import { describe, expect, it } from 'vitest';

import { listCurrencies } from '@/lib/currency/dataset';
import { loadSnapshot } from '@/lib/fx/fetch';
import { plnPerMinor, snapshotIdOf } from '@/lib/fx/normalize';

describe('plnPerMinor', () => {
  const snapshot = loadSnapshot();

  it('computes PLN value of one minor unit for PLN (2 minor digits)', () => {
    expect(plnPerMinor('PLN', 2, snapshot)).toBe(0.01);
  });

  it('equals ratesToPLN value directly when minorDigits is 0 (e.g. JPY)', () => {
    expect(plnPerMinor('JPY', 0, snapshot)).toBe(snapshot.ratesToPLN['JPY']);
  });

  it('ratesToPLN[PLN] === 1', () => {
    expect(snapshot.ratesToPLN['PLN']).toBe(1);
  });

  it('snapshot covers every dataset currency', () => {
    for (const currency of listCurrencies()) {
      expect(snapshot.ratesToPLN).toHaveProperty(currency.code);
      expect(typeof snapshot.ratesToPLN[currency.code]).toBe('number');
    }
  });

  it('falls back to the snapshot when a code is missing from the given rates', () => {
    const incomplete = {
      ...snapshot,
      ratesToPLN: { PLN: 1 },
    };
    expect(plnPerMinor('EUR', 2, incomplete)).toBe(
      snapshot.ratesToPLN['EUR'] / 100,
    );
  });

  it('throws a clear error when a code is unknown everywhere', () => {
    expect(() => plnPerMinor('XXX', 2, snapshot)).toThrow(
      /No FX rate available/,
    );
  });
});

describe('snapshotIdOf', () => {
  it('returns the snapshotId field', () => {
    const snapshot = loadSnapshot();
    expect(snapshotIdOf(snapshot)).toBe(snapshot.snapshotId);
  });
});
