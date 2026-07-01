import { listCurrencies } from '@/lib/currency/dataset';
import type { FrankfurterResponse } from '@/lib/fx/convert';
import { convertFrankfurterToPLN } from '@/lib/fx/convert';
import { loadSnapshot } from '@/lib/fx/fetch';
import type { RatesResponse } from '@/lib/fx/types';

export const runtime = 'edge';
export const revalidate = 86400;

const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?base=PLN';

export async function GET(): Promise<Response> {
  const snapshot = loadSnapshot();

  try {
    const upstream = await fetch(FRANKFURTER_URL, {
      next: { revalidate: 86400 },
    });

    if (!upstream.ok) {
      return jsonResponse(snapshot);
    }

    const frankfurter = (await upstream.json()) as FrankfurterResponse;
    const datasetCodes = listCurrencies().map((c) => c.code);
    const { date, ratesToPLN } = convertFrankfurterToPLN(
      frankfurter,
      datasetCodes,
      snapshot,
    );

    const body: RatesResponse = {
      base: 'PLN',
      date,
      source: 'live',
      stale: false,
      snapshotId: `live:${date}`,
      ratesToPLN,
    };

    return jsonResponse(body);
  } catch {
    // Any upstream failure/timeout/parse error -> serve the bundled
    // snapshot. Never throw to the client.
    return jsonResponse(snapshot);
  }
}

function jsonResponse(body: RatesResponse): Response {
  // Live rates are safe to cache for a full day (matches `revalidate`).
  // Snapshot fallbacks get a much shorter cache so we retry the upstream
  // again soon rather than pinning stale data for 24h.
  const cacheControl = body.stale
    ? 'public, max-age=0, s-maxage=60, stale-while-revalidate=300'
    : 'public, max-age=0, s-maxage=86400, stale-while-revalidate=86400';

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': cacheControl,
    },
  });
}
