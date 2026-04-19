'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';

type Holder = { owner: string; balance: number; usd?: number };
type Snapshot = { market: string; type: string; holders: number; totalBalance: number; totalUsd: number; top: Holder[] };
type HoldersData = Record<string, Snapshot>;
type FlowData = { inflow: number[]; outflow: number[] };

type ChartMetric = 'tvl' | 'flow' | 'volume' | 'apy';
type HolderTab = 'pt' | 'yt' | 'lp';
type Range = '30d' | '90d' | '1y' | 'all';

function MarketView() {
  const params = useSearchParams();
  const router = useRouter();
  const key = params.get('key') || '';

  const [liveMarkets, setLiveMarkets] = useState<any>(null);
  const [holders, setHolders] = useState<HoldersData | null>(null);
  const [histData, setHistData] = useState<any>(null);
  const [chartMetric, setChartMetric] = useState<ChartMetric>('tvl');
  const [holderTab, setHolderTab] = useState<HolderTab>('pt');
  const [range, setRange] = useState<Range>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('/markets-live.json').then(r => r.json()).then(setLiveMarkets).catch(() => null);
    fetch('/holders.json').then(r => r.json()).then(setHolders).catch(() => null);
    fetch('/tvl-history.json').then(r => r.json()).then(setHistData).catch(() => null);
  }, []);

  const marketInfo = useMemo(() => {
    if (!liveMarkets) return null;
    return liveMarkets.markets?.find((m: any) => {
      const d = new Date(m.maturity + 'T00:00:00Z');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      const mmm = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()];
      const yy = String(d.getUTCFullYear()).slice(-2);
      return `${m.ticker}-${dd}${mmm}${yy}` === key;
    });
  }, [liveMarkets, key]);

  const chartData = useMemo((): Record<string, any>[] => {
    if (!histData) return [];
    const dates: string[] = histData.dates || [];
    const rangeDays: Record<Range, number> = { '30d': 30, '90d': 90, '1y': 365, 'all': dates.length };
    const cutoff = rangeDays[range];
    const startIdx = Math.max(0, dates.length - cutoff);
    const slicedDates = dates.slice(startIdx);

    if (chartMetric === 'tvl') {
      const tvl = (histData.byMarket?.[key] || []).slice(startIdx);
      return slicedDates.map((d: string, i: number) => ({ date: d, TVL: tvl[i] || 0 }));
    }
    if (chartMetric === 'flow') {
      const flow: FlowData = histData.flowByMarket?.[key] || { inflow: [], outflow: [] };
      return slicedDates.map((d: string, i: number) => {
        const idx = startIdx + i;
        return { date: d, Inflow: flow.inflow[idx] || 0, Outflow: -(flow.outflow[idx] || 0) };
      });
    }
    if (chartMetric === 'volume') {
      const flow: FlowData = histData.flowByMarket?.[key] || { inflow: [], outflow: [] };
      return slicedDates.map((d: string, i: number) => {
        const idx = startIdx + i;
        return { date: d, Volume: (flow.inflow[idx] || 0) + (flow.outflow[idx] || 0) };
      });
    }
    if (chartMetric === 'apy') {
      const underlying = (histData.underlyingApyByMarket?.[key] || []).slice(startIdx);
      const implied = (histData.impliedApyByMarket?.[key] || []).slice(startIdx);
      return slicedDates.map((d: string, i: number) => ({
        date: d,
        Underlying: (underlying[i] || 0) * 100,
        Implied: (implied[i] || 0) * 100,
      }));
    }
    return [];
  }, [histData, key, chartMetric, range]);

  const ptData = holders?.[`${key}:pt`];
  const ytData = holders?.[`${key}:yt`];
  const lpData = holders?.[`${key}:lp`];
  const currentHolders = holderTab === 'pt' ? ptData : holderTab === 'yt' ? ytData : lpData;

  if (!liveMarkets) return <div className="mx-auto max-w-[1400px] px-4 py-10 text-white/50">Loading…</div>;

  const fmtTick = (d: string) => {
    const dt = new Date(d + 'T00:00:00Z');
    return `${dt.toLocaleString('en', { month: 'short' })} ${String(dt.getUTCFullYear()).slice(-2)}`;
  };
  const fmtAxis = (v: number) => {
    if (chartMetric === 'apy') return `${v.toFixed(0)}%`;
    const abs = Math.abs(v);
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v}`;
  };
  const interval = Math.max(1, Math.floor(chartData.length / 8));
  const meta = histData?.marketMeta?.[key];

  return (
    <main className="mx-auto max-w-[1400px] px-4 sm:px-6 py-10">
      <button onClick={() => router.back()} className="text-white/40 hover:text-white text-sm">← back</button>

      <div className="mt-4 flex items-baseline gap-4 flex-wrap">
        <h1 className="text-2xl font-semibold text-white">{key}</h1>
        {marketInfo && (
          <span className="text-sm text-white/40">{marketInfo.platform} · matures {marketInfo.maturity}</span>
        )}
        {!marketInfo && meta && (
          <span className="text-sm text-white/40">{meta.platform} · matured {meta.maturityDate} · <span className="text-white/20">expired</span></span>
        )}
      </div>

      {/* Stats row */}
      {marketInfo && (
        <div className="mt-6 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 text-sm">
          <Stat label="TVL" value={fmtUsd(marketInfo.tvlUsd)} />
          <Stat label="Income (PT)" value={fmtUsd(marketInfo.incomeTvl)} />
          <Stat label="Farm (YT)" value={fmtUsd(marketInfo.farmTvl)} />
          <Stat label="LP" value={fmtUsd(marketInfo.lpTvl)} />
          <Stat label="Implied APY" value={`${(marketInfo.impliedApy * 100).toFixed(2)}%`} />
          <Stat label="Underlying APY" value={marketInfo.underlyingApy ? `${(marketInfo.underlyingApy * 100).toFixed(2)}%` : '–'} />
          <Stat label="YT Price" value={marketInfo.ytPrice.toFixed(4)} />
          <Stat label="PT Price" value={marketInfo.ptPrice.toFixed(4)} />
        </div>
      )}
      {!marketInfo && meta && (
        <div className="mt-6 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <Stat label="Peak TVL" value={fmtUsd(meta.peakTvl)} />
          <Stat label="Status" value="Expired" />
          <Stat label="Maturity" value={meta.maturityDate} />
        </div>
      )}

      {/* Per-market chart */}
      <div className="mt-8 mb-8">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-1">
            {(['tvl', 'flow', 'volume', 'apy'] as ChartMetric[]).map(m => (
              <button key={m} onClick={() => setChartMetric(m)}
                className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                  chartMetric === m ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'
                }`}>
                {m === 'tvl' ? 'TVL' : m === 'flow' ? 'Inflow / Outflow' : m === 'volume' ? 'Volume' : 'APY'}
              </button>
            ))}
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
          <ResponsiveContainer width="100%" height={300}>
            {chartMetric === 'apy' ? (
              <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <XAxis dataKey="date" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={fmtTick} interval={interval} />
                <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={fmtAxis} width={55} />
                <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }}
                  formatter={(v: any, name: any) => [`${Number(v).toFixed(2)}%`, name]} />
                <Line type="monotone" dataKey="Implied" stroke="#6b66ff" strokeWidth={2} dot={false} connectNulls />
                <Line type="monotone" dataKey="Underlying" stroke="#4ade80" strokeWidth={1.5} dot={false} connectNulls />
              </LineChart>
            ) : chartMetric === 'flow' ? (
              <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }} stackOffset="sign">
                <XAxis dataKey="date" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={fmtTick} interval={interval} />
                <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={fmtAxis} width={55} />
                <ReferenceLine y={0} stroke="#333" />
                <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }}
                  formatter={(v: any, name: any) => [`$${(Math.abs(Number(v)) / 1e6).toFixed(2)}M`, name]} />
                <Bar dataKey="Inflow" fill="#4ade80" fillOpacity={0.7} stackId="s" />
                <Bar dataKey="Outflow" fill="#f87171" fillOpacity={0.7} stackId="s" />
              </BarChart>
            ) : (
              <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <XAxis dataKey="date" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={fmtTick} interval={interval} />
                <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={fmtAxis} width={55} />
                <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }}
                  formatter={(v: any, name: any) => [`$${(Number(v) / 1e6).toFixed(2)}M`, name]} />
                <Bar dataKey={chartMetric === 'tvl' ? 'TVL' : 'Volume'}
                  fill={chartMetric === 'tvl' ? '#6b66ff' : '#38bdf8'} fillOpacity={0.8} />
              </BarChart>
            )}
          </ResponsiveContainer>
          {chartMetric === 'flow' && (
            <div className="flex gap-4 justify-center mt-2 text-[11px]">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400" /> Inflow</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-400" /> Outflow</span>
            </div>
          )}
          {chartMetric === 'apy' && (
            <div className="flex gap-4 justify-center mt-2 text-[11px]">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#6b66ff' }} /> Implied</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#4ade80' }} /> Underlying</span>
            </div>
          )}
        </div>
      </div>

      {/* Holder tabs */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button onClick={() => setHolderTab('pt')}
          className={`text-sm px-4 py-2 rounded-lg border transition ${holderTab === 'pt' ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'}`}>
          PT Holders
          {ptData && <span className="text-white/30 ml-2">{ptData.holders} · {fmtUsd(ptData.totalUsd)}</span>}
        </button>
        <button onClick={() => setHolderTab('yt')}
          className={`text-sm px-4 py-2 rounded-lg border transition ${holderTab === 'yt' ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'}`}>
          YT Holders
          {ytData && <span className="text-white/30 ml-2">{ytData.holders} · {fmtUsd(ytData.totalUsd)}</span>}
        </button>
        <button onClick={() => setHolderTab('lp')}
          className={`text-sm px-4 py-2 rounded-lg border transition ${holderTab === 'lp' ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'}`}>
          LP Holders
          {lpData && <span className="text-white/30 ml-2">{lpData.holders} · {fmtUsd(lpData.totalUsd)}</span>}
        </button>
      </div>

      {/* Search */}
      <div className="mb-3">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search wallet address…"
          className="w-full max-w-md bg-eclipse-800/80 border border-eclipse-600/40 focus:border-white/30 focus:outline-none rounded-md px-3 py-2 text-sm placeholder-white/20 font-mono" />
      </div>

      {/* Holders table */}
      <div className="rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-white/40 bg-eclipse-900/60">
            <tr>
              <th className="cell">#</th>
              <th className="cell text-left">Wallet</th>
              <th className="cell text-right">Balance</th>
              <th className="cell text-right">Value</th>
              <th className="cell text-right">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
            {!currentHolders?.top?.length && (
              <tr><td className="cell text-white/30" colSpan={5}>{holders ? 'No holders found.' : 'Loading...'}</td></tr>
            )}
            {currentHolders?.top?.filter((h: Holder) => !search || h.owner.toLowerCase().includes(search.toLowerCase())).map((h: Holder, i: number) => {
              const share = currentHolders.totalBalance > 0 ? (h.balance / currentHolders.totalBalance * 100) : 0;
              return (
                <tr key={h.owner} onClick={() => router.push(`/wallet/?addr=${h.owner}`)}
                    className="cursor-pointer hover:bg-eclipse-800/40">
                  <td className="cell text-white/30 tabular-nums">{i + 1}</td>
                  <td className="cell">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white/70 font-mono">{h.owner}</span>
                      <a onClick={e => e.stopPropagation()} className="text-white/20 hover:text-white/60 text-xs"
                         href={`https://solscan.io/account/${h.owner}`} target="_blank" rel="noopener noreferrer">↗</a>
                    </div>
                  </td>
                  <td className="cell text-right tabular-nums text-white">
                    {h.balance > 1e6 ? `${(h.balance/1e6).toFixed(2)}M` : h.balance > 1e3 ? `${(h.balance/1e3).toFixed(1)}K` : h.balance.toFixed(2)}
                  </td>
                  <td className="cell text-right tabular-nums text-emerald-400/80">
                    {(h.usd || 0) > 0 ? fmtUsd(h.usd || 0) : '–'}
                  </td>
                  <td className="cell text-right tabular-nums text-white/50">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${Math.min(share, 100)}%` }} />
                      </div>
                      <span>{share.toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {currentHolders && currentHolders.holders > 500 && (
        <div className="text-xs text-white/30 mt-2 text-center">Showing top 500 of {currentHolders.holders} holders</div>
      )}
    </main>
  );
}

export default function MarketPage() {
  return <Suspense fallback={<div className="mx-auto max-w-[1400px] px-4 py-10 text-white/50">Loading…</div>}><MarketView /></Suspense>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-eclipse-700/60 bg-eclipse-900/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-white tabular-nums">{value}</div>
    </div>
  );
}

function fmtUsd(n: number) {
  if (!n) return '–';
  if (n > 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n > 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
