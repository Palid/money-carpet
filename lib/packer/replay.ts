/**
 * Authoritative replay + the headless CPU pipeline (packCPU).
 *
 * replayCandidate runs the real note packer (skyline) then the real coin fill
 * (circleFill, skipped for 'fewest'), assembles the SoA PackGeometry and the
 * per-denomination statistics, and computes the coverage-first score. When a
 * config would exceed PIECE_CAP it packs a representative interior block and
 * linearly extrapolates counts/value to the full room (patch mode).
 *
 * packCPU is the whole pipeline: build candidates, rank them with the fast shelf
 * scorer, authoritatively replay the top-K, and return the lexicographic best.
 */

import type { Denomination } from '@/lib/currency/types';
import { getCurrency } from '@/lib/currency/dataset';
import {
  PIECE_CAP,
  PATCH_BLOCK_TARGET_PIECES,
  UNITS_PER_M,
  DATASET_VERSION,
} from '@/lib/config/constants';
import { coinRadiusUnits, noteDimsUnits } from '@/lib/currency/derived';
import type {
  DenomRef,
  PackGeometry,
  PackRequest,
  PackResult,
  PerDenomStat,
} from '@/lib/packer/types';
import type { Config } from '@/lib/packer/candidates';
import {
  buildArchetypeOrders,
  computeBaseSeed,
  makeCandidate,
  makeCandidates,
} from '@/lib/packer/candidates';
import { packNotes, computeRoomSideUnits, orientedDims, type NotePlacement } from '@/lib/packer/skyline';
import { circleFill, type CoinPlacement } from '@/lib/packer/circleFill';
import { computeScoreKey, shelfScoreCandidate } from '@/lib/packer/scoring';

const TOP_K = 8;
const COIN_ESTIMATE_FILL = 0.85;

function resolveEligible(req: PackRequest): Denomination[] {
  const currency = getCurrency(req.currencyCode);
  return currency.denominations.filter(
    (d) => !(req.excludeNonIssued && d.status === 'legalTenderNotIssued'),
  );
}

function buildDenomTable(currencyCode: string, minorDigits: number, eligible: Denomination[]): DenomRef[] {
  return eligible.map((d) => ({
    currencyCode,
    label: d.label,
    color: d.color,
    kind: d.kind,
    minorValue: d.minorValue,
    minorDigits,
  }));
}

/** Build the SoA geometry from note + coin placements (notes first, then coins). */
function buildGeometry(notes: NotePlacement[], coins: CoinPlacement[]): PackGeometry {
  const count = notes.length + coins.length;
  const kind = new Uint8Array(count);
  const denom = new Uint16Array(count);
  const x = new Int32Array(count);
  const y = new Int32Array(count);
  const w = new Int32Array(count);
  const h = new Int32Array(count);
  const r = new Int32Array(count);
  const rot = new Uint8Array(count);

  let k = 0;
  for (const n of notes) {
    kind[k] = 0;
    denom[k] = n.denomIndex;
    x[k] = n.x;
    y[k] = n.y;
    w[k] = n.w;
    h[k] = n.h;
    r[k] = 0;
    rot[k] = n.rot;
    k++;
  }
  for (const c of coins) {
    kind[k] = 1;
    denom[k] = c.denomIndex;
    x[k] = c.cx;
    y[k] = c.cy;
    w[k] = 0;
    h[k] = 0;
    r[k] = c.r;
    rot[k] = 0;
    k++;
  }
  return { count, kind, denom, x, y, w, h, r, rot };
}

/** Per-denom counts scaled by rho (rho=1 when not extrapolating). */
function buildPerDenom(
  eligible: Denomination[],
  notes: NotePlacement[],
  coins: CoinPlacement[],
  rho: number,
): { perDenom: PerDenomStat[]; pieceCount: number; totalValueMinor: number } {
  const rawCounts = new Array<number>(eligible.length).fill(0);
  for (const n of notes) rawCounts[n.denomIndex]++;
  for (const c of coins) rawCounts[c.denomIndex]++;

  const perDenom: PerDenomStat[] = [];
  let pieceCount = 0;
  let totalValueMinor = 0;
  for (let i = 0; i < eligible.length; i++) {
    const count = rho === 1 ? rawCounts[i] : Math.round(rawCounts[i] * rho);
    const valueMinor = count * eligible[i].minorValue;
    perDenom.push({ denomIndex: i, label: eligible[i].label, count, valueMinor });
    pieceCount += count;
    totalValueMinor += valueMinor;
  }
  return { perDenom, pieceCount, totalValueMinor };
}

function avgCoinArea(eligible: Denomination[]): number {
  let sum = 0;
  let n = 0;
  for (const d of eligible) {
    if (d.kind !== 'coin') continue;
    const r = coinRadiusUnits(d);
    if (r <= 0) continue;
    sum += Math.PI * r * r;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function avgNoteArea(eligible: Denomination[]): number {
  let sum = 0;
  let n = 0;
  for (const d of eligible) {
    if (d.kind !== 'note') continue;
    const [w, h] = noteDimsUnits(d);
    if (w <= 0 || h <= 0) continue;
    sum += w * h;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

// Assumed note-area fraction of the room used by the ANALYTIC cap estimate.
const NOTE_FILL_ESTIMATE = 0.85;

function largestNoteDimUnits(config: Config, eligible: Denomination[]): number {
  let m = 0;
  for (const d of eligible) {
    if (d.kind !== 'note') continue;
    const [w, h] = orientedDims(d, config.orientPolicy);
    m = Math.max(m, w, h);
  }
  return m;
}

/**
 * Authoritatively replay a single candidate config into a PackResult.
 */
export function replayCandidate(
  config: Config,
  req: PackRequest,
  eligibleDenoms: Denomination[],
  plnPerMinor: number,
): PackResult {
  const currency = getCurrency(req.currencyCode);
  const minorDigits = currency.minorDigits;
  const currencyCode = currency.code;
  const roomSide = computeRoomSideUnits(req.areaTenths);
  const roomArea = roomSide * roomSide;
  const roomAreaM2 = req.areaTenths / 10;
  const denomTable = buildDenomTable(currencyCode, minorDigits, eligibleDenoms);
  const isFewest = req.mode === 'fewest';

  // --- analytic piece estimate (config-independent; deliberately avoids packing
  //     the full room so a >50k scenario is detected BEFORE materializing it) ---
  const avgNA = avgNoteArea(eligibleDenoms);
  const aca = avgCoinArea(eligibleDenoms);
  let estNotes = 0;
  let residualEst = roomArea;
  if (avgNA > 0) {
    const estNoteArea = roomArea * NOTE_FILL_ESTIMATE;
    estNotes = Math.round(estNoteArea / avgNA);
    residualEst = Math.max(0, roomArea - estNoteArea);
  }
  let estCoins = 0;
  if (!isFewest && aca > 0) {
    estCoins = Math.round((residualEst * COIN_ESTIMATE_FILL) / aca);
  }
  const estPieces = estNotes + estCoins;

  const baseFields = {
    mode: req.mode,
    currencyCode,
    roomSideUnits: roomSide,
    roomAreaM2,
    denomTable,
    fxSnapshotId: req.fxSnapshotId,
    fxStale: req.fxStale,
    datasetVersion: DATASET_VERSION,
    candidateId: config.candidateId,
  };

  if (estPieces <= PIECE_CAP) {
    // ---- full authoritative replay ----
    const fullNotes = packNotes(config, roomSide, eligibleDenoms).placements;
    const fullNoteArea = fullNotes.reduce((s, n) => s + n.w * n.h, 0);
    const coins = isFewest ? [] : circleFill(fullNotes, roomSide, eligibleDenoms).coins;
    const coinArea = coins.reduce((s, c) => s + Math.PI * c.r * c.r, 0);
    const geometry = buildGeometry(fullNotes, coins);
    const { perDenom, pieceCount, totalValueMinor } = buildPerDenom(eligibleDenoms, fullNotes, coins, 1);

    const coveredArea = fullNoteArea + coinArea;
    const coverage = roomArea > 0 ? Math.min(1, coveredArea / roomArea) : 0;
    const totalPLN = totalValueMinor * plnPerMinor;
    const key = computeScoreKey(req.mode, coveredArea, roomArea, totalValueMinor, plnPerMinor, pieceCount);

    return {
      ...baseFields,
      geometry,
      pieceCount,
      coverage,
      totalValueMinor,
      totalPLN,
      perDenom,
      capped: false,
      extrapolationFactor: 1,
      scoreKeyHi: key.hi,
      scoreKeyLo: key.lo,
    };
  }

  // ---- 50k CAP / PATCH MODE: pack a representative interior block, extrapolate ----
  let blockArea = roomArea * (PATCH_BLOCK_TARGET_PIECES / estPieces);
  let blockSide = Math.round(Math.sqrt(blockArea));
  // Keep the block representative: big enough to host at least one note tile,
  // never larger than the room.
  const minBlock = Math.min(roomSide, Math.max(1, largestNoteDimUnits(config, eligibleDenoms)));
  if (blockSide < minBlock) blockSide = minBlock;
  if (blockSide > roomSide) blockSide = roomSide;
  if (blockSide < 1) blockSide = 1;
  blockArea = blockSide * blockSide;

  const blockNotes = packNotes(config, blockSide, eligibleDenoms).placements;
  const blockNoteArea = blockNotes.reduce((s, n) => s + n.w * n.h, 0);
  const blockCoins = isFewest ? [] : circleFill(blockNotes, blockSide, eligibleDenoms).coins;
  const blockCoinArea = blockCoins.reduce((s, c) => s + Math.PI * c.r * c.r, 0);

  const rho = roomArea / blockArea;
  const geometry = buildGeometry(blockNotes, blockCoins); // REAL block geometry
  const { perDenom, pieceCount, totalValueMinor } = buildPerDenom(eligibleDenoms, blockNotes, blockCoins, rho);

  const blockCovered = blockNoteArea + blockCoinArea;
  const coverage = blockArea > 0 ? Math.min(1, blockCovered / blockArea) : 0; // coverage_full = coverage_block
  const totalPLN = totalValueMinor * plnPerMinor;
  // Score on the extrapolated full quantities.
  const key = computeScoreKey(req.mode, coverage * roomArea, roomArea, totalValueMinor, plnPerMinor, pieceCount);
  const patchAreaM2 = (blockSide / UNITS_PER_M) * (blockSide / UNITS_PER_M);

  return {
    ...baseFields,
    geometry,
    pieceCount,
    coverage,
    totalValueMinor,
    totalPLN,
    perDenom,
    capped: true,
    extrapolationFactor: rho,
    patchAreaM2,
    scoreKeyHi: key.hi,
    scoreKeyLo: key.lo,
  };
}

/** Pick the lexicographically best result; ties -> lowest candidateId. */
function pickBest(results: PackResult[]): PackResult {
  let best = results[0];
  for (let i = 1; i < results.length; i++) {
    const c = results[i];
    if (
      c.scoreKeyHi > best.scoreKeyHi ||
      (c.scoreKeyHi === best.scoreKeyHi && c.scoreKeyLo > best.scoreKeyLo) ||
      (c.scoreKeyHi === best.scoreKeyHi &&
        c.scoreKeyLo === best.scoreKeyLo &&
        c.candidateId < best.candidateId)
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * THE HEADLESS CPU PIPELINE. Resolves the request, builds candidates, ranks them
 * all with the shelf scorer, authoritatively replays the top-K, and returns the
 * lexicographic best (ties -> lowest candidateId).
 */
export function packCPU(req: PackRequest): PackResult {
  const eligibleDenoms = resolveEligible(req);
  const plnPerMinor = req.plnPerMinor;
  const candidates = makeCandidates(req, eligibleDenoms, plnPerMinor);

  // Rank all candidates by the fast shelf scorer.
  const ranked = candidates.map((config) => ({
    config,
    score: shelfScoreCandidate(config, req, eligibleDenoms, plnPerMinor),
  }));
  ranked.sort((a, b) => {
    if (a.score.coverageQ !== b.score.coverageQ) return b.score.coverageQ - a.score.coverageQ;
    if (a.score.metric !== b.score.metric) return b.score.metric - a.score.metric;
    return a.config.candidateId - b.config.candidateId;
  });

  const topK = ranked.slice(0, Math.min(TOP_K, ranked.length));
  const results = topK.map((e) => replayCandidate(e.config, req, eligibleDenoms, plnPerMinor));
  return pickBest(results);
}

/**
 * Authoritatively re-check a set of candidateIds (e.g. the GPU's top-8) and
 * return the lexicographic best, mirroring packCPU's final selection.
 */
export function replayTopK(req: PackRequest, candidateIds: number[]): PackResult {
  const eligibleDenoms = resolveEligible(req);
  const plnPerMinor = req.plnPerMinor;
  const baseSeed = computeBaseSeed(req);
  const archetypeOrders = buildArchetypeOrders(eligibleDenoms, plnPerMinor);
  const n = eligibleDenoms.length;

  const results = candidateIds.map((id) => {
    const config = makeCandidate(id, baseSeed, n, archetypeOrders);
    return replayCandidate(config, req, eligibleDenoms, plnPerMinor);
  });
  return pickBest(results);
}
