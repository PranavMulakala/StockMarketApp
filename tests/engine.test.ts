import { describe, expect, it } from 'vitest';
import { PlayEngine, etToUtcMs, rateMove, sessionOf, type EngineOptions } from '../engine';
import { DAY, PREV_DAY, bar, before, feed, plays, quietDay, walk, zigzag } from './helpers';

const prevDay = () => quietDay(PREV_DAY, 100, 1);

function engine(opts: Partial<EngineOptions> = {}) {
  const e = new PlayEngine({ symbol: 'TEST', assetClass: 'equity', ...opts });
  e.warmup(prevDay());
  return e;
}

describe('time and sessions', () => {
  it('converts Eastern wall-clock time across daylight saving', () => {
    expect(new Date(etToUtcMs('2026-01-15', 9, 30)).toISOString()).toBe('2026-01-15T14:30:00.000Z');
    expect(new Date(etToUtcMs('2026-07-15', 9, 30)).toISOString()).toBe('2026-07-15T13:30:00.000Z');
  });

  it('classifies sessions at their edges', () => {
    expect(sessionOf(etToUtcMs(DAY, 9, 29), 'equity')).toBe('pre');
    expect(sessionOf(etToUtcMs(DAY, 9, 30), 'equity')).toBe('regular');
    expect(sessionOf(etToUtcMs(DAY, 15, 59), 'equity')).toBe('regular');
    expect(sessionOf(etToUtcMs(DAY, 16, 0), 'equity')).toBe('post');
    expect(sessionOf(etToUtcMs(DAY, 20, 0), 'equity')).toBe('closed');
    expect(sessionOf(etToUtcMs(DAY, 3, 0), 'crypto')).toBe('always');
  });
});

describe('move rating', () => {
  it('rises with surprise and with volume', () => {
    const a = rateMove({ z: 4, pct: 0.5 }).rating;
    const b = rateMove({ z: 8, pct: 0.5 }).rating;
    const c = rateMove({ z: 8, pct: 0.5, volMult: 8 }).rating;
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('caps at 10 unless the move is historic', () => {
    expect(rateMove({ z: 60, pct: 6, volMult: 50, novelty: 3 }).rating).toBe(10);
    expect(rateMove({ z: 60, pct: 15, volMult: 50, novelty: 3 }).rating).toBeGreaterThan(10);
  });
});

describe('PlayEngine', () => {
  it('stays quiet on an ordinary day', () => {
    const e = engine();
    const found = plays(feed(e, quietDay(DAY, 100, 11))).filter((p) => p.kind !== 'bell' && p.kind !== 'candle');
    expect(found.length).toBeLessThanOrEqual(12);
    expect(Math.max(0, ...found.map((p) => p.rating))).toBeLessThan(6);
  });

  it('calls a sharp move once and updates it while it runs', () => {
    const e = engine();
    const base = before(quietDay(DAY, 100, 21), DAY, '11:00');
    feed(e, base);
    let p = base.at(-1)!.c;
    const ev1 = e.update(bar(DAY, '11:00', p, p * 1.012, 200_000), true);
    p *= 1.012;
    const ev2 = e.update(bar(DAY, '11:01', p, p * 1.013, 220_000), true);
    const move = ev1.find((x) => x.type === 'play' && x.play.kind === 'move');
    expect(move).toBeDefined();
    expect(move!.play.dir).toBe(1);
    expect(move!.play.rating).toBeGreaterThanOrEqual(7);
    expect(move!.play.factors.some((f) => f.includes('normal volume'))).toBe(true);
    const upd = ev2.find((x) => x.type === 'update' && x.play.id === move!.play.id);
    expect(upd).toBeDefined();
    expect(upd!.play.pct!).toBeGreaterThan(move!.play.pct!);
    expect(upd!.play.revision).toBe(1);
    expect(plays(ev2).filter((x) => x.kind === 'move')).toHaveLength(0);
  });

  it('calls the fade when a big move gives back half', () => {
    const e = engine();
    const base = before(quietDay(DAY, 100, 21), DAY, '11:00');
    feed(e, base);
    const start = base.at(-1)!.c;
    let p = start;
    for (const [hm, k] of [
      ['11:00', 1.012],
      ['11:01', 1.013],
    ] as const) {
      e.update(bar(DAY, hm, p, p * k, 200_000), true);
      p *= k;
    }
    const peak = p;
    const evs = [];
    for (const [hm, k] of [
      ['11:02', 0.998],
      ['11:03', 0.996],
      ['11:04', 0.996],
      ['11:05', 0.997],
      ['11:06', 0.998],
    ] as const) {
      evs.push(...e.update(bar(DAY, hm, p, p * k, 60_000), true));
      p *= k;
    }
    expect((peak - p) / (peak - start)).toBeGreaterThan(0.5);
    const called = evs.some(
      (x) => x.play.kind === 'fade' || (x.play.kind === 'move' && x.play.dir === -1 && /half the pop/.test(x.play.title)),
    );
    expect(called).toBe(true);
  });

  it('rings the opening and closing bells against the previous close', () => {
    const e = engine();
    const prevClose = before(prevDay(), PREV_DAY, '16:00').at(-1)!.c;
    const day = quietDay(DAY, prevClose * 1.02, 31);
    const evs = plays(feed(e, day));
    const open = evs.find((p) => p.title.startsWith('Opening bell'));
    expect(open?.title).toContain("vs yesterday's close");
    const firstRegular = day.find((b) => b.t >= etToUtcMs(DAY, 9, 30))!;
    expect(open!.pct!).toBeCloseTo((firstRegular.o / prevClose - 1) * 100, 2);
    expect(open!.price).toBe(firstRegular.o);
    expect(evs.find((p) => p.title.startsWith('Closing bell'))?.title).toContain('on the day');
    expect(evs.find((p) => p.title.startsWith('After-hours wrap'))).toBeDefined();
  });

  it('calls the earnings reaction from the 4:00 PM close', () => {
    const e = engine({ events: [{ t: etToUtcMs(DAY, 16, 5), title: 'TEST posts Q3 results', kind: 'earnings' }] });
    const day = before(quietDay(DAY, 100, 41), DAY, '16:06');
    const evs = feed(e, day);
    expect(plays(evs).some((p) => p.kind === 'event' && p.title === 'TEST posts Q3 results')).toBe(true);
    const close = before(day, DAY, '16:00').at(-1)!.c;
    const reaction = plays(e.update(bar(DAY, '16:06', day.at(-1)!.c, close * 1.06, 90_000), true)).find(
      (p) => p.kind === 'reaction',
    );
    expect(reaction).toBeDefined();
    expect(reaction!.title).toMatch(/^Earnings reaction: TEST \+6\.0% from the close/);
    expect(reaction!.rating).toBeGreaterThanOrEqual(8);
    expect(reaction!.factors).toContain('Earnings window');
  });

  it('calls a new high of the day after a long range', () => {
    const e = engine();
    const range = zigzag(DAY, '09:30', '12:30', 100);
    feed(e, range);
    const high = Math.max(...range.map((b) => b.h));
    const evs = plays(e.update(bar(DAY, '12:30', 100, high * 1.0015, 50_000), true));
    const hit = evs.find((p) => p.kind === 'high' || /new high of the day/.test(p.title));
    expect(hit).toBeDefined();
    expect(hit!.factors.join(' ')).toMatch(/stood 3 hr/);
  });

  it('calls a run of straight green minutes', () => {
    const e = engine();
    const base = zigzag(DAY, '09:30', '11:00', 100);
    feed(e, base);
    let p = base.at(-1)!.c;
    const evs = [];
    for (const hm of ['11:00', '11:01', '11:02', '11:03', '11:04', '11:05']) {
      evs.push(...e.update(bar(DAY, hm, p, p * 1.0011, 22_000), true));
      p *= 1.0011;
    }
    const run = plays(evs).find((x) => x.kind === 'run');
    expect(run).toBeDefined();
    expect(run!.title).toMatch(/up \d+ straight minutes/);
    expect(plays(evs).some((x) => x.kind === 'move')).toBe(false);
  });

  it('calls a move mid-bar and does not repeat it when the bar closes', () => {
    const e = engine();
    const base = before(quietDay(DAY, 100, 51), DAY, '11:00');
    feed(e, base);
    const p = base.at(-1)!.c;
    const t = etToUtcMs(DAY, 11, 0);
    const partial = [
      { t, o: p, h: p, l: p, c: p, v: 1_000 },
      { t, o: p, h: p * 1.015, l: p, c: p * 1.015, v: 150_000 },
      { t, o: p, h: p * 1.016, l: p, c: p * 1.014, v: 180_000 },
    ];
    const evs = partial.flatMap((b, i) => e.update(b, false, t + (i + 1) * 10_000));
    evs.push(...e.update({ t, o: p, h: p * 1.016, l: p, c: p * 1.0145, v: 200_000 }, true));
    const moves = plays(evs).filter((x) => x.kind === 'move');
    expect(moves).toHaveLength(1);
    expect(moves[0]!.t).toBe(t + 20_000); // called 20 seconds into the minute
  });

  it('turns every five minutes into a candle play with the real OHLC', () => {
    const e = engine();
    const day = before(quietDay(DAY, 100, 61), DAY, '10:30');
    const candles = plays(feed(e, day)).filter((p) => p.kind === 'candle');
    const regular = candles.filter((p) => p.session === 'regular');
    expect(regular).toHaveLength(12); // 9:30–10:30
    const k = regular[0]!.candle!;
    const five = day.filter((b) => b.t >= k.start && b.t < k.start + 5 * 60_000);
    expect(k.o).toBe(five[0]!.o);
    expect(k.c).toBe(five.at(-1)!.c);
    expect(k.h).toBe(Math.max(...five.map((b) => b.h)));
    expect(regular[0]!.title).toMatch(/candle: TEST [+−]/);
  });

  it('works around the clock for crypto, with no bells', () => {
    const e = new PlayEngine({ symbol: 'BTC-USD', assetClass: 'crypto' });
    const hist = walk(PREV_DAY, '00:00', '23:59', 60_000, { sigma: 0.0006, volume: 40, seed: 5 });
    e.warmup(hist);
    let p = hist.at(-1)!.c;
    const t = hist.at(-1)!.t + 60_000;
    const evs = e.update({ t, o: p, h: p * 1.01, l: p, c: p * 1.009, v: 600 }, true);
    p *= 1.009;
    expect(plays(evs).some((x) => x.kind === 'move' && x.dir === 1)).toBe(true);
    expect(plays(evs).some((x) => x.kind === 'bell')).toBe(false);
  });
});
