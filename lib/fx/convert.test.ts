import { describe, expect, it } from 'vitest';

import { listCurrencies } from '@/lib/currency/dataset';
import type { FrankfurterResponse } from '@/lib/fx/convert';
import { convertFrankfurterToPLN } from '@/lib/fx/convert';
import { loadSnapshot } from '@/lib/fx/fetch';

describe('convertFrankfurterToPLN', () => {
  const snapshot = loadSnapshot();
  const datasetCodes = listCurrencies().map((c) => c.code);

  it('inverts Frankfurter units-per-PLN into PLN-per-major-unit', () => {
    const frankfurter: FrankfurterResponse = {
      base: 'PLN',
      date: '2026-06-30',
      rates: {
        EUR: 0.2326, // 1 PLN == 0.2326 EUR -> 1 EUR == 1/0.2326 PLN
        USD: 0.25,
      },
    };

    const { date, ratesToPLN } = convertFrankfurterToPLN(
      frankfurter,
      ['PLN', 'EUR', 'USD'],
      snapshot,
    );

    expect(date).toBe('2026-06-30');
    expect(ratesToPLN.PLN).toBe(1);
    expect(ratesToPLN.EUR).toBeCloseTo(1 / 0.2326, 10);
    expect(ratesToPLN.USD).toBeCloseTo(1 / 0.25, 10);
  });

  it('always sets PLN to 1 even if Frankfurter includes it', () => {
    const frankfurter: FrankfurterResponse = {
      base: 'PLN',
      date: '2026-06-30',
      rates: { PLN: 999 },
    };
    const { ratesToPLN } = convertFrankfurterToPLN(
      frankfurter,
      ['PLN'],
      snapshot,
    );
    expect(ratesToPLN.PLN).toBe(1);
  });

  it('falls back to the snapshot for dataset currencies missing from Frankfurter', () => {
    const frankfurter: FrankfurterResponse = {
      base: 'PLN',
      date: '2026-06-30',
      rates: { EUR: 0.2326 }, // no INR, no HUF etc.
    };

    const { ratesToPLN } = convertFrankfurterToPLN(
      frankfurter,
      ['PLN', 'EUR', 'INR', 'HUF'],
      snapshot,
    );

    expect(ratesToPLN.INR).toBe(snapshot.ratesToPLN.INR);
    expect(ratesToPLN.HUF).toBe(snapshot.ratesToPLN.HUF);
  });

  it('produces a value for every currency in the real dataset given a realistic Frankfurter payload', () => {
    // Simulate Frankfurter covering most, but not all, dataset currencies.
    const rates: Record<string, number> = {};
    for (const code of datasetCodes) {
      if (code === 'PLN') continue;
      rates[code] = 1 / snapshot.ratesToPLN[code]; // pretend live == snapshot
    }
    delete rates.NZD; // simulate one gap Frankfurter doesn't cover

    const frankfurter: FrankfurterResponse = {
      base: 'PLN',
      date: '2026-06-30',
      rates,
    };

    const { ratesToPLN } = convertFrankfurterToPLN(
      frankfurter,
      datasetCodes,
      snapshot,
    );

    for (const code of datasetCodes) {
      expect(typeof ratesToPLN[code]).toBe('number');
      expect(Number.isFinite(ratesToPLN[code])).toBe(true);
    }
    // The simulated gap should have fallen back to the snapshot value.
    expect(ratesToPLN.NZD).toBe(snapshot.ratesToPLN.NZD);
  });

  it('ignores non-positive or non-numeric upstream rates and falls back to snapshot', () => {
    const frankfurter: FrankfurterResponse = {
      base: 'PLN',
      date: '2026-06-30',
      rates: { EUR: 0, USD: -1 },
    };

    const { ratesToPLN } = convertFrankfurterToPLN(
      frankfurter,
      ['PLN', 'EUR', 'USD'],
      snapshot,
    );

    expect(ratesToPLN.EUR).toBe(snapshot.ratesToPLN.EUR);
    expect(ratesToPLN.USD).toBe(snapshot.ratesToPLN.USD);
  });
});
