/** Exponentially weighted mean. */
export class Ewma {
  private m: number | null = null;
  n = 0;

  constructor(private readonly alpha: number) {}

  static halfLife(samples: number): Ewma {
    return new Ewma(1 - Math.pow(2, -1 / samples));
  }

  push(x: number): void {
    this.m = this.m === null ? x : this.m + this.alpha * (x - this.m);
    this.n++;
  }

  get value(): number | null {
    return this.m;
  }
}

/**
 * What a "normal" one-minute move is for this stock right now, from squared log returns divided by
 * the time-of-day shape (so the busy open doesn't inflate the midday baseline). Two speeds:
 *
 * - slow: the long-run normal (half-life 90 minutes), outliers capped at 4 sigma so one shock
 *   doesn't redefine normal;
 * - fast: the current regime (half-life 6 minutes). After earnings hit, the tape is wild for a
 *   while, and the next 0.4% wiggle is not news. The fast side lets "normal" catch up.
 *
 * A move is judged against the larger of the two. Moves already in progress keep the baseline from
 * when they started, so a move doesn't shrink its own rating as it grows.
 */
export class VolTracker {
  private readonly slow = Ewma.halfLife(90);
  private readonly fast = Ewma.halfLife(6);

  constructor(
    private readonly floor: number,
    private readonly fallback: number,
  ) {}

  push(logReturn: number, minutes: number, shape: number): void {
    const x = (logReturn * logReturn) / Math.max(1, minutes) / (shape * shape);
    const s = this.slow.value;
    this.slow.push(s !== null && this.slow.n >= 20 ? Math.min(x, 16 * s) : x);
    const f = this.fast.value;
    this.fast.push(f !== null && this.fast.n >= 5 ? Math.min(x, 100 * f) : x);
  }

  /** Per-minute sigma for a quiet midday minute (shape-neutral). */
  base(): number {
    const s = this.slow.value;
    const slow = s === null || this.slow.n < 10 ? this.fallback : Math.max(Math.sqrt(s), this.floor);
    const f = this.fast.value;
    const fast = f === null || this.fast.n < 3 ? 0 : 0.6 * Math.sqrt(f);
    return Math.max(slow, fast);
  }

  /** Expected sigma of a log return over `minutes` at time-of-day multiplier `shape`. */
  sigma(minutes: number, shape: number): number {
    return this.base() * shape * Math.sqrt(Math.max(1, minutes));
  }

  get samples(): number {
    return this.slow.n;
  }
}

/**
 * Normal volume per bar: exponentially weighted geometric means, normalized for time of day.
 * `expected` is the long-run normal; `recent` is the last few minutes, used to tell a genuine spike
 * from a session where everything is already heavy (right after earnings).
 */
export class VolumeTracker {
  private readonly slow = Ewma.halfLife(60);
  private readonly fast = Ewma.halfLife(5);

  push(volume: number, shape: number): void {
    if (volume <= 0) return;
    const lv = Math.log(volume / shape);
    const s = this.slow.value;
    this.slow.push(s !== null && this.slow.n >= 20 ? Math.min(lv, s + Math.log(20)) : lv);
    this.fast.push(lv);
  }

  expected(shape: number): number | null {
    const v = this.slow.value;
    return v === null || this.slow.n < 10 ? null : Math.exp(v) * shape;
  }

  recent(shape: number): number | null {
    const v = this.fast.value;
    return v === null || this.fast.n < 3 ? null : Math.exp(v) * shape;
  }
}
