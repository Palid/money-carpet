'use client';

import * as React from 'react';
import { select } from 'd3-selection';
import { zoomIdentity, ZoomTransform, type ZoomBehavior } from 'd3-zoom';
import type { Quadtree } from 'd3-quadtree';

import type { PackResult } from '@/lib/packer/types';
import {
  computeBufferView,
  renderToBufferChunked,
  type BufferView,
  type ChunkedRenderHandle,
} from '@/lib/render/draw';
import { attachZoom, paintFrame, screenToWorld } from '@/lib/render/zoom';
import { buildQuadtree, pick, type PickResult } from '@/lib/render/tooltip';
import { cn } from '@/lib/utils';

export interface PackingCanvasProps {
  result: PackResult;
  /** Draw denom labels + sheen when true; caller decides based on zoom level / sparsity. */
  detail?: boolean;
  className?: string;
  /** Max offscreen buffer side in device pixels (perf/memory budget). Defaults to draw.ts's default. */
  maxBufferPixels?: number;
}

interface TooltipState {
  screenX: number;
  screenY: number;
  info: PickResult;
}

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
export function PackingCanvas({ result, detail = false, className, maxBufferPixels }: PackingCanvasProps) {
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

  const [tooltip, setTooltip] = React.useState<TooltipState | null>(null);

  const schedulePaint = React.useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const canvas = canvasRef.current;
      const buffer = bufferRef.current;
      if (!canvas || !buffer) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      paintFrame(ctx, buffer, transformRef.current, dprRef.current);
    });
  }, []);

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
  }, [applyFitIfReady, schedulePaint]);

  // Attach the d3-zoom behavior to the overlay once on mount.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    const behavior = attachZoom<HTMLDivElement, unknown>(select<HTMLDivElement, unknown>(overlay), (transform) => {
      transformRef.current = transform;
      schedulePaint();
    });
    zoomBehaviorRef.current = behavior;

    return () => {
      select(overlay).on('.zoom', null);
      zoomBehaviorRef.current = null;
    };
  }, [schedulePaint]);

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

  // Rebuild the offscreen buffer + quadtree whenever the result (or detail) changes.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    chunkedHandleRef.current?.cancel();
    hasFitRef.current = false;
    setTooltip(null);

    const buffer: HTMLCanvasElement | OffscreenCanvas =
      typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    bufferRef.current = buffer;
    quadtreeRef.current = buildQuadtree(result);
    viewRef.current = computeBufferView(result, maxBufferPixels);

    const handle = renderToBufferChunked(result, buffer, { detail, maxPixels: maxBufferPixels }, () => {
      viewRef.current = computeBufferView(result, maxBufferPixels);
      applyFitIfReady();
      schedulePaint();
    });
    chunkedHandleRef.current = handle;

    return () => {
      handle.cancel();
    };
  }, [result, detail, maxBufferPixels, applyFitIfReady, schedulePaint]);

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
