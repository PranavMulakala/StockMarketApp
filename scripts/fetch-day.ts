/**
 * Download one-minute bars for a stock and day (4:00 AM–8:00 PM ET) from Alpaca, plus the previous
 * trading day for warmup, into data/replays/. Personal-use data: never commit it or show it publicly.
 *
 *   npm run fetch -- --env-file ~/path/to/.env NVDA 2026-08-26 [NFLX 2026-10-15 ...]
 *
 * Tape stores no keys. They are read at run time from the env file you point at (only the Alpaca
 * key names below are read from it) or from the environment.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Bar } from '../engine';
import { etToUtcMs } from '../engine';
import { saveDay } from '../server/data';

const KEY_NAMES = ['ALPACA_API_KEY_ID', 'APCA_API_KEY_ID', 'ALPACA_PAPER_API_KEY'];
const SECRET_NAMES = ['ALPACA_API_SECRET_KEY', 'APCA_API_SECRET_KEY', 'ALPACA_PAPER_API_SECRET'];

function readKeys(envFile?: string): { key: string; secret: string } {
  const vals: Record<string, string> = {};
  if (envFile) {
    const path = envFile.replace(/^~(?=\/)/, homedir());
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || ![...KEY_NAMES, ...SECRET_NAMES].includes(m[1]!)) continue;
      vals[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
    }
  }
  const pick = (names: string[]) => names.map((n) => vals[n] ?? process.env[n]).find((v) => v);
  const key = pick(KEY_NAMES);
  const secret = pick(SECRET_NAMES);
  if (!key || !secret) {
    throw new Error(`No Alpaca keys found. Pass --env-file with one of ${KEY_NAMES.join('/')} and ${SECRET_NAMES.join('/')}.`);
  }
  return { key, secret };
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

async function alpacaBars(
  auth: { key: string; secret: string },
  symbol: string,
  start: string,
  end: string,
  timeframe = '1Min',
): Promise<Bar[]> {
  const out: Bar[] = [];
  let token: string | undefined;
  do {
    const q = new URLSearchParams({ timeframe, start, end, limit: '10000', adjustment: 'raw', feed: 'sip' });
    if (token) q.set('page_token', token);
    const res = await fetch(`https://data.alpaca.markets/v2/stocks/${symbol}/bars?${q}`, {
      headers: { 'APCA-API-KEY-ID': auth.key, 'APCA-API-SECRET-KEY': auth.secret },
    });
    if (!res.ok) throw new Error(`Alpaca ${res.status} for ${symbol} ${start}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { bars: AlpacaBar[] | null; next_page_token: string | null };
    for (const b of body.bars ?? []) out.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    token = body.next_page_token ?? undefined;
  } while (token);
  return out;
}

const iso = (ms: number) => new Date(ms).toISOString();

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchDay(auth: { key: string; secret: string }, symbol: string, date: string) {
  const session = (d: string) => [iso(etToUtcMs(d, 4, 0)), iso(etToUtcMs(d, 20, 0))] as const;
  const bars = await alpacaBars(auth, symbol, ...session(date));
  if (!bars.length) throw new Error(`No bars for ${symbol} on ${date} (market holiday or weekend?)`);
  for (let back = 1; back <= 7; back++) {
    const prevDate = shiftDate(date, -back);
    const prevBars = await alpacaBars(auth, symbol, ...session(prevDate));
    if (!prevBars.length) continue;
    const daily = await alpacaBars(auth, symbol, prevDate, prevDate, '1Day');
    const prevClose = daily[0]?.c ?? prevBars.filter((b) => b.t < etToUtcMs(prevDate, 16, 0)).at(-1)!.c;
    const file = saveDay({
      symbol,
      date,
      source: 'alpaca-sip-1min',
      fetchedAt: new Date().toISOString(),
      prevDate,
      prevClose,
      prevBars,
      bars,
    });
    console.log(`${symbol} ${date}: ${bars.length} bars (prev ${prevDate}: ${prevBars.length} bars, close ${prevClose}) → ${file}`);
    return;
  }
  throw new Error(`No previous trading day found for ${symbol} ${date}`);
}

async function main() {
  const args = process.argv.slice(2);
  let envFile: string | undefined;
  const i = args.indexOf('--env-file');
  if (i >= 0) {
    envFile = args[i + 1];
    args.splice(i, 2);
  }
  if (args.length < 2 || args.length % 2) {
    console.error('Usage: npm run fetch -- --env-file <path> SYMBOL YYYY-MM-DD [SYMBOL YYYY-MM-DD ...]');
    process.exit(1);
  }
  const auth = readKeys(envFile);
  for (let k = 0; k < args.length; k += 2) await fetchDay(auth, args[k]!.toUpperCase(), args[k + 1]!);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
