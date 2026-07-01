'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import { getCurrency } from '@/lib/currency/dataset';
import type { Denomination } from '@/lib/currency/types';

export interface DenomPickerProps {
  /** Currency whose denominations are offered (getCurrency(currencyCode).denominations). */
  currencyCode: string;
  /** Index into that currency's full denominations array, or null for auto/mix. */
  primaryDenom: number | null;
  /** When true (and primaryDenom set), the packer fills the floor with ONLY that denomination. */
  onlyPrimary: boolean;
  onPrimaryChange: (idx: number | null) => void;
  onOnlyPrimaryChange: (b: boolean) => void;
}

const AUTO_VALUE = 'auto';

/** "note, 120×60 mm" or "coin, ⌀16.5 mm" — a compact kind + dimensions suffix. */
function formatKindAndDims(d: Denomination): string {
  if (d.kind === 'note') {
    return `note, ${d.widthMm}×${d.heightMm} mm`;
  }
  return `coin, ⌀${d.diameterMm} mm`;
}

/**
 * Lets the user pin the packer to a single "main" denomination instead of
 * the default auto/mix behavior, and optionally restrict the floor to just
 * that denomination (a single-denomination carpet).
 *
 * Purely prop-driven — no store dependency — so it can be unit-tested and
 * reused without a live app store.
 */
export function DenomPicker({
  currencyCode,
  primaryDenom,
  onlyPrimary,
  onPrimaryChange,
  onOnlyPrimaryChange,
}: DenomPickerProps) {
  const selectId = React.useId();
  const checkboxId = React.useId();

  const denominations = React.useMemo(
    () => getCurrency(currencyCode).denominations,
    [currencyCode],
  );

  const selectValue =
    primaryDenom !== null && primaryDenom >= 0 && primaryDenom < denominations.length
      ? String(primaryDenom)
      : AUTO_VALUE;

  const handleSelectChange = React.useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const { value } = e.target;
      onPrimaryChange(value === AUTO_VALUE ? null : Number(value));
    },
    [onPrimaryChange],
  );

  const handleOnlyPrimaryChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onOnlyPrimaryChange(e.target.checked);
    },
    [onOnlyPrimaryChange],
  );

  const onlyPrimaryDisabled = primaryDenom === null;

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor={selectId}
        className="text-sm font-medium text-foreground"
      >
        Main denomination
      </label>
      <select
        id={selectId}
        value={selectValue}
        onChange={handleSelectChange}
        className="flex h-10 w-full min-w-0 items-center rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-72"
      >
        <option value={AUTO_VALUE}>Auto (mix everything)</option>
        {denominations.map((d, idx) => (
          <option key={`${d.kind}:${d.label}:${idx}`} value={idx}>
            {d.label} — {formatKindAndDims(d)}
          </option>
        ))}
      </select>

      <label
        htmlFor={checkboxId}
        className={cn(
          'flex items-center gap-2 text-sm text-foreground',
          onlyPrimaryDisabled
            ? 'cursor-not-allowed text-muted-foreground'
            : 'cursor-pointer',
        )}
      >
        <input
          id={checkboxId}
          type="checkbox"
          checked={onlyPrimary}
          disabled={onlyPrimaryDisabled}
          onChange={handleOnlyPrimaryChange}
          className="h-4 w-4 rounded border-input text-primary accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span>Only this denomination</span>
      </label>
    </div>
  );
}

export default DenomPicker;
