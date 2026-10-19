import WebSocket from 'ws';
import type { Bar } from '../engine';

const REST = 'https://api.exchange.coinbase.com';
const WS = 'wss://ws-feed.exchange.coinbase.com';
const HEADERS = { 'User-Agent': 'tape-dev/0.1', Accept: 'application/json' };

export interface FeedHandlers {
  trade(price: number, size: number, t: number): void;
  status(s: 'connecting' | 'live' | 'offline'): void;
}

/**
 * Coinbase's public market data: no key, no account. Recent one-minute candles to warm up the
 * engine, then every trade over a websocket, which the room turns into bars as they form.
 */
export class CoinbaseFeed {
  private ws: WebSocket | null = null;
  private retry = 0;
  private stopped = false;

  constructor(
    readonly product: string,
    private readonly on: FeedHandlers,
  ) {}

  /** Up to the last 300 one-minute candles, oldest first. */
  async candles(): Promise<Bar[]> {
    const res = await fetch(`${REST}/products/${this.product}/candles?granularity=60`, { headers: HEADERS });
    if (!res.ok) throw new Error(`Coinbase candles ${res.status}`);
    const rows = (await res.json()) as [number, number, number, number, number, number][];
    return rows
      .map(([t, l, h, o, c, v]) => ({ t: t * 1000, o, h, l, c, v }))
      .sort((a, b) => a.t - b.t);
  }

  /** The price 24 hours ago, for the header's change. */
  async open24h(): Promise<number | null> {
    const res = await fetch(`${REST}/products/${this.product}/stats`, { headers: HEADERS });
    if (!res.ok) return null;
    const body = (await res.json()) as { open?: string };
    return body.open ? Number(body.open) : null;
  }

  connect(): void {
    this.on.status('connecting');
    const ws = new WebSocket(WS);
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: [this.product], channels: ['matches'] }));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as { type: string; product_id?: string; price?: string; size?: string; time?: string };
      if (m.type === 'subscriptions') this.on.status('live');
      if (m.type === 'match' && m.product_id === this.product && m.price && m.size && m.time) {
        this.on.trade(Number(m.price), Number(m.size), Date.parse(m.time));
      }
    });
    ws.on('close', () => {
      this.on.status('offline');
      if (!this.stopped) setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** this.retry++));
    });
    ws.on('error', () => ws.close());
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }
}
