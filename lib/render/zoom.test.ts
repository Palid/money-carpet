import { describe, expect, it } from 'vitest';
import { ZoomTransform, zoomIdentity } from 'd3-zoom';

import { bufferBounds, computeBufferScale, computeBufferView, worldToBuffer } from './draw';
import { makeSyntheticResult } from './synthetic';
import { screenToWorld, worldToScreen } from './zoom';

describe('screenToWorld / worldToScreen round trip', () => {
  const result = makeSyntheticResult({ pieceCount: 50, roomAreaM2: 4, seed: 3 });
  const view = computeBufferView(result, 2048);

  const transforms: ZoomTransform[] = [
    zoomIdentity,
    new ZoomTransform(2, 40, -15),
    new ZoomTransform(0.5, -100, 250),
    zoomIdentity.scale(3).translate(12, 34),
    new ZoomTransform(8, -1234.5, 987.6),
  ];

  for (const t of transforms) {
    it(`is identity for k=${t.k} x=${t.x} y=${t.y}`, () => {
      const worldX = 12_345;
      const worldY = 67_890;

      const [sx, sy] = worldToScreen(worldX, worldY, t, view);
      const [wx, wy] = screenToWorld(sx, sy, t, view);

      expect(wx).toBeCloseTo(worldX, 3);
      expect(wy).toBeCloseTo(worldY, 3);
    });
  }

  it('also round-trips for a point at the world origin', () => {
    const t = new ZoomTransform(1.7, 5, -5);
    const [sx, sy] = worldToScreen(0, 0, t, view);
    const [wx, wy] = screenToWorld(sx, sy, t, view);
    expect(wx).toBeCloseTo(0, 3);
    expect(wy).toBeCloseTo(0, 3);
  });
});

describe('computeBufferScale', () => {
  it('never lets the buffer side exceed the max pixel budget', () => {
    const { scale, bufferSide } = computeBufferScale(500_000, 1024);
    expect(bufferSide).toBeLessThanOrEqual(1024);
    expect(scale).toBeGreaterThan(0);
  });

  it('uses less than the budget when the room is small relative to it', () => {
    const { bufferSide } = computeBufferScale(1_000, 4096);
    expect(bufferSide).toBeLessThanOrEqual(4096);
    expect(bufferSide).toBeGreaterThan(0);
  });

  it('respects the budget across a range of room sizes', () => {
    for (const roomSideUnits of [100, 10_000, 316_228, 1_000_000, 3_162_278]) {
      const { bufferSide } = computeBufferScale(roomSideUnits, 2048);
      expect(bufferSide).toBeLessThanOrEqual(2048);
    }
  });
});

describe('worldToBuffer', () => {
  it('maps room corners to buffer corners', () => {
    const result = makeSyntheticResult({ pieceCount: 20, roomAreaM2: 4, seed: 7 });
    const bounds = bufferBounds(result);
    const view = computeBufferView(result, 2048);

    const [x0, y0] = worldToBuffer(bounds.minX, bounds.minY, view);
    expect(x0).toBeCloseTo(0, 6);
    expect(y0).toBeCloseTo(0, 6);

    const [x1, y1] = worldToBuffer(bounds.maxX, bounds.maxY, view);
    expect(x1).toBeCloseTo(view.bufferWidth, 3);
    expect(y1).toBeCloseTo(view.bufferHeight, 3);
  });

  it('maps the room center to the buffer center', () => {
    const result = makeSyntheticResult({ pieceCount: 20, roomAreaM2: 9, seed: 8 });
    const bounds = bufferBounds(result);
    const view = computeBufferView(result, 4096);

    const midX = (bounds.minX + bounds.maxX) / 2;
    const midY = (bounds.minY + bounds.maxY) / 2;
    const [bx, by] = worldToBuffer(midX, midY, view);

    expect(bx).toBeCloseTo(view.bufferWidth / 2, 3);
    expect(by).toBeCloseTo(view.bufferHeight / 2, 3);
  });
});
