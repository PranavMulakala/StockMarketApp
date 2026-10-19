import type {
  AssetClass,
  Bar,
  EngineEvent,
  EngineOptions,
  Play,
  PlayKind,
  RatingParts,
  ScheduledEvent,
  Session,
} from './types';
import {
  CLOSE_MIN,
  POST_END_MIN,
  dayKey,
  intradayShape,
  isAuctionBar,
  isCrossBar,
  sessionOf,
  type Shape,
} from './session';
import { VolTracker, VolumeTracker } from './stats';
import { clamp, rateMove, round1, round2, type RatingInput } from './rating';
import { fmtAbsPct, fmtDuration, fmtMinutes, fmtMult, fmtPct, fmtPrice } from './format';
import { etMinuteOfDay } from './time';

const MIN = 60_000;
/** Look-back windows (minutes) a move is measured over. The most surprising one wins. */
const WINDOWS = [1, 2, 3, 5, 10, 15];
const RUN_MILESTONES = [5, 8, 12, 20];
/** A move stays in progress (and updates in place) while it keeps making new extremes this often. */
const EXTEND_GAP = 4 * MIN;
const MOVE_MAX_AGE = 45 * MIN;
/** How long after the first reaction an event keeps its boost. */
const HOT_AFTER_REACTION = 15 * MIN;

type Group = 'regular' | 'extended' | 'always';
type Dir = 1 | -1;

const groupOf = (s: Session): Group => (s === 'regular' ? 'regular' : s === 'always' ? 'always' : 'extended');
const sign = (x: number): Dir | 0 => (x > 0 ? 1 : x < 0 ? -1 : 0);
const pctChange = (from: number, to: number) => (to / from - 1) * 100;
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

function verb(dir: Dir, pct: number): string {
  const a = Math.abs(pct);
  if (dir === 1) return a >= 3 ? 'rips' : a >= 1.5 ? 'jumps' : a >= 0.6 ? 'climbs' : 'ticks up';
  return a >= 3 ? 'plunges' : a >= 1.5 ? 'drops' : a >= 0.6 ? 'slides' : 'dips';
}

interface Ctx {
  bar: Bar;
  session: Session;
  group: Group;
  shape: Shape;
  now: number;
  price: number;
  final: boolean;
  context: number;
  ctxFactor?: string;
  /** Thin extended-hours trading outside an event window: demand bigger moves. */
  strict: boolean;
  pctMin: number;
}

interface MoveCand {
  ref: Bar;
  minutes: number;
  pct: number;
  z: number;
  volMult: number | null;
  dir: Dir;
}

interface OpenMove {
  play: Play;
  dir: Dir;
  /** Price the move is measured from (an earlier close, or the 4 PM close for an earnings reaction). */
  startPrice: number;
  startT: number;
  /** When the price actually started moving. */
  moveStartT: number;
  /** Per-minute sigma (with time-of-day shape) when the move began: its yardstick for life. */
  base: number;
  extreme: number;
  lastExtendT: number;
  prefix?: string;
  refLabel?: string;
  fadeNote?: string;
  fadeFactor?: string;
  /** Closed by a big enough move the other way: later moves in this direction are new plays. */
  closed?: boolean;
}

interface Major {
  playId: string;
  dir: Dir;
  start: number;
  extreme: number;
  rating: number;
  /** How many fade levels (half, all) have been called. */
  level: number;
  t: number;
  /** The fade play for this move, which grows from "half" to "all" in place. */
  fadePlay?: Play;
}

interface Run {
  dir: Dir;
  count: number;
  start: number;
  startT: number;
  milestone: number;
  play?: Play;
}

interface Extreme {
  price: number;
  t: number;
}

interface Break {
  dir: Dir;
  /** Appended to a move's title. */
  suffix: string;
  /** Title when the break is the play. */
  headline: string;
  factor: string;
  novelty: number;
  /** Clearing the regular session's high or low after hours. */
  regular: boolean;
}

interface Fade {
  major: Major;
  level: number;
  merged: boolean;
}

/**
 * Turns a stream of one-minute bars into rated "plays", the way a sports feed turns a game into
 * plays. Feed it bars in time order with `update`: partial updates for a bar still forming (so a
 * move is called seconds after it happens, not at the end of the minute) and a final update when
 * the bar closes. Each call returns the plays it found and the in-progress plays that grew.
 *
 * Deterministic: the same bars always produce the same plays, which is what makes replays and
 * honest scoring possible.
 */
export class PlayEngine {
  readonly symbol: string;
  private readonly asset: AssetClass;
  private readonly minRating: number;
  private readonly events: ScheduledEvent[];
  private readonly closes: Record<string, number>;
  /** Percent move at which surprise counts fully in the rating. */
  private readonly fullAt: number;
  /** Smallest move (percent) that counts as a big move worth calling fades of, or as a reaction. */
  private readonly bigPct: number;

  private readonly history: Bar[] = [];
  private readonly vol: Record<Group, VolTracker>;
  private readonly volume: Record<Group, VolumeTracker> = {
    regular: new VolumeTracker(),
    extended: new VolumeTracker(),
    always: new VolumeTracker(),
  };

  private day = '';
  private prevClose: number | undefined;
  private lastRegularClose: number | undefined;
  private todayClose: number | undefined;
  private readonly highs = new Map<Session, Extreme>();
  private readonly lows = new Map<Session, Extreme>();
  private readonly sessionBars = new Map<Session, number>();
  private regularHighBroken = false;
  private regularLowBroken = false;
  private readonly lastBreakT = new Map<Dir, number>();
  private readonly bells = new Set<string>();
  private readonly firedEvents = new Set<number>();
  private catalyst: {
    event: ScheduledEvent;
    until: number;
    reacted: boolean;
    reactedAt?: number;
    price: number;
  } | null = null;
  /** The latest move in each direction. While active, it grows in place instead of repeating. */
  private readonly openBy = new Map<Dir, OpenMove>();
  private major: Major | null = null;
  private run: Run | null = null;
  private lastVolumeT = -Infinity;
  private readonly firedInBar = new Map<string, number>();
  private seq = 0;
  private silent = false;

  constructor(opts: EngineOptions) {
    this.symbol = opts.symbol;
    this.asset = opts.assetClass;
    this.minRating = opts.minRating ?? 4;
    this.prevClose = opts.prevClose;
    this.closes = opts.closes ?? {};
    this.events = [...(opts.events ?? [])].sort((a, b) => a.t - b.t);
    this.fullAt = this.asset === 'crypto' ? 0.7 : 1;
    this.bigPct = this.asset === 'crypto' ? 0.7 : 1;
    // Per-minute sigma floors and fallbacks (fractions of price).
    this.vol = {
      regular: new VolTracker(0.0003, 0.0012),
      extended: new VolTracker(0.0004, 0.0015),
      always: new VolTracker(0.0002, 0.001),
    };
  }

  /** Feed history without emitting plays, so baselines, highs, lows and bells are already set. */
  warmup(bars: Bar[]): void {
    this.silent = true;
    for (const b of bars) this.update(b, true);
    this.silent = false;
    // Plays from the warmup were never shown, so later moves start fresh.
    this.openBy.clear();
    if (this.major) this.major.fadePlay = undefined;
    if (this.run) this.run.play = undefined;
  }

  /** The latest completed bar. */
  get lastBar(): Bar | undefined {
    return this.history.at(-1);
  }

  update(bar: Bar, final: boolean, now?: number): EngineEvent[] {
    const t = now ?? bar.t + (final ? MIN - 1 : 0);
    const out: EngineEvent[] = [];
    const session = sessionOf(bar.t, this.asset);
    if (session === 'closed') {
      if (final) this.commit(bar, session);
      return out;
    }
    this.rollDay(bar.t);
    this.contextPlays(bar, session, final, t, out);
    const ctx = this.ctx(bar, session, final, t);
    if (this.ready(ctx.group)) this.detect(ctx, out);
    if (final) this.commit(bar, session);
    return this.silent ? [] : out;
  }

  private rate(i: RatingInput) {
    return rateMove({ fullAt: this.fullAt, ...i });
  }

  // ── context: bells and scheduled events ──────────────────────────────────

  private contextPlays(bar: Bar, session: Session, final: boolean, now: number, out: EngineEvent[]) {
    if (this.asset === 'equity') {
      const m = etMinuteOfDay(bar.t);
      if (session === 'regular' && !this.bells.has('open')) {
        this.bells.add('open');
        const gap = this.prevClose ? pctChange(this.prevClose, bar.o) : undefined;
        this.push(
          out,
          this.make('bell', bar, session, bar.t, bar.o, {
            dir: gap === undefined ? 0 : sign(gap),
            rating: 2 + (gap === undefined ? 0 : 1.5 * Math.log2(1 + Math.abs(gap))),
            title:
              `Opening bell: ${this.symbol} opens at ${fmtPrice(bar.o)}` +
              (gap === undefined ? '' : `, ${fmtPct(gap)} vs yesterday's close`),
            factors: gap === undefined ? ['Opening bell'] : ['Opening bell', `Gap ${fmtPct(gap)}`],
            pct: gap === undefined ? undefined : round2(gap),
          }),
        );
      }
      const closingBar = session === 'regular' && final && m === CLOSE_MIN - 1;
      if (!this.bells.has('close') && this.bells.has('open') && (closingBar || session === 'post')) {
        this.bells.add('close');
        const close = closingBar ? bar.c : (this.lastRegularClose ?? bar.o);
        this.todayClose = close;
        const day = this.prevClose ? pctChange(this.prevClose, close) : undefined;
        this.push(
          out,
          this.make('bell', bar, session, closingBar ? bar.t + MIN : bar.t, close, {
            dir: day === undefined ? 0 : sign(day),
            rating: 2 + (day === undefined ? 0 : 1.2 * Math.log2(1 + Math.abs(day))),
            title:
              `Closing bell: ${this.symbol} closes at ${fmtPrice(close)}` +
              (day === undefined ? '' : `, ${fmtPct(day)} on the day`),
            factors: day === undefined ? ['Closing bell'] : ['Closing bell', `Day ${fmtPct(day)}`],
            pct: day === undefined ? undefined : round2(day),
          }),
        );
      }
      if (session === 'post' && final && m === POST_END_MIN - 1 && this.todayClose && !this.bells.has('wrap')) {
        this.bells.add('wrap');
        const ah = pctChange(this.todayClose, bar.c);
        this.push(
          out,
          this.make('bell', bar, session, bar.t + MIN, bar.c, {
            dir: sign(ah),
            rating: 2 + 1.2 * Math.log2(1 + Math.abs(ah)),
            title: `After-hours wrap: ${this.symbol} last ${fmtPrice(bar.c)}, ${fmtPct(ah)} vs the close`,
            factors: ['After-hours close', `${fmtPct(ah)} after hours`],
            pct: round2(ah),
          }),
        );
      }
    }
    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i]!;
      if (this.firedEvents.has(i) || now < ev.t) continue;
      this.firedEvents.add(i);
      if (now - ev.t > 12 * 60 * MIN) continue; // long past
      this.catalyst = { event: ev, until: ev.t + (ev.windowMin ?? 90) * MIN, reacted: false, price: bar.c };
      this.push(
        out,
        this.make('event', bar, session, now, bar.c, {
          dir: 0,
          rating: ev.kind === 'earnings' ? 5 : 4,
          title: ev.title,
          factors: [ev.kind === 'earnings' ? 'Earnings' : ev.kind === 'macro' ? 'Macro event' : 'Scheduled event'],
        }),
      );
    }
  }

  private ctx(bar: Bar, session: Session, final: boolean, now: number): Ctx {
    const ext = session === 'pre' || session === 'post';
    const cat = this.catalyst;
    const hotUntil = cat
      ? cat.reactedAt !== undefined
        ? Math.min(cat.until, cat.reactedAt + HOT_AFTER_REACTION)
        : cat.until
      : 0;
    const hot = !!cat && now >= cat.event.t && now <= hotUntil;
    return {
      bar,
      session,
      final,
      now,
      price: bar.c,
      group: groupOf(session),
      shape: intradayShape(bar.t, this.asset),
      context: hot ? 1.15 : ext ? 0.9 : 1,
      ctxFactor: hot
        ? cat!.event.kind === 'earnings'
          ? 'Earnings window'
          : 'Event window'
        : ext
          ? session === 'pre'
            ? 'Pre-market'
            : 'After hours'
          : undefined,
      strict: ext && !hot,
      pctMin: this.asset === 'crypto' ? 0.15 : ext && !hot ? 0.4 : 0.25,
    };
  }

  private ready(g: Group): boolean {
    return this.vol[g].samples >= 10 || this.history.length >= 30;
  }

  // ── detection ────────────────────────────────────────────────────────────

  private detect(c: Ctx, out: EngineEvent[]) {
    // Thin extended-hours trading: one odd print can fake a spike mid-minute, so outside event
    // windows only closed minutes can start a play.
    if (c.strict && !c.final) {
      this.extendOpen(c, null, null, out);
      return;
    }
    const fade = this.checkFade(c);
    const brk = this.checkBreak(c);
    let handled = this.extendOpen(c, brk, fade, out);
    if (!handled) {
      const best = this.bestMove(c);
      if (best) handled = this.onMove(best, brk, fade, c, out);
    }
    // A break in the direction of a move in progress is already part of that move's story.
    if (!handled && brk && !this.activeOpen(brk.dir, c.now)) handled = this.onBreak(brk, c, out);
    if (fade && !fade.merged) this.onFade(fade, c, out);
    if (c.final) {
      this.onRun(c, out);
      this.onVolume(c, out);
    }
    const m = this.major;
    if (m) m.extreme = m.dir === 1 ? Math.max(m.extreme, c.price) : Math.min(m.extreme, c.price);
  }

  private isActive(o: OpenMove | null | undefined, now: number): o is OpenMove {
    return !!o && !o.closed && now - o.lastExtendT <= EXTEND_GAP && now - o.startT <= MOVE_MAX_AGE;
  }

  /** A counter-move at least half the size of the move it opposes ends that move. */
  private closeOpposite(om: OpenMove, now: number) {
    const opp = this.activeOpen(om.dir === 1 ? -1 : 1, now);
    if (opp && Math.abs(om.play.pct ?? 0) >= 0.5 * Math.abs(opp.play.pct ?? 0)) opp.closed = true;
  }

  private activeOpen(dir: Dir, now: number): OpenMove | null {
    const o = this.openBy.get(dir);
    return this.isActive(o, now) ? o : null;
  }

  /** A move in progress that just made a new extreme grows in place instead of becoming a new play. */
  private extendOpen(c: Ctx, brk: Break | null, fade: Fade | null, out: EngineEvent[]): boolean {
    const o = [this.activeOpen(1, c.now), this.activeOpen(-1, c.now)].find(
      (m) => m && (m.dir === 1 ? c.price > m.extreme : c.price < m.extreme),
    );
    if (!o) return false;
    o.extreme = c.price;
    o.lastExtendT = c.now;
    const opposed = fade && fade.major.dir !== o.dir ? fade : null;
    const fadeText = opposed && !o.fadeNote && !o.prefix ? this.fadeText(opposed) : null;
    if (fadeText) Object.assign(o, fadeText);
    const sameDirBreak = brk && brk.dir === o.dir ? brk : null;
    const before = { rating: o.play.rating, pct: o.play.pct ?? 0 };
    this.fillMove(o, c, sameDirBreak);
    // An earnings reaction is the headline; a fade it causes needs no play of its own.
    if (opposed && (fadeText || o.prefix)) this.consumeFade(opposed);
    if (sameDirBreak) this.noteBreak(sameDirBreak, c);
    this.closeOpposite(o, c.now);
    this.trackMajor(o, c);
    const grew =
      !!fadeText ||
      !!sameDirBreak ||
      Math.abs(o.play.rating - before.rating) >= 0.3 ||
      Math.abs((o.play.pct ?? 0) - before.pct) >= Math.max(0.15, 0.1 * Math.abs(before.pct));
    if (grew || c.final) {
      o.play.revision++;
      o.play.updatedAt = c.now;
      this.push(out, o.play, 'update');
    }
    return true;
  }

  /** The most surprising move ending now, across the look-back windows. */
  private bestMove(c: Ctx): MoveCand | null {
    const zMin = c.strict ? 4.5 : 3.5;
    const exp = this.volume[c.group].expected(c.shape.volume);
    let best: MoveCand | null = null;
    for (const w of WINDOWS) {
      const ref = this.refBar(c.bar.t - w * MIN);
      if (!ref || c.bar.t - ref.t > (w + 30) * MIN) continue;
      const minutes = Math.max(1, (c.now - (ref.t + MIN)) / MIN);
      const r = Math.log(c.price / ref.c);
      const dir: Dir = r > 0 ? 1 : -1;
      // A follow-on move is measured from where the last move in its direction ended, so the
      // same drop is never counted twice.
      const last = this.openBy.get(dir);
      if (last && c.now - last.lastExtendT < 30 * MIN && ref.t + MIN < last.lastExtendT) continue;
      const z = Math.abs(r) / this.vol[c.group].sigma(minutes, c.shape.vol);
      const pct = pctChange(ref.c, c.price);
      if (z < zMin || Math.abs(pct) < c.pctMin || (best && z <= best.z)) continue;
      best = { ref, minutes, pct, z, dir, volMult: this.volMult(ref.t, c, exp) };
    }
    return best;
  }

  private onMove(cand: MoveCand, brk: Break | null, fade: Fade | null, c: Ctx, out: EngineEvent[]): boolean {
    // Still inside a move already on the feed.
    if (this.activeOpen(cand.dir, c.now)) return true;
    if (this.firedInBar.get('move') === c.bar.t) return true;

    // The first big move inside a scheduled event's window is its reaction, measured from the close.
    const cat = this.catalyst;
    const reacting =
      !!cat &&
      !cat.reacted &&
      c.now >= cat.event.t &&
      c.now <= cat.until &&
      cand.z >= 6 &&
      Math.abs(cand.pct) >= this.bigPct;
    let startPrice = cand.ref.c;
    let startT = cand.ref.t + MIN;
    let prefix: string | undefined;
    let refLabel: string | undefined;
    if (reacting) {
      const ref =
        c.session === 'post'
          ? (this.todayClose ?? this.lastRegularClose)
          : c.session === 'pre'
            ? this.prevClose
            : cat!.price;
      if (ref) {
        startPrice = ref;
        startT = cat!.event.t;
        prefix = cat!.event.kind === 'earnings' ? 'Earnings reaction' : 'Reaction';
        refLabel = c.session === 'post' ? 'from the close' : c.session === 'pre' ? "from yesterday's close" : 'since the news';
      }
    }
    const play = this.make(prefix ? 'reaction' : 'move', c.bar, c.session, c.now, c.price, {
      dir: cand.dir,
      rating: 0,
      title: '',
      factors: [],
    });
    const om: OpenMove = {
      play,
      dir: cand.dir,
      startPrice,
      startT,
      moveStartT: cand.ref.t + MIN,
      base: this.vol[c.group].base() * c.shape.vol,
      extreme: c.price,
      lastExtendT: c.now,
      prefix,
      refLabel,
    };
    const fadeText = fade && fade.major.dir !== cand.dir && !prefix ? this.fadeText(fade) : null;
    if (fadeText) Object.assign(om, fadeText);
    const sameDirBreak = brk && brk.dir === cand.dir ? brk : null;
    this.fillMove(om, c, sameDirBreak, prefix ? undefined : cand);
    if (!this.push(out, play)) return false;
    if (reacting && prefix) {
      cat!.reacted = true;
      cat!.reactedAt = c.now;
    }
    // An earnings reaction is the headline; a fade it causes needs no play of its own.
    if (fade && fade.major.dir !== cand.dir && (fadeText || prefix)) this.consumeFade(fade);
    if (sameDirBreak) this.noteBreak(sameDirBreak, c);
    this.firedInBar.set('move', c.bar.t);
    this.closeOpposite(om, c.now);
    this.openBy.set(cand.dir, om);
    this.trackMajor(om, c);
    return true;
  }

  /** Recompute a move's stats, rating, title and factors from its start to now. */
  private fillMove(om: OpenMove, c: Ctx, brk: Break | null, cand?: MoveCand) {
    const pct = cand ? cand.pct : pctChange(om.startPrice, c.price);
    // Duration of the actual move (an earnings reaction's percent runs from the close, but its
    // surprise is judged over the minutes the price really moved).
    const minutes = cand ? cand.minutes : Math.max(1, (c.now - om.moveStartT) / MIN);
    const z = cand ? cand.z : Math.abs(Math.log(c.price / om.startPrice)) / (om.base * Math.sqrt(minutes));
    const volMult = cand ? cand.volMult : this.volMult(om.moveStartT - MIN, c);
    const novelty = (brk ? brk.novelty : 0) + (om.prefix ? 0.8 : 0);
    const { rating, parts } = this.rate({ z, pct, volMult, novelty, context: c.context });
    let title = om.prefix
      ? `${om.prefix}: ${this.symbol} ${fmtPct(pct)} ${om.refLabel}, now ${fmtPrice(c.price)}`
      : `${this.symbol} ${verb(om.dir, pct)} ${fmtAbsPct(pct)} in ${fmtMinutes(minutes)} to ${fmtPrice(c.price)}`;
    if (brk) title += `, ${brk.suffix}`;
    if (om.fadeNote) title += `, ${om.fadeNote}`;
    const p = om.play;
    p.rating = rating;
    p.parts = parts;
    p.title = title;
    p.pct = round2(pct);
    p.minutes = Math.round(minutes);
    p.endPrice = c.price;
    p.factors = [
      `${fmtMult(z)} a normal ${Math.round(minutes)}-min move`,
      volMult && volMult >= 2 ? `${fmtMult(volMult)} normal volume` : undefined,
      brk?.factor,
      om.fadeFactor,
      c.ctxFactor,
    ].filter(isStr);
  }

  /** Big moves (rated 7+ and at least 1%) are remembered, so giving them back can be called. */
  private trackMajor(om: OpenMove, c: Ctx) {
    const m = this.major;
    if (m && m.playId === om.play.id) {
      m.rating = Math.max(m.rating, om.play.rating);
      return;
    }
    if (om.play.rating >= 7 && Math.abs(om.play.pct ?? 0) >= this.bigPct) {
      this.major = {
        playId: om.play.id,
        dir: om.dir,
        start: om.startPrice,
        extreme: c.price,
        rating: om.play.rating,
        level: 0,
        t: c.now,
      };
    }
  }

  // ── session highs and lows ───────────────────────────────────────────────

  private checkBreak(c: Ctx): Break | null {
    const s = c.session;
    // After hours, clearing the regular session's high or low is its own milestone.
    if (s === 'post') {
      const rh = this.highs.get('regular');
      const rl = this.lows.get('regular');
      if (rh && !this.regularHighBroken && c.price > rh.price) {
        return {
          dir: 1,
          suffix: `clearing the day's high of ${fmtPrice(rh.price)}`,
          headline: `${this.symbol} clears the day's high of ${fmtPrice(rh.price)}, now ${fmtPrice(c.price)}`,
          factor: `Above the regular-session high (${fmtPrice(rh.price)})`,
          novelty: 1.8,
          regular: true,
        };
      }
      if (rl && !this.regularLowBroken && c.price < rl.price) {
        return {
          dir: -1,
          suffix: `breaking the day's low of ${fmtPrice(rl.price)}`,
          headline: `${this.symbol} breaks the day's low of ${fmtPrice(rl.price)}, now ${fmtPrice(c.price)}`,
          factor: `Below the regular-session low (${fmtPrice(rl.price)})`,
          novelty: 1.8,
          regular: true,
        };
      }
    }
    const minBars = s === 'pre' || s === 'post' ? 5 : 15;
    if ((this.sessionBars.get(s) ?? 0) < minBars) return null;
    for (const dir of [1, -1] as const) {
      const e = dir === 1 ? this.highs.get(s) : this.lows.get(s);
      if (!e) continue;
      const crossed = dir === 1 ? c.price > e.price : c.price < e.price;
      if (!crossed || c.now - e.t < 10 * MIN || c.now - (this.lastBreakT.get(dir) ?? -Infinity) < 10 * MIN) continue;
      const stood = (c.now - e.t) / MIN;
      const word = dir === 1 ? 'high' : 'low';
      const where = s === 'pre' ? `pre-market ${word}` : s === 'post' ? `after-hours ${word}` : `${word} of the day`;
      return {
        dir,
        suffix: `a new ${where}`,
        headline: `${this.symbol} hits a new ${where} at ${fmtPrice(c.price)}`,
        factor: `New ${where} (the old one stood ${fmtDuration(stood)})`,
        novelty: 1 + Math.log2(1 + stood / 30),
        regular: false,
      };
    }
    return null;
  }

  private noteBreak(b: Break, c: Ctx) {
    this.lastBreakT.set(b.dir, c.now);
    if (b.regular) {
      if (b.dir === 1) this.regularHighBroken = true;
      else this.regularLowBroken = true;
    }
  }

  private onBreak(b: Break, c: Ctx, out: EngineEvent[]): boolean {
    if (this.firedInBar.get('break') === c.bar.t) return true;
    const ref = this.refBar(c.bar.t - 5 * MIN);
    const minutes = ref ? Math.max(1, (c.now - (ref.t + MIN)) / MIN) : 5;
    const pct = ref ? pctChange(ref.c, c.price) : 0;
    const z = ref ? Math.abs(Math.log(c.price / ref.c)) / this.vol[c.group].sigma(minutes, c.shape.vol) : 0;
    const volMult = ref ? this.volMult(ref.t, c) : null;
    const { rating, parts } = this.rate({ z, pct, volMult, novelty: b.novelty, context: c.context });
    const play = this.make(b.dir === 1 ? 'high' : 'low', c.bar, c.session, c.now, c.price, {
      dir: b.dir,
      rating,
      parts,
      title: b.headline,
      factors: [b.factor, volMult && volMult >= 2 ? `${fmtMult(volMult)} normal volume` : undefined, c.ctxFactor].filter(
        isStr,
      ),
      pct: round2(pct),
      minutes: Math.round(minutes),
    });
    if (!this.push(out, play)) return false;
    this.firedInBar.set('break', c.bar.t);
    this.noteBreak(b, c);
    return true;
  }

  // ── fades of a big move ──────────────────────────────────────────────────

  private checkFade(c: Ctx): Fade | null {
    const m = this.major;
    if (!m) return null;
    if (c.now - m.t > 180 * MIN) {
      this.major = null;
      return null;
    }
    const span = (m.extreme - m.start) * m.dir;
    if (span <= 0) return null;
    const frac = ((m.extreme - c.price) * m.dir) / span;
    const level = [0.5, 1][m.level];
    if (level === undefined || frac < level) return null;
    return { major: m, level, merged: false };
  }

  private fadeText(f: Fade): { fadeNote: string; fadeFactor: string } {
    const whole = f.level >= 1;
    if (f.major.dir === 1) {
      return whole
        ? { fadeNote: 'erasing the whole pop', fadeFactor: 'Round trip: the whole pop is gone' }
        : { fadeNote: 'giving back half the pop', fadeFactor: 'Gave back half the pop' };
    }
    return whole
      ? { fadeNote: 'erasing the whole drop', fadeFactor: 'Round trip: the whole drop is gone' }
      : { fadeNote: 'recovering half the drop', fadeFactor: 'Won back half the drop' };
  }

  private consumeFade(f: Fade) {
    f.merged = true;
    f.major.level++;
  }

  private onFade(f: Fade, c: Ctx, out: EngineEvent[]) {
    // A move already running the other way tells this story: add it to that play.
    const o = this.activeOpen(f.major.dir === 1 ? -1 : 1, c.now);
    if (o) {
      if (!o.prefix && !o.fadeNote) {
        Object.assign(o, this.fadeText(f));
        this.fillMove(o, c, null);
        o.play.revision++;
        o.play.updatedAt = c.now;
        this.push(out, o.play, 'update');
      }
      this.consumeFade(f);
      return;
    }
    if (this.firedInBar.get('fade') === c.bar.t) return;
    const m = f.major;
    const whole = f.level >= 1;
    // A spike that gives back half within a couple of minutes is whipsaw: wait to see if it sticks.
    if (!whole && c.now - m.t < 3 * MIN) return;
    const fromExtreme = pctChange(m.extreme, c.price);
    const what = m.dir === 1 ? 'pop' : 'drop';
    const headline =
      m.dir === 1
        ? whole
          ? `${this.symbol} erases the whole pop, back to ${fmtPrice(c.price)}`
          : `${this.symbol} gives back half the pop, back to ${fmtPrice(c.price)}`
        : whole
          ? `${this.symbol} erases the whole drop, back to ${fmtPrice(c.price)}`
          : `${this.symbol} recovers half the drop, back to ${fmtPrice(c.price)}`;
    const fields = {
      rating: round1(clamp(0.55 * m.rating + (whole ? 0.6 : 0), 0, 10)),
      title: headline,
      factors: [`${fmtPct(fromExtreme)} from the ${m.dir === 1 ? 'peak' : 'bottom'} of the ${what}`, c.ctxFactor].filter(
        isStr,
      ),
      pct: round2(fromExtreme),
      endPrice: c.price,
    };
    // One fade play per big move: "gives back half" grows into "erases the whole" in place.
    if (m.fadePlay) {
      Object.assign(m.fadePlay, fields, { updatedAt: c.now });
      m.fadePlay.revision++;
      this.push(out, m.fadePlay, 'update');
      this.firedInBar.set('fade', c.bar.t);
      this.consumeFade(f);
      return;
    }
    const play = this.make('fade', c.bar, c.session, c.now, c.price, { dir: (m.dir === 1 ? -1 : 1) as Dir, ...fields });
    if (this.push(out, play)) {
      m.fadePlay = play;
      this.firedInBar.set('fade', c.bar.t);
      this.consumeFade(f);
    }
  }

  // ── runs and volume (closed bars only) ───────────────────────────────────

  private onRun(c: Ctx, out: EngineEvent[]) {
    const prev = this.history.at(-1);
    if (!prev || c.bar.t - prev.t > 2 * MIN) {
      this.run = null;
      return;
    }
    const d = sign(c.bar.c - prev.c);
    if (d === 0) return;
    if (!this.run || this.run.dir !== d) {
      this.run = { dir: d, count: 0, start: prev.c, startT: prev.t + MIN, milestone: 0 };
    }
    const run = this.run;
    run.count++;
    const ms = RUN_MILESTONES.filter((x) => x <= run.count).pop();
    if (!ms || ms <= run.milestone) return;
    run.milestone = ms;
    if (this.activeOpen(d, c.now)) return; // the move already covers it
    const minutes = run.count;
    const pct = pctChange(run.start, c.price);
    const z = Math.abs(Math.log(c.price / run.start)) / this.vol[c.group].sigma(minutes, c.shape.vol);
    if (z < 2.5 || Math.abs(pct) < c.pctMin) return;
    const volMult = this.volMult(run.startT - MIN, c);
    const r = this.rate({ z, pct, volMult, novelty: 0.5 + 0.15 * run.count, context: c.context });
    const title = `${this.symbol} ${d === 1 ? 'up' : 'down'} ${run.count} straight minutes, ${fmtPct(pct)} to ${fmtPrice(c.price)}`;
    const factors = [
      `${run.count} ${d === 1 ? 'green' : 'red'} minutes in a row`,
      `${fmtMult(z)} a normal ${minutes}-min move`,
      volMult && volMult >= 2 ? `${fmtMult(volMult)} normal volume` : undefined,
      c.ctxFactor,
    ].filter(isStr);
    if (run.play) {
      Object.assign(run.play, {
        rating: r.rating,
        parts: r.parts,
        title,
        factors,
        pct: round2(pct),
        minutes,
        endPrice: c.price,
        updatedAt: c.now,
      });
      run.play.revision++;
      this.push(out, run.play, 'update');
    } else {
      const play = this.make('run', c.bar, c.session, c.now, c.price, {
        dir: d,
        rating: r.rating,
        parts: r.parts,
        title,
        factors,
        pct: round2(pct),
        minutes,
      });
      if (this.push(out, play)) run.play = play;
    }
  }

  /**
   * Heavy volume without a big price move: someone is trading size. Only when it is heavy against
   * both the long-run normal and the last few minutes (right after earnings, everything is heavy).
   */
  private onVolume(c: Ctx, out: EngineEvent[]) {
    if (isCrossBar(c.bar.t, this.asset) || c.now - this.lastVolumeT < 10 * MIN) return;
    if (['move', 'break', 'fade'].some((k) => this.firedInBar.get(k) === c.bar.t)) return;
    if ([...this.openBy.values()].some((o) => c.now - o.lastExtendT <= 2 * MIN)) return;
    const exp = this.volume[c.group].expected(c.shape.volume);
    if (!exp) return;
    const mult = c.bar.v / exp;
    if (mult < 8) return;
    const recent = this.volume[c.group].recent(c.shape.volume);
    if (recent && c.bar.v < 3 * recent) return;
    const prev = this.history.at(-1);
    const pct = prev ? pctChange(prev.c, c.price) : 0;
    const z = prev ? Math.abs(Math.log(c.price / prev.c)) / this.vol[c.group].sigma(1, c.shape.vol) : 0;
    const r = this.rate({ z, pct, volMult: mult, novelty: 0.8, context: c.context });
    const steady = Math.abs(pct) < 0.05;
    const play = this.make('volume', c.bar, c.session, c.now, c.price, {
      dir: steady ? 0 : sign(pct),
      rating: r.rating,
      parts: r.parts,
      title: `Heavy volume in ${this.symbol}: ${fmtMult(mult)} normal, ${steady ? 'price steady' : `price ${fmtPct(pct)}`} at ${fmtPrice(c.price)}`,
      factors: [`${fmtMult(mult)} normal volume for this time of day`, c.ctxFactor].filter(isStr),
      pct: round2(pct),
      minutes: 1,
    });
    if (this.push(out, play)) this.lastVolumeT = c.now;
  }

  // ── bookkeeping ──────────────────────────────────────────────────────────

  private volMult(afterT: number, c: Ctx, exp = this.volume[c.group].expected(c.shape.volume)): number | null {
    if (!exp) return null;
    let sum = c.bar.v;
    let n = 1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const b = this.history[i]!;
      if (b.t <= afterT) break;
      sum += b.v;
      n++;
    }
    return sum / (exp * n);
  }

  /** Latest completed bar that started at or before `tMax`. */
  private refBar(tMax: number): Bar | undefined {
    const h = this.history;
    let lo = 0;
    let hi = h.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (h[mid]!.t <= tMax) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans >= 0 ? h[ans] : undefined;
  }

  private rollDay(t: number) {
    const d = dayKey(t, this.asset);
    if (d === this.day) return;
    const hadDay = this.day !== '';
    this.day = d;
    if (this.closes[d] !== undefined) this.prevClose = this.closes[d];
    else if (hadDay)
      this.prevClose = this.asset === 'crypto' ? this.history.at(-1)?.c : (this.lastRegularClose ?? this.prevClose);
    this.highs.clear();
    this.lows.clear();
    this.sessionBars.clear();
    this.bells.clear();
    this.lastBreakT.clear();
    this.regularHighBroken = false;
    this.regularLowBroken = false;
    this.todayClose = undefined;
    this.openBy.clear();
    this.major = null;
    this.run = null;
  }

  private commit(bar: Bar, session: Session) {
    if (session !== 'closed') {
      const g = groupOf(session);
      const shape = intradayShape(bar.t, this.asset);
      const auction = isAuctionBar(bar.t, this.asset);
      const prev = this.history.at(-1);
      if (prev && !auction && groupOf(sessionOf(prev.t, this.asset)) === g && bar.t - prev.t <= 30 * MIN) {
        this.vol[g].push(Math.log(bar.c / prev.c), (bar.t - prev.t) / MIN, shape.vol);
      }
      if (!auction) this.volume[g].push(bar.v, shape.volume);
      const hi = this.highs.get(session);
      if (!hi || bar.h > hi.price) this.highs.set(session, { price: bar.h, t: bar.t });
      const lo = this.lows.get(session);
      if (!lo || bar.l < lo.price) this.lows.set(session, { price: bar.l, t: bar.t });
      this.sessionBars.set(session, (this.sessionBars.get(session) ?? 0) + 1);
      if (session === 'regular') this.lastRegularClose = bar.c;
    }
    this.history.push(bar);
    if (this.history.length > 3000) this.history.splice(0, 1000);
  }

  private push(out: EngineEvent[], play: Play, type: 'play' | 'update' = 'play'): boolean {
    const contextual = play.kind === 'bell' || play.kind === 'event';
    if (type === 'play' && !contextual && play.rating < this.minRating) return false;
    out.push({ type, play: { ...play, factors: [...play.factors], parts: play.parts ? { ...play.parts } : undefined } });
    return true;
  }

  private make(
    kind: PlayKind,
    bar: Bar,
    session: Session,
    t: number,
    price: number,
    f: {
      dir: Dir | 0;
      rating: number;
      title: string;
      factors: string[];
      parts?: RatingParts;
      pct?: number;
      minutes?: number;
    },
  ): Play {
    return {
      id: `${this.symbol}-${kind}-${bar.t}-${++this.seq}`,
      symbol: this.symbol,
      kind,
      session,
      t,
      price,
      barT: bar.t,
      revision: 0,
      ...f,
      rating: round1(f.rating),
    };
  }
}
