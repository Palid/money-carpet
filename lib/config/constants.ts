export const WORKGROUP_SIZE = 64;
export const DEFAULT_CANDIDATES = 2048;
export const PIECE_CAP = 50000;
export const FP = 100; // fixed-point units per mm (1 unit = 1/100 mm)
export const MM_PER_M = 1000;
export const UNITS_PER_M = FP * MM_PER_M; // 100000 fixed-point units per meter
export const AREA_MIN_M2 = 1;
export const AREA_MAX_M2 = 10;
export const AREA_STEP_M2 = 0.1;
export const COVERAGE_Q_SCALE = 1_000_000; // coverageQ = floor(coverage * this)
export const DATASET_VERSION = 1;
export const PATCH_BLOCK_TARGET_PIECES = 6000;
