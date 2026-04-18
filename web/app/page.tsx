import { TvlOverview } from '@/components/TvlOverview';
import { HistoricalChart } from '@/components/HistoricalChart';
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

      <TvlOverview />
      <HistoricalChart />
      <MarketCards />
    </main>
  );
}
