'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';

type TokenChange = { symbol: string; delta: number; usd: number };
type WalletEvent = {
  sig: string;
  blockTime: number;
  market: string;
  action: string;
  instr: string;
  changes?: TokenChange[];
  usd?: number;
};

type Filter = 'buyYt' | 'sellYt' | 'claimYield' | 'addLiq' | 'removeLiq' | 'strip' | 'redeemPt' | 'buyPt' | 'sellPt';
const ALL_FILTERS: Filter[] = ['buyYt', 'sellYt', 'buyPt', 'sellPt', 'claimYield', 'addLiq', 'removeLiq', 'strip', 'redeemPt'];
const LABEL: Record<string, string> = {
  buyYt:'Buy YT', sellYt:'Sell YT', buyPt:'Buy PT', sellPt:'Sell PT',
  claimYield:'Claim Yield', addLiq:'Add Liquidity', removeLiq:'Remove Liquidity',
  strip:'Strip', redeemPt:'Redeem PT',
};
const COLOR: Record<string, string> = {
  buyYt:'text-emerald-400', sellYt:'text-rose-400', buyPt:'text-sky-400', sellPt:'text-orange-400',
  claimYield:'text-yellow-400', addLiq:'text-purple-400', removeLiq:'text-purple-400/70',
  strip:'text-white/50', redeemPt:'text-white/50',
};

type SortKey = 'date' | 'market' | 'action' | 'usd';

function WalletView() {
  const params = useSearchParams();
  const router = useRouter();
  const addr = params.get('addr') || '';
  const [events, setEvents] = useState<WalletEvent[] | null>(null);
  const [enabled, setEnabled] = useState<Set<Filter>>(new Set(ALL_FILTERS));
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [asc, setAsc] = useState(false);

  useEffect(() => {
    if (!addr) { setEvents([]); return; }
    setEvents(null);
    fetch(`/events/${addr}.json`)
      .then(r => r.status === 404 ? [] : r.json())
      .then(setEvents).catch(() => setEvents([]));
  }, [addr]);

  const actionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of events || []) {
      if (e.action) counts[e.action] = (counts[e.action] || 0) + 1;
    }
    return counts;
  }, [events]);

  const visible = useMemo(() => {
    let arr = (events || []).filter(e => e.action && enabled.has(e.action as Filter));
    arr.sort((a, b) => {
      let c = 0;
      if (sortKey === 'date') c = (a.blockTime || 0) - (b.blockTime || 0);
      else if (sortKey === 'market') c = (a.market || '').localeCompare(b.market || '');
      else if (sortKey === 'action') c = (a.action || '').localeCompare(b.action || '');
      else if (sortKey === 'usd') c = (a.usd || 0) - (b.usd || 0);
      return c * (asc ? 1 : -1);
    });
    return arr;
  }, [events, enabled, sortKey, asc]);

  function onSort(k: SortKey) { if (sortKey === k) setAsc(v => !v); else { setSortKey(k); setAsc(k === 'date'); } }
  function arrow(k: SortKey) { return sortKey === k ? <span className="ml-1 text-white/70">{asc ? '↑' : '↓'}</span> : null; }
  function toggle(f: Filter) { setEnabled(prev => { const n = new Set(prev); if (n.has(f)) n.delete(f); else n.add(f); return n; }); }
  const allOn = enabled.size === ALL_FILTERS.length;

  const totalEvents = (events || []).filter(e => e.action).length;
  const markets = new Set((events || []).map(e => e.market).filter(Boolean));

  return (
    <main className="mx-auto max-w-[1400px] px-4 sm:px-6 py-10">
      <button onClick={() => router.back()} className="text-white/40 hover:text-white text-sm">← back</button>
      <h1 className="mt-4 text-2xl font-semibold text-white">Wallet Activity</h1>
      <p className="font-mono text-xs text-white/50 break-all mt-1 flex items-center gap-3 flex-wrap">
        <span>{addr}</span>
        {addr && <a href={`https://solscan.io/account/${addr}`} target="_blank" rel="noopener noreferrer" className="text-white/40 hover:text-white">solscan ↗</a>}
      </p>

      {/* Summary stats */}
      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 text-sm">
        <Stat label="Total Txns" value={`${totalEvents}`} />
        <Stat label="Markets" value={`${markets.size}`} />
        {ALL_FILTERS.map(f => actionCounts[f] ? (
          <Stat key={f} label={LABEL[f]} value={`${actionCounts[f]}`} />
        ) : null)}
      </div>

      {/* Filter chips */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button onClick={() => setEnabled(new Set(allOn ? [] : ALL_FILTERS))}
          className={`text-xs px-3 py-1.5 rounded-lg border transition ${allOn ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40'}`}>
          {allOn ? 'All' : `${enabled.size} selected`}
        </button>
        {ALL_FILTERS.map(f => (
          <button key={f} onClick={() => toggle(f)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition ${enabled.has(f) ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40'}`}>
            {LABEL[f]} {actionCounts[f] ? `(${actionCounts[f]})` : ''}
          </button>
        ))}
      </div>

      {/* Events table */}
      <section className="mt-4 rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-white/40 bg-eclipse-900/60">
            <tr>
              <th className="th-sortable cell text-left" onClick={() => onSort('date')}>Date{arrow('date')}</th>
              <th className="th-sortable cell text-left" onClick={() => onSort('market')}>Market{arrow('market')}</th>
              <th className="th-sortable cell text-left" onClick={() => onSort('action')}>Action{arrow('action')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('usd')}>USD{arrow('usd')}</th>
              <th className="cell text-left">Token Changes</th>
              <th className="cell">Tx</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
            {events === null && <tr><td className="cell text-white/30" colSpan={6}>Loading…</td></tr>}
            {visible.length === 0 && events !== null && <tr><td className="cell text-white/30" colSpan={6}>No events found.</td></tr>}
            {visible.map((e, i) => (
              <tr key={`${e.sig}-${i}`} className="hover:bg-eclipse-800/40">
                <td className="cell text-white/50 font-mono text-xs whitespace-nowrap">
                  {new Date(e.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19)}
                </td>
                <td className="cell text-white/70">{e.market || '–'}</td>
                <td className="cell"><span className={COLOR[e.action] || 'text-white/50'}>{LABEL[e.action] || e.action}</span></td>
                <td className="cell text-right tabular-nums text-white/60">
                  {e.usd ? fmtUsdVal(e.usd) : '–'}
                </td>
                <td className="cell text-xs tabular-nums">
                  {e.changes?.length ? (
                    <div className="flex flex-col gap-0.5">
                      {e.changes.map((c, j) => (
                        <span key={j} className={c.delta > 0 ? 'text-emerald-400/70' : 'text-rose-400/70'}>
                          {c.delta > 0 ? '+' : ''}{fmtAmount(c.delta)} <span className="text-white/40">{c.symbol}</span>
                          {c.usd != null && c.usd > 0.01 ? <span className="text-white/20 ml-1">(${fmtCompact(c.usd)})</span> : null}
                        </span>
                      ))}
                    </div>
                  ) : '–'}
                </td>
                <td className="cell">
                  <a href={`https://solscan.io/tx/${e.sig}`} target="_blank" rel="noopener noreferrer" className="text-white/30 hover:text-white">↗</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {visible.length > 0 && (
        <div className="text-xs text-white/30 mt-2 text-center">
          Showing {visible.length} of {totalEvents} events
        </div>
      )}
    </main>
  );
}

export default function WalletPage() {
  return <Suspense fallback={<div className="mx-auto max-w-[1400px] px-4 py-10 text-white/50">Loading…</div>}><WalletView /></Suspense>;
}

function fmtUsdVal(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toFixed(2)}`;
}

function fmtCompact(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

function fmtAmount(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (abs >= 1) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toFixed(4);
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-eclipse-700/60 bg-eclipse-900/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-white tabular-nums">{value}</div>
    </div>
  );
}
