import { ClientApp } from '@/components/client-app';

/**
 * RSC shell. The heading/intro render on the server; the interactive,
 * browser-only app is mounted client-side via <ClientApp/> (which lazy-loads
 * the shell with `ssr: false`).
 */
export default function Page() {
  return (
    <>
      <header className="mx-auto w-full max-w-7xl px-4 pt-8 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Money-Room Packing Calculator
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Fill a square room&apos;s floor with a single, to-scale flat layer of
          real banknotes and coins, then see how much money that is &mdash;
          standardised to PLN. Pick a currency, room size, and packing goal.
        </p>
      </header>
      <ClientApp />
    </>
  );
}
