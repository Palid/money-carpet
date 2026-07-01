// Integration regression test: real packCPU output drawn through the
// render layer's own geometry helpers must (a) stay inside the room bounds,
// (b) rasterize to a coverage fraction matching result.coverage, and
// (c) never overlap note-on-note.
//
// This exists because lib/render/synthetic.ts historically used the OPPOSITE
// note-orientation convention from the real packer (lib/packer): the packer
// stores EFFECTIVE (already-oriented, as-placed) dims directly in
// PackGeometry.w/h with `rot` as metadata only, while the old renderer
// (noteEffectiveExtent) re-swapped w<->h whenever rot===1. Synthetic data
// happened to expect that swap, so render tests against synthetic data
// passed even though the renderer double-rotated real packer output.
//
// candidateCount matches the app's real default (DEFAULT_CANDIDATES): a
// smaller candidate pool changes which candidate wins the lexicographic
// ranking, and at a smaller pool the winner for these requests may happen
// to use zero rotated notes - which would make this test pass even against
// the buggy renderer for the wrong reason. At the real default, PLN 1 m^2
// densest's winning candidate places its notes ALL rotated (rot=1), which
// is the actual repro of the reported bug (96.9% coverage, solid bars).
import { describe, expect, it } from 'vitest';

import { packCPU } from '@/lib/packer';
import { DEFAULT_CANDIDATES } from '@/lib/config/constants';
import type { PackRequest, PackResult } from '@/lib/packer/types';
import { computeBufferView, noteEffectiveExtent, pieceContainsPoint } from '@/lib/render/draw';

// A few fixed-point units of slack (1 unit = 1/100 mm) for rounding.
const EPS = 5;
const GRID_N = 300;

function makeReq(p: Partial<PackRequest>): PackRequest {
  return {
    currencyCode: 'PLN',
    areaTenths: 40,
    mode: 'densest',
    excludeNonIssued: true,
    plnPerMinor: 0.01,
    fxSnapshotId: 'test',
    fxStale: false,
    candidateCount: DEFAULT_CANDIDATES,
    primaryDenom: null,
    onlyPrimary: false,
    ...p,
  };
}

/** Rasterizes ANY piece coverage onto a GRID_N x GRID_N grid using the RENDER's own extent helper. */
function rasterizeCoverageFraction(result: PackResult, gridN: number): number {
  const side = Math.max(result.roomSideUnits, 1);
  const cellSize = side / gridN;
  const anyCover = new Uint8Array(gridN * gridN);
  const { geometry } = result;

  function markRect(x0: number, y0: number, x1: number, y1: number): void {
    const i0 = Math.max(0, Math.floor(x0 / cellSize));
    const i1 = Math.min(gridN - 1, Math.ceil(x1 / cellSize) - 1);
    const j0 = Math.max(0, Math.floor(y0 / cellSize));
    const j1 = Math.min(gridN - 1, Math.ceil(y1 / cellSize) - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        anyCover[j * gridN + i] = 1;
      }
    }
  }

  function markCircle(cx: number, cy: number, r: number): void {
    const i0 = Math.max(0, Math.floor((cx - r) / cellSize));
    const i1 = Math.min(gridN - 1, Math.ceil((cx + r) / cellSize) - 1);
    const j0 = Math.max(0, Math.floor((cy - r) / cellSize));
    const j1 = Math.min(gridN - 1, Math.ceil((cy + r) / cellSize) - 1);
    for (let j = j0; j <= j1; j++) {
      const cellCy = (j + 0.5) * cellSize;
      for (let i = i0; i <= i1; i++) {
        const cellCx = (i + 0.5) * cellSize;
        const dx = cellCx - cx;
        const dy = cellCy - cy;
        if (dx * dx + dy * dy <= r * r) {
          anyCover[j * gridN + i] = 1;
        }
      }
    }
  }

  for (let idx = 0; idx < geometry.count; idx++) {
    if (geometry.kind[idx] === 0) {
      const [ew, eh] = noteEffectiveExtent(geometry.w[idx], geometry.h[idx], geometry.rot[idx]);
      markRect(geometry.x[idx], geometry.y[idx], geometry.x[idx] + ew, geometry.y[idx] + eh);
    } else {
      markCircle(geometry.x[idx], geometry.y[idx], geometry.r[idx]);
    }
  }

  let covered = 0;
  for (let k = 0; k < anyCover.length; k++) if (anyCover[k]) covered++;
  return covered / anyCover.length;
}

/**
 * Total pairwise overlap AREA between note rects (drawn with the render's own
 * effective extent), as a fraction of total note area. Uses exact rectangle
 * intersection (not a rasterized grid): two notes that merely touch along a
 * shared edge (routine in a tightly packed room) have zero intersection
 * area, so this doesn't false-positive on flush-adjacent notes the way a
 * coarse grid would.
 */
function noteOverlapAreaFraction(result: PackResult): number {
  const { geometry } = result;
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  let totalArea = 0;
  for (let i = 0; i < geometry.count; i++) {
    if (geometry.kind[i] !== 0) continue;
    const [ew, eh] = noteEffectiveExtent(geometry.w[i], geometry.h[i], geometry.rot[i]);
    rects.push({ x: geometry.x[i], y: geometry.y[i], w: ew, h: eh });
    totalArea += ew * eh;
  }
  if (totalArea === 0) return 0;

  let overlapArea = 0;
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    for (let j = i + 1; j < rects.length; j++) {
      const b = rects[j];
      const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      overlapArea += ox * oy;
    }
  }
  return overlapArea / totalArea;
}

function checkPack(label: string, req: PackRequest): void {
  describe(label, () => {
    const result = packCPU(req);
    const view = computeBufferView(result);

    it('produces pieces', () => {
      expect(result.geometry.count).toBeGreaterThan(0);
    });

    it("every piece, drawn with the render's effective extent, fits inside the room bounds", () => {
      const { geometry } = result;
      for (let i = 0; i < geometry.count; i++) {
        if (geometry.kind[i] === 0) {
          const [ew, eh] = noteEffectiveExtent(geometry.w[i], geometry.h[i], geometry.rot[i]);
          const x = geometry.x[i];
          const y = geometry.y[i];
          expect(x).toBeGreaterThanOrEqual(-EPS);
          expect(y).toBeGreaterThanOrEqual(-EPS);
          expect(x + ew).toBeLessThanOrEqual(view.bounds.maxX + EPS);
          expect(y + eh).toBeLessThanOrEqual(view.bounds.maxY + EPS);

          // pieceContainsPoint must agree with the same effective rect at its own center.
          const cx = x + ew / 2;
          const cy = y + eh / 2;
          expect(pieceContainsPoint(result, i, cx, cy)).toBe(true);
        } else {
          const x = geometry.x[i];
          const y = geometry.y[i];
          const r = geometry.r[i];
          expect(x - r).toBeGreaterThanOrEqual(-EPS);
          expect(y - r).toBeGreaterThanOrEqual(-EPS);
          expect(x + r).toBeLessThanOrEqual(view.bounds.maxX + EPS);
          expect(y + r).toBeLessThanOrEqual(view.bounds.maxY + EPS);
          expect(pieceContainsPoint(result, i, x, y)).toBe(true);
        }
      }
    });

    it('coverage rasterized from the render extents matches result.coverage', () => {
      const coverageFraction = rasterizeCoverageFraction(result, GRID_N);
      expect(Math.abs(coverageFraction - result.coverage)).toBeLessThanOrEqual(0.03);
    });

    it('notes drawn with the render extents do not overlap each other', () => {
      expect(noteOverlapAreaFraction(result)).toBeLessThanOrEqual(0.005);
    });
  });
}

checkPack(
  'PLN 1 m^2 densest (repro case)',
  makeReq({ currencyCode: 'PLN', areaTenths: 10, mode: 'densest' }),
);
checkPack(
  'PLN 4 m^2 cheapest',
  makeReq({ currencyCode: 'PLN', areaTenths: 40, mode: 'cheapest' }),
);
checkPack(
  'USD 2 m^2 densest',
  makeReq({ currencyCode: 'USD', areaTenths: 20, mode: 'densest', plnPerMinor: 0.04 }),
);
