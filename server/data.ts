import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bar } from '../engine';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Market data cache. Git-ignored: personal-use data must never be committed or shown publicly. */
export const DATA_DIR = process.env.TAPE_DATA_DIR ?? join(ROOT, 'data');
const REPLAY_DIR = join(DATA_DIR, 'replays');

/** One stock's day of one-minute bars (4:00 AM–8:00 PM ET) plus the previous day for warmup. */
export interface DayData {
  symbol: string;
  date: string;
  source: string;
  fetchedAt: string;
  prevDate: string;
  /** Official previous close (daily bar), for gaps and day change. */
  prevClose: number;
  prevBars: Bar[];
  bars: Bar[];
}

const fileFor = (symbol: string, date: string) => join(REPLAY_DIR, `${symbol.toUpperCase()}_${date}.json`);

export function loadDay(symbol: string, date: string): DayData | null {
  const f = fileFor(symbol, date);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as DayData) : null;
}

export function saveDay(d: DayData): string {
  mkdirSync(REPLAY_DIR, { recursive: true });
  const f = fileFor(d.symbol, d.date);
  writeFileSync(f, JSON.stringify(d));
  return f;
}

export function cachedDays(): string[] {
  return existsSync(REPLAY_DIR) ? readdirSync(REPLAY_DIR).filter((f) => f.endsWith('.json')) : [];
}
