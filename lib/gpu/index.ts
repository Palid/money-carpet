/**
 * Public API of the WebGPU parallel candidate-search.
 *
 * The GPU RANKS candidate configs (integer score keys); the CPU replayTopK
 * (lib/packer) authoritatively replays the winner. See pack-search.wgsl and
 * wgslMirror.ts for the bit-parity contract.
 */

// Device acquisition + loss handling.
export {
  getGpuDevice,
  reacquire,
  onDeviceLost,
  GpuUnsupportedError,
  type DeviceLostListener,
} from '@/lib/gpu/device';

// Pipeline construction.
export {
  createSearchPipeline,
  type SearchPipeline,
  type DispatchParams,
} from '@/lib/gpu/pipeline';

// Search + authoritative replay.
export {
  runSearch,
  searchAndReplay,
  initGpuSearch,
  verifyGpuParity,
  resolveEligible,
} from '@/lib/gpu/runSearch';

// Pure-TS parity mirror (unit-testable without a GPU).
export {
  next as mirrorNext,
  makeRng as mirrorMakeRng,
  nextBounded as mirrorNextBounded,
  makePermutation as mirrorMakePermutation,
  decodePolicies as mirrorDecodePolicies,
  applyPrimaryFirst as mirrorApplyPrimaryFirst,
  reconstructOrder as mirrorReconstructOrder,
  shelfScore as mirrorShelfScore,
  GOLDEN_VECTOR,
  GOLDEN_SEED_INITSTATE,
  GOLDEN_SEED_INITSEQ,
  type MirrorDenom,
  type MirrorShelfInput,
  type MirrorShelfScore,
} from '@/lib/gpu/wgslMirror';

// FROZEN worker message protocol TYPES (so other agents can import them).
export type {
  WorkerRequestMsg,
  WorkerResponseMsg,
  WorkerPackMsg,
  WorkerResultMsg,
  WorkerErrorMsg,
  WorkerUnsupportedMsg,
  WorkerGpuLostMsg,
} from '@/lib/gpu/pack.worker';
