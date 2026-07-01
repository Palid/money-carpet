import type { RatesResponse } from '@/lib/fx/types';

/**
 * Shape of the Frankfurter API response for `?base=PLN`:
 * https://api.frankfurter.app/latest?base=PLN
 * `rates[CUR]` is the number of units of CUR per 1 PLN.
 */
export interface FrankfurterResponse {
  base: string;
  date: string;
  rates: Record<string, number>;
}

/**
 * Pure conversion of a Frankfurter response into our normalized
 * ratesToPLN shape (PLN value of ONE MAJOR unit of each currency).
 *
 * Frankfurter/ECB doesn't cover every currency in our dataset, so any
 * dataset currency missing from `frankfurter.rates` (and not PLN itself)
 * falls back to the corresponding value in `snapshot.ratesToPLN`.
 *
 * Returns only the parts derived from the upstream response; the caller
 * (the route handler) is responsible for filling in source/stale/snapshotId.
 */
export function convertFrankfurterToPLN(
  frankfurter: FrankfurterResponse,
  datasetCodes: string[],
  snapshot: RatesResponse,
): Pick<RatesResponse, 'date' | 'ratesToPLN'> {
  const ratesToPLN: Record<string, number> = {};

  for (const code of datasetCodes) {
    const upper = code.toUpperCase();
    if (upper === 'PLN') {
      ratesToPLN[upper] = 1;
      continue;
    }

    const unitsPerPLN = frankfurter.rates[upper];
    if (typeof unitsPerPLN === 'number' && unitsPerPLN > 0) {
      ratesToPLN[upper] = 1 / unitsPerPLN;
    } else {
      ratesToPLN[upper] = snapshot.ratesToPLN[upper];
    }
  }

  return {
    date: frankfurter.date,
    ratesToPLN,
  };
}
