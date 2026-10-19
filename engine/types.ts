export type AssetClass = 'equity' | 'crypto';

/** Equity sessions are Eastern time; crypto trades around the clock ('always'). */
export type Session = 'pre' | 'regular' | 'post' | 'closed' | 'always';

/** One price bar. `t` is the bar's start time in epoch ms. */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type PlayKind =
  | 'move' // a sharp move, measured against the stock's own normal
  | 'reaction' // the first big move after a scheduled event (earnings)
  | 'high' // a new high for the session
  | 'low' // a new low for the session
  | 'volume' // trading far heavier than normal without a big price move
  | 'run' // many straight minutes in one direction
  | 'fade' // giving back a big move
  | 'bell' // opening bell, closing bell, after-hours wrap
  | 'event'; // a scheduled event: earnings out, Fed decision, CPI

export interface RatingParts {
  size: number;
  volume: number;
  novelty: number;
  context: number;
}

export interface Play {
  id: string;
  symbol: string;
  kind: PlayKind;
  /** +1 up, -1 down, 0 neither */
  dir: 1 | -1 | 0;
  /** 0–10. Above 10 only for historic moves. */
  rating: number;
  title: string;
  /** Plain-language reasons behind the rating. */
  factors: string[];
  /** When the play was detected (epoch ms) and the price at that instant. Never changes. */
  t: number;
  price: number;
  /** Start of the bar the play was detected in. */
  barT: number;
  session: Session;
  /** Size of the move in percent, when there is one. */
  pct?: number;
  /** Minutes the move took. */
  minutes?: number;
  /** For in-progress plays: the latest price and when the play last grew. */
  endPrice?: number;
  updatedAt?: number;
  parts?: RatingParts;
  /** Bumped each time an in-progress play grows. */
  revision: number;
}

export interface ScheduledEvent {
  t: number;
  title: string;
  kind: 'earnings' | 'macro' | 'other';
  /** Minutes after `t` that count as the event's window. Default 90. */
  windowMin?: number;
}

export type EngineEvent = { type: 'play'; play: Play } | { type: 'update'; play: Play };

export interface EngineOptions {
  symbol: string;
  assetClass: AssetClass;
  /** Previous close for the first day the engine sees. */
  prevClose?: number;
  /** Official previous closes keyed by the day they belong to (YYYY-MM-DD). */
  closes?: Record<string, number>;
  events?: ScheduledEvent[];
  /** Plays rated below this are dropped. Bells and scheduled events always pass. Default 4. */
  minRating?: number;
}
