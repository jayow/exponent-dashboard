'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';

type EnrichedUser = {
  wallet: string; holdingUsd: number; claimUsd: number; unclaimedUsd: number; txs: number;
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

type View = 'leaderboard' | 'cohorts' | 'growth' | 'retention' | 'concentration' | 'whales';
type SortKey = 'holdingUsd' | 'claimUsd' | 'unclaimedUsd' | 'txs' | 'markets' | 'firstDate';
type Range = '30d' | '90d' | '1y' | 'all';

export function HolderAnalytics() {
  const router = useRouter();
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [tvlData, setTvlData] = useState<TvlHistory | null>(null);
  const [view, setView] = useState<View>('leaderboard');
  const [sortKey, setSortKey] = useState<SortKey>('holdingUsd');
  const [sortAsc, setSortAsc] = useState(false);
  const [range, setRange] = useState<Range>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => {
    fetch('/analytics.json').then(r => r.json()).then(setAnalytics).catch(() => null);
    fetch('/tvl-history.json').then(r => r.json()).then(setTvlData).catch(() => null);
  }, []);

  const sortedUsers = useMemo(() => {
    if (!analytics) return [];
    let arr = [...analytics.enrichedUsers];
    if (search) {
      const q = search.toLowerCase();
      arr = arr.filter(u => u.wallet.toLowerCase().includes(q));
    }
    arr.sort((a, b) => {
      let va: number, vb: number;
      switch (sortKey) {
        case 'holdingUsd': va = a.holdingUsd; vb = b.holdingUsd; break;
        case 'claimUsd': va = a.claimUsd; vb = b.claimUsd; break;
        case 'unclaimedUsd': va = a.unclaimedUsd || 0; vb = b.unclaimedUsd || 0; break;
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
  }, [analytics, sortKey, sortAsc, search]);

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
    setPage(0);
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
            { key: 'leaderboard', label: 'Users' },
            { key: 'cohorts', label: 'Cohorts' },
            { key: 'whales', label: 'Whale Activity' },
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
        {/* Users */}
        {view === 'leaderboard' && (
          <div className="p-3 border-b border-eclipse-700/40">
            <input value={search} onChange={e => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search wallet address…"
              className="w-full max-w-md bg-eclipse-800/80 border border-eclipse-600/40 focus:border-white/30 focus:outline-none rounded-md px-3 py-2 text-sm placeholder-white/20 font-mono" />
          </div>
        )}
        {view === 'leaderboard' && (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-white/40 bg-eclipse-900/60">
              <tr>
                <th className="cell">#</th>
                <th className="cell text-left">Wallet</th>
                <th className="th-sortable cell text-right" onClick={() => onSort('holdingUsd')} title="Current value of all PT/YT/LP positions in active markets">Active Holdings{arrow('holdingUsd')}</th>
                <th className="th-sortable cell text-right" onClick={() => onSort('claimUsd')} title="Total yield claimed across all markets (active + expired)">Claimed{arrow('claimUsd')}</th>
                <th className="th-sortable cell text-right" onClick={() => onSort('unclaimedUsd')} title="YT positions where yield has never been collected">Unclaimed{arrow('unclaimedUsd')}</th>
                <th className="th-sortable cell text-right" onClick={() => onSort('txs')} title="Total on-chain transactions with Exponent">Txns{arrow('txs')}</th>
                <th className="th-sortable cell text-right" onClick={() => onSort('markets')} title="Number of distinct markets participated in (active + expired)">Markets{arrow('markets')}</th>
                <th className="th-sortable cell text-right" onClick={() => onSort('firstDate')} title="Date of first Exponent transaction">First{arrow('firstDate')}</th>
                <th className="cell text-right" title="Date of most recent Exponent transaction">Last</th>
                <th className="cell" title="Active = last txn within 30 days">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
              {sortedUsers.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((u, i) => {
                const rank = page * PAGE_SIZE + i;
                const daysSince = u.lastDate ? Math.round((Date.now() - new Date(u.lastDate).getTime()) / 86400000) : null;
                const isActive = daysSince !== null && daysSince <= 30;
                return (
                  <tr key={u.wallet} onClick={() => router.push(`/wallet/?addr=${u.wallet}`)} className="cursor-pointer hover:bg-eclipse-800/40">
                    <td className="cell text-white/30 tabular-nums">{rank + 1}</td>
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
                    <td className="cell text-right tabular-nums text-rose-400/70">{u.unclaimedUsd > 0 ? fmtUsd(u.unclaimedUsd) : <span className="text-white/15">–</span>}</td>
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

        {/* Pagination */}
        {view === 'leaderboard' && sortedUsers.length > PAGE_SIZE && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-eclipse-700/40">
            <span className="text-xs text-white/30">
              {search ? `${sortedUsers.length.toLocaleString()} results` : `${sortedUsers.length.toLocaleString()} users`}
              {' · '}Page {page + 1} of {Math.ceil(sortedUsers.length / PAGE_SIZE)}
            </span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(0)} disabled={page === 0}
                className="text-xs px-2 py-1 rounded border border-white/10 text-white/40 hover:text-white disabled:opacity-20 disabled:cursor-default">First</button>
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
                className="text-xs px-2 py-1 rounded border border-white/10 text-white/40 hover:text-white disabled:opacity-20 disabled:cursor-default">Prev</button>
              <button onClick={() => setPage(p => Math.min(Math.ceil(sortedUsers.length / PAGE_SIZE) - 1, p + 1))} disabled={(page + 1) * PAGE_SIZE >= sortedUsers.length}
                className="text-xs px-2 py-1 rounded border border-white/10 text-white/40 hover:text-white disabled:opacity-20 disabled:cursor-default">Next</button>
              <button onClick={() => setPage(Math.ceil(sortedUsers.length / PAGE_SIZE) - 1)} disabled={(page + 1) * PAGE_SIZE >= sortedUsers.length}
                className="text-xs px-2 py-1 rounded border border-white/10 text-white/40 hover:text-white disabled:opacity-20 disabled:cursor-default">Last</button>
            </div>
          </div>
        )}

        {/* Cohorts */}
        {view === 'cohorts' && (() => {
          const users = analytics?.enrichedUsers || [];
          const activeUsers = users.filter(u => u.holdingUsd > 0);
          const cohorts = [
            { label: 'Whale', min: 100000, color: '#6b66ff' },
            { label: 'Large', min: 10000, color: '#38bdf8' },
            { label: 'Medium', min: 1000, color: '#4ade80' },
            { label: 'Small', min: 100, color: '#ffb74d' },
            { label: 'Micro', min: 0, color: '#f87171' },
          ];
          const cohortData = cohorts.map((c, idx) => {
            const max = idx === 0 ? Infinity : cohorts[idx - 1].min;
            const members = activeUsers.filter(u => u.holdingUsd >= c.min && u.holdingUsd < max);
            const totalHoldings = members.reduce((s, u) => s + u.holdingUsd, 0);
            const totalClaimed = members.reduce((s, u) => s + u.claimUsd, 0);
            const avgTxs = members.length > 0 ? Math.round(members.reduce((s, u) => s + u.txs, 0) / members.length) : 0;
            const avgMarkets = members.length > 0 ? (members.reduce((s, u) => s + u.markets, 0) / members.length).toFixed(1) : '0';
            const trades = members.reduce((s, u) => s + u.buyYt + u.sellYt + u.buyPt + u.sellPt, 0);
            const avgTradeSize = trades > 0 ? totalHoldings / trades : 0;
            const activePct = members.length > 0
              ? Math.round(members.filter(u => u.lastDate && (Date.now() - new Date(u.lastDate).getTime()) / 86400000 <= 30).length / members.length * 100)
              : 0;
            return { ...c, max, count: members.length, totalHoldings, totalClaimed, avgTxs, avgMarkets, trades, avgTradeSize, activePct };
          });
          const totalActive = activeUsers.length;
          const totalHoldings = activeUsers.reduce((s, u) => s + u.holdingUsd, 0);

          return (
            <div className="p-4">
              <div className="text-xs text-white/40 mb-4">
                {totalActive.toLocaleString()} users with active positions · {fmtUsd(totalHoldings)} total
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-white/40">
                  <tr>
                    <th className="cell text-left">Cohort</th>
                    <th className="cell text-left">Range</th>
                    <th className="cell text-right">Users</th>
                    <th className="cell text-right">% of Users</th>
                    <th className="cell text-right">Total Holdings</th>
                    <th className="cell text-right">% of TVL</th>
                    <th className="cell text-right">Total Claimed</th>
                    <th className="cell text-right">Trades</th>
                    <th className="cell text-right">Avg Trade</th>
                    <th className="cell text-right">Avg Txns</th>
                    <th className="cell text-right">Avg Markets</th>
                    <th className="cell text-right">Active (30d)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
                  {cohortData.map(c => (
                    <tr key={c.label}>
                      <td className="cell font-semibold" style={{ color: c.color }}>{c.label}</td>
                      <td className="cell text-white/40">
                        {c.max === Infinity ? `>$${(c.min/1000).toFixed(0)}K` : `$${c.min >= 1000 ? `${(c.min/1000).toFixed(0)}K` : c.min} – $${(c.max/1000).toFixed(0)}K`}
                      </td>
                      <td className="cell text-right tabular-nums text-white">{c.count.toLocaleString()}</td>
                      <td className="cell text-right tabular-nums text-white/50">{totalActive > 0 ? (c.count / totalActive * 100).toFixed(1) : 0}%</td>
                      <td className="cell text-right tabular-nums text-emerald-400/80">{fmtUsd(c.totalHoldings)}</td>
                      <td className="cell text-right tabular-nums text-white/50">{totalHoldings > 0 ? (c.totalHoldings / totalHoldings * 100).toFixed(1) : 0}%</td>
                      <td className="cell text-right tabular-nums text-yellow-400/70">{fmtUsd(c.totalClaimed)}</td>
                      <td className="cell text-right tabular-nums text-white/50">{c.trades.toLocaleString()}</td>
                      <td className="cell text-right tabular-nums text-white/50">{c.avgTradeSize > 0 ? fmtUsd(c.avgTradeSize) : '–'}</td>
                      <td className="cell text-right tabular-nums text-white/50">{c.avgTxs}</td>
                      <td className="cell text-right tabular-nums text-white/50">{c.avgMarkets}</td>
                      <td className="cell text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="w-12 h-1.5 bg-white/10 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${c.activePct}%` }} />
                          </div>
                          <span className="tabular-nums text-white/50">{c.activePct}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })()}

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
                  interval={Math.max(1, Math.floor(analytics.retention.weeks.length / 10))}
                  tickFormatter={d => { const dt = new Date(d + 'T00:00:00Z'); return `${dt.toLocaleString('en', { month: 'short' })} ${dt.getUTCDate()}`; }} />
                <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false} width={45} />
                <Tooltip
                  contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }}
                  labelFormatter={d => {
                    const mon = new Date(d + 'T00:00:00Z');
                    const sun = new Date(mon.getTime() + 6 * 86400000);
                    return `Week of ${mon.toLocaleDateString('en', { month: 'short', day: 'numeric' })} – ${sun.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}`;
                  }} />
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

        {/* Whale Activity */}
        {view === 'whales' && (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-white/40 bg-eclipse-900/60">
              <tr>
                <th className="cell">#</th>
                <th className="cell text-left">Date</th>
                <th className="cell text-left">Wallet</th>
                <th className="cell text-left">Market</th>
                <th className="cell text-left">Action</th>
                <th className="cell text-right">USD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
              {(analytics as any)?.whaleEvents?.map((w: any, i: number) => (
                <tr key={i} className="hover:bg-eclipse-800/40">
                  <td className="cell text-white/30 tabular-nums">{i + 1}</td>
                  <td className="cell text-white/50">{w.date}</td>
                  <td className="cell text-xs text-white/70 font-mono">{w.wallet}</td>
                  <td className="cell text-white/60">{w.market}</td>
                  <td className="cell text-white/50">{w.action}</td>
                  <td className="cell text-right tabular-nums text-emerald-400/80">{fmtUsd(w.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      </div>
    </div>
  );
}

function fmtUsd(n: number) {
  if (!n) return <span className="text-white/15">–</span>;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
