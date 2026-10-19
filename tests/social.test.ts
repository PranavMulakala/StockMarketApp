import { describe, expect, it } from 'vitest';
import { cleanName, screenComment } from '../server/moderation';
import { SocialStore } from '../server/social';

const post = (s: SocialStore, userId: string, text: string, stamp = { t: 1_000, price: 210.5 }) =>
  s.comment({ playId: 'p1', userId, name: userId, text, stance: 'long' }, stamp);

describe('moderation', () => {
  it('blocks links, scam pitches and abuse, and keeps comments short', () => {
    expect(screenComment('NVDA ripping, called it').ok).toBe(true);
    expect(screenComment('check https://pump.example').ok).toBe(false);
    expect(screenComment('join my discord at discord.gg/abc').ok).toBe(false);
    expect(screenComment('guaranteed 100x, dm me').ok).toBe(false);
    expect(screenComment('kys').ok).toBe(false);
    expect(screenComment('x'.repeat(301)).ok).toBe(false);
    expect(screenComment('   ').ok).toBe(false);
  });

  it('accepts reasonable display names only', () => {
    expect(cleanName('Pranav')).toBe('Pranav');
    expect(cleanName('  options_kid  ')).toBe('options_kid');
    expect(cleanName('a')).toBeNull();
    expect(cleanName('www.scam.com')).toBeNull();
  });
});

describe('SocialStore', () => {
  it('toggles reactions per user', () => {
    const s = new SocialStore();
    s.react('p1', 'u1', '🔥');
    s.react('p1', 'u2', '🔥');
    expect(s.social('p1').reactions['🔥']).toEqual(['u1', 'u2']);
    s.react('p1', 'u1', '🔥');
    expect(s.social('p1').reactions['🔥']).toEqual(['u2']);
  });

  it('stamps comments with the room clock and price it is given, never anything else', () => {
    let now = 5_000_000;
    const s = new SocialStore(() => now);
    const r = post(s, 'u1', 'long here', { t: 42, price: 203.58 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.comment.t).toBe(42);
    expect(r.comment.price).toBe(203.58);
    expect(r.comment.at).toBe(now);
    expect(s.social('p1').comments).toBe(1);
    now += 60_000;
    post(s, 'u1', 'adding');
    expect(s.thread('p1').map((c) => c.text)).toEqual(['adding', 'long here']);
  });

  it('puts new names in slow mode and caps comments per minute', () => {
    let now = 0;
    const s = new SocialStore(() => now);
    expect(post(s, 'u1', 'one').ok).toBe(true);
    now += 5_000;
    const slow = post(s, 'u1', 'two');
    expect(slow.ok).toBe(false);
    if (!slow.ok) expect(slow.reason).toMatch(/Slow mode/);
    now = 200_000; // past the first two minutes: 3 s gaps
    for (let i = 0; i < 6; i++) {
      expect(post(s, 'u1', `msg ${i}`).ok).toBe(true);
      now += 3_100;
    }
    expect(post(s, 'u1', 'one too many').ok).toBe(false);
  });

  it('hides a comment after three different people report it, and not on self-reports', () => {
    const s = new SocialStore();
    const r = post(s, 'u1', 'bad take');
    if (!r.ok) throw new Error('not posted');
    expect(s.report(r.comment.id, 'u1')).toBeNull();
    expect(s.report(r.comment.id, 'u2')).toBeNull();
    expect(s.report(r.comment.id, 'u2')).toBeNull();
    expect(s.report(r.comment.id, 'u3')).toBeNull();
    expect(s.report(r.comment.id, 'u4')?.id).toBe(r.comment.id);
    expect(s.thread('p1')).toHaveLength(0);
    expect(s.social('p1').comments).toBe(0);
  });
});
