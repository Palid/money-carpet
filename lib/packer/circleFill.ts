/**
 * True-circle coin gap-fill over the free space left by the note packer.
 *
 * Pipeline:
 *   1. Rasterize placed notes into an occupancy grid (cell size derived from the
 *      smallest coin radius, grid capped at 2048x2048).
 *   2. Felzenszwalb two-pass 1D squared-distance transform -> per free cell,
 *      squared distance to the nearest occupied cell. Combined with the exact
 *      distance to the room walls this gives a clearance field (SDF).
 *   3. Seat coins largest-radius-first at descending-SDF cells. Every placement
 *      is confirmed by an EXACT geometry test (integer squared distances) against
 *      notes, walls and already-placed coins, so overlaps are impossible even
 *      though the SDF used for ordering is approximate.
 *
 * `bruteForceCircleFill` is an O(n^2) reference used by tests on small rooms.
 */

import type { Denomination } from '@/lib/currency/types';
import { coinRadiusUnits } from '@/lib/currency/derived';
import type { NotePlacement } from '@/lib/packer/skyline';

export interface CoinPlacement {
  denomIndex: number;
  cx: number;
  cy: number;
  r: number;
}

export interface CircleFillResult {
  coins: CoinPlacement[];
  coinArea: number; // sum of PI*r^2 over placed coins (JS number)
}

interface CoinType {
  denomIndex: number;
  r: number;
}

/** Eligible coins as {denomIndex, r}, sorted by radius desc then index asc. */
export function eligibleCoinTypes(eligibleDenoms: Denomination[]): CoinType[] {
  const coins: CoinType[] = [];
  for (let i = 0; i < eligibleDenoms.length; i++) {
    const d = eligibleDenoms[i];
    if (d.kind !== 'coin') continue;
    const r = coinRadiusUnits(d);
    if (r > 0) coins.push({ denomIndex: i, r });
  }
  coins.sort((a, b) => (a.r !== b.r ? b.r - a.r : a.denomIndex - b.denomIndex));
  return coins;
}

/** Exact squared distance from point (px,py) to axis-aligned rect [x,x+w)x[y,y+h). 0 if inside. */
function rectDistSq(px: number, py: number, rx: number, ry: number, rw: number, rh: number): number {
  let dx = 0;
  if (px < rx) dx = rx - px;
  else if (px > rx + rw) dx = px - (rx + rw);
  let dy = 0;
  if (py < ry) dy = ry - py;
  else if (py > ry + rh) dy = py - (ry + rh);
  return dx * dx + dy * dy;
}

// ---------------------------------------------------------------------------
// Felzenszwalb 1D squared distance transform.
// ---------------------------------------------------------------------------
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dxq = q - v[k];
    d[q] = dxq * dxq + f[v[k]];
  }
}

/** 2D squared EDT of an occupancy grid (occupied cells = 0). Returns cell-unit squared distances. */
function distanceTransform2D(occ: Uint8Array, gridN: number): Float64Array {
  const INF = 1e20;
  const g = new Float64Array(gridN * gridN);
  for (let i = 0; i < g.length; i++) g[i] = occ[i] ? 0 : INF;

  const line = new Float64Array(gridN);
  const out = new Float64Array(gridN);
  const v = new Int32Array(gridN);
  const z = new Float64Array(gridN + 1);

  // Transform along x (rows).
  for (let y = 0; y < gridN; y++) {
    const base = y * gridN;
    for (let x = 0; x < gridN; x++) line[x] = g[base + x];
    dt1d(line, gridN, out, v, z);
    for (let x = 0; x < gridN; x++) g[base + x] = out[x];
  }
  // Transform along y (columns).
  for (let x = 0; x < gridN; x++) {
    for (let y = 0; y < gridN; y++) line[y] = g[y * gridN + x];
    dt1d(line, gridN, out, v, z);
    for (let y = 0; y < gridN; y++) g[y * gridN + x] = out[y];
  }
  return g;
}

/**
 * Fill the free space between notes with coins. If there are no eligible coins
 * the result is empty.
 *
 * `priorityCoinDenom` (optional, an index into `eligibleDenoms`) makes a chosen
 * coin DOMINANT: when set to an eligible coin, that coin is seated FIRST at every
 * SDF maximum it fits (highest-clearance seeds first), and only THEN are the
 * remaining coins seated largest-radius-first as usual. This is a CPU-only
 * priority with no bit-parity impact (the GPU coin score stays analytic); the
 * exact non-overlap geometry tests are unchanged.
 */
export function circleFill(
  notes: NotePlacement[],
  roomSide: number,
  eligibleDenoms: Denomination[],
  priorityCoinDenom?: number,
): CircleFillResult {
  const coinTypes = eligibleCoinTypes(eligibleDenoms);
  if (coinTypes.length === 0) return { coins: [], coinArea: 0 };

  const minCoinR = coinTypes[coinTypes.length - 1].r;
  const maxCoinR = coinTypes[0].r;

  // --- grid cell size: clamp(minCoinR/3, floor(roomSide/2048), roomSide/2048) ---
  const gLo = Math.floor(roomSide / 2048);
  const gHi = roomSide / 2048;
  let g = minCoinR / 3;
  if (g < gLo) g = gLo;
  if (g > gHi) g = gHi;
  g = Math.max(1, Math.round(g));
  let gridN = Math.ceil(roomSide / g);
  if (gridN > 2048) gridN = 2048;
  if (gridN < 1) gridN = 1;

  // --- occupancy: mark cells overlapping any note rect ---
  const occ = new Uint8Array(gridN * gridN);
  for (const nt of notes) {
    const i0 = Math.max(0, Math.floor(nt.x / g));
    const i1 = Math.min(gridN - 1, Math.floor((nt.x + nt.w) / g));
    const j0 = Math.max(0, Math.floor(nt.y / g));
    const j1 = Math.min(gridN - 1, Math.floor((nt.y + nt.h) / g));
    for (let j = j0; j <= j1; j++) {
      const base = j * gridN;
      for (let i = i0; i <= i1; i++) occ[base + i] = 1;
    }
  }

  // --- clearance field (world units) ---
  const dtSq = distanceTransform2D(occ, gridN);
  const nCells = gridN * gridN;
  const sdf = new Float64Array(nCells); // world-unit clearance, 0 if occupied
  // Cell centers as integer world coords.
  const cellCx = new Int32Array(nCells);
  const cellCy = new Int32Array(nCells);
  for (let c = 0; c < nCells; c++) {
    const i = c % gridN;
    const j = (c / gridN) | 0;
    const cx = Math.round((i + 0.5) * g);
    const cy = Math.round((j + 0.5) * g);
    cellCx[c] = cx;
    cellCy[c] = cy;
    if (occ[c]) {
      sdf[c] = 0;
      continue;
    }
    const noteDist = Math.sqrt(dtSq[c]) * g;
    const wallDist = Math.min(cx, roomSide - cx, cy, roomSide - cy);
    sdf[c] = Math.min(noteDist, wallDist);
  }

  // --- seed candidates: cells with sdf >= minCoinR, counting-sorted by sdf desc ---
  // We subsample cells on a stride well below the smallest coin radius: the SDF
  // grid stays full-resolution, but coin CENTRES are only tried on the coarser
  // lattice. Spacing is <= minCoinR/4 so no realistic placement is missed, and
  // it keeps the scan cheap even for a room that is almost entirely free space.
  const seedStride = Math.max(1, Math.floor(minCoinR / (4 * g)));
  const isSeedCell = (c: number) => {
    const i = c % gridN;
    const j = (c / gridN) | 0;
    return i % seedStride === 0 && j % seedStride === 0;
  };

  // Bin by floor(sdf / g) so the sort is O(n + bins) and deterministic.
  const nBins = gridN + 2;
  const binOf = (s: number) => {
    let b = Math.floor(s / g);
    if (b < 0) b = 0;
    if (b >= nBins) b = nBins - 1;
    return b;
  };
  const binCount = new Int32Array(nBins);
  let seedTotal = 0;
  for (let c = 0; c < nCells; c++) {
    if (sdf[c] >= minCoinR && isSeedCell(c)) {
      binCount[binOf(sdf[c])]++;
      seedTotal++;
    }
  }
  // Descending bins -> compute start offsets.
  const binStart = new Int32Array(nBins);
  let acc = 0;
  for (let b = nBins - 1; b >= 0; b--) {
    binStart[b] = acc;
    acc += binCount[b];
  }
  const seeds = new Int32Array(seedTotal);
  const cursor = binStart.slice();
  // Iterate cells in row-major order so within a bin the order is by cell index.
  for (let c = 0; c < nCells; c++) {
    if (sdf[c] >= minCoinR && isSeedCell(c)) {
      const b = binOf(sdf[c]);
      seeds[cursor[b]++] = c;
    }
  }

  // --- coin spatial hash (bucket = 2*maxCoinR) ---
  const cb = Math.max(1, 2 * maxCoinR);
  const coinBuckets = new Map<number, CoinPlacement[]>();
  const bucketKey = (bx: number, by: number) => bx * 73856093 + by * 19349663;
  const addCoinToHash = (coin: CoinPlacement) => {
    const bx = Math.floor(coin.cx / cb);
    const by = Math.floor(coin.cy / cb);
    const key = bucketKey(bx, by);
    let arr = coinBuckets.get(key);
    if (!arr) {
      arr = [];
      coinBuckets.set(key, arr);
    }
    arr.push(coin);
  };
  const coinOverlaps = (cx: number, cy: number, r: number): boolean => {
    const bx = Math.floor(cx / cb);
    const by = Math.floor(cy / cb);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const arr = coinBuckets.get(bucketKey(bx + ox, by + oy));
        if (!arr) continue;
        for (const p of arr) {
          const dx = cx - p.cx;
          const dy = cy - p.cy;
          const rr = r + p.r;
          if (dx * dx + dy * dy < rr * rr) return true;
        }
      }
    }
    return false;
  };

  // --- note spatial hash (register each note into buckets its expanded bbox touches) ---
  const nb = Math.max(1, maxCoinR);
  const noteBuckets = new Map<number, number[]>();
  for (let ni = 0; ni < notes.length; ni++) {
    const nt = notes[ni];
    const bx0 = Math.floor((nt.x - maxCoinR) / nb);
    const bx1 = Math.floor((nt.x + nt.w + maxCoinR) / nb);
    const by0 = Math.floor((nt.y - maxCoinR) / nb);
    const by1 = Math.floor((nt.y + nt.h + maxCoinR) / nb);
    for (let bx = bx0; bx <= bx1; bx++) {
      for (let by = by0; by <= by1; by++) {
        const key = bucketKey(bx, by);
        let arr = noteBuckets.get(key);
        if (!arr) {
          arr = [];
          noteBuckets.set(key, arr);
        }
        arr.push(ni);
      }
    }
  }
  const noteOverlaps = (cx: number, cy: number, r: number): boolean => {
    const bx = Math.floor(cx / nb);
    const by = Math.floor(cy / nb);
    const arr = noteBuckets.get(bucketKey(bx, by));
    if (!arr) return false;
    const r2 = r * r;
    for (const ni of arr) {
      const nt = notes[ni];
      if (rectDistSq(cx, cy, nt.x, nt.y, nt.w, nt.h) < r2) return true;
    }
    return false;
  };

  // --- seat coins ---
  // Single pass over seeds in descending-SDF order; at each seed place the
  // LARGEST coin that fits (seeds with the most clearance come first, so larger
  // coins are seated first and smaller coins fall into the interstices). Every
  // placement is confirmed by exact integer geometry tests, so the approximate
  // SDF ordering can never cause an overlap. `consumed` cells (already inside a
  // placed coin) are skipped so later seeds are not rescanned.
  const coins: CoinPlacement[] = [];
  let coinArea = 0;
  const consumed = new Uint8Array(nCells);
  const slack = g; // one-cell tolerance for the approximate sdf ordering

  const markConsumed = (cx: number, cy: number, r: number) => {
    const i0 = Math.max(0, Math.floor((cx - r) / g));
    const i1 = Math.min(gridN - 1, Math.floor((cx + r) / g));
    const j0 = Math.max(0, Math.floor((cy - r) / g));
    const j1 = Math.min(gridN - 1, Math.floor((cy + r) / g));
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const base = j * gridN;
      for (let i = i0; i <= i1; i++) {
        const cc = base + i;
        const dx = cellCx[cc] - cx;
        const dy = cellCy[cc] - cy;
        if (dx * dx + dy * dy < r2) consumed[cc] = 1;
      }
    }
  };

  // One seating pass: scan seeds in descending-SDF order and, at each unconsumed
  // seed, place the first coin from `types` (already radius-desc) that fits. This
  // is exactly the original single pass when called with the full coinTypes list.
  const seatPass = (types: CoinType[]) => {
    if (types.length === 0) return;
    const minR = types[types.length - 1].r; // smallest radius in this pass
    for (let si = 0; si < seeds.length; si++) {
      const c = seeds[si];
      if (consumed[c]) continue;
      const clear = sdf[c];
      if (clear < minR - slack) continue; // even the smallest coin in this pass cannot fit
      const cx = cellCx[c];
      const cy = cellCy[c];
      for (const ct of types) {
        const r = ct.r;
        if (clear < r - slack) continue; // this coin is too big for the clearance here
        if (cx - r < 0 || cx + r > roomSide || cy - r < 0 || cy + r > roomSide) continue;
        if (noteOverlaps(cx, cy, r)) continue;
        if (coinOverlaps(cx, cy, r)) continue;
        const coin: CoinPlacement = { denomIndex: ct.denomIndex, cx, cy, r };
        coins.push(coin);
        addCoinToHash(coin);
        coinArea += Math.PI * r * r;
        markConsumed(cx, cy, r);
        break; // largest fitting coin placed; move to the next seed
      }
    }
  };

  // Coin-primary: seat the priority coin at all maxima it fits FIRST (dominant),
  // then fall through to the normal largest-first fill for the interstitial gaps.
  if (priorityCoinDenom != null) {
    const priority = coinTypes.find((ct) => ct.denomIndex === priorityCoinDenom);
    if (priority) seatPass([priority]);
  }
  seatPass(coinTypes);

  return { coins, coinArea };
}

/**
 * Brute-force circle fill reference (O(n^2)); scans candidate points on a fine
 * grid, largest-radius-first, testing every note/wall/placed-coin exactly. Used
 * by tests on small rooms to bound the coverage of `circleFill`.
 */
export function bruteForceCircleFill(
  notes: NotePlacement[],
  roomSide: number,
  eligibleDenoms: Denomination[],
  step?: number,
): CircleFillResult {
  const coinTypes = eligibleCoinTypes(eligibleDenoms);
  if (coinTypes.length === 0) return { coins: [], coinArea: 0 };
  const minCoinR = coinTypes[coinTypes.length - 1].r;
  const st = step && step > 0 ? Math.round(step) : Math.max(1, Math.round(minCoinR / 3));

  const coins: CoinPlacement[] = [];
  let coinArea = 0;

  const noteOverlaps = (cx: number, cy: number, r: number): boolean => {
    const r2 = r * r;
    for (const nt of notes) {
      if (rectDistSq(cx, cy, nt.x, nt.y, nt.w, nt.h) < r2) return true;
    }
    return false;
  };
  const coinOverlaps = (cx: number, cy: number, r: number): boolean => {
    for (const p of coins) {
      const dx = cx - p.cx;
      const dy = cy - p.cy;
      const rr = r + p.r;
      if (dx * dx + dy * dy < rr * rr) return true;
    }
    return false;
  };

  for (const ct of coinTypes) {
    const r = ct.r;
    for (let cy = 0; cy <= roomSide; cy += st) {
      if (cy - r < 0 || cy + r > roomSide) continue;
      for (let cx = 0; cx <= roomSide; cx += st) {
        if (cx - r < 0 || cx + r > roomSide) continue;
        if (noteOverlaps(cx, cy, r)) continue;
        if (coinOverlaps(cx, cy, r)) continue;
        coins.push({ denomIndex: ct.denomIndex, cx, cy, r });
        coinArea += Math.PI * r * r;
      }
    }
  }

  return { coins, coinArea };
}
