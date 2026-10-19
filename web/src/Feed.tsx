import { tierOf, type Play, type PlayKind } from '../../engine';
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

/** The play-by-play: newest first, every play rated, explained, timed and price-stamped. */
export function Feed({
  plays,
  lastPlayId,
  onSelect,
}: {
  plays: Play[];
  lastPlayId?: string;
  onSelect: (p: Play) => void;
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
        <PlayCard key={p.id} play={p} fresh={p.id === lastPlayId} onSelect={onSelect} />
      ))}
    </ol>
  );
}

function PlayCard({ play: p, fresh, onSelect }: { play: Play; fresh: boolean; onSelect: (p: Play) => void }) {
  const context = p.kind === 'bell' || p.kind === 'event';
  const dir = p.dir > 0 ? 'up' : p.dir < 0 ? 'down' : 'flat';
  return (
    <li className={`play ${context ? 'context' : ''} ${dir} ${fresh ? 'fresh' : ''}`}>
      <button type="button" onClick={() => onSelect(p)} title="Show on the chart">
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
    </li>
  );
}
