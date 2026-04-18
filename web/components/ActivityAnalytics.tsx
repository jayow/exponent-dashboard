'use client';
import { useEffect, useMemo, useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';

type Analytics = {
  dates: string[];
  holderGrowth: number[];
  dailyActions: Record<string, number[]>;
  dailyClaims: number[];
  retention: { weeks: string[]; new: number[]; returning: number[] };
  claimFrequency: Record<string, number>;
  totalUniqueWallets: number;
  topTraders: any[];
  topClaimers: any[];
  marketActivity: any[];
  stats: Record<string, number>;
};

type View = 'holders' | 'actions' | 'claims' | 'retention' | 'traders' | 'claimers' | 'marketActivity';
type Range = '30d' | '90d' | '1y' | 'all';

const COLORS = [
  '#6b66ff', '#4ade80', '#f87171', '#38bdf8', '#ffb74d',
  '#a78bfa', '#fb923c', '#34d399', '#f472b6', '#facc15',
];

const ACTION_COLORS: Record<string, string> = {
  buyYt: '#4ade80', sellYt: '#f87171', buyPt: '#38bdf8', sellPt: '#fb923c',
  addLiq: '#a78bfa', removeLiq: '#f472b6', claimYield: '#facc15', redeemPt: '#818cf8', strip: '#22d3ee',
};

export function ActivityAnalytics() {
  const [data, setData] = useState<Analytics | null>(null);
  const [view, setView] = useState<View>('holders');
  const [range, setRange] = useState<Range>('all');

  useEffect(() => {
    fetch('/analytics.json').then(r => r.json()).then(setData).catch(() => null);
  }, []);

  const sliced = useMemo(() => {
    if (!data) return { dates: [] as string[], startIdx: 0 };
    const rangeDays: Record<Range, number> = { '30d': 30, '90d': 90, '1y': 365, 'all': data.dates.length };
    const cutoff = rangeDays[range];
    const startIdx = Math.max(0, data.dates.length - cutoff);
    return { dates: data.dates.slice(startIdx), startIdx };
  }, [data, range]);

  if (!data) return null;

  const fmtTick = (d: string) => {
    const dt = new Date(d + 'T00:00:00Z');
    return `${dt.toLocaleString('en', { month: 'short' })} ${String(dt.getUTCFullYear()).slice(-2)}`;
  };
  const interval = Math.max(1, Math.floor(sliced.dates.length / 8));

  const views: { key: View; label: string }[] = [
    { key: 'holders', label: 'Holder Growth' },
    { key: 'actions', label: 'Activity' },
    { key: 'claims', label: 'Claims' },
    { key: 'retention', label: 'Retention' },
    { key: 'traders', label: 'Top Traders' },
    { key: 'claimers', label: 'Top Claimers' },
    { key: 'marketActivity', label: 'Market Activity' },
  ];

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-1 flex-wrap">
          {views.map(v => (
            <button key={v.key} onClick={() => setView(v.key)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                view === v.key ? 'border-white/30 bg-white/10 text-white' : 'border-white/10 text-white/40 hover:text-white'
              }`}>
              {v.label}
            </button>
          ))}
        </div>
        {!['traders', 'claimers', 'marketActivity'].includes(view) && (
          <div className="flex items-center gap-1">
            {(['30d', '90d', '1y', 'all'] as Range[]).map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`text-xs px-2.5 py-1 rounded-md transition ${
                  range === r ? 'bg-white/10 text-white' : 'text-white/30 hover:text-white/60'
                }`}>
                {r === 'all' ? 'All' : r.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-eclipse-700/60 bg-eclipse-900/40 backdrop-blur p-4">
        {/* Holder Growth */}
        {view === 'holders' && (
          <>
            <div className="text-xs text-white/40 mb-2">Cumulative unique wallets: {data.totalUniqueWallets.toLocaleString()}</div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={sliced.dates.map((d, i) => ({ date: d, holders: data.holderGrowth[sliced.startIdx + i] }))}
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <XAxis dataKey="date" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={fmtTick} interval={interval} />
                <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}K` : `${v}`} width={45} />
                <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }}
                  formatter={(v: any) => [Number(v).toLocaleString(), 'Holders']} />
                <Line type="monotone" dataKey="holders" stroke="#6b66ff" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </>
        )}

        {/* Daily Actions */}
        {view === 'actions' && (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={sliced.dates.map((d, i) => {
                const row: Record<string, any> = { date: d };
                Object.entries(data.dailyActions).forEach(([a, vals]) => { row[a] = vals[sliced.startIdx + i] || 0; });
                return row;
              })} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <XAxis dataKey="date" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={fmtTick} interval={interval} />
                <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false} width={45} />
                <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }}
                  formatter={(v: any, name: any) => [Number(v).toLocaleString(), name]} />
                {Object.keys(data.dailyActions).map(a => (
                  <Bar key={a} dataKey={a} stackId="1" fill={ACTION_COLORS[a] || '#666'} fillOpacity={0.8} />
                ))}
              </BarChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 justify-center text-[11px]">
              {Object.keys(data.dailyActions).map(a => (
                <span key={a} className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: ACTION_COLORS[a] || '#666' }} />
                  <span className="text-white/50">{a}</span>
                </span>
              ))}
            </div>
          </>
        )}

        {/* Daily Claims */}
        {view === 'claims' && (
          <>
            <div className="flex items-center gap-6 mb-3 text-sm">
              <span className="text-white/40">Total claims: <span className="text-white">{data.stats.totalClaims?.toLocaleString()}</span></span>
              <span className="text-white/40">Claimers: <span className="text-white">{data.stats.totalClaimers?.toLocaleString()}</span></span>
              <span className="text-white/40">Avg per user: <span className="text-white">{data.stats.avgClaimsPerUser}</span></span>
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={sliced.dates.map((d, i) => ({ date: d, claims: data.dailyClaims[sliced.startIdx + i] || 0 }))}
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <XAxis dataKey="date" tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false}
                  tickFormatter={fmtTick} interval={interval} />
                <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false} width={45} />
                <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }}
                  formatter={(v: any) => [Number(v).toLocaleString(), 'Claims']} />
                <Bar dataKey="claims" fill="#facc15" fillOpacity={0.7} />
              </BarChart>
            </ResponsiveContainer>
            {/* Claim frequency pie */}
            <div className="mt-4 flex items-center justify-center gap-8">
              <div style={{ width: 160, height: 160 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={Object.entries(data.claimFrequency).map(([k, v]) => ({ name: k, value: v }))}
                      dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={35} outerRadius={65} paddingAngle={2} stroke="none">
                      {Object.keys(data.claimFrequency).map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="text-[12px] space-y-1">
                {Object.entries(data.claimFrequency).map(([k, v], i) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
                    <span className="text-white/50 capitalize">{k}</span>
                    <span className="text-white tabular-nums">{v.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* Retention */}
        {view === 'retention' && (
          <>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data.retention.weeks.map((w, i) => ({
                week: w, New: data.retention.new[i], Returning: data.retention.returning[i],
              }))} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                <XAxis dataKey="week" tick={{ fill: '#8888aa', fontSize: 10 }} axisLine={false} tickLine={false}
                  interval={Math.max(1, Math.floor(data.retention.weeks.length / 10))} />
                <YAxis tick={{ fill: '#8888aa', fontSize: 11 }} axisLine={false} tickLine={false} width={45} />
                <Tooltip contentStyle={{ background: '#1a1a1a', border: '1px solid #333', borderRadius: 8, fontSize: 13, color: '#fff' }} />
                <Bar dataKey="New" fill="#4ade80" fillOpacity={0.8} stackId="1" />
                <Bar dataKey="Returning" fill="#6b66ff" fillOpacity={0.8} stackId="1" />
              </BarChart>
            </ResponsiveContainer>
            <div className="flex gap-4 justify-center mt-2 text-[11px]">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-emerald-400" /> New Users</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: '#6b66ff' }} /> Returning</span>
            </div>
          </>
        )}

        {/* Top Traders Table */}
        {view === 'traders' && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-white/40 bg-eclipse-900/60">
                <tr>
                  <th className="cell">#</th>
                  <th className="cell text-left">Wallet</th>
                  <th className="cell text-right">Txns</th>
                  <th className="cell text-right">Buy YT</th>
                  <th className="cell text-right">Sell YT</th>
                  <th className="cell text-right">Buy PT</th>
                  <th className="cell text-right">Sell PT</th>
                  <th className="cell text-right">Add Liq</th>
                  <th className="cell text-right">Claims</th>
                  <th className="cell text-right">Markets</th>
                  <th className="cell text-right">First</th>
                  <th className="cell text-right">Last</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
                {data.topTraders.slice(0, 50).map((t, i) => (
                  <tr key={t.wallet} className="hover:bg-eclipse-800/40">
                    <td className="cell text-white/30 tabular-nums">{i + 1}</td>
                    <td className="cell"><span className="text-xs text-white/70 font-mono">{t.wallet}</span></td>
                    <td className="cell text-right tabular-nums text-white">{t.txs}</td>
                    <td className="cell text-right tabular-nums text-white/50">{t.buyYt || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/50">{t.sellYt || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/50">{t.buyPt || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/50">{t.sellPt || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/50">{t.addLiq || '–'}</td>
                    <td className="cell text-right tabular-nums text-yellow-400/70">{t.claimYield || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/50">{t.markets}</td>
                    <td className="cell text-right tabular-nums text-white/30">{t.firstDate || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/30">{t.lastDate || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Top Claimers */}
        {view === 'claimers' && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-white/40 bg-eclipse-900/60">
                <tr>
                  <th className="cell">#</th>
                  <th className="cell text-left">Wallet</th>
                  <th className="cell text-right">Claims</th>
                  <th className="cell text-right">Markets</th>
                  <th className="cell text-right">First Claim</th>
                  <th className="cell text-right">Last Claim</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
                {data.topClaimers.map((c, i) => (
                  <tr key={c.wallet} className="hover:bg-eclipse-800/40">
                    <td className="cell text-white/30 tabular-nums">{i + 1}</td>
                    <td className="cell"><span className="text-xs text-white/70 font-mono">{c.wallet}</span></td>
                    <td className="cell text-right tabular-nums text-yellow-400">{c.claims}</td>
                    <td className="cell text-right tabular-nums text-white/50">{c.markets}</td>
                    <td className="cell text-right tabular-nums text-white/30">{c.firstClaim || '–'}</td>
                    <td className="cell text-right tabular-nums text-white/30">{c.lastClaim || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Market Activity */}
        {view === 'marketActivity' && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-white/40 bg-eclipse-900/60">
                <tr>
                  <th className="cell text-left">Market</th>
                  <th className="cell text-left">Platform</th>
                  <th className="cell text-right">Txns</th>
                  <th className="cell text-right">Users</th>
                  <th className="cell text-right">Trades</th>
                  <th className="cell text-right">Claims</th>
                  <th className="cell text-right">LP Events</th>
                  <th className="cell text-right">First</th>
                  <th className="cell text-right">Last</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-eclipse-700/40 text-[13px]">
                {data.marketActivity.map(m => (
                  <tr key={m.market} className="hover:bg-eclipse-800/40">
                    <td className="cell font-semibold text-white">{m.market}</td>
                    <td className="cell text-white/50">{m.platform}</td>
                    <td className="cell text-right tabular-nums text-white">{m.txs.toLocaleString()}</td>
                    <td className="cell text-right tabular-nums text-white/60">{m.uniqueUsers.toLocaleString()}</td>
                    <td className="cell text-right tabular-nums text-white/50">{((m.actions.buyYt || 0) + (m.actions.sellYt || 0) + (m.actions.buyPt || 0) + (m.actions.sellPt || 0)).toLocaleString()}</td>
                    <td className="cell text-right tabular-nums text-yellow-400/70">{(m.actions.claimYield || 0).toLocaleString()}</td>
                    <td className="cell text-right tabular-nums text-white/50">{((m.actions.addLiq || 0) + (m.actions.removeLiq || 0)).toLocaleString()}</td>
                    <td className="cell text-right tabular-nums text-white/30">{m.firstDate}</td>
                    <td className="cell text-right tabular-nums text-white/30">{m.lastDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
