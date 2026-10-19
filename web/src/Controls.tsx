import { SPEEDS, type ControlAction, type ReplayState } from '../../server/protocol';
import { TIER_COLOR } from './Chart';
import { tierOf } from '../../engine';
import { clockMin } from './fmt';

export function ReplayControls({
  replay,
  clock,
  onControl,
}: {
  replay: ReplayState;
  clock: number;
  onControl: (a: ControlAction, v?: number) => void;
}) {
  const span = replay.endMs - replay.startMs;
  const at = (t: number) => `${Math.max(0, Math.min(100, ((t - replay.startMs) / span) * 100))}%`;
  return (
    <div className="controls">
      <div className="buttons">
        <button type="button" className="primary" onClick={() => onControl(replay.playing ? 'pause' : 'play')}>
          {replay.playing ? 'Pause' : replay.ended ? 'Watch again' : 'Play'}
        </button>
        <div className="speeds" role="group" aria-label="Replay speed">
          {SPEEDS.map((s) => (
            <button type="button" key={s} className={s === replay.speed ? 'on' : ''} onClick={() => onControl('speed', s)}>
              {s}×
            </button>
          ))}
        </div>
        <button type="button" onClick={() => onControl('next')} disabled={!replay.highlights.some((h) => h.t > clock + 1000)}>
          Next big play
        </button>
        <button type="button" onClick={() => onControl('restart')}>
          Restart
        </button>
      </div>
      <div
        className="track"
        role="slider"
        aria-label="Replay position"
        aria-valuemin={replay.startMs}
        aria-valuemax={replay.endMs}
        aria-valuenow={clock}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onControl('seek', replay.startMs + ((e.clientX - r.left) / r.width) * span);
        }}
      >
        <div className="fill" style={{ width: at(clock) }} />
        {replay.highlights.map((h) => (
          <span
            key={h.t}
            className="tick"
            style={{ left: at(h.t), background: TIER_COLOR[tierOf(h.rating)] }}
            title={`Rated ${h.rating.toFixed(1)} at ${clockMin(h.t)} ET`}
          />
        ))}
      </div>
      <div className="track-labels">
        <span>{clockMin(replay.startMs)} ET</span>
        <span>{clockMin(replay.endMs)} ET</span>
      </div>
    </div>
  );
}
