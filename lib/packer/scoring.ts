/**
 * Coverage-first lexicographic scoring.
 *
 * The score key is two u32 values (hi, lo):
 *   hi = coverageQ = floor(coverage * COVERAGE_Q_SCALE)
 *   lo = mode metric (all integer, u32-clamped):
 *        cheapest: VMAX - V_cents  (minimize value)
 *        densest:  V_cents         (maximize value)
 *        fewest:   KMAX - pieceCount (minimize piece count)
 * A candidate is "better" when its (hi, lo) is lexicographically LARGER.
 *
 * `shelfScoreCandidate` is the fast approximate scorer -- the CPU TWIN the GPU
 * ranking must match. It uses an NFDH shelf note pack plus an analytic coin
 * coverage estimate, integer-only and simple enough to mirror in WGSL.
 */

import type { Denomination } from '@/lib/currency/types';
import { coinRadiusUnits } from '@/lib/currency/derived';
import { COVERAGE_Q_SCALE } from '@/lib/config/constants';
import type { Mode, PackRequest } from '@/lib/packer/types';
import type { Config } from '@/lib/packer/candidates';
import { computeRoomSideUnits, orientedDims } from '@/lib/packer/skyline';

export const U32_MAX = 0xffffffff;
const VMAX = U32_MAX;
const KMAX = U32_MAX;

function clampU32(x: number): number {
  const r = Math.round(x);
  if (r < 0) return 0;
  if (r > U32_MAX) return U32_MAX;
  return r;
}

/** Value in integer 1/100 PLN (V_cents), clamped to u32. */
export function valueCents(totalValueMinor: number, plnPerMinor: number): number {
  return clampU32(totalValueMinor * plnPerMinor * 100);
}

export interface ScoreKey {
  hi: number; // coverageQ
  lo: number; // mode metric
}

function modeMetric(mode: Mode, vCents: number, pieceCount: number): number {
  if (mode === 'cheapest') return (VMAX - vCents) >>> 0;
  if (mode === 'densest') return vCents >>> 0;
  return (KMAX - clampU32(pieceCount)) >>> 0; // fewest
}

/**
 * Authoritative score key from a fully replayed candidate's measured quantities.
 * `coveredArea` and `roomArea` are fixed-point-units-squared as JS numbers.
 */
export function computeScoreKey(
  mode: Mode,
  coveredArea: number,
  roomArea: number,
  totalValueMinor: number,
  plnPerMinor: number,
  pieceCount: number,
): ScoreKey {
  let coverage = roomArea > 0 ? coveredArea / roomArea : 0;
  if (coverage < 0) coverage = 0;
  if (coverage > 1) coverage = 1;
  const coverageQ = Math.floor(coverage * COVERAGE_Q_SCALE);
  const vCents = valueCents(totalValueMinor, plnPerMinor);
  return { hi: coverageQ, lo: modeMetric(mode, vCents, pieceCount) };
}

/** Lexicographic compare: >0 if a is better (larger) than b. */
export function compareScoreKey(aHi: number, aLo: number, bHi: number, bLo: number): number {
  if (aHi !== bHi) return aHi - bHi;
  return aLo - bLo;
}

export interface ShelfScore {
  coverageQ: number;
  metric: number;
  pieceCount: number;
}

const COIN_FILL_ETA_NUM = 9; // analytic coin packing efficiency ~ 0.9
const COIN_FILL_ETA_DEN = 10;

/**
 * The CPU twin the GPU must match in ranking. O(1) private scalar state (it only
 * reads the order/denom arrays): an NFDH shelf pack of notes plus an analytic,
 * monotone coin coverage estimate.
 */
export function shelfScoreCandidate(
  config: Config,
  req: PackRequest,
  eligibleDenoms: Denomination[],
  plnPerMinor: number,
): ShelfScore {
  const roomSide = computeRoomSideUnits(req.areaTenths);
  const roomArea = roomSide * roomSide;

  // --- NFDH shelf note pack (priority = config.order, unlimited supply) ---
  let y = 0;
  let x = 0;
  let shelfH = 0;
  let shelfOpen = false;
  let noteArea = 0;
  let noteValue = 0;
  let noteCount = 0;

  const orderNotes = config.order; // scan in priority order

  const MAX_PLACEMENTS = 2_000_000;
  let placements = 0;
  while (placements < MAX_PLACEMENTS) {
    // Find the highest-priority note that fits under the current shelf state.
    let chosen = -1;
    let cw = 0;
    let ch = 0;
    let cVal = 0;
    for (let oi = 0; oi < orderNotes.length; oi++) {
      const di = orderNotes[oi];
      const d = eligibleDenoms[di];
      if (d.kind !== 'note') continue;
      const [w, h] = orientedDims(d, config.orientPolicy);
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

    // Nothing fits the current state.
    if (shelfOpen) {
      // Close the shelf and try to open a new one.
      y += shelfH;
      shelfOpen = false;
      shelfH = 0;
      x = 0;
      continue;
    }
    break; // no shelf open and nothing fits -> done
  }

  // --- analytic coin fill (skipped for 'fewest') ---
  let coinCount = 0;
  let coinValue = 0;
  let coinArea = 0;
  if (req.mode !== 'fewest') {
    // Representative coin: highest value-density for densest, lowest for cheapest.
    let repArea = 0;
    let repValue = 0;
    let bestDensity = req.mode === 'densest' ? -Infinity : Infinity;
    for (let i = 0; i < eligibleDenoms.length; i++) {
      const d = eligibleDenoms[i];
      if (d.kind !== 'coin') continue;
      const r = coinRadiusUnits(d);
      if (r <= 0) continue;
      const area = Math.PI * r * r;
      const density = d.minorValue / area;
      const better = req.mode === 'densest' ? density > bestDensity : density < bestDensity;
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
  const metric = modeMetric(req.mode, vCents, pieceCount);

  return { coverageQ, metric, pieceCount };
}
