import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Money-Room Packing Calculator',
  description:
    'Fills a square room floor with a to-scale single flat layer of real banknotes/coins and reports efficiency, standardized to PLN.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
