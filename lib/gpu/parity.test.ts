import { describe, it, expect } from 'vitest';

// lib/packer — the FINISHED, TESTED CPU packer this mirror must match.
import { getCurrency } from '@/lib/currency/dataset';
import { noteDimsUnits, coinRadiusUnits } from '@/lib/currency/derived';
import type { Denomination } from '@/lib/currency/types';
import type { PackRequest, Mode } from '@/lib/packer/types';
import { hashBaseSeed, type U64 } from '@/lib/packer/rng';
import {
  buildArchetypeOrders,
  computeBaseSeed,
  makeCandidate,
  modeIndex,
  type Config,
} from '@/lib/packer/candidates';
import { shelfScoreCandidate } from '@/lib/packer/scoring';
import { computeRoomSideUnits } from '@/lib/packer/skyline';

// The pure-TS transcription of the WGSL kernel under test.
import {
  next as mNext,
  makeRng as mMakeRng,
  makePermutation as mMakePermutation,
  decodePolicies as mDecodePolicies,
  reconstructOrder as mReconstructOrder,
  shelfScore as mShelfScore,
  GOLDEN_VECTOR,
  GOLDEN_SEED_INITSTATE,
  GOLDEN_SEED_INITSEQ,
  N_BASE_CONFIGS,
  type MirrorDenom,
} from '@/lib/gpu/wgslMirror';

const PLN_PER_MINOR = 0.01;

function makeReq(p: Partial<PackRequest> = {}): PackRequest {
  return {
    currencyCode: 'PLN',
    areaTenths: 40,
    mode: 'cheapest',
    excludeNonIssued: false,
    plnPerMinor: PLN_PER_MINOR,
    fxSnapshotId: 'test-snapshot',
    fxStale: false,
    candidateCount: 2048,
    ...p,
  };
}

function toMirrorDenoms(denoms: Denomination[]): MirrorDenom[] {
  return denoms.map((d) => {
    const [w, h] = noteDimsUnits(d);
    const r = coinRadiusUnits(d);
    return { kind: d.kind === 'note' ? 0 : 1, w, h, r, minorValue: d.minorValue };
  });
}

// ---------------------------------------------------------------------------
// 1. PCG32 golden vector — the integer core the whole search depends on.
// ---------------------------------------------------------------------------
describe('wgslMirror PCG32 parity', () => {
  it('reproduces the exported PCG golden vector', () => {
    const rng = mMakeRng(GOLDEN_SEED_INITSTATE, GOLDEN_SEED_INITSEQ);
    const out: number[] = [];
    for (let i = 0; i < GOLDEN_VECTOR.length; i++) out.push(mNext(rng));
    expect(out).toEqual([465482994, 3895364073, 1746730475, 3759121132, 2984354868, 3193308813]);
    expect(out).toEqual([...GOLDEN_VECTOR]);
  });
});

// ---------------------------------------------------------------------------
// 2. makePermutation golden — the #1 project bit-parity risk.
// ---------------------------------------------------------------------------
describe('wgslMirror makePermutation parity', () => {
  it('hashBaseSeed("PLN",40,0,1,0) matches the canonical baseSeed', () => {
    const seed = hashBaseSeed('PLN', 40, 0, 1, 0);
    expect(seed).toEqual({ hi: 3794898416, lo: 2530266012 });
  });

  it('makePermutation(0, canonical baseSeed, 5) === [0,2,1,3,4]', () => {
    const baseSeed: U64 = { hi: 3794898416, lo: 2530266012 };
    expect(mMakePermutation(0, baseSeed, 5)).toEqual([0, 2, 1, 3, 4]);
  });

  it('matches lib/packer makeCandidate order for padded candidates (PLN)', () => {
    const req = makeReq();
    const eligible = getCurrency('PLN').denominations;
    const baseSeed = computeBaseSeed(req);
    const orders = buildArchetypeOrders(eligible, PLN_PER_MINOR);
    const n = eligible.length;
    for (const id of [192, 193, 250, 777, 2047]) {
      const config = makeCandidate(id, baseSeed, n, orders);
      const mirrorOrder = mReconstructOrder(id, baseSeed, n, orders);
      expect(mirrorOrder).toEqual(Array.from(config.order));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. decodeConfig policy parity (base + padded).
// ---------------------------------------------------------------------------
describe('wgslMirror decodePolicies parity', () => {
  it('matches makeCandidate policies across base and padded ids', () => {
    const req = makeReq();
    const eligible = getCurrency('PLN').denominations;
    const baseSeed = computeBaseSeed(req);
    const orders = buildArchetypeOrders(eligible, PLN_PER_MINOR);
    const n = eligible.length;
    for (const id of [0, 1, 7, 50, 191, 192, 193, 500, 2047]) {
      const config = makeCandidate(id, baseSeed, n, orders);
      const pol = mDecodePolicies(id, baseSeed);
      expect(pol).toEqual({
        startCorner: config.startCorner,
        orientPolicy: config.orientPolicy,
        fitHeuristic: config.fitHeuristic,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. shelfScore parity vs scoring.ts shelfScoreCandidate (all modes).
// ---------------------------------------------------------------------------
const SAMPLE_IDS = [0, 1, 7, 50, 100, 150, 191, 192, 193, 300, 500, 1000, 1500, 2047];

describe('wgslMirror shelfScore parity vs CPU twin', () => {
  const modes: Mode[] = ['cheapest', 'densest', 'fewest'];
  for (const currencyCode of ['PLN', 'USD']) {
    for (const mode of modes) {
      it(`${currencyCode} ${mode}: exact (coverageQ, metric, pieceCount) parity`, () => {
        const req = makeReq({ currencyCode, mode });
        const eligible = getCurrency(currencyCode).denominations;
        const baseSeed = computeBaseSeed(req);
        const orders = buildArchetypeOrders(eligible, PLN_PER_MINOR);
        const n = eligible.length;
        const mDenoms = toMirrorDenoms(eligible);
        const roomSide = computeRoomSideUnits(req.areaTenths);
        const mi = modeIndex(mode);

        for (const id of SAMPLE_IDS) {
          const config: Config = makeCandidate(id, baseSeed, n, orders);
          const cpu = shelfScoreCandidate(config, req, eligible, PLN_PER_MINOR);
          const mirror = mShelfScore({
            order: config.order,
            orientPolicy: config.orientPolicy,
            modeIndex: mi,
            roomSide,
            plnPerMinor: PLN_PER_MINOR,
            denoms: mDenoms,
          });
          expect(mirror, `candidate ${id}`).toEqual({
            coverageQ: cpu.coverageQ,
            metric: cpu.metric,
            pieceCount: cpu.pieceCount,
          });
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 5. RANKING parity — the argmax must agree with the CPU twin. Ranks a moderate
//    candidate set the same way runSearch/packCPU do (coverageQ desc, metric
//    desc, id asc) using each scorer, and asserts identical ordering.
// ---------------------------------------------------------------------------
describe('wgslMirror ranking parity vs CPU twin', () => {
  function rank(
    ids: number[],
    scoreOf: (id: number) => { coverageQ: number; metric: number },
  ): number[] {
    return [...ids].sort((a, b) => {
      const sa = scoreOf(a);
      const sb = scoreOf(b);
      if (sa.coverageQ !== sb.coverageQ) return sb.coverageQ - sa.coverageQ;
      if (sa.metric !== sb.metric) return sb.metric - sa.metric;
      return a - b;
    });
  }

  const modes: Mode[] = ['cheapest', 'densest', 'fewest'];
  for (const mode of modes) {
    it(`PLN ${mode}: full 512-candidate ranking is identical`, () => {
      const req = makeReq({ mode, areaTenths: 20 });
      const eligible = getCurrency('PLN').denominations;
      const baseSeed = computeBaseSeed(req);
      const orders = buildArchetypeOrders(eligible, PLN_PER_MINOR);
      const n = eligible.length;
      const mDenoms = toMirrorDenoms(eligible);
      const roomSide = computeRoomSideUnits(req.areaTenths);
      const mi = modeIndex(mode);

      const ids = Array.from({ length: 512 }, (_, i) => i);

      const cpuCache = new Map<number, { coverageQ: number; metric: number }>();
      const mirrorCache = new Map<number, { coverageQ: number; metric: number }>();
      for (const id of ids) {
        const config = makeCandidate(id, baseSeed, n, orders);
        const cpu = shelfScoreCandidate(config, req, eligible, PLN_PER_MINOR);
        cpuCache.set(id, { coverageQ: cpu.coverageQ, metric: cpu.metric });
        const mirror = mShelfScore({
          order: config.order,
          orientPolicy: config.orientPolicy,
          modeIndex: mi,
          roomSide,
          plnPerMinor: PLN_PER_MINOR,
          denoms: mDenoms,
        });
        mirrorCache.set(id, { coverageQ: mirror.coverageQ, metric: mirror.metric });
      }

      const cpuRank = rank(ids, (id) => cpuCache.get(id)!);
      const mirrorRank = rank(ids, (id) => mirrorCache.get(id)!);
      expect(mirrorRank).toEqual(cpuRank);
      // Sanity: at least some base configs are exercised.
      expect(ids.filter((i) => i < N_BASE_CONFIGS).length).toBeGreaterThan(0);
    });
  }
});
