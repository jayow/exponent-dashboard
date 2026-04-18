'use client';
import { useEffect, useMemo, useState } from 'react';

type LifecycleEntry = {
  key: string;
  platform: string;
  status: string;
  maturityDate: string;
  firstTvlDate: string | null;
  peakTvl: number;
};

function normalizePlatform(p: string): string {
  if (/^Hylo/i.test(p)) return 'Hylo';
  if (/^Drift/i.test(p)) return 'Drift';
  if (/^Jupiter/i.test(p)) return 'Jupiter';
  if (/^Jito Restaking/i.test(p)) return 'Fragmetric';
  if (/^Jito/i.test(p)) return 'Jito';
  if (/^BULK/i.test(p)) return 'BULK';
  return p || 'Other';
}

const PLATFORM_COLORS: Record<string, string> = {
  'Solstice': '#6b66ff', 'Fragmetric': '#4ade80', 'Hylo': '#38bdf8', 'BULK': '#ffb74d',
  'OnRe': '#f87171', 'Jupiter': '#a78bfa', 'Kyros': '#fb923c', 'marginfi': '#34d399',
  'Kamino': '#f472b6', 'Carrot': '#facc15', 'Drift': '#818cf8', 'Meteora': '#fbbf24',
  'Sanctum': '#22d3ee', 'Adrena': '#e879f9', 'Stablecoins': '#a3e635', 'Jito': '#38bdf8',
  'Solv': '#4ade80', 'ORE': '#fb923c',
};

export function MarketLifecycle() {
  const [data, setData] = useState<LifecycleEntry[] | null>(null);
  const [showExpired, setShowExpired] = useState(true);

  useEffect(() => {
    fetch('/tvl-history.json')
      .then(r => r.json())
      .then(d => setData(d.lifecycle || []))
      .catch(() => null);
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    return data
      .filter(m => m.firstTvlDate && m.peakTvl > 0)
      .filter(m => showExpired || m.status === 'active');
  }, [data, showExpired]);

  const byPlatform = useMemo(() => {
    if (!filtered.length) return [];
    const groups: Record<string, LifecycleEntry[]> = {};
    for (const m of filtered) {
      const p = normalizePlatform(m.platform);
      if (!groups[p]) groups[p] = [];
      groups[p].push(m);
    }
    return Object.entries(groups).sort((a, b) => {
      const aMax = Math.max(...a[1].map(m => m.peakTvl));
      const bMax = Math.max(...b[1].map(m => m.peakTvl));
      return bMax - aMax;
    });
  }, [filtered]);

  if (!data || !filtered.length) return null;

  const allDates = filtered.flatMap(m => [m.firstTvlDate!, m.maturityDate]).filter(Boolean);
  const minDate = new Date(allDates.sort()[0] + 'T00:00:00Z').getTime();
  const maxDate = new Date(allDates.sort().pop()! + 'T00:00:00Z').getTime();
  const totalSpan = maxDate - minDate;

  const toPercent = (dateStr: string) => {
    const t = new Date(dateStr + 'T00:00:00Z').getTime();
    return ((t - minDate) / totalSpan) * 100;
  };

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Market Lifecycle</h2>
        <button onClick={() => setShowExpired(v => !v)}
          className={`text-xs px-2.5 py-1 rounded-md border transition ${
            !showExpired ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/30 hover:text-white/60'
          }`}>
          Active Only
        </button>
      </div>

      <div className="rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur p-4 overflow-x-auto">
        {/* Time axis */}
        <div className="relative h-6 mb-2 text-[10px] text-white/30">
          {['2025-01', '2025-04', '2025-07', '2025-10', '2026-01', '2026-04'].map(d => {
            const pct = toPercent(d + '-01');
            if (pct < 0 || pct > 100) return null;
            return <span key={d} className="absolute" style={{ left: `${pct}%` }}>{d}</span>;
          })}
        </div>

        {/* Bars by platform */}
        {byPlatform.map(([platform, markets]) => (
          <div key={platform} className="mb-3">
            <div className="text-[11px] text-white/40 mb-1">{platform}</div>
            {markets.map(m => {
              const start = toPercent(m.firstTvlDate!);
              const end = toPercent(m.maturityDate);
              const width = Math.max(0.5, end - start);
              const color = PLATFORM_COLORS[normalizePlatform(m.platform)] || '#666';
              const isActive = m.status === 'active';
              return (
                <div key={m.key} className="relative h-5 mb-0.5" title={`${m.key}: ${m.firstTvlDate} → ${m.maturityDate} (peak $${(m.peakTvl/1e6).toFixed(1)}M)`}>
                  <div
                    className="absolute h-full rounded-sm transition-opacity hover:opacity-100"
                    style={{
                      left: `${start}%`,
                      width: `${width}%`,
                      background: color,
                      opacity: isActive ? 0.8 : 0.3,
                    }}
                  />
                  <span className="absolute text-[9px] text-white/60 truncate pointer-events-none"
                    style={{ left: `${start + 0.5}%`, top: 2, maxWidth: `${width - 1}%` }}>
                    {m.key.split('-')[0]}
                  </span>
                </div>
              );
            })}
          </div>
        ))}

        {/* Today marker */}
        <div className="relative h-0">
          <div className="absolute top-0 bottom-0 w-px bg-white/30"
            style={{ left: `${toPercent(new Date().toISOString().slice(0, 10))}%`, height: '100%', position: 'absolute', top: '-100%' }}>
          </div>
        </div>
      </div>
    </div>
  );
}
