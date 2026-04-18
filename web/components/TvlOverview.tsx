'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie,
} from 'recharts';

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
  categories: string[];
};

type LiveData = {
  generatedAt: string;
  totalLiquidityUsd: number;
  totalTvlUsd: number;
  markets: Market[];
};

const COLORS = [
  '#6b66ff', '#ffb74d', '#4ade80', '#f87171', '#38bdf8',
  '#a78bfa', '#fb923c', '#34d399', '#f472b6', '#facc15',
];

type HistStats = {
  activeMarkets: number;
  expiredMarkets: number;
  platforms: number;
  peakTvl: number;
  peakDate: string;
  totalVolume: number;
  uniqueHolders: number;
  protocolAgeDays: number;
};

export function TvlOverview() {
  const [data, setData] = useState<LiveData | null>(null);
  const [stats, setStats] = useState<HistStats | null>(null);

  useEffect(() => {
    fetch('/markets-live.json').then(r => r.json()).then(setData).catch(() => null);
    fetch('/tvl-history.json').then(r => r.json()).then(d => setStats(d.stats)).catch(() => null);
  }, []);

  const byPlatform = useMemo(() => {
    if (!data) return [];
    // Consolidate related platforms
    const normalize = (platform: string, ticker: string): string => {
      if (/^Hylo/i.test(platform)) return 'Hylo';
      if (/^Jito Restaking/i.test(platform)) return 'Fragmetric';
      if (/^Jito/i.test(platform)) return 'Jito';
      if (/^Drift/i.test(platform)) return 'Drift';
      if (/^Jupiter/i.test(platform)) return 'Jupiter';
      if (/^BULK/i.test(platform)) return 'BULK';
      if (/^frag/i.test(ticker)) return 'Fragmetric';
      return platform;
    };
    const map: Record<string, { platform: string; tvl: number; pool: number; markets: number }> = {};
    for (const m of data.markets) {
      const p = normalize(m.platform, m.ticker);
      if (!map[p]) map[p] = { platform: p, tvl: 0, pool: 0, markets: 0 };
      map[p].tvl += m.tvlUsd;
      map[p].pool += m.liquidityUsd;
      map[p].markets += 1;
    }
    return Object.values(map).sort((a, b) => b.tvl - a.tvl);
  }, [data]);

  if (!data) return <div className="text-eclipse-100/50 text-sm py-8">Loading…</div>;

  const totalTvl = data.totalTvlUsd;
  const totalPool = data.totalLiquidityUsd;

  return (
    <div className="mb-10">
      {/* Headline */}
      {(() => {
        const income = data.markets.reduce((s: number, m: any) => s + (m.incomeTvl || 0), 0);
        const farm = data.markets.reduce((s: number, m: any) => s + (m.farmTvl || 0), 0);
        const lp = data.markets.reduce((s: number, m: any) => s + (m.lpTvl || 0), 0);
        const idle = data.markets.reduce((s: number, m: any) => s + (m.idleTvl || 0), 0);
        return (
          <div className="flex items-end gap-6 mb-6 flex-wrap">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1">Protocol TVL</div>
              <div className="text-5xl font-bold text-white tabular-nums">
                ${(totalTvl / 1e6).toFixed(1)}M
              </div>
            </div>
            <div className="mb-1">
              <div className="text-[10px] text-white/30">Income (PT)</div>
              <div className="text-lg text-white/50 tabular-nums">${(income / 1e6).toFixed(1)}M</div>
            </div>
            <div className="mb-1">
              <div className="text-[10px] text-white/30">Farm (YT)</div>
              <div className="text-lg text-white/50 tabular-nums">${(farm / 1e6).toFixed(1)}M</div>
            </div>
            <div className="mb-1">
              <div className="text-[10px] text-white/30">Liquidity (LP)</div>
              <div className="text-lg text-white/50 tabular-nums">${(lp / 1e6).toFixed(1)}M</div>
            </div>
            <div className="mb-1">
              <div className="text-[10px] text-white/30">Idle</div>
              <div className="text-lg text-white/50 tabular-nums">${(idle / 1e6).toFixed(1)}M</div>
            </div>
            <div className="mb-1">
              <div className="text-[10px] text-white/30">All-Time Volume</div>
              <div className="text-lg text-white/50 tabular-nums">{stats ? fmtCompact(stats.totalVolume) : '–'}</div>
            </div>
            <div className="mb-1">
              <div className="text-[10px] text-white/30">Peak TVL</div>
              <div className="text-lg text-white/50 tabular-nums">{stats ? fmtCompact(stats.peakTvl) : '–'}</div>
            </div>
            <div className="mb-1">
              <div className="text-[10px] text-white/30">Holders</div>
              <div className="text-lg text-white/50 tabular-nums">{stats ? stats.uniqueHolders.toLocaleString() : '–'}</div>
            </div>
            <div className="mb-1">
              <div className="text-[10px] text-white/30">Markets</div>
              <div className="text-lg text-white/50">{stats ? `${stats.activeMarkets} / ${stats.activeMarkets + stats.expiredMarkets}` : data.markets.length}</div>
            </div>
            <div className="mb-1">
              <div className="text-[10px] text-white/30">Platforms</div>
              <div className="text-lg text-white/50">{stats ? stats.platforms : byPlatform.length}</div>
            </div>
            <div className="mb-1">
              <div className="text-[10px] text-white/30">Age</div>
              <div className="text-lg text-white/50">{stats ? `${stats.protocolAgeDays}d` : '–'}</div>
            </div>
          </div>
        );
      })()}

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Bar chart — TVL by platform */}
        <div className="lg:col-span-2 rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur p-4">
          <div className="text-xs uppercase tracking-wider text-eclipse-100/50 mb-3">TVL by Platform</div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={byPlatform} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
              <XAxis type="number" tickFormatter={v => `$${(v/1e6).toFixed(0)}M`}
                tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="platform" width={130}
                tick={{ fill: '#c8caff', fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }}
                labelStyle={{ color: '#fff', fontWeight: 600 }}
                itemStyle={{ color: '#ccc' }}
                formatter={(v: any, name: any) => [`$${(Number(v)/1e6).toFixed(2)}M`, name === 'tvl' ? 'TVL' : 'Pool']}
              />
              <Bar dataKey="tvl" radius={[0, 6, 6, 0]} barSize={24} cursor="default">
                {byPlatform.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Pie chart — TVL share */}
        <div className="rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur p-4">
          <div className="text-xs uppercase tracking-wider text-eclipse-100/50 mb-3">TVL Share</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie
                data={byPlatform}
                dataKey="tvl"
                nameKey="platform"
                cx="50%" cy="50%"
                innerRadius={50} outerRadius={85}
                paddingAngle={2}
                stroke="none"
                label={({ percent }: any) => `${((percent || 0) * 100).toFixed(1)}%`}
                labelLine={false}
              >
                {byPlatform.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }}
                itemStyle={{ color: '#ccc' }}
                formatter={(v: any) => `$${(Number(v)/1e6).toFixed(2)}M`}
              />
            </PieChart>
          </ResponsiveContainer>
          {/* Legend */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 justify-center">
            {byPlatform.map((p, i) => (
              <div key={p.platform} className="flex items-center gap-1 text-[11px]">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                <span className="text-white/50">{p.platform}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtCompact(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}
