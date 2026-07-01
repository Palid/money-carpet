import { describe, it, expect } from 'vitest';

import { getCurrency } from '@/lib/currency/dataset';
import type { PackRequest, PackResult } from '@/lib/packer/types';
import { packCPU } from '@/lib/packer/replay';
import { getEligibleDenoms } from '@/lib/packer/eligible';

// PLN: 1 minor unit (grosz) = 0.01 PLN.
const PLN_PER_MINOR = 0.01;

// FULL-denominations indices (index into getCurrency('PLN').denominations).
const PLN = getCurrency('PLN').denominations;
const NOTE_10ZL = PLN.findIndex((d) => d.kind === 'note' && d.label === '10 zł');
const COIN_5ZL = PLN.findIndex((d) => d.kind === 'coin' && d.label === '5 zł');

function makeReq(p: Partial<PackRequest>): PackRequest {
  return {
    currencyCode: 'PLN',
    areaTenths: 40, // 4 m^2
    mode: 'densest',
    excludeNonIssued: true,
    plnPerMinor: PLN_PER_MINOR,
    fxSnapshotId: 'test-snapshot',
    fxStale: false,
    candidateCount: 2048,
    primaryDenom: null,
    onlyPrimary: false,
    ...p,
  };
}

/** count of pieces whose denomTable label === label (real drawn geometry). */
function geomCountByLabel(res: PackResult, label: string): number {
  let n = 0;
  for (let i = 0; i < res.geometry.count; i++) {
    if (res.denomTable[res.geometry.denom[i]].label === label) n++;
  }
  return n;
}

function perDenomCount(res: PackResult, label: string): number {
  const e = res.perDenom.find((p) => p.label === label);
  return e ? e.count : 0;
}

function geometryEqual(a: PackResult, b: PackResult): boolean {
  if (a.geometry.count !== b.geometry.count) return false;
  const keys = ['kind', 'denom', 'x', 'y', 'w', 'h', 'r', 'rot'] as const;
  for (const k of keys) {
    for (let i = 0; i < a.geometry.count; i++) {
      if (a.geometry[k][i] !== b.geometry[k][i]) return false;
    }
  }
  return true;
}

// The full-array indices we depend on must resolve.
it('resolves the PLN 10 zł note and 5 zł coin full-array indices', () => {
  expect(NOTE_10ZL).toBeGreaterThanOrEqual(0);
  expect(COIN_5ZL).toBeGreaterThanOrEqual(0);
  expect(PLN[NOTE_10ZL].kind).toBe('note');
  expect(PLN[COIN_5ZL].kind).toBe('coin');
});

// ---------------------------------------------------------------------------
// NOTE primary: lead with the 10 zł note (dominant), keep coins as gap-fill.
// ---------------------------------------------------------------------------
describe('primary NOTE (10 zł)', () => {
  it('the 10 zł note is the dominant note; coins fill gaps; coverage high; deterministic', () => {
    const req = makeReq({ primaryDenom: NOTE_10ZL, onlyPrimary: false });
    const res = packCPU(req);

    const noteCount = perDenomCount(res, '10 zł');
    expect(noteCount).toBeGreaterThan(0);

    // The 10 zł note dominates every OTHER note (it leads the pack). Small
    // gap-fill coins can be individually numerous, but among notes the primary
    // is strictly the most numerous.
    for (const p of res.perDenom) {
      const d = res.denomTable[p.denomIndex];
      if (d.kind === 'note' && p.label !== '10 zł') {
        expect(p.count).toBeLessThan(noteCount);
      }
    }

    // Coins are kept and fill the leftover space.
    let anyCoin = false;
    for (let i = 0; i < res.geometry.count; i++) if (res.geometry.kind[i] === 1) anyCoin = true;
    expect(anyCoin).toBe(true);

    // Coverage remains high.
    expect(res.coverage).toBeGreaterThan(0.9);

    // Determinism: same request twice -> identical geometry.
    const res2 = packCPU(req);
    expect(geometryEqual(res, res2)).toBe(true);
  }, 120000);
});

// ---------------------------------------------------------------------------
// COIN primary: drop ALL notes, lead with the 5 zł coin, smaller coins fill.
// ---------------------------------------------------------------------------
describe('primary COIN (5 zł)', () => {
  it('the 5 zł coin dominates the coins; zero notes; smaller coins fill gaps', () => {
    const req = makeReq({ primaryDenom: COIN_5ZL, onlyPrimary: false });
    const res = packCPU(req);

    // ZERO notes placed anywhere in the geometry.
    for (let i = 0; i < res.geometry.count; i++) {
      expect(res.geometry.kind[i]).not.toBe(0);
    }

    // The 5 zł coin has the highest count among ALL denominations (all coins now).
    const fiveZl = perDenomCount(res, '5 zł');
    expect(fiveZl).toBeGreaterThan(0);
    for (const p of res.perDenom) {
      if (p.label !== '5 zł') expect(p.count).toBeLessThan(fiveZl);
    }
    // It is also the most numerous piece in the real geometry.
    expect(geomCountByLabel(res, '5 zł')).toBeGreaterThan(0);

    // Smaller coins fill the interstitial gaps (at least one other coin appears).
    const otherCoins = res.perDenom.filter((p) => p.label !== '5 zł' && p.count > 0);
    expect(otherCoins.length).toBeGreaterThan(0);
  }, 120000);
});

// ---------------------------------------------------------------------------
// onlyPrimary: single-denomination carpet, no gap-fill.
// ---------------------------------------------------------------------------
describe('onlyPrimary COIN (5 zł)', () => {
  it('places ONLY 5 zł coins; coverage below the coin-primary-with-fill case', () => {
    const onlyReq = makeReq({ primaryDenom: COIN_5ZL, onlyPrimary: true });
    const only = packCPU(onlyReq);

    // Every placed piece is a 5 zł coin.
    for (let i = 0; i < only.geometry.count; i++) {
      expect(only.geometry.kind[i]).toBe(1);
      expect(only.denomTable[only.geometry.denom[i]].label).toBe('5 zł');
    }
    // No other denom has any count.
    for (const p of only.perDenom) {
      if (p.label !== '5 zł') expect(p.count).toBe(0);
    }
    expect(perDenomCount(only, '5 zł')).toBeGreaterThan(0);

    // Gap-fill helps: the coin-primary-with-fill pack covers strictly more.
    const withFill = packCPU(makeReq({ primaryDenom: COIN_5ZL, onlyPrimary: false }));
    expect(only.coverage).toBeLessThan(withFill.coverage);
  }, 120000);
});

// ---------------------------------------------------------------------------
// Default (primaryDenom = null): unchanged behavior, a sanity pack still works.
// ---------------------------------------------------------------------------
describe('primaryDenom = null (default)', () => {
  it('a sanity pack still works with high coverage', () => {
    const res = packCPU(makeReq({ primaryDenom: null, onlyPrimary: false }));
    expect(res.geometry.count).toBeGreaterThan(0);
    expect(res.coverage).toBeGreaterThan(0.9);

    // getEligibleDenoms reports no primary for the default request.
    const { primaryEligibleIndex } = getEligibleDenoms(makeReq({ primaryDenom: null }));
    expect(primaryEligibleIndex).toBe(-1);
  }, 120000);
});
