'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';

type FlowData = { inflow: number[]; outflow: number[] };
type TvlHistory = {
  dates: string[];
  inflow: number[];
  outflow: number[];
  volume: number[];
  flowByPlatform: Record<string, FlowData>;
  flowByMarket: Record<string, FlowData>;
};

type Metric = 'flow' | 'volume';
type View = 'protocol' | 'platform' | 'market';
type Range = '30d' | '90d' | '1y' | 'all';

const COLORS = [
  '#6b66ff', '#ffb74d', '#4ade80', '#f87171', '#38bdf8',
  '#a78bfa', '#fb923c', '#34d399', '#f472b6', '#facc15',
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

export function FlowChart() {
  const [data, setData] = useState<TvlHistory | null>(null);
  const [metric, setMetric] = useState<Metric>('flow');
  const [view, setView] = useState<View>('protocol');
  const [range, setRange] = useState<Range>('90d');

  useEffect(() => {
    fetch('/tvl-history.json').then(r => r.json()).then(setData).catch(() => null);
  }, []);

  const { chartData, topKeys, keyColors } = useMemo(() => {
    if (!data) return { chartData: [] as Record<string, any>[], topKeys: [] as string[], keyColors: {} as Record<string, string> };

    const rangeDays: Record<Range, number> = { '30d': 30, '90d': 90, '1y': 365, 'all': data.dates.length };
    const cutoff = rangeDays[range];
    const startIdx = Math.max(0, data.dates.length - cutoff);
    const dates = data.dates.slice(startIdx);

    if (view === 'protocol') {
      const rows = dates.map((d, i) => {
        const idx = startIdx + i;
        return {
          date: d,
          inflow: data.inflow[idx] || 0,
          outflow: -(data.outflow[idx] || 0),
          volume: data.volume[idx] || 0,
        };
      });
      return { chartData: rows, topKeys: ['protocol'], keyColors: {} as Record<string, string> };
    }

    // Platform or Market view — get top 5 by total volume in range, rest as Others
    const source = view === 'platform' ? data.flowByPlatform : data.flowByMarket;
    const consolidated: Record<string, FlowData> = {};

    if (view === 'platform') {
      for (const [k, v] of Object.entries(source)) {
        const norm = normalizePlatform(k);
        if (!consolidated[norm]) consolidated[norm] = { inflow: new Array(data.dates.length).fill(0), outflow: new Array(data.dates.length).fill(0) };
        v.inflow.forEach((val, i) => { consolidated[norm].inflow[i] += val; });
        v.outflow.forEach((val, i) => { consolidated[norm].outflow[i] += val; });
      }
    } else {
      Object.assign(consolidated, source);
    }

    // Rank by total volume in the visible range
    const ranked = Object.entries(consolidated)
      .map(([k, v]) => {
        let vol = 0;
        for (let i = startIdx; i < data.dates.length; i++) {
          vol += (v.inflow[i] || 0) + (v.outflow[i] || 0);
        }
        return { key: k, data: v, vol };
      })
      .filter(e => e.vol > 0)
      .sort((a, b) => b.vol - a.vol);

    const top5 = ranked.slice(0, 5);
    const others = ranked.slice(5);
    const keys = top5.map(e => e.key);

    // Build Others aggregate
    if (others.length > 0) {
      keys.push('Others');
    }

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
        for (const e of top5) {
          row[e.key] = (e.data.inflow[idx] || 0) + (e.data.outflow[idx] || 0);
        }
        if (others.length > 0) {
          let oVol = 0;
          for (const e of others) { oVol += (e.data.inflow[idx] || 0) + (e.data.outflow[idx] || 0); }
          row['Others'] = oVol;
        }
      }
      return row;
    });

    return { chartData: rows, topKeys: keys, keyColors: colors as Record<string, string> };
  }, [data, metric, view, range]);

  if (!data) return null;

  const fmtAxis = (v: number) => {
    const abs = Math.abs(v);
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v}`;
  };

  const fmtTick = (d: string) => {
    const dt = new Date(d + 'T00:00:00Z');
    return `${dt.toLocaleString('en', { month: 'short' })} ${dt.getUTCDate()}`;
  };

  const interval = Math.max(1, Math.floor(chartData.length / 8));

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            {(['flow', 'volume'] as Metric[]).map(m => (
              <button key={m} onClick={() => setMetric(m)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                  metric === m ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'
                }`}>
                {m === 'flow' ? 'Inflow / Outflow' : 'Volume'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {(['protocol', 'platform', 'market'] as View[]).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={`text-xs px-2.5 py-1 rounded-md transition ${
                  view === v ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
                }`}>
                {v === 'protocol' ? 'Protocol' : v === 'platform' ? 'Platform' : 'Market'}
              </button>
            ))}
          </div>
        </div>
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

      <div className="rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur p-4">
        <ResponsiveContainer width="100%" height={280}>
          {metric === 'flow' ? (
            <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }} stackOffset="sign">
              <XAxis dataKey="date" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                tickFormatter={fmtTick} interval={interval} />
              <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                tickFormatter={fmtAxis} width={55} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const dt = new Date(label + 'T00:00:00Z');
                  const dateStr = dt.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });

                  if (view === 'protocol') {
                    const inflow = Math.abs(Number(payload.find((p: any) => p.dataKey === 'inflow')?.value || 0));
                    const outflow = Math.abs(Number(payload.find((p: any) => p.dataKey === 'outflow')?.value || 0));
                    const net = inflow - outflow;
                    return (
                      <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                        <div style={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}>{dateStr}</div>
                        <div style={{ color: '#4ade80' }}>Inflow: ${(inflow / 1e6).toFixed(2)}M</div>
                        <div style={{ color: '#f87171' }}>Outflow: ${(outflow / 1e6).toFixed(2)}M</div>
                        <div style={{ color: net >= 0 ? '#4ade80' : '#f87171', borderTop: '1px solid #333', marginTop: 4, paddingTop: 4 }}>
                          Net: {net >= 0 ? '+' : ''}${(net / 1e6).toFixed(2)}M
                        </div>
                      </div>
                    );
                  }

                  // Platform/market breakdown
                  const items: { name: string; inflow: number; outflow: number; color: string }[] = [];
                  for (const key of topKeys) {
                    const inf = Math.abs(Number(payload.find((p: any) => p.dataKey === `${key}_in`)?.value || 0));
                    const outf = Math.abs(Number(payload.find((p: any) => p.dataKey === `${key}_out`)?.value || 0));
                    if (inf > 0 || outf > 0) items.push({ name: key, inflow: inf, outflow: outf, color: keyColors[key] });
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
                }}
              />
              <ReferenceLine y={0} stroke="#333" />
              {view === 'protocol' ? (
                <>
                  <Bar dataKey="inflow" fill="#4ade80" fillOpacity={0.7} stackId="s" />
                  <Bar dataKey="outflow" fill="#f87171" fillOpacity={0.7} stackId="s" />
                </>
              ) : (
                topKeys.flatMap((k, i) => [
                  <Bar key={`${k}_in`} dataKey={`${k}_in`} fill={keyColors[k]} fillOpacity={0.8} stackId="in" />,
                  <Bar key={`${k}_out`} dataKey={`${k}_out`} fill={keyColors[k]} fillOpacity={0.4} stackId="out" />,
                ])
              )}
            </BarChart>
          ) : (
            <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <XAxis dataKey="date" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                tickFormatter={fmtTick} interval={interval} />
              <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                tickFormatter={fmtAxis} width={55} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const dt = new Date(label + 'T00:00:00Z');
                  const dateStr = dt.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
                  const items = payload
                    .filter((p: any) => Number(p.value) > 0)
                    .sort((a: any, b: any) => Number(b.value) - Number(a.value));
                  if (!items.length) return null;
                  return (
                    <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                      <div style={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}>{dateStr}</div>
                      {items.map((p: any) => (
                        <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, color: '#ccc' }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color || '#38bdf8', display: 'inline-block' }} />
                            {p.name === 'volume' ? 'Volume' : p.name}
                          </span>
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>${(Number(p.value) / 1e6).toFixed(2)}M</span>
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              {view === 'protocol' ? (
                <Bar dataKey="volume" fill="#38bdf8" fillOpacity={0.7} />
              ) : (
                topKeys.map((k, i) => (
                  <Bar key={k} dataKey={k} stackId="1" fill={keyColors[k]} fillOpacity={0.7} />
                ))
              )}
            </BarChart>
          )}
        </ResponsiveContainer>

        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 justify-center text-[11px]">
          {metric === 'flow' && view === 'protocol' && (
            <>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400" /> Inflow</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-400" /> Outflow</span>
            </>
          )}
          {view !== 'protocol' && topKeys.map(k => (
            <span key={k} className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: keyColors[k] }} />
              <span className="text-white/50">{k}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
