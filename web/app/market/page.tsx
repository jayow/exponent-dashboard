'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';

type Holder = { owner: string; balance: number; usd?: number };
type Snapshot = { market: string; type: string; holders: number; totalBalance: number; totalUsd: number; top: Holder[] };
type HoldersData = Record<string, Snapshot>;

type Tab = 'pt' | 'yt' | 'lp';

function MarketView() {
  const params = useSearchParams();
  const router = useRouter();
  const key = params.get('key') || '';
  const [liveMarkets, setLiveMarkets] = useState<any>(null);
  const [holders, setHolders] = useState<HoldersData | null>(null);
  const [tab, setTab] = useState<Tab>('pt');
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('/markets-live.json').then(r => r.json()).then(setLiveMarkets).catch(() => null);
    fetch('/holders.json').then(r => r.json()).then(setHolders).catch(() => null);
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

  const ptData = holders?.[`${key}:pt`];
  const ytData = holders?.[`${key}:yt`];
  const lpData = holders?.[`${key}:lp`];
  const current = tab === 'pt' ? ptData : tab === 'yt' ? ytData : lpData;

  if (!liveMarkets) return <div className="mx-auto max-w-[1400px] px-4 py-10 text-white/50">Loading…</div>;

  return (
    <main className="mx-auto max-w-[1400px] px-4 sm:px-6 py-10">
      <Link href="/" className="text-white/40 hover:text-white text-sm">← all markets</Link>

      <div className="mt-4 flex items-baseline gap-4 flex-wrap">
        <h1 className="text-2xl font-semibold text-white">{key}</h1>
        {marketInfo && (
          <span className="text-sm text-white/40">{marketInfo.platform} · matures {marketInfo.maturity}</span>
        )}
      </div>

      {marketInfo && (
        <div className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
          <Stat label="TVL" value={fmtUsd(marketInfo.tvlUsd)} />
          <Stat label="Income (PT)" value={fmtUsd(marketInfo.incomeTvl)} />
          <Stat label="Farm (YT)" value={fmtUsd(marketInfo.farmTvl)} />
          <Stat label="LP" value={fmtUsd(marketInfo.lpTvl)} />
          <Stat label="Idle" value={fmtUsd(marketInfo.idleTvl)} />
          <Stat label="Implied APY" value={`${(marketInfo.impliedApy * 100).toFixed(2)}%`} />
        </div>
      )}

      {/* Tab toggle */}
      <div className="mt-8 flex items-center gap-2 mb-4">
        <button onClick={() => setTab('pt')}
          className={`text-sm px-4 py-2 rounded-lg border transition ${tab === 'pt' ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'}`}>
          PT Holders (Income)
          {ptData && <span className="text-white/30 ml-2">{ptData.holders} · {fmtUsd(ptData.totalUsd)}</span>}
        </button>
        <button onClick={() => setTab('yt')}
          className={`text-sm px-4 py-2 rounded-lg border transition ${tab === 'yt' ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'}`}>
          YT Holders (Farm)
          {ytData && <span className="text-white/30 ml-2">{ytData.holders} · {fmtUsd(ytData.totalUsd)}</span>}
        </button>
        <button onClick={() => setTab('lp')}
          className={`text-sm px-4 py-2 rounded-lg border transition ${tab === 'lp' ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'}`}>
          LP Holders (Liquidity)
          {lpData && <span className="text-white/30 ml-2">{lpData.holders} · {fmtUsd(lpData.totalUsd)}</span>}
        </button>
      </div>

      {/* Search */}
      <div className="mb-3">
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search wallet address…"
          className="w-full max-w-md bg-eclipse-800/80 border border-eclipse-600/40 focus:border-white/30 focus:outline-none rounded-md px-3 py-2 text-sm placeholder-white/20 font-mono"
        />
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
            {!current?.top?.length && (
              <tr><td className="cell text-white/30" colSpan={5}>{holders ? 'No holders found.' : 'Loading...'}</td></tr>
            )}
            {current?.top?.filter((h: Holder) => !search || h.owner.toLowerCase().includes(search.toLowerCase())).map((h: Holder, i: number) => {
              const share = current.totalBalance > 0 ? (h.balance / current.totalBalance * 100) : 0;
              return (
                <tr key={h.owner}
                    onClick={() => router.push(`/wallet/?addr=${h.owner}`)}
                    className="cursor-pointer hover:bg-eclipse-800/40">
                  <td className="cell text-white/30 tabular-nums">{i + 1}</td>
                  <td className="cell">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-white/70">{h.owner}</span>
                      <a onClick={(e) => e.stopPropagation()} className="text-white/20 hover:text-white/60 text-xs"
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
      {current && current.holders > 500 && (
        <div className="text-xs text-white/30 mt-2 text-center">Showing top 500 of {current.holders} holders</div>
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
