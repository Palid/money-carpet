/**
 * Full-screen fallback shown when `hasWebGPU()` reports no `navigator.gpu`.
 * Static and hook-free so it can be rendered from a server component or
 * the app shell before any client-only state is available.
 */
export function UnsupportedScreen() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center text-foreground">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-muted text-3xl">
        {'⚠️'}
      </div>
      <div className="flex max-w-md flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          WebGPU required
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          This app packs the room floor with real-scale banknotes and coins on
          the GPU, so it needs a browser with WebGPU support. Please try{' '}
          <span className="font-medium text-foreground">
            Chrome or Edge 113+
          </span>{' '}
          or <span className="font-medium text-foreground">Safari 18+</span>,
          then reload this page.
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        No data is sent anywhere &mdash; everything runs locally in your
        browser.
      </p>
    </main>
  );
}

export default UnsupportedScreen;
