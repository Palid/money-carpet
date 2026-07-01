'use client';

import * as React from 'react';

import { useStore, retryGpu } from '@/lib/state';
import {
  CountryCombobox,
  DenomPicker,
  ModeButtons,
  RoomSlider,
} from '@/components/controls';
import { PackingCanvas } from '@/components/canvas/packing-canvas';
import { ResultsPanel } from '@/components/results/results-panel';
import { CurrencyTable } from '@/components/reference/currency-table';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/** Draw denom labels + sheen only when the layout is sparse enough to read. */
const DETAIL_PIECE_LIMIT = 4000;

/**
 * The single-page application grid: a controls bar, the live packing canvas,
 * the results summary, a full currency reference, and the honesty disclosures.
 *
 * All state flows through the vanilla store via `useStore` selectors; the
 * recompute engine (owned by app-shell) reacts to the intent fields these
 * controls mutate.
 */
export function Dashboard() {
  const currencyCode = useStore((s) => s.currencyCode);
  const areaTenths = useStore((s) => s.areaTenths);
  const mode = useStore((s) => s.mode);
  const excludeNonIssued = useStore((s) => s.excludeNonIssued);
  const primaryDenom = useStore((s) => s.primaryDenom);
  const onlyPrimary = useStore((s) => s.onlyPrimary);
  const useImages = useStore((s) => s.useImages);
  const rates = useStore((s) => s.rates);
  const result = useStore((s) => s.result);
  const status = useStore((s) => s.status);
  const errorMessage = useStore((s) => s.errorMessage);

  const setCurrency = useStore((s) => s.setCurrency);
  const setAreaTenths = useStore((s) => s.setAreaTenths);
  const setMode = useStore((s) => s.setMode);
  const setExcludeNonIssued = useStore((s) => s.setExcludeNonIssued);
  const setPrimaryDenom = useStore((s) => s.setPrimaryDenom);
  const setOnlyPrimary = useStore((s) => s.setOnlyPrimary);
  const setUseImages = useStore((s) => s.setUseImages);

  const detail = result ? result.geometry.count <= DETAIL_PIECE_LIMIT : false;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      {/* Controls bar */}
      <section
        aria-label="Packing controls"
        className="flex flex-col gap-5 rounded-lg border border-border bg-card p-5 text-card-foreground"
      >
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:gap-8">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Currency</span>
            <CountryCombobox value={currencyCode} onSelect={setCurrency} />
          </div>
          <DenomPicker
            currencyCode={currencyCode}
            primaryDenom={primaryDenom}
            onlyPrimary={onlyPrimary}
            onPrimaryChange={setPrimaryDenom}
            onOnlyPrimaryChange={setOnlyPrimary}
          />
          <div className="min-w-0 flex-1">
            <RoomSlider areaTenths={areaTenths} onChange={setAreaTenths} />
          </div>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <ModeButtons mode={mode} onModeChange={setMode} />
          <div className="flex flex-col gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={excludeNonIssued}
                onChange={(e) => setExcludeNonIssued(e.target.checked)}
                className="h-4 w-4 cursor-pointer rounded border-input text-primary accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              <span>
                Exclude flagged notes
                <span className="ml-1 text-muted-foreground">
                  (&euro;500, &#8377;2000 &mdash; legal tender, not issued)
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={useImages}
                onChange={(e) => setUseImages(e.target.checked)}
                className="h-4 w-4 cursor-pointer rounded border-input text-primary accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              <span>
                Official currency images
                <span className="ml-1 text-muted-foreground">
                  (US dollar only &mdash; other currencies use color)
                </span>
              </span>
            </label>
          </div>
        </div>
      </section>

      {/* Status banners */}
      {status === 'error' && errorMessage && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <span className="font-medium">Something went wrong. </span>
          {errorMessage}
        </div>
      )}
      {status === 'gpu-lost' && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <span className="font-medium">GPU connection lost. </span>
            The graphics device was reset. Your last result is still shown.
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => retryGpu()}
            className="shrink-0"
          >
            Retry
          </Button>
        </div>
      )}

      {/* Canvas + results */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="relative min-h-[420px] overflow-hidden rounded-lg border border-border bg-card lg:aspect-square lg:min-h-0">
          {result ? (
            <PackingCanvas result={result} detail={detail} useImages={useImages && detail} />
          ) : (
            <div className="flex h-full w-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
              {status === 'loading'
                ? 'Packing the floor…'
                : 'The packed floor will render here.'}
            </div>
          )}
        </div>
        <ResultsPanel
          result={result}
          loading={status === 'loading'}
          fxSnapshotId={rates?.snapshotId}
          fxStale={rates?.stale}
        />
      </div>

      {/* Currency reference */}
      <CurrencyTable />

      {/* Honesty disclosures (P6) */}
      <div className="flex justify-center">
        <Dialog>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              Assumptions &amp; honesty
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Assumptions &amp; honesty</DialogTitle>
              <DialogDescription>
                What these numbers do &mdash; and don&apos;t &mdash; claim.
              </DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col gap-3 text-sm text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">
                  Curated dimensions (&plusmn;0.5&nbsp;mm).
                </span>{' '}
                Banknote and coin sizes are hand-curated from published specs and
                rounded; real pieces vary by roughly half a millimetre.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Heuristic packing, not optimal.
                </span>{' '}
                We rank a best-of-N set of shelf layouts on the GPU and replay the
                winner on the CPU. It is a good layout, not a provably optimal one.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Large rooms are extrapolated.
                </span>{' '}
                Above the 50,000-piece draw cap we pack a representative patch and
                scale its totals up. Those figures are an estimate, not an exact
                count.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Square-room assumption.
                </span>{' '}
                The room is modelled as a perfect square with side&nbsp;=&nbsp;
                &radic;area.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Polygon coins are approximated as circles.
                </span>{' '}
                Non-round coins are packed as circles using their across-corners
                diameter (&#8960;), so they take slightly more room than reality.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Official images &mdash; US dollar only.
                </span>{' '}
                With &ldquo;Official currency images&rdquo; on, US banknotes and
                coins are drawn from public-domain U.S. Government scans
                (Wikimedia Commons); every other currency falls back to flat
                color tiles.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Flagged notes excluded by default.
                </span>{' '}
                The &euro;500 and &#8377;2000 notes are legal tender but no longer
                issued; they are left out unless you enable them with the toggle
                above.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  FX rates &mdash; age &amp; source.
                </span>{' '}
                {rates ? (
                  <>
                    Standardised to PLN using{' '}
                    <span className="text-foreground">
                      {rates.source === 'live' ? 'live' : 'bundled snapshot'}
                    </span>{' '}
                    rates dated{' '}
                    <span className="text-foreground">{rates.date}</span>
                    {rates.stale
                      ? ' (snapshot fallback — upstream unavailable).'
                      : '.'}
                  </>
                ) : (
                  'FX rates are still loading.'
                )}
              </li>
            </ul>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  );
}

export default Dashboard;
