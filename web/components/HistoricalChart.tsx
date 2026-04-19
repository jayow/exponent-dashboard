'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
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
  underlyingApyByMarket?: Record<string, number[]>;
  impliedApyByMarket?: Record<string, number[]>;
  marketMeta?: Record<string, { status: string; platform?: string }>;
};

type Metric = 'tvl' | 'flow' | 'volume' | 'activity' | 'claims' | 'apy';
type ApyView = 'current' | 'history';
type View = 'protocol' | 'platform' | 'market';
type Range = '30d' | '90d' | '1y' | 'all';

const COLORS = [
  '#6b66ff', '#ffb74d', '#4ade80', '#f87171', '#38bdf8',
  '#a78bfa', '#fb923c', '#34d399', '#f472b6', '#facc15',
  '#818cf8', '#fbbf24', '#22d3ee', '#e879f9', '#a3e635',
];

function round2(n: number) { return Math.round(n * 100) / 100; }

function fmtVal(n: number) {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

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
  const [analyticsData, setAnalyticsData] = useState<any>(null);
  const [metric, setMetric] = useState<Metric>('tvl');
  const [view, setView] = useState<View>('protocol');
  const [range, setRange] = useState<Range>('all');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hideExpired, setHideExpired] = useState(false);
  const [apyView, setApyView] = useState<ApyView>('current');

  useEffect(() => {
    fetch('/tvl-history.json').then(r => r.json()).then(setData).catch(() => null);
    fetch('/analytics.json').then(r => r.json()).then(setAnalyticsData).catch(() => null);
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

    // Activity view — stacked bar of action types
    if (metric === 'activity' && analyticsData) {
      const actionTypes = ['buyYt', 'sellYt', 'buyPt', 'sellPt', 'addLiq', 'removeLiq', 'claimYield', 'redeemPt'];
      const actionColors: Record<string, string> = {
        buyYt: '#4ade80', sellYt: '#f87171', buyPt: '#38bdf8', sellPt: '#fb923c',
        addLiq: '#a78bfa', removeLiq: '#f472b6', claimYield: '#facc15', redeemPt: '#818cf8',
      };

      if (view === 'protocol') {
        const actData = analyticsData.activityProtocol || {};
        const aDates = analyticsData.dates || [];
        const aStartIdx = Math.max(0, aDates.length - cutoff);
        const rows = aDates.slice(aStartIdx).map((d: string, i: number) => {
          const row: Record<string, any> = { date: d };
          actionTypes.forEach(a => { row[a] = (actData[a] || [])[aStartIdx + i] || 0; });
          return row;
        });
        return { chartData: rows, series: actionTypes, seriesColors: actionColors };
      }
      // Platform view
      const platData = analyticsData.activityByPlatform || {};
      const aDates = analyticsData.dates || [];
      const aStartIdx = Math.max(0, aDates.length - cutoff);
      const platforms = Object.keys(platData).sort((a, b) => {
        const aSum = Object.values(platData[a] as Record<string, number[]>).flat().reduce((s: number, v: number) => s + v, 0);
        const bSum = Object.values(platData[b] as Record<string, number[]>).flat().reduce((s: number, v: number) => s + v, 0);
        return bSum - aSum;
      }).slice(0, 8);
      const rows = aDates.slice(aStartIdx).map((d: string, i: number) => {
        const row: Record<string, any> = { date: d };
        platforms.forEach(p => {
          row[p] = actionTypes.reduce((s, a) => s + ((platData[p]?.[a] || [])[aStartIdx + i] || 0), 0);
        });
        return row;
      });
      const colors: Record<string, string> = {};
      platforms.forEach((p, i) => { colors[p] = COLORS[i % COLORS.length]; });
      return { chartData: rows, series: platforms, seriesColors: colors };
    }

    // Claims view — daily claim count or USD
    if (metric === 'claims' && analyticsData) {
      const aDates = analyticsData.dates || [];
      const aStartIdx = Math.max(0, aDates.length - cutoff);

      if (view === 'protocol') {
        const cp = analyticsData.claimsProtocol || { count: [], usd: [] };
        const rows = aDates.slice(aStartIdx).map((d: string, i: number) => ({
          date: d, 'Claim Count': cp.count[aStartIdx + i] || 0, 'Claim USD': cp.usd[aStartIdx + i] || 0,
        }));
        return { chartData: rows, series: ['Claim USD'], seriesColors: { 'Claim Count': '#facc15', 'Claim USD': '#facc15' } };
      }
      // Platform/Market
      const source = view === 'platform' ? analyticsData.claimsByPlatform : analyticsData.claimsByMarket;
      if (!source) return { chartData: [] as Record<string, any>[], series: [] as string[], seriesColors: {} as Record<string, string> };
      const entries = Object.entries(source as Record<string, { usd: number[] }>)
        .map(([k, v]) => ({ key: k, total: v.usd.reduce((s, x) => s + x, 0) }))
        .filter(e => e.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 8);
      const keys = entries.map(e => e.key);
      const colors: Record<string, string> = {};
      keys.forEach((k, i) => { colors[k] = COLORS[i % COLORS.length]; });
      const rows = aDates.slice(aStartIdx).map((d: string, i: number) => {
        const row: Record<string, any> = { date: d };
        keys.forEach(k => { row[k] = (source[k]?.usd || [])[aStartIdx + i] || 0; });
        return row;
      });
      return { chartData: rows, series: keys, seriesColors: colors };
    }

    // APY view
    if (metric === 'apy') {
      const impliedData = data.impliedApyByMarket || {};
      const underlyingData = data.underlyingApyByMarket || {};
      const activeKeys = Array.from(activeMarketKeys);

      if (apyView === 'current') {
        // Snapshot: horizontal bar chart comparing implied vs underlying
        const entries = activeKeys
          .map(k => {
            const implied = (impliedData[k] || []).slice(-1)[0] || 0;
            const underlying = (underlyingData[k] || []).slice(-1)[0] || 0;
            return { key: k, implied, underlying };
          })
          .filter(e => e.implied > 0 || e.underlying > 0)
          .sort((a, b) => b.implied - a.implied);

        const keys = entries.map(e => e.key);
        const colors: Record<string, string> = {};
        keys.forEach((k, i) => { colors[k] = COLORS[i % COLORS.length]; });

        const rows = entries.map(e => ({ market: e.key, Implied: round2(e.implied * 100), Underlying: round2(e.underlying * 100) }));
        return { chartData: rows, series: keys, seriesColors: colors };
      } else {
        // Historical: line chart of underlying APY over time for active markets
        const entries = activeKeys
          .map(k => {
            const uVals = (underlyingData[k] || []).slice(startIdx);
            const iVals = (impliedData[k] || []).slice(startIdx);
            const hasData = uVals.some(x => x > 0) || iVals.some(x => x > 0);
            return { key: k, uVals, iVals, hasData };
          })
          .filter(e => e.hasData)
          .sort((a, b) => {
            const aLast = a.uVals.findLast(x => x > 0) || a.iVals.findLast(x => x > 0) || 0;
            const bLast = b.uVals.findLast(x => x > 0) || b.iVals.findLast(x => x > 0) || 0;
            return bLast - aLast;
          });

        const keys: string[] = [];
        const colors: Record<string, string> = {};
        entries.forEach((e, i) => {
          const color = COLORS[i % COLORS.length];
          keys.push(e.key);
          colors[e.key] = color;
        });

        const rows = dates.map((d, i) => {
          const row: Record<string, any> = { date: d };
          entries.forEach(e => {
            const uVal = (e.uVals[i] || 0) * 100;
            const iVal = (e.iVals[i] || 0) * 100;
            row[e.key] = hidden.has(e.key) ? 0 : (iVal > 0 ? iVal : uVal);
          });
          return row;
        });
        return { chartData: rows, series: keys, seriesColors: colors };
      }
    }

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
    if (metric === 'apy') return `${v.toFixed(0)}%`;
    if (metric === 'activity') return `${v >= 1000 ? `${(v/1000).toFixed(0)}K` : v}`;
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
            {(['tvl', 'flow', 'volume', 'activity', 'claims', 'apy'] as Metric[]).map(m => (
              <button key={m} onClick={() => { setMetric(m); setHidden(new Set()); }}
                className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                  metric === m ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'
                }`}>
                {m === 'tvl' ? 'TVL' : m === 'flow' ? 'Inflow / Outflow' : m === 'volume' ? 'Volume' : m === 'activity' ? 'Activity' : m === 'claims' ? 'Claims' : 'APY'}
              </button>
            ))}
          </div>
          {metric === 'apy' ? (
            <div className="flex items-center gap-1">
              {(['current', 'history'] as ApyView[]).map(v => (
                <button key={v} onClick={() => { setApyView(v); setHidden(new Set()); }}
                  className={`text-xs px-2.5 py-1 rounded-md transition ${
                    apyView === v ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
                  }`}>
                  {v === 'current' ? 'Current' : 'Historical'}
                </button>
              ))}
            </div>
          ) : metric === 'activity' && view === 'protocol' ? null : (
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
          )}
        </div>
        {(metric !== 'apy' || apyView === 'history') && (
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
        )}
      </div>

      <div className="rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur p-4">
        <ResponsiveContainer width="100%" height={340}>
          {metric === 'apy' && apyView === 'current' ? (
            <BarChart data={chartData} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <XAxis type="number" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                tickFormatter={v => `${v}%`} />
              <YAxis type="category" dataKey="market" width={130}
                tick={{ fill: '#c8caff', fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }}
                formatter={(v: any, name: any) => [`${Number(v).toFixed(2)}%`, name]}
              />
              <Bar dataKey="Implied" fill="#6b66ff" fillOpacity={0.85} barSize={14} radius={[0, 4, 4, 0]} />
              <Bar dataKey="Underlying" fill="#4ade80" fillOpacity={0.6} barSize={14} radius={[0, 4, 4, 0]} />
            </BarChart>
          ) : metric === 'apy' && apyView === 'history' ? (
            <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <XAxis dataKey="date" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                tickFormatter={fmtTick} interval={interval} />
              <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                tickFormatter={v => `${v.toFixed(0)}%`} width={55} />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const dt = new Date(label + 'T00:00:00Z');
                  const dateStr = dt.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
                  const items = payload.filter((p: any) => Number(p.value) > 0).sort((a: any, b: any) => Number(b.value) - Number(a.value));
                  if (!items.length) return null;
                  return (
                    <div style={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}>
                      <div style={{ color: '#fff', fontWeight: 600, marginBottom: 4 }}>{dateStr}</div>
                      {items.map((p: any) => (
                        <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, color: '#ccc' }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color || seriesColors[p.name], display: 'inline-block' }} />
                            {p.name}
                          </span>
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Number(p.value).toFixed(2)}%</span>
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              {series.map((s) => (
                <Line key={s} type="monotone" dataKey={s}
                  stroke={hidden.has(s) ? 'transparent' : seriesColors[s]}
                  strokeWidth={2} dot={false} connectNulls />
              ))}
            </LineChart>
          ) : (
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
                        <div style={{ color: '#4ade80' }}>Inflow: {fmtVal(inf)}</div>
                        <div style={{ color: '#f87171' }}>Outflow: {fmtVal(outf)}</div>
                        <div style={{ color: net >= 0 ? '#4ade80' : '#f87171', borderTop: '1px solid #333', marginTop: 4, paddingTop: 4 }}>
                          Net: {net >= 0 ? '+' : '-'}{fmtVal(Math.abs(net))}
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
                            <span style={{ color: '#4ade80', fontVariantNumeric: 'tabular-nums' }}>+{fmtVal(it.inflow)}</span>
                            <span style={{ color: '#f87171', fontVariantNumeric: 'tabular-nums' }}>-{fmtVal(it.outflow)}</span>
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
                          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{metric === 'apy' ? `${Number(p.value).toFixed(2)}%` : metric === 'activity' ? Number(p.value).toLocaleString() : fmtVal(Number(p.value))}</span>
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
            {/* Activity + Claims bars */}
              {(metric === 'activity' || metric === 'claims') && (
                series.map((k) => (
                  <Bar key={k} dataKey={k} stackId="1" fill={seriesColors[k]} fillOpacity={0.8} />
                ))
              )}
            </BarChart>
          )}
        </ResponsiveContainer>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-3 justify-center items-center">
          {isFlowProtocol && (
            <>
              <span className="flex items-center gap-1 text-[11px]"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400" /> Inflow</span>
              <span className="flex items-center gap-1 text-[11px]"><span className="w-2.5 h-2.5 rounded-full bg-red-400" /> Outflow</span>
            </>
          )}
          {metric === 'apy' && apyView === 'current' && (
            <>
              <span className="flex items-center gap-1 text-[11px]"><span className="w-2.5 h-2.5 rounded" style={{ background: '#6b66ff' }} /> Implied</span>
              <span className="flex items-center gap-1 text-[11px]"><span className="w-2.5 h-2.5 rounded" style={{ background: '#4ade80' }} /> Underlying</span>
            </>
          )}
          {metric === 'apy' && apyView === 'history' && (
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
          {metric === 'tvl' && view !== 'protocol' && (
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
