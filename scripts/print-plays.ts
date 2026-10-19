/**
 * Print the plays the engine calls for a replay, for checking and tuning the engine.
 *
 *   npm run plays                      # every scenario with cached data
 *   npm run plays -- nvda-earnings-2026-08-26
 */
import { etClock, fmtPrice } from '../engine';
import { finalPlays, loadScenarios, timelineFor } from '../server/replay';

const wanted = process.argv.slice(2);
for (const sc of loadScenarios()) {
  if (wanted.length && !wanted.includes(sc.id)) continue;
  const tl = timelineFor(sc);
  if (!tl) {
    console.log(`\n${sc.id}: no data cached (npm run fetch -- --env-file <path> ${sc.symbol} ${sc.date})`);
    continue;
  }
  const plays = finalPlays(tl.frames);
  const updates = tl.frames.reduce((n, f) => n + f.events.filter((e) => e.type === 'update').length, 0);
  console.log(`\n${sc.title} (${sc.date}, ${sc.start}–${sc.end} ET): ${plays.length} plays, ${updates} in-place updates`);
  for (const p of plays) {
    const rev = p.revision ? ` (updated ×${p.revision})` : '';
    console.log(
      `  ${etClock(p.t).padStart(8)}  ${p.rating.toFixed(1).padStart(4)}  ${p.kind.padEnd(8)} ${p.title}${rev}`,
    );
    console.log(`  ${''.padStart(8)}        ${''.padEnd(8)} · ${p.factors.join(' · ')} · stamped ${fmtPrice(p.price)}`);
  }
}
