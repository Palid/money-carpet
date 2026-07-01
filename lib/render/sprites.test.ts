import { describe, expect, it } from 'vitest';

import type { DenomRef, PackResult } from '@/lib/packer/types';
import {
  collectSpriteUrls,
  denomTableHasImages,
  loadSprites,
} from '@/lib/render/sprites';

function denom(partial: Partial<DenomRef>): DenomRef {
  return {
    currencyCode: 'USD',
    label: '$1',
    color: '#85BB65',
    kind: 'note',
    minorValue: 100,
    minorDigits: 2,
    ...partial,
  };
}

describe('collectSpriteUrls', () => {
  it('returns only denoms that declare an image, keyed by table index', () => {
    const table: DenomRef[] = [
      denom({ image: '/currency/usd/note-1.jpg' }),
      denom({ label: '5c', kind: 'coin', minorValue: 5 }), // no image
      denom({ label: '$100', minorValue: 10000, image: '/currency/usd/note-100.jpg' }),
    ];
    expect(collectSpriteUrls(table)).toEqual([
      { denomIndex: 0, url: '/currency/usd/note-1.jpg' },
      { denomIndex: 2, url: '/currency/usd/note-100.jpg' },
    ]);
  });

  it('is empty when no denom has an image', () => {
    const table: DenomRef[] = [denom({ image: undefined }), denom({ label: '2 zł' })];
    expect(collectSpriteUrls(table)).toEqual([]);
  });
});

describe('denomTableHasImages', () => {
  it('is true iff at least one denom has an image', () => {
    expect(denomTableHasImages([denom({}), denom({ image: '/x.png' })])).toBe(true);
    expect(denomTableHasImages([denom({}), denom({})])).toBe(false);
  });
});

describe('loadSprites', () => {
  function resultWith(table: DenomRef[]): PackResult {
    return { denomTable: table } as unknown as PackResult;
  }

  it('resolves to an empty map when nothing has an image (no image loading attempted)', async () => {
    const map = await loadSprites(resultWith([denom({ image: undefined })]));
    expect(map.size).toBe(0);
  });

  it('omits images in a non-DOM environment rather than throwing', async () => {
    // In the node test env there is no global Image, so every load resolves to
    // null and the denom simply falls back to its flat fill (empty map here).
    const map = await loadSprites(resultWith([denom({ image: '/currency/usd/note-1.jpg' })]));
    expect(map.size).toBe(0);
  });
});
