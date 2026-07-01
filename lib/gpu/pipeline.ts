/**
 * Compute-pipeline construction for the candidate search.
 *
 * `createSearchPipeline(device)` builds the shader module + two compute pipelines
 * (the `main` search entry and the `parityMain` on-GPU golden-vector kernel) and
 * returns a reusable object whose `dispatch(params)` uploads inputs, runs
 * ceil(candidateCount/64) workgroups, and reads the integer scores back.
 *
 * Both pipelines use layout:'auto'; each auto layout includes ONLY the bindings
 * its entry point statically uses (main -> 0,1,2,3; parityMain -> 10), so they
 * coexist in one module without conflict.
 */

import { WORKGROUP_SIZE } from '@/lib/config/constants';

// WGSL source. Loaded as a URL asset (works in a module Worker / browser bundle)
// and fetched at pipeline build time. The .wgsl file is the canonical source
// that must stay line-for-line identical to lib/gpu/wgslMirror.ts.
const SHADER_URL = new URL('./shaders/pack-search.wgsl', import.meta.url);

let cachedSource: string | null = null;
async function loadShaderSource(): Promise<string> {
  if (cachedSource !== null) return cachedSource;
  const res = await fetch(SHADER_URL);
  cachedSource = await res.text();
  return cachedSource;
}

/** Everything a single search dispatch needs (already reduced to GPU-ready form). */
export interface DispatchParams {
  roomSideUnits: number;
  modeIndex: number;
  candidateCount: number;
  baseSeedHi: number;
  baseSeedLo: number;
  denomCount: number;
  plnPerMinor: number;
  /** stride-5 per denom: [kind, w, h, r, minorValue]. length = denomCount*5. */
  denomData: Uint32Array;
  /** 8 * denomCount, row-major by archetype. */
  archOrders: Int32Array;
}

export interface SearchPipeline {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  parityPipeline: GPUComputePipeline;
  /** Upload inputs, dispatch, and return the raw scores (4 u32 per candidate). */
  dispatch(params: DispatchParams): Promise<Uint32Array>;
  /** Run the on-GPU parity kernel; returns the 6 golden-vector outputs. */
  runParity(): Promise<Uint32Array>;
}

const PARAMS_U32_COUNT = 8; // Params struct: 8 * u32 = 32 bytes
const SCORE_U32_COUNT = 4; // ScoreOut: coverageQ, metric, pieceCount, candidateIndex

export async function createSearchPipeline(device: GPUDevice): Promise<SearchPipeline> {
  const code = await loadShaderSource();
  const module = device.createShaderModule({ code, label: 'pack-search' });

  const pipeline = device.createComputePipeline({
    label: 'pack-search-main',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const parityPipeline = device.createComputePipeline({
    label: 'pack-search-parity',
    layout: 'auto',
    compute: { module, entryPoint: 'parityMain' },
  });

  function makeParamsBuffer(p: DispatchParams): GPUBuffer {
    const buf = device.createBuffer({
      label: 'params',
      size: PARAMS_U32_COUNT * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const u32 = new Uint32Array(PARAMS_U32_COUNT);
    const f32 = new Float32Array(u32.buffer);
    u32[0] = p.roomSideUnits >>> 0;
    u32[1] = p.modeIndex >>> 0;
    u32[2] = p.candidateCount >>> 0;
    u32[3] = p.baseSeedHi >>> 0;
    u32[4] = p.baseSeedLo >>> 0;
    u32[5] = p.denomCount >>> 0;
    f32[6] = p.plnPerMinor;
    u32[7] = 0; // _pad
    device.queue.writeBuffer(buf, 0, u32);
    return buf;
  }

  function makeStorage(label: string, data: Uint32Array | Int32Array, extraUsage = 0): GPUBuffer {
    const buf = device.createBuffer({
      label,
      size: Math.max(4, data.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage,
    });
    device.queue.writeBuffer(buf, 0, data as GPUAllowSharedBufferSource);
    return buf;
  }

  async function readBack(src: GPUBuffer, byteLength: number): Promise<Uint32Array> {
    const staging = device.createBuffer({
      label: 'readback',
      size: byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, staging, 0, byteLength);
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
  }

  async function dispatch(p: DispatchParams): Promise<Uint32Array> {
    const paramsBuf = makeParamsBuffer(p);
    const denomBuf = makeStorage('denomData', p.denomData);
    const archBuf = makeStorage('archOrders', p.archOrders);

    const scoresBytes = p.candidateCount * SCORE_U32_COUNT * 4;
    const scoresBuf = device.createBuffer({
      label: 'scores',
      size: Math.max(4, scoresBytes),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const bindGroup = device.createBindGroup({
      label: 'search-bind',
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: denomBuf } },
        { binding: 2, resource: { buffer: archBuf } },
        { binding: 3, resource: { buffer: scoresBuf } },
      ],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    const groups = Math.ceil(p.candidateCount / WORKGROUP_SIZE);
    pass.dispatchWorkgroups(groups);
    pass.end();
    device.queue.submit([enc.finish()]);

    const out = await readBack(scoresBuf, scoresBytes);

    paramsBuf.destroy();
    denomBuf.destroy();
    archBuf.destroy();
    scoresBuf.destroy();
    return out;
  }

  async function runParity(): Promise<Uint32Array> {
    const bytes = 6 * 4;
    const outBuf = device.createBuffer({
      label: 'parityOut',
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const bindGroup = device.createBindGroup({
      label: 'parity-bind',
      layout: parityPipeline.getBindGroupLayout(0),
      entries: [{ binding: 10, resource: { buffer: outBuf } }],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(parityPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([enc.finish()]);
    const out = await readBack(outBuf, bytes);
    outBuf.destroy();
    return out;
  }

  return { device, pipeline, parityPipeline, dispatch, runParity };
}
