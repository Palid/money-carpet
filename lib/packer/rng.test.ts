import { describe, it, expect } from 'vitest';

import {
  makeRng,
  next,
  nextBounded,
  hashBaseSeed,
  GOLDEN_VECTOR,
  GOLDEN_SEED_INITSTATE,
  GOLDEN_SEED_INITSEQ,
  type U64,
} from '@/lib/packer/rng';

// ---------------------------------------------------------------------------
// Independent BigInt reference PCG32 (NOT used by production code; only here to
// cross-check the u32-lane generator).
// ---------------------------------------------------------------------------
const MASK64 = (1n << 64n) - 1n;
const MULT = 6364136223846793005n;

function rotr32(x: bigint, r: bigint): bigint {
  x &= 0xffffffffn;
  r &= 31n;
  return ((x >> r) | (x << ((-r) & 31n))) & 0xffffffffn;
}

class RefPCG {
  state = 0n;
  inc = 0n;
  seed(initstate: bigint, initseq: bigint): void {
    this.state = 0n;
    this.inc = ((initseq << 1n) | 1n) & MASK64;
    this.next();
    this.state = (this.state + initstate) & MASK64;
    this.next();
  }
  next(): bigint {
    const old = this.state;
    this.state = (old * MULT + this.inc) & MASK64;
    const xorshifted = (((old >> 18n) ^ old) >> 27n) & 0xffffffffn;
    const rot = (old >> 59n) & 0xffffffffn;
    return rotr32(xorshifted, rot);
  }
}

function u64ToBig(v: U64): bigint {
  return ((BigInt(v.hi >>> 0) << 32n) | BigInt(v.lo >>> 0)) & MASK64;
}

describe('PCG32 u32-lane generator', () => {
  it('matches the BigInt reference for 100 consecutive outputs', () => {
    const initstate: U64 = GOLDEN_SEED_INITSTATE;
    const initseq: U64 = GOLDEN_SEED_INITSEQ;

    const ref = new RefPCG();
    ref.seed(u64ToBig(initstate), u64ToBig(initseq));

    const rng = makeRng(initstate, initseq);

    for (let i = 0; i < 100; i++) {
      const expected = Number(ref.next());
      const got = next(rng);
      expect(got).toBe(expected);
    }
  });

  it('matches the BigInt reference for a different seed', () => {
    const initstate: U64 = { hi: 0, lo: 42 };
    const initseq: U64 = { hi: 0, lo: 54 };

    const ref = new RefPCG();
    ref.seed(u64ToBig(initstate), u64ToBig(initseq));
    const rng = makeRng(initstate, initseq);

    for (let i = 0; i < 100; i++) {
      expect(next(rng)).toBe(Number(ref.next()));
    }
  });

  it('reproduces the exported golden vector', () => {
    const rng = makeRng(GOLDEN_SEED_INITSTATE, GOLDEN_SEED_INITSEQ);
    const out: number[] = [];
    for (let i = 0; i < GOLDEN_VECTOR.length; i++) out.push(next(rng));
    expect(out).toEqual([...GOLDEN_VECTOR]);
  });

  it('nextBounded stays in range and covers the range', () => {
    const rng = makeRng({ hi: 0, lo: 1 }, { hi: 0, lo: 7 });
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = nextBounded(rng, 6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
      seen.add(v);
    }
    // Every bucket should appear at least once across 5000 draws.
    expect(seen.size).toBe(6);
  });

  it('hashBaseSeed is deterministic and stays in u32 lanes', () => {
    const a = hashBaseSeed('PLN', 40, 0, 1, 0);
    const b = hashBaseSeed('PLN', 40, 0, 1, 0);
    expect(a).toEqual(b);
    expect(a.hi).toBeGreaterThanOrEqual(0);
    expect(a.hi).toBeLessThanOrEqual(0xffffffff);
    expect(a.lo).toBeGreaterThanOrEqual(0);
    expect(a.lo).toBeLessThanOrEqual(0xffffffff);
    // Different inputs -> (almost surely) different seed.
    const c = hashBaseSeed('PLN', 40, 1, 1, 0);
    expect(u64ToBig(c)).not.toBe(u64ToBig(a));
  });
});
