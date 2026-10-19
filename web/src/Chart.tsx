import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { tierOf, type Bar, type Play } from '../../engine';
import { clockMin } from './fmt';

const UP = '#22c55e';
const DOWN = '#f43f5e';
export const TIER_COLOR = {
  minor: '#64748b',
  notable: '#60a5fa',
  big: '#fbbf24',
  huge: '#fb923c',
  historic: '#c084fc',
} as const;

const ts = (ms: number) => (ms / 1000) as UTCTimestamp;
const toCandle = (b: Bar) => ({ time: ts(b.t), open: b.o, high: b.h, low: b.l, close: b.c });
const toVolume = (b: Bar) => ({
  time: ts(b.t),
  value: b.v,
  color: b.c >= b.o ? 'rgba(34,197,94,0.32)' : 'rgba(244,63,94,0.32)',
});

interface Api {
  chart: IChartApi;
  candles: ISeriesApi<'Candlestick'>;
  volume: ISeriesApi<'Histogram'>;
  markers: ISeriesMarkersPluginApi<Time>;
}

/** Candles and volume (TradingView's open-source Lightweight Charts), with a marker on every play. */
export function Chart({ bars, plays, version, focus }: { bars: Bar[]; plays: Play[]; version: number; focus: Play | null }) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const drawn = useRef({ version: -1, count: 0 });

  useEffect(() => {
    const chart = createChart(host.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b95a5',
        fontFamily: 'inherit',
        attributionLogo: true,
      },
      grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderVisible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        rightOffset: 4,
        barSpacing: 7,
        tickMarkFormatter: (t: Time) => clockMin(Number(t) * 1000),
      },
      localization: { timeFormatter: (t: Time) => `${clockMin(Number(t) * 1000)} ET` },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    api.current = { chart, candles, volume, markers: createSeriesMarkers(candles, []) };
    return () => {
      chart.remove();
      api.current = null;
      drawn.current = { version: -1, count: 0 };
    };
  }, []);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const d = drawn.current;
    if (d.version !== version || bars.length < d.count) {
      a.candles.setData(bars.map(toCandle));
      a.volume.setData(bars.map(toVolume));
    } else {
      for (let i = Math.max(0, d.count - 1); i < bars.length; i++) {
        a.candles.update(toCandle(bars[i]!));
        a.volume.update(toVolume(bars[i]!));
      }
    }
    drawn.current = { version, count: bars.length };
  }, [bars, version]);

  useEffect(() => {
    const a = api.current;
    if (!a) return;
    const first = bars[0]?.t ?? 0;
    const markers: SeriesMarker<Time>[] = plays
      .filter((p) => p.kind !== 'bell' && p.kind !== 'event' && p.barT >= first)
      .map((p) => ({
        time: ts(p.barT),
        position: p.dir < 0 ? 'aboveBar' : 'belowBar',
        shape: p.dir < 0 ? 'arrowDown' : p.dir > 0 ? 'arrowUp' : 'circle',
        color: TIER_COLOR[tierOf(p.rating)],
        text: p.rating.toFixed(1),
      }));
    markers.sort((x, y) => Number(x.time) - Number(y.time));
    a.markers.setMarkers(markers);
  }, [plays, bars]);

  useEffect(() => {
    const a = api.current;
    if (!a || !focus) return;
    const t = focus.barT / 1000;
    a.chart.timeScale().setVisibleRange({ from: (t - 40 * 60) as UTCTimestamp, to: (t + 15 * 60) as UTCTimestamp });
  }, [focus]);

  return <div className="chart" ref={host} />;
}
