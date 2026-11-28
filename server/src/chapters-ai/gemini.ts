/** Gemini as a chapter maker: the timed transcript goes in, a JSON list of chapters comes out. */
import type { Config } from '../config.js';
import { cleanChapters, type CleanOptions, type Draft } from './validate.js';
import { clock, toLines, type Cue } from './transcript.js';

export class GeminiError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export interface AiOptions { style: 'strict' | 'balance' | 'creative'; count: 'fewer' | 'moderate' | 'more'; ads: boolean; links: boolean }

const COUNT_TEXT = {
  fewer: 'about one chapter every 8 to 10 minutes',
  moderate: 'about one chapter every 4 to 6 minutes',
  more: 'about one chapter every 2 to 3 minutes',
};
const STYLE_TEXT = {
  strict: 'Reuse the speakers’ own words for titles.',
  balance: 'Write short titles that paraphrase what is said.',
  creative: 'Write free, catchy titles.',
};

export function buildPrompt(o: AiOptions, durationSec: number | null): string {
  return [
    'You split a podcast episode into chapters from its timed transcript.',
    'Each transcript line looks like "[HH:MM:SS] text".',
    `Start a new chapter where the topic shifts. Aim for ${COUNT_TEXT[o.count]}.`,
    'The first chapter starts at 00:00:00. Every startTime must be copied exactly from the start of a transcript line.',
    `Titles: ${STYLE_TEXT[o.style]} Keep each under about 6 words, with no trailing punctuation, in the transcript’s language.`,
    o.ads
      ? 'Give advertisements and sponsor reads their own chapter, with the title starting "Ad: " (in the transcript’s language).'
      : 'Do not make ads or sponsor reads their own chapters unless they run long.',
    'Do not make short intros or sign-offs separate chapters unless they run long.',
    o.links
      ? 'If a web address is spoken in a chapter’s part of the episode, return it in "url", exactly as spoken. Never invent one.'
      : 'Do not return any "url".',
    durationSec ? `The episode is ${clock(durationSec)} long.` : '',
    'Answer with JSON only, in the form {"chapters":[{"startTime":"HH:MM:SS","title":"..."}]}.',
  ].filter(Boolean).join('\n');
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    chapters: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { startTime: { type: 'STRING' }, title: { type: 'STRING' }, url: { type: 'STRING' } }, required: ['startTime', 'title'] },
    },
  },
  required: ['chapters'],
};

interface GeminiReply { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>; promptFeedback?: { blockReason?: string }; error?: { message?: string; status?: string } }

async function ask(config: Config, system: string, user: string, timeoutMs: number): Promise<string> {
  if (!config.geminiKey) throw new GeminiError('Gemini isn’t set up: an administrator adds the API key in Site settings.', 409);
  let res: Response;
  try {
    res = await fetch(`${config.geminiUrl.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SCHEMA },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = (e as Error).name === 'TimeoutError';
    throw new GeminiError(timedOut ? 'Gemini took too long to answer. Try again.' : `Couldn’t reach Gemini: ${(e as Error).message}`, 502);
  }
  const text = await res.text();
  let json: GeminiReply | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const said = json?.error?.message ?? text.slice(0, 200);
    if (res.status === 429) throw new GeminiError('Gemini says too many requests were made or the quota is used up. Try again in a minute.', 429);
    if (res.status === 404) throw new GeminiError(`Gemini doesn’t know the model “${config.geminiModel}”. Check the model name in Site settings.`, 502);
    if (res.status === 400 && /api key/i.test(said)) throw new GeminiError('Gemini didn’t accept the API key. Check it in Site settings → Gemini.', 502);
    if (res.status === 401 || res.status === 403) throw new GeminiError('Gemini didn’t accept the API key. Check it in Site settings → Gemini.', 502);
    throw new GeminiError(`Gemini: ${said || `status ${res.status}`}`, 502);
  }
  const part = json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!part.trim()) {
    throw new GeminiError(json?.promptFeedback?.blockReason ? `Gemini declined this transcript (${json.promptFeedback.blockReason}).` : 'Gemini sent back nothing. Try again.', 502);
  }
  return part;
}

/** Check a key and model without making chapters. */
export async function testGemini(config: Config, key: string, model: string): Promise<{ model: string }> {
  let res: Response;
  try {
    res = await fetch(`${config.geminiUrl.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(model)}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new GeminiError(`Couldn’t reach Gemini: ${(e as Error).message}`, 502);
  }
  if (res.status === 404) throw new GeminiError(`Gemini doesn’t know the model “${model}”.`, 400);
  if (!res.ok) throw new GeminiError('Gemini didn’t accept the API key.', 400);
  return { model };
}

/** Chapters for a transcript. One retry when the answer can't be used, with the problem fed back. */
export async function geminiChapters(config: Config, cues: Cue[], transcriptText: string, o: AiOptions, durationSec: number | null): Promise<Draft[]> {
  const system = buildPrompt(o, durationSec);
  const lines = toLines(cues);
  const clean: CleanOptions = { durationSec, count: o.count, ads: o.ads, links: o.links, transcriptText };
  let user = lines;
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await ask(config, system, user, 50_000);
    try {
      return cleanChapters((JSON.parse(out) as { chapters?: unknown }).chapters, cues, clean);
    } catch (e) {
      problem = e instanceof SyntaxError ? 'The answer was not valid JSON.' : (e as Error).message;
      user = `${lines}\n\nYour previous answer could not be used: ${problem} Try again and follow the instructions exactly.`;
    }
  }
  throw new GeminiError(`Gemini didn’t return usable chapters (${problem}). Try again.`, 502);
}
