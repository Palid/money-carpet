'use client';

import * as React from 'react';
import { select } from 'd3-selection';
import { zoomIdentity, ZoomTransform, type ZoomBehavior } from 'd3-zoom';
import type { Quadtree } from 'd3-quadtree';

import type { PackResult } from '@/lib/packer/types';
import {
  computeBufferView,
  computeViewportView,
  renderToBufferChunked,
  renderViewport,
  type BufferView,
  type ChunkedRenderHandle,
} from '@/lib/render/draw';
import { attachZoom, paintFrame, screenToWorld } from '@/lib/render/zoom';
import { buildQuadtree, pick, type PickResult } from '@/lib/render/tooltip';
import { loadSprites, type SpriteMap } from '@/lib/render/sprites';
import { cn } from '@/lib/utils';

export interface PackingCanvasProps {
  result: PackResult;
  /** Draw denom labels + sheen when true; caller decides based on zoom level / sparsity. */
  detail?: boolean;
  /** Blit official currency images (where available) instead of flat fills. */
  useImages?: boolean;
  className?: string;
  /** Max offscreen buffer side in device pixels (perf/memory budget). Defaults to draw.ts's default. */
  maxBufferPixels?: number;
}

interface TooltipState {
  screenX: number;
  screenY: number;
  info: PickResult;
}

/** Latest inputs a sharp (viewport) render reads, kept in a ref so the once-attached zoom handler stays stable. */
interface SharpConfig {
  result: PackResult;
  detail: boolean;
  sprites: SpriteMap | undefined;
}

/** Debounce before a sharp re-render fires while the user is still interacting. */
const SHARP_SETTLE_MS = 140;
/**
 * When transform.k * dpr exceeds this, the static room buffer is being magnified
 * past its own resolution, so a device-resolution viewport re-render is worth it.
 * At or below it the static buffer already meets/exceeds the screen.
 */
const SHARP_MIN_DEVICE_SCALE = 1 + 1e-3;

/** Scale+center the buffer so it fits entirely inside the visible CSS box. */
function computeFitTransform(view: BufferView, cssWidth: number, cssHeight: number): ZoomTransform {
  if (cssWidth <= 0 || cssHeight <= 0 || view.bufferWidth <= 0 || view.bufferHeight <= 0) {
    return zoomIdentity;
  }
  const k = Math.min(cssWidth / view.bufferWidth, cssHeight / view.bufferHeight);
  const x = (cssWidth - view.bufferWidth * k) / 2;
  const y = (cssHeight - view.bufferHeight * k) / 2;
  return new ZoomTransform(k, x, y);
}

/**
 * Renders a PackResult to canvas: draws the whole layout once to an offscreen
 * buffer (chunked across rAFs so the first draw never janks), then pans/zooms
 * via d3-zoom by blitting that buffer - never re-tessellating on interaction.
 */
export function PackingCanvas({ result, detail = false, useImages = false, className, maxBufferPixels }: PackingCanvasProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const overlayRef = React.useRef<HTMLDivElement | null>(null);

  const bufferRef = React.useRef<HTMLCanvasElement | OffscreenCanvas | null>(null);
  const viewRef = React.useRef<BufferView | null>(null);
  const quadtreeRef = React.useRef<Quadtree<number> | null>(null);
  const transformRef = React.useRef<ZoomTransform>(zoomIdentity);
  const zoomBehaviorRef = React.useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null);
  const dprRef = React.useRef(1);
  const rafRef = React.useRef<number | null>(null);
  const cssSizeRef = React.useRef({ width: 0, height: 0 });
  const chunkedHandleRef = React.useRef<ChunkedRenderHandle | null>(null);
  const hasFitRef = React.useRef(false);
  const prevResultRef = React.useRef<PackResult | null>(null);

  // --- Sharp "settle" render: one reused viewport-sized detail canvas, plus a
  // monotonically increasing token so a newer zoom event supersedes any pending
  // or in-flight sharp render (stale tokens are ignored). ---
  const detailCanvasRef = React.useRef<HTMLCanvasElement | OffscreenCanvas | null>(null);
  const sharpConfigRef = React.useRef<SharpConfig | null>(null);
  const sharpTokenRef = React.useRef(0);
  const sharpTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const sharpRafRef = React.useRef<number | null>(null);

  const [tooltip, setTooltip] = React.useState<TooltipState | null>(null);
  const [sprites, setSprites] = React.useState<SpriteMap | null>(null);

  const schedulePaint = React.useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      const buffer = bufferRef.current;
      if (!canvas || !buffer) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // Crisp downsample when the buffer is larger than the on-screen area
      // (zoomed out); harmless when magnifying (the fast preview).
      ctx.imageSmoothingQuality = 'high';
      paintFrame(ctx, buffer, transformRef.current, dprRef.current);
    });
  }, []);

  // Cancels any pending/in-flight sharp render (and invalidates in-flight ones
  // via the token). Called when zooming back out or on teardown.
  const cancelSharpRender = React.useCallback(() => {
    sharpTokenRef.current += 1;
    if (sharpTimerRef.current !== null) {
      clearTimeout(sharpTimerRef.current);
      sharpTimerRef.current = null;
    }
    if (sharpRafRef.current !== null) {
      cancelAnimationFrame(sharpRafRef.current);
      sharpRafRef.current = null;
    }
  }, []);

  // Rasterizes the visible world rect at device resolution into the reused
  // detail canvas and blits it 1:1 over the visible canvas. Runs inside a rAF so
  // it lands AFTER the fast static paint scheduled for the same event. Bails
  // (leaving the already-correct static frame) on any missing input, a 0-size
  // canvas, an empty result, or if superseded by a newer token.
  const performSharpRender = React.useCallback((token: number) => {
    if (sharpRafRef.current !== null) cancelAnimationFrame(sharpRafRef.current);
    sharpRafRef.current = requestAnimationFrame(() => {
      sharpRafRef.current = null;
      if (token !== sharpTokenRef.current) return; // superseded

      const cfg = sharpConfigRef.current;
      const canvas = canvasRef.current;
      const staticView = viewRef.current;
      const detailCanvas = detailCanvasRef.current;
      if (!cfg || !canvas || !staticView || !detailCanvas) return;

      const transform = transformRef.current;
      const dpr = dprRef.current;
      if (transform.k * dpr <= SHARP_MIN_DEVICE_SCALE) return; // zoomed out; static buffer suffices

      const deviceWidth = canvas.width;
      const deviceHeight = canvas.height;
      if (deviceWidth <= 0 || deviceHeight <= 0) return;
      if (cfg.result.geometry.count === 0) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      try {
        const viewportView = computeViewportView(staticView, transform, deviceWidth, deviceHeight, dpr);
        if (viewportView.bufferWidth <= 0 || viewportView.bufferHeight <= 0) return;
        renderViewport(cfg.result, detailCanvas, viewportView, { detail: cfg.detail, sprites: cfg.sprites });
        if (token !== sharpTokenRef.current) return; // a newer event landed while rendering
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(detailCanvas as CanvasImageSource, 0, 0);
      } catch {
        // Sharp path unavailable/failed - the fast static frame already painted
        // this transform, so leave it as-is (no visual regression).
      }
    });
  }, []);

  // (Re)schedules a sharp render, superseding any older one via a fresh token.
  // `immediate` (the d3 'end' event) skips the settle debounce.
  const requestSharpRender = React.useCallback(
    (immediate: boolean) => {
      const token = ++sharpTokenRef.current;
      if (sharpTimerRef.current !== null) {
        clearTimeout(sharpTimerRef.current);
        sharpTimerRef.current = null;
      }
      if (immediate) {
        performSharpRender(token);
      } else {
        sharpTimerRef.current = setTimeout(() => {
          sharpTimerRef.current = null;
          performSharpRender(token);
        }, SHARP_SETTLE_MS);
      }
    },
    [performSharpRender],
  );

  // Fits + clamps the zoom behavior to the current buffer/container size, and
  // (once) sets an initial transform that frames the whole room.
  const applyFitIfReady = React.useCallback(() => {
    const view = viewRef.current;
    const overlay = overlayRef.current;
    const behavior = zoomBehaviorRef.current;
    const { width, height } = cssSizeRef.current;
    if (!view || !overlay || !behavior || width <= 0 || height <= 0) return;

    behavior.translateExtent([
      [0, 0],
      [view.bufferWidth, view.bufferHeight],
    ]);
    const fitK = Math.min(width / view.bufferWidth, height / view.bufferHeight) || 1;
    behavior.scaleExtent([Math.min(0.1, fitK * 0.25), Math.max(40, fitK * 8)]);

    if (!hasFitRef.current) {
      hasFitRef.current = true;
      const fitTransform = computeFitTransform(view, width, height);
      behavior.transform(select<HTMLDivElement, unknown>(overlay), fitTransform);
    }
  }, []);

  const resizeCanvas = React.useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    cssSizeRef.current = { width, height };

    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    applyFitIfReady();
    schedulePaint();
    // The visible canvas just resized; refresh the sharp frame if zoomed in.
    if (transformRef.current.k * dprRef.current > SHARP_MIN_DEVICE_SCALE) {
      requestSharpRender(false);
    }
  }, [applyFitIfReady, schedulePaint, requestSharpRender]);

  // Attach the d3-zoom behavior to the overlay once on mount, and allocate the
  // one reused (viewport-sized, NOT room-sized) detail canvas for sharp renders.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    detailCanvasRef.current =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');

    const behavior = attachZoom<HTMLDivElement, unknown>(
      select<HTMLDivElement, unknown>(overlay),
      (transform, event) => {
        transformRef.current = transform;
        // Fast, responsive preview on every event: blit the static buffer.
        schedulePaint();
        // Once magnified past the static buffer's resolution, schedule a sharp
        // device-resolution re-render (debounced, plus immediately on 'end').
        // When zoomed out the static buffer already suffices - drop any pending.
        if (transform.k * dprRef.current > SHARP_MIN_DEVICE_SCALE) {
          requestSharpRender(event.type === 'end');
        } else {
          cancelSharpRender();
        }
      },
    );
    zoomBehaviorRef.current = behavior;

    return () => {
      select(overlay).on('.zoom', null);
      zoomBehaviorRef.current = null;
      cancelSharpRender();
      detailCanvasRef.current = null;
    };
  }, [schedulePaint, requestSharpRender, cancelSharpRender]);

  // Keep the sharp-render inputs current for the once-attached zoom handler.
  React.useEffect(() => {
    sharpConfigRef.current = {
      result,
      detail,
      sprites: useImages ? sprites ?? undefined : undefined,
    };
  }, [result, detail, useImages, sprites]);

  // Keep the visible canvas sized (DPR-aware) to its container.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;

    resizeCanvas();
    const observer = new ResizeObserver(() => resizeCanvas());
    observer.observe(container);
    return () => observer.disconnect();
  }, [resizeCanvas]);

  // Load official currency images when enabled; clear them when disabled. The
  // packing itself is unaffected — this only changes what the rasterizer blits.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!useImages) {
      setSprites(null);
      return;
    }
    const controller = new AbortController();
    loadSprites(result, controller.signal).then((map) => {
      if (!controller.signal.aborted) setSprites(map);
    });
    return () => controller.abort();
  }, [useImages, result]);

  // Rebuild the offscreen buffer + quadtree whenever the result, detail, or the
  // loaded sprites change. Re-framing (fit) only resets on a genuinely new
  // result, so toggling images or having them finish loading preserves the
  // user's current pan/zoom.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    chunkedHandleRef.current?.cancel();
    if (prevResultRef.current !== result) {
      prevResultRef.current = result;
      hasFitRef.current = false;
      setTooltip(null);
    }

    const buffer: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    bufferRef.current = buffer;
    quadtreeRef.current = buildQuadtree(result);
    viewRef.current = computeBufferView(result, maxBufferPixels);

    const spriteMap = useImages ? sprites ?? undefined : undefined;
    const handle = renderToBufferChunked(
      result,
      buffer,
      { detail, sprites: spriteMap, maxPixels: maxBufferPixels },
      () => {
        viewRef.current = computeBufferView(result, maxBufferPixels);
        applyFitIfReady();
        schedulePaint();
        // The static repaint above would cover any existing sharp frame; if we're
        // still zoomed in (e.g. sprites just finished loading), re-sharpen.
        if (transformRef.current.k * dprRef.current > SHARP_MIN_DEVICE_SCALE) {
          requestSharpRender(false);
        }
      },
    );
    chunkedHandleRef.current = handle;

    return () => {
      handle.cancel();
    };
  }, [result, detail, useImages, sprites, maxBufferPixels, applyFitIfReady, schedulePaint, requestSharpRender]);

  const handleMouseMove = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const view = viewRef.current;
      const qt = quadtreeRef.current;
      if (!view || !qt) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;
      const [worldX, worldY] = screenToWorld(screenX, screenY, transformRef.current, view);
      const found = pick(qt, worldX, worldY, result);
      setTooltip(found ? { screenX, screenY, info: found } : null);
    },
    [result],
  );

  const handleMouseLeave = React.useCallback(() => setTooltip(null), []);

  return (
    <div ref={containerRef} className={cn('relative h-full w-full overflow-hidden', className)}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      <div
        ref={overlayRef}
        className="absolute inset-0 h-full w-full cursor-grab touch-none active:cursor-grabbing"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />
      {tooltip ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-black/80 px-2 py-1 text-xs text-white shadow"
          style={{ left: tooltip.screenX, top: tooltip.screenY - 8 }}
        >
          {tooltip.info.denom.label} · {tooltip.info.valueLabel}
        </div>
      ) : null}
    </div>
  );
}
