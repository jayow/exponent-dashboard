'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type Market = {
  ticker: string;
  platform: string;
  maturity: string;
  daysLeft: number;
  liquidityUsd: number;
  tvlUsd: number;
  impliedApy: number;
  ytPrice: number;
  ptPrice: number;
  yieldExposure: number;
  pointsName: string | null;
  incomeTvl?: number;
  farmTvl?: number;
  lpTvl?: number;
  idleTvl?: number;
};

type LiveData = {
  generatedAt: string;
  totalLiquidityUsd: number;
  totalTvlUsd: number;
  markets: Market[];
};

type SortKey = 'ticker' | 'platform' | 'tvl' | 'income' | 'farm' | 'lp' | 'idle' | 'apy' | 'ytPrice' | 'ptPrice' | 'leverage' | 'maturity';

export function MarketCards() {
  const router = useRouter();
  const [data, setData] = useState<LiveData | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('tvl');
  const [asc, setAsc] = useState(false);

  useEffect(() => {
    fetch('/markets-live.json').then(r => r.json()).then(setData).catch(() => null);
  }, []);

  const sorted = useMemo(() => {
    if (!data) return [];
    const arr = [...data.markets];
    const getVal = (m: Market): number | string => {
      switch (sortKey) {
        case 'ticker': return m.ticker;
        case 'platform': return normalizePlatform(m.platform, m.ticker);
        case 'tvl': return m.tvlUsd;
        case 'income': return m.incomeTvl || 0;
        case 'farm': return m.farmTvl || 0;
        case 'lp': return m.lpTvl || 0;
        case 'idle': return m.idleTvl || 0;
        case 'apy': return m.impliedApy;
        case 'ytPrice': return m.ytPrice;
        case 'ptPrice': return m.ptPrice;
        case 'leverage': return m.yieldExposure;
        case 'maturity': return m.daysLeft;
      }
    };
    arr.sort((a, b) => {
      const va = getVal(a), vb = getVal(b);
      const cmp = typeof va === 'string' ? (va as string).localeCompare(vb as string) : (va as number) - (vb as number);
      return cmp * (asc ? 1 : -1);
    });
    return arr;
  }, [data, sortKey, asc]);

  function onSort(k: SortKey) {
    if (sortKey === k) setAsc(v => !v);
    else { setSortKey(k); setAsc(k === 'ticker' || k === 'platform'); }
  }
  function arrow(k: SortKey) {
    if (sortKey !== k) return null;
    return <span className="ml-1 text-white/70">{asc ? '↑' : '↓'}</span>;
  }

  if (!data) return <div className="text-white/30 text-sm py-4">Loading…</div>;

  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold text-white mb-3">Markets</h2>
      <div className="rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-white/40 bg-eclipse-900/60">
            <tr>
              <th className="th-sortable cell" onClick={() => onSort('ticker')}>Market{arrow('ticker')}</th>
              <th className="th-sortable cell" onClick={() => onSort('platform')}>Platform{arrow('platform')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('tvl')}>TVL{arrow('tvl')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('income')}>Income{arrow('income')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('farm')}>Farm{arrow('farm')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('lp')}>LP{arrow('lp')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('idle')}>Idle{arrow('idle')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('apy')}>APY{arrow('apy')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('ytPrice')}>YT price{arrow('ytPrice')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('ptPrice')}>PT price{arrow('ptPrice')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('leverage')}>Leverage{arrow('leverage')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('maturity')}>Maturity{arrow('maturity')}</th>
              <th className="cell text-left">Emissions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
            {sorted.map((m, i) => (
              <tr key={`${m.ticker}-${i}`}
                  onClick={() => {
                    const d = new Date(m.maturity + 'T00:00:00Z');
                    const dd = String(d.getUTCDate()).padStart(2, '0');
                    const mmm = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'][d.getUTCMonth()];
                    const yy = String(d.getUTCFullYear()).slice(-2);
                    router.push(`/market/?key=${encodeURIComponent(`${m.ticker}-${dd}${mmm}${yy}`)}`);
                  }}
                  className="cursor-pointer hover:bg-eclipse-800/40"
                  title="Click for on-chain activity">
                <td className="cell font-semibold text-white">{m.ticker}</td>
                <td className="cell text-white/50">{normalizePlatform(m.platform, m.ticker)}</td>
                <td className="cell text-right tabular-nums text-white">{fmtUsd(m.tvlUsd)}</td>
                <td className="cell text-right tabular-nums text-white/60">{fmtUsd(m.incomeTvl || 0)}</td>
                <td className="cell text-right tabular-nums text-white/60">{fmtUsd(m.farmTvl || 0)}</td>
                <td className="cell text-right tabular-nums text-white/60">{fmtUsd(m.lpTvl || 0)}</td>
                <td className="cell text-right tabular-nums text-white/40">{fmtUsd(m.idleTvl || 0)}</td>
                <td className="cell text-right tabular-nums text-emerald-400">{(m.impliedApy * 100).toFixed(2)}%</td>
                <td className="cell text-right tabular-nums text-white/60">{m.ytPrice.toFixed(4)}</td>
                <td className="cell text-right tabular-nums text-white/60">{m.ptPrice.toFixed(4)}</td>
                <td className="cell text-right tabular-nums">{m.yieldExposure.toFixed(0)}×</td>
                <td className="cell text-right tabular-nums text-white/50">
                  <span>{m.maturity}</span>
                  <span className="text-white/30 ml-1">({m.daysLeft}d)</span>
                </td>
                <td className="cell text-white/40 text-xs truncate max-w-[120px]">{m.pointsName || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function normalizePlatform(platform: string, ticker: string): string {
  if (/^Hylo/i.test(platform)) return 'Hylo';
  if (/^frag/i.test(ticker)) return 'Fragmetric';
  return platform;
}

function fmtUsd(n: number) {
  if (!n) return <span className="text-white/15">—</span>;
  if (n > 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n > 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
