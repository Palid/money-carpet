/**
 * SSR-safe synchronous gate for the app shell: does this browser even expose
 * a `navigator.gpu` entry point? This does NOT attempt adapter acquisition
 * (no `requestAdapter()` call) — that's an async concern that lives with the
 * real GPU wiring elsewhere. This is only meant to decide whether to render
 * the app shell or the unsupported-screen fallback.
 */
export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}
