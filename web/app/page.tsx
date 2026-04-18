import { TvlOverview } from '@/components/TvlOverview';
import { TvlChart } from '@/components/TvlChart';
import { MarketCards } from '@/components/MarketCards';

export default function HomePage() {
  return (
    <main className="mx-auto max-w-[1500px] px-4 sm:px-6 py-10">
      <header className="relative mb-8">
        <div className="flex items-center gap-3">
          <a href="https://app.exponent.finance" target="_blank" rel="noopener noreferrer" className="shrink-0">
            <img src="/logos/v2-logo.svg" alt="Exponent" className="h-7" />
          </a>
          <span className="text-[11px] text-white/30 border-l border-white/10 pl-3">
            by <a href="https://hanyon.app" target="_blank" rel="noopener noreferrer" className="text-white/50 hover:text-white transition">Hanyon Analytics</a>
          </span>
        </div>
      </header>

      {/* Protocol overview — TVL headline + platform breakdown charts */}
      <TvlOverview />

      {/* Historical TVL chart — protocol / by platform / by market */}
      <TvlChart />

      {/* Per-market table — click to drill into on-chain activity */}
      <MarketCards />

      <footer className="mt-10 text-center text-xs text-white/20">
        Market data fetched live from Exponent API · On-chain activity indexed via Helius.
      </footer>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-eclipse-700/60 bg-eclipse-900/60 backdrop-blur px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-solar-400">{label}</div>
      <div className="mt-0.5 text-base font-semibold text-white tabular-nums">{value}</div>
    </div>
  );
}
