'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { TradeEvent } from '@/lib/types';

type Filter = 'buyYt' | 'sellYt' | 'claimYield' | 'addLiq' | 'removeLiq' | 'strip' | 'redeemPt';
const ALL_FILTERS: Filter[] = ['buyYt', 'sellYt', 'claimYield', 'addLiq', 'removeLiq', 'strip', 'redeemPt'];
const LABEL: Record<Filter, string> = { buyYt:'YT buy', sellYt:'YT sell', claimYield:'Claim', addLiq:'LP add', removeLiq:'LP remove', strip:'Strip', redeemPt:'Redeem' };
const COLOR: Record<string, string> = { buyYt:'text-emerald-400', sellYt:'text-rose-400', claimYield:'text-solar-400', addLiq:'text-flare-400', removeLiq:'text-flare-400/70', strip:'text-eclipse-100/70', redeemPt:'text-eclipse-100/70', other:'text-eclipse-100/50' };

type SortKey = 'date' | 'market' | 'action' | 'usd' | 'underlying';

function WalletView() {
  const params = useSearchParams();
  const addr = params.get('addr') || '';
  const [events, setEvents] = useState<TradeEvent[] | null>(null);
  const [enabled, setEnabled] = useState<Set<Filter>>(new Set(ALL_FILTERS));
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [asc, setAsc] = useState(true);

  useEffect(() => {
    if (!addr) { setEvents([]); return; }
    setEvents(null);
    fetch(`/events/${addr}.json`)
      .then(r => r.status === 404 ? [] : r.json())
      .then(setEvents).catch(() => setEvents([]));
  }, [addr]);

  const totals = useMemo(() => {
    const t = { buyYt: 0, sellYt: 0, claimYield: 0, addLiq: 0, removeLiq: 0 };
    for (const e of events || []) {
      const v = Math.abs(e.usdNet || 0);
      if (e.action in t) (t as any)[e.action] += v;
    }
    return t;
  }, [events]);

  const visible = useMemo(() => {
    let arr = (events || []).filter(e => enabled.has(e.action as Filter));
    arr.sort((a, b) => {
      let c = 0;
      if (sortKey === 'date') c = (a.blockTime || 0) - (b.blockTime || 0);
      else if (sortKey === 'market') c = a.market.localeCompare(b.market);
      else if (sortKey === 'action') c = a.action.localeCompare(b.action);
      else if (sortKey === 'usd') c = Math.abs(a.usdNet) - Math.abs(b.usdNet);
      else if (sortKey === 'underlying') c = a.underlyingDelta - b.underlyingDelta;
      return c * (asc ? 1 : -1);
    });
    return arr;
  }, [events, enabled, sortKey, asc]);

  function onSort(k: SortKey) { if (sortKey === k) setAsc(v => !v); else { setSortKey(k); setAsc(k === 'date'); } }
  function arrow(k: SortKey) { return sortKey === k ? <span className="ml-1 text-white/70">{asc ? '↑' : '↓'}</span> : null; }
  function toggle(f: Filter) { setEnabled(prev => { const n = new Set(prev); if (n.has(f)) n.delete(f); else n.add(f); return n; }); }
  const allOn = enabled.size === ALL_FILTERS.length;

  return (
    <main className="mx-auto max-w-[1200px] px-4 sm:px-6 py-10">
      <Link href="/" className="text-solar-300 hover:text-white text-sm">← all wallets</Link>
      <h1 className="mt-4 text-2xl font-semibold text-white">Wallet activity</h1>
      <p className="font-mono text-xs text-eclipse-100/50 break-all mt-1 flex items-center gap-3 flex-wrap">
        <span>{addr}</span>
        {addr && <a href={`https://solscan.io/account/${addr}`} target="_blank" rel="noopener noreferrer" className="text-solar-300 hover:text-white">solscan ↗</a>}
      </p>
      <div className="mt-6 grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
        <Stat label="YT buys" value={`$${Math.round(totals.buyYt).toLocaleString()}`} />
        <Stat label="YT sells" value={`$${Math.round(totals.sellYt).toLocaleString()}`} />
        <Stat label="Claims" value={`$${Math.round(totals.claimYield).toLocaleString()}`} />
        <Stat label="LP deposits" value={`$${Math.round(totals.addLiq).toLocaleString()}`} />
        <Stat label="LP withdrawals" value={`$${Math.round(totals.removeLiq).toLocaleString()}`} />
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button onClick={() => setEnabled(new Set(allOn ? [] : ALL_FILTERS))}
          className={`text-xs px-3 py-1.5 rounded-full border transition ${allOn ? 'border-solar-400 bg-solar-500/10 text-white' : 'border-eclipse-700/60 bg-eclipse-900/40 text-eclipse-100/70'}`}>
          {allOn ? 'All ✓' : `${enabled.size} selected`}
        </button>
        {ALL_FILTERS.map(f => (
          <button key={f} onClick={() => toggle(f)}
            className={`text-xs px-3 py-1.5 rounded-full border transition ${enabled.has(f) ? 'border-solar-400 bg-solar-500/10 text-white' : 'border-eclipse-700/60 bg-eclipse-900/40 text-eclipse-100/50'}`}>
            {LABEL[f]}
          </button>
        ))}
      </div>
      <section className="mt-4 rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-eclipse-100/50 bg-eclipse-900/60">
            <tr>
              <th className="th-sortable cell text-left" onClick={() => onSort('date')}>date{arrow('date')}</th>
              <th className="th-sortable cell text-left" onClick={() => onSort('market')}>market{arrow('market')}</th>
              <th className="th-sortable cell text-left" onClick={() => onSort('action')}>action{arrow('action')}</th>
              <th className="cell text-left">instruction</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('usd')}>USD{arrow('usd')}</th>
              <th className="th-sortable cell text-right" onClick={() => onSort('underlying')}>underlying Δ{arrow('underlying')}</th>
              <th className="cell text-left">tx</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
            {events === null && <tr><td className="cell text-eclipse-100/50" colSpan={7}>Loading…</td></tr>}
            {visible.length === 0 && events !== null && <tr><td className="cell text-eclipse-100/40" colSpan={7}>No events.</td></tr>}
            {visible.map(e => (
              <tr key={e.sig + e.market} className="hover:bg-eclipse-800/40">
                <td className="cell text-eclipse-100/70 font-mono text-xs">{new Date(e.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19)}</td>
                <td className="cell">{e.market}</td>
                <td className="cell"><span className={COLOR[e.action] || COLOR.other}>{e.action}</span></td>
                <td className="cell text-eclipse-100/60 text-xs">{e.instr || '—'}</td>
                <td className="cell text-right tabular-nums">${Math.abs(e.usdNet || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td className="cell text-right tabular-nums text-eclipse-100/70">{e.underlyingDelta.toFixed(4)}</td>
                <td className="cell"><a href={`https://solscan.io/tx/${e.sig}`} target="_blank" rel="noopener noreferrer" className="text-solar-300 hover:text-white">↗</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

export default function WalletPage() {
  return <Suspense fallback={<div className="mx-auto max-w-[1200px] px-4 py-10 text-eclipse-100/50">Loading…</div>}><WalletView /></Suspense>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-eclipse-700/60 bg-eclipse-900/60 backdrop-blur px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-solar-400">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-white tabular-nums">{value}</div>
    </div>
  );
}
