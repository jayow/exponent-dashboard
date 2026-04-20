'use client';
import { useEffect, useState } from 'react';

type RolloverStat = {
  expiredUsers: number;
  rolledOver: number;
  rolloverPct: number;
  markets: number;
};

export function MarketRollover() {
  const [data, setData] = useState<Record<string, RolloverStat> | null>(null);

  useEffect(() => {
    fetch('/analytics.json').then(r => r.json()).then(d => setData(d.rolloverByTicker || {})).catch(() => null);
  }, []);

  if (!data) return <div className="text-white/30 text-sm py-4">Loading…</div>;

  const entries = Object.entries(data)
    .filter(([_, v]) => v.expiredUsers >= 50)
    .sort((a, b) => b[1].expiredUsers - a[1].expiredUsers);

  const totalExpired = entries.reduce((s, [_, v]) => s + v.expiredUsers, 0);
  const totalRolled = entries.reduce((s, [_, v]) => s + v.rolledOver, 0);
  const overallPct = totalExpired ? (totalRolled / totalExpired * 100) : 0;

  return (
    <div className="rounded-lg border border-white/5 bg-[#0f0f0f] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-white font-medium">Market Rollover</div>
        <div className="text-[11px] text-white/50">
          {totalRolled.toLocaleString()} / {totalExpired.toLocaleString()} rolled over ({overallPct.toFixed(1)}%)
        </div>
      </div>
      <div className="text-[10px] text-white/30 mb-3">
        % of wallets that opened a position in an expired market and later opened one in a newer market with the same underlying
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-white/40 border-b border-white/10">
            <th className="text-left pb-2 pr-3">Underlying</th>
            <th className="text-right pb-2 pr-3">Expired wallets</th>
            <th className="text-right pb-2 pr-3">Rolled over</th>
            <th className="text-right pb-2 pr-3">Rollover %</th>
            <th className="text-right pb-2">Markets</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([ticker, v]) => (
            <tr key={ticker} className="border-b border-white/5 hover:bg-white/5">
              <td className="py-2 pr-3 text-white">{ticker}</td>
              <td className="py-2 pr-3 text-right text-white/70">{v.expiredUsers.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right text-white/70">{v.rolledOver.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right">
                <span
                  className={`font-medium ${
                    v.rolloverPct >= 10 ? 'text-emerald-400' :
                    v.rolloverPct >= 5 ? 'text-amber-400' : 'text-red-400'
                  }`}>
                  {v.rolloverPct.toFixed(1)}%
                </span>
              </td>
              <td className="py-2 text-right text-white/50">{v.markets}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
