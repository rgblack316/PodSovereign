/** Caption files (SRT or WebVTT) as cues, and as the timestamped lines the AI reads. */

export interface Cue { start: number; text: string }

const TIME = /(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const ARROW = new RegExp(`^\\s*${TIME.source}\\s*-->`);

const seconds = (h: string | undefined, m: string, s: string, ms: string) =>
  Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;

/** Cues in order. Text without timings gives none. */
export function parseCues(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => ARROW.test(l));
    if (i < 0) continue;
    const m = ARROW.exec(lines[i]!)!;
    const body = lines.slice(i + 1).join(' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (body) cues.push({ start: seconds(m[1], m[2]!, m[3]!, m[4]!), text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export const clock = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

/** One line per cue: `[00:12:34] text`. */
export const toLines = (cues: Cue[]) => cues.map((c) => `[${clock(c.start)}] ${c.text}`).join('\n');

/** "HH:MM:SS", "MM:SS" or plain seconds, as the AI might write it. NaN when it isn't a time. */
export function parseClock(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const m = /^\[?\s*(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?\s*\]?$/.exec(v.trim());
  if (!m) return /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
}
