import { useEffect, useRef, useState } from 'react';
import { etMinuteOfDay, sessionOf, tierOf, type Play } from '../../engine';
import type { RoomMeta } from '../../server/protocol';
import { Chart } from './Chart';
import { ReplayControls } from './Controls';
import { Feed } from './Feed';
import { clockSec, longDate, money, signedPct } from './fmt';
import { Thread } from './Thread';
import { useRoom } from './useRoom';

const SESSION = { pre: 'Pre-market', regular: 'Market open', post: 'After hours', closed: 'Market closed', always: '24/7' };

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function Room({ id }: { id: string }) {
  const api = useRoom(id);
  const { state, control, identity } = api;
  const [focus, setFocus] = useState<Play | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const threadPlay = threadId ? state.plays.find((p) => p.id === threadId) : undefined;
  const openThread = (playId: string) => {
    setThreadId(playId);
    api.openThread(playId);
  };
  const [momentId, setMomentId] = useState<string | null>(null);
  useTick(250);

  // A big play (rated 8+) gets the banner, like Real's moments. It shows the play as it grows.
  useEffect(() => {
    const p = state.plays.find((x) => x.id === state.lastPlayId);
    if (!p || p.rating < 8) return;
    setMomentId(p.id);
    const t = setTimeout(() => setMomentId(null), 6000);
    return () => clearTimeout(t);
  }, [state.lastPlayId]); // eslint-disable-line react-hooks/exhaustive-deps
  const moment = momentId ? (state.plays.find((p) => p.id === momentId) ?? null) : null;

  const r = state.room;
  const replay = state.replay;
  const clock =
    r?.kind === 'replay' && replay
      ? replay.playing
        ? Math.min(replay.endMs, state.now + (Date.now() - state.receivedAt) * replay.speed)
        : state.now
      : Date.now();

  return (
    <div className="room">
      <nav className="topbar">
        <a href="#/" className="back">
          ← All games
        </a>
        <a href="#/" className="brand">
          Tape
        </a>
      </nav>
      {state.error && <div className="banner error">{state.error}</div>}
      {!r ? (
        <div className="loading">{state.connected ? 'Joining the room…' : 'Connecting to the Tape server…'}</div>
      ) : !r.ready ? (
        <NotReady room={r} />
      ) : (
        <>
          <Scoreboard room={r} price={state.price} refPrice={state.refPrice} clock={clock} state={state} />
          <main className="stage">
            <section className="left">
              {moment && (
                <div className={`moment ${tierOf(moment.rating)}`} role="status">
                  <span className={`badge ${tierOf(moment.rating)}`}>{moment.rating.toFixed(1)}</span>
                  <span>{moment.title}</span>
                </div>
              )}
              <Chart bars={state.bars} plays={state.plays} version={state.version} focus={focus} />
              {r.kind === 'replay' && replay ? (
                <ReplayControls replay={replay} clock={clock} onControl={control} />
              ) : (
                <div className="live-note">
                  <span className={`dot ${state.live?.status ?? 'connecting'}`} /> Coinbase public feed ·{' '}
                  {state.live?.status ?? 'connecting'} · the engine checks every trade and calls a play the moment
                  a move is unusual.
                </div>
              )}
            </section>
            <aside className="right">
              {threadPlay ? (
                <Thread
                  play={threadPlay}
                  social={state.social[threadPlay.id]}
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
                <>
                  <div className="feed-head">
                    <span>Play-by-play</span>
                    <span className="count">{state.plays.length} plays</span>
                  </div>
                  <Feed
                    plays={state.plays}
                    lastPlayId={state.lastPlayId}
                    social={state.social}
                    me={identity.userId}
                    onSelect={setFocus}
                    onReact={api.react}
                    onOpen={openThread}
                  />
                </>
              )}
            </aside>
          </main>
          <footer className="fine">
            Information and entertainment only, not investment advice. Ratings come from price and volume alone, never
            from chatter.{' '}
            {r.kind === 'replay'
              ? 'Replay of recorded market data, for personal use on this machine.'
              : 'Live data from Coinbase’s public feed.'}
          </footer>
        </>
      )}
    </div>
  );
}

function Scoreboard({
  room: r,
  price,
  refPrice,
  clock,
  state,
}: {
  room: RoomMeta;
  price: number | null;
  refPrice: number | null;
  clock: number;
  state: ReturnType<typeof useRoom>['state'];
}) {
  const prev = useRef<number | null>(null);
  const dir = price !== null && prev.current !== null && price !== prev.current ? (price > prev.current ? 'up' : 'down') : '';
  useEffect(() => {
    prev.current = price;
  }, [price]);
  const change = price !== null && refPrice ? (price / refPrice - 1) * 100 : null;
  const s = sessionOf(clock, r.assetClass);
  const session = SESSION[s];
  const replay = state.replay;
  // After hours, the number people watch is the move since the 4:00 PM close.
  const close = s === 'post' ? [...state.bars].reverse().find((b) => etMinuteOfDay(b.t) === 15 * 60 + 59)?.c : undefined;
  const afterHours = close && price !== null ? (price / close - 1) * 100 : null;
  return (
    <section className="scoreboard">
      <div className="who">
        <div className="sym">{r.symbol}</div>
        <div className="name">
          {r.title}
          {r.date ? ` · ${longDate(r.date)}` : ''}
        </div>
      </div>
      <div className="px">
        <div key={price ?? 0} className={`price ${dir}`}>
          {money(price)}
        </div>
        <div className={`chg ${change === null ? '' : change >= 0 ? 'up' : 'down'}`}>
          {signedPct(change)} <span className="muted">{r.refLabel}</span>
        </div>
        {afterHours !== null && (
          <div className={`chg ${afterHours >= 0 ? 'up' : 'down'}`}>
            {signedPct(afterHours)} <span className="muted">after hours</span>
          </div>
        )}
      </div>
      <div className="clock">
        {r.kind === 'replay' ? (
          <span className="pill replay">REPLAY · {replay?.speed ?? 30}×</span>
        ) : (
          <span className={`pill live ${state.live?.status ?? ''}`}>
            {state.live?.status === 'live' ? 'LIVE' : (state.live?.status ?? 'connecting').toUpperCase()}
          </span>
        )}
        <div className="time">{clockSec(clock)} ET</div>
        <div className="session">
          {session} · {state.here} here
        </div>
      </div>
    </section>
  );
}

function NotReady({ room }: { room: RoomMeta }) {
  return (
    <div className="loading">
      <p>No data cached for {room.title} yet.</p>
      <p>
        Fetch it with <code>{room.hint}</code>
      </p>
    </div>
  );
}
