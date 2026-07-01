// Drives the real rasterizer (renderToBuffer) through a fake 2D context so we
// can assert the sprite path blits images (clipped, rotated for rot===1) while
// denoms without a sprite keep the flat Path2D fill. The vitest env is `node`,
// so Path2D / canvas globals don't exist — we stub the minimum the renderer
// touches.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { DenomRef, PackGeometry, PackResult } from '@/lib/packer/types';
import { renderToBuffer } from '@/lib/render/draw';
import type { SpriteMap } from '@/lib/render/sprites';

const CTX_METHODS = [
  'save', 'restore', 'setTransform', 'clearRect', 'fillRect',
  'beginPath', 'roundRect', 'arc', 'moveTo', 'lineTo', 'clip',
  'translate', 'rotate', 'scale', 'drawImage', 'fill', 'stroke',
  'fillText', 'createLinearGradient', 'createRadialGradient',
] as const;

function makeCtx() {
  const ctx: Record<string, unknown> = {
    fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '', lineWidth: 1,
  };
  for (const m of CTX_METHODS) ctx[m] = vi.fn();
  return ctx as Record<string, ReturnType<typeof vi.fn>> & { fillStyle: string };
}

function makeCanvas(ctx: unknown) {
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function denomRef(p: Partial<DenomRef>): DenomRef {
  return {
    currencyCode: 'USD', label: '$1', color: '#85BB65',
    kind: 'note', minorValue: 100, minorDigits: 2, ...p,
  };
}

interface Piece {
  kind: 0 | 1; denom: number;
  x: number; y: number; w?: number; h?: number; r?: number; rot?: 0 | 1;
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
    mode: 'densest', currencyCode: 'USD', roomSideUnits: 100000, roomAreaM2: 1,
    denomTable, geometry, pieceCount: n, coverage: 0.5, totalValueMinor: 0, totalPLN: 0,
    perDenom: [], capped: false, extrapolationFactor: 1, fxSnapshotId: 't', fxStale: false,
    datasetVersion: 1, candidateId: 0, scoreKeyHi: 0, scoreKeyLo: 0,
  };
}

beforeAll(() => {
  // Minimal Path2D so the flat-fill branch (which builds a Path2D) works.
  (globalThis as { Path2D?: unknown }).Path2D = class {
    roundRect() {}
    moveTo() {}
    arc() {}
  };
});
afterAll(() => {
  delete (globalThis as { Path2D?: unknown }).Path2D;
});

describe('renderToBuffer sprite path', () => {
  const NOTE_W = 15600; // 156mm in 1/100mm
  const NOTE_H = 6630; // 66.3mm

  it('blits an image for a denom with a sprite and never fills it', () => {
    const table = [denomRef({ image: '/currency/usd/note-1.jpg' })];
    const result = makeResult(table, [
      { kind: 0, denom: 0, x: 1000, y: 1000, w: NOTE_W, h: NOTE_H, rot: 0 },
      { kind: 0, denom: 0, x: 1000, y: 9000, w: NOTE_W, h: NOTE_H, rot: 0 },
    ]);
    const ctx = makeCtx();
    const img = { tag: 'img' };
    const sprites: SpriteMap = new Map([[0, img as unknown as CanvasImageSource]]);

    renderToBuffer(result, makeCanvas(ctx), { sprites });

    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    expect(ctx.drawImage.mock.calls[0][0]).toBe(img);
    expect(ctx.clip).toHaveBeenCalled();
    expect(ctx.fill).not.toHaveBeenCalled(); // no flat fill for a sprite denom
  });

  it('rotates the image 90° for a note placed rotated (rot===1)', () => {
    const table = [denomRef({ image: '/currency/usd/note-1.jpg' })];
    const result = makeResult(table, [
      { kind: 0, denom: 0, x: 1000, y: 1000, w: NOTE_H, h: NOTE_W, rot: 1 }, // effective portrait
    ]);
    const ctx = makeCtx();
    const sprites: SpriteMap = new Map([[0, {} as unknown as CanvasImageSource]]);

    renderToBuffer(result, makeCanvas(ctx), { sprites });

    expect(ctx.rotate).toHaveBeenCalledTimes(1);
    expect(ctx.rotate.mock.calls[0][0]).toBeCloseTo(Math.PI / 2);
    expect(ctx.translate).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  });

  it('does not rotate/translate for a non-rotated note', () => {
    const table = [denomRef({ image: '/currency/usd/note-1.jpg' })];
    const result = makeResult(table, [
      { kind: 0, denom: 0, x: 1000, y: 1000, w: NOTE_W, h: NOTE_H, rot: 0 },
    ]);
    const ctx = makeCtx();
    renderToBuffer(result, makeCanvas(ctx), {
      sprites: new Map([[0, {} as unknown as CanvasImageSource]]),
    });
    expect(ctx.rotate).not.toHaveBeenCalled();
    expect(ctx.translate).not.toHaveBeenCalled();
  });

  it('clips coins to a circle and blits the image', () => {
    const table = [denomRef({ kind: 'coin', label: '1c', minorValue: 1, image: '/currency/usd/coin-1c.png' })];
    const result = makeResult(table, [{ kind: 1, denom: 0, x: 5000, y: 5000, r: 900 }]);
    const ctx = makeCtx();
    renderToBuffer(result, makeCanvas(ctx), {
      sprites: new Map([[0, {} as unknown as CanvasImageSource]]),
    });
    expect(ctx.arc).toHaveBeenCalled();
    expect(ctx.clip).toHaveBeenCalled();
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
  });

  it('falls back to the flat fill for denoms without a sprite', () => {
    const table = [
      denomRef({ image: '/currency/usd/note-1.jpg' }),
      denomRef({ label: '$5', minorValue: 500 }), // no image
    ];
    const result = makeResult(table, [
      { kind: 0, denom: 0, x: 1000, y: 1000, w: NOTE_W, h: NOTE_H, rot: 0 },
      { kind: 0, denom: 1, x: 1000, y: 9000, w: NOTE_W, h: NOTE_H, rot: 0 },
    ]);
    const ctx = makeCtx();
    renderToBuffer(result, makeCanvas(ctx), {
      sprites: new Map([[0, {} as unknown as CanvasImageSource]]),
    });
    expect(ctx.drawImage).toHaveBeenCalledTimes(1); // only the sprite denom
    expect(ctx.fill).toHaveBeenCalledTimes(1); // only the flat-fill denom
  });

  it('draws no images at all when no sprites option is given', () => {
    const table = [denomRef({ image: '/currency/usd/note-1.jpg' })];
    const result = makeResult(table, [
      { kind: 0, denom: 0, x: 1000, y: 1000, w: NOTE_W, h: NOTE_H, rot: 0 },
    ]);
    const ctx = makeCtx();
    renderToBuffer(result, makeCanvas(ctx), {});
    expect(ctx.drawImage).not.toHaveBeenCalled();
    expect(ctx.fill).toHaveBeenCalledTimes(1);
  });
});
