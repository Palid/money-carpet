// The core rasterizer: draws a PackResult ONCE to an offscreen buffer canvas
// at a fixed world->buffer scale. Pan/zoom never re-tessellates - see zoom.ts,
// which only blits this buffer with a d3-zoom transform.
//
// Coordinates in `result.geometry` are fixed-point i32 in 1/100mm (FP, see
// lib/config/constants.ts). Notes: (x,y) is TOP-LEFT; coins: (x,y) is CENTER.
import { UNITS_PER_M } from '@/lib/config/constants';
import type { DenomRef, PackResult } from '@/lib/packer/types';

/** Either a real <canvas> 2D context or an OffscreenCanvas 2D context. */
export type Canvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const DEFAULT_BUFFER_PIXELS_PER_METER = 400;
export const DEFAULT_MAX_BUFFER_PIXELS = 4096;
export const DEFAULT_CHUNK_SIZE = 3000;

export interface BufferBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface BufferView {
  bounds: BufferBounds;
  /** Buffer pixels per world unit (1/100mm). */
  scale: number;
  bufferWidth: number;
  bufferHeight: number;
}

export interface RenderOptions {
  /** Max buffer canvas side length, in pixels. Defaults to DEFAULT_MAX_BUFFER_PIXELS. */
  maxPixels?: number;
  /** Draw denom label text + sheen gradient. Off (flat fill only) when dense/zoomed-out. */
  detail?: boolean;
  backgroundColor?: string;
  /** Pieces drawn per animation frame in renderToBufferChunked. */
  chunkSize?: number;
}

export interface ChunkedRenderHandle {
  cancel(): void;
}

// ---------------------------------------------------------------------------
// Pure world<->buffer transform math
// ---------------------------------------------------------------------------

/** Room bounds, in world units, that the buffer canvas is sized to. */
export function bufferBounds(result: PackResult): BufferBounds {
  const side = Math.max(result.roomSideUnits, 1);
  return { minX: 0, minY: 0, maxX: side, maxY: side, width: side, height: side };
}

/**
 * Picks a world->buffer scale (buffer pixels per world unit) for a square
 * room of side `roomSideUnits`, capped so the buffer's side never exceeds
 * `maxPixels`.
 */
export function computeBufferScale(
  roomSideUnits: number,
  maxPixels: number,
): { scale: number; bufferSide: number } {
  const side = Math.max(roomSideUnits, 1);
  const budget = Math.max(1, Math.floor(maxPixels));
  const desiredScale = DEFAULT_BUFFER_PIXELS_PER_METER / UNITS_PER_M;
  const desiredSide = side * desiredScale;
  const bufferSide = Math.max(1, Math.min(Math.round(desiredSide), budget));
  const scale = bufferSide / side;
  return { scale, bufferSide };
}

export function computeBufferView(
  result: PackResult,
  maxPixels: number = DEFAULT_MAX_BUFFER_PIXELS,
): BufferView {
  const bounds = bufferBounds(result);
  const { scale, bufferSide } = computeBufferScale(bounds.width, maxPixels);
  return { bounds, scale, bufferWidth: bufferSide, bufferHeight: bufferSide };
}

export function worldToBuffer(x: number, y: number, view: BufferView): [number, number] {
  return [(x - view.bounds.minX) * view.scale, (y - view.bounds.minY) * view.scale];
}

// ---------------------------------------------------------------------------
// Shared per-piece geometry helpers (used by both the rasterizer and
// tooltip.ts's hit-testing, so the two stay in agreement).
// ---------------------------------------------------------------------------

/** rot=1 swaps the note's footprint (portrait/landscape), anchored at the same top-left. */
export function noteEffectiveExtent(wUnits: number, hUnits: number, rot: number): [number, number] {
  return rot === 1 ? [hUnits, wUnits] : [wUnits, hUnits];
}

export function pieceCenter(result: PackResult, index: number): [number, number] {
  const { geometry } = result;
  if (geometry.kind[index] === 1) {
    return [geometry.x[index], geometry.y[index]];
  }
  const [ew, eh] = noteEffectiveExtent(geometry.w[index], geometry.h[index], geometry.rot[index]);
  return [geometry.x[index] + ew / 2, geometry.y[index] + eh / 2];
}

export function pieceContainsPoint(
  result: PackResult,
  index: number,
  worldX: number,
  worldY: number,
): boolean {
  const { geometry } = result;
  if (geometry.kind[index] === 1) {
    const dx = worldX - geometry.x[index];
    const dy = worldY - geometry.y[index];
    const rr = geometry.r[index];
    return dx * dx + dy * dy <= rr * rr;
  }
  const [ew, eh] = noteEffectiveExtent(geometry.w[index], geometry.h[index], geometry.rot[index]);
  const x0 = geometry.x[index];
  const y0 = geometry.y[index];
  return worldX >= x0 && worldX <= x0 + ew && worldY >= y0 && worldY <= y0 + eh;
}

// ---------------------------------------------------------------------------
// Rasterization
// ---------------------------------------------------------------------------

function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

function getContext2D(canvas: HTMLCanvasElement | OffscreenCanvas): Canvas2DContext | null {
  if (hasOffscreenCanvas() && canvas instanceof OffscreenCanvas) {
    return canvas.getContext('2d');
  }
  return (canvas as HTMLCanvasElement).getContext('2d');
}

function clearCanvas(ctx: Canvas2DContext, view: BufferView, backgroundColor?: string): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.bufferWidth, view.bufferHeight);
  if (backgroundColor) {
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, view.bufferWidth, view.bufferHeight);
  }
  ctx.restore();
}

/** Draws detail-mode sheen gradient + denom label text for one piece. Not batched (per-piece gradient). */
function drawPieceDetail(
  ctx: Canvas2DContext,
  result: PackResult,
  view: BufferView,
  index: number,
  spec: DenomRef,
): void {
  const { geometry } = result;
  const { scale, bounds } = view;
  if (geometry.kind[index] === 0) {
    const [ew, eh] = noteEffectiveExtent(geometry.w[index], geometry.h[index], geometry.rot[index]);
    const px = (geometry.x[index] - bounds.minX) * scale;
    const py = (geometry.y[index] - bounds.minY) * scale;
    const ww = ew * scale;
    const hh = eh * scale;
    const gradient = ctx.createLinearGradient(px, py, px + ww, py + hh);
    gradient.addColorStop(0, 'rgba(255,255,255,0.28)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0)');
    gradient.addColorStop(1, 'rgba(255,255,255,0.14)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(px, py, ww, hh, Math.min(ww, hh) * 0.12);
    ctx.fill();

    const fontSize = Math.max(8, Math.min(ww, hh) * 0.28);
    ctx.fillStyle = '#ffffff';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.label, px + ww / 2, py + hh / 2);
  } else {
    const cx = (geometry.x[index] - bounds.minX) * scale;
    const cy = (geometry.y[index] - bounds.minY) * scale;
    const radius = geometry.r[index] * scale;
    const gradient = ctx.createRadialGradient(
      cx - radius * 0.3,
      cy - radius * 0.3,
      Math.max(radius * 0.1, 0.01),
      cx,
      cy,
      radius,
    );
    gradient.addColorStop(0, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    const fontSize = Math.max(6, radius * 0.6);
    ctx.fillStyle = '#3a2f00';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.label, cx, cy);
  }
}

/** Draws pieces [start,end) of `result`, batched by denom to minimize context state changes. */
function drawRange(
  ctx: Canvas2DContext,
  result: PackResult,
  view: BufferView,
  start: number,
  end: number,
  opts: RenderOptions,
): void {
  const { geometry, denomTable } = result;
  const { kind, x, y, w, h, r, rot, denom } = geometry;
  const { scale, bounds } = view;

  const groups = new Map<number, number[]>();
  for (let i = start; i < end; i++) {
    const d = denom[i];
    let indices = groups.get(d);
    if (!indices) {
      indices = [];
      groups.set(d, indices);
    }
    indices.push(i);
  }

  for (const [denomIdx, indices] of groups) {
    const spec = denomTable[denomIdx];
    if (!spec) continue;

    const path = new Path2D();
    for (const i of indices) {
      if (kind[i] === 0) {
        const [ew, eh] = noteEffectiveExtent(w[i], h[i], rot[i]);
        const px = (x[i] - bounds.minX) * scale;
        const py = (y[i] - bounds.minY) * scale;
        const ww = ew * scale;
        const hh = eh * scale;
        path.roundRect(px, py, ww, hh, Math.min(ww, hh) * 0.12);
      } else {
        const cx = (x[i] - bounds.minX) * scale;
        const cy = (y[i] - bounds.minY) * scale;
        const radius = r[i] * scale;
        path.moveTo(cx + radius, cy);
        path.arc(cx, cy, radius, 0, Math.PI * 2);
      }
    }
    ctx.fillStyle = spec.color;
    ctx.fill(path);

    if (opts.detail) {
      for (const i of indices) {
        drawPieceDetail(ctx, result, view, i, spec);
      }
    }
  }
}

/** Draws the whole layout once, synchronously, to `bufferCanvas`. Returns the view used. */
export function renderToBuffer(
  result: PackResult,
  bufferCanvas: HTMLCanvasElement | OffscreenCanvas,
  opts: RenderOptions = {},
): BufferView {
  const view = computeBufferView(result, opts.maxPixels ?? DEFAULT_MAX_BUFFER_PIXELS);
  bufferCanvas.width = view.bufferWidth;
  bufferCanvas.height = view.bufferHeight;

  const ctx = getContext2D(bufferCanvas);
  if (!ctx) return view;

  clearCanvas(ctx, view, opts.backgroundColor);
  drawRange(ctx, result, view, 0, result.geometry.count, opts);
  return view;
}

/**
 * Draws the layout in chunks across animation frames so the main thread never
 * janks on the first draw. Falls back to a synchronous draw when
 * requestAnimationFrame doesn't exist (e.g. in non-DOM/test environments).
 */
export function renderToBufferChunked(
  result: PackResult,
  bufferCanvas: HTMLCanvasElement | OffscreenCanvas,
  opts: RenderOptions = {},
  onProgress?: (fraction: number) => void,
): ChunkedRenderHandle {
  const view = computeBufferView(result, opts.maxPixels ?? DEFAULT_MAX_BUFFER_PIXELS);
  bufferCanvas.width = view.bufferWidth;
  bufferCanvas.height = view.bufferHeight;

  const ctx = getContext2D(bufferCanvas);
  const count = result.geometry.count;
  let cancelled = false;
  let rafId: number | null = null;

  if (!ctx || count === 0) {
    onProgress?.(1);
    return {
      cancel() {
        cancelled = true;
      },
    };
  }

  clearCanvas(ctx, view, opts.backgroundColor);

  const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const hasRaf = typeof requestAnimationFrame === 'function';

  function step(start: number): void {
    if (cancelled) return;
    const end = Math.min(count, start + chunkSize);
    drawRange(ctx as Canvas2DContext, result, view, start, end, opts);
    onProgress?.(end / count);
    if (end < count) {
      if (hasRaf) {
        rafId = requestAnimationFrame(() => step(end));
      } else {
        step(end);
      }
    }
  }

  step(0);

  return {
    cancel() {
      cancelled = true;
      if (rafId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
    },
  };
}
