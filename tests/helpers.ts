import type { Bar, EngineEvent, PlayEngine } from '../engine';
import { etToUtcMs, parseHm } from '../engine';

export const PREV_DAY = '2026-06-09'; // a Tuesday
export const DAY = '2026-06-10'; // a Wednesday

/** Seeded random numbers, so every test tape is identical run to run. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const at = (date: string, hm: string) => {
  const [h, m] = parseHm(hm);
  return etToUtcMs(date, h, m);
};

export interface WalkOpts {
  sigma?: number;
  volume?: number;
  seed?: number;
}

/** Random-walk one-minute bars from `from` up to (not including) `to`, Eastern time. */
export function walk(date: string, from: string, to: string, start: number, o: WalkOpts = {}): Bar[] {
  const r = rng(o.seed ?? 7);
  const sigma = o.sigma ?? 0.0008;
  const volume = o.volume ?? 20_000;
  const bars: Bar[] = [];
  let p = start;
  for (let t = at(date, from); t < at(date, to); t += 60_000) {
    const c = p * Math.exp(sigma * gauss(r));
    const h = Math.max(p, c) * (1 + Math.abs(gauss(r)) * sigma * 0.3);
    const l = Math.min(p, c) * (1 - Math.abs(gauss(r)) * sigma * 0.3);
    bars.push({ t, o: p, h, l, c, v: Math.round(volume * (0.6 + r() * 0.8)) });
    p = c;
  }
  return bars;
}

/** Bars that alternate up and down by `step`: a known, steady volatility with no trend. */
export function zigzag(date: string, from: string, to: string, start: number, step = 0.0008, volume = 20_000): Bar[] {
  const bars: Bar[] = [];
  let i = 0;
  for (let t = at(date, from); t < at(date, to); t += 60_000, i++) {
    const o = i % 2 === 0 ? start : start * (1 + step);
    const c = i % 2 === 0 ? start * (1 + step) : start;
    bars.push({ t, o, h: Math.max(o, c) * 1.0001, l: Math.min(o, c) * 0.9999, c, v: volume });
  }
  return bars;
}

/** One bar at an Eastern time. */
export function bar(date: string, hm: string, o: number, c: number, v: number): Bar {
  return { t: at(date, hm), o, h: Math.max(o, c) * 1.0001, l: Math.min(o, c) * 0.9999, c, v };
}

/** A whole quiet day: pre-market, regular session, after hours. */
export function quietDay(date: string, start: number, seed: number): Bar[] {
  const pre = walk(date, '04:00', '09:30', start, { sigma: 0.0005, volume: 1_500, seed });
  const reg = walk(date, '09:30', '16:00', pre.at(-1)!.c, { sigma: 0.0008, volume: 20_000, seed: seed + 1 });
  const post = walk(date, '16:00', '20:00', reg.at(-1)!.c, { sigma: 0.0005, volume: 1_500, seed: seed + 2 });
  return [...pre, ...reg, ...post];
}

export function before(bars: Bar[], date: string, hm: string): Bar[] {
  const t = at(date, hm);
  return bars.filter((b) => b.t < t);
}

export function feed(engine: PlayEngine, bars: Bar[]): EngineEvent[] {
  return bars.flatMap((b) => engine.update(b, true));
}

export const plays = (evs: EngineEvent[]) => evs.filter((e) => e.type === 'play').map((e) => e.play);
