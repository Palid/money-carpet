import { describe, it, expect } from 'vitest';

// lib/packer — the FINISHED, TESTED CPU packer this mirror must match.
import { getCurrency } from '@/lib/currency/dataset';
import { noteDimsUnits, coinRadiusUnits } from '@/lib/currency/derived';
import type { Denomination } from '@/lib/currency/types';
import type { PackRequest, Mode } from '@/lib/packer/types';
import { hashBaseSeed, type U64 } from '@/lib/packer/rng';
import {
  applyPrimaryFirst,
  buildArchetypeOrders,
  computeBaseSeed,
  makeCandidate,
  modeIndex,
  type Config,
} from '@/lib/packer/candidates';
import { getEligibleDenoms } from '@/lib/packer/eligible';
import { shelfScoreCandidate } from '@/lib/packer/scoring';
import { computeRoomSideUnits } from '@/lib/packer/skyline';

// The pure-TS transcription of the WGSL kernel under test.
import {
  next as mNext,
  makeRng as mMakeRng,
  makePermutation as mMakePermutation,
  decodePolicies as mDecodePolicies,
  applyPrimaryFirst as mApplyPrimaryFirst,
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
    primaryDenom: null,
    onlyPrimary: false,
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

// ---------------------------------------------------------------------------
// 6. "main denomination" (primary) parity — the new packer feature. The mirror's
//    applyPrimaryFirst + reconstructOrder must move the primary to the front the
//    SAME way lib/packer candidates.ts does (which the WGSL kernel then mirrors).
// ---------------------------------------------------------------------------
describe('wgslMirror applyPrimaryFirst parity vs CPU', () => {
  // (order, idx) vectors: identity, middle, already-first, last, single-shift.
  const cases: Array<{ order: number[]; idx: number }> = [
    { order: [0, 1, 2, 3, 4], idx: -1 }, // identity (no primary)
    { order: [0, 1, 2, 3, 4], idx: 2 }, // primary in the middle
    { order: [3, 1, 4, 0, 2], idx: 3 }, // primary already first
    { order: [3, 1, 4, 0, 2], idx: 2 }, // primary last
    { order: [5, 6, 7], idx: 7 }, // shift a single leading element
    { order: [8, 6, 7, 5, 2, 4, 1, 3, 0], idx: 8 }, // 9-coin golden order, already-first
  ];
  for (const { order, idx } of cases) {
    it(`matches candidates.applyPrimaryFirst for order=${order} idx=${idx}`, () => {
      const cpu = Array.from(applyPrimaryFirst(Int32Array.from(order), idx));
      const mirror = mApplyPrimaryFirst(order, idx);
      expect(mirror).toEqual(cpu);
    });
  }
});

describe('wgslMirror primary-denomination ordering golden', () => {
  it('PLN 5 zł coin primary => 9 coins, primaryEligibleIndex=8, candidate #0 order [8,6,7,5,2,4,1,3,0]', () => {
    const req = makeReq({
      mode: 'densest',
      areaTenths: 40,
      excludeNonIssued: true,
      primaryDenom: 14, // 5 zł coin (full-array index)
      onlyPrimary: false,
      candidateCount: 64,
    });
    const { eligible, primaryEligibleIndex } = getEligibleDenoms(req);

    // Coin-primary drops all notes -> the 9 PLN coins, primary last in dataset order.
    expect(eligible.length).toBe(9);
    expect(eligible.every((d) => d.kind === 'coin')).toBe(true);
    expect(primaryEligibleIndex).toBe(8);

    const baseSeed = computeBaseSeed(req);
    const orders = buildArchetypeOrders(eligible, PLN_PER_MINOR);
    const n = eligible.length;

    // candidate #0 is base archetype 0; final ordering has the primary at front.
    const mirrorOrder = mReconstructOrder(0, baseSeed, n, orders, primaryEligibleIndex);
    const cpuOrder = Array.from(
      makeCandidate(0, baseSeed, n, orders, primaryEligibleIndex).order,
    );
    expect(mirrorOrder).toEqual([8, 6, 7, 5, 2, 4, 1, 3, 0]);
    expect(mirrorOrder).toEqual(cpuOrder);
  });
});

// ---------------------------------------------------------------------------
// 7. shelfScore parity WITH the primary feature engaged (note-primary + coin-
//    primary). The mirror reconstructs the primary-first order itself, so this
//    exercises reconstructOrder + applyPrimaryFirst + shelfScore end-to-end.
// ---------------------------------------------------------------------------
describe('wgslMirror shelfScore parity vs CPU twin (primary engaged)', () => {
  const SAMPLE = [0, 1, 7, 50, 100, 191, 192, 193, 300, 500, 1000, 2047];
  // primaryDenom 14 = 5 zł COIN (drops notes); 2 = 50 zł NOTE (keeps coins as fill).
  const scenarios: Array<{ label: string; primaryDenom: number }> = [
    { label: 'coin-primary (5 zł)', primaryDenom: 14 },
    { label: 'note-primary (50 zł)', primaryDenom: 2 },
  ];
  const modes: Mode[] = ['cheapest', 'densest', 'fewest'];

  for (const { label, primaryDenom } of scenarios) {
    for (const mode of modes) {
      it(`PLN ${mode} ${label}: exact (coverageQ, metric, pieceCount) parity + ranking`, () => {
        const req = makeReq({
          mode,
          areaTenths: 20,
          excludeNonIssued: true,
          primaryDenom,
          onlyPrimary: false,
        });
        const { eligible, primaryEligibleIndex } = getEligibleDenoms(req);
        expect(primaryEligibleIndex).toBeGreaterThanOrEqual(0);

        const baseSeed = computeBaseSeed(req);
        const orders = buildArchetypeOrders(eligible, PLN_PER_MINOR);
        const n = eligible.length;
        const mDenoms = toMirrorDenoms(eligible);
        const roomSide = computeRoomSideUnits(req.areaTenths);
        const mi = modeIndex(mode);

        const cpuScores = new Map<number, { coverageQ: number; metric: number }>();
        const mirrorScores = new Map<number, { coverageQ: number; metric: number }>();

        for (const id of SAMPLE) {
          const config: Config = makeCandidate(id, baseSeed, n, orders, primaryEligibleIndex);
          const cpu = shelfScoreCandidate(config, req, eligible, PLN_PER_MINOR);
          // Mirror rebuilds the primary-first order from scratch (reconstruct path).
          const mirrorOrder = mReconstructOrder(id, baseSeed, n, orders, primaryEligibleIndex);
          expect(mirrorOrder, `order ${id}`).toEqual(Array.from(config.order));
          const mirror = mShelfScore({
            order: mirrorOrder,
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
          cpuScores.set(id, { coverageQ: cpu.coverageQ, metric: cpu.metric });
          mirrorScores.set(id, { coverageQ: mirror.coverageQ, metric: mirror.metric });
        }

        const rank = (m: Map<number, { coverageQ: number; metric: number }>) =>
          [...SAMPLE].sort((a, b) => {
            const sa = m.get(a)!;
            const sb = m.get(b)!;
            if (sa.coverageQ !== sb.coverageQ) return sb.coverageQ - sa.coverageQ;
            if (sa.metric !== sb.metric) return sb.metric - sa.metric;
            return a - b;
          });
        expect(rank(mirrorScores)).toEqual(rank(cpuScores));
      });
    }
  }
});
