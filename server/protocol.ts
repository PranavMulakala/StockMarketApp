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

// ── social layer: every play is its own conversation ──────────────────────

/** Where the poster stands. Shown on every comment; it is what calls get scored on later. */
export type Stance = 'long' | 'short' | 'flat' | 'none';

export const REACTIONS = ['🔥', '🚀', '📉', '😱', '🤡', '💀'] as const;
export type Reaction = (typeof REACTIONS)[number];

export interface Comment {
  id: string;
  playId: string;
  userId: string;
  name: string;
  text: string;
  stance: Stance;
  /**
   * Stamped by the server, never the client: the room's clock (replay time in replays) and the
   * room's price at the instant the comment was posted.
   */
  t: number;
  price: number | null;
  /** Wall-clock time it was posted. */
  at: number;
}

export interface PlaySocial {
  /** Reaction → the user ids who gave it. */
  reactions: Partial<Record<Reaction, string[]>>;
  comments: number;
}

export interface SocialMsg {
  type: 'social';
  plays: Record<string, PlaySocial>;
  here: number;
}

export interface ReactedMsg {
  type: 'reacted';
  playId: string;
  social: PlaySocial;
}

export interface CommentMsg {
  type: 'comment';
  comment: Comment;
  social: PlaySocial;
}

export interface ThreadMsg {
  type: 'thread';
  playId: string;
  comments: Comment[];
}

export interface HiddenMsg {
  type: 'hidden';
  playId: string;
  commentId: string;
  social: PlaySocial;
}

export interface PresenceMsg {
  type: 'presence';
  here: number;
}

// ── picks: "next five minutes, higher or lower?" for points (no money, ever) ─

export type Side = 'up' | 'down';

export interface PickMarket {
  /** The candle play the pick hangs on; it resolves against that candle's close. */
  playId: string;
  base: number;
  /** Room clock after which picks are locked. */
  lockAt: number;
  up: string[];
  down: string[];
  outcome?: Side | 'flat';
  /** The close it resolved against. */
  settle?: number;
}

export interface Score {
  userId: string;
  name: string;
  points: number;
  correct: number;
  total: number;
  streak: number;
}

export interface PicksMsg {
  type: 'picks';
  markets: PickMarket[];
  leaderboard: Score[];
}

/** A post the server refused (moderation, rate limit), sent only to the poster. */
export interface RejectedMsg {
  type: 'rejected';
  reason: string;
}

export type ServerMsg =
  | SnapshotMsg
  | FrameMsg
  | StateMsg
  | ErrorMsg
  | SocialMsg
  | ReactedMsg
  | CommentMsg
  | ThreadMsg
  | HiddenMsg
  | PresenceMsg
  | PicksMsg
  | RejectedMsg;

export type ControlAction = 'play' | 'pause' | 'speed' | 'restart' | 'seek' | 'next';

export type ClientMsg =
  | { type: 'hello'; userId: string; name: string | null }
  | { type: 'join'; room: string }
  | { type: 'control'; action: ControlAction; value?: number }
  | { type: 'react'; playId: string; reaction: Reaction }
  | { type: 'comment'; playId: string; text: string; stance: Stance }
  | { type: 'thread'; playId: string }
  | { type: 'report'; commentId: string }
  | { type: 'pick'; playId: string; side: Side };

export const SPEEDS = [1, 10, 30, 60, 120] as const;
