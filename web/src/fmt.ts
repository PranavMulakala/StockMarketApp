const ET_SEC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});
const ET_MIN = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** "4:05:12 PM" Eastern */
export const clockSec = (ms: number) => ET_SEC.format(ms);
/** "4:05 PM" Eastern */
export const clockMin = (ms: number) => ET_MIN.format(ms);
/** "Aug 26, 2026" */
export const longDate = (iso: string) => DATE.format(new Date(`${iso}T12:00:00Z`));

/** "$81,956.88", "$209.66" */
export function money(p: number | null | undefined): string {
  if (p === null || p === undefined) return '—';
  return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "+1.24%", "−0.40%" */
export function signedPct(p: number | null): string {
  if (p === null) return '—';
  return `${p < 0 ? '−' : '+'}${Math.abs(p).toFixed(2)}%`;
}
