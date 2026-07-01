import { loadSnapshot } from '@/lib/fx/fetch';
import type { RatesResponse } from '@/lib/fx/types';

/**
 * PLN value of ONE MINOR unit of `code` (e.g. 1 grosz, 1 cent, 1 yen).
 * This is exactly what PackRequest.plnPerMinor expects.
 *
 * Falls back to the bundled snapshot if `rates` is missing the code
 * (upstream provider gaps); throws a clear error if the code is unknown
 * everywhere.
 */
export function plnPerMinor(
  code: string,
  minorDigits: number,
  rates: RatesResponse,
): number {
  const upper = code.toUpperCase();
  let perMajor = rates.ratesToPLN[upper];

  if (typeof perMajor !== 'number') {
    const snapshot = loadSnapshot();
    perMajor = snapshot.ratesToPLN[upper];
  }

  if (typeof perMajor !== 'number') {
    throw new Error(`No FX rate available for currency code: ${code}`);
  }

  return perMajor / 10 ** minorDigits;
}

export function snapshotIdOf(rates: RatesResponse): string {
  return rates.snapshotId;
}
