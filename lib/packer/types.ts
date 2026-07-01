import type { PieceKind } from '@/lib/currency/types';
export type Mode = 'cheapest' | 'densest' | 'fewest';

// A compact per-result denomination table; geometry.denom indexes into this.
export interface DenomRef {
  currencyCode: string;
  label: string;
  color: string;
  kind: PieceKind;
  minorValue: number;
  minorDigits: number;
}

// All coordinates are fixed-point integers in 1/100 mm (see FP).
// Notes: (x,y) is TOP-LEFT, plus w,h,rot. Coins: (x,y) is CENTER, plus r.
//
// w,h are the EFFECTIVE, as-placed footprint dimensions - i.e. draw a w x h
// rect directly at (x,y), with no further rotation. `rot` is metadata only
// (whether the piece was placed rotated vs. its catalog orientation) and
// must NOT be re-applied by renderers/consumers; doing so double-rotates
// the piece (see lib/render/draw.ts's noteEffectiveExtent).
export interface PackGeometry {
  count: number; // pieces actually stored (real drawn geometry)
  kind: Uint8Array; // 0 = note, 1 = coin
  denom: Uint16Array; // index into denomTable
  x: Int32Array;
  y: Int32Array;
  w: Int32Array; // note EFFECTIVE (as-placed) width (0 for coins)
  h: Int32Array; // note EFFECTIVE (as-placed) height (0 for coins)
  r: Int32Array; // coin radius (0 for notes)
  rot: Uint8Array; // note orientation metadata 0/1 (0 for coins); NOT re-applied to w/h
}
export interface PerDenomStat {
  denomIndex: number;
  label: string;
  count: number; // pieces (post-extrapolation)
  valueMinor: number; // total minor units for this denom (post-extrapolation)
}
export interface PackResult {
  mode: Mode;
  currencyCode: string;
  roomSideUnits: number; // 1/100 mm side of square room
  roomAreaM2: number;
  denomTable: DenomRef[];
  geometry: PackGeometry; // REAL geometry (may be a representative patch when capped)
  pieceCount: number; // total (post-extrapolation)
  coverage: number; // 0..1
  totalValueMinor: number; // total minor units in the currency (post-extrapolation)
  totalPLN: number; // after FX multiply (0 if FX not applied yet)
  perDenom: PerDenomStat[];
  capped: boolean;
  extrapolationFactor: number; // rho (1 when not capped)
  patchAreaM2?: number; // area of the drawn patch when capped
  fxSnapshotId: string;
  fxStale: boolean;
  datasetVersion: number;
  candidateId: number;
  scoreKeyHi: number; // coverageQ
  scoreKeyLo: number; // mode metric
}

// Input passed into the packer/worker. plnPerMinor = PLN value of ONE minor unit.
export interface PackRequest {
  currencyCode: string;
  areaTenths: number; // area in 0.1 m^2 units (10..100 for 1..10 m^2)
  mode: Mode;
  excludeNonIssued: boolean;
  plnPerMinor: number;
  fxSnapshotId: string;
  fxStale: boolean;
  candidateCount: number;

  // --- "main denomination" selection (see lib/packer/eligible.ts) ---
  // Index into the currency's FULL denominations array
  // (getCurrency(currencyCode).denominations). When set, the packer LEADS with
  // this denomination (packed first + dominant) and fills the rest with the
  // currency's other eligible denominations. A COIN primary drops all notes; a
  // NOTE primary keeps coins as gap-fill. null = auto/mix (default behavior).
  primaryDenom: number | null;
  // When true AND primaryDenom is set, restrict the pack to JUST that one
  // denomination (single-denomination carpet; no gap-fill; leftover floor empty).
  // Ignored when primaryDenom is null.
  onlyPrimary: boolean;
}
