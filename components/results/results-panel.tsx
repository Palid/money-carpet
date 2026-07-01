'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import type { PackResult } from '@/lib/packer/types';

export interface ResultsPanelProps {
  result: PackResult | null;
  loading: boolean;
  fxSnapshotId?: string;
  fxStale?: boolean;
}

const plnFormatter = new Intl.NumberFormat('pl-PL', {
  style: 'currency',
  currency: 'PLN',
  maximumFractionDigits: 0,
});

const integerFormatter = new Intl.NumberFormat('en-US');

const oneDecimalFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const rhoFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 2,
});

function formatMajor(valueMinor: number, minorDigits: number, code: string) {
  const major = valueMinor / 10 ** minorDigits;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: minorDigits,
      maximumFractionDigits: minorDigits,
    }).format(major);
  } catch {
    return `${major.toFixed(minorDigits)} ${code}`;
  }
}

function SkeletonBlock({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded-md bg-muted', className)} />
  );
}

/**
 * Presentational summary dashboard for a completed (or in-flight) pack run.
 * Pure props in, JSX out -- no store/worker access.
 */
export function ResultsPanel({
  result,
  loading,
  fxSnapshotId,
  fxStale,
}: ResultsPanelProps) {
  const stale = fxStale ?? result?.fxStale ?? false;
  const snapshotId = fxSnapshotId ?? result?.fxSnapshotId;

  if (loading) {
    return (
      <div
        className="flex flex-col gap-4 rounded-lg border border-border bg-card p-6 text-card-foreground"
        aria-busy="true"
        aria-live="polite"
      >
        <SkeletonBlock className="h-8 w-2/3" />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SkeletonBlock className="h-16" />
          <SkeletonBlock className="h-16" />
          <SkeletonBlock className="h-16" />
          <SkeletonBlock className="h-16" />
        </div>
        <SkeletonBlock className="h-40 w-full" />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card/50 p-10 text-center text-card-foreground">
        <p className="text-sm font-medium">No results yet</p>
        <p className="text-sm text-muted-foreground">
          Pick a currency, room size, and mode to pack the floor.
        </p>
      </div>
    );
  }

  const currency = result.currencyCode;
  const plnPerM2 = result.roomAreaM2 > 0 ? result.totalPLN / result.roomAreaM2 : 0;
  const piecesPerM2 =
    result.roomAreaM2 > 0 ? result.pieceCount / result.roomAreaM2 : 0;

  // Only show denominations that were actually placed; the packer emits a
  // perDenom entry for every eligible denomination (many with count 0), which
  // otherwise clutters the table with empty "PLN 0.00" rows.
  const rows = [...result.perDenom]
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <div className="flex flex-col gap-5 rounded-lg border border-border bg-card p-6 text-card-foreground">
      {(result.capped || stale) && (
        <div className="flex flex-wrap gap-2">
          {result.capped && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
              Representative patch &mdash; totals extrapolated (&times;
              {rhoFormatter.format(result.extrapolationFactor)})
            </span>
          )}
          {stale && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-3 py-1 text-xs font-medium text-sky-600 dark:text-sky-400"
              title={snapshotId ? `FX snapshot: ${snapshotId}` : undefined}
            >
              Snapshot rates
            </span>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">Total value</span>
        <span className="text-3xl font-semibold tracking-tight">
          {plnFormatter.format(result.totalPLN)}
        </span>
        <span className="text-sm text-muted-foreground">
          {formatMajor(
            result.totalValueMinor,
            result.denomTable[0]?.minorDigits ?? 2,
            currency,
          )}{' '}
          in {currency}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="flex flex-col gap-0.5 rounded-md bg-muted/50 p-3">
          <dt className="text-xs text-muted-foreground">Pieces</dt>
          <dd className="text-lg font-medium">
            {integerFormatter.format(result.pieceCount)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 rounded-md bg-muted/50 p-3">
          <dt className="text-xs text-muted-foreground">Coverage</dt>
          <dd className="text-lg font-medium">
            {oneDecimalFormatter.format(result.coverage * 100)}%
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 rounded-md bg-muted/50 p-3">
          <dt className="text-xs text-muted-foreground">PLN / m&sup2;</dt>
          <dd className="text-lg font-medium">
            {plnFormatter.format(plnPerM2)}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 rounded-md bg-muted/50 p-3">
          <dt className="text-xs text-muted-foreground">Pieces / m&sup2;</dt>
          <dd className="text-lg font-medium">
            {oneDecimalFormatter.format(piecesPerM2)}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">
          Per-denomination breakdown
        </h3>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Denomination
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-right">
                  Count
                </th>
                <th scope="col" className="px-3 py-2 font-medium text-right">
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((stat) => {
                const denom = result.denomTable[stat.denomIndex];
                return (
                  <tr
                    key={stat.denomIndex}
                    className="border-t border-border first:border-t-0"
                  >
                    <td className="px-3 py-2">{stat.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {integerFormatter.format(stat.count)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMajor(
                        stat.valueMinor,
                        denom?.minorDigits ?? 2,
                        currency,
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={3}
                    className="px-3 py-4 text-center text-muted-foreground"
                  >
                    No pieces fit in this room.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default ResultsPanel;
