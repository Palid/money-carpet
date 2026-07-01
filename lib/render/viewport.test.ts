// Covers the viewport "sharp settle" render helpers added to draw.ts:
//   - computeViewportView: its world->detail-buffer mapping must land on the
//     exact same device pixel paintFrame() produces (the invariant that keeps
//     the sharp render a pure higher-res redraw of the on-screen frame).
//   - pieceIntersectsRect / renderViewport culling: pieces outside the visible
//     world rect must be skipped.
// The vitest env is `node`, so Path2D / canvas globals don't exist — we stub the
// minimum the renderer touches (mirrors draw-sprites.test.ts).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZoomTransform } from 'd3-zoom';

import type { DenomRef, PackGeometry, PackResult } from '@/lib/packer/types';
import {
  computeBufferView,
  computeViewportView,
  pieceIntersectsRect,
  pieceWorldBounds,
  renderViewport,
  type BufferView,
} from '@/lib/render/draw';
import { makeSyntheticResult } from '@/lib/render/synthetic';
import type { SpriteMap } from '@/lib/render/sprites';

// ---------------------------------------------------------------------------
// computeViewportView invariant: detail mapping === paintFrame device mapping
// ---------------------------------------------------------------------------

/** The on-screen device pixel paintFrame() maps world x to (see zoom.ts). */
function paintFrameDeviceX(x: number, staticView: BufferView, t: ZoomTransform, dpr: number): number {
  return (x - staticView.bounds.minX) * staticView.scale * t.k * dpr + t.x * dpr;
}
function paintFrameDeviceY(y: number, staticView: BufferView, t: ZoomTransform, dpr: number): number {
  return (y - staticView.bounds.minY) * staticView.scale * t.k * dpr + t.y * dpr;
}

describe('computeViewportView', () => {
  const result = makeSyntheticResult({ pieceCount: 40, roomAreaM2: 4, seed: 5 });
  const staticView = computeBufferView(result, 2048);

  const cases: Array<{ t: ZoomTransform; dpr: number; xs: number[] }> = [
    { t: new ZoomTransform(5, 120, -60), dpr: 2, xs: [0, 12_345, 199_999, staticView.bounds.maxX] },
    { t: new ZoomTransform(2.5, -400, 250), dpr: 1, xs: [1_000, 50_000, 175_000] },
    { t: new ZoomTransform(12, -1234.5, 987.6), dpr: 3, xs: [0, 80_000, 200_000] },
  ];

  for (const { t, dpr, xs } of cases) {
    it(`maps world -> device exactly like paintFrame (k=${t.k}, dpr=${dpr})`, () => {
      const view = computeViewportView(staticView, t, 800, 600, dpr);
      for (const x of xs) {
        const detailX = (x - view.bounds.minX) * view.scale;
        const deviceX = paintFrameDeviceX(x, staticView, t, dpr);
        expect(Math.abs(detailX - deviceX)).toBeLessThan(1e-6 * (1 + Math.abs(deviceX)));

        const detailY = (x - view.bounds.minY) * view.scale;
        const deviceY = paintFrameDeviceY(x, staticView, t, dpr);
        expect(Math.abs(detailY - deviceY)).toBeLessThan(1e-6 * (1 + Math.abs(deviceY)));
      }
    });
  }

  it('sizes the detail buffer to the rounded device viewport', () => {
    const view = computeViewportView(staticView, new ZoomTransform(4, 10, 20), 801.4, 600.6, 2);
    expect(view.bufferWidth).toBe(801);
    expect(view.bufferHeight).toBe(601);
  });

  it('sets scale = staticScale * k * dpr and a consistent bounds rect', () => {
    const t = new ZoomTransform(3, 40, -15);
    const dpr = 2;
    const view = computeViewportView(staticView, t, 640, 480, dpr);
    expect(view.scale).toBeCloseTo(staticView.scale * t.k * dpr, 12);
    expect(view.bounds.width).toBeCloseTo(640 / view.scale, 6);
    expect(view.bounds.height).toBeCloseTo(480 / view.scale, 6);
    expect(view.bounds.maxX).toBeCloseTo(view.bounds.minX + view.bounds.width, 6);
    expect(view.bounds.maxY).toBeCloseTo(view.bounds.minY + view.bounds.height, 6);
  });
});

// ---------------------------------------------------------------------------
// Cull-rect intersection
// ---------------------------------------------------------------------------

function denomRef(p: Partial<DenomRef>): DenomRef {
  return { currencyCode: 'USD', label: '$1', color: '#85BB65', kind: 'note', minorValue: 100, minorDigits: 2, ...p };
}

interface Piece {
  kind: 0 | 1;
  denom: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
  r?: number;
  rot?: 0 | 1;
}

function makeResult(denomTable: DenomRef[], pieces: Piece[]): PackResult {
  const n = pieces.length;
  const geometry: PackGeometry = {
    count: n,
    kind: Uint8Array.from(pieces.map((p) => p.kind)),
    denom: Uint16Array.from(pieces.map((p) => p.denom)),
    x: Int32Array.from(pieces.map((p) => p.x)),
    y: Int32Array.from(pieces.map((p) => p.y)),
    w: Int32Array.from(pieces.map((p) => p.w ?? 0)),
    h: Int32Array.from(pieces.map((p) => p.h ?? 0)),
    r: Int32Array.from(pieces.map((p) => p.r ?? 0)),
    rot: Uint8Array.from(pieces.map((p) => p.rot ?? 0)),
  };
  return {
    mode: 'densest', currencyCode: 'USD', roomSideUnits: 1_000_000, roomAreaM2: 100,
    denomTable, geometry, pieceCount: n, coverage: 0.5, totalValueMinor: 0, totalPLN: 0,
    perDenom: [], capped: false, extrapolationFactor: 1, fxSnapshotId: 't', fxStale: false,
    datasetVersion: 1, candidateId: 0, scoreKeyHi: 0, scoreKeyLo: 0,
  };
}

const NOTE_W = 15600; // 156mm in 1/100mm
const NOTE_H = 6630; // 66.3mm

describe('pieceWorldBounds / pieceIntersectsRect', () => {
  const rect = { minX: 0, minY: 0, maxX: 20_000, maxY: 20_000, width: 20_000, height: 20_000 };

  it('gives the top-left rect AABB for a note', () => {
    const result = makeResult([denomRef({})], [{ kind: 0, denom: 0, x: 1000, y: 2000, w: NOTE_W, h: NOTE_H }]);
    const b = pieceWorldBounds(result, 0);
    expect(b.minX).toBe(1000);
    expect(b.minY).toBe(2000);
    expect(b.maxX).toBe(1000 + NOTE_W);
    expect(b.maxY).toBe(2000 + NOTE_H);
  });

  it('gives the center +/- r AABB for a coin', () => {
    const result = makeResult([denomRef({ kind: 'coin' })], [{ kind: 1, denom: 0, x: 5000, y: 5000, r: 900 }]);
    const b = pieceWorldBounds(result, 0);
    expect(b.minX).toBe(4100);
    expect(b.maxX).toBe(5900);
    expect(b.minY).toBe(4100);
    expect(b.maxY).toBe(5900);
  });

  it('includes a note inside the rect and excludes one fully outside', () => {
    const result = makeResult(
      [denomRef({})],
      [
        { kind: 0, denom: 0, x: 1000, y: 1000, w: NOTE_W, h: NOTE_H }, // inside
        { kind: 0, denom: 0, x: 500_000, y: 500_000, w: NOTE_W, h: NOTE_H }, // far away
      ],
    );
    expect(pieceIntersectsRect(result, 0, rect)).toBe(true);
    expect(pieceIntersectsRect(result, 1, rect)).toBe(false);
  });

  it('includes a note that only partially overlaps the rect edge', () => {
    // Straddles the right edge (x from 19000 to 19000+NOTE_W, past maxX=20000).
    const result = makeResult([denomRef({})], [{ kind: 0, denom: 0, x: 19_000, y: 1000, w: NOTE_W, h: NOTE_H }]);
    expect(pieceIntersectsRect(result, 0, rect)).toBe(true);
  });

  it('includes a coin whose circle AABB clips the rect and excludes a distant one', () => {
    const result = makeResult(
      [denomRef({ kind: 'coin' })],
      [
        { kind: 1, denom: 0, x: 20_500, y: 10_000, r: 900 }, // center just outside, AABB clips maxX
        { kind: 1, denom: 0, x: 40_000, y: 40_000, r: 900 }, // fully outside
      ],
    );
    expect(pieceIntersectsRect(result, 0, rect)).toBe(true);
    expect(pieceIntersectsRect(result, 1, rect)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderViewport culls out-of-rect pieces from the actual draw path
// ---------------------------------------------------------------------------

const CTX_METHODS = [
  'save', 'restore', 'setTransform', 'clearRect', 'fillRect',
  'beginPath', 'roundRect', 'arc', 'moveTo', 'lineTo', 'clip',
  'translate', 'rotate', 'scale', 'drawImage', 'fill', 'stroke',
  'fillText', 'createLinearGradient', 'createRadialGradient',
] as const;

function makeCtx() {
  const ctx: Record<string, unknown> = {
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '', lineWidth: 1,
    imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
  };
  for (const m of CTX_METHODS) ctx[m] = vi.fn();
  return ctx as Record<string, ReturnType<typeof vi.fn>> & { fillStyle: string; imageSmoothingQuality: string };
}

function makeCanvas(ctx: unknown) {
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

beforeAll(() => {
  (globalThis as { Path2D?: unknown }).Path2D = class {
    roundRect() {}
    moveTo() {}
    arc() {}
  };
});
afterAll(() => {
  delete (globalThis as { Path2D?: unknown }).Path2D;
});

describe('renderViewport', () => {
  // A visible rect covering only the near-origin region (world units).
  const viewportView: BufferView = {
    bounds: { minX: 0, minY: 0, maxX: 20_000, maxY: 20_000, width: 20_000, height: 20_000 },
    scale: 0.01,
    bufferWidth: 200,
    bufferHeight: 200,
  };

  it('sizes the detail canvas, clears it, and requests crisp downscaling', () => {
    const result = makeResult([denomRef({})], [{ kind: 0, denom: 0, x: 1000, y: 1000, w: NOTE_W, h: NOTE_H }]);
    const ctx = makeCtx();
    const canvas = makeCanvas(ctx);
    renderViewport(result, canvas, viewportView, {});
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(200);
    expect(ctx.imageSmoothingQuality).toBe('high');
    expect(ctx.clearRect).toHaveBeenCalled();
  });

  it('fills only the denom whose piece is inside the visible rect', () => {
    const result = makeResult(
      [denomRef({ label: '$1' }), denomRef({ label: '$5', minorValue: 500 })],
      [
        { kind: 0, denom: 0, x: 1000, y: 1000, w: NOTE_W, h: NOTE_H }, // inside -> filled
        { kind: 0, denom: 1, x: 500_000, y: 500_000, w: NOTE_W, h: NOTE_H }, // culled
      ],
    );
    const ctx = makeCtx();
    renderViewport(result, makeCanvas(ctx), viewportView, {});
    expect(ctx.fill).toHaveBeenCalledTimes(1); // the out-of-rect denom is skipped entirely
  });

  it('draws no pieces at all when everything is outside the visible rect', () => {
    const result = makeResult(
      [denomRef({})],
      [{ kind: 0, denom: 0, x: 500_000, y: 500_000, w: NOTE_W, h: NOTE_H }],
    );
    const ctx = makeCtx();
    renderViewport(result, makeCanvas(ctx), viewportView, {});
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it('blits a sprite only for the in-rect piece', () => {
    const result = makeResult(
      [denomRef({ image: '/currency/usd/note-1.jpg' })],
      [
        { kind: 0, denom: 0, x: 1000, y: 1000, w: NOTE_W, h: NOTE_H }, // inside
        { kind: 0, denom: 0, x: 500_000, y: 500_000, w: NOTE_W, h: NOTE_H }, // culled
      ],
    );
    const ctx = makeCtx();
    const sprites: SpriteMap = new Map([[0, { tag: 'img' } as unknown as CanvasImageSource]]);
    renderViewport(result, makeCanvas(ctx), viewportView, { sprites });
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  });
});
