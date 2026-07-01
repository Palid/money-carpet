import { describe, expect, it } from 'vitest';

import { makeSyntheticResult } from './synthetic';
import { buildQuadtree, pick } from './tooltip';
import { noteEffectiveExtent, pieceCenter } from './draw';

describe('buildQuadtree + pick', () => {
  it('returns the correct note piece for a point at its center', () => {
    const result = makeSyntheticResult({ pieceCount: 40, noteFraction: 1, seed: 11, roomAreaM2: 4 });
    const qt = buildQuadtree(result);

    // Pick a note somewhere in the middle of the grid, not an edge case.
    const index = Math.floor(result.geometry.count / 2);
    const [cx, cy] = pieceCenter(result, index);

    const found = pick(qt, cx, cy, result);
    expect(found).not.toBeNull();
    expect(found?.index).toBe(index);
    expect(found?.kind).toBe('note');
  });

  it('returns the correct coin piece for a point at its center', () => {
    const result = makeSyntheticResult({ pieceCount: 40, noteFraction: 0, seed: 12, roomAreaM2: 4 });
    const qt = buildQuadtree(result);

    const index = Math.floor(result.geometry.count / 2);
    const [cx, cy] = pieceCenter(result, index);

    const found = pick(qt, cx, cy, result);
    expect(found).not.toBeNull();
    expect(found?.index).toBe(index);
    expect(found?.kind).toBe('coin');
  });

  it('returns the correct piece for a point inside its rect (not just the exact center)', () => {
    const result = makeSyntheticResult({ pieceCount: 40, noteFraction: 1, seed: 13, roomAreaM2: 4 });
    const qt = buildQuadtree(result);

    const index = 5;
    const x0 = result.geometry.x[index];
    const y0 = result.geometry.y[index];
    const [ew, eh] = noteEffectiveExtent(
      result.geometry.w[index],
      result.geometry.h[index],
      result.geometry.rot[index],
    );
    // A point near the top-left corner of the rect, well inside its bounds.
    const px = x0 + Math.min(ew, eh) * 0.1;
    const py = y0 + Math.min(ew, eh) * 0.1;

    const found = pick(qt, px, py, result);
    expect(found).not.toBeNull();
    expect(found?.index).toBe(index);
  });

  it('returns null for a point in the gap between pieces', () => {
    const result = makeSyntheticResult({
      pieceCount: 40,
      noteFraction: 1,
      seed: 14,
      roomAreaM2: 4,
      gapMm: 10,
    });
    const qt = buildQuadtree(result);

    // Two adjacent pieces in the grid (index 0 and 1, same row).
    const x0 = result.geometry.x[0];
    const y0 = result.geometry.y[0];
    const [ew0, eh0] = noteEffectiveExtent(
      result.geometry.w[0],
      result.geometry.h[0],
      result.geometry.rot[0],
    );
    const x1 = result.geometry.x[1];

    // Midpoint between the right edge of piece 0 and the left edge of piece 1,
    // vertically centered - squarely in the gap.
    const gapX = (x0 + ew0 + x1) / 2;
    const gapY = y0 + eh0 / 2;

    // Sanity: the gap point must not already fall inside a piece's own rect.
    expect(gapX).toBeGreaterThan(x0 + ew0);
    expect(gapX).toBeLessThan(x1);

    const found = pick(qt, gapX, gapY, result);
    expect(found).toBeNull();
  });

  it('returns null when querying far outside any geometry', () => {
    const result = makeSyntheticResult({ pieceCount: 10, seed: 15, roomAreaM2: 4 });
    const qt = buildQuadtree(result);
    const found = pick(qt, -1_000_000, -1_000_000, result);
    expect(found).toBeNull();
  });

  it('stays correct at 50000 pieces', () => {
    const result = makeSyntheticResult({ pieceCount: 50_000, seed: 99, roomAreaM2: 10 });
    const qt = buildQuadtree(result);

    for (const index of [0, 1234, 25_000, 49_999]) {
      const [cx, cy] = pieceCenter(result, index);
      const found = pick(qt, cx, cy, result);
      expect(found).not.toBeNull();
      expect(found?.index).toBe(index);
    }
  });
});
