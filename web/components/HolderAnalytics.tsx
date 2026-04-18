'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type TopHolder = { wallet: string; totalUsd: number };
type Concentration = { holders: number; top1Pct: number; top5Pct: number; top10Pct: number };
type TvlHistory = {
  topHolders?: TopHolder[];
  holderConcentration?: Record<string, Concentration>;
};

type Tab = 'leaderboard' | 'concentration';

export function HolderAnalytics() {
  const router = useRouter();
  const [data, setData] = useState<TvlHistory | null>(null);
  const [tab, setTab] = useState<Tab>('leaderboard');

  useEffect(() => {
    fetch('/tvl-history.json').then(r => r.json()).then(setData).catch(() => null);
  }, []);

  const holders = data?.topHolders || [];
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
                <th className="cell text-right">Total Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
              {holders.map((h, i) => (
                <tr key={h.wallet}
                    onClick={() => router.push(`/wallet/?addr=${h.wallet}`)}
                    className="cursor-pointer hover:bg-eclipse-800/40">
                  <td className="cell text-white/30 tabular-nums">{i + 1}</td>
                  <td className="cell">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white/70 font-mono">{h.wallet}</span>
                      <a onClick={e => e.stopPropagation()} className="text-white/20 hover:text-white/60 text-xs"
                         href={`https://solscan.io/account/${h.wallet}`} target="_blank" rel="noopener noreferrer">↗</a>
                    </div>
                  </td>
                  <td className="cell text-right tabular-nums text-emerald-400/80">{fmtUsd(h.totalUsd)}</td>
                </tr>
              ))}
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
