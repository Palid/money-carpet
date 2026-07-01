/**
 * Canonical integer PCG32, WGSL-PORTABLE.
 *
 * CRITICAL: this generator will later be ported VERBATIM to WGSL, which has NO
 * native u64. So the 64-bit state is emulated as TWO u32 lanes {hi, lo} using
 * ONLY u32 wrapping arithmetic and bit ops — the exact same integer operations
 * WGSL will use. NO BigInt is used anywhere in this file (BigInt only appears in
 * rng.test.ts as an independent cross-check reference).
 *
 * PCG32 spec implemented here (matches the pcg-c-basic / pcg-cpp reference):
 *   MULT (u64) = 6364136223846793005 = 0x5851F42D4C957F2D
 *   next(rng) -> u32:
 *     old   = state
 *     state = old * MULT + inc                 // 64-bit wrapping multiply-add
 *     xorshifted = u32( ((old >> 18) ^ old) >> 27 )
 *     rot        = u32( old >> 59 )
 *     return rotr32(xorshifted, rot)
 *   seed(initstate, initseq):
 *     state = 0; inc = (initseq << 1) | 1; next(); state += initstate; next();
 *
 * Every step is commented so a WGSL port is line-for-line. All lane values are
 * kept in the unsigned 32-bit range via `>>> 0`.
 */

// A 64-bit unsigned value emulated as two u32 lanes.
export interface U64 {
  hi: number; // high 32 bits, u32
  lo: number; // low 32 bits, u32
}

// The PCG32 stream state: 64-bit `state` and 64-bit `inc`, each as two u32 lanes.
export interface Rng {
  stateHi: number;
  stateLo: number;
  incHi: number;
  incLo: number;
}

// MULT = 0x5851F42D4C957F2D as two u32 lanes.
const MULT_HI = 0x5851f42d;
const MULT_LO = 0x4c957f2d;

/**
 * Low 32 bits of a u32 * u32 product (wrapping). Mirrors WGSL's `u32 * u32`
 * (which wraps to 32 bits). Math.imul computes the low 32 bits of the signed
 * product; `>>> 0` reinterprets as unsigned.
 */
function umul32lo(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

/**
 * Full 64-bit product of two u32 values, returned as {hi, lo} u32 lanes.
 * Computed from 16-bit partial products so it is exact and WGSL-portable
 * (WGSL would use the same 16-bit splitting since it also lacks a widening
 * multiply intrinsic in the base spec).
 */
function mul32(a: number, b: number): U64 {
  const aL = a & 0xffff;
  const aH = a >>> 16;
  const bL = b & 0xffff;
  const bH = b >>> 16;

  const ll = aL * bL; // bits 0..31
  const lh = aL * bH; // bits 16..47
  const hl = aH * bL; // bits 16..47
  const hh = aH * bH; // bits 32..63

  // Accumulate the middle 16-bit column (bits 16..31) plus carry.
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);

  const lo = (((ll & 0xffff) | ((mid & 0xffff) << 16)) >>> 0) >>> 0;
  const hi = ((hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0) >>> 0;
  return { hi, lo };
}

/**
 * 64-bit wrapping multiply-add: (a * b + c) mod 2^64, all operands and result
 * as u32 lanes. Only the low 64 bits are needed, so the a.hi*b.hi (>>64) term
 * is dropped.
 */
function mulAdd64(aHi: number, aLo: number, bHi: number, bLo: number, cHi: number, cLo: number): U64 {
  // Full 64-bit product of the low lanes.
  const ll = mul32(aLo, bLo);
  // Cross terms contribute only to the high 32 bits (they are shifted by 32).
  const prodLo = ll.lo;
  const prodHi = (ll.hi + umul32lo(aLo, bHi) + umul32lo(aHi, bLo)) >>> 0;

  // Add c (64-bit), propagating carry from low to high lane.
  const sumLo = prodLo + cLo; // may be up to 2^33 - 2, safe as a JS number
  const lo = sumLo >>> 0;
  const carry = sumLo > 0xffffffff ? 1 : 0;
  const hi = (prodHi + cHi + carry) >>> 0;
  return { hi, lo };
}

/** 64-bit add: (a + b) mod 2^64 as u32 lanes. */
function add64(aHi: number, aLo: number, bHi: number, bLo: number): U64 {
  const sumLo = aLo + bLo;
  const lo = sumLo >>> 0;
  const carry = sumLo > 0xffffffff ? 1 : 0;
  const hi = (aHi + bHi + carry) >>> 0;
  return { hi, lo };
}

/** Rotate-right of a 32-bit value by `rot` (0..31). rotr32(x,0) === x. */
function rotr32(x: number, rot: number): number {
  const r = rot & 31;
  // (x >> r) | (x << ((-r) & 31)); for r===0 the second term is x<<0 -> x.
  return ((x >>> r) | (x << ((-r) & 31))) >>> 0;
}

/**
 * Advance the stream and return the next 32-bit output. Mutates `rng` in place.
 */
export function next(rng: Rng): number {
  // old = state
  const oldHi = rng.stateHi;
  const oldLo = rng.stateLo;

  // state = old * MULT + inc   (64-bit wrapping)
  const s = mulAdd64(oldHi, oldLo, MULT_HI, MULT_LO, rng.incHi, rng.incLo);
  rng.stateHi = s.hi;
  rng.stateLo = s.lo;

  // xorshifted = u32( ((old >> 18) ^ old) >> 27 ), computed on the 64-bit `old`.
  // (old >> 18) as 64-bit: lo' = (old.lo >>> 18) | (old.hi << 14); hi' = old.hi >>> 18.
  const sh18Lo = ((oldLo >>> 18) | (oldHi << 14)) >>> 0;
  const sh18Hi = (oldHi >>> 18) >>> 0;
  // xored = (old >> 18) ^ old  (64-bit)
  const xLo = (sh18Lo ^ oldLo) >>> 0;
  const xHi = (sh18Hi ^ oldHi) >>> 0;
  // (xored >> 27), low 32 bits: (xLo >>> 27) | (xHi << 5)
  const xorshifted = ((xLo >>> 27) | (xHi << 5)) >>> 0;

  // rot = u32(old >> 59) = top 5 bits of the 64-bit value = old.hi >>> 27
  const rot = oldHi >>> 27;

  return rotr32(xorshifted, rot);
}

/**
 * Seed a stream in place following the canonical PCG32 seeding procedure.
 * initstate and initseq are provided as u32 lanes.
 */
function seed(rng: Rng, initstateHi: number, initstateLo: number, initseqHi: number, initseqLo: number): void {
  rng.stateHi = 0;
  rng.stateLo = 0;
  // inc = (initseq << 1) | 1   (64-bit)
  rng.incLo = (((initseqLo << 1) | 1) >>> 0) >>> 0;
  rng.incHi = ((initseqHi << 1) | (initseqLo >>> 31)) >>> 0;
  next(rng);
  // state = state + initstate  (64-bit)
  const s = add64(rng.stateHi, rng.stateLo, initstateHi, initstateLo);
  rng.stateHi = s.hi;
  rng.stateLo = s.lo;
  next(rng);
}

/**
 * Construct and seed a PCG32 stream. `initstate` selects the sequence position,
 * `initseq` selects the stream (must be < 2^63 effectively; the low bit is
 * forced to 1 internally as per PCG). Both are {hi, lo} u32 lane pairs.
 */
export function makeRng(initstate: U64, initseq: U64): Rng {
  const rng: Rng = { stateHi: 0, stateLo: 0, incHi: 0, incLo: 0 };
  seed(rng, initstate.hi >>> 0, initstate.lo >>> 0, initseq.hi >>> 0, initseq.lo >>> 0);
  return rng;
}

/**
 * Bounded output in [0, n). Uses PLAIN modulo deliberately: for search-seed
 * generation the modulo bias is irrelevant, and plain `next() % n` is trivially
 * identical across JS and WGSL (both compute u32 remainder). n must be >= 1.
 */
export function nextBounded(rng: Rng, n: number): number {
  return next(rng) % n;
}

/**
 * FNV-1a-64 emulated over u32 lanes, used to derive the per-request base seed.
 * Feeds: the ASCII bytes of `currencyCode`, then each integer argument as 4
 * little-endian bytes (areaTenths, modeIndex, datasetVersion, fxSnapshotHash).
 * Returns the 64-bit hash as {hi, lo} to be used as PCG `initstate`.
 */
const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_HI = 0x00000100; // 0x100000001b3 high 32 bits
const FNV_PRIME_LO = 0x000001b3; // 0x100000001b3 low 32 bits

/** (a * b) mod 2^64 for u32-lane operands, low 64 bits. */
function mul64(aHi: number, aLo: number, bHi: number, bLo: number): U64 {
  const ll = mul32(aLo, bLo);
  const lo = ll.lo;
  const hi = (ll.hi + umul32lo(aLo, bHi) + umul32lo(aHi, bLo)) >>> 0;
  return { hi, lo };
}

function fnvStep(h: U64, byte: number): U64 {
  // hash = (hash XOR byte) * FNV_PRIME  (byte affects only the low byte)
  const xLo = (h.lo ^ (byte & 0xff)) >>> 0;
  return mul64(h.hi, xLo, FNV_PRIME_HI, FNV_PRIME_LO);
}

export function hashBaseSeed(
  currencyCode: string,
  areaTenths: number,
  modeIndex: number,
  datasetVersion: number,
  fxSnapshotHash: number,
): U64 {
  let h: U64 = { hi: FNV_OFFSET_HI, lo: FNV_OFFSET_LO };
  for (let i = 0; i < currencyCode.length; i++) {
    h = fnvStep(h, currencyCode.charCodeAt(i) & 0xff);
  }
  const ints = [areaTenths | 0, modeIndex | 0, datasetVersion | 0, fxSnapshotHash | 0];
  for (const v of ints) {
    const u = v >>> 0;
    h = fnvStep(h, u & 0xff);
    h = fnvStep(h, (u >>> 8) & 0xff);
    h = fnvStep(h, (u >>> 16) & 0xff);
    h = fnvStep(h, (u >>> 24) & 0xff);
  }
  return h;
}

/** FNV-1a-32 over a string, used to fold fxSnapshotId into a u32 for hashBaseSeed. */
export function hashStringU32(s: string): number {
  let h = 0x811c9dc5 >>> 0; // 32-bit FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h = (h ^ (s.charCodeAt(i) & 0xff)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0; // 32-bit FNV prime
  }
  return h >>> 0;
}

/**
 * GOLDEN VECTOR: the first 6 `next()` outputs for the canonical PCG demo seed
 * seed(initstate=0x853c49e6748fea9b, initseq=0xda3e39cb94b95bdb). The GPU agent
 * asserts parity against these exact values.
 */
export const GOLDEN_SEED_INITSTATE: U64 = { hi: 0x853c49e6, lo: 0x748fea9b };
export const GOLDEN_SEED_INITSEQ: U64 = { hi: 0xda3e39cb, lo: 0x94b95bdb };
export const GOLDEN_VECTOR: readonly number[] = [
  465482994, 3895364073, 1746730475, 3759121132, 2984354868, 3193308813,
];
