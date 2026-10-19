import type { RatingParts } from './types';

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const round1 = (x: number) => Math.round(x * 10) / 10;
export const round2 = (x: number) => Math.round(x * 100) / 100;

export interface RatingInput {
  /** Move size in "normal moves" (sigmas) for this stock, window and time of day. */
  z: number;
  /** Move size in percent. */
  pct: number;
  /** Volume during the move, as a multiple of normal. */
  volMult?: number | null;
  /** Extra points for new highs/lows, long-standing levels, an event's first reaction. */
  novelty?: number;
  /** Event windows count more (1.15); thin pre-market and after-hours trading counts less (0.9). */
  context?: number;
  /** Percent move at which surprise counts fully. Smaller moves have their surprise damped. Default 1. */
  fullAt?: number;
}

/**
 * The move rating, 0–10 (above 10 only for historic moves, like Real's rating).
 *
 * size     — how unusual the move is for this stock (z), or how big it is in plain percent,
 *            whichever is larger, with a little credit when both are large. Surprise on a tiny
 *            move is damped: a 0.3% wiggle can be "unusual" and still not worth anyone's attention.
 * volume   — 0 at twice normal volume, up to 2.5 points at 11× or more.
 * novelty  — new highs/lows and first reactions to scheduled news.
 * context  — multiplier for event windows and extended hours.
 * cap      — the rating can't outrun the move's size: about 6.4 at most for a 0.3% move, 8.5 at
 *            1%, 10 from 3%. Above 10 only for historic moves (10%+ and very unusual).
 *
 * Every input is market data. Chat activity never feeds the rating.
 */
export function rateMove(i: RatingInput): { rating: number; parts: RatingParts } {
  const damp = clamp(0.55 + (0.45 * Math.abs(i.pct)) / (i.fullAt ?? 1), 0.55, 1);
  const rel = 2.5 * Math.log2(1 + i.z / 2) * damp;
  const abs = 1.2 * Math.log2(1 + Math.abs(i.pct));
  const size = Math.max(rel, abs) + 0.35 * Math.min(rel, abs);
  const volume = i.volMult ? clamp(Math.log2(i.volMult / 2), 0, 2.5) : 0;
  const novelty = i.novelty ?? 0;
  const context = i.context ?? 1;
  // Big ratings need big moves: at most ~6.4 for a 0.3% move, 8.5 at 1%, 10 from 3%.
  const a = Math.abs(i.pct);
  const f = i.fullAt ?? 1;
  const sizeCap = Math.min(10, 5.5 + 3 * Math.min(1, a / f) + 1.5 * clamp((a - f) / (2 * f), 0, 1));
  const cap = a >= 10 && i.z >= 8 ? 12 : sizeCap;
  const rating = round1(clamp((size + volume + novelty) * context, 0, cap));
  return { rating, parts: { size: round1(size), volume: round1(volume), novelty: round1(novelty), context } };
}

export type Tier = 'minor' | 'notable' | 'big' | 'huge' | 'historic';

export function tierOf(rating: number): Tier {
  if (rating > 10) return 'historic';
  if (rating >= 8) return 'huge';
  if (rating >= 6) return 'big';
  if (rating >= 4) return 'notable';
  return 'minor';
}
