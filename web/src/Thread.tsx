import { useEffect, useState } from 'react';
import type { Play } from '../../engine';
import type { Comment, PickMarket, PlaySocial, Reaction, Side, Stance } from '../../server/protocol';
import { PlayCard } from './Feed';
import { clockSec, money, signedPct } from './fmt';
import { loadMuted, saveMuted } from './identity';

const STANCES: { value: Stance; label: string }[] = [
  { value: 'long', label: 'Long' },
  { value: 'short', label: 'Short' },
  { value: 'flat', label: 'Flat' },
  { value: 'none', label: 'No position' },
];
const MAX = 300;

/** How a long or short call has done since it was posted, from its server stamp to the price now. */
function sinceCall(c: Comment, price: number | null): number | null {
  if (c.price === null || price === null || (c.stance !== 'long' && c.stance !== 'short')) return null;
  const move = (price / c.price - 1) * 100;
  return c.stance === 'long' ? move : -move;
}

/** One play's conversation: the play itself, the composer, then comments newest first. */
export function Thread({
  play,
  social,
  market,
  clock,
  onPick,
  comments,
  me,
  name,
  price,
  rejected,
  onBack,
  onReact,
  onComment,
  onReport,
  onSetName,
}: {
  play: Play;
  social?: PlaySocial;
  market?: PickMarket;
  clock: number;
  onPick: (playId: string, side: Side) => void;
  comments?: Comment[];
  me: string;
  name: string | null;
  price: number | null;
  rejected?: { reason: string; at: number };
  onBack: () => void;
  onReact: (playId: string, r: Reaction) => void;
  onComment: (text: string, stance: Stance) => void;
  onReport: (commentId: string) => void;
  onSetName: (name: string) => void;
}) {
  const [text, setText] = useState('');
  const [stance, setStance] = useState<Stance>('none');
  const [draftName, setDraftName] = useState('');
  const [muted, setMuted] = useState<string[]>(loadMuted);
  const [reported, setReported] = useState<string[]>([]);
  const [sentAt, setSentAt] = useState(0);

  // Clear the box once our own comment comes back from the server.
  useEffect(() => {
    if (comments?.[0]?.userId === me && sentAt && comments[0].at >= sentAt - 5_000) setText('');
  }, [comments, me, sentAt]);

  const showRejection = rejected && rejected.at >= sentAt && sentAt > 0;
  const visible = (comments ?? []).filter((c) => !muted.includes(c.userId));

  const mute = (userId: string) => {
    const next = [...muted, userId];
    setMuted(next);
    saveMuted(next);
  };

  return (
    <div className="thread">
      <div className="thread-head">
        <button type="button" className="link" onClick={onBack}>
          ← Play-by-play
        </button>
        <span className="count">
          {social?.comments ?? 0} comment{social?.comments === 1 ? '' : 's'}
        </span>
      </div>
      <ol className="feed thread-play">
        <PlayCard play={play} social={social} market={market} me={me} clock={clock} onReact={onReact} onPick={onPick} />
      </ol>

      {!name ? (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (draftName.trim()) onSetName(draftName.trim());
          }}
        >
          <label className="composer-label" htmlFor="name">
            Pick a display name to join the conversation
          </label>
          <div className="row">
            <input
              id="name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              maxLength={20}
              placeholder="e.g. options_kid"
              autoComplete="off"
            />
            <button type="submit" className="primary">
              Join
            </button>
          </div>
          {rejected && <div className="reject">{rejected.reason}</div>}
        </form>
      ) : (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            setSentAt(Date.now());
            onComment(text, stance);
          }}
        >
          <div className="stances" role="radiogroup" aria-label="Your position">
            {STANCES.map((s) => (
              <button
                type="button"
                key={s.value}
                role="radio"
                aria-checked={stance === s.value}
                className={`stance ${s.value} ${stance === s.value ? 'on' : ''}`}
                onClick={() => setStance(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX))}
            placeholder={`What do you make of this, ${name}?`}
            rows={2}
            aria-label="Comment"
          />
          <div className="row">
            <span className="hint">
              {MAX - text.length} left · stamped with the price when you post · no links
            </span>
            <button type="submit" className="primary" disabled={!text.trim()}>
              Post
            </button>
          </div>
          {showRejection && <div className="reject">{rejected!.reason}</div>}
        </form>
      )}

      <ol className="comments">
        {comments === undefined && <li className="feed-empty">Loading the thread…</li>}
        {comments !== undefined && visible.length === 0 && (
          <li className="feed-empty">No comments yet. Call it first: your take is stamped with the price right now.</li>
        )}
        {visible.map((c) => {
          const since = sinceCall(c, price);
          return (
            <li key={c.id} className="comment">
              <div className="comment-top">
                <span className="who">{c.name}</span>
                {c.stance !== 'none' && <span className={`stance-tag ${c.stance}`}>{c.stance}</span>}
                <span className="when">{clockSec(c.t)} ET</span>
              </div>
              <div className="text">{c.text}</div>
              <div className="comment-meta">
                <span>Stamped {money(c.price)}</span>
                {since !== null && (
                  <span className={since >= 0 ? 'up' : 'down'}>
                    {c.stance === 'long' ? 'Long' : 'Short'} call {signedPct(since)} since
                  </span>
                )}
                {c.userId !== me && (
                  <>
                    <button
                      type="button"
                      className="link"
                      disabled={reported.includes(c.id)}
                      onClick={() => {
                        setReported([...reported, c.id]);
                        onReport(c.id);
                      }}
                    >
                      {reported.includes(c.id) ? 'Reported' : 'Report'}
                    </button>
                    <button type="button" className="link" onClick={() => mute(c.userId)}>
                      Mute
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
