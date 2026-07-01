import snapshotData from '@/data/fx-snapshot.json';
import type { RatesResponse } from '@/lib/fx/types';

/**
 * Builds a RatesResponse from the bundled static snapshot
 * (data/fx-snapshot.json). Always succeeds — this is the fallback of
 * last resort and must never throw.
 */
export function loadSnapshot(): RatesResponse {
  return {
    base: 'PLN',
    date: snapshotData.date,
    source: 'snapshot',
    stale: true,
    snapshotId: snapshotData.snapshotId,
    ratesToPLN: { ...snapshotData.ratesToPLN },
  };
}

/**
 * Client helper: GETs /api/rates. On any network failure (offline,
 * timeout, etc.) falls back to the bundled snapshot directly so callers
 * always get a valid RatesResponse without needing to handle rejection.
 */
export async function fetchRates(): Promise<RatesResponse> {
  try {
    const res = await fetch('/api/rates');
    if (!res.ok) {
      return loadSnapshot();
    }
    return (await res.json()) as RatesResponse;
  } catch {
    return loadSnapshot();
  }
}
