'use client';

import * as React from 'react';

import { hasWebGPU } from '@/components/webgpu';
import { UnsupportedScreen } from '@/components/unsupported-screen';
import { Dashboard } from '@/components/dashboard';
import { useStore, initRecompute, disposeRecompute } from '@/lib/state';

/**
 * Top-level client gate. This module is only ever loaded on the client (it is
 * imported via `next/dynamic` with `{ ssr: false }`), so it is safe to probe
 * `navigator.gpu` in a lazy state initializer.
 *
 * Rendering decision:
 *  - No `navigator.gpu` at all -> the static <UnsupportedScreen/>.
 *  - The worker later reports `status === 'unsupported'` (an adapter/device
 *    could not be acquired even though the entry point existed) -> also the
 *    <UnsupportedScreen/>.
 *  - Otherwise -> the interactive <Dashboard/> (which owns the recoverable
 *    'gpu-lost' banner).
 *
 * The recompute engine (FX fetch + worker RPC + store subscription) is started
 * once on mount and torn down on unmount, keeping HMR and React strict-mode
 * double-invocation safe via disposeRecompute().
 */
export function AppShell() {
  // Runs exactly once, on the client, before first paint. hasWebGPU() is
  // SSR-safe but this component never renders on the server anyway.
  const [supported] = React.useState(() => hasWebGPU());
  const status = useStore((s) => s.status);

  React.useEffect(() => {
    if (!supported) return;
    initRecompute();
    return () => disposeRecompute();
  }, [supported]);

  if (!supported || status === 'unsupported') {
    return <UnsupportedScreen />;
  }

  return <Dashboard />;
}

export default AppShell;
