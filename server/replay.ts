import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PlayEngine,
  etToUtcMs,
  parseHm,
  type Bar,
  type EngineEvent,
  type Play,
  type ScheduledEvent,
} from '../engine';
import { ROOT, loadDay, type DayData } from './data';

export interface Scenario {
  id: string;
  symbol: string;
  name: string;
  date: string;
  kind: 'earnings' | 'session';
  title: string;
  subtitle?: string;
  note?: string;
  /** Eastern "HH:MM" */
  start: string;
  end: string;
  events?: { time: string; kind: ScheduledEvent['kind']; title: string }[];
}

/** One step of a replay: the bar as it looked at time `t`, and any plays found at that moment. */
export interface Frame {
  t: number;
  bar: Bar;
  final: boolean;
  events: EngineEvent[];
}

export interface Timeline {
  scenario: Scenario;
  startMs: number;
  endMs: number;
  prevClose: number;
  /** The day's bars before the replay starts (shown on the chart as context). */
  history: Bar[];
  frames: Frame[];
}

const MIN = 60_000;
/** Seconds into each minute at which a replay shows the bar still forming. */
const TICKS = [0, 15_000, 35_000, 55_000];

export function loadScenarios(): Scenario[] {
  return JSON.parse(readFileSync(join(ROOT, 'scenarios', 'replays.json'), 'utf8')) as Scenario[];
}

/** The order a bar most plausibly traded in: up bars dip first, down bars pop first. */
function path(b: Bar): number[] {
  return b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
}

/**
 * Runs the play engine over a recorded day exactly as it would run live: warm up on the previous
 * day and the morning, then feed each minute as it forms (several partial updates) and closes.
 * Deterministic, so a replay always shows the same plays at the same moments.
 */
export function buildTimeline(sc: Scenario, data: DayData): Timeline {
  const at = (hm: string) => {
    const [h, m] = parseHm(hm);
    return etToUtcMs(sc.date, h, m);
  };
  const startMs = at(sc.start);
  const endMs = at(sc.end);
  const events: ScheduledEvent[] = (sc.events ?? []).map((e) => ({ t: at(e.time), title: e.title, kind: e.kind }));
  const engine = new PlayEngine({
    symbol: sc.symbol,
    assetClass: 'equity',
    closes: { [sc.date]: data.prevClose },
    events,
  });
  const history = data.bars.filter((b) => b.t < startMs);
  engine.warmup([...data.prevBars, ...history]);
  const frames: Frame[] = [];
  for (const b of data.bars) {
    if (b.t < startMs || b.t >= endMs) continue;
    const p = path(b);
    let h = b.o;
    let l = b.o;
    for (let i = 0; i < TICKS.length; i++) {
      const price = p[i]!;
      h = Math.max(h, price);
      l = Math.min(l, price);
      const partial: Bar = { t: b.t, o: b.o, h, l, c: price, v: Math.round((b.v * (i + 1)) / (TICKS.length + 1)) };
      const now = b.t + TICKS[i]!;
      frames.push({ t: now, bar: partial, final: false, events: engine.update(partial, false, now) });
    }
    const now = b.t + MIN - 1;
    frames.push({ t: now, bar: b, final: true, events: engine.update(b, true, now) });
  }
  return { scenario: sc, startMs, endMs, prevClose: data.prevClose, history, frames };
}

export function timelineFor(sc: Scenario): Timeline | null {
  const data = loadDay(sc.symbol, sc.date);
  return data ? buildTimeline(sc, data) : null;
}

/** Every play in its latest form, in the order it was first called. */
export function finalPlays(frames: Frame[], until = Infinity): Play[] {
  const byId = new Map<string, Play>();
  for (const f of frames) {
    if (f.t > until) break;
    for (const e of f.events) byId.set(e.play.id, e.play);
  }
  return [...byId.values()];
}
