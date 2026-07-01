// Synthetic PackResult generator for exercising the render layer standalone,
// without depending on the real packer (which is built in parallel).
//
// Deterministic: seeded via a simple LCG (no Math.random) so the same opts
// always produce byte-identical geometry, which is what makes the tooltip /
// zoom tests reliable.
import { DATASET_VERSION, FP, PIECE_CAP, UNITS_PER_M } from '@/lib/config/constants';
import type { DenomRef, Mode, PackGeometry, PackResult, PerDenomStat } from '@/lib/packer/types';

export interface SyntheticOptions {
  /** Total number of pieces to generate. Supports up to PIECE_CAP (50000). */
  pieceCount?: number;
  /** Requested room area in square meters (drives roomSideUnits). */
  roomAreaM2?: number;
  currencyCode?: string;
  mode?: Mode;
  /** LCG seed; same seed + opts => identical output. */
  seed?: number;
  /** Fraction (0..1) of pieces that are notes; the rest are coins. */
  noteFraction?: number;
  /** Gap between grid cells, in mm. Keeps a visible seam for hit-testing tests. */
  gapMm?: number;
}

interface NoteDenomSeed {
  minorValue: number;
  label: string;
  color: string;
  wMm: number;
  hMm: number;
}
interface CoinDenomSeed {
  minorValue: number;
  label: string;
  color: string;
  dMm: number;
}

const NOTE_SEEDS: NoteDenomSeed[] = [
  { minorValue: 1000, label: '10', color: '#3d7a3d', wMm: 120, hMm: 60 },
  { minorValue: 2000, label: '20', color: '#2255aa', wMm: 126, hMm: 63 },
  { minorValue: 5000, label: '50', color: '#a05a2c', wMm: 132, hMm: 66 },
  { minorValue: 10000, label: '100', color: '#7a3d7a', wMm: 138, hMm: 69 },
];

const COIN_SEEDS: CoinDenomSeed[] = [
  { minorValue: 500, label: '5', color: '#c9a227', dMm: 24 },
  { minorValue: 200, label: '2', color: '#b5b5b5', dMm: 21 },
  { minorValue: 100, label: '1', color: '#d4af37', dMm: 18 },
];

/** Simple deterministic LCG (Numerical Recipes constants). Returns [0,1). */
function makeLcg(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return function next(): number {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function mmToUnits(mm: number): number {
  return Math.round(mm * FP);
}

export function makeSyntheticResult(opts: SyntheticOptions = {}): PackResult {
  const {
    pieceCount = 2000,
    roomAreaM2 = 4,
    currencyCode = 'PLN',
    mode = 'densest',
    seed = 1,
    noteFraction = 0.6,
    gapMm = 4,
  } = opts;

  const n = Math.max(1, Math.min(Math.floor(pieceCount), PIECE_CAP));
  const noteCount = Math.max(0, Math.min(n, Math.round(n * clamp01(noteFraction))));
  const coinCount = n - noteCount;
  const rand = makeLcg(seed);

  const denomTable: DenomRef[] = [
    ...NOTE_SEEDS.map(
      (d): DenomRef => ({
        currencyCode,
        label: d.label,
        color: d.color,
        kind: 'note',
        minorValue: d.minorValue,
        minorDigits: 2,
      }),
    ),
    ...COIN_SEEDS.map(
      (d): DenomRef => ({
        currencyCode,
        label: d.label,
        color: d.color,
        kind: 'coin',
        minorValue: d.minorValue,
        minorDigits: 2,
      }),
    ),
  ];

  const kind = new Uint8Array(n);
  const denom = new Uint16Array(n);
  const x = new Int32Array(n);
  const y = new Int32Array(n);
  const w = new Int32Array(n);
  const h = new Int32Array(n);
  const r = new Int32Array(n);
  const rot = new Uint8Array(n);

  const gap = mmToUnits(gapMm);

  // --- Notes: uniform grid, cell sized to the largest note so cells never overlap. ---
  const maxNoteWUnits = Math.max(...NOTE_SEEDS.map((d) => mmToUnits(d.wMm)));
  const maxNoteHUnits = Math.max(...NOTE_SEEDS.map((d) => mmToUnits(d.hMm)));
  const cellW = maxNoteWUnits + gap;
  const cellH = maxNoteHUnits + gap;
  const noteCols = Math.max(1, Math.ceil(Math.sqrt(noteCount)));

  let i = 0;
  for (let idx = 0; idx < noteCount; idx++) {
    const row = Math.floor(idx / noteCols);
    const col = idx % noteCols;
    const denomIdx = Math.floor(rand() * NOTE_SEEDS.length) % NOTE_SEEDS.length;
    const spec = NOTE_SEEDS[denomIdx];
    kind[i] = 0;
    denom[i] = denomIdx;
    x[i] = col * cellW;
    y[i] = row * cellH;
    w[i] = mmToUnits(spec.wMm);
    h[i] = mmToUnits(spec.hMm);
    r[i] = 0;
    // w/h already store the effective, as-placed footprint (matching the real
    // packer's convention - see lib/packer/types.ts), so rot is metadata only
    // and is always 0 here (no rotation applied to the generated grid).
    rot[i] = 0;
    i++;
  }
  const noteRows = noteCount > 0 ? Math.ceil(noteCount / noteCols) : 0;
  const gridWidthUnits = noteCols * cellW;
  const gridHeightUnits = noteRows * cellH;

  // --- Coins: own sub-grid below the note grid, own cell size so it never overlaps notes. ---
  const maxCoinDiameterUnits = Math.max(...COIN_SEEDS.map((d) => mmToUnits(d.dMm)));
  const coinCell = maxCoinDiameterUnits + gap;
  const coinCols = Math.max(1, Math.ceil(Math.sqrt(coinCount)));
  const coinOriginY = gridHeightUnits + (noteCount > 0 && coinCount > 0 ? gap : 0);

  for (let idx = 0; idx < coinCount; idx++) {
    const row = Math.floor(idx / coinCols);
    const col = idx % coinCols;
    const denomIdx = Math.floor(rand() * COIN_SEEDS.length) % COIN_SEEDS.length;
    const spec = COIN_SEEDS[denomIdx];
    const radius = Math.round(mmToUnits(spec.dMm) / 2);
    const cx = col * coinCell + coinCell / 2;
    const cy = coinOriginY + row * coinCell + coinCell / 2;
    kind[i] = 1;
    denom[i] = NOTE_SEEDS.length + denomIdx;
    x[i] = Math.round(cx);
    y[i] = Math.round(cy);
    w[i] = 0;
    h[i] = 0;
    r[i] = radius;
    rot[i] = 0;
    i++;
  }
  const coinRows = coinCount > 0 ? Math.ceil(coinCount / coinCols) : 0;
  const patchWidthUnits = Math.max(gridWidthUnits, coinCols * coinCell, 1);
  const patchHeightUnits = Math.max(coinOriginY + coinRows * coinCell, 1);
  const patchSideUnits = Math.max(patchWidthUnits, patchHeightUnits, 1);

  const geometry: PackGeometry = { count: n, kind, denom, x, y, w, h, r, rot };

  // The requested room area drives roomSideUnits. If the generated patch is
  // larger than the room (asking for more pieces than physically fit), fall
  // back to the same "representative patch + extrapolation" story the real
  // packer uses (see PackResult.capped/extrapolationFactor/patchAreaM2).
  const roomSideUnits = Math.max(1, Math.round(Math.sqrt(roomAreaM2) * UNITS_PER_M));
  const roomAreaM2Actual = (roomSideUnits / UNITS_PER_M) ** 2;
  const capped = patchSideUnits > roomSideUnits;
  const patchAreaM2 = capped ? (patchSideUnits / UNITS_PER_M) ** 2 : undefined;
  const extrapolationFactor = capped && patchAreaM2 ? roomAreaM2Actual / patchAreaM2 : 1;

  const perDenomAgg = new Map<number, { count: number; value: number }>();
  for (let p = 0; p < n; p++) {
    const d = denom[p];
    const spec = denomTable[d];
    const agg = perDenomAgg.get(d) ?? { count: 0, value: 0 };
    agg.count += 1;
    agg.value += spec.minorValue;
    perDenomAgg.set(d, agg);
  }
  const perDenom: PerDenomStat[] = Array.from(perDenomAgg.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([denomIndex, agg]) => ({
      denomIndex,
      label: denomTable[denomIndex].label,
      count: Math.round(agg.count * extrapolationFactor),
      valueMinor: Math.round(agg.value * extrapolationFactor),
    }));

  const pieceCountTotal = perDenom.reduce((sum, d) => sum + d.count, 0);
  const totalValueMinor = perDenom.reduce((sum, d) => sum + d.valueMinor, 0);

  // Rough occupied-area coverage estimate from the drawn geometry.
  let occupiedAreaUnits2 = 0;
  for (let p = 0; p < n; p++) {
    if (kind[p] === 0) {
      occupiedAreaUnits2 += w[p] * h[p];
    } else {
      occupiedAreaUnits2 += Math.PI * r[p] * r[p];
    }
  }
  const roomAreaUnits2 = roomSideUnits * roomSideUnits;
  const coverage = clamp01((occupiedAreaUnits2 * extrapolationFactor) / roomAreaUnits2);

  return {
    mode,
    currencyCode,
    roomSideUnits,
    roomAreaM2: roomAreaM2Actual,
    denomTable,
    geometry,
    pieceCount: pieceCountTotal,
    coverage,
    totalValueMinor,
    totalPLN: 0,
    perDenom,
    capped,
    extrapolationFactor,
    patchAreaM2,
    fxSnapshotId: 'synthetic',
    fxStale: false,
    datasetVersion: DATASET_VERSION,
    candidateId: 0,
    scoreKeyHi: Math.round(coverage * 1_000_000),
    scoreKeyLo: 0,
  };
}
