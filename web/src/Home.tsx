import { useEffect, useState } from 'react';
import type { RoomMeta } from '../../server/protocol';
import { longDate } from './fmt';

export function Home() {
  const [rooms, setRooms] = useState<RoomMeta[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    fetch('/api/rooms')
      .then((r) => r.json() as Promise<RoomMeta[]>)
      .then(setRooms)
      .catch(() => setErr(true));
  }, []);
  const live = rooms?.filter((r) => r.kind === 'live') ?? [];
  const replays = rooms?.filter((r) => r.kind === 'replay') ?? [];
  return (
    <div className="home">
      <header className="hero">
        <div className="brand big">Tape</div>
        <p className="tagline">The market, play by play.</p>
        <p className="lede">
          Every big move becomes a play: called the moment it happens, rated 0–10 against what is normal for that
          stock at that time of day, and stamped with the price.
        </p>
      </header>
      {err && (
        <div className="banner error">
          Can't reach the Tape server. Is <code>npm run dev</code> running?
        </div>
      )}
      <section>
        <h2>Live now</h2>
        <div className="cards">
          {live.map((r) => (
            <RoomCard key={r.id} r={r} />
          ))}
        </div>
      </section>
      <section>
        <h2>Earnings nights · replays</h2>
        <div className="cards">
          {replays.map((r) => (
            <RoomCard key={r.id} r={r} />
          ))}
        </div>
      </section>
      <footer className="fine">Prototype. Information and entertainment only, not investment advice.</footer>
    </div>
  );
}

function RoomCard({ r }: { r: RoomMeta }) {
  const body = (
    <>
      <div className="card-top">
        <span className="sym">{r.symbol}</span>
        <span className={`pill ${r.kind}`}>{r.kind === 'live' ? 'LIVE' : 'REPLAY'}</span>
      </div>
      <div className="card-title">{r.title}</div>
      <div className="card-sub">
        {r.date ? `${longDate(r.date)} · ` : ''}
        {r.subtitle}
      </div>
      {r.note && <div className="card-note">{r.note}</div>}
      {!r.ready && (
        <div className="card-hint">
          Not fetched yet: <code>{r.hint}</code>
        </div>
      )}
    </>
  );
  return r.ready ? (
    <a className="card" href={`#/room/${encodeURIComponent(r.id)}`}>
      {body}
    </a>
  ) : (
    <div className="card disabled">{body}</div>
  );
}
