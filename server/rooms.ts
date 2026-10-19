import type { WebSocket } from 'ws';
import { PlayEngine, type Bar, type EngineEvent, type Play } from '../engine';
import { loadDay } from './data';
import { CoinbaseFeed } from './coinbase';
import { finalPlays, loadScenarios, timelineFor, type Scenario, type Timeline } from './replay';
import {
  SPEEDS,
  type ClientMsg,
  type ControlAction,
  type LiveState,
  type ReplayState,
  type RoomMeta,
  type ServerMsg,
  type SnapshotMsg,
} from './protocol';

const MIN = 60_000;

export interface Client {
  ws: WebSocket;
  room?: Room;
}

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/**
 * A room is one "game": everyone in it sees the same price, the same plays, at the same moment.
 * That shared clock is what the comments will hang on in the next slice.
 */
export abstract class Room {
  readonly clients = new Set<Client>();

  constructor(readonly meta: RoomMeta) {}

  join(c: Client) {
    this.clients.add(c);
    c.room = this;
    send(c.ws, this.snapshot());
    this.onJoin();
  }

  leave(c: Client) {
    this.clients.delete(c);
    if (c.room === this) c.room = undefined;
    if (!this.clients.size) this.onEmpty();
  }

  broadcast(msg: ServerMsg) {
    const s = JSON.stringify(msg);
    for (const c of this.clients) if (c.ws.readyState === 1) c.ws.send(s);
  }

  abstract snapshot(): SnapshotMsg;
  control(_action: ControlAction, _value?: number): void {}
  protected onJoin(): void {}
  protected onEmpty(): void {}
}

// ── replays ────────────────────────────────────────────────────────────────

/** Plays back a recorded session through the engine on a shared clock, at 1×–120× speed. */
export class ReplayRoom extends Room {
  private tl: Timeline | null = null;
  private idx = 0;
  private simTime = 0;
  private playing = false;
  private speed = 30;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReal = 0;
  private started = false;
  private marks: { t: number; rating: number }[] | null = null;

  constructor(private readonly sc: Scenario) {
    super(replayMeta(sc));
  }

  private timeline(): Timeline | null {
    if (!this.tl) {
      this.tl = timelineFor(this.sc);
      if (this.tl) this.simTime = this.tl.startMs;
    }
    return this.tl;
  }

  snapshot(): SnapshotMsg {
    const tl = this.timeline();
    const meta = { ...this.meta, ready: !!tl };
    if (!tl) return { type: 'snapshot', room: meta, bars: [], plays: [], price: null, refPrice: null, now: Date.now() };
    const bars = new Map<number, Bar>();
    for (const b of tl.history) bars.set(b.t, b);
    for (let i = 0; i < this.idx; i++) {
      const f = tl.frames[i]!;
      bars.set(f.bar.t, f.bar);
    }
    const list = [...bars.values()];
    return {
      type: 'snapshot',
      room: meta,
      bars: list,
      plays: finalPlays(tl.frames.slice(0, this.idx)),
      price: list.at(-1)?.c ?? null,
      refPrice: tl.prevClose,
      replay: this.state(),
      now: this.simTime,
    };
  }

  private state(): ReplayState {
    const tl = this.tl!;
    return {
      playing: this.playing,
      speed: this.speed,
      simTime: this.simTime,
      startMs: tl.startMs,
      endMs: tl.endMs,
      ended: this.idx >= tl.frames.length,
      highlights: this.highlights(),
    };
  }

  /** When the big plays land (rated 7+), for the progress bar and "next big play". */
  private highlights() {
    if (!this.marks) {
      const first = new Map<string, number>();
      const plays = new Map<string, Play>();
      for (const f of this.tl!.frames) {
        for (const e of f.events) {
          if (!first.has(e.play.id)) first.set(e.play.id, f.t);
          plays.set(e.play.id, e.play);
        }
      }
      this.marks = [...plays.values()]
        .filter((p) => p.rating >= 7 && p.kind !== 'bell' && p.kind !== 'event')
        .map((p) => ({ t: first.get(p.id)!, rating: p.rating }))
        .sort((a, b) => a.t - b.t);
    }
    return this.marks;
  }

  protected override onJoin() {
    if (!this.started && this.timeline()) {
      this.started = true;
      this.play();
    }
  }

  protected override onEmpty() {
    this.pause();
  }

  private play() {
    const tl = this.timeline();
    if (!tl) return;
    if (this.idx >= tl.frames.length) this.seek(tl.startMs, false);
    this.playing = true;
    this.lastReal = Date.now();
    this.timer ??= setInterval(() => this.tick(), 100);
    this.broadcast({ type: 'state', replay: this.state() });
  }

  private pause() {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.tl) this.broadcast({ type: 'state', replay: this.state() });
  }

  private tick() {
    const tl = this.tl!;
    const now = Date.now();
    this.simTime = Math.min(tl.endMs, this.simTime + (now - this.lastReal) * this.speed);
    this.lastReal = now;
    const bars = new Map<number, Bar>();
    const events: EngineEvent[] = [];
    while (this.idx < tl.frames.length && tl.frames[this.idx]!.t <= this.simTime) {
      const f = tl.frames[this.idx++]!;
      bars.set(f.bar.t, f.bar);
      events.push(...f.events);
    }
    if (bars.size || events.length) {
      const list = [...bars.values()];
      this.broadcast({ type: 'frame', now: this.simTime, bars: list, events, price: list.at(-1)?.c ?? null });
    }
    if (this.idx >= tl.frames.length || this.simTime >= tl.endMs) {
      this.simTime = tl.endMs;
      this.pause();
    }
  }

  private seek(t: number, announce = true) {
    const tl = this.timeline();
    if (!tl) return;
    this.simTime = Math.max(tl.startMs, Math.min(tl.endMs, t));
    let lo = 0;
    let hi = tl.frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tl.frames[mid]!.t <= this.simTime) lo = mid + 1;
      else hi = mid;
    }
    this.idx = lo;
    this.lastReal = Date.now();
    if (announce) this.broadcast(this.snapshot());
  }

  override control(action: ControlAction, value?: number) {
    const tl = this.timeline();
    if (!tl) return;
    switch (action) {
      case 'play':
        this.play();
        break;
      case 'pause':
        this.pause();
        break;
      case 'speed':
        if (value && (SPEEDS as readonly number[]).includes(value)) {
          this.speed = value;
          this.broadcast({ type: 'state', replay: this.state() });
        }
        break;
      case 'restart':
        this.seek(tl.startMs);
        this.play();
        break;
      case 'seek':
        if (value) this.seek(value);
        break;
      case 'next': {
        const next = this.highlights().find((h) => h.t > this.simTime + 1000);
        if (next) {
          this.seek(next.t - 20_000);
          this.play();
        }
        break;
      }
    }
  }
}

function replayMeta(sc: Scenario): RoomMeta {
  const ready = !!loadDay(sc.symbol, sc.date);
  return {
    id: sc.id,
    kind: 'replay',
    symbol: sc.symbol,
    name: sc.name,
    title: sc.title,
    subtitle: sc.subtitle,
    note: sc.note,
    date: sc.date,
    assetClass: 'equity',
    ready,
    hint: ready ? undefined : `npm run fetch -- --env-file <path> ${sc.symbol} ${sc.date}`,
    refLabel: "vs yesterday's close",
  };
}

// ── live crypto ────────────────────────────────────────────────────────────

/** A live room on Coinbase's public trade feed. Runs the engine on every trade, around the clock. */
export class LiveRoom extends Room {
  private readonly engine: PlayEngine;
  private feed: CoinbaseFeed | null = null;
  private bars: Bar[] = [];
  private current: Bar | null = null;
  private readonly plays = new Map<string, Play>();
  private status: LiveState['status'] = 'connecting';
  private refPrice: number | null = null;
  private lastEval = 0;
  private readonly pendingBars = new Map<number, Bar>();
  private pendingEvents: EngineEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly product: string,
    name: string,
  ) {
    super({
      id: `live-${product.toLowerCase()}`,
      kind: 'live',
      symbol: product,
      name,
      title: `${name} live`,
      subtitle: 'Coinbase public feed · around the clock',
      assetClass: 'crypto',
      ready: true,
      refLabel: 'vs 24 hours ago',
    });
    this.engine = new PlayEngine({ symbol: product, assetClass: 'crypto' });
  }

  protected override onJoin() {
    if (!this.feed) void this.start();
  }

  private async start() {
    this.feed = new CoinbaseFeed(this.product, {
      trade: (price, size, t) => this.onTrade(price, size, t),
      status: (s) => {
        this.status = s;
        this.broadcast({ type: 'state', live: { status: s } });
      },
    });
    try {
      const [seed, open] = await Promise.all([this.feed.candles(), this.feed.open24h()]);
      this.refPrice = open;
      const minute = Math.floor(Date.now() / MIN) * MIN;
      const last = seed.at(-1);
      if (last && last.t >= minute) this.current = seed.pop()!; // the minute still forming
      this.engine.warmup(seed);
      this.bars = seed;
      this.broadcast(this.snapshot());
    } catch (e) {
      console.error(`[${this.product}] warmup failed:`, e instanceof Error ? e.message : e);
    }
    this.feed.connect();
    this.flushTimer = setInterval(() => this.flush(), 250);
  }

  private onTrade(price: number, size: number, t: number) {
    const minute = Math.floor(t / MIN) * MIN;
    const now = Date.now();
    if (this.current && minute < this.current.t) return; // late print for a closed minute
    if (this.current && minute > this.current.t) {
      const done = this.current;
      this.queue(done, this.engine.update(done, true, now));
      this.bars.push(done);
      if (this.bars.length > 600) this.bars.splice(0, this.bars.length - 600);
      this.current = null;
    }
    if (!this.current) this.current = { t: minute, o: price, h: price, l: price, c: price, v: 0 };
    const b = this.current;
    b.h = Math.max(b.h, price);
    b.l = Math.min(b.l, price);
    b.c = price;
    b.v += size;
    if (now - this.lastEval >= 400) {
      this.lastEval = now;
      this.queue({ ...b }, this.engine.update({ ...b }, false, now));
    } else {
      this.pendingBars.set(b.t, { ...b });
    }
  }

  private queue(bar: Bar, events: EngineEvent[]) {
    this.pendingBars.set(bar.t, bar);
    for (const e of events) {
      this.pendingEvents.push(e);
      this.plays.set(e.play.id, e.play);
    }
    if (this.plays.size > 300) {
      const oldest = [...this.plays.values()].sort((a, b) => a.t - b.t).slice(0, this.plays.size - 300);
      for (const p of oldest) this.plays.delete(p.id);
    }
  }

  private flush() {
    if (!this.pendingBars.size && !this.pendingEvents.length) return;
    const bars = [...this.pendingBars.values()].sort((a, b) => a.t - b.t);
    this.broadcast({ type: 'frame', now: Date.now(), bars, events: this.pendingEvents, price: bars.at(-1)?.c ?? null });
    this.pendingBars.clear();
    this.pendingEvents = [];
  }

  snapshot(): SnapshotMsg {
    const bars = this.current ? [...this.bars, { ...this.current }] : [...this.bars];
    return {
      type: 'snapshot',
      room: this.meta,
      bars,
      plays: [...this.plays.values()].sort((a, b) => a.t - b.t),
      price: bars.at(-1)?.c ?? null,
      refPrice: this.refPrice,
      live: { status: this.status },
      now: Date.now(),
    };
  }
}

// ── the hub ────────────────────────────────────────────────────────────────

const LIVE = [
  { product: 'BTC-USD', name: 'Bitcoin' },
  { product: 'ETH-USD', name: 'Ethereum' },
];

export class RoomHub {
  private readonly rooms = new Map<string, Room>();

  list(): RoomMeta[] {
    const live = LIVE.map((l) => this.liveRoom(l.product, l.name).meta);
    const replays = loadScenarios().map((sc) => replayMeta(sc));
    return [...live, ...replays];
  }

  private liveRoom(product: string, name: string): Room {
    const id = `live-${product.toLowerCase()}`;
    let room = this.rooms.get(id);
    if (!room) {
      room = new LiveRoom(product, name);
      this.rooms.set(id, room);
    }
    return room;
  }

  private room(id: string): Room | null {
    const existing = this.rooms.get(id);
    if (existing) return existing;
    const live = LIVE.find((l) => `live-${l.product.toLowerCase()}` === id);
    if (live) return this.liveRoom(live.product, live.name);
    const sc = loadScenarios().find((s) => s.id === id);
    if (!sc) return null;
    const room = new ReplayRoom(sc);
    this.rooms.set(id, room);
    return room;
  }

  connect(ws: WebSocket) {
    const client: Client = { ws };
    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        return;
      }
      if (msg.type === 'join') {
        client.room?.leave(client);
        const room = this.room(msg.room);
        if (!room) return send(ws, { type: 'error', message: `No room called "${msg.room}".` });
        room.join(client);
      } else if (msg.type === 'control') {
        client.room?.control(msg.action, msg.value);
      }
    });
    ws.on('close', () => client.room?.leave(client));
  }
}
