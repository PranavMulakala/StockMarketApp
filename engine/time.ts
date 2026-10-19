/** Time helpers. Market times are US Eastern (America/New_York), DST-aware. */

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const ET_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
});

export interface EtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function etParts(ms: number): EtParts {
  const p: Record<string, string> = {};
  for (const part of ET_PARTS.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Minutes since midnight, Eastern. */
export function etMinuteOfDay(ms: number): number {
  const p = etParts(ms);
  return p.hour * 60 + p.minute;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Eastern calendar date, YYYY-MM-DD. */
export function etDate(ms: number): string {
  const p = etParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** UTC calendar date, YYYY-MM-DD. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Epoch ms for an Eastern wall-clock time on a date, e.g. ("2026-08-26", 16, 5). */
export function etToUtcMs(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wanted = Date.UTC(y, m - 1, d, hour, minute);
  let guess = wanted + 5 * 3_600_000; // start from UTC-5, correct for DST below
  for (let i = 0; i < 3; i++) {
    const p = etParts(guess);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (shown === wanted) break;
    guess += wanted - shown;
  }
  return guess;
}

/** "16:05" → [16, 5] */
export function parseHm(hm: string): [number, number] {
  const [h, m] = hm.split(':').map(Number);
  return [h ?? 0, m ?? 0];
}

/** "4:05 PM" in Eastern time. */
export function etClock(ms: number): string {
  return ET_CLOCK.format(new Date(ms));
}
