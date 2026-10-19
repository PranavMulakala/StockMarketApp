# Tape

**The market, play by play.** A prototype of "Real for markets": a live room for a stock's big
moments (earnings nights first). An engine turns the continuous price tape into discrete, rated
plays, the way a sports app turns a game into plays, and everyone in a room sees the same play at
the same moment.

> NVDA, Aug 26 2026, 4:20 PM ET: **10.0 · Earnings reaction: NVDA −3.0% from the close, now $203.58**
> · 49× a normal 2-min move · 65× normal volume · Earnings window · stamped $206.25

## What's here (slice 1: play engine + replay)

- **Play engine** (`engine/`). Turns one-minute bars into plays: moves, earnings reactions, new
  highs and lows, runs, fades, heavy volume, opening and closing bells. Each play gets:
  - a 0–10 **move rating**, judged against what is normal for that ticker at that time of day;
  - plain-language reasons for the rating;
  - a time and price stamp that never changes.

  Moves still in progress grow in place instead of repeating. The engine is deterministic and unit-tested.
- **Replays** (`server/replay.ts`, `scenarios/replays.json`). Any recorded session plays back
  through the same engine, minute by minute as the bars form, at 1×–120×. You can jump to the next
  big play or seek.
- **Live rooms** (`server/coinbase.ts`). BTC-USD and ETH-USD from Coinbase's public feed (no key),
  around the clock, with the engine checking every trade.
- **Web app** (`web/`). A scoreboard, candles and volume (TradingView Lightweight Charts) with a
  marker on every play, the play-by-play feed, replay controls, and a banner for big moments.

## Slice 2: every play is a conversation

- **Reactions:** one tap (🔥 🚀 📉 😱 🤡 💀) on every play, synced live to everyone in the room.
- **Threads:** each play has its own comment thread (300 characters, newest first).
- **Stance and price stamp on every comment:**
  - every comment carries a long, short, flat or no-position tag;
  - the **server** stamps it with the room's clock and price when it's posted (the client can't set it);
  - long and short calls then show how they've done since: "Long call −4.06% since." That's the
    honest scoreboard, applied the same way to everyone.
- **Presence:** "N here" in the scoreboard.
- **Moderation from day one:**
  - links are blocked, and so are scam pitches ("dm me", "guaranteed", "100x") and slurs;
  - new names start in slow mode (10 s between comments for the first two minutes, then 3 s, and at
    most 6 a minute);
  - three reports from different people hide a comment;
  - mute works per browser.
- **Identity:** a display name and a random id kept in the browser. No accounts yet. Comments never
  feed the move rating.
- Reactions and comments live in memory (`server/social.ts`) behind a small interface, ready for a
  database.

## Run it

```bash
npm install
npm run dev     # server on 127.0.0.1:8787, web app on http://localhost:5173
npm test        # engine tests
npm run plays   # print the plays the engine calls for every cached replay
```

## Replay data

Replays need one-minute bars cached in `data/` (git-ignored). Fetch them from Alpaca. The keys are
read at run time from an env file you point at; Tape itself stores no keys.

```bash
npm run fetch -- --env-file ~/path/to/.env NVDA 2026-08-26
```

Alpaca's individual data plans are licensed for personal use. Never commit `data/`, and never serve
it publicly. The server listens on 127.0.0.1 only. A public version needs a display license for
real-time prices; that budget is laid out in the research report.

## How the move rating works

Every input is market data. Chat activity never feeds the rating.

| Part | What it measures |
|---|---|
| Size | How unusual the move is for this ticker right now (in "normal moves" for that window and time of day), or how big it is in plain percent, whichever is larger. Surprise on a tiny move is damped. |
| Volume | 0 points at twice normal volume, up to 2.5 points at 11× or more. |
| Novelty | New session highs and lows (more if the old level stood a long time), and the first big move after scheduled news. |
| Context | Earnings windows count more (×1.15). Thin pre-market and after-hours trading counts less (×0.9). |
| Cap | Big ratings need big moves: about 6.4 at most for a 0.3% move, 8.5 at 1%, 10 from 3%. Above 10 only for historic moves. |

"Normal" has two speeds:

- **Slow:** the long-run baseline, with outliers capped.
- **Fast:** the last few minutes.

After earnings hit, the fast side catches up, so the next 0.4% wiggle isn't a 10. Moves already in
progress keep the baseline from when they started.

## Layout

```
engine/      play engine, rating, sessions, time helpers (pure TypeScript, no I/O)
server/      room server: replays, live Coinbase rooms, websocket protocol, data cache
scripts/     fetch-day (Alpaca bars → data/), print-plays (engine output for tuning)
scenarios/   curated replays (metadata only; no market data)
web/         React app
tests/       engine tests on synthetic tapes
```

## Next slices

1. ~~Social layer~~ (done in slice 2). Next comes persistence: SQLite, then real accounts.
2. **Earnings-night rooms from the calendar:** free "beat or miss?" predictions (points only) and
   shareable box-score cards.
3. **Opening it up:** licensed real-time data for other users, accounts, moderation, then a phone app.

## Guardrails for v1

- No order routing and no revenue that depends on trades.
- No paid alert rooms, no personalized advice, no real-money predictions.
- 18+.
- Information and entertainment only, not investment advice.
