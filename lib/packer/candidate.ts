/**
 * Candidate configuration primitives shared bit-for-bit with the future GPU
 * packer. A candidate config is:
 *   {
 *     order:         Int32Array  // permutation of eligible denom indices
 *     startCorner:   0..3
 *     orientPolicy:  0..2
 *     fitHeuristic:  0..1
 *   }
 *
 * The two functions here (makePermutation and decodeConfig) MUST produce
 * bit-identical results in WGSL, so both are specified exactly against the
 * PCG32 in rng.ts. makePermutation's parity is the single highest project risk.
 */

import { makeRng, nextBounded, type U64, type Rng } from '@/lib/packer/rng';

// Number of base archetype configs = 8 orderings * 4 corners * 3 orient * 2 fit.
export const N_ARCHETYPES = 8;
export const N_START_CORNERS = 4;
export const N_ORIENT_POLICIES = 3;
export const N_FIT_HEURISTICS = 2;
export const N_BASE_CONFIGS =
  N_ARCHETYPES * N_START_CORNERS * N_ORIENT_POLICIES * N_FIT_HEURISTICS; // 192

export interface DecodedPolicies {
  startCorner: number;
  orientPolicy: number;
  fitHeuristic: number;
}

/**
 * candidateId -> {archetype, startCorner, orientPolicy, fitHeuristic} for the
 * base archetype block. The mixed-radix layout (matched by makeCandidates):
 *   id = ((archetype*4 + startCorner)*3 + orientPolicy)*2 + fitHeuristic
 */
export function decodeBaseArchetype(candidateId: number): {
  archetype: number;
  startCorner: number;
  orientPolicy: number;
  fitHeuristic: number;
} {
  let id = candidateId | 0;
  const fitHeuristic = id % N_FIT_HEURISTICS;
  id = Math.floor(id / N_FIT_HEURISTICS);
  const orientPolicy = id % N_ORIENT_POLICIES;
  id = Math.floor(id / N_ORIENT_POLICIES);
  const startCorner = id % N_START_CORNERS;
  id = Math.floor(id / N_START_CORNERS);
  const archetype = id % N_ARCHETYPES;
  return { archetype, startCorner, orientPolicy, fitHeuristic };
}

/**
 * The per-candidate PCG stream. initstate = baseSeed (per request), initseq =
 * candidateId. candidateId is folded into a u32 lane. Each candidate therefore
 * has its own independent, reproducible stream — exactly what the GPU needs to
 * regenerate a config from just (baseSeed, candidateId).
 */
function candidateRng(candidateId: number, baseSeed: U64): Rng {
  const initseq: U64 = { hi: 0, lo: candidateId >>> 0 };
  return makeRng(baseSeed, initseq);
}

/**
 * Fisher-Yates shuffle of [0, n) using the candidate's PCG stream.
 *
 * EXACT SPEC (WGSL must match): i runs from n-1 down to 1; j = nextBounded(rng,
 * i+1); swap order[i] and order[j]. The stream is makeRng(baseSeed, candidateId).
 * This is the #1 bit-parity risk; keep it verbatim.
 */
export function makePermutation(candidateId: number, baseSeed: U64, n: number): Int32Array {
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  if (n <= 1) return order;
  const rng = candidateRng(candidateId, baseSeed);
  for (let i = n - 1; i >= 1; i--) {
    const j = nextBounded(rng, i + 1);
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}

/**
 * Derive {startCorner, orientPolicy, fitHeuristic}.
 *  - Base archetypes (candidateId < N_BASE_CONFIGS): decoded from the mixed-radix
 *    candidateId (deterministic, no RNG).
 *  - Padded candidates (candidateId >= N_BASE_CONFIGS): drawn from the candidate's
 *    PCG stream. A SEPARATE stream instance from makePermutation's (both seeded
 *    identically) — so the two are independently reproducible on the GPU.
 */
export function decodeConfig(candidateId: number, baseSeed: U64, n: number): DecodedPolicies {
  void n;
  if (candidateId < N_BASE_CONFIGS) {
    const d = decodeBaseArchetype(candidateId);
    return {
      startCorner: d.startCorner,
      orientPolicy: d.orientPolicy,
      fitHeuristic: d.fitHeuristic,
    };
  }
  const rng = candidateRng(candidateId, baseSeed);
  const startCorner = nextBounded(rng, N_START_CORNERS);
  const orientPolicy = nextBounded(rng, N_ORIENT_POLICIES);
  const fitHeuristic = nextBounded(rng, N_FIT_HEURISTICS);
  return { startCorner, orientPolicy, fitHeuristic };
}
