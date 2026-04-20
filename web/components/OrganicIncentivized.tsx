'use client';
import { useEffect, useState } from 'react';

type OISummary = {
  incentivizedMarkets: string[];
  organicMarkets: string[];
  incentivizedClaims: number;
  organicClaims: number;
  incentivizedTrades: number;
  organicTrades: number;
};

export function OrganicIncentivized() {
  const [data, setData] = useState<OISummary | null>(null);
  const [emissions, setEmissions] = useState<Record<string, number>>({});

  useEffect(() => {
    fetch('/analytics.json').then(r => r.json()).then(d => {
      setData(d.organicIncentivized || null);
      setEmissions(d.emissionsByMarket || {});
    }).catch(() => null);
  }, []);

  if (!data) return <div className="text-white/30 text-sm py-4">Loading…</div>;

  const totalClaims = data.incentivizedClaims + data.organicClaims;
  const totalTrades = data.incentivizedTrades + data.organicTrades;
  const totalMarkets = data.incentivizedMarkets.length + data.organicMarkets.length;

  const claimsIncPct = totalClaims ? data.incentivizedClaims / totalClaims * 100 : 0;
  const tradesIncPct = totalTrades ? data.incentivizedTrades / totalTrades * 100 : 0;
  const marketsIncPct = totalMarkets ? data.incentivizedMarkets.length / totalMarkets * 100 : 0;

  return (
    <div className="rounded-lg border border-white/5 bg-[#0f0f0f] p-4">
      <div className="text-white font-medium mb-1">Organic vs Incentivized Activity</div>
      <div className="text-[10px] text-white/30 mb-4">
        Incentivized = markets where users received external emission tokens (non-underlying/PT/SY). Organic = markets where yield comes purely from the underlying asset.
      </div>
      <div className="grid grid-cols-3 gap-4 mb-5">
        <Stat label="Markets" incPct={marketsIncPct}
          incLabel={`${data.incentivizedMarkets.length}`}
          orgLabel={`${data.organicMarkets.length}`} />
        <Stat label="Claim events" incPct={claimsIncPct}
          incLabel={data.incentivizedClaims.toLocaleString()}
          orgLabel={data.organicClaims.toLocaleString()} />
        <Stat label="Trades" incPct={tradesIncPct}
          incLabel={data.incentivizedTrades.toLocaleString()}
          orgLabel={data.organicTrades.toLocaleString()} />
      </div>
      <details className="text-[11px]">
        <summary className="cursor-pointer text-white/50 hover:text-white/80">
          Incentivized markets ({data.incentivizedMarkets.length}) — click to expand
        </summary>
        <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 pl-3">
          {data.incentivizedMarkets.map(mk => (
            <div key={mk} className="flex items-center justify-between text-white/60">
              <span>{mk}</span>
              <span className="text-white/30 tabular-nums">{(emissions[mk] || 0).toLocaleString()} ev</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function Stat({ label, incPct, incLabel, orgLabel }: { label: string; incPct: number; incLabel: string; orgLabel: string }) {
  return (
    <div>
      <div className="text-[11px] text-white/40 mb-1">{label}</div>
      <div className="h-2 bg-white/5 rounded-full overflow-hidden mb-2 flex">
        <div className="bg-amber-400/70" style={{ width: `${incPct}%` }} />
        <div className="bg-emerald-400/70" style={{ width: `${100 - incPct}%` }} />
      </div>
      <div className="flex justify-between text-[10px]">
        <div>
          <span className="text-amber-400">● </span>
          <span className="text-white">{incLabel}</span>
          <span className="text-white/40"> incentivized ({incPct.toFixed(0)}%)</span>
        </div>
        <div>
          <span className="text-emerald-400">● </span>
          <span className="text-white">{orgLabel}</span>
          <span className="text-white/40"> organic</span>
        </div>
      </div>
    </div>
  );
}
