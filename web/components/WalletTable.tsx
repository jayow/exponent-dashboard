'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { WalletRow, MarketMeta } from '@/lib/types';

type SortKey = 'addr' | 'totalVolume' | 'farmNet' | 'farmBuys' | 'farmSells' | 'farmClaims' | 'lpNet' | 'lpAdds' | 'lpRemoves' | 'txs' | `m:${string}`;

export function WalletTable({ wallets, markets }: { wallets: WalletRow[]; markets: MarketMeta[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('totalVolume');
  const [asc, setAsc] = useState(false);
  const [minVol, setMinVol] = useState(0);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return wallets.filter(w => {
      if (needle && !w.addr.toLowerCase().includes(needle)) return false;
      if (minVol > 0 && w.totalVolume < minVol) return false;
      return true;
    });
  }, [wallets, q, minVol]);

  const sorted = useMemo(() => {
    const getNum = (w: WalletRow): number => {
      switch (sortKey) {
        case 'totalVolume': return w.totalVolume;
        case 'farmNet': return w.farmNet;
        case 'farmBuys': return w.farm.buyYt;
        case 'farmSells': return w.farm.sellYt;
        case 'farmClaims': return w.farm.claimYield;
        case 'lpNet': return w.lpNet;
        case 'lpAdds': return w.lp.addLiq;
        case 'lpRemoves': return w.lp.removeLiq;
        case 'txs': return w.txs;
        default:
          if (sortKey.startsWith('m:')) return w.byMarket[sortKey.slice(2)] || 0;
          return 0;
      }
    };
    const arr = [...filtered];
    if (sortKey === 'addr') arr.sort((a, b) => a.addr.localeCompare(b.addr) * (asc ? 1 : -1));
    else arr.sort((a, b) => (getNum(a) - getNum(b)) * (asc ? 1 : -1));
    return arr;
  }, [filtered, sortKey, asc]);

  const visible = sorted.slice(0, 500);

  function onSort(k: SortKey) {
    if (sortKey === k) setAsc(v => !v);
    else { setSortKey(k); setAsc(false); }
  }
  function arrow(k: SortKey) {
    if (sortKey !== k) return null;
    return <span className="ml-1 text-white/70">{asc ? '↑' : '↓'}</span>;
  }

  return (
    <section className="rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur">
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-eclipse-700/60">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search wallet…"
          className="flex-1 min-w-[240px] bg-eclipse-800/80 border border-eclipse-600/40 focus:border-solar-400 focus:outline-none rounded-md px-3 py-2 text-sm placeholder-eclipse-100/30 font-mono" />
        <label className="flex items-center gap-2 text-xs text-eclipse-100/70">
          min volume $:
          <input type="number" min={0} value={minVol} onChange={e => setMinVol(Number(e.target.value) || 0)}
            className="w-24 bg-eclipse-800/80 border border-eclipse-600/40 rounded-md px-2 py-1 text-sm tabular-nums" />
        </label>
        <div className="text-xs text-eclipse-100/50 ml-auto">
          {sorted.length.toLocaleString()} wallets · showing top {visible.length}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-eclipse-100/50 bg-eclipse-900/60">
            <tr>
              <th className="cell">#</th>
              <th className="th-sortable cell" onClick={() => onSort('addr')}>wallet{arrow('addr')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('farmBuys')}>YT buys{arrow('farmBuys')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('farmSells')}>YT sells{arrow('farmSells')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('farmClaims')}>claims{arrow('farmClaims')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('farmNet')}>YT net{arrow('farmNet')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('lpAdds')}>LP add{arrow('lpAdds')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('lpRemoves')}>LP remove{arrow('lpRemoves')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('totalVolume')}>total vol{arrow('totalVolume')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('txs')}>txs{arrow('txs')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
            {visible.map((w, i) => (
              <tr key={w.addr} onClick={() => router.push(`/wallet/?addr=${w.addr}`)} className="cursor-pointer hover:bg-eclipse-800/40">
                <td className="cell text-eclipse-100/40 tabular-nums">{i + 1}</td>
                <td className="cell">
                  <div className="flex items-center gap-2">
                    <span className="text-solar-300 font-mono text-xs">{w.addr.slice(0, 4)}…{w.addr.slice(-4)}</span>
                    <a onClick={e => e.stopPropagation()} className="text-eclipse-100/30 hover:text-solar-300 text-xs"
                       href={`https://solscan.io/account/${w.addr}`} target="_blank" rel="noopener noreferrer">↗</a>
                  </div>
                </td>
                <td className="cell text-right tabular-nums text-emerald-400/90">{usd(w.farm.buyYt)}</td>
                <td className="cell text-right tabular-nums text-rose-400/90">{usd(w.farm.sellYt)}</td>
                <td className="cell text-right tabular-nums text-solar-400/90">{usd(w.farm.claimYield)}</td>
                <td className="cell text-right tabular-nums text-white font-medium">{net(w.farmNet)}</td>
                <td className="cell text-right tabular-nums text-flare-400">{usd(w.lp.addLiq)}</td>
                <td className="cell text-right tabular-nums text-flare-400/70">{usd(w.lp.removeLiq)}</td>
                <td className="cell text-right tabular-nums">{usd(w.totalVolume)}</td>
                <td className="cell text-right tabular-nums text-eclipse-100/60">{w.txs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function usd(n: number) { return n > 0 ? `$${Math.round(n).toLocaleString()}` : <span className="text-eclipse-100/20">–</span>; }
function net(n: number) { if (Math.abs(n) < 1) return <span className="text-eclipse-100/20">–</span>; return <span className={n > 0 ? 'text-emerald-400' : 'text-rose-400'}>${Math.round(Math.abs(n)).toLocaleString()}</span>; }
