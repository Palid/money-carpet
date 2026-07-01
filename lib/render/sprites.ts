// Loads official currency images (banknote/coin scans) and maps them to the
// denominations of a PackResult, so draw.ts can blit them instead of the flat
// color fill. Everything degrades gracefully: a denom with no `image`, or an
// image that fails to load, simply falls back to the flat fill in draw.ts.
import type { DenomRef, PackResult } from '@/lib/packer/types';

/** denomTable index -> loaded, drawable image for that denomination. */
export type SpriteMap = Map<number, CanvasImageSource>;

export interface SpriteUrlRef {
  /** Index into result.denomTable. */
  denomIndex: number;
  /** /public path to the image, e.g. '/currency/usd/note-100.jpg'. */
  url: string;
}

/**
 * Pure: the (denomIndex -> url) pairs for denominations that declare an image.
 * Denominations without an `image` are omitted (they render as flat fills).
 */
export function collectSpriteUrls(denomTable: DenomRef[]): SpriteUrlRef[] {
  const out: SpriteUrlRef[] = [];
  for (let i = 0; i < denomTable.length; i++) {
    const url = denomTable[i]?.image;
    if (url) out.push({ denomIndex: i, url });
  }
  return out;
}

/** True when at least one denomination in the table has an official image. */
export function denomTableHasImages(denomTable: DenomRef[]): boolean {
  return denomTable.some((d) => Boolean(d.image));
}

// Cache each URL's load promise so switching mode/area/currency never re-fetches
// an image we already have. Keyed by url; the promise resolves to null on error.
const imageCache = new Map<string, Promise<CanvasImageSource | null>>();

function loadImage(url: string): Promise<CanvasImageSource | null> {
  const cached = imageCache.get(url);
  if (cached) return cached;

  const promise = new Promise<CanvasImageSource | null>((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(null); // non-DOM environment (SSR/tests) — fall back to flat fill
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });

  imageCache.set(url, promise);
  return promise;
}

/**
 * Loads every image referenced by `result.denomTable` and returns a map from
 * denomTable index to a drawable image. Images that fail to load are omitted,
 * so the caller can treat "no entry" as "use the flat fill". Resolves with an
 * empty map when nothing in the table has an image (e.g. non-USD currencies).
 *
 * Pass an AbortSignal to discard the result of a superseded load (the images
 * still finish downloading into the cache, but won't be applied).
 */
export async function loadSprites(
  result: PackResult,
  signal?: AbortSignal,
): Promise<SpriteMap> {
  const refs = collectSpriteUrls(result.denomTable);
  const map: SpriteMap = new Map();
  if (refs.length === 0) return map;

  // Load unique URLs once, then fan back out to every denom index using it.
  const uniqueUrls = Array.from(new Set(refs.map((r) => r.url)));
  const loaded = await Promise.all(uniqueUrls.map((url) => loadImage(url)));
  if (signal?.aborted) return map;

  const byUrl = new Map<string, CanvasImageSource | null>();
  uniqueUrls.forEach((url, i) => byUrl.set(url, loaded[i]));

  for (const { denomIndex, url } of refs) {
    const img = byUrl.get(url);
    if (img) map.set(denomIndex, img);
  }
  return map;
}

/** Test-only: drop cached image promises so a fresh load can be observed. */
export function _clearSpriteCache(): void {
  imageCache.clear();
}
