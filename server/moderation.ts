/**
 * Moderation that ships on day one, cheapest checks first (the way Real does it): length, links,
 * scam patterns, abuse. A model-based classifier can sit behind these later for what slips through.
 */

export const MAX_COMMENT = 300;

const LINK =
  /(https?:\/\/|www\.|t\.me\/|discord\.gg|\b[a-z0-9-]+\.(com|net|org|io|gg|xyz|me|co|ly|link|app|to|cc|biz|info)\b)/i;

/** The pump-and-dump and phishing playbook: move people off the platform or promise returns. */
const SCAM =
  /\b(dm me|message me|telegram|whats ?app|signal group|join my (group|discord|channel)|guaranteed|risk[- ]?free|can'?t lose|100x|1000x|send (me )?(btc|eth|sol|crypto|usdt)|seed phrase|airdrop claim)\b/i;

const ABUSE = /\b(kys|kill yourself|retard(ed)?|faggot|nigg(er|a)|tranny)\b/i;

const NAME = /^[\p{L}\p{N} ._-]{2,20}$/u;

export type Screen = { ok: true; text: string } | { ok: false; reason: string };

export function screenComment(raw: string): Screen {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: 'Write something first.' };
  if (text.length > MAX_COMMENT) return { ok: false, reason: `Keep it under ${MAX_COMMENT} characters.` };
  if (LINK.test(text)) return { ok: false, reason: 'Links are off in comments, to keep scams out.' };
  if (SCAM.test(text)) return { ok: false, reason: 'That reads like a promotion or a scam pitch, so it was not posted.' };
  if (ABUSE.test(text)) return { ok: false, reason: 'That comment breaks the room rules.' };
  return { ok: true, text };
}

/** Display names: 2–20 letters, numbers, spaces, dots, dashes, underscores; same checks as comments. */
export function cleanName(raw: string | null | undefined): string | null {
  const name = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!NAME.test(name) || LINK.test(name) || ABUSE.test(name)) return null;
  return name;
}
