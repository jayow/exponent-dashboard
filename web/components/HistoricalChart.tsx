'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';

type FlowData = { inflow: number[]; outflow: number[] };
type TvlHistory = {
  dates: string[];
  protocol: number[];
  byPlatform: Record<string, number[]>;
  byMarket: Record<string, number[]>;
  inflow: number[];
  outflow: number[];
  volume: number[];
  flowByPlatform: Record<string, FlowData>;
  flowByMarket: Record<string, FlowData>;
  marketMeta?: Record<string, { status: string }>;
};

type Metric = 'tvl' | 'flow' | 'volume';
type View = 'protocol' | 'platform' | 'market';
type Range = '30d' | '90d' | '1y' | 'all';

const COLORS = [
  '#6b66ff', '#ffb74d', '#4ade80', '#f87171', '#38bdf8',
  '#a78bfa', '#fb923c', '#34d399', '#f472b6', '#facc15',
  '#818cf8', '#fbbf24', '#22d3ee', '#e879f9', '#a3e635',
];

function normalizePlatform(p: string): string {
  if (/^Hylo/i.test(p)) return 'Hylo';
  if (/^Drift/i.test(p)) return 'Drift';
  if (/^Jupiter/i.test(p)) return 'Jupiter';
  if (/^Jito Restaking/i.test(p)) return 'Fragmetric';
  if (/^Jito/i.test(p)) return 'Jito';
  if (/^BULK/i.test(p)) return 'BULK';
  return p || 'Other';
}

function parseMaturity(key: string) {
  const parts = key.match(/(\d{2})([A-Z]{3})(\d{2})$/);
  if (!parts) return '9999-12-31';
  const months: Record<string, string> = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
  return `20${parts[3]}-${months[parts[2]] || '01'}-${parts[1]}`;
}

export function HistoricalChart() {
  const [data, setData] = useState<TvlHistory | null>(null);
  const [metric, setMetric] = useState<Metric>('tvl');
  const [view, setView] = useState<View>('protocol');
  const [range, setRange] = useState<Range>('all');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hideExpired, setHideExpired] = useState(false);

  useEffect(() => {
    fetch('/tvl-history.json').then(r => r.json()).then(setData).catch(() => null);
  }, []);

  const activeMarketKeys = useMemo(() => {
    if (!data?.marketMeta) return new Set<string>();
    return new Set(Object.entries(data.marketMeta).filter(([, m]) => m.status === 'active').map(([k]) => k));
  }, [data]);

  const toggleSeries = (key: string) => {
    setHidden(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  };

  const { chartData, series, seriesColors } = useMemo(() => {
    if (!data) return { chartData: [] as Record<string, any>[], series: [] as string[], seriesColors: {} as Record<string, string> };

    const rangeDays: Record<Range, number> = { '30d': 30, '90d': 90, '1y': 365, 'all': data.dates.length };
    const cutoff = rangeDays[range];
    const startIdx = Math.max(0, data.dates.length - cutoff);
    const dates = data.dates.slice(startIdx);

    // Protocol view
    if (view === 'protocol') {
      const rows = dates.map((d, i) => {
        const idx = startIdx + i;
        if (metric === 'tvl') return { date: d, TVL: data.protocol[idx] || 0 };
        if (metric === 'flow') return { date: d, Inflow: data.inflow[idx] || 0, Outflow: -(data.outflow[idx] || 0) };
        return { date: d, Volume: data.volume[idx] || 0 };
      });
      const keys = metric === 'flow' ? ['Inflow', 'Outflow'] : metric === 'tvl' ? ['TVL'] : ['Volume'];
      const colors: Record<string, string> = { TVL: '#6b66ff', Volume: '#38bdf8', Inflow: '#4ade80', Outflow: '#f87171' };
      return { chartData: rows, series: keys, seriesColors: colors };
    }

    // Platform or Market view
    if (metric === 'tvl') {
      // TVL breakdown
      let source = view === 'platform' ? data.byPlatform : data.byMarket;

      // Consolidate platforms
      if (view === 'platform') {
        const consolidated: Record<string, number[]> = {};
        for (const [k, v] of Object.entries(source)) {
          const norm = normalizePlatform(k);
          if (!consolidated[norm]) consolidated[norm] = new Array(v.length).fill(0);
          v.forEach((val, i) => { consolidated[norm][i] += val; });
        }
        source = consolidated;
      }

      const entries = Object.entries(source)
        .map(([k, v]) => ({ key: k, values: v.slice(startIdx), peak: Math.max(...v) }))
        .filter(e => e.peak > 0)
        .filter(e => view !== 'market' || !hideExpired || activeMarketKeys.has(e.key))
        .sort((a, b) => view === 'market' ? parseMaturity(a.key).localeCompare(parseMaturity(b.key)) : b.peak - a.peak);

      const keys = entries.map(e => e.key);
      const colors: Record<string, string> = {};
      keys.forEach((k, i) => { colors[k] = COLORS[i % COLORS.length]; });

      const rows = dates.map((d, i) => {
        const row: Record<string, any> = { date: d };
        entries.forEach(e => { row[e.key] = hidden.has(e.key) ? 0 : (e.values[i] || 0); });
        return row;
      });

      return { chartData: rows, series: keys, seriesColors: colors };
    }

    // Flow or Volume by platform/market — top 5 + Others
    const flowSource = view === 'platform' ? data.flowByPlatform : data.flowByMarket;
    const consolidated: Record<string, FlowData> = {};

    if (view === 'platform') {
      for (const [k, v] of Object.entries(flowSource)) {
        const norm = normalizePlatform(k);
        if (!consolidated[norm]) consolidated[norm] = { inflow: new Array(data.dates.length).fill(0), outflow: new Array(data.dates.length).fill(0) };
        v.inflow.forEach((val, i) => { consolidated[norm].inflow[i] += val; });
        v.outflow.forEach((val, i) => { consolidated[norm].outflow[i] += val; });
      }
    } else {
      for (const [k, v] of Object.entries(flowSource)) {
        if (hideExpired && !activeMarketKeys.has(k)) continue;
        consolidated[k] = v;
      }
    }

    const ranked = Object.entries(consolidated)
      .map(([k, v]) => {
        let vol = 0;
        for (let i = startIdx; i < data.dates.length; i++) vol += (v.inflow[i] || 0) + (v.outflow[i] || 0);
        return { key: k, data: v, vol };
      })
      .filter(e => e.vol > 0)
      .sort((a, b) => b.vol - a.vol);

    const top5 = ranked.slice(0, 5);
    const others = ranked.slice(5);
    const keys = top5.map(e => e.key);
    if (others.length > 0) keys.push('Others');

    const colors: Record<string, string> = {};
    keys.forEach((k, i) => { colors[k] = COLORS[i % COLORS.length]; });

    const rows = dates.map((d, i) => {
      const idx = startIdx + i;
      const row: Record<string, any> = { date: d };

      if (metric === 'flow') {
        for (const e of top5) {
          row[`${e.key}_in`] = e.data.inflow[idx] || 0;
          row[`${e.key}_out`] = -(e.data.outflow[idx] || 0);
        }
        if (others.length > 0) {
          let oIn = 0, oOut = 0;
          for (const e of others) { oIn += e.data.inflow[idx] || 0; oOut += e.data.outflow[idx] || 0; }
          row['Others_in'] = oIn;
          row['Others_out'] = -oOut;
        }
      } else {
        for (const e of top5) row[e.key] = (e.data.inflow[idx] || 0) + (e.data.outflow[idx] || 0);
        if (others.length > 0) {
          let oVol = 0;
          for (const e of others) oVol += (e.data.inflow[idx] || 0) + (e.data.outflow[idx] || 0);
          row['Others'] = oVol;
        }
      }
      return row;
    });

    return { chartData: rows, series: keys, seriesColors: colors };
  }, [data, metric, view, range, hidden, hideExpired, activeMarketKeys]);

  if (!data) return <div className="text-white/30 text-sm py-4">Loading…</div>;

  const fmtAxis = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v}`;
  };
  const fmtTick = (d: string) => {
    const dt = new Date(d + 'T00:00:00Z');
    return `${dt.toLocaleString('en', { month: 'short' })} ${String(dt.getUTCFullYear()).slice(-2)}`;
  };
  const interval = Math.max(1, Math.floor(chartData.length / 8));

  const isFlowProtocol = metric === 'flow' && view === 'protocol';
  const isFlowBreakdown = metric === 'flow' && view !== 'protocol';

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            {(['tvl', 'flow', 'volume'] as Metric[]).map(m => (
              <button key={m} onClick={() => { setMetric(m); setHidden(new Set()); }}
                className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                  metric === m ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'
                }`}>
                {m === 'tvl' ? 'TVL' : m === 'flow' ? 'Inflow / Outflow' : 'Volume'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {(['protocol', 'platform', 'market'] as View[]).map(v => (
              <button key={v} onClick={() => { setView(v); setHidden(new Set()); }}
                className={`text-xs px-2.5 py-1 rounded-md transition ${
                  view === v ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
                }`}>
                {v === 'protocol' ? 'Protocol' : v === 'platform' ? 'Platform' : 'Market'}
              </button>
            ))}
          </div>
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
          <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
            {...(isFlowProtocol || isFlowBreakdown ? { stackOffset: 'sign' as const } : {})}>
            <XAxis dataKey="date" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
              tickFormatter={fmtTick} interval={interval} />
            <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
              tickFormatter={fmtAxis} width={55} />
            {(isFlowProtocol || isFlowBreakdown) && <ReferenceLine y={0} stroke="#333" />}
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const dt = new Date(label + 'T00:00:00Z');
                const dateStr = dt.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });

                if (isFlowProtocol) {
                  const inf = Math.abs(Number(payload.find((p: any) => p.dataKey === 'Inflow')?.value || 0));
                  const outf = Math.abs(Number(payload.find((p: any) => p.dataKey === 'Outflow')?.value || 0));
                  const net = inf - outf;
                  return (
                    <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                      <div style={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}>{dateStr}</div>
                      <div style={{ color: '#4ade80' }}>Inflow: ${(inf / 1e6).toFixed(2)}M</div>
                      <div style={{ color: '#f87171' }}>Outflow: ${(outf / 1e6).toFixed(2)}M</div>
                      <div style={{ color: net >= 0 ? '#4ade80' : '#f87171', borderTop: '1px solid #333', marginTop: 4, paddingTop: 4 }}>
                        Net: {net >= 0 ? '+' : ''}${(net / 1e6).toFixed(2)}M
                      </div>
                    </div>
                  );
                }

                if (isFlowBreakdown) {
                  const items: { name: string; inflow: number; outflow: number; color: string }[] = [];
                  for (const key of series) {
                    const inf = Math.abs(Number(payload.find((p: any) => p.dataKey === `${key}_in`)?.value || 0));
                    const outf = Math.abs(Number(payload.find((p: any) => p.dataKey === `${key}_out`)?.value || 0));
                    if (inf > 0 || outf > 0) items.push({ name: key, inflow: inf, outflow: outf, color: seriesColors[key] });
                  }
                  items.sort((a, b) => (b.inflow + b.outflow) - (a.inflow + a.outflow));
                  return (
                    <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, padding: '8px 12px', fontSize: 12, maxHeight: 300, overflow: 'auto' }}>
                      <div style={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}>{dateStr}</div>
                      {items.map(it => (
                        <div key={it.name} style={{ display: 'flex', gap: 12, marginBottom: 2 }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 80 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: it.color, display: 'inline-block' }} />
                            {it.name}
                          </span>
                          <span style={{ color: '#4ade80', fontVariantNumeric: 'tabular-nums' }}>+${(it.inflow / 1e6).toFixed(2)}M</span>
                          <span style={{ color: '#f87171', fontVariantNumeric: 'tabular-nums' }}>-${(it.outflow / 1e6).toFixed(2)}M</span>
                        </div>
                      ))}
                    </div>
                  );
                }

                // TVL or Volume tooltip
                const items = payload.filter((p: any) => Number(p.value) > 0).sort((a: any, b: any) => Number(b.value) - Number(a.value));
                if (!items.length) return null;
                return (
                  <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, padding: '8px 12px', fontSize: 13, maxHeight: 350, overflow: 'auto' }}>
                    <div style={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}>{dateStr}</div>
                    {items.map((p: any) => (
                      <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, color: '#ccc' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color || seriesColors[p.name] || '#6b66ff', display: 'inline-block' }} />
                          {p.name}
                        </span>
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>${(Number(p.value) / 1e6).toFixed(2)}M</span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />

            {/* TVL bars */}
            {metric === 'tvl' && view === 'protocol' && (
              <Bar dataKey="TVL" fill="#6b66ff" fillOpacity={0.8} />
            )}
            {metric === 'tvl' && view !== 'protocol' && (
              series.map((s, i) => (
                <Bar key={s} dataKey={s} stackId="1"
                  fill={hidden.has(s) ? 'transparent' : seriesColors[s]}
                  fillOpacity={hidden.has(s) ? 0 : 0.8} />
              ))
            )}

            {/* Flow bars */}
            {isFlowProtocol && (
              <>
                <Bar dataKey="Inflow" fill="#4ade80" fillOpacity={0.7} stackId="s" />
                <Bar dataKey="Outflow" fill="#f87171" fillOpacity={0.7} stackId="s" />
              </>
            )}
            {isFlowBreakdown && (
              series.flatMap((k) => [
                <Bar key={`${k}_in`} dataKey={`${k}_in`} fill={seriesColors[k]} fillOpacity={0.8} stackId="in" />,
                <Bar key={`${k}_out`} dataKey={`${k}_out`} fill={seriesColors[k]} fillOpacity={0.4} stackId="out" />,
              ])
            )}

            {/* Volume bars */}
            {metric === 'volume' && view === 'protocol' && (
              <Bar dataKey="Volume" fill="#38bdf8" fillOpacity={0.7} />
            )}
            {metric === 'volume' && view !== 'protocol' && (
              series.map((k) => (
                <Bar key={k} dataKey={k} stackId="1" fill={seriesColors[k]} fillOpacity={0.7} />
              ))
            )}
          </BarChart>
        </ResponsiveContainer>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-3 justify-center items-center">
          {isFlowProtocol && (
            <>
              <span className="flex items-center gap-1 text-[11px]"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400" /> Inflow</span>
              <span className="flex items-center gap-1 text-[11px]"><span className="w-2.5 h-2.5 rounded-full bg-red-400" /> Outflow</span>
            </>
          )}
          {view !== 'protocol' && metric === 'tvl' && (
            <>
              <button
                onClick={() => { if (hidden.size === series.length) setHidden(new Set()); else setHidden(new Set(series)); }}
                className="text-[10px] px-2 py-0.5 rounded border border-white/10 text-white/30 hover:text-white/60 transition mr-1">
                {hidden.size === series.length ? 'Show All' : 'Hide All'}
              </button>
              {series.map(s => (
                <button key={s} onClick={() => toggleSeries(s)}
                  className={`flex items-center gap-1 text-[11px] transition cursor-pointer ${hidden.has(s) ? 'opacity-30' : 'opacity-100 hover:opacity-80'}`}>
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: seriesColors[s] }} />
                  <span className="text-white/50">{s}</span>
                </button>
              ))}
            </>
          )}
          {view !== 'protocol' && metric !== 'tvl' && (
            series.map(k => (
              <span key={k} className="flex items-center gap-1 text-[11px]">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: seriesColors[k] }} />
                <span className="text-white/50">{k}</span>
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
