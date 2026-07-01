import { getCurrency } from '@/lib/currency/dataset';
import { fetchRates, loadSnapshot } from '@/lib/fx/fetch';
import type { RatesResponse } from '@/lib/fx/types';
import { plnPerMinor } from '@/lib/fx/normalize';
import { DEFAULT_CANDIDATES } from '@/lib/config/constants';
import type { PackRequest, PackResult } from '@/lib/packer/types';

import { store, type AppData } from '@/lib/state/store';

/**
 * Worker message protocol — a structural (not shared-import) copy of the
 * frozen contract in lib/gpu/pack.worker.ts. Kept local on purpose: the
 * worker module is owned by a different work-in-progress area and we only
 * ever talk to it across the `postMessage` boundary, so duck typing here is
 * both sufficient and safer than reaching into lib/gpu directly.
 */
export type WorkerRequestMsg = {
  kind: 'pack';
  requestId: number;
  request: PackRequest;
};
export type WorkerResponseMsg =
  | { kind: 'result'; requestId: number; result: PackResult }
  | { kind: 'error'; requestId: number; message: string }
  | { kind: 'unsupported'; requestId: number }
  | { kind: 'gpu-lost'; requestId: number };

/** Slider-driven area changes debounce for this long before dispatch. */
const AREA_DEBOUNCE_MS = 200;
/** Everything else (mode/currency/exclude) dispatches with ~no debounce. */
const IMMEDIATE_DEBOUNCE_MS = 0;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing — no window/Worker required).
// ---------------------------------------------------------------------------

/** True when a worker response no longer corresponds to the latest dispatch. */
export function isStale(responseId: number, latestId: number): boolean {
  return responseId !== latestId;
}

export type PackRequestState = Pick<
  AppData,
  | 'currencyCode'
  | 'areaTenths'
  | 'mode'
  | 'excludeNonIssued'
  | 'primaryDenom'
  | 'onlyPrimary'
>;

/** Builds the PackRequest the worker expects from current UI intent + FX rates. */
export function buildPackRequest(
  state: PackRequestState,
  rates: RatesResponse,
): PackRequest {
  const currency = getCurrency(state.currencyCode);
  return {
    currencyCode: state.currencyCode,
    areaTenths: state.areaTenths,
    mode: state.mode,
    excludeNonIssued: state.excludeNonIssued,
    plnPerMinor: plnPerMinor(state.currencyCode, currency.minorDigits, rates),
    fxSnapshotId: rates.snapshotId,
    fxStale: rates.stale,
    candidateCount: DEFAULT_CANDIDATES,
    primaryDenom: state.primaryDenom,
    onlyPrimary: state.onlyPrimary,
  };
}

/** A tiny generic coalescing debouncer: schedule() resets any pending timer. */
export function createDebouncer(fn: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(ms: number): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, ms);
    },
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Worker RPC engine (client-only).
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let latestRequestId = 0;
let storeUnsubscribe: (() => void) | null = null;
let disposed = false;

const debouncer = createDebouncer(dispatchRecompute);

function handleWorkerMessage(ev: MessageEvent<WorkerResponseMsg>): void {
  const msg = ev.data;
  if (isStale(msg.requestId, latestRequestId)) return; // drop stale response

  switch (msg.kind) {
    case 'result':
      store.getState()._patch({
        result: msg.result,
        status: 'idle',
        errorMessage: null,
      });
      break;
    case 'error':
      store.getState()._patch({ status: 'error', errorMessage: msg.message });
      break;
    case 'unsupported':
      store.getState()._patch({ status: 'unsupported', errorMessage: null });
      break;
    case 'gpu-lost':
      store.getState()._patch({ status: 'gpu-lost', errorMessage: null });
      break;
  }
}

/** Lazily creates the single module worker. Returns null (and sets status) on failure. */
function ensureWorker(): Worker | null {
  if (typeof window === 'undefined') return null;
  if (worker) return worker;

  try {
    worker = new Worker(new URL('../gpu/pack.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = handleWorkerMessage;
    worker.onerror = () => {
      store.getState()._patch({ status: 'gpu-lost' });
    };
  } catch {
    worker = null;
    store.getState()._patch({ status: 'unsupported' });
  }

  return worker;
}

/** Builds a PackRequest from current state and posts it to the worker. */
function dispatchRecompute(): void {
  if (typeof window === 'undefined') return;

  const state = store.getState();
  let rates = state.rates;
  if (!rates) {
    // Recompute can be requested before initRecompute's fetch resolves
    // (e.g. tests, or a stray subscriber firing early); never block on it.
    rates = loadSnapshot();
    store.getState().setRates(rates);
  }

  const w = ensureWorker();
  if (!w) return; // status already set to 'unsupported' by ensureWorker

  const request = buildPackRequest(state, rates);
  latestRequestId += 1;
  const requestId = latestRequestId;

  store.getState()._patch({ status: 'loading' });

  const msg: WorkerRequestMsg = { kind: 'pack', requestId, request };
  w.postMessage(msg);
}

/**
 * Requests a recompute with no debounce — useful for direct/imperative
 * callers (initial load, retryGpu). UI-driven state changes should go
 * through the subscription in initRecompute(), which debounces itself.
 */
export function requestRecompute(): void {
  debouncer.schedule(IMMEDIATE_DEBOUNCE_MS);
}

/** Fetches FX rates, wires up the store subscription, and triggers an initial recompute. */
export function initRecompute(): void {
  if (typeof window === 'undefined') return;
  disposed = false;

  fetchRates()
    .then((r) => store.getState().setRates(r))
    .catch(() => store.getState().setRates(loadSnapshot()))
    .finally(() => {
      if (!disposed) debouncer.schedule(IMMEDIATE_DEBOUNCE_MS);
    });

  let prev = store.getState();
  storeUnsubscribe = store.subscribe((state) => {
    const areaChanged = state.areaTenths !== prev.areaTenths;
    const otherIntentChanged =
      state.currencyCode !== prev.currencyCode ||
      state.mode !== prev.mode ||
      state.excludeNonIssued !== prev.excludeNonIssued ||
      state.primaryDenom !== prev.primaryDenom ||
      state.onlyPrimary !== prev.onlyPrimary;
    prev = state;

    if (!areaChanged && !otherIntentChanged) return;
    debouncer.schedule(
      otherIntentChanged ? IMMEDIATE_DEBOUNCE_MS : AREA_DEBOUNCE_MS,
    );
  });
}

/** Re-attempts computation after a 'gpu-lost' status by recreating the worker. */
export function retryGpu(): void {
  if (typeof window === 'undefined') return;

  if (worker) {
    worker.terminate();
    worker = null;
  }
  store.getState()._patch({ status: 'loading', errorMessage: null });
  debouncer.schedule(IMMEDIATE_DEBOUNCE_MS);
}

/** Terminates the worker and unsubscribes from the store (React cleanup / HMR safety). */
export function disposeRecompute(): void {
  disposed = true;
  debouncer.cancel();

  if (storeUnsubscribe) {
    storeUnsubscribe();
    storeUnsubscribe = null;
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
}
