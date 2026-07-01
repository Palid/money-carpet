import { describe, it, expect } from 'vitest';

import { getCurrency } from '@/lib/currency/dataset';
import type { PackRequest, PackResult, PackGeometry } from '@/lib/packer/types';
import { packCPU, replayCandidate } from '@/lib/packer/replay';
import { buildArchetypeOrders, computeBaseSeed, makeCandidate } from '@/lib/packer/candidates';
import { circleFill, bruteForceCircleFill } from '@/lib/packer/circleFill';
import { computeRoomSideUnits, type NotePlacement } from '@/lib/packer/skyline';

// PLN: 1 minor unit (grosz) = 0.01 PLN. USD via a fixed test rate 1 USD = 4 PLN
// -> 1 cent = 0.04 PLN.
const PLN_PER_MINOR = 0.01;
const USD_PLN_PER_MINOR = 0.04;

function makeReq(p: Partial<PackRequest>): PackRequest {
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

function geometryEqual(a: PackGeometry, b: PackGeometry): boolean {
  if (a.count !== b.count) return false;
  const keys = ['kind', 'denom', 'x', 'y', 'w', 'h', 'r', 'rot'] as const;
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    for (let i = 0; i < a.count; i++) if (av[i] !== bv[i]) return false;
  }
  return true;
}

function positionsEqual(a: PackGeometry, b: PackGeometry): boolean {
  if (a.count !== b.count) return false;
  const keys = ['kind', 'x', 'y', 'w', 'h', 'r', 'rot'] as const;
  for (const k of keys) {
    for (let i = 0; i < a.count; i++) if (a[k][i] !== b[k][i]) return false;
  }
  return true;
}

interface Piece {
  kind: number;
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}
function pieces(g: PackGeometry): Piece[] {
  const out: Piece[] = [];
  for (let i = 0; i < g.count; i++) {
    out.push({ kind: g.kind[i], x: g.x[i], y: g.y[i], w: g.w[i], h: g.h[i], r: g.r[i] });
  }
  return out;
}

function firstNoteLabel(res: PackResult): string {
  for (let i = 0; i < res.geometry.count; i++) {
    if (res.geometry.kind[i] === 0) return res.denomTable[res.geometry.denom[i]].label;
  }
  return '';
}

// ---------------------------------------------------------------------------
// 1. DETERMINISM
// ---------------------------------------------------------------------------
describe('determinism', () => {
  it('packCPU is byte-identical for the same PLN request', () => {
    const req = makeReq({ mode: 'densest' });
    const a = packCPU(req);
    const b = packCPU(req);
    expect(a.geometry.count).toBe(b.geometry.count);
    expect(geometryEqual(a.geometry, b.geometry)).toBe(true);
    expect(a.totalValueMinor).toBe(b.totalValueMinor);
    expect(a.pieceCount).toBe(b.pieceCount);
    expect(a.coverage).toBe(b.coverage);
    expect(a.candidateId).toBe(b.candidateId);
    expect(a.scoreKeyHi).toBe(b.scoreKeyHi);
    expect(a.scoreKeyLo).toBe(b.scoreKeyLo);
  }, 60000);

  it('packCPU is byte-identical for the same USD request', () => {
    const req = makeReq({ currencyCode: 'USD', plnPerMinor: USD_PLN_PER_MINOR, mode: 'cheapest' });
    const a = packCPU(req);
    const b = packCPU(req);
    expect(geometryEqual(a.geometry, b.geometry)).toBe(true);
    expect(a.totalValueMinor).toBe(b.totalValueMinor);
  }, 60000);
});

// ---------------------------------------------------------------------------
// 3. COIN FILL correctness (vs brute force, no overlaps, in bounds)
// ---------------------------------------------------------------------------
describe('circleFill correctness (small room)', () => {
  const eligible = getCurrency('PLN').denominations;
  const roomSide = computeRoomSideUnits(2); // 0.2 m^2

  it('fills a bare square without overlaps, within tolerance of brute force', () => {
    const notes: NotePlacement[] = [];
    const cf = circleFill(notes, roomSide, eligible);
    const bf = bruteForceCircleFill(notes, roomSide, eligible);

    expect(cf.coins.length).toBeGreaterThan(0);

    // Coverage within tolerance of the brute-force reference.
    expect(cf.coinArea).toBeGreaterThanOrEqual(0.8 * bf.coinArea);

    // No pairwise overlaps (exact integer squared-distance test).
    for (let i = 0; i < cf.coins.length; i++) {
      const a = cf.coins[i];
      for (let j = i + 1; j < cf.coins.length; j++) {
        const b = cf.coins[j];
        const dx = a.cx - b.cx;
        const dy = a.cy - b.cy;
        const rr = a.r + b.r;
        expect(dx * dx + dy * dy).toBeGreaterThanOrEqual(rr * rr);
      }
    }
    // All coins fully inside the room.
    for (const c of cf.coins) {
      expect(c.cx - c.r).toBeGreaterThanOrEqual(0);
      expect(c.cy - c.r).toBeGreaterThanOrEqual(0);
      expect(c.cx + c.r).toBeLessThanOrEqual(roomSide);
      expect(c.cy + c.r).toBeLessThanOrEqual(roomSide);
    }
  }, 60000);

  it('never overlaps a placed note', () => {
    const note: NotePlacement = { denomIndex: 0, x: 0, y: 0, w: 12000, h: 6000, rot: 0 };
    const cf = circleFill([note], roomSide, eligible);
    expect(cf.coins.length).toBeGreaterThan(0);
    for (const c of cf.coins) {
      // closest point on the note rect to the coin centre
      const nx = Math.max(note.x, Math.min(c.cx, note.x + note.w));
      const ny = Math.max(note.y, Math.min(c.cy, note.y + note.h));
      const dx = c.cx - nx;
      const dy = c.cy - ny;
      expect(dx * dx + dy * dy).toBeGreaterThanOrEqual(c.r * c.r);
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// 4. NO note overlaps; all pieces within room bounds
// ---------------------------------------------------------------------------
describe('note packing has no overlaps and stays in bounds', () => {
  it('PLN 4 m^2 densest', () => {
    const res = packCPU(makeReq({ mode: 'densest' }));
    const roomSide = res.roomSideUnits;
    const ps = pieces(res.geometry);
    const notes = ps.filter((p) => p.kind === 0);
    expect(notes.length).toBeGreaterThan(0);

    // No note-note overlap.
    for (let i = 0; i < notes.length; i++) {
      const a = notes[i];
      for (let j = i + 1; j < notes.length; j++) {
        const b = notes[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }

    // All pieces (notes and coins) within room bounds.
    for (const p of ps) {
      if (p.kind === 0) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.x + p.w).toBeLessThanOrEqual(roomSide);
        expect(p.y + p.h).toBeLessThanOrEqual(roomSide);
      } else {
        expect(p.x - p.r).toBeGreaterThanOrEqual(0);
        expect(p.y - p.r).toBeGreaterThanOrEqual(0);
        expect(p.x + p.r).toBeLessThanOrEqual(roomSide);
        expect(p.y + p.r).toBeLessThanOrEqual(roomSide);
      }
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// 5. PER-MODE SANITY
// ---------------------------------------------------------------------------
describe('per-mode sanity', () => {
  it('PLN 4 m^2: cheapest/densest coverage near-equal; fewest is fewest & sparser', () => {
    const cheapest = packCPU(makeReq({ mode: 'cheapest' }));
    const densest = packCPU(makeReq({ mode: 'densest' }));
    const fewest = packCPU(makeReq({ mode: 'fewest' }));

    // Coverage near-equal between cheapest and densest (within ~5%).
    expect(Math.abs(cheapest.coverage - densest.coverage)).toBeLessThanOrEqual(0.05);

    // Under coverage-first, densest never settles for less value than cheapest.
    expect(densest.totalValueMinor).toBeGreaterThanOrEqual(cheapest.totalValueMinor);

    // Fewest has the lowest piece count and lower coverage (notes only, no coins).
    expect(fewest.pieceCount).toBeLessThan(cheapest.pieceCount);
    expect(fewest.pieceCount).toBeLessThan(densest.pieceCount);
    expect(fewest.coverage).toBeLessThan(cheapest.coverage);
    for (let i = 0; i < fewest.geometry.count; i++) {
      expect(fewest.geometry.kind[i]).toBe(0); // no coins in fewest mode
    }
  }, 120000);

  it('USD: cheapest picks $1, densest picks $100, identical geometry, different value', () => {
    const cheapest = packCPU(makeReq({ currencyCode: 'USD', plnPerMinor: USD_PLN_PER_MINOR, mode: 'cheapest' }));
    const densest = packCPU(makeReq({ currencyCode: 'USD', plnPerMinor: USD_PLN_PER_MINOR, mode: 'densest' }));

    expect(firstNoteLabel(cheapest)).toBe('$1');
    expect(firstNoteLabel(densest)).toBe('$100');

    // Same note dimensions across all USD notes => identical positional geometry.
    expect(positionsEqual(cheapest.geometry, densest.geometry)).toBe(true);

    // But different denominations and a much larger total value for densest.
    expect(densest.totalValueMinor).toBeGreaterThan(cheapest.totalValueMinor * 10);

    // The note denom index differs (dollar notes are different indices).
    let denomDiffers = false;
    for (let i = 0; i < cheapest.geometry.count; i++) {
      if (cheapest.geometry.kind[i] === 0 && cheapest.geometry.denom[i] !== densest.geometry.denom[i]) {
        denomDiffers = true;
        break;
      }
    }
    expect(denomDiffers).toBe(true);
  }, 120000);
});

// ---------------------------------------------------------------------------
// 6. CAP / EXTRAPOLATION
// ---------------------------------------------------------------------------
describe('50k cap / linear extrapolation', () => {
  const eligible = getCurrency('PLN').denominations;

  function replayAt(areaTenths: number): PackResult {
    const req = makeReq({ areaTenths, mode: 'cheapest' });
    const baseSeed = computeBaseSeed(req);
    const orders = buildArchetypeOrders(eligible, req.plnPerMinor);
    const config = makeCandidate(0, baseSeed, eligible.length, orders);
    return replayCandidate(config, req, eligible, req.plnPerMinor);
  }

  it('caps a huge room and extrapolates linearly with area', () => {
    // Areas beyond the normal 1..10 m^2 UI range, chosen so the estimate exceeds
    // PIECE_CAP (the dataset cannot reach 50k pieces within 10 m^2).
    const a = replayAt(1200); // 120 m^2
    const b = replayAt(2400); // 240 m^2 (double)

    expect(a.capped).toBe(true);
    expect(b.capped).toBe(true);
    expect(a.extrapolationFactor).toBeGreaterThan(1);
    expect(a.patchAreaM2).toBeGreaterThan(0);
    // The real drawn geometry is the representative block, not the full room.
    expect(a.geometry.count).toBeLessThan(a.pieceCount);

    // Doubling area -> ~2x pieces and ~2x value, ~equal coverage.
    expect(b.pieceCount / a.pieceCount).toBeGreaterThan(1.9);
    expect(b.pieceCount / a.pieceCount).toBeLessThan(2.1);
    expect(b.totalValueMinor / a.totalValueMinor).toBeGreaterThan(1.9);
    expect(b.totalValueMinor / a.totalValueMinor).toBeLessThan(2.1);
    expect(Math.abs(a.coverage - b.coverage)).toBeLessThan(0.02);
  }, 120000);
});
