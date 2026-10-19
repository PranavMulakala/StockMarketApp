/** Messages between the room server and the web app (types only, shared by both sides). */
import type { AssetClass, Bar, EngineEvent, Play } from '../engine';

export type RoomKind = 'replay' | 'live';

export interface RoomMeta {
  id: string;
  kind: RoomKind;
  symbol: string;
  name: string;
  title: string;
  subtitle?: string;
  note?: string;
  date?: string;
  assetClass: AssetClass;
  /** Replay data is cached / the live feed can start. */
  ready: boolean;
  /** What to do when not ready. */
  hint?: string;
  /** What the change in the header is measured against. */
  refLabel: string;
}

export interface ReplayState {
  playing: boolean;
  /** Multiple of real time. */
  speed: number;
  /** Replay clock (epoch ms). */
  simTime: number;
  startMs: number;
  endMs: number;
  ended: boolean;
  /** When the big plays land, for the progress bar. */
  highlights: { t: number; rating: number }[];
}

export interface LiveState {
  status: 'connecting' | 'live' | 'offline';
}

export interface SnapshotMsg {
  type: 'snapshot';
  room: RoomMeta;
  bars: Bar[];
  plays: Play[];
  price: number | null;
  refPrice: number | null;
  replay?: ReplayState;
  live?: LiveState;
  /** Room clock: replay time for replays, wall time for live rooms. */
  now: number;
}

export interface FrameMsg {
  type: 'frame';
  now: number;
  /** Bars that changed (the forming bar, plus any that just closed), oldest first. */
  bars: Bar[];
  events: EngineEvent[];
  price: number | null;
}

export interface StateMsg {
  type: 'state';
  replay?: ReplayState;
  live?: LiveState;
}

export interface ErrorMsg {
  type: 'error';
  message: string;
}

export type ServerMsg = SnapshotMsg | FrameMsg | StateMsg | ErrorMsg;

export type ControlAction = 'play' | 'pause' | 'speed' | 'restart' | 'seek' | 'next';

export type ClientMsg = { type: 'join'; room: string } | { type: 'control'; action: ControlAction; value?: number };

export const SPEEDS = [1, 10, 30, 60, 120] as const;
