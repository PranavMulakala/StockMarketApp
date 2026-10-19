import { useEffect, useRef, useState } from 'react';
import { etMinuteOfDay, sessionOf, tierOf, type Play } from '../../engine';
import type { RoomMeta } from '../../server/protocol';
import { Chart } from './Chart';
import { ReplayControls } from './Controls';
import { Feed, Leaderboard, type FeedTab } from './Feed';
import { clockSec, longDate, money, signedPct } from './fmt';
import { Thread } from './Thread';
import { useRoom, type RoomState } from './useRoom';

const SESSION = { pre: 'Pre-market', regular: 'Market open', post: 'After hours', closed: 'Closed', always: '24/7' };

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** The game screen: scoreboard, momentum chart, and the play-by-play. */
export function Room({ id }: { id: string }) {
  const api = useRoom(id);
  const { state, control, identity } = api;
  const [focus, setFocus] = useState<Play | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [tab, setTab] = useState<FeedTab>('live');
  const [momentId, setMomentId] = useState<string | null>(null);
  useTick(250);

  // A big play (rated 8+) gets the banner, like Real's moments, and it grows with the play.
  useEffect(() => {
    const p = state.plays.find((x) => x.id === state.lastPlayId);
    if (!p || p.rating < 8 || p.kind === 'candle') return;
    setMomentId(p.id);
    const t = setTimeout(() => setMomentId(null), 6000);
    return () => clearTimeout(t);
  }, [state.lastPlayId]); // eslint-disable-line react-hooks/exhaustive-deps
  const moment = momentId ? state.plays.find((p) => p.id === momentId) : undefined;

  const r = state.room;
  const replay = state.replay;
  const clock =
    r?.kind === 'replay' && replay
      ? replay.playing
        ? Math.min(replay.endMs, state.now + (Date.now() - state.receivedAt) * replay.speed)
        : state.now
      : Date.now();
  const threadPlay = threadId ? state.plays.find((p) => p.id === threadId) : undefined;
  const openThread = (playId: string) => {
    setThreadId(playId);
    api.openThread(playId);
  };

  return (
    <div className="room">
      <nav className="topbar">
        <a href="#/" className="back" aria-label="All games">
          ‹ Games
        </a>
        <a href="#/" className="brand">
          Tape
        </a>
        <span className="here">{state.here > 0 ? `${state.here} watching` : ''}</span>
      </nav>
      {state.error && <div className="banner error">{state.error}</div>}
      {!r ? (
        <div className="loading">{state.connected ? 'Joining the room…' : 'Connecting…'}</div>
      ) : !r.ready ? (
        <div className="loading">
          <p>No data cached for {r.title} yet.</p>
          <p>
            Fetch it with <code>{r.hint}</code>
          </p>
        </div>
      ) : (
        <>
          <Scoreboard room={r} clock={clock} state={state} />
          <main className="stage">
            <section className="left">
              <div className="chart-card">
                {moment && (
                  <div className={`moment ${tierOf(moment.rating)}`} role="status">
                    <span className={`badge ${tierOf(moment.rating)}`}>{moment.rating.toFixed(1)}</span>
                    <span>{moment.title}</span>
                  </div>
                )}
                <Chart bars={state.bars} plays={state.plays} version={state.version} focus={focus} />
              </div>
              {r.kind === 'replay' && replay ? (
                <ReplayControls replay={replay} clock={clock} onControl={control} />
              ) : (
                <div className="live-note">
                  <span className={`dot ${state.live?.status ?? 'connecting'}`} /> Coinbase public feed ·{' '}
                  {state.live?.status ?? 'connecting'}. Every trade is checked; a candle closes every five minutes.
                </div>
              )}
              <div className="desk-only">
                <Leaderboard rows={state.leaderboard} me={identity.userId} />
              </div>
            </section>
            <aside className="right">
              {threadPlay ? (
                <Thread
                  play={threadPlay}
                  social={state.social[threadPlay.id]}
                  market={state.markets[threadPlay.id]}
                  clock={clock}
                  onPick={api.pick}
                  comments={state.threads[threadPlay.id]}
                  me={identity.userId}
                  name={identity.name}
                  price={state.price}
                  rejected={state.rejected}
                  onBack={() => setThreadId(null)}
                  onReact={api.react}
                  onComment={(text, stance) => api.comment(threadPlay.id, text, stance)}
                  onReport={api.report}
                  onSetName={api.setName}
                />
              ) : (
                <Feed
                  plays={state.plays}
                  social={state.social}
                  markets={state.markets}
                  leaderboard={state.leaderboard}
                  me={identity.userId}
                  clock={clock}
                  lastPlayId={state.lastPlayId}
                  tab={tab}
                  onTab={setTab}
                  onSelect={setFocus}
                  onReact={api.react}
                  onOpen={openThread}
                  onPick={api.pick}
                />
              )}
              {state.rejected && Date.now() - state.rejected.at < 4000 && !threadPlay && (
                <div className="toast">{state.rejected.reason}</div>
              )}
            </aside>
          </main>
          <footer className="fine">
            Information and entertainment only, not investment advice. Ratings come from price and volume alone, never
            from chatter. Picks are for points only.{' '}
            {r.kind === 'replay'
              ? 'Replay of recorded market data, for personal use on this machine.'
              : 'Live data from Coinbase’s public feed.'}
          </footer>
        </>
      )}
    </div>
  );
}

/** The game header: the ticker is the team, the price is the score, the session is the clock. */
function Scoreboard({ room: r, clock, state }: { room: RoomMeta; clock: number; state: RoomState }) {
  const { price, refPrice } = state;
  const prev = useRef<number | null>(null);
  const dir = price !== null && prev.current !== null && price !== prev.current ? (price > prev.current ? 'up' : 'down') : '';
  useEffect(() => {
    prev.current = price;
  }, [price]);
  const change = price !== null && refPrice ? (price / refPrice - 1) * 100 : null;
  const s = sessionOf(clock, r.assetClass);
  const close = s === 'post' ? [...state.bars].reverse().find((b) => etMinuteOfDay(b.t) === 15 * 60 + 59)?.c : undefined;
  const afterHours = close && price !== null ? (price / close - 1) * 100 : null;
  const lead = afterHours ?? change;
  return (
    <header className="scoreboard">
      <div className="team">
        <span className="logo" aria-hidden>
          {r.symbol.slice(0, 1)}
        </span>
        <span>
          <span className="sym">{r.symbol}</span>
          <span className="name">
            {r.title}
            {r.date ? ` · ${longDate(r.date)}` : ''}
          </span>
        </span>
      </div>
      <div className="score">
        <span key={price ?? 0} className={`price ${dir}`}>
          {money(price)}
        </span>
        <span className={`chg ${lead === null ? '' : lead >= 0 ? 'up' : 'down'}`}>
          {afterHours !== null ? (
            <>
              {signedPct(afterHours)} <span className="muted">after hours</span> · {signedPct(change)}{' '}
              <span className="muted">day</span>
            </>
          ) : (
            <>
              {signedPct(change)} <span className="muted">{r.refLabel}</span>
            </>
          )}
        </span>
      </div>
      <div className="clock">
        <span className="time">{clockSec(clock)}</span>
        <span className={`session ${s}`}>{SESSION[s]}</span>
        {r.kind === 'replay' ? (
          <span className="pill replay">REPLAY {state.replay?.speed ?? 10}×</span>
        ) : (
          <span className={`pill live ${state.live?.status ?? ''}`}>
            {state.live?.status === 'live' ? 'LIVE' : (state.live?.status ?? 'connecting').toUpperCase()}
          </span>
        )}
      </div>
    </header>
  );
}
