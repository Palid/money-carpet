/**
 * pack.worker.ts — the Web Worker entry for the GPU packer.
 *
 * FROZEN message protocol (the store agent implements the mirror image
 * independently against this exact shape — DO NOT change without coordinating):
 *   // main -> worker:  { kind:'pack', requestId:number, request:PackRequest }
 *   // worker -> main:  { kind:'result', requestId:number, result:PackResult }
 *   //                | { kind:'error',  requestId:number, message:string }
 *   //                | { kind:'unsupported', requestId:number }
 *   //                | { kind:'gpu-lost', requestId:number }
 *
 * Module worker. Import via:
 *   new Worker(new URL('../gpu/pack.worker.ts', import.meta.url), { type: 'module' })
 *
 * The GPU only RANKS candidates; the CPU replayTopK (inside searchAndReplay)
 * produces the authoritative PackResult. GPU-approximated geometry is never sent.
 */

import type { PackRequest, PackResult } from '@/lib/packer/types';
import type { SearchPipeline } from '@/lib/gpu/pipeline';
import { createSearchPipeline } from '@/lib/gpu/pipeline';
import { getGpuDevice, reacquire, onDeviceLost, GpuUnsupportedError } from '@/lib/gpu/device';
import { searchAndReplay } from '@/lib/gpu/runSearch';

// --- FROZEN protocol types (re-exported for consumers via lib/gpu/index.ts) ---
export interface WorkerPackMsg {
  kind: 'pack';
  requestId: number;
  request: PackRequest;
}
export type WorkerRequestMsg = WorkerPackMsg;

export interface WorkerResultMsg {
  kind: 'result';
  requestId: number;
  result: PackResult;
}
export interface WorkerErrorMsg {
  kind: 'error';
  requestId: number;
  message: string;
}
export interface WorkerUnsupportedMsg {
  kind: 'unsupported';
  requestId: number;
}
export interface WorkerGpuLostMsg {
  kind: 'gpu-lost';
  requestId: number;
}
export type WorkerResponseMsg =
  | WorkerResultMsg
  | WorkerErrorMsg
  | WorkerUnsupportedMsg
  | WorkerGpuLostMsg;

// --- worker global scope shim (avoids depending on the WebWorker lib) ---
interface WorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const ctx = globalThis as unknown as WorkerScope;

// --- cached GPU state across messages ---
let gpu: { device: GPUDevice; pipeline: SearchPipeline } | null = null;
let deviceLost = false;

onDeviceLost(() => {
  deviceLost = true;
  gpu = null; // force reacquire on next use
});

async function ensureGpu(forceReacquire = false): Promise<{ device: GPUDevice; pipeline: SearchPipeline }> {
  if (gpu && !forceReacquire) return gpu;
  const device = forceReacquire ? await reacquire() : await getGpuDevice();
  const pipeline = await createSearchPipeline(device);
  deviceLost = false;
  gpu = { device, pipeline };
  return gpu;
}

/** Transferable ArrayBuffers of the SoA geometry (zero-copy hand-off). */
function geometryTransferList(result: PackResult): Transferable[] {
  const g = result.geometry;
  const bufs = [
    g.x.buffer,
    g.y.buffer,
    g.w.buffer,
    g.h.buffer,
    g.r.buffer,
    g.kind.buffer,
    g.denom.buffer,
    g.rot.buffer,
  ];
  return Array.from(new Set(bufs)) as Transferable[];
}

function post(msg: WorkerResponseMsg, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer);
}

async function handlePack(requestId: number, request: PackRequest): Promise<void> {
  try {
    const { device, pipeline } = await ensureGpu();
    const result = await searchAndReplay(device, pipeline, request);
    post({ kind: 'result', requestId, result }, geometryTransferList(result));
  } catch (err) {
    // No GPU at all -> unsupported.
    if (err instanceof GpuUnsupportedError) {
      post({ kind: 'unsupported', requestId });
      return;
    }

    // Device lost mid-run -> attempt ONE reacquire, then retry.
    if (deviceLost || gpu === null) {
      try {
        const { device, pipeline } = await ensureGpu(true);
        const result = await searchAndReplay(device, pipeline, request);
        post({ kind: 'result', requestId, result }, geometryTransferList(result));
        return;
      } catch (retryErr) {
        if (retryErr instanceof GpuUnsupportedError) {
          post({ kind: 'unsupported', requestId });
        } else {
          post({ kind: 'gpu-lost', requestId });
        }
        return;
      }
    }

    // Anything else -> generic error.
    post({ kind: 'error', requestId, message: err instanceof Error ? err.message : String(err) });
  }
}

ctx.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as WorkerRequestMsg;
  if (!msg || msg.kind !== 'pack') return;
  void handlePack(msg.requestId, msg.request);
};
