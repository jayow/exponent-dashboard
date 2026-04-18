'use client';
import { useEffect, useState } from 'react';

type Stats = {
  activeMarkets: number;
  expiredMarkets: number;
  totalMarkets: number;
  platforms: number;
  peakTvl: number;
  peakDate: string;
  currentTvl: number;
  totalVolume: number;
  uniqueHolders: number;
  firstDate: string;
  protocolAgeDays: number;
};

export function ProtocolStats() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch('/tvl-history.json')
      .then(r => r.json())
      .then(d => setStats(d.stats))
      .catch(() => null);
  }, []);

  if (!stats) return null;

  const items = [
    { label: 'Protocol Age', value: `${stats.protocolAgeDays}d`, sub: `since ${stats.firstDate}` },
    { label: 'All-Time Volume', value: fmtUsd(stats.totalVolume) },
    { label: 'Peak TVL', value: fmtUsd(stats.peakTvl), sub: stats.peakDate },
    { label: 'Unique Holders', value: stats.uniqueHolders.toLocaleString() },
    { label: 'Markets', value: `${stats.activeMarkets}`, sub: `${stats.expiredMarkets} expired` },
    { label: 'Platforms', value: `${stats.platforms}` },
  ];

  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-6">
      {items.map(item => (
        <div key={item.label} className="rounded-xl border border-eclipse-700/60 bg-eclipse-900/50 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-white/30">{item.label}</div>
          <div className="mt-0.5 text-base font-semibold text-white tabular-nums">{item.value}</div>
          {item.sub && <div className="text-[10px] text-white/20">{item.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function fmtUsd(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
