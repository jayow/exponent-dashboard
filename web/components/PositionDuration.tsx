'use client';
import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

type DurationStats = {
  count: number;
  openCount: number;
  avgDays: number;
  medianDays: number;
  p25Days: number;
  p75Days: number;
  minDays: number;
  maxDays: number;
  histogram: { bucket: string; count: number }[];
};

type Data = {
  yt: DurationStats;
  pt: DurationStats;
  lp: DurationStats;
};

const COLORS = {
  yt: '#f59e0b',
  pt: '#22d3ee',
  lp: '#a78bfa',
};

const LABELS = {
  yt: 'Yield Tokens (YT)',
  pt: 'Principal Tokens (PT)',
  lp: 'Liquidity Pool (LP)',
};

export function PositionDuration() {
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    fetch('/analytics.json').then(r => r.json()).then(d => setData(d.positionDuration || null)).catch(() => null);
  }, []);

  if (!data) return <div className="text-white/30 text-sm py-4">Loading…</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {(['yt', 'pt', 'lp'] as const).map(type => {
        const v = data[type];
        if (!v) return null;
        const total = v.count + v.openCount;
        const closedPct = total ? (v.count / total * 100) : 0;
        return (
          <div key={type} className="rounded-lg border border-white/5 bg-[#0f0f0f] p-4">
            <div className="text-white font-medium mb-3" style={{ color: COLORS[type] }}>
              {LABELS[type]}
            </div>
            <div className="grid grid-cols-2 gap-3 text-[11px] mb-4">
              <div>
                <div className="text-white/40">Closed</div>
                <div className="text-white font-medium text-sm">{v.count.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-white/40">Open</div>
                <div className="text-white font-medium text-sm">{v.openCount.toLocaleString()}</div>
              </div>
              <div>
                <div className="text-white/40">Avg held</div>
                <div className="text-white font-medium text-sm">{v.avgDays}d</div>
              </div>
              <div>
                <div className="text-white/40">Median</div>
                <div className="text-white font-medium text-sm">{v.medianDays}d</div>
              </div>
              <div>
                <div className="text-white/40">25th–75th %ile</div>
                <div className="text-white font-medium text-sm">{v.p25Days}–{v.p75Days}d</div>
              </div>
              <div>
                <div className="text-white/40">Max</div>
                <div className="text-white font-medium text-sm">{v.maxDays}d</div>
              </div>
            </div>
            <div className="h-40">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={v.histogram} margin={{ top: 0, right: 0, left: -30, bottom: 0 }}>
                  <XAxis dataKey="bucket" stroke="#666" fontSize={9} tickLine={false} />
                  <YAxis stroke="#666" fontSize={9} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ background: '#0a0a0a', border: '1px solid #333', borderRadius: 4, fontSize: 11 }}
                    itemStyle={{ color: '#fff' }}
                    labelStyle={{ color: '#999' }}
                    formatter={(value: any) => [`${Number(value).toLocaleString()} positions`, '']}
                  />
                  <Bar dataKey="count" fill={COLORS[type]} fillOpacity={0.7} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="text-[10px] text-white/30 mt-2">
              Distribution of days held for {v.count.toLocaleString()} closed positions
            </div>
          </div>
        );
      })}
    </div>
  );
}
