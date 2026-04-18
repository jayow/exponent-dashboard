'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';

type TvlHistory = {
  generatedAt: string;
  dates: string[];
  protocol: number[];
  byPlatform: Record<string, number[]>;
  byMarket: Record<string, number[]>;
};

type View = 'protocol' | 'platform' | 'market';
type Range = '30d' | '90d' | '1y' | 'all';

const COLORS = [
  '#6b66ff', '#ffb74d', '#4ade80', '#f87171', '#38bdf8',
  '#a78bfa', '#fb923c', '#34d399', '#f472b6', '#facc15',
  '#818cf8', '#fbbf24', '#22d3ee', '#e879f9', '#a3e635',
];

export function TvlChart() {
  const [data, setData] = useState<TvlHistory | null>(null);
  const [liveData, setLiveData] = useState<any>(null);
  const [view, setView] = useState<View>('protocol');
  const [range, setRange] = useState<Range>('all');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hideExpired, setHideExpired] = useState(false);

  const toggleSeries = (key: string) => {
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    fetch('/tvl-history.json').then(r => r.json()).then(setData).catch(() => null);
    fetch('/markets-live.json').then(r => r.json()).then(setLiveData).catch(() => null);
  }, []);

  const activeMarketKeys = useMemo(() => {
    if (!liveData) return new Set<string>();
    return new Set<string>(liveData.markets?.map((m: any) => {
      const d = new Date(m.maturity + 'T00:00:00Z');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mmm = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()];
      const yy = String(d.getUTCFullYear()).slice(-2);
      return `${m.ticker}-${dd}${mmm}${yy}`;
    }) || []);
  }, [liveData]);

  const { chartData, series, seriesColors } = useMemo(() => {
    if (!data) return { chartData: [], series: [] as string[], seriesColors: {} as Record<string, string> };

    const now = new Date();
    const rangeDays: Record<Range, number> = { '30d': 30, '90d': 90, '1y': 365, 'all': data.dates.length };
    const cutoff = rangeDays[range];
    const startIdx = Math.max(0, data.dates.length - cutoff);
    const dates = data.dates.slice(startIdx);

    let keys: string[] = [];
    let seriesData: Record<string, number[]> = {};

    if (view === 'protocol') {
      keys = ['TVL'];
      seriesData['TVL'] = data.protocol.slice(startIdx);
    } else if (view === 'platform') {
      // Consolidate related platforms
      const consolidated: Record<string, number[]> = {};
      for (const [k, v] of Object.entries(data.byPlatform)) {
        const norm = normalizePlatform(k);
        if (!consolidated[norm]) consolidated[norm] = new Array(v.length).fill(0);
        v.forEach((val, i) => { consolidated[norm][i] += val; });
      }
      const entries = Object.entries(consolidated)
        .map(([k, v]) => ({ key: k, values: v.slice(startIdx), peak: Math.max(...v) }))
        .filter(e => e.peak > 100000)
        .sort((a, b) => b.peak - a.peak);
      keys = entries.map(e => e.key);
      entries.forEach(e => { seriesData[e.key] = e.values; });
    } else {
      const entries = Object.entries(data.byMarket)
        .map(([k, v]) => ({ key: k, values: v.slice(startIdx), peak: Math.max(...v) }))
        .filter(e => e.peak > 0)
        .filter(e => !hideExpired || activeMarketKeys.has(e.key))
        .sort((a, b) => {
          // Sort by maturity date (parse from key like "USX-01JUN26")
          const parseMaturity = (key: string) => {
            const parts = key.match(/(\d{2})([A-Z]{3})(\d{2})$/);
            if (!parts) return '9999-12-31';
            const months: Record<string, string> = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
            return `20${parts[3]}-${months[parts[2]] || '01'}-${parts[1]}`;
          };
          return parseMaturity(a.key).localeCompare(parseMaturity(b.key));
        });
      keys = entries.map(e => e.key);
      entries.forEach(e => { seriesData[e.key] = e.values; });
    }

    const rows = dates.map((d, i) => {
      const row: Record<string, any> = { date: d };
      keys.forEach(k => { row[k] = hidden.has(k) ? 0 : (seriesData[k]?.[i] || 0); });
      return row;
    });

    const colors: Record<string, string> = {};
    keys.forEach((k, i) => { colors[k] = COLORS[i % COLORS.length]; });

    return { chartData: rows, series: keys, seriesColors: colors };
  }, [data, view, range, hidden, hideExpired, activeMarketKeys]);

  if (!data) return <div className="text-white/30 text-sm py-4">Loading historical data…</div>;

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-1">
          {(['protocol', 'platform', 'market'] as View[]).map(v => (
            <button key={v} onClick={() => { setView(v); setHidden(new Set()); }}
              className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                view === v ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'
              }`}>
              {v === 'protocol' ? 'Protocol' : v === 'platform' ? 'By Platform' : 'By Market'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {view === 'market' && (
            <button onClick={() => { setHideExpired(v => !v); setHidden(new Set()); }}
              className={`text-xs px-2.5 py-1 rounded-md border transition ${
                hideExpired ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/30 hover:text-white/60'
              }`}>
              Active Only
            </button>
          )}
          <div className="flex items-center gap-1">
            {(['30d', '90d', '1y', 'all'] as Range[]).map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`text-xs px-2.5 py-1 rounded-md transition ${
                  range === r ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
                }`}>
                {r === 'all' ? 'All' : r.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur p-4">
        <ResponsiveContainer width="100%" height={340}>
          <AreaChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
            <defs>
              {series.map((s, i) => (
                <linearGradient key={s} id={`grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={seriesColors[s]} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={seriesColors[s]} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fill: '#8888aa', fontSize: 11 }}
              axisLine={false} tickLine={false}
              tickFormatter={d => {
                const dt = new Date(d + 'T00:00:00Z');
                return `${dt.toLocaleString('en', { month: 'short' })} ${dt.getUTCFullYear().toString().slice(-2)}`;
              }}
              interval={Math.max(1, Math.floor(chartData.length / 8))}
            />
            <YAxis
              tick={{ fill: '#8888aa', fontSize: 11 }}
              axisLine={false} tickLine={false}
              tickFormatter={v => v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v}`}
              width={60}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload) return null;
                const dt = new Date(label + 'T00:00:00Z');
                const dateStr = dt.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
                const nonZero = payload.filter((p: any) => p.value > 0).sort((a: any, b: any) => b.value - a.value);
                if (!nonZero.length) return null;
                return (
                  <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                    <div style={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}>{dateStr}</div>
                    {nonZero.map((p: any) => (
                      <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, color: '#ccc' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, display: 'inline-block' }} />
                          {p.name}
                        </span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>${(p.value / 1e6).toFixed(2)}M</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            {view === 'protocol' ? (
              <Area
                type="monotone" dataKey="TVL"
                stroke="#6b66ff" strokeWidth={2}
                fill="url(#grad-0)"
              />
            ) : (
              series.map((s, i) => (
                <Area
                  key={s} type="monotone" dataKey={s}
                  stackId="1"
                  stroke={hidden.has(s) ? 'transparent' : seriesColors[s]}
                  strokeWidth={hidden.has(s) ? 0 : 1}
                  fill={hidden.has(s) ? 'transparent' : `url(#grad-${i})`}
                  fillOpacity={hidden.has(s) ? 0 : 1}
                />
              ))
            )}
          </AreaChart>
        </ResponsiveContainer>

        {view !== 'protocol' && (
          <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-3 justify-center items-center">
            <button
              onClick={() => {
                if (hidden.size === series.length) setHidden(new Set());
                else setHidden(new Set(series));
              }}
              className="text-[10px] px-2 py-0.5 rounded border border-white/10 text-white/30 hover:text-white/60 transition mr-1">
              {hidden.size === series.length ? 'Show All' : 'Hide All'}
            </button>
            {series.map(s => (
              <button key={s} onClick={() => toggleSeries(s)}
                className={`flex items-center gap-1 text-[11px] transition cursor-pointer ${hidden.has(s) ? 'opacity-30' : 'opacity-100 hover:opacity-80'}`}>
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: seriesColors[s] }} />
                <span className="text-white/50">{s}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function normalizePlatform(platform: string): string {
  if (/^Hylo/i.test(platform)) return 'Hylo';
  if (/^Drift/i.test(platform)) return 'Drift';
  if (/^Jupiter/i.test(platform)) return 'Jupiter';
  if (/^Jito Restaking/i.test(platform)) return 'Fragmetric';
  if (/^Jito/i.test(platform)) return 'Jito';
  if (/^BULK/i.test(platform)) return 'BULK';
  return platform || 'Other';
}
