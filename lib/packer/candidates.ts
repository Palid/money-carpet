/**
 * Build the candidate-config list for a pack request.
 *
 * Layout: 8 order archetypes x 4 startCorners x 3 orientPolicies x 2
 * fitHeuristics = 192 base configs, then padded up to req.candidateCount with
 * makePermutation-derived configs. Every config carries its candidateId so the
 * exact same config can be regenerated from (baseSeed, candidateId) on the GPU.
 */

import type { Denomination } from '@/lib/currency/types';
import { footprintM2, valueDensityPLN, noteDimsUnits, coinRadiusUnits } from '@/lib/currency/derived';
import { DATASET_VERSION, DEFAULT_CANDIDATES } from '@/lib/config/constants';
import type { Mode, PackRequest } from '@/lib/packer/types';
import { hashBaseSeed, hashStringU32, type U64 } from '@/lib/packer/rng';
import {
  N_BASE_CONFIGS,
  decodeBaseArchetype,
  decodeConfig,
  makePermutation,
} from '@/lib/packer/candidate';

export interface Config {
  candidateId: number;
  order: Int32Array; // permutation of eligible denom indices
  startCorner: number; // 0..3
  orientPolicy: number; // 0..2
  fitHeuristic: number; // 0..1
}

export function modeIndex(mode: Mode): number {
  return mode === 'cheapest' ? 0 : mode === 'densest' ? 1 : 2;
}

/** The per-request PCG initstate. */
export function computeBaseSeed(req: PackRequest): U64 {
  const fxHash = hashStringU32(req.fxSnapshotId);
  return hashBaseSeed(req.currencyCode, req.areaTenths, modeIndex(req.mode), DATASET_VERSION, fxHash);
}

/**
 * Stable sort of eligible-denom indices by `key` (numeric). `dir` = -1 for
 * descending, +1 for ascending. Ties break by original index ascending so the
 * result is fully deterministic.
 */
function sortedIndices(denoms: Denomination[], key: (d: Denomination) => number, dir: number): Int32Array {
  const idx = Array.from({ length: denoms.length }, (_, i) => i);
  idx.sort((a, b) => {
    const ka = key(denoms[a]);
    const kb = key(denoms[b]);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return a - b; // stable tie-break
  });
  return Int32Array.from(idx);
}

function aspectRatio(d: Denomination): number {
  if (d.kind !== 'note') return 1;
  const [w, h] = noteDimsUnits(d);
  const lo = Math.min(w, h);
  const hi = Math.max(w, h);
  return lo === 0 ? 1 : hi / lo;
}

/** Radius used only for coin ordering (notes -> 0). */
function coinRadius(d: Denomination): number {
  return d.kind === 'coin' ? coinRadiusUnits(d) : 0;
}

/**
 * The 8 archetype orderings over the eligible denominations. Each is an
 * Int32Array of indices into `denoms`.
 */
export function buildArchetypeOrders(denoms: Denomination[], plnPerMinor: number): Int32Array[] {
  const vd = (d: Denomination) => valueDensityPLN(d, 0, plnPerMinor);
  const fp = (d: Denomination) => footprintM2(d);
  const fv = (d: Denomination) => d.minorValue;

  const orders: Int32Array[] = [];
  orders[0] = sortedIndices(denoms, fp, -1); // largest-footprint
  orders[1] = sortedIndices(denoms, fp, 1); // smallest-footprint
  orders[2] = sortedIndices(denoms, vd, -1); // valueDensity-desc
  orders[3] = sortedIndices(denoms, vd, 1); // valueDensity-asc
  orders[4] = sortedIndices(denoms, aspectRatio, 1); // aspect-ratio ascending
  orders[5] = sortedIndices(denoms, fv, -1); // faceValue-desc
  orders[6] = sortedIndices(denoms, fv, 1); // faceValue-asc

  // hybrid: notes by valueDensity desc, then coins by radius desc.
  const noteIdx = denoms
    .map((d, i) => ({ d, i }))
    .filter((e) => e.d.kind === 'note')
    .sort((a, b) => {
      const dv = vd(b.d) - vd(a.d);
      if (dv !== 0) return dv < 0 ? -1 : 1;
      return a.i - b.i;
    })
    .map((e) => e.i);
  const coinIdx = denoms
    .map((d, i) => ({ d, i }))
    .filter((e) => e.d.kind === 'coin')
    .sort((a, b) => {
      const dr = coinRadius(b.d) - coinRadius(a.d);
      if (dr !== 0) return dr < 0 ? -1 : 1;
      return a.i - b.i;
    })
    .map((e) => e.i);
  orders[7] = Int32Array.from([...noteIdx, ...coinIdx]);

  return orders;
}

/** Build a single Config for a given candidateId (used by replayTopK). */
export function makeCandidate(
  candidateId: number,
  baseSeed: U64,
  n: number,
  archetypeOrders: Int32Array[],
): Config {
  if (candidateId < N_BASE_CONFIGS) {
    const d = decodeBaseArchetype(candidateId);
    return {
      candidateId,
      order: archetypeOrders[d.archetype],
      startCorner: d.startCorner,
      orientPolicy: d.orientPolicy,
      fitHeuristic: d.fitHeuristic,
    };
  }
  const order = makePermutation(candidateId, baseSeed, n);
  const pol = decodeConfig(candidateId, baseSeed, n);
  return { candidateId, order, ...pol };
}

/** Build the full candidate list for a request. */
export function makeCandidates(
  req: PackRequest,
  eligibleDenoms: Denomination[],
  plnPerMinor: number,
): Config[] {
  const n = eligibleDenoms.length;
  const total = req.candidateCount > 0 ? req.candidateCount : DEFAULT_CANDIDATES;
  const baseSeed = computeBaseSeed(req);
  const archetypeOrders = buildArchetypeOrders(eligibleDenoms, plnPerMinor);

  const configs: Config[] = [];
  for (let candidateId = 0; candidateId < total; candidateId++) {
    configs.push(makeCandidate(candidateId, baseSeed, n, archetypeOrders));
  }
  return configs;
}
