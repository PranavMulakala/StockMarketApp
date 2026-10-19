import type { AssetClass, Session } from './types';
import { etDate, etMinuteOfDay, utcDate } from './time';

export const PRE_MIN = 4 * 60; // 4:00 AM ET
export const OPEN_MIN = 9 * 60 + 30; // 9:30 AM ET
export const CLOSE_MIN = 16 * 60; // 4:00 PM ET
export const POST_END_MIN = 20 * 60; // 8:00 PM ET

export function sessionOf(t: number, asset: AssetClass): Session {
  if (asset === 'crypto') return 'always';
  const m = etMinuteOfDay(t);
  if (m >= PRE_MIN && m < OPEN_MIN) return 'pre';
  if (m >= OPEN_MIN && m < CLOSE_MIN) return 'regular';
  if (m >= CLOSE_MIN && m < POST_END_MIN) return 'post';
  return 'closed';
}

/** The trading day a bar belongs to: Eastern date for stocks, UTC date for crypto. */
export function dayKey(t: number, asset: AssetClass): string {
  return asset === 'crypto' ? utcDate(t) : etDate(t);
}

export interface Shape {
  /** Expected volatility relative to a quiet midday minute. */
  vol: number;
  /** Expected volume relative to a quiet midday minute. */
  volume: number;
}

/**
 * The regular session's U-shape: the open and close are much busier than midday, so a move that
 * would be huge at 1 PM is ordinary at 9:31. Ratings compare each minute with what is normal for
 * that time of day, not with a single daily average.
 */
export function intradayShape(t: number, asset: AssetClass): Shape {
  if (asset === 'crypto') return { vol: 1, volume: 1 };
  const m = etMinuteOfDay(t);
  if (m < OPEN_MIN || m >= CLOSE_MIN) return { vol: 1, volume: 1 };
  const sinceOpen = m - OPEN_MIN;
  const toClose = CLOSE_MIN - m;
  if (sinceOpen < 5) return { vol: 2.6, volume: 4 };
  if (sinceOpen < 15) return { vol: 1.9, volume: 2.6 };
  if (sinceOpen < 30) return { vol: 1.45, volume: 1.8 };
  if (sinceOpen < 60) return { vol: 1.15, volume: 1.3 };
  if (toClose <= 10) return { vol: 1.3, volume: 2.2 };
  if (toClose <= 30) return { vol: 1.1, volume: 1.4 };
  return { vol: 1, volume: 1 };
}

/** The 9:30 and 4:00 PM bars carry the opening and closing auctions: keep them out of baselines. */
export function isAuctionBar(t: number, asset: AssetClass): boolean {
  if (asset === 'crypto') return false;
  const m = etMinuteOfDay(t);
  return m === OPEN_MIN || m === CLOSE_MIN;
}

/** Minutes whose volume is mostly auction and cross prints: never call "heavy volume" on them. */
export function isCrossBar(t: number, asset: AssetClass): boolean {
  if (asset === 'crypto') return false;
  const m = etMinuteOfDay(t);
  return m === OPEN_MIN || (m >= CLOSE_MIN && m <= CLOSE_MIN + 2);
}
