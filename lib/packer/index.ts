/**
 * Public API of the deterministic CPU packer.
 */

// Pipeline / authoritative replay.
export { packCPU, replayCandidate, replayTopK } from '@/lib/packer/replay';

// Candidate generation.
export {
  makeCandidates,
  makeCandidate,
  buildArchetypeOrders,
  computeBaseSeed,
  modeIndex,
  type Config,
} from '@/lib/packer/candidates';
export {
  makePermutation,
  decodeConfig,
  decodeBaseArchetype,
  N_BASE_CONFIGS,
  type DecodedPolicies,
} from '@/lib/packer/candidate';

// Scoring (authoritative + the CPU twin the GPU must match).
export {
  shelfScoreCandidate,
  computeScoreKey,
  compareScoreKey,
  valueCents,
  U32_MAX,
  type ScoreKey,
  type ShelfScore,
} from '@/lib/packer/scoring';

// Geometry primitives.
export {
  packNotes,
  computeRoomSideUnits,
  orientedDims,
  type NotePlacement,
  type SkylineResult,
} from '@/lib/packer/skyline';
export {
  circleFill,
  bruteForceCircleFill,
  eligibleCoinTypes,
  type CoinPlacement,
  type CircleFillResult,
} from '@/lib/packer/circleFill';

// RNG (canonical PCG32) + seeding + golden vectors.
export {
  makeRng,
  next,
  nextBounded,
  hashBaseSeed,
  hashStringU32,
  GOLDEN_VECTOR,
  GOLDEN_SEED_INITSTATE,
  GOLDEN_SEED_INITSEQ,
  type U64,
  type Rng,
} from '@/lib/packer/rng';
