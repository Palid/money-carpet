/**
 * WebGPU device acquisition + loss handling. SSR-safe: every entry point guards
 * `navigator` so importing this module never throws in a Node / server context.
 */

/** Thrown when WebGPU (navigator.gpu / adapter / device) is unavailable. */
export class GpuUnsupportedError extends Error {
  constructor(message = 'WebGPU is not available in this environment') {
    super(message);
    this.name = 'GpuUnsupportedError';
  }
}

export type DeviceLostListener = (info: GPUDeviceLostInfo) => void;

// Module-level registry so callers can subscribe to device-loss independent of
// which device instance is live (a reacquire swaps the underlying device).
const lostListeners = new Set<DeviceLostListener>();

/** Register a device-lost callback. Returns an unsubscribe function. */
export function onDeviceLost(cb: DeviceLostListener): () => void {
  lostListeners.add(cb);
  return () => lostListeners.delete(cb);
}

function wireLostHandler(device: GPUDevice): void {
  // device.lost resolves once, when the device is lost. Fan out to listeners.
  void device.lost.then((info) => {
    for (const cb of lostListeners) {
      try {
        cb(info);
      } catch {
        // a faulty listener must not swallow the others
      }
    }
  });
}

function hasGpu(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

/**
 * Acquire a GPUDevice, throwing GpuUnsupportedError if WebGPU / an adapter is
 * absent. Registers the device.lost handler that drives onDeviceLost listeners.
 */
export async function getGpuDevice(): Promise<GPUDevice> {
  if (!hasGpu()) {
    throw new GpuUnsupportedError('navigator.gpu is unavailable (no WebGPU support)');
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new GpuUnsupportedError('No suitable GPUAdapter found');
  }
  const device = await adapter.requestDevice();
  wireLostHandler(device);
  return device;
}

/**
 * Try ONCE to reacquire a device after a loss. Rejects with GpuUnsupportedError
 * (or the underlying error) if it still cannot be obtained.
 */
export async function reacquire(): Promise<GPUDevice> {
  return getGpuDevice();
}
