'use client';

import dynamic from 'next/dynamic';

/**
 * Client-only wrapper around the app shell.
 *
 * Next 14 forbids `next/dynamic` with `{ ssr: false }` inside a Server
 * Component, so this tiny Client Component owns that dynamic import. The whole
 * shell (WebGPU probe, Worker, canvas, d3-zoom) is browser-only, so it must
 * never be server-rendered or prerendered.
 */
const AppShell = dynamic(() => import('@/components/app-shell'), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-[60vh] items-center justify-center text-sm text-muted-foreground">
      Loading…
    </div>
  ),
});

export function ClientApp() {
  return <AppShell />;
}

export default ClientApp;
