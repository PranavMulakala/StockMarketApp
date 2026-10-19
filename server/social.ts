import { REACTIONS, type Comment, type PlaySocial, type Reaction, type Stance } from './protocol';
import { screenComment } from './moderation';

const STANCES: readonly Stance[] = ['long', 'short', 'flat', 'none'];
/** Reports from this many different people hide a comment. */
const HIDE_AT = 3;

export interface Stamp {
  t: number;
  price: number | null;
}

export type Posted = { ok: true; comment: Comment } | { ok: false; reason: string };

/**
 * Reactions and comment threads for one room, keyed by play. In memory for now, behind this small
 * surface so a database can replace it without touching the rooms.
 *
 * Rate limits: a name gets slow mode (one comment per 10 s) for its first two minutes, then one per
 * 3 s, and never more than 6 a minute.
 */
export class SocialStore {
  private readonly reactions = new Map<string, Map<Reaction, Set<string>>>();
  private readonly threads = new Map<string, Comment[]>();
  private readonly byId = new Map<string, Comment>();
  private readonly reports = new Map<string, Set<string>>();
  private readonly hidden = new Set<string>();
  private readonly posters = new Map<string, { firstSeen: number; recent: number[] }>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  social(playId: string): PlaySocial {
    const reactions: PlaySocial['reactions'] = {};
    for (const [r, users] of this.reactions.get(playId) ?? []) if (users.size) reactions[r] = [...users];
    const comments = (this.threads.get(playId) ?? []).filter((c) => !this.hidden.has(c.id)).length;
    return { reactions, comments };
  }

  all(): Record<string, PlaySocial> {
    const ids = new Set([...this.reactions.keys(), ...this.threads.keys()]);
    return Object.fromEntries([...ids].map((id) => [id, this.social(id)]));
  }

  /** Toggles a reaction. */
  react(playId: string, userId: string, reaction: Reaction): PlaySocial | null {
    if (!REACTIONS.includes(reaction)) return null;
    let byReaction = this.reactions.get(playId);
    if (!byReaction) this.reactions.set(playId, (byReaction = new Map()));
    let users = byReaction.get(reaction);
    if (!users) byReaction.set(reaction, (users = new Set()));
    if (users.has(userId)) users.delete(userId);
    else users.add(userId);
    return this.social(playId);
  }

  comment(
    input: { playId: string; userId: string; name: string; text: string; stance: Stance },
    stamp: Stamp,
  ): Posted {
    const screened = screenComment(input.text);
    if (!screened.ok) return screened;
    if (!STANCES.includes(input.stance)) return { ok: false, reason: 'Pick long, short, flat or no position.' };
    const now = this.now();
    const p = this.posters.get(input.userId) ?? { firstSeen: now, recent: [] };
    this.posters.set(input.userId, p);
    p.recent = p.recent.filter((t) => now - t < 60_000);
    const gap = now - p.firstSeen < 120_000 ? 10_000 : 3_000;
    const last = p.recent.at(-1);
    if (last !== undefined && now - last < gap) {
      const wait = Math.ceil((gap - (now - last)) / 1000);
      return { ok: false, reason: `Slow mode: wait ${wait} s before posting again.` };
    }
    if (p.recent.length >= 6) return { ok: false, reason: 'That is a lot of comments in a minute. Take a breath.' };
    p.recent.push(now);
    const comment: Comment = {
      id: `c${++this.seq}-${now.toString(36)}`,
      playId: input.playId,
      userId: input.userId,
      name: input.name,
      text: screened.text,
      stance: input.stance,
      t: stamp.t,
      price: stamp.price,
      at: now,
    };
    const thread = this.threads.get(input.playId) ?? [];
    thread.push(comment);
    this.threads.set(input.playId, thread);
    this.byId.set(comment.id, comment);
    return { ok: true, comment };
  }

  /** Visible comments, newest first. */
  thread(playId: string): Comment[] {
    return (this.threads.get(playId) ?? []).filter((c) => !this.hidden.has(c.id)).reverse();
  }

  /** Records a report; returns the comment if this report just hid it. */
  report(commentId: string, userId: string): Comment | null {
    const c = this.byId.get(commentId);
    if (!c || this.hidden.has(commentId) || c.userId === userId) return null;
    const by = this.reports.get(commentId) ?? new Set<string>();
    by.add(userId);
    this.reports.set(commentId, by);
    if (by.size < HIDE_AT) return null;
    this.hidden.add(commentId);
    return c;
  }
}
