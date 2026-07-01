// d3-zoom integration. The zoom transform is applied ONLY at paint time as a
// single ctx.drawImage blit of the pre-rendered buffer (see draw.ts) - pan/zoom
// never re-tessellates the layout.
import type { Selection } from 'd3-selection';
import { zoom as d3zoom, type ZoomBehavior, type D3ZoomEvent, type ZoomTransform } from 'd3-zoom';

import type { BufferView, Canvas2DContext } from './draw';

export interface AttachZoomOptions {
  scaleExtent?: [number, number];
  translateExtent?: [[number, number], [number, number]];
}

/**
 * Binds a d3-zoom behavior to `overlaySel` (a transparent element sitting atop
 * the visible canvas) and invokes `onTransform` on every start/zoom/end event.
 * Returns the zoom behavior so callers can drive it programmatically (e.g.
 * `zoomBehavior.transform(overlaySel, initialTransform)` to set an initial fit).
 */
export function attachZoom<ZoomRefElement extends Element, Datum>(
  overlaySel: Selection<ZoomRefElement, Datum, any, any>,
  onTransform: (transform: ZoomTransform, event: D3ZoomEvent<ZoomRefElement, Datum>) => void,
  opts: AttachZoomOptions = {},
): ZoomBehavior<ZoomRefElement, Datum> {
  const behavior = d3zoom<ZoomRefElement, Datum>()
    .scaleExtent(opts.scaleExtent ?? [0.5, 40])
    .translateExtent(
      opts.translateExtent ?? [
        [-Infinity, -Infinity],
        [Infinity, Infinity],
      ],
    )
    .on('start zoom end', (event: D3ZoomEvent<ZoomRefElement, Datum>) => {
      onTransform(event.transform, event);
    });

  overlaySel.call(behavior);
  return behavior;
}

/**
 * Clears the visible canvas and blits the offscreen buffer at the current
 * zoom transform in a single drawImage call. Never re-tessellates.
 */
export function paintFrame(
  ctx: Canvas2DContext,
  buffer: HTMLCanvasElement | OffscreenCanvas,
  transform: ZoomTransform,
  devicePixelRatio = 1,
): void {
  const canvas = ctx.canvas as HTMLCanvasElement | OffscreenCanvas;
  const width = canvas.width;
  const height = canvas.height;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.setTransform(
    transform.k * devicePixelRatio,
    0,
    0,
    transform.k * devicePixelRatio,
    transform.x * devicePixelRatio,
    transform.y * devicePixelRatio,
  );
  ctx.drawImage(buffer as CanvasImageSource, 0, 0);
  ctx.restore();
}

/**
 * Maps a world point (fixed-point units) to screen/CSS-pixel space, given the
 * current zoom transform and the buffer's world<->buffer view. Pure - no DOM
 * access, safe to unit test.
 */
export function worldToScreen(
  x: number,
  y: number,
  transform: ZoomTransform,
  view: BufferView,
): [number, number] {
  const bufferX = (x - view.bounds.minX) * view.scale;
  const bufferY = (y - view.bounds.minY) * view.scale;
  return [transform.applyX(bufferX), transform.applyY(bufferY)];
}

/**
 * Inverse of worldToScreen: maps a screen/CSS-pixel point (e.g. a mousemove
 * event relative to the canvas) back to world (fixed-point) coordinates.
 */
export function screenToWorld(
  px: number,
  py: number,
  transform: ZoomTransform,
  view: BufferView,
): [number, number] {
  const bufferX = transform.invertX(px);
  const bufferY = transform.invertY(py);
  return [bufferX / view.scale + view.bounds.minX, bufferY / view.scale + view.bounds.minY];
}
