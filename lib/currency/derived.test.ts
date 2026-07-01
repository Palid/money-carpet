import { describe, expect, it } from 'vitest';

import {
  coinRadiusUnits,
  faceValueMajor,
  footprintM2,
  noteDimsUnits,
  valueDensityPLN,
} from '@/lib/currency/derived';
import { FP } from '@/lib/config/constants';
import type { CoinSpec, NoteSpec } from '@/lib/currency/types';

const pln10: NoteSpec = {
  kind: 'note',
  minorValue: 1000,
  widthMm: 120,
  heightMm: 60,
  color: '#A94442',
  label: '10 zł',
};

const jpy1000: NoteSpec = {
  kind: 'note',
  minorValue: 1000,
  widthMm: 150,
  heightMm: 76,
  color: '#3B5998',
  label: '¥1000',
};

const plnCoin5zl: CoinSpec = {
  kind: 'coin',
  minorValue: 500,
  diameterMm: 24.0,
  shape: 'circle',
  color: '#D4AF37',
  label: '5 zł',
};

const gbpPolygon20p: CoinSpec = {
  kind: 'coin',
  minorValue: 20,
  diameterMm: 21.4,
  shape: 'polygon',
  sides: 7,
  color: '#C0C0C0',
  label: '20p',
};

describe('faceValueMajor', () => {
  it('converts integer minor units to major units using minorDigits', () => {
    // 10 zł at minorDigits 2 -> minorValue 1000 -> major value 10
    expect(faceValueMajor(pln10, 2)).toBe(10);
  });

  it('handles minorDigits 0 (JPY has no minor unit subdivision)', () => {
    // ¥1000 at minorDigits 0 -> minorValue 1000 -> major value 1000
    expect(faceValueMajor(jpy1000, 0)).toBe(1000);
  });
});

describe('footprintM2', () => {
  it('computes note footprint as bounding-box area', () => {
    const expected = (120 * 60) / 1e6;
    expect(footprintM2(pln10)).toBeCloseTo(expected, 12);
  });

  it('computes coin footprint using TRUE CIRCLE area, never bounding box', () => {
    const radiusMm = 24.0 / 2;
    const circleArea = (Math.PI * radiusMm * radiusMm) / 1e6;
    const boundingBoxArea = (24.0 * 24.0) / 1e6;
    expect(footprintM2(plnCoin5zl)).toBeCloseTo(circleArea, 12);
    expect(footprintM2(plnCoin5zl)).not.toBeCloseTo(boundingBoxArea, 6);
  });

  it('uses the across-corners diameter as a circle even for polygon coins', () => {
    const radiusMm = gbpPolygon20p.diameterMm / 2;
    const circleArea = (Math.PI * radiusMm * radiusMm) / 1e6;
    expect(footprintM2(gbpPolygon20p)).toBeCloseTo(circleArea, 12);
  });

  it('gives all USD notes the identical footprint (all bills are 156x66.3mm)', () => {
    const usd1: NoteSpec = {
      kind: 'note',
      minorValue: 100,
      widthMm: 156,
      heightMm: 66.3,
      color: '#85BB65',
      label: '$1',
    };
    const usd100: NoteSpec = {
      kind: 'note',
      minorValue: 10000,
      widthMm: 156,
      heightMm: 66.3,
      color: '#7DB89D',
      label: '$100',
    };
    expect(footprintM2(usd1)).toBe(footprintM2(usd100));
  });
});

describe('valueDensityPLN', () => {
  it('computes (minorValue * plnPerMinor) / footprintM2', () => {
    const plnPerMinor = 1; // pretend 1 PLN grosz == 1 PLN "minor unit value" for the test
    const expected = (pln10.minorValue * plnPerMinor) / footprintM2(pln10);
    expect(valueDensityPLN(pln10, 2, plnPerMinor)).toBeCloseTo(expected, 12);
  });
});

describe('noteDimsUnits / coinRadiusUnits', () => {
  it('converts note dimensions to fixed-point (1/100mm) integers', () => {
    const [w, h] = noteDimsUnits(pln10);
    expect(w).toBe(Math.round(120 * FP));
    expect(h).toBe(Math.round(60 * FP));
    expect(Number.isInteger(w)).toBe(true);
    expect(Number.isInteger(h)).toBe(true);
  });

  it('returns [0, 0] note dims for a coin', () => {
    expect(noteDimsUnits(plnCoin5zl)).toEqual([0, 0]);
  });

  it('converts coin diameter to a fixed-point (1/100mm) integer radius', () => {
    const r = coinRadiusUnits(plnCoin5zl);
    expect(r).toBe(Math.round((24.0 / 2) * FP));
    expect(Number.isInteger(r)).toBe(true);
  });

  it('returns 0 coin radius for a note', () => {
    expect(coinRadiusUnits(pln10)).toBe(0);
  });
});

describe('integer minor-unit math has no float drift', () => {
  it('sums 10000 identical notes as integer minor units, then multiplies once', () => {
    const count = 10000;
    // Summing minorValue as an integer 10000 times must stay exact.
    let totalMinor = 0;
    for (let i = 0; i < count; i++) {
      totalMinor += pln10.minorValue;
    }
    expect(totalMinor).toBe(count * pln10.minorValue);
    expect(Number.isInteger(totalMinor)).toBe(true);

    // Only convert to major-unit PLN value via a single divide at the end,
    // avoiding accumulated float drift from repeated division.
    // 10000 notes * 10 zł each = 100,000 zł.
    const totalMajor = totalMinor / 100;
    expect(totalMajor).toBe(100_000);
  });
});
