/**
 * wgslMirror.ts — a PURE-TS transcription of the EXACT integer ops implemented
 * in lib/gpu/shaders/pack-search.wgsl. Its sole purpose is to make GPU parity
 * UNIT-TESTABLE WITHOUT a GPU: every function here maps 1:1 to a WGSL function
 * of the same name, and the two must stay line-for-line identical.
 *
 * CROSS-REFERENCE MAP (this file  <->  pack-search.wgsl  <->  lib/packer):
 *   next / nextRng              rng.ts:116   (PCG32 output)            — BIT-EXACT
 *   makeRng / seed              rng.ts:146   (PCG32 seeding)           — BIT-EXACT
 *   nextBounded                 rng.ts:176   (plain modulo)            — BIT-EXACT
 *   makePermutation             candidate.ts:72 (Fisher-Yates)         — BIT-EXACT
 *   decodeBaseArchetype         candidate.ts:37                        — BIT-EXACT
 *   decodePolicies              candidate.ts:94 (decodeConfig)         — BIT-EXACT
 *   orientedDims                skyline.ts:45                          — BIT-EXACT
 *   shelfScore                  scoring.ts:91 (shelfScoreCandidate)    — see note
 *
 * INTEGER OPS (next/nextBounded/makePermutation/decode*) are bit-exact between
 * THIS mirror, the WGSL, AND lib/packer — argmax on the GPU is therefore
 * deterministic across hardware. shelfScore's note-pack + coin-coverage logic is
 * ported structurally identically; this mirror uses f64 (to match scoring.ts
 * EXACTLY, which is what the parity test asserts), whereas the WGSL uses f32 for
 * the AREA/VALUE accumulators. That f32<->f64 gap is the sanctioned ranking
 * approximation: the GPU only RANKS, the CPU replayTopK is authoritative, so a
 * boundary-rounding difference can only make the search slightly worse-ranked,
 * never produce wrong output.
 */

// ---------------------------------------------------------------------------
// PCG32, u32-lane (mirrors pack-search.wgsl Rng/U64 + the 64-bit helpers,
// which themselves mirror lib/packer/rng.ts). Self-contained on purpose: it is
// an INDEPENDENT transcription, not a re-export of rng.ts, so the parity test
// actually exercises a second copy of the algorithm.
// ---------------------------------------------------------------------------

export interface MirrorU64 {
  hi: number;
  lo: number;
}

export interface MirrorRng {
  stateHi: number;
  stateLo: number;
  incHi: number;
  incLo: number;
}

// MULT = 0x5851F42D4C957F2D as two u32 lanes (rng.ts:40-41 / wgsl MULT_HI/LO).
const MULT_HI = 0x5851f42d;
const MULT_LO = 0x4c957f2d;

/** low 32 bits of a*b (wraps) — WGSL `u32 * u32`. (rng.ts:48 umul32lo) */
function umul32lo(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

/** full 64-bit product of two u32 as {hi,lo} via 16-bit partials. (rng.ts:58 mul32) */
function mul32(a: number, b: number): MirrorU64 {
  const aL = a & 0xffff;
  const aH = a >>> 16;
  const bL = b & 0xffff;
  const bH = b >>> 16;

  const ll = aL * bL;
  const lh = aL * bH;
  const hl = aH * bL;
  const hh = aH * bH;

  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);

  const lo = (((ll & 0xffff) | ((mid & 0xffff) << 16)) >>> 0) >>> 0;
  const hi = ((hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0) >>> 0;
  return { hi, lo };
}

/** (a*b + c) mod 2^64, u32 lanes. (rng.ts:82 mulAdd64) */
function mulAdd64(
  aHi: number,
  aLo: number,
  bHi: number,
  bLo: number,
  cHi: number,
  cLo: number,
): MirrorU64 {
  const ll = mul32(aLo, bLo);
  const prodLo = ll.lo;
  const prodHi = (ll.hi + umul32lo(aLo, bHi) + umul32lo(aHi, bLo)) >>> 0;

  const sumLo = prodLo + cLo;
  const lo = sumLo >>> 0;
  const carry = sumLo > 0xffffffff ? 1 : 0;
  const hi = (prodHi + cHi + carry) >>> 0;
  return { hi, lo };
}

/** (a+b) mod 2^64, u32 lanes. (rng.ts:98 add64) */
function add64(aHi: number, aLo: number, bHi: number, bLo: number): MirrorU64 {
  const sumLo = aLo + bLo;
  const lo = sumLo >>> 0;
  const carry = sumLo > 0xffffffff ? 1 : 0;
  const hi = (aHi + bHi + carry) >>> 0;
  return { hi, lo };
}

/** rotate-right 32-bit. (rng.ts:107 rotr32) */
function rotr32(x: number, rot: number): number {
  const r = rot & 31;
  return ((x >>> r) | (x << ((-r) & 31))) >>> 0;
}

/** Advance the stream, return next u32. Mutates rng. (rng.ts:116 next / wgsl nextRng) */
export function next(rng: MirrorRng): number {
  const oldHi = rng.stateHi;
  const oldLo = rng.stateLo;

  const s = mulAdd64(oldHi, oldLo, MULT_HI, MULT_LO, rng.incHi, rng.incLo);
  rng.stateHi = s.hi;
  rng.stateLo = s.lo;

  const sh18Lo = ((oldLo >>> 18) | (oldHi << 14)) >>> 0;
  const sh18Hi = (oldHi >>> 18) >>> 0;
  const xLo = (sh18Lo ^ oldLo) >>> 0;
  const xHi = (sh18Hi ^ oldHi) >>> 0;
  const xorshifted = ((xLo >>> 27) | (xHi << 5)) >>> 0;
  const rot = oldHi >>> 27;

  return rotr32(xorshifted, rot);
}

/** Seed + construct a PCG32 stream. (rng.ts:146 seed + rng.ts:165 makeRng / wgsl makeRng) */
export function makeRng(initstate: MirrorU64, initseq: MirrorU64): MirrorRng {
  const rng: MirrorRng = { stateHi: 0, stateLo: 0, incHi: 0, incLo: 0 };
  const initstateHi = initstate.hi >>> 0;
  const initstateLo = initstate.lo >>> 0;
  const initseqHi = initseq.hi >>> 0;
  const initseqLo = initseq.lo >>> 0;

  rng.stateHi = 0;
  rng.stateLo = 0;
  rng.incLo = (((initseqLo << 1) | 1) >>> 0) >>> 0;
  rng.incHi = ((initseqHi << 1) | (initseqLo >>> 31)) >>> 0;
  next(rng);
  const s = add64(rng.stateHi, rng.stateLo, initstateHi, initstateLo);
  rng.stateHi = s.hi;
  rng.stateLo = s.lo;
  next(rng);
  return rng;
}

/** Bounded output in [0,n) via plain modulo. (rng.ts:176 nextBounded / wgsl nextBounded) */
export function nextBounded(rng: MirrorRng, n: number): number {
  return next(rng) % n;
}

// ---------------------------------------------------------------------------
// Candidate reconstruction (mirrors candidate.ts + pack-search.wgsl).
// ---------------------------------------------------------------------------

export const N_ARCHETYPES = 8;
export const N_START_CORNERS = 4;
export const N_ORIENT_POLICIES = 3;
export const N_FIT_HEURISTICS = 2;
export const N_BASE_CONFIGS =
  N_ARCHETYPES * N_START_CORNERS * N_ORIENT_POLICIES * N_FIT_HEURISTICS; // 192

/** The per-candidate stream: initstate = baseSeed, initseq = {0, candidateId}. (candidate.ts:60) */
function candidateRng(candidateId: number, baseSeed: MirrorU64): MirrorRng {
  return makeRng(baseSeed, { hi: 0, lo: candidateId >>> 0 });
}

/**
 * Fisher-Yates shuffle of [0,n). (candidate.ts:72 makePermutation / wgsl makePermutation)
 * i runs n-1..1; j = nextBounded(rng, i+1); swap(order[i], order[j]).
 */
export function makePermutation(candidateId: number, baseSeed: MirrorU64, n: number): number[] {
  const order = new Array<number>(n);
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
 * candidate.ts:46 applyPrimaryFirst — move the "main denomination" (its eligible
 * index) to the FRONT of `order` (stable). Line-for-line with pack-search.wgsl's
 * applyPrimaryFirst: an in-place shift-down. The OUTPUT is identical to lib/packer
 * candidates.applyPrimaryFirst (the parity test asserts this). Returns a NEW array
 * so the caller's input is untouched. primaryEligibleIndex < 0 => identity.
 */
export function applyPrimaryFirst(
  order: ArrayLike<number>,
  primaryEligibleIndex: number,
  n: number = order.length,
): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = order[i];
  if (primaryEligibleIndex < 0) return out;
  // find the primary's current position p within order[0..n).
  let p = 0;
  for (let i = 0; i < n; i++) {
    if (out[i] === primaryEligibleIndex) {
      p = i;
      break;
    }
  }
  // shift order[0..p) down into [1..p], then place the primary at the front.
  for (let k = p; k >= 1; k--) out[k] = out[k - 1];
  out[0] = primaryEligibleIndex;
  return out;
}

export interface MirrorPolicies {
  startCorner: number;
  orientPolicy: number;
  fitHeuristic: number;
}

/** candidateId -> {archetype, startCorner, orientPolicy, fitHeuristic}. (candidate.ts:37) */
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

/** Derive {startCorner, orientPolicy, fitHeuristic}. (candidate.ts:94 decodeConfig) */
export function decodePolicies(candidateId: number, baseSeed: MirrorU64): MirrorPolicies {
  if (candidateId < N_BASE_CONFIGS) {
    const d = decodeBaseArchetype(candidateId);
    return { startCorner: d.startCorner, orientPolicy: d.orientPolicy, fitHeuristic: d.fitHeuristic };
  }
  const rng = candidateRng(candidateId, baseSeed);
  const startCorner = nextBounded(rng, N_START_CORNERS);
  const orientPolicy = nextBounded(rng, N_ORIENT_POLICIES);
  const fitHeuristic = nextBounded(rng, N_FIT_HEURISTICS);
  return { startCorner, orientPolicy, fitHeuristic };
}

/**
 * Reconstruct a candidate's priority order EXACTLY as candidates.ts makeCandidate
 * does, and as the WGSL kernel does:
 *   base configs (id < 192): the precomputed archetype order (data-derived, not RNG)
 *   padded configs (id >= 192): makePermutation(id, baseSeed, n)
 * then applyPrimaryFirst moves the "main denomination" to the front (identity when
 * primaryEligibleIndex < 0, so the pre-feature path is preserved exactly).
 * archetypeOrders[a] must be the SAME arrays buildArchetypeOrders() produced.
 */
export function reconstructOrder(
  candidateId: number,
  baseSeed: MirrorU64,
  n: number,
  archetypeOrders: ArrayLike<number>[],
  primaryEligibleIndex: number = -1,
): number[] {
  let order: number[];
  if (candidateId < N_BASE_CONFIGS) {
    const { archetype } = decodeBaseArchetype(candidateId);
    const a = archetypeOrders[archetype];
    order = new Array<number>(n);
    for (let i = 0; i < n; i++) order[i] = a[i];
  } else {
    order = makePermutation(candidateId, baseSeed, n);
  }
  return applyPrimaryFirst(order, primaryEligibleIndex, n);
}

// ---------------------------------------------------------------------------
// Shelf score (mirrors scoring.ts shelfScoreCandidate + pack-search.wgsl shelf
// block). Integer keys out; f64 intermediates here (matches scoring.ts exactly).
// ---------------------------------------------------------------------------

const COVERAGE_Q_SCALE = 1_000_000; // constants.ts COVERAGE_Q_SCALE
const COIN_FILL_ETA_NUM = 9; // scoring.ts:83
const COIN_FILL_ETA_DEN = 10; // scoring.ts:84
const U32_MAX = 0xffffffff;

/** A denomination reduced to the integer fields the shelf scorer reads. */
export interface MirrorDenom {
  kind: number; // 0 = note, 1 = coin (currency/types PieceKind)
  w: number; // note width, fixed-point units (noteDimsUnits[0]); 0 for coins
  h: number; // note height, fixed-point units (noteDimsUnits[1]); 0 for coins
  r: number; // coin radius, fixed-point units (coinRadiusUnits); 0 for notes
  minorValue: number; // integer minor units
}

export interface MirrorShelfInput {
  order: ArrayLike<number>; // priority order (indices into denoms)
  orientPolicy: number; // 0/1/2
  modeIndex: number; // 0 cheapest, 1 densest, 2 fewest
  roomSide: number; // fixed-point units (computeRoomSideUnits)
  plnPerMinor: number;
  denoms: MirrorDenom[];
}

export interface MirrorShelfScore {
  coverageQ: number;
  metric: number;
  pieceCount: number;
}

/** clampU32(round(x)) — scoring.ts:28 clampU32. */
function clampU32(x: number): number {
  const r = Math.round(x);
  if (r < 0) return 0;
  if (r > U32_MAX) return U32_MAX;
  return r;
}

/** valueCents — scoring.ts:36. */
function valueCents(totalValueMinor: number, plnPerMinor: number): number {
  return clampU32(totalValueMinor * plnPerMinor * 100);
}

/** modeMetric — scoring.ts:45. */
function modeMetric(modeIndex: number, vCents: number, pieceCount: number): number {
  if (modeIndex === 0) return (U32_MAX - vCents) >>> 0; // cheapest
  if (modeIndex === 1) return vCents >>> 0; // densest
  return (U32_MAX - clampU32(pieceCount)) >>> 0; // fewest
}

/** orientedDims (dims only; rot flag unused by the scorer) — skyline.ts:45. */
function orientedDims(d: MirrorDenom, orientPolicy: number): [number, number] {
  const w = d.w;
  const h = d.h;
  if (orientPolicy === 1) return w >= h ? [w, h] : [h, w];
  if (orientPolicy === 2) return h >= w ? [w, h] : [h, w];
  return [w, h];
}

/**
 * The CPU TWIN, mirrored. (scoring.ts:91 shelfScoreCandidate)
 * NFDH shelf note pack (O(1) scalar state) + analytic coin coverage estimate.
 */
export function shelfScore(input: MirrorShelfInput): MirrorShelfScore {
  const { order, orientPolicy, modeIndex, roomSide, plnPerMinor, denoms } = input;
  const roomArea = roomSide * roomSide;

  // --- NFDH shelf note pack (scoring.ts:100-159) ---
  let y = 0;
  let x = 0;
  let shelfH = 0;
  let shelfOpen = false;
  let noteArea = 0;
  let noteValue = 0;
  let noteCount = 0;

  const MAX_PLACEMENTS = 2_000_000;
  let placements = 0;
  while (placements < MAX_PLACEMENTS) {
    let chosen = -1;
    let cw = 0;
    let ch = 0;
    let cVal = 0;
    for (let oi = 0; oi < order.length; oi++) {
      const di = order[oi];
      const d = denoms[di];
      if (d.kind !== 0) continue; // notes only
      const [w, h] = orientedDims(d, orientPolicy);
      if (w <= 0 || h <= 0 || w > roomSide) continue;
      const fits = shelfOpen ? h <= shelfH && x + w <= roomSide : h <= roomSide - y;
      if (fits) {
        chosen = di;
        cw = w;
        ch = h;
        cVal = d.minorValue;
        break;
      }
    }

    if (chosen >= 0) {
      if (!shelfOpen) {
        shelfOpen = true;
        shelfH = ch;
        x = 0;
      }
      x += cw;
      noteArea += cw * ch;
      noteValue += cVal;
      noteCount++;
      placements++;
      continue;
    }

    if (shelfOpen) {
      y += shelfH;
      shelfOpen = false;
      shelfH = 0;
      x = 0;
      continue;
    }
    break;
  }

  // --- analytic coin fill, skipped for 'fewest' (scoring.ts:161-191) ---
  let coinCount = 0;
  let coinValue = 0;
  let coinArea = 0;
  if (modeIndex !== 2) {
    let repArea = 0;
    let repValue = 0;
    let bestDensity = modeIndex === 1 ? -Infinity : Infinity;
    for (let i = 0; i < denoms.length; i++) {
      const d = denoms[i];
      if (d.kind !== 1) continue; // coins only
      const r = d.r;
      if (r <= 0) continue;
      const area = Math.PI * r * r;
      const density = d.minorValue / area;
      const better = modeIndex === 1 ? density > bestDensity : density < bestDensity;
      if (better) {
        bestDensity = density;
        repArea = area;
        repValue = d.minorValue;
      }
    }
    if (repArea > 0) {
      const residual = Math.max(0, roomArea - noteArea);
      const effArea = (residual * COIN_FILL_ETA_NUM) / COIN_FILL_ETA_DEN;
      coinCount = Math.floor(effArea / repArea);
      coinArea = coinCount * repArea;
      coinValue = coinCount * repValue;
    }
  }

  const coveredArea = noteArea + coinArea;
  let coverage = roomArea > 0 ? coveredArea / roomArea : 0;
  if (coverage > 1) coverage = 1;
  const coverageQ = Math.floor(coverage * COVERAGE_Q_SCALE);

  const totalValueMinor = noteValue + coinValue;
  const pieceCount = noteCount + coinCount;
  const vCents = valueCents(totalValueMinor, plnPerMinor);
  const metric = modeMetric(modeIndex, vCents, pieceCount);

  return { coverageQ, metric, pieceCount };
}

// ---------------------------------------------------------------------------
// The canonical PCG golden seed + vector (mirrors rng.ts:242-246). The runtime
// on-GPU parity kernel (runSearch.verifyGpuParity) checks these exact values.
// ---------------------------------------------------------------------------
export const GOLDEN_SEED_INITSTATE: MirrorU64 = { hi: 0x853c49e6, lo: 0x748fea9b };
export const GOLDEN_SEED_INITSEQ: MirrorU64 = { hi: 0xda3e39cb, lo: 0x94b95bdb };
export const GOLDEN_VECTOR: readonly number[] = [
  465482994, 3895364073, 1746730475, 3759121132, 2984354868, 3193308813,
];
