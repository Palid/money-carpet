/**
 * THE single source of truth for the eligible-denomination set of a PackRequest.
 *
 * Both the CPU pipeline (packCPU / replay / candidates / scoring) AND the GPU
 * worker/runSearch call THIS function, then upload/replay from the exact list it
 * returns. The list MUST therefore be fully DETERMINISTIC (identical shape and
 * order on every call for the same request) so the CPU and GPU agree bit-for-bit.
 *
 * Rules, applied in order (see getEligibleDenoms):
 *   1. Start from getCurrency(req.currencyCode).denominations (dataset order).
 *   2. onlyPrimary + primary set  -> eligible = [that denomination] ONLY.
 *   3. Otherwise filter out status==='legalTenderNotIssued' when
 *      req.excludeNonIssued, but ALWAYS keep the primary (selecting it as primary
 *      overrides the exclusion).
 *   4. If the primary is a COIN, drop ALL notes (coin-primary => coins only).
 *   5. primaryEligibleIndex = position of the primary within the resulting
 *      `eligible` list, or -1 when no primary is selected.
 */

import type { Denomination } from '@/lib/currency/types';
import { getCurrency } from '@/lib/currency/dataset';
import type { PackRequest } from '@/lib/packer/types';

export interface EligibleSet {
  // Ordered eligible denominations. Same order the packer/scorer/GPU index into.
  eligible: Denomination[];
  // Position of req.primaryDenom within `eligible`, or -1 if no primary selected.
  primaryEligibleIndex: number;
}

export function getEligibleDenoms(req: PackRequest): EligibleSet {
  const all = getCurrency(req.currencyCode).denominations;

  // The primary denomination (by its FULL-array index), if any and in range.
  const hasPrimary =
    req.primaryDenom != null && req.primaryDenom >= 0 && req.primaryDenom < all.length;
  const primary = hasPrimary ? all[req.primaryDenom as number] : null;

  // (2) onlyPrimary: restrict to just the one selected denomination.
  if (req.onlyPrimary && primary != null) {
    return { eligible: [primary], primaryEligibleIndex: 0 };
  }

  // (3) Exclusion filter, but always keep the primary even if non-issued.
  let eligible = all.filter((d, i) => {
    if (i === req.primaryDenom) return true; // selecting-as-primary overrides exclusion
    return !(req.excludeNonIssued && d.status === 'legalTenderNotIssued');
  });

  // (4) Coin-primary => drop all notes (coins only).
  if (primary != null && primary.kind === 'coin') {
    eligible = eligible.filter((d) => d.kind === 'coin');
  }

  // (5) Locate the primary within the resulting list.
  const primaryEligibleIndex = primary != null ? eligible.indexOf(primary) : -1;

  return { eligible, primaryEligibleIndex };
}
