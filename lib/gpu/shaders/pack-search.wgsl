// pack-search.wgsl — WebGPU parallel candidate-search kernel.
//
// ONE THREAD = ONE CANDIDATE CONFIG. Each thread reconstructs its config from
// (candidateIndex, baseSeed), runs the NFDH shelf note-pack + analytic coin
// coverage estimate (the CPU twin scoring.ts `shelfScoreCandidate`), and writes
// an INTEGER score key. The GPU only RANKS; the CPU `replayTopK` authoritatively
// replays the winner. A GPU bug can only make the search slightly worse-ranked.
//
// This shader is a VERBATIM port of lib/gpu/wgslMirror.ts (which itself mirrors
// lib/packer/rng.ts, candidate.ts, skyline.ts, scoring.ts). Keep the two
// line-for-line identical; the wgslMirror.next / makePermutation / shelfScore
// parity tests are the guard for the #1 project risk.
//
// PRIVATE STATE: the shelf pack keeps only O(1) SCALARS (y, x, shelfH, area,
// value, counts) — it never materializes placements (which can reach 50k). The
// only per-thread array is `order`, a denom-sized (<= MAX_DENOMS) READ buffer,
// exactly like the CPU's config.order; it is bounded by the denomination count,
// not by the piece count, so thread-per-candidate stays feasible.
//
// FLOAT NOTE: area/value accumulators are f32 here vs f64 in scoring.ts/mirror.
// The emitted KEYS (coverageQ, metric, pieceCount) are u32, so argmax is a pure
// integer compare and is bit-identical across hardware. The f32<->f64 gap can
// only nudge a key by 1 near a quantization boundary — a ranking approximation,
// never wrong output (CPU replay is authoritative).

// ===========================================================================
// PCG32, u32-lane (mirror: wgslMirror.ts / rng.ts). BIT-EXACT integer ops.
// ===========================================================================

const MULT_HI: u32 = 0x5851f42du; // rng.ts:40
const MULT_LO: u32 = 0x4c957f2du; // rng.ts:41

struct U64 { hi: u32, lo: u32, }
struct Rng { stateHi: u32, stateLo: u32, incHi: u32, incLo: u32, }

// rng.ts:58 mul32 — full 64-bit product of two u32 as {hi,lo} via 16-bit partials.
fn mul32(a: u32, b: u32) -> U64 {
  let aL = a & 0xffffu;
  let aH = a >> 16u;
  let bL = b & 0xffffu;
  let bH = b >> 16u;

  let ll = aL * bL;
  let lh = aL * bH;
  let hl = aH * bL;
  let hh = aH * bH;

  let mid = (ll >> 16u) + (lh & 0xffffu) + (hl & 0xffffu);

  let lo = (ll & 0xffffu) | ((mid & 0xffffu) << 16u);
  let hi = hh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u);
  return U64(hi, lo);
}

// rng.ts:82 mulAdd64 — (a*b + c) mod 2^64. `a*b` low-lane wraps == umul32lo.
fn mulAdd64(aHi: u32, aLo: u32, bHi: u32, bLo: u32, cHi: u32, cLo: u32) -> U64 {
  let ll = mul32(aLo, bLo);
  let prodLo = ll.lo;
  let prodHi = ll.hi + (aLo * bHi) + (aHi * bLo);

  let sumLo = prodLo + cLo; // u32 wraps
  let carry = select(0u, 1u, sumLo < prodLo); // overflow == wrapped below addend
  let hi = prodHi + cHi + carry;
  return U64(hi, sumLo);
}

// rng.ts:98 add64 — (a+b) mod 2^64.
fn add64(aHi: u32, aLo: u32, bHi: u32, bLo: u32) -> U64 {
  let sumLo = aLo + bLo;
  let carry = select(0u, 1u, sumLo < aLo);
  let hi = aHi + bHi + carry;
  return U64(hi, sumLo);
}

// rng.ts:107 rotr32 — rotate-right 32-bit; rotr32(x,0) == x.
fn rotr32(x: u32, rot: u32) -> u32 {
  let r = rot & 31u;
  return (x >> r) | (x << ((0u - r) & 31u));
}

// rng.ts:116 next — advance the stream, return next u32. Mutates *rng.
fn nextRng(rng: ptr<function, Rng>) -> u32 {
  let oldHi = (*rng).stateHi;
  let oldLo = (*rng).stateLo;

  let s = mulAdd64(oldHi, oldLo, MULT_HI, MULT_LO, (*rng).incHi, (*rng).incLo);
  (*rng).stateHi = s.hi;
  (*rng).stateLo = s.lo;

  let sh18Lo = (oldLo >> 18u) | (oldHi << 14u);
  let sh18Hi = oldHi >> 18u;
  let xLo = sh18Lo ^ oldLo;
  let xHi = sh18Hi ^ oldHi;
  let xorshifted = (xLo >> 27u) | (xHi << 5u);
  let rot = oldHi >> 27u;

  return rotr32(xorshifted, rot);
}

// rng.ts:146 seed + rng.ts:165 makeRng — seed & construct a stream.
fn makeRng(initstateHi: u32, initstateLo: u32, initseqHi: u32, initseqLo: u32) -> Rng {
  var rng: Rng;
  rng.stateHi = 0u;
  rng.stateLo = 0u;
  rng.incLo = (initseqLo << 1u) | 1u;
  rng.incHi = (initseqHi << 1u) | (initseqLo >> 31u);
  _ = nextRng(&rng);
  let s = add64(rng.stateHi, rng.stateLo, initstateHi, initstateLo);
  rng.stateHi = s.hi;
  rng.stateLo = s.lo;
  _ = nextRng(&rng);
  return rng;
}

// rng.ts:176 nextBounded — plain modulo (deliberate; trivially identical in WGSL).
fn nextBounded(rng: ptr<function, Rng>, n: u32) -> u32 {
  return nextRng(rng) % n;
}

// ===========================================================================
// Candidate reconstruction (mirror: wgslMirror.ts / candidate.ts).
// ===========================================================================

const N_ARCHETYPES: u32 = 8u;
const N_START_CORNERS: u32 = 4u;
const N_ORIENT_POLICIES: u32 = 3u;
const N_FIT_HEURISTICS: u32 = 2u;
const N_BASE_CONFIGS: u32 = 192u; // 8*4*3*2
const MAX_DENOMS: u32 = 64u; // upper bound on eligible denominations

// candidate.ts:37 decodeBaseArchetype -> (archetype, startCorner, orientPolicy, fitHeuristic)
fn decodeBaseArchetype(candidateId: u32) -> vec4<u32> {
  var id = candidateId;
  let fitHeuristic = id % N_FIT_HEURISTICS;
  id = id / N_FIT_HEURISTICS;
  let orientPolicy = id % N_ORIENT_POLICIES;
  id = id / N_ORIENT_POLICIES;
  let startCorner = id % N_START_CORNERS;
  id = id / N_START_CORNERS;
  let archetype = id % N_ARCHETYPES;
  return vec4<u32>(archetype, startCorner, orientPolicy, fitHeuristic);
}

// candidate.ts:72 makePermutation — Fisher-Yates into a bounded function-local
// order array. i runs n-1..1; j = nextBounded(rng, i+1); swap.
fn makePermutation(orderOut: ptr<function, array<i32, MAX_DENOMS>>, candidateId: u32, baseHi: u32, baseLo: u32, n: u32) {
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    (*orderOut)[i] = i32(i);
  }
  if (n <= 1u) {
    return;
  }
  // candidate.ts:60 candidateRng — initstate = baseSeed, initseq = {0, candidateId}
  var rng = makeRng(baseHi, baseLo, 0u, candidateId);
  var i: u32 = n - 1u;
  loop {
    let j = nextBounded(&rng, i + 1u);
    let tmp = (*orderOut)[i];
    (*orderOut)[i] = (*orderOut)[j];
    (*orderOut)[j] = tmp;
    if (i == 1u) { break; }
    i = i - 1u;
  }
}

// candidate.ts:46 applyPrimaryFirst — move the "main denomination" (its eligible
// index) to the FRONT of `order` (stable). Line-for-line with wgslMirror.ts: an
// in-place shift-down over the per-thread order buffer (O(1) extra private state),
// producing OUTPUT identical to the TS reference. primaryEligibleIndex < 0 => no-op.
fn applyPrimaryFirst(orderOut: ptr<function, array<i32, MAX_DENOMS>>, primaryEligibleIndex: i32, n: u32) {
  if (primaryEligibleIndex < 0) { return; }
  // find the primary's current position p within order[0..n).
  var p: u32 = 0u;
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    if ((*orderOut)[i] == primaryEligibleIndex) { p = i; break; }
  }
  // shift order[0..p) down into [1..p], then place the primary at the front.
  var k: u32 = p;
  loop {
    if (k == 0u) { break; }
    (*orderOut)[k] = (*orderOut)[k - 1u];
    k = k - 1u;
  }
  (*orderOut)[0] = primaryEligibleIndex;
}

// skyline.ts:45 orientedDims — oriented note dims (rot flag unused by the scorer).
fn orientedDims(w0: i32, h0: i32, orientPolicy: u32) -> vec2<i32> {
  if (orientPolicy == 1u) {
    if (w0 >= h0) { return vec2<i32>(w0, h0); }
    return vec2<i32>(h0, w0);
  }
  if (orientPolicy == 2u) {
    if (h0 >= w0) { return vec2<i32>(w0, h0); }
    return vec2<i32>(h0, w0);
  }
  return vec2<i32>(w0, h0);
}

// ===========================================================================
// Bindings.
// ===========================================================================

struct Params {
  roomSideUnits: u32, // computeRoomSideUnits(areaTenths)
  modeIndex: u32,     // 0 cheapest, 1 densest, 2 fewest
  candidateCount: u32,
  baseSeedHi: u32,
  baseSeedLo: u32,
  denomCount: u32,
  plnPerMinor: f32,
  primaryEligibleIndex: i32, // eligible index of the "main denomination", or -1 (none)
}

struct ScoreOut {
  coverageQ: u32,      // scoring.ts coverageQ (score key hi)
  metric: u32,         // scoring.ts mode metric (score key lo)
  pieceCount: u32,
  candidateIndex: u32,
}

// denomData is packed stride-5 per denomination:
//   [i*5+0] kind (0 note, 1 coin)
//   [i*5+1] note width units   (0 for coins)
//   [i*5+2] note height units  (0 for coins)
//   [i*5+3] coin radius units  (0 for notes)
//   [i*5+4] minorValue
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> denomData: array<u32>;
@group(0) @binding(2) var<storage, read> archOrders: array<i32>; // 8 * denomCount, row = archetype
@group(0) @binding(3) var<storage, read_write> scores: array<ScoreOut>;

fn denomKind(i: u32) -> u32 { return denomData[i * 5u + 0u]; }
fn denomW(i: u32) -> i32 { return i32(denomData[i * 5u + 1u]); }
fn denomH(i: u32) -> i32 { return i32(denomData[i * 5u + 2u]); }
fn denomR(i: u32) -> i32 { return i32(denomData[i * 5u + 3u]); }
fn denomVal(i: u32) -> u32 { return denomData[i * 5u + 4u]; }

const PI: f32 = 3.1415927; // scoring.ts Math.PI, nearest f32
const COVERAGE_Q_SCALE: f32 = 1000000.0; // constants.ts COVERAGE_Q_SCALE
const U32MAX: u32 = 0xffffffffu;

// scoring.ts:28 clampU32(round(x)); inputs are >= 0 so floor(x+0.5) == Math.round.
fn clampU32f(x: f32) -> u32 {
  let r = floor(x + 0.5);
  if (r < 0.0) { return 0u; }
  if (r > 4294967295.0) { return U32MAX; }
  return u32(r);
}

// ===========================================================================
// Main search kernel. @workgroup_size(64) == constants.ts WORKGROUP_SIZE.
// ===========================================================================
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.candidateCount) { return; }
  let n = params.denomCount;

  // --- reconstruct config: order (priority) + orientPolicy (candidate.ts). ---
  var order: array<i32, MAX_DENOMS>;
  var orientPolicy: u32;
  if (idx < N_BASE_CONFIGS) {
    let d = decodeBaseArchetype(idx);
    let archetype = d.x;
    orientPolicy = d.z;
    for (var oi: u32 = 0u; oi < n; oi = oi + 1u) {
      order[oi] = archOrders[archetype * n + oi];
    }
  } else {
    makePermutation(&order, idx, params.baseSeedHi, params.baseSeedLo, n);
    // decodeConfig (candidate.ts:104): a SEPARATE stream, draws startCorner then
    // orientPolicy then fitHeuristic. The scorer only needs orientPolicy, but we
    // must advance past startCorner first to land on the same value.
    var rngPol = makeRng(params.baseSeedHi, params.baseSeedLo, 0u, idx);
    _ = nextBounded(&rngPol, N_START_CORNERS); // startCorner (unused by scorer)
    orientPolicy = nextBounded(&rngPol, N_ORIENT_POLICIES);
    // fitHeuristic draw omitted: unused by the shelf estimate.
  }

  // Move the "main denomination" to the front (candidates.ts makeCandidate applies
  // applyPrimaryFirst to BOTH the archetype order and the PCG permutation).
  applyPrimaryFirst(&order, params.primaryEligibleIndex, n);

  // --- shelf score (scoring.ts:91 shelfScoreCandidate). ---
  let roomSide = i32(params.roomSideUnits);
  let roomAreaF = f32(roomSide) * f32(roomSide);
  let modeIdx = params.modeIndex;

  // NFDH shelf note pack (scoring.ts:100-159) — O(1) scalar state.
  var yy: i32 = 0;
  var xx: i32 = 0;
  var shelfH: i32 = 0;
  var shelfOpen: bool = false;
  var noteArea: f32 = 0.0;
  var noteValue: f32 = 0.0;
  var noteCount: u32 = 0u;

  let MAX_PLACEMENTS: u32 = 2000000u;
  var placements: u32 = 0u;
  loop {
    if (placements >= MAX_PLACEMENTS) { break; }

    // highest-priority note that fits the current shelf state.
    var chosen: i32 = -1;
    var cw: i32 = 0;
    var ch: i32 = 0;
    var cVal: u32 = 0u;
    for (var oi: u32 = 0u; oi < n; oi = oi + 1u) {
      let diu = u32(order[oi]);
      if (denomKind(diu) != 0u) { continue; } // notes only
      let od = orientedDims(denomW(diu), denomH(diu), orientPolicy);
      let w = od.x;
      let h = od.y;
      if (w <= 0 || h <= 0 || w > roomSide) { continue; }
      var fits: bool;
      if (shelfOpen) {
        fits = (h <= shelfH) && (xx + w <= roomSide);
      } else {
        fits = (h <= roomSide - yy);
      }
      if (fits) {
        chosen = i32(diu);
        cw = w;
        ch = h;
        cVal = denomVal(diu);
        break;
      }
    }

    if (chosen >= 0) {
      if (!shelfOpen) {
        shelfOpen = true;
        shelfH = ch;
        xx = 0;
      }
      xx = xx + cw;
      noteArea = noteArea + f32(cw) * f32(ch);
      noteValue = noteValue + f32(cVal);
      noteCount = noteCount + 1u;
      placements = placements + 1u;
      continue;
    }

    if (shelfOpen) {
      yy = yy + shelfH;
      shelfOpen = false;
      shelfH = 0;
      xx = 0;
      continue;
    }
    break;
  }

  // analytic coin fill, skipped for 'fewest' (scoring.ts:161-191).
  var coinCount: u32 = 0u;
  var coinValue: f32 = 0.0;
  var coinArea: f32 = 0.0;
  if (modeIdx != 2u) {
    var repArea: f32 = 0.0;
    var repValue: f32 = 0.0;
    var bestDensity: f32 = 0.0;
    var haveBest: bool = false; // == scoring.ts bestDensity init -Inf/+Inf
    for (var i: u32 = 0u; i < n; i = i + 1u) {
      if (denomKind(i) != 1u) { continue; } // coins only
      let r = denomR(i);
      if (r <= 0) { continue; }
      let area = PI * f32(r) * f32(r);
      let density = f32(denomVal(i)) / area;
      var better: bool;
      if (!haveBest) {
        better = true;
      } else if (modeIdx == 1u) {
        better = density > bestDensity; // densest
      } else {
        better = density < bestDensity; // cheapest
      }
      if (better) {
        bestDensity = density;
        repArea = area;
        repValue = f32(denomVal(i));
        haveBest = true;
      }
    }
    if (repArea > 0.0) {
      let residual = max(0.0, roomAreaF - noteArea);
      let effArea = residual * 9.0 / 10.0; // COIN_FILL_ETA_NUM/DEN
      coinCount = u32(floor(effArea / repArea));
      coinArea = f32(coinCount) * repArea;
      coinValue = f32(coinCount) * repValue;
    }
  }

  // integer score key (scoring.ts:193-203).
  let coveredArea = noteArea + coinArea;
  var coverage: f32 = 0.0;
  if (roomAreaF > 0.0) { coverage = coveredArea / roomAreaF; }
  if (coverage > 1.0) { coverage = 1.0; }
  let coverageQ = u32(floor(coverage * COVERAGE_Q_SCALE));

  let totalValue = noteValue + coinValue;
  let vCents = clampU32f(totalValue * params.plnPerMinor * 100.0);
  let pieceCount = noteCount + coinCount;
  var metric: u32;
  if (modeIdx == 0u) {
    metric = U32MAX - vCents; // cheapest: VMAX - vCents
  } else if (modeIdx == 1u) {
    metric = vCents; // densest
  } else {
    metric = U32MAX - pieceCount; // fewest: KMAX - pieceCount (pieceCount <= u32max)
  }

  scores[idx] = ScoreOut(coverageQ, metric, pieceCount, idx);
}

// ===========================================================================
// Runtime on-GPU parity kernel. Reproduces the rng.ts GOLDEN_VECTOR from the
// canonical demo seed using the SAME nextRng/makeRng as `main`. runSearch reads
// parityOut back and throws if it != [465482994, ...]. This is the on-hardware
// guard that CI's headless wgslMirror parity test cannot cover.
// ===========================================================================
@group(0) @binding(10) var<storage, read_write> parityOut: array<u32>;

@compute @workgroup_size(1)
fn parityMain(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x != 0u) { return; }
  // rng.ts GOLDEN_SEED_INITSTATE = 0x853c49e6748fea9b, INITSEQ = 0xda3e39cb94b95bdb
  var rng = makeRng(0x853c49e6u, 0x748fea9bu, 0xda3e39cbu, 0x94b95bdbu);
  for (var i: u32 = 0u; i < 6u; i = i + 1u) {
    parityOut[i] = nextRng(&rng);
  }
}
