import type { Play } from '../engine';
import type { PickMarket, Score, Side } from './protocol';

/** Room-clock time a pick stays open after its candle closes. */
export const PICK_WINDOW = 150_000;
const KEEP = 60;

/**
 * "Next five minutes: higher or lower?" on every candle play, for points only. Free to play,
 * nothing to buy, nothing to win but rank: a game, not a bet. Accuracy is what ranks you.
 *
 * Scoring: a right call is 10 points, +5 for each call in a row after that (capped at 30 per
 * call). A wrong call resets the streak. A flat candle is a push.
 */
export class PickBook {
  private readonly markets = new Map<string, PickMarket>();
  private readonly order: string[] = [];
  private readonly scores = new Map<string, Score>();

  /** A new candle closed: settle the open market(s) against its close, then open one on it. */
  onCandle(play: Play, window = PICK_WINDOW): PickMarket[] {
    const close = play.candle?.c ?? play.price;
    const changed: PickMarket[] = [];
    for (const id of this.order) {
      const m = this.markets.get(id)!;
      if (m.outcome || id === play.id) continue;
      this.settle(m, close);
      changed.push(m);
    }
    if (!this.markets.has(play.id)) {
      const m: PickMarket = { playId: play.id, base: close, lockAt: play.t + window, up: [], down: [] };
      this.markets.set(play.id, m);
      this.order.push(play.id);
      changed.push(m);
      while (this.order.length > KEEP) this.markets.delete(this.order.shift()!);
    }
    return changed;
  }

  pick(playId: string, userId: string, name: string, side: Side, clock: number): PickMarket | string {
    const m = this.markets.get(playId);
    if (!m) return 'Picks are only on five-minute candles.';
    if (m.outcome) return 'That one is already settled.';
    if (clock > m.lockAt) return 'Picks are locked for this candle. Catch the next one.';
    if (side !== 'up' && side !== 'down') return 'Pick higher or lower.';
    m.up = m.up.filter((u) => u !== userId);
    m.down = m.down.filter((u) => u !== userId);
    m[side].push(userId);
    if (!this.scores.has(userId)) this.scores.set(userId, { userId, name, points: 0, correct: 0, total: 0, streak: 0 });
    this.scores.get(userId)!.name = name;
    return m;
  }

  private settle(m: PickMarket, close: number) {
    m.settle = close;
    m.outcome = close > m.base ? 'up' : close < m.base ? 'down' : 'flat';
    if (m.outcome === 'flat') return;
    for (const side of ['up', 'down'] as const) {
      for (const userId of m[side]) {
        const s = this.scores.get(userId);
        if (!s) continue;
        s.total++;
        if (side === m.outcome) {
          s.correct++;
          s.streak++;
          s.points += Math.min(30, 10 + 5 * (s.streak - 1));
        } else {
          s.streak = 0;
        }
      }
    }
  }

  all(): PickMarket[] {
    return this.order.map((id) => this.markets.get(id)!);
  }

  leaderboard(n = 10): Score[] {
    return [...this.scores.values()]
      .filter((s) => s.total > 0)
      .sort((a, b) => b.points - a.points || b.correct / b.total - a.correct / a.total)
      .slice(0, n);
  }
}
