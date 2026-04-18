'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type TopHolder = { wallet: string; totalUsd: number; markets?: number; firstTxn?: string; lastTxn?: string; txCount?: number; type?: string };
type Concentration = { holders: number; top1Pct: number; top5Pct: number; top10Pct: number };
type TvlHistory = {
  topHolders?: TopHolder[];
  holderConcentration?: Record<string, Concentration>;
};

type Tab = 'leaderboard' | 'concentration';
type HolderSort = 'value' | 'markets' | 'txns' | 'firstTxn';

export function HolderAnalytics() {
  const router = useRouter();
  const [data, setData] = useState<TvlHistory | null>(null);
  const [tab, setTab] = useState<Tab>('leaderboard');
  const [holderSort, setHolderSort] = useState<HolderSort>('value');
  const [holderAsc, setHolderAsc] = useState(false);

  useEffect(() => {
    fetch('/tvl-history.json').then(r => r.json()).then(setData).catch(() => null);
  }, []);

  const rawHolders = data?.topHolders || [];

  const holders = useMemo(() => {
    const arr = [...rawHolders];
    arr.sort((a, b) => {
      let va: number, vb: number;
      switch (holderSort) {
        case 'value': va = a.totalUsd; vb = b.totalUsd; break;
        case 'markets': va = a.markets || 0; vb = b.markets || 0; break;
        case 'txns': va = a.txCount || 0; vb = b.txCount || 0; break;
        case 'firstTxn':
          va = a.firstTxn ? new Date(a.firstTxn).getTime() : 9999999999999;
          vb = b.firstTxn ? new Date(b.firstTxn).getTime() : 9999999999999;
          break;
      }
      return (va - vb) * (holderAsc ? 1 : -1);
    });
    return arr;
  }, [rawHolders, holderSort, holderAsc]);

  function onHolderSort(k: HolderSort) {
    if (holderSort === k) setHolderAsc(v => !v);
    else { setHolderSort(k); setHolderAsc(k === 'firstTxn'); }
  }
  function hArrow(k: HolderSort) {
    if (holderSort !== k) return null;
    return <span className="ml-1 text-white/70">{holderAsc ? '↑' : '↓'}</span>;
  }
  const concentration = data?.holderConcentration || {};

  const markets = useMemo(() => {
    const grouped: Record<string, Record<string, Concentration>> = {};
    for (const [key, val] of Object.entries(concentration)) {
      const [market, type] = key.split(':');
      if (!grouped[market]) grouped[market] = {};
      grouped[market][type] = val;
    }
    return Object.entries(grouped).sort((a, b) => {
      const aH = Object.values(a[1]).reduce((s, v) => s + v.holders, 0);
      const bH = Object.values(b[1]).reduce((s, v) => s + v.holders, 0);
      return bH - aH;
    });
  }, [concentration]);

  if (!data) return null;

  return (
    <div className="mb-8">
      <div className="flex items-center gap-2 mb-4">
        {(['leaderboard', 'concentration'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition ${
              tab === t ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'
            }`}>
            {t === 'leaderboard' ? 'Top Holders' : 'Concentration'}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur overflow-x-auto">
        {tab === 'leaderboard' ? (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-white/40 bg-eclipse-900/60">
              <tr>
                <th className="cell">#</th>
                <th className="cell text-left">Wallet</th>
                <th className="th-sortable cell text-right" onClick={() => onHolderSort('value')}>Total Value{hArrow('value')}</th>
                <th className="th-sortable cell text-right" onClick={() => onHolderSort('markets')}>Markets{hArrow('markets')}</th>
                <th className="th-sortable cell text-right" onClick={() => onHolderSort('txns')}>Txns{hArrow('txns')}</th>
                <th className="th-sortable cell text-right" onClick={() => onHolderSort('firstTxn')}>First Txn{hArrow('firstTxn')}</th>
                <th className="cell text-right">Last Txn</th>
                <th className="cell">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
              {holders.map((h, i) => {
                const daysSinceLast = h.lastTxn ? Math.round((Date.now() - new Date(h.lastTxn + 'T00:00:00Z').getTime()) / 86400000) : null;
                const isActive = daysSinceLast !== null && daysSinceLast <= 30;
                return (
                  <tr key={h.wallet}
                      onClick={() => router.push(`/wallet/?addr=${h.wallet}`)}
                      className="cursor-pointer hover:bg-eclipse-800/40">
                    <td className="cell text-white/30 tabular-nums">{i + 1}</td>
                    <td className="cell">
                      <div className="flex items-center gap-2">
                        {h.type === 'protocol' && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-400 shrink-0">POOL</span>
                        )}
                        <span className="text-xs text-white/70 font-mono">{h.wallet}</span>
                        <a onClick={e => e.stopPropagation()} className="text-white/20 hover:text-white/60 text-xs"
                           href={`https://solscan.io/account/${h.wallet}`} target="_blank" rel="noopener noreferrer">↗</a>
                      </div>
                    </td>
                    <td className="cell text-right tabular-nums text-emerald-400/80">{fmtUsd(h.totalUsd)}</td>
                    <td className="cell text-right tabular-nums text-white/50">{h.markets || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/50">{h.txCount || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/40">{h.firstTxn || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/40">{h.lastTxn || '–'}</td>
                    <td className="cell">
                      {daysSinceLast !== null ? (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-white/5 text-white/30'}`}>
                          {isActive ? 'Active' : `${daysSinceLast}d ago`}
                        </span>
                      ) : (
                        <span className="text-xs text-white/20">–</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
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
              {markets.map(([market, types]) =>
                Object.entries(types).map(([type, c], j) => (
                  <tr key={`${market}:${type}`} className={j > 0 ? '' : ''}>
                    {j === 0 ? (
                      <td className="cell font-semibold text-white" rowSpan={Object.keys(types).length}>{market}</td>
                    ) : null}
                    <td className="cell text-white/40 uppercase text-xs">{type}</td>
                    <td className="cell text-right tabular-nums text-white/60">{c.holders}</td>
                    <td className="cell text-right tabular-nums text-white/60">{c.top1Pct}%</td>
                    <td className="cell text-right tabular-nums text-white/60">{c.top5Pct}%</td>
                    <td className="cell text-right tabular-nums text-white/60">{c.top10Pct}%</td>
                    <td className="cell">
                      <div className="flex items-center gap-1">
                        <div className="w-20 h-2 bg-white/10 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{
                            width: `${c.top10Pct}%`,
                            background: c.top10Pct > 90 ? '#f87171' : c.top10Pct > 70 ? '#fbbf24' : '#4ade80',
                          }} />
                        </div>
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
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
