import { tierOf, type Play, type PlayKind } from '../../engine';
import { REACTIONS, type PlaySocial, type Reaction } from '../../server/protocol';
import { clockSec, money } from './fmt';

const KIND: Record<PlayKind, string> = {
  move: 'Move',
  reaction: 'Reaction',
  high: 'New high',
  low: 'New low',
  volume: 'Heavy volume',
  run: 'Run',
  fade: 'Fade',
  bell: 'Bell',
  event: 'Event',
};

/** The play-by-play: newest first, every play rated, explained, timed, price-stamped, and open for comment. */
export function Feed({
  plays,
  lastPlayId,
  social,
  me,
  onSelect,
  onReact,
  onOpen,
}: {
  plays: Play[];
  lastPlayId?: string;
  social: Record<string, PlaySocial>;
  me: string;
  onSelect: (p: Play) => void;
  onReact: (playId: string, r: Reaction) => void;
  onOpen: (playId: string) => void;
}) {
  const list = [...plays].sort((a, b) => b.t - a.t);
  if (!list.length) {
    return (
      <div className="feed-empty">
        Waiting for the first play. A play is called the moment a move is unusual for this ticker at this time of
        day. Quiet stretches are normal.
      </div>
    );
  }
  return (
    <ol className="feed">
      {list.map((p) => (
        <PlayCard
          key={p.id}
          play={p}
          fresh={p.id === lastPlayId}
          social={social[p.id]}
          me={me}
          onSelect={onSelect}
          onReact={onReact}
          onOpen={onOpen}
        />
      ))}
    </ol>
  );
}

export function PlayCard({
  play: p,
  fresh = false,
  social,
  me,
  onSelect,
  onReact,
  onOpen,
}: {
  play: Play;
  fresh?: boolean;
  social?: PlaySocial;
  me: string;
  onSelect?: (p: Play) => void;
  onReact: (playId: string, r: Reaction) => void;
  onOpen?: (playId: string) => void;
}) {
  const context = p.kind === 'bell' || p.kind === 'event';
  const dir = p.dir > 0 ? 'up' : p.dir < 0 ? 'down' : 'flat';
  return (
    <li className={`play ${context ? 'context' : ''} ${dir} ${fresh ? 'fresh' : ''}`}>
      <button type="button" className="play-main" onClick={() => onSelect?.(p)} title="Show on the chart">
        <span key={p.revision} className="flash" aria-hidden />
        <span className={`badge ${tierOf(p.rating)}`}>{p.rating.toFixed(1)}</span>
        <span className="body">
          <span className="kind">
            {KIND[p.kind]}
            {p.revision > 0 && <span className="grew"> · grew {p.revision}×</span>}
          </span>
          <span className="title">{p.title}</span>
          {!context && p.factors.length > 0 && (
            <span className="chips">
              {p.factors.map((f) => (
                <span className="chip" key={f}>
                  {f}
                </span>
              ))}
            </span>
          )}
          <span className="meta">
            {clockSec(p.t)} ET · stamped {money(p.price)}
          </span>
        </span>
      </button>
      <div className="social-bar">
        {REACTIONS.map((r) => {
          const users = social?.reactions[r] ?? [];
          const mine = users.includes(me);
          return (
            <button
              type="button"
              key={r}
              className={`react ${mine ? 'mine' : ''} ${users.length ? 'has' : ''}`}
              onClick={() => onReact(p.id, r)}
              aria-pressed={mine}
              aria-label={`React ${r}`}
            >
              <span>{r}</span>
              {users.length > 0 && <span className="n">{users.length}</span>}
            </button>
          );
        })}
        {onOpen && (
          <button type="button" className="thread-btn" onClick={() => onOpen(p.id)}>
            {social?.comments ? `${social.comments} comment${social.comments === 1 ? '' : 's'}` : 'Comment'}
          </button>
        )}
      </div>
    </li>
  );
}
