/**
 * runSearch — drive the GPU candidate search, then hand the top-8 to the CPU.
 *
 * The GPU RANKS every candidate config and writes an integer score key; this
 * module reads the keys back, argmaxes over the lexicographic (coverageQ hi,
 * metric lo; ties -> LOWEST candidateIndex) ordering to pick the top-8, and the
 * CPU `replayTopK` (lib/packer) authoritatively replays those 8 to select the
 * winning PackResult. The GPU never produces drawn geometry.
 */

import type { Denomination } from '@/lib/currency/types';
import { getCurrency } from '@/lib/currency/dataset';
import { noteDimsUnits, coinRadiusUnits } from '@/lib/currency/derived';
import { DEFAULT_CANDIDATES } from '@/lib/config/constants';
import type { PackRequest, PackResult } from '@/lib/packer/types';
import { computeRoomSideUnits } from '@/lib/packer/skyline';
import {
  buildArchetypeOrders,
  computeBaseSeed,
  modeIndex,
} from '@/lib/packer/candidates';
import { replayTopK } from '@/lib/packer/replay';
import type { U64 } from '@/lib/packer/rng';
import type { SearchPipeline, DispatchParams } from '@/lib/gpu/pipeline';
import { createSearchPipeline } from '@/lib/gpu/pipeline';
import { getGpuDevice } from '@/lib/gpu/device';
import { GOLDEN_VECTOR } from '@/lib/gpu/wgslMirror';

const TOP_K = 8;

/** Resolve eligible denominations exactly like lib/packer/replay.ts. */
export function resolveEligible(req: PackRequest): Denomination[] {
  const currency = getCurrency(req.currencyCode);
  return currency.denominations.filter(
    (d) => !(req.excludeNonIssued && d.status === 'legalTenderNotIssued'),
  );
}

/** stride-5 per denom: [kind, noteW, noteH, coinR, minorValue] (matches WGSL denomData). */
function buildDenomData(denoms: Denomination[]): Uint32Array {
  const out = new Uint32Array(denoms.length * 5);
  for (let i = 0; i < denoms.length; i++) {
    const d = denoms[i];
    const [w, h] = noteDimsUnits(d);
    const r = coinRadiusUnits(d);
    out[i * 5 + 0] = d.kind === 'note' ? 0 : 1;
    out[i * 5 + 1] = w >>> 0;
    out[i * 5 + 2] = h >>> 0;
    out[i * 5 + 3] = r >>> 0;
    out[i * 5 + 4] = d.minorValue >>> 0;
  }
  return out;
}

/** Flatten the 8 archetype orders into one row-major Int32Array (row = archetype). */
function buildArchOrders(denoms: Denomination[], plnPerMinor: number): Int32Array {
  const orders = buildArchetypeOrders(denoms, plnPerMinor);
  const n = denoms.length;
  const out = new Int32Array(orders.length * n);
  for (let a = 0; a < orders.length; a++) {
    const row = orders[a];
    for (let i = 0; i < n; i++) out[a * n + i] = row[i];
  }
  return out;
}

function candidateCountOf(req: PackRequest): number {
  return req.candidateCount > 0 ? req.candidateCount : DEFAULT_CANDIDATES;
}

/**
 * Select the top-K candidateIds from the raw GPU scores (4 u32 per candidate:
 * coverageQ, metric, pieceCount, candidateIndex). Ordering: coverageQ desc,
 * metric desc, candidateIndex asc (ties -> lowest candidateIndex). All integer.
 */
function topKFromScores(scores: Uint32Array, candidateCount: number, k: number): number[] {
  const idx = new Array<number>(candidateCount);
  for (let i = 0; i < candidateCount; i++) idx[i] = i;
  idx.sort((a, b) => {
    const ca = scores[a * 4 + 0];
    const cb = scores[b * 4 + 0];
    if (ca !== cb) return cb - ca; // coverageQ desc
    const ma = scores[a * 4 + 1];
    const mb = scores[b * 4 + 1];
    if (ma !== mb) return mb - ma; // metric desc
    const ka = scores[a * 4 + 3];
    const kb = scores[b * 4 + 3];
    return ka - kb; // candidateIndex asc
  });
  const take = Math.min(k, candidateCount);
  const out = new Array<number>(take);
  for (let i = 0; i < take; i++) out[i] = scores[idx[i] * 4 + 3];
  return out;
}

/**
 * Dispatch the GPU search and return the TOP-K=8 candidateIds. The caller hands
 * these to CPU `replayTopK` for authoritative winner selection.
 */
export async function runSearch(
  device: GPUDevice,
  pipeline: SearchPipeline,
  req: PackRequest,
  eligibleDenoms: Denomination[],
  baseSeed: U64,
): Promise<number[]> {
  void device; // pipeline already owns its device; kept for API symmetry.
  await verifyGpuParity(pipeline); // dev-mode on-GPU golden-vector guard (once).

  const plnPerMinor = req.plnPerMinor;
  const candidateCount = candidateCountOf(req);
  const params: DispatchParams = {
    roomSideUnits: computeRoomSideUnits(req.areaTenths),
    modeIndex: modeIndex(req.mode),
    candidateCount,
    baseSeedHi: baseSeed.hi >>> 0,
    baseSeedLo: baseSeed.lo >>> 0,
    denomCount: eligibleDenoms.length,
    plnPerMinor,
    denomData: buildDenomData(eligibleDenoms),
    archOrders: buildArchOrders(eligibleDenoms, plnPerMinor),
  };

  const scores = await pipeline.dispatch(params);
  return topKFromScores(scores, candidateCount, TOP_K);
}

/**
 * Full pipeline: GPU-rank -> top-8 -> CPU replayTopK -> authoritative PackResult.
 */
export async function searchAndReplay(
  device: GPUDevice,
  pipeline: SearchPipeline,
  req: PackRequest,
): Promise<PackResult> {
  const eligibleDenoms = resolveEligible(req);
  const baseSeed = computeBaseSeed(req);
  const topIds = await runSearch(device, pipeline, req, eligibleDenoms, baseSeed);
  // CPU is authoritative: it re-derives + replays each of the GPU's top-8 and
  // returns the lexicographic best (ties -> lowest candidateId).
  return replayTopK(req, topIds);
}

/** Convenience: acquire device + build pipeline in one call (browser/worker). */
export async function initGpuSearch(): Promise<{ device: GPUDevice; pipeline: SearchPipeline }> {
  const device = await getGpuDevice();
  const pipeline = await createSearchPipeline(device);
  return { device, pipeline };
}

// ---------------------------------------------------------------------------
// On-GPU parity guard. Headless CI can only test wgslMirror (see parity.test.ts);
// this asserts the REAL GPU reproduces the PCG golden vector, throwing on drift.
// Runs at most once per pipeline (cached) and only in non-production builds.
// ---------------------------------------------------------------------------
const parityVerified = new WeakSet<SearchPipeline>();

function isDevMode(): boolean {
  try {
    return typeof process === 'undefined' || process.env?.NODE_ENV !== 'production';
  } catch {
    return true;
  }
}

export async function verifyGpuParity(pipeline: SearchPipeline): Promise<void> {
  if (!isDevMode() || parityVerified.has(pipeline)) return;
  const got = await pipeline.runParity();
  for (let i = 0; i < GOLDEN_VECTOR.length; i++) {
    if (got[i] !== GOLDEN_VECTOR[i] >>> 0) {
      throw new Error(
        `GPU PCG parity FAILED at index ${i}: got ${got[i] >>> 0}, expected ${
          GOLDEN_VECTOR[i] >>> 0
        }. The WGSL RNG diverged from lib/packer/rng.ts — search results are untrustworthy.`,
      );
    }
  }
  parityVerified.add(pipeline);
}
