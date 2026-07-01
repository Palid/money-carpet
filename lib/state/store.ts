import { createStore } from 'zustand/vanilla';
import { useStore as useZustandStore } from 'zustand/react';

import type { Mode, PackResult } from '@/lib/packer/types';
import type { RatesResponse } from '@/lib/fx/types';

/** Lifecycle of the most recent recompute dispatch. */
export type Status = 'idle' | 'loading' | 'error' | 'unsupported' | 'gpu-lost';

/** Pure data held by the store (no actions) — the shape recompute.ts reads/patches. */
export interface AppData {
  currencyCode: string;
  areaTenths: number; // 0.1 m^2 units (10..100 for 1..10 m^2)
  mode: Mode;
  excludeNonIssued: boolean;

  rates: RatesResponse | null;

  result: PackResult | null;
  status: Status;
  errorMessage: string | null;
}

export interface AppState extends AppData {
  setCurrency: (code: string) => void;
  setAreaTenths: (t: number) => void;
  setMode: (m: Mode) => void;
  setExcludeNonIssued: (b: boolean) => void;
  setRates: (r: RatesResponse) => void;
  setResult: (r: PackResult) => void;
  setStatus: (s: Status, message?: string | null) => void;
  /**
   * Internal, low-level patch used by recompute.ts to apply multi-field
   * updates atomically (e.g. result + status together). Not intended for
   * UI call sites — prefer the named actions above.
   */
  _patch: (partial: Partial<AppData>) => void;
}

export const initialAppData: AppData = {
  currencyCode: 'PLN',
  areaTenths: 40,
  mode: 'cheapest',
  excludeNonIssued: true,
  rates: null,
  result: null,
  status: 'idle',
  errorMessage: null,
};

/** Vanilla store handle — usable outside React (e.g. recompute.ts). */
export const store = createStore<AppState>((set) => ({
  ...initialAppData,

  setCurrency: (code) => set({ currencyCode: code }),
  setAreaTenths: (t) => set({ areaTenths: t }),
  setMode: (m) => set({ mode: m }),
  setExcludeNonIssued: (b) => set({ excludeNonIssued: b }),
  setRates: (r) => set({ rates: r }),
  setResult: (r) => set({ result: r }),
  setStatus: (s, message = null) => set({ status: s, errorMessage: message }),

  _patch: (partial) => set(partial),
}));

/** React hook — mirrors zustand's `create()` ergonomics over the vanilla store. */
export function useStore(): AppState;
export function useStore<U>(selector: (state: AppState) => U): U;
export function useStore<U>(selector?: (state: AppState) => U) {
  return selector ? useZustandStore(store, selector) : useZustandStore(store);
}
