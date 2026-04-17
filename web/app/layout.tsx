import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Exponent · Dashboard',
  description: 'On-chain activity across all Exponent yield markets.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0a0a0a] text-white/80">{children}</body>
    </html>
  );
}
