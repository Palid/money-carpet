import type { Denomination } from '@/lib/currency/types';
import { FP } from '@/lib/config/constants';

/**
 * Convert a denomination's integer minor-unit face value into its major-unit
 * face value, e.g. minorValue 1000 with minorDigits 2 -> 10 (10 zł).
 */
export function faceValueMajor(d: Denomination, minorDigits: number): number {
  return d.minorValue / 10 ** minorDigits;
}

/**
 * Physical footprint of a single piece in square meters.
 * Notes: bounding-box area (widthMm * heightMm).
 * Coins: TRUE CIRCLE area using the across-corners diameter, even for
 * polygon-shaped coins (never the polygon's own smaller area, never a
 * bounding box).
 */
export function footprintM2(d: Denomination): number {
  if (d.kind === 'note') {
    return (d.widthMm * d.heightMm) / 1e6;
  }
  const radiusMm = d.diameterMm / 2;
  return (Math.PI * radiusMm * radiusMm) / 1e6;
}

/**
 * Value density in PLN per square meter for a denomination.
 * plnPerMinor is the PLN value of ONE minor unit of the piece's currency.
 */
export function valueDensityPLN(
  d: Denomination,
  minorDigits: number,
  plnPerMinor: number,
): number {
  // minorDigits is part of the signature to mirror faceValueMajor's shape
  // and because callers typically have both values on hand together; the
  // density calc itself only needs minorValue (already integer minor units)
  // and plnPerMinor.
  void minorDigits;
  const totalPLN = d.minorValue * plnPerMinor;
  return totalPLN / footprintM2(d);
}

/**
 * Fixed-point (1/100 mm) integer dimensions for a note. Returns [0, 0] for
 * coins.
 */
export function noteDimsUnits(d: Denomination): [widthUnits: number, heightUnits: number] {
  if (d.kind !== 'note') {
    return [0, 0];
  }
  return [Math.round(d.widthMm * FP), Math.round(d.heightMm * FP)];
}

/**
 * Fixed-point (1/100 mm) integer radius for a coin. Returns 0 for notes.
 */
export function coinRadiusUnits(d: Denomination): number {
  if (d.kind !== 'coin') {
    return 0;
  }
  return Math.round((d.diameterMm / 2) * FP);
}
