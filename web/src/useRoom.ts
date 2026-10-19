import { useEffect, useReducer, useRef } from 'react';
import type { Bar, Play } from '../../engine';
import type {
  ClientMsg,
  ControlAction,
  LiveState,
  ReplayState,
  RoomMeta,
  ServerMsg,
} from '../../server/protocol';

export interface RoomState {
  connected: boolean;
  room: RoomMeta | null;
  bars: Bar[];
  plays: Play[];
  price: number | null;
  refPrice: number | null;
  replay?: ReplayState;
  live?: LiveState;
  /** Room clock at `receivedAt`. */
  now: number;
  receivedAt: number;
  /** Bumped on every full snapshot, so the chart knows to redraw from scratch. */
  version: number;
  /** The newest play called (not updates). */
  lastPlayId?: string;
  error?: string;
}

type Action = { type: 'msg'; msg: ServerMsg } | { type: 'connected'; value: boolean };

const initial: RoomState = {
  connected: false,
  room: null,
  bars: [],
  plays: [],
  price: null,
  refPrice: null,
  now: Date.now(),
  receivedAt: Date.now(),
  version: 0,
};

function upsertBars(bars: Bar[], incoming: Bar[]): Bar[] {
  const out = bars.slice();
  for (const b of incoming) {
    const last = out.at(-1);
    if (!last || b.t > last.t) out.push(b);
    else if (b.t === last.t) out[out.length - 1] = b;
    else {
      const i = out.findIndex((x) => x.t === b.t);
      if (i >= 0) out[i] = b;
    }
  }
  return out;
}

function reducer(s: RoomState, a: Action): RoomState {
  if (a.type === 'connected') return { ...s, connected: a.value };
  const m = a.msg;
  const receivedAt = Date.now();
  switch (m.type) {
    case 'snapshot':
      return {
        ...s,
        room: m.room,
        bars: m.bars,
        plays: m.plays,
        price: m.price,
        refPrice: m.refPrice,
        replay: m.replay,
        live: m.live,
        now: m.now,
        receivedAt,
        version: s.version + 1,
        lastPlayId: undefined,
        error: undefined,
      };
    case 'frame': {
      let plays = s.plays;
      let lastPlayId = s.lastPlayId;
      if (m.events.length) {
        const byId = new Map(plays.map((p) => [p.id, p]));
        for (const e of m.events) {
          byId.set(e.play.id, e.play);
          if (e.type === 'play') lastPlayId = e.play.id;
        }
        plays = [...byId.values()].sort((x, y) => x.t - y.t);
      }
      return {
        ...s,
        bars: m.bars.length ? upsertBars(s.bars, m.bars) : s.bars,
        plays,
        price: m.price ?? s.price,
        now: m.now,
        receivedAt,
        lastPlayId,
      };
    }
    case 'state':
      return {
        ...s,
        replay: m.replay ?? s.replay,
        live: m.live ?? s.live,
        now: m.replay?.simTime ?? s.now,
        receivedAt,
      };
    case 'error':
      return { ...s, error: m.message };
  }
}

/** Joins a room over the websocket and keeps its state: bars, plays, clock, replay controls. */
export function useRoom(id: string) {
  const [state, dispatch] = useReducer(reducer, initial);
  const sock = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: number | undefined;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      sock.current = ws;
      ws.onopen = () => {
        retry = 0;
        dispatch({ type: 'connected', value: true });
        ws.send(JSON.stringify({ type: 'join', room: id } satisfies ClientMsg));
      };
      ws.onmessage = (e) => dispatch({ type: 'msg', msg: JSON.parse(e.data as string) as ServerMsg });
      ws.onclose = () => {
        dispatch({ type: 'connected', value: false });
        if (!closed) timer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      sock.current?.close();
    };
  }, [id]);

  const control = (action: ControlAction, value?: number) =>
    sock.current?.send(JSON.stringify({ type: 'control', action, value } satisfies ClientMsg));

  return { state, control };
}
