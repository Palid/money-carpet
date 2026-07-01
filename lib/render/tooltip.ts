// d3-quadtree hover picking over piece CENTERS, with a containment check so
// hovering a gap between pieces returns null instead of "closest piece".
import { quadtree, type Quadtree } from 'd3-quadtree';

import type { PieceKind } from '@/lib/currency/types';
import type { DenomRef, PackResult } from '@/lib/packer/types';

import { pieceCenter, pieceContainsPoint } from './draw';

export interface PickResult {
  index: number;
  denom: DenomRef;
  kind: PieceKind;
  /** Formatted monetary value, e.g. "10.00 PLN". */
  valueLabel: string;
}

/** Builds a quadtree over piece centers, keyed by piece index into `result.geometry`. */
export function buildQuadtree(result: PackResult): Quadtree<number> {
  const count = result.geometry.count;
  const indices: number[] = new Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;

  return quadtree<number>(
    indices,
    (i) => pieceCenter(result, i)[0],
    (i) => pieceCenter(result, i)[1],
  );
}

function formatValueLabel(denom: DenomRef): string {
  const value = denom.minorValue / 10 ** denom.minorDigits;
  return `${value.toFixed(denom.minorDigits)} ${denom.currencyCode}`;
}

/**
 * Nearest piece (by center) to (worldX, worldY), rejected (returns null)
 * unless the point actually falls inside that piece's rect/circle - so
 * hovering a gap between pieces returns null rather than the nearest piece.
 */
export function pick(
  qt: Quadtree<number>,
  worldX: number,
  worldY: number,
  result: PackResult,
): PickResult | null {
  const index = qt.find(worldX, worldY);
  if (index === undefined) return null;
  if (!pieceContainsPoint(result, index, worldX, worldY)) return null;

  const denomIdx = result.geometry.denom[index];
  const denom = result.denomTable[denomIdx];
  if (!denom) return null;

  const kind: PieceKind = result.geometry.kind[index] === 1 ? 'coin' : 'note';
  return { index, denom, kind, valueLabel: formatValueLabel(denom) };
}
