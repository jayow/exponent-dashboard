'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';

type EnrichedUser = {
  wallet: string; holdingUsd: number; claimUsd: number; txs: number;
  buyYt: number; sellYt: number; buyPt: number; sellPt: number;
  addLiq: number; removeLiq: number; claimYield: number; redeemPt: number;
  markets: number; type: string; firstDate: string | null; lastDate: string | null;
};

type Concentration = { holders: number; top1Pct: number; top5Pct: number; top10Pct: number };

type Analytics = {
  dates: string[];
  holderGrowth: number[];
  retention: { weeks: string[]; new: number[]; returning: number[] };
  enrichedUsers: EnrichedUser[];
};

type TvlHistory = {
  holderConcentration?: Record<string, Concentration>;
};

type View = 'leaderboard' | 'growth' | 'retention' | 'concentration';
type SortKey = 'holdingUsd' | 'claimUsd' | 'txs' | 'markets' | 'firstDate';
type Range = '30d' | '90d' | '1y' | 'all';

export function HolderAnalytics() {
  const router = useRouter();
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [tvlData, setTvlData] = useState<TvlHistory | null>(null);
  const [view, setView] = useState<View>('leaderboard');
  const [sortKey, setSortKey] = useState<SortKey>('holdingUsd');
  const [sortAsc, setSortAsc] = useState(false);
  const [range, setRange] = useState<Range>('all');

  useEffect(() => {
    fetch('/analytics.json').then(r => r.json()).then(setAnalytics).catch(() => null);
    fetch('/tvl-history.json').then(r => r.json()).then(setTvlData).catch(() => null);
  }, []);

  const sortedUsers = useMemo(() => {
    if (!analytics) return [];
    const arr = [...analytics.enrichedUsers];
    arr.sort((a, b) => {
      let va: number, vb: number;
      switch (sortKey) {
        case 'holdingUsd': va = a.holdingUsd; vb = b.holdingUsd; break;
        case 'claimUsd': va = a.claimUsd; vb = b.claimUsd; break;
        case 'txs': va = a.txs; vb = b.txs; break;
        case 'markets': va = a.markets; vb = b.markets; break;
        case 'firstDate':
          va = a.firstDate ? new Date(a.firstDate).getTime() : 9e12;
          vb = b.firstDate ? new Date(b.firstDate).getTime() : 9e12;
          break;
      }
      return (va - vb) * (sortAsc ? 1 : -1);
    });
    return arr;
  }, [analytics, sortKey, sortAsc]);

  const concentration = useMemo(() => {
    if (!tvlData?.holderConcentration) return [];
    const grouped: Record<string, Record<string, Concentration>> = {};
    for (const [key, val] of Object.entries(tvlData.holderConcentration)) {
      const [market, type] = key.split(':');
      if (!grouped[market]) grouped[market] = {};
      grouped[market][type] = val;
    }
    return Object.entries(grouped).sort((a, b) => {
      const aH = Object.values(a[1]).reduce((s, v) => s + v.holders, 0);
      const bH = Object.values(b[1]).reduce((s, v) => s + v.holders, 0);
      return bH - aH;
    });
  }, [tvlData]);

  if (!analytics) return null;

  function onSort(k: SortKey) {
    if (sortKey === k) setSortAsc(v => !v);
    else { setSortKey(k); setSortAsc(k === 'firstDate'); }
  }
  function arrow(k: SortKey) {
    if (sortKey !== k) return null;
    return <span className="ml-1 text-white/70">{sortAsc ? '↑' : '↓'}</span>;
  }

  const sliceData = () => {
    const rangeDays: Record<Range, number> = { '30d': 30, '90d': 90, '1y': 365, 'all': analytics.dates.length };
    const cutoff = rangeDays[range];
    return Math.max(0, analytics.dates.length - cutoff);
  };
  const startIdx = sliceData();
  const dates = analytics.dates.slice(startIdx);
  const fmtTick = (d: string) => { const dt = new Date(d+'T00:00:00Z'); return `${dt.toLocaleString('en',{month:'short'})} ${String(dt.getUTCFullYear()).slice(-2)}`; };
  const interval = Math.max(1, Math.floor(dates.length / 8));

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-1">
          {([
            { key: 'leaderboard', label: 'Leaderboard' },
            { key: 'growth', label: 'Growth' },
            { key: 'retention', label: 'Retention' },
            { key: 'concentration', label: 'Concentration' },
          ] as { key: View; label: string }[]).map(v => (
            <button key={v.key} onClick={() => setView(v.key)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition ${view === v.key ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'}`}>
              {v.label}
            </button>
          ))}
        </div>
        {(view === 'growth' || view === 'retention') && (
          <div className="flex items-center gap-1">
            {(['30d','90d','1y','all'] as Range[]).map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`text-xs px-2.5 py-1 rounded-md transition ${range === r ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'}`}>
                {r === 'all' ? 'All' : r.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur overflow-x-auto">
        {/* Leaderboard */}
        {view === 'leaderboard' && (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-white/40 bg-eclipse-900/60">
              <tr>
                <th className="cell">#</th>
                <th className="cell text-left">Wallet</th>
                <th className="th-sortable cell text-right" onClick={() => onSort('holdingUsd')}>Holdings{arrow('holdingUsd')}</th>
                <th className="th-sortable cell text-right" onClick={() => onSort('claimUsd')}>Claimed{arrow('claimUsd')}</th>
                <th className="th-sortable cell text-right" onClick={() => onSort('txs')}>Txns{arrow('txs')}</th>
                <th className="th-sortable cell text-right" onClick={() => onSort('markets')}>Markets{arrow('markets')}</th>
                <th className="th-sortable cell text-right" onClick={() => onSort('firstDate')}>First{arrow('firstDate')}</th>
                <th className="cell text-right">Last</th>
                <th className="cell">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
              {sortedUsers.map((u, i) => {
                const daysSince = u.lastDate ? Math.round((Date.now() - new Date(u.lastDate).getTime()) / 86400000) : null;
                const isActive = daysSince !== null && daysSince <= 30;
                return (
                  <tr key={u.wallet} onClick={() => router.push(`/wallet/?addr=${u.wallet}`)} className="cursor-pointer hover:bg-eclipse-800/40">
                    <td className="cell text-white/30 tabular-nums">{i + 1}</td>
                    <td className="cell">
                      <div className="flex items-center gap-2">
                        {u.type === 'protocol' && <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-400 shrink-0">POOL</span>}
                        <span className="text-xs text-white/70 font-mono">{u.wallet}</span>
                        <a onClick={e => e.stopPropagation()} className="text-white/20 hover:text-white/60 text-xs"
                           href={`https://solscan.io/account/${u.wallet}`} target="_blank" rel="noopener noreferrer">↗</a>
                      </div>
                    </td>
                    <td className="cell text-right tabular-nums text-emerald-400/80">{fmtUsd(u.holdingUsd)}</td>
                    <td className="cell text-right tabular-nums text-yellow-400/70">{fmtUsd(u.claimUsd)}</td>
                    <td className="cell text-right tabular-nums text-white/50">{u.txs || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/50">{u.markets}</td>
                    <td className="cell text-right tabular-nums text-white/30">{u.firstDate || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/30">{u.lastDate || '–'}</td>
                    <td className="cell">
                      {daysSince !== null ? (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-white/5 text-white/30'}`}>
                          {isActive ? 'Active' : `${daysSince}d ago`}
                        </span>
                      ) : <span className="text-xs text-white/20">–</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* Holder Growth */}
        {view === 'growth' && (
          <div className="p-4">
            <div className="text-xs text-white/40 mb-2">Cumulative unique wallets: {analytics.holderGrowth[analytics.holderGrowth.length - 1]?.toLocaleString()}</div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={dates.map((d, i) => ({ date: d, holders: analytics.holderGrowth[startIdx + i] }))} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <XAxis dataKey="date" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={fmtTick} interval={interval} />
                <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}K` : `${v}`} width={45} />
                <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }}
                  formatter={(v: any) => [Number(v).toLocaleString(), 'Wallets']} />
                <Line type="monotone" dataKey="holders" stroke="#6b66ff" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Retention */}
        {view === 'retention' && (
          <div className="p-4">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={analytics.retention.weeks.map((w, i) => ({ week: w, New: analytics.retention.new[i], Returning: analytics.retention.returning[i] }))}
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <XAxis dataKey="week" tick={{ fill: '#8888aa', fontSize: 10 }} axisLine={false} tickLine={false}
                  interval={Math.max(1, Math.floor(analytics.retention.weeks.length / 10))} />
                <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false} width={45} />
                <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }} />
                <Bar dataKey="New" fill="#4ade80" fillOpacity={0.8} stackId="1" />
                <Bar dataKey="Returning" fill="#6b66ff" fillOpacity={0.8} stackId="1" />
              </BarChart>
            </ResponsiveContainer>
            <div className="flex gap-4 justify-center mt-2 text-[11px]">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400" /> New Users</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#6b66ff' }} /> Returning</span>
            </div>
          </div>
        )}

        {/* Concentration */}
        {view === 'concentration' && (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-white/40 bg-eclipse-900/60">
              <tr>
                <th className="cell text-left">Market</th>
                <th className="cell">Type</th>
                <th className="cell text-right">Holders</th>
                <th className="cell text-right">Top 1</th>
                <th className="cell text-right">Top 5</th>
                <th className="cell text-right">Top 10</th>
                <th className="cell">Distribution</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
              {concentration.map(([market, types]) =>
                Object.entries(types).map(([type, c], j) => (
                  <tr key={`${market}:${type}`}>
                    {j === 0 ? <td className="cell font-semibold text-white" rowSpan={Object.keys(types).length}>{market}</td> : null}
                    <td className="cell text-white/40 uppercase text-xs">{type}</td>
                    <td className="cell text-right tabular-nums text-white/60">{c.holders}</td>
                    <td className="cell text-right tabular-nums text-white/60">{c.top1Pct}%</td>
                    <td className="cell text-right tabular-nums text-white/60">{c.top5Pct}%</td>
                    <td className="cell text-right tabular-nums text-white/60">{c.top10Pct}%</td>
                    <td className="cell">
                      <div className="w-20 h-2 bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${c.top10Pct}%`, background: c.top10Pct > 90 ? '#f87171' : c.top10Pct > 70 ? '#fbbf24' : '#4ade80' }} />
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function fmtUsd(n: number) {
  if (!n) return <span className="text-white/15">–</span>;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
