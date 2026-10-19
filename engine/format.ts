const fixed = (a: number) => (a >= 1 ? a.toFixed(1) : a.toFixed(2));

/** "+3.1%", "−0.45%" */
export function fmtPct(pct: number): string {
  return `${pct < 0 ? '−' : '+'}${fixed(Math.abs(pct))}%`;
}

/** "3.1%" */
export function fmtAbsPct(pct: number): string {
  return `${fixed(Math.abs(pct))}%`;
}

/** "$184.20", "$67,420" */
export function fmtPrice(p: number): string {
  if (p >= 1000) return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return '$' + p.toFixed(2);
}

/** "1 min", "12 min" */
export function fmtMinutes(m: number): string {
  const r = Math.max(1, Math.round(m));
  return r === 1 ? '1 min' : `${r} min`;
}

/** "45 min", "2 hr 10 min" */
export function fmtDuration(m: number): string {
  const r = Math.max(1, Math.round(m));
  if (r < 60) return `${r} min`;
  const h = Math.floor(r / 60);
  const rest = r % 60;
  return rest ? `${h} hr ${rest} min` : `${h} hr`;
}

/** "5.2×", "14×" */
export function fmtMult(x: number): string {
  return `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;
}
