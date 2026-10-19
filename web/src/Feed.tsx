import { useEffect, useRef, useState } from 'react';
import { tierOf, type Play, type PlayKind } from '../../engine';
import { REACTIONS, type PickMarket, type PlaySocial, type Reaction, type Score, type Side } from '../../server/protocol';
import { clockMin, clockSec, money } from './fmt';

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
  candle: '5-min candle',
};

export type FeedTab = 'live' | 'top' | 'picks';

interface Handlers {
  onSelect?: (p: Play) => void;
  onReact: (playId: string, r: Reaction) => void;
  onOpen?: (playId: string) => void;
  onPick: (playId: string, side: Side) => void;
}

/**
 * The game feed, Real-style. Live: every play newest first, big plays and five-minute candles.
 * Top: the biggest plays, ranked by rating. Picks: the candles you can call, plus the leaderboard.
 */
export function Feed({
  plays,
  social,
  markets,
  leaderboard,
  me,
  clock,
  lastPlayId,
  tab,
  onTab,
  ...h
}: Handlers & {
  plays: Play[];
  social: Record<string, PlaySocial>;
  markets: Record<string, PickMarket>;
  leaderboard: Score[];
  me: string;
  clock: number;
  lastPlayId?: string;
  tab: FeedTab;
  onTab: (t: FeedTab) => void;
}) {
  const big = plays.filter((p) => p.kind !== 'candle');
  const candles = plays.filter((p) => p.kind === 'candle');
  const openPicks = candles.filter((p) => markets[p.id] && !markets[p.id]!.outcome && clock <= markets[p.id]!.lockAt);
  const list =
    tab === 'top'
      ? big.filter((p) => p.kind !== 'bell' && p.kind !== 'event').sort((a, b) => b.rating - a.rating)
      : tab === 'picks'
        ? [...candles].sort((a, b) => b.t - a.t)
        : [...plays].sort((a, b) => b.t - a.t);

  return (
    <div className="feed-wrap">
      <div className="tabs" role="tablist">
        {(
          [
            ['live', 'Live', plays.length],
            ['top', 'Top', big.length],
            ['picks', 'Picks', openPicks.length],
          ] as const
        ).map(([id, label, n]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`tab ${tab === id ? 'on' : ''} ${id === 'picks' && n > 0 ? 'hot' : ''}`}
            onClick={() => onTab(id)}
          >
            {label}
            {n > 0 && <span className="n">{n}</span>}
          </button>
        ))}
      </div>
      {tab === 'picks' && <Leaderboard rows={leaderboard} me={me} />}
      {list.length === 0 ? (
        <div className="feed-empty">
          {tab === 'picks'
            ? 'Every five minutes a candle closes and you can call the next one: higher or lower. Points only.'
            : 'Waiting for the first play. The tape never stops, so it will not be long.'}
        </div>
      ) : (
        <ol className="feed">
          {list.map((p) => (
            <PlayCard
              key={p.id}
              play={p}
              fresh={p.id === lastPlayId}
              social={social[p.id]}
              market={markets[p.id]}
              me={me}
              clock={clock}
              {...h}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

export function PlayCard({
  play: p,
  fresh = false,
  social,
  market,
  me,
  clock,
  onSelect,
  onReact,
  onOpen,
  onPick,
}: Handlers & {
  play: Play;
  fresh?: boolean;
  social?: PlaySocial;
  market?: PickMarket;
  me: string;
  clock: number;
}) {
  const context = p.kind === 'bell' || p.kind === 'event';
  const candle = p.kind === 'candle';
  const dir = p.dir > 0 ? 'up' : p.dir < 0 ? 'down' : 'flat';
  return (
    <li className={`play ${candle ? 'candle' : ''} ${context ? 'context' : ''} ${dir} ${fresh ? 'fresh' : ''}`}>
      <button type="button" className="play-main" onClick={() => onSelect?.(p)} title="Show on the chart">
        <span key={p.revision} className="flash" aria-hidden />
        {candle && p.candle ? (
          <CandleGlyph k={p.candle} />
        ) : (
          <span className={`badge ${tierOf(p.rating)}`}>{p.rating.toFixed(1)}</span>
        )}
        <span className="body">
          <span className="kind">
            {KIND[p.kind]}
            {candle && p.candle && (
              <>
                {' '}
                · {clockMin(p.candle.start)}–{clockMin(p.candle.start + 5 * 60_000)}
              </>
            )}
            {p.revision > 0 && <span className="grew"> · grew {p.revision}×</span>}
            {candle && <span className={`mini-rating ${tierOf(p.rating)}`}>{p.rating.toFixed(1)}</span>}
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
          {!candle && (
            <span className="meta">
              {clockSec(p.t)} ET · stamped {money(p.price)}
            </span>
          )}
        </span>
      </button>
      {market && <PickBox market={market} me={me} clock={clock} onPick={(s) => onPick(p.id, s)} />}
      <ReactionBar play={p} social={social} me={me} onReact={onReact} onOpen={onOpen} />
    </li>
  );
}

/** Reactions under every play. Other people's reactions float up as they land, like Real. */
function ReactionBar({
  play,
  social,
  me,
  onReact,
  onOpen,
}: {
  play: Play;
  social?: PlaySocial;
  me: string;
  onReact: (playId: string, r: Reaction) => void;
  onOpen?: (playId: string) => void;
}) {
  const [floaters, setFloaters] = useState<{ id: number; r: Reaction; x: number }[]>([]);
  const prev = useRef<Partial<Record<Reaction, number>> | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const now: Partial<Record<Reaction, number>> = {};
    for (const r of REACTIONS) now[r] = social?.reactions[r]?.length ?? 0;
    if (prev.current) {
      const born = REACTIONS.filter((r) => (now[r] ?? 0) > (prev.current![r] ?? 0)).map((r) => ({
        id: ++seq.current,
        r,
        x: 10 + Math.random() * 70,
      }));
      if (born.length) {
        setFloaters((f) => [...f, ...born]);
        setTimeout(() => setFloaters((f) => f.filter((x) => !born.includes(x))), 1400);
      }
    }
    prev.current = now;
  }, [social]);

  return (
    <div className="social-bar">
      {floaters.map((f) => (
        <span key={f.id} className="floater" style={{ left: `${f.x}%` }} aria-hidden>
          {f.r}
        </span>
      ))}
      {REACTIONS.map((r) => {
        const users = social?.reactions[r] ?? [];
        const mine = users.includes(me);
        return (
          <button
            type="button"
            key={r}
            className={`react ${mine ? 'mine' : ''} ${users.length ? 'has' : ''}`}
            onClick={() => onReact(play.id, r)}
            aria-pressed={mine}
            aria-label={`React ${r}`}
          >
            <span>{r}</span>
            {users.length > 0 && <span className="n">{users.length}</span>}
          </button>
        );
      })}
      {onOpen && (
        <button type="button" className="thread-btn" onClick={() => onOpen(play.id)}>
          {social?.comments ? `${social.comments} comment${social.comments === 1 ? '' : 's'}` : 'Comment'}
        </button>
      )}
    </div>
  );
}

/** "Next 5 min: higher or lower than $X?" Points only. */
function PickBox({
  market: m,
  me,
  clock,
  onPick,
}: {
  market: PickMarket;
  me: string;
  clock: number;
  onPick: (s: Side) => void;
}) {
  const mine: Side | null = m.up.includes(me) ? 'up' : m.down.includes(me) ? 'down' : null;
  const total = m.up.length + m.down.length;
  if (m.outcome) {
    const won = m.outcome;
    const result =
      won === 'flat'
        ? 'Closed flat: a push, no points'
        : `${won === 'up' ? 'Higher' : 'Lower'} won · closed ${money(m.settle)} vs ${money(m.base)}`;
    return (
      <div className={`pick settled ${won}`}>
        <span>{result}</span>
        {mine && won !== 'flat' && (
          <span className={`you ${mine === won ? 'hit' : 'miss'}`}>{mine === won ? 'You called it' : 'You missed'}</span>
        )}
        {!mine && total > 0 && <span className="muted">{total} picked</span>}
      </div>
    );
  }
  const left = m.lockAt - clock;
  const locked = left <= 0;
  const secs = Math.max(0, Math.ceil(left / 1000));
  const pct = (side: Side) => (total ? Math.round((m[side].length / total) * 100) : 0);
  return (
    <div className={`pick ${locked ? 'locked' : 'open'}`}>
      <div className="pick-q">
        <span>
          Next 5 min vs <b>{money(m.base)}</b>
        </span>
        <span className="muted">
          {locked ? 'Locked, waiting for the close' : `Locks in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}
        </span>
      </div>
      <div className="pick-btns">
        {(['up', 'down'] as const).map((side) => (
          <button
            key={side}
            type="button"
            className={`pick-btn ${side} ${mine === side ? 'mine' : ''}`}
            disabled={locked}
            onClick={() => onPick(side)}
            aria-pressed={mine === side}
          >
            <span>{side === 'up' ? '▲ Higher' : '▼ Lower'}</span>
            <span className="share">{total ? `${pct(side)}%` : ''}</span>
            <span className="bar" style={{ width: `${pct(side)}%` }} />
          </button>
        ))}
      </div>
    </div>
  );
}

function CandleGlyph({ k }: { k: { o: number; h: number; l: number; c: number } }) {
  const span = k.h - k.l || 1;
  const y = (v: number) => 4 + ((k.h - v) / span) * 36;
  const up = k.c >= k.o;
  const top = y(Math.max(k.o, k.c));
  const bottom = y(Math.min(k.o, k.c));
  return (
    <svg className={`glyph ${up ? 'up' : 'down'}`} viewBox="0 0 20 44" width="20" height="44" aria-hidden>
      <line x1="10" x2="10" y1={y(k.h)} y2={y(k.l)} />
      <rect x="4" width="12" y={top} height={Math.max(2, bottom - top)} rx="1.5" />
    </svg>
  );
}

export function Leaderboard({ rows, me }: { rows: Score[]; me: string }) {
  if (!rows.length) {
    return (
      <div className="leaders empty">
        <b>Room leaderboard</b>
        <span className="muted">Call the next candle to get on the board. Ranked by points, then accuracy.</span>
      </div>
    );
  }
  return (
    <div className="leaders">
      <b>Room leaderboard</b>
      <ol>
        {rows.map((s, i) => (
          <li key={s.userId} className={s.userId === me ? 'me' : ''}>
            <span className="rank">{i + 1}</span>
            <span className="who">{s.name}</span>
            <span className="acc">
              {s.correct}/{s.total}
            </span>
            {s.streak >= 2 && <span className="streak">{s.streak} in a row</span>}
            <span className="pts">{s.points}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
