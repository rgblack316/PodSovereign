/**
 * Timestamps are the main risk with AI output, so nothing is trusted as returned: each chapter is moved to a real
 * cue start, sorted, de-duplicated, spaced out and capped, and titles and links are cleaned.
 */
import { parseClock, type Cue } from './transcript.js';

export interface Draft { startTime: number; title: string; url: string | null }
export type Count = 'fewer' | 'moderate' | 'more';

export const MIN_GAP_SEC = 30;
export const MAX_TITLE = 80;
export const HARD_CEILING = 30;
const PER_HOUR: Record<Count, number> = { fewer: 6, moderate: 12, more: 24 };

/** The most chapters kept: about 1.5 times the wanted density for the episode's length. */
export function chapterCap(durationSec: number, count: Count): number {
  const hours = Math.max(durationSec, 60) / 3600;
  return Math.min(HARD_CEILING, Math.max(4, Math.ceil(hours * PER_HOUR[count] * 1.5)));
}

const cleanTitle = (t: unknown, ads: boolean) => {
  let s = typeof t === 'string' ? t : '';
  s = s.replace(/<[^>]*>/g, '').replace(/[*_`#]+/g, '').replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!ads) s = s.replace(/^ad\s*:\s*/i, '');
  s = s.replace(/[.:;,\s]+$/, '');
  return s.length > MAX_TITLE ? s.slice(0, MAX_TITLE).replace(/\s+\S*$/, '') : s;
};

const nearest = (starts: number[], t: number) => {
  let best = starts[0]!;
  for (const s of starts) if (Math.abs(s - t) < Math.abs(best - t)) best = s;
  return best;
};

export interface CleanOptions { durationSec: number | null; count: Count; ads: boolean; links: boolean; transcriptText: string }

/** Returns cleaned chapters, or throws a message the model can be asked to fix. */
export function cleanChapters(raw: unknown, cues: Cue[], o: CleanOptions): Draft[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error('The chapters list was empty.');
  if (!cues.length) throw new Error('The transcript has no timed lines.');
  const starts = cues.map((c) => c.start);
  const last = cues.at(-1)!.start;
  const end = o.durationSec && o.durationSec > 0 ? o.durationSec : last + 1;
  const hay = o.transcriptText.toLowerCase();

  let list: Draft[] = [];
  for (const c of raw as Array<Record<string, unknown>>) {
    const t = parseClock(c?.startTime);
    const title = cleanTitle(c?.title, o.ads);
    if (!Number.isFinite(t) || !title || t >= end) continue;
    const url = o.links && typeof c.url === 'string' ? c.url.trim().replace(/[.,;)]+$/, '') : '';
    list.push({ startTime: nearest(starts, Math.max(0, t)), title, url: url && hay.includes(url.toLowerCase()) ? url : null });
  }
  if (!list.length) throw new Error('None of the chapters had a valid startTime and title.');
  list.sort((a, b) => a.startTime - b.startTime);
  list = list.filter((c, i) => i === 0 || c.startTime !== list[i - 1]!.startTime);
  if (!list.length) throw new Error('Every chapter started after the end of the episode.');
  list[0]!.startTime = 0;

  const spaced: Draft[] = [];
  for (const c of list) {
    if (spaced.length && c.startTime - spaced.at(-1)!.startTime < MIN_GAP_SEC) continue;
    spaced.push(c);
  }

  const cap = chapterCap(end, o.count);
  if (spaced.length <= cap) return spaced;
  const kept = [spaced[0]!];
  for (let i = 1; i < cap; i++) kept.push(spaced[Math.round((i * (spaced.length - 1)) / (cap - 1))]!);
  return kept.filter((c, i) => i === 0 || c !== kept[i - 1]);
}
