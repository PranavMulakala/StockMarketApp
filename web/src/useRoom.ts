import { useEffect, useReducer, useRef, useState } from 'react';
import type { Bar, Play } from '../../engine';
import type {
  ClientMsg,
  Comment,
  ControlAction,
  LiveState,
  PlaySocial,
  Reaction,
  ReplayState,
  RoomMeta,
  ServerMsg,
  Stance,
} from '../../server/protocol';
import { loadIdentity, saveIdentity, type Identity } from './identity';

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
  /** Reactions and comment counts per play. */
  social: Record<string, PlaySocial>;
  /** Loaded threads, newest comment first. */
  threads: Record<string, Comment[]>;
  here: number;
  /** The server's latest refusal of something this browser posted. */
  rejected?: { reason: string; at: number };
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
  social: {},
  threads: {},
  here: 0,
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
    case 'social':
      return { ...s, social: m.plays, here: m.here, threads: {} };
    case 'presence':
      return { ...s, here: m.here };
    case 'reacted':
      return { ...s, social: { ...s.social, [m.playId]: m.social } };
    case 'thread':
      return { ...s, threads: { ...s.threads, [m.playId]: m.comments } };
    case 'comment': {
      const id = m.comment.playId;
      const thread = s.threads[id];
      return {
        ...s,
        social: { ...s.social, [id]: m.social },
        threads: thread ? { ...s.threads, [id]: [m.comment, ...thread] } : s.threads,
      };
    }
    case 'hidden': {
      const thread = s.threads[m.playId];
      return {
        ...s,
        social: { ...s.social, [m.playId]: m.social },
        threads: thread ? { ...s.threads, [m.playId]: thread.filter((c) => c.id !== m.commentId) } : s.threads,
      };
    }
    case 'rejected':
      return { ...s, rejected: { reason: m.reason, at: receivedAt } };
  }
}

/**
 * Joins a room over the websocket and keeps its state: bars, plays, clock, replay controls, and
 * the conversation on every play.
 */
export function useRoom(id: string) {
  const [state, dispatch] = useReducer(reducer, initial);
  const [identity, setIdentity] = useState<Identity>(loadIdentity);
  const sock = useRef<WebSocket | null>(null);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const send = (msg: ClientMsg) => {
    if (sock.current?.readyState === WebSocket.OPEN) sock.current.send(JSON.stringify(msg));
  };

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
        const me = identityRef.current;
        ws.send(JSON.stringify({ type: 'hello', userId: me.userId, name: me.name } satisfies ClientMsg));
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

  return {
    state,
    identity,
    control: (action: ControlAction, value?: number) => send({ type: 'control', action, value }),
    react: (playId: string, reaction: Reaction) => send({ type: 'react', playId, reaction }),
    comment: (playId: string, text: string, stance: Stance) => send({ type: 'comment', playId, text, stance }),
    openThread: (playId: string) => send({ type: 'thread', playId }),
    report: (commentId: string) => send({ type: 'report', commentId }),
    setName: (name: string) => {
      const next = { ...identityRef.current, name };
      saveIdentity(next);
      setIdentity(next);
      send({ type: 'hello', userId: next.userId, name });
    },
  };
}

export type RoomApi = ReturnType<typeof useRoom>;
