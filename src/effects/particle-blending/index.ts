import { getNoiseTexture } from '../../gpu/emission/noise-texture.ts';
import { createOit, OIT_CHUNKS, OIT_WEIGHTS, type OitWeight } from '../../gpu/particles/oit.ts';
import { createDepthSort } from '../../gpu/particles/sort.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import {
  CameraUniform,
  computeCamera,
  createCameraMatrices,
  fitFovY,
  setCameraUniform,
} from '../../gpu/scene/camera.ts';
import { createOrbitControl, createOrbitState, orbitEye } from '../../gpu/scene/orbit.ts';
import { createShader, withChunks } from '../../gpu/shader.ts';
import { createUniformBuffer, defineUniformStruct } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import drawShader from './draw.wgsl';
import { meta } from './meta.ts';
import puffsShader from './puffs.wgsl';

const MODES = ['additive', 'unsorted', 'sorted', 'oit'] as const;
type Mode = (typeof MODES)[number];
const SPLITS = ['off', ...MODES] as const;
const SORTS = ['radix', 'radix16', 'bitonic', 'temporal'] as const;
const WEIGHTS = Object.keys(OIT_WEIGHTS) as OitWeight[];

/** Most puffs; the sort and the buffers are sized for it. */
const MAX_COUNT = 65536;
/** The clock wraps here: a whole number of flame (1 s) and smoke (7 s) cycles, see puffs.wgsl. */
const CLOCK_WRAP = 7 * 1024;

const PuffParams = defineUniformStruct('PuffParams', {
  time: 'f32',
  count: 'u32',
  flame_share: 'f32',
  size: 'f32',
  smoke: 'f32',
  soot: 'f32',
  fire: 'f32',
  sky: 'f32',
  lean: 'f32',
  lanterns: 'u32',
  // 2048 puffs of size 1 / (count * size^2): keeps the total light and coverage of the column
  // roughly the same when the count or size changes.
  coverage: 'f32',
});

const DrawParams = defineUniformStruct('DrawParams', {
  weight: 'u32',
  z_scale: 'f32',
  intensity: 'f32',
  underlight: 'f32',
});

// Points of light around the fire, so the smoke has something to hide. They are the first slots of
// the particle buffer (see puffs.wgsl), so every mode orders them with the smoke.
const LANTERNS = 14;

export const effect = defineEffect({
  meta,
  params: {
    mode: { type: 'select', default: 'sorted', options: MODES },
    split: { type: 'select', default: 'off', options: SPLITS, label: 'right half' },
    sort: { type: 'select', default: 'radix', options: SORTS, label: 'sort method' },
    count: { type: 'number', default: 2048, min: 256, max: MAX_COUNT, step: 256, label: 'puffs' },
    size: { type: 'number', default: 1, min: 0.3, max: 2.5, step: 0.05, label: 'puff size' },
    flameShare: {
      type: 'number',
      default: 0.25,
      min: 0,
      max: 0.8,
      step: 0.01,
      label: 'flame share',
    },
    smoke: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'smoke opacity' },
    soot: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01 },
    fire: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'fire brightness' },
    sky: { type: 'number', default: 0.35, min: 0, max: 2, step: 0.01, label: 'sky light' },
    weight: { type: 'select', default: 'eq7', options: WEIGHTS, label: 'OIT weight' },
    weightDepth: {
      type: 'number',
      default: 1,
      min: 0.25,
      max: 4,
      step: 0.05,
      label: 'OIT depth scale',
    },
    occlusion: {
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'OIT fire occlusion',
    },
    lanterns: { type: 'boolean', default: true },
    orbit: { type: 'boolean', default: true },
    speed: { type: 'number', default: 1, min: 0, max: 2, step: 0.01 },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    // The two that get smoke right, side by side: exact order against weighted blending.
    'sorted | oit': { mode: 'sorted', split: 'oit' },
    // The cheap wrong answer: smoke as light.
    'additive | sorted': { mode: 'additive', split: 'sorted' },
    // What sorting buys.
    'unsorted | sorted': { mode: 'unsorted', split: 'sorted' },
    // Thick sooty smoke: where weighted blending's colour bias shows.
    'heavy smoke': { mode: 'sorted', split: 'oit', smoke: 0.9, soot: 0.9, size: 1.3 },
    // Many small puffs: the sort's cost starts to show.
    dense: { mode: 'sorted', count: 32768, size: 0.55, smoke: 0.4 },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'particle-blending' });
    const camera = createUniformBuffer(device, CameraUniform, 'particle-blending camera');
    const matrices = createCameraMatrices();
    const noise = getNoiseTexture(device);

    // --- Particle state ---
    const positions = device.createBuffer({
      label: 'particle-blending positions',
      size: MAX_COUNT * 16,
      usage: GPUBufferUsage.STORAGE,
    });
    const looks = device.createBuffer({
      label: 'particle-blending looks',
      size: MAX_COUNT * 32,
      usage: GPUBufferUsage.STORAGE,
    });
    // Buffer order, for every mode but "sorted".
    const identity = device.createBuffer({
      label: 'particle-blending identity order',
      size: MAX_COUNT * 4,
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    const order = new Uint32Array(identity.getMappedRange());
    for (let i = 0; i < MAX_COUNT; i++) order[i] = i;
    identity.unmap();

    const puffUniforms = createUniformBuffer(device, PuffParams, 'particle-blending puffs');
    const simModule = createShader(
      device,
      withChunks(puffsShader, { 'puff-params.wgsl': PuffParams.wgsl }),
    );
    const simPipeline = device.createComputePipeline({
      label: 'particle-blending puffs',
      layout: 'auto',
      compute: { module: simModule, entryPoint: 'puffs' },
    });
    const simGroup = device.createBindGroup({
      label: 'particle-blending puffs',
      layout: simPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: puffUniforms.buffer } },
        { binding: 1, resource: { buffer: positions } },
        { binding: 2, resource: { buffer: looks } },
      ],
    });

    // --- Sort and OIT ---
    const sort = createDepthSort(device, {
      capacity: MAX_COUNT,
      camera: camera.buffer,
      label: 'particle-blending sort',
    });
    const oit = createOit(device, { label: 'particle-blending oit' });

    // --- Puff drawing: one vertex stage, three blend pipelines ---
    const drawUniforms = createUniformBuffer(device, DrawParams, 'particle-blending draw');
    const drawModule = createShader(
      device,
      withChunks(drawShader, OIT_CHUNKS, { 'draw-params.wgsl': DrawParams.wgsl }),
    );
    const drawLayout = device.createBindGroupLayout({
      label: 'particle-blending draw',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({
      label: 'particle-blending draw',
      bindGroupLayouts: [drawLayout],
    });
    const drawPipeline = (entryPoint: string, targets: GPUColorTargetState[]) =>
      device.createRenderPipeline({
        label: `particle-blending ${entryPoint}`,
        layout: pipelineLayout,
        vertex: { module: drawModule, entryPoint: 'vs' },
        fragment: { module: drawModule, entryPoint, targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      });
    const sceneFormat = tail.scene.format;
    const additivePipeline = drawPipeline('fs_additive', [
      {
        format: sceneFormat,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one' },
          // Light adds nothing to coverage.
          alpha: { srcFactor: 'zero', dstFactor: 'one' },
        },
      },
    ]);
    const overPipeline = drawPipeline('fs_over', [
      {
        format: sceneFormat,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        },
      },
    ]);
    const oitPipeline = drawPipeline('fs_oit', [...oit.targets]);
    const drawGroup = (orderBuffer: GPUBuffer, label: string) =>
      device.createBindGroup({
        label: `particle-blending draw (${label})`,
        layout: drawLayout,
        entries: [
          { binding: 0, resource: { buffer: camera.buffer } },
          { binding: 1, resource: { buffer: drawUniforms.buffer } },
          { binding: 2, resource: { buffer: positions } },
          { binding: 3, resource: { buffer: looks } },
          { binding: 4, resource: { buffer: orderBuffer } },
          { binding: 5, resource: noise.view },
          { binding: 6, resource: noise.sampler },
        ],
      });
    const bufferOrder = drawGroup(identity, 'buffer order');
    const sortedOrder = drawGroup(sort.indices, 'sorted');

    const orbit = createOrbitControl(
      canvas,
      createOrbitState({ yaw: 0.35, pitch: 0.1, distance: 12, target: [0.3, 3.2, 0] }),
      { minPitch: -0.3, maxPitch: 1.2, autoSpeed: 0.1, idleDelay: 0, idleRamp: 0.5 },
    );

    let width = 1;
    let height = 1;
    // Starts well into the clock so the first frame has puffs of every age.
    let clock = 30;

    return {
      resize(newWidth, newHeight) {
        width = newWidth;
        height = newHeight;
        tail.resize(width, height);
      },

      frame(time, encoder, target) {
        clock = (clock + Math.min(time.delta, 0.1) * params.speed) % CLOCK_WRAP;
        const state = orbit.update(time.delta, params.orbit);
        const aspect = width / height;
        computeCamera(
          {
            position: orbitEye(state),
            target: state.target,
            fovY: fitFovY(0.78, aspect, 0.85),
            aspect,
            near: 0.1,
            far: 90,
          },
          matrices,
        );
        setCameraUniform(camera, matrices, width, height);
        camera.upload();

        const count = Math.max(LANTERNS + 1, Math.min(MAX_COUNT, Math.round(params.count)));
        puffUniforms.set({
          time: clock,
          count,
          flame_share: params.flameShare,
          size: params.size,
          smoke: params.smoke,
          soot: params.soot,
          fire: params.fire,
          sky: params.sky,
          lean: 0.3,
          lanterns: params.lanterns ? LANTERNS : 0,
          coverage: Math.min(4, Math.max(0.05, 2048 / (count * params.size * params.size))),
        });
        puffUniforms.upload();
        drawUniforms.set({
          weight: OIT_WEIGHTS[params.weight as OitWeight] ?? 7,
          z_scale: params.weightDepth,
          intensity: 1,
          underlight: 0.35,
        });
        drawUniforms.upload();

        const sim = encoder.beginComputePass({
          label: 'particle-blending puffs',
          timestampWrites: profiler.pass('puffs'),
        });
        sim.setPipeline(simPipeline);
        sim.setBindGroup(0, simGroup);
        sim.dispatchWorkgroups(Math.ceil(count / 64));
        sim.end();

        // Which mode draws where. Too narrow to split: the left mode fills the canvas.
        const left = params.mode as Mode;
        const right = params.split !== 'off' && width >= 4 ? (params.split as Mode) : undefined;
        const middle = Math.floor(width / 2);
        const halves: { mode: Mode; scissor: [number, number, number, number] }[] = right
          ? [
              { mode: left, scissor: [0, 0, middle - 1, height] },
              { mode: right, scissor: [middle + 1, 0, width - middle - 1, height] },
            ]
          : [{ mode: left, scissor: [0, 0, width, height] }];

        // The OIT targets (18 bytes a pixel, 37 MB at 1080p) exist only while an OIT view is shown.
        const usesOit = halves.some((half) => half.mode === 'oit');
        if (usesOit) oit.resize(width, height);
        else oit.resize(1, 1);

        if (halves.some((half) => half.mode === 'sorted')) {
          const method = params.sort;
          sort.settings.method =
            method === 'radix16' ? 'radix' : (method as 'radix' | 'bitonic' | 'temporal');
          sort.settings.keyBits = method === 'radix16' ? 16 : 32;
          sort.encode(encoder, { positions, count, timestampWrites: profiler.pass('sort') });
        }

        // Clear to transparent: over a page, only what is drawn hides it.
        encoder
          .beginRenderPass({
            label: 'particle-blending clear',
            colorAttachments: [
              {
                view: tail.scene.view,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 0],
              },
            ],
          })
          .end();
        for (const { mode, scissor } of halves) {
          const timing = profiler.pass(`particles (${mode})`);
          if (mode === 'oit') {
            const pass = oit.begin(encoder, { scissor, timestampWrites: timing });
            pass.setPipeline(oitPipeline);
            pass.setBindGroup(0, bufferOrder);
            pass.draw(6, count);
            pass.end();
            oit.composite(encoder, tail.scene.view, {
              occlusion: params.occlusion,
              scissor,
              timestampWrites: profiler.pass('oit composite'),
            });
          } else {
            const pass = encoder.beginRenderPass({
              label: `particle-blending ${mode}`,
              colorAttachments: [{ view: tail.scene.view, loadOp: 'load', storeOp: 'store' }],
              timestampWrites: timing,
            });
            pass.setScissorRect(...scissor);
            pass.setPipeline(mode === 'additive' ? additivePipeline : overPipeline);
            pass.setBindGroup(0, mode === 'sorted' ? sortedOrder : bufferOrder);
            pass.draw(6, count);
            pass.end();
          }
        }

        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        orbit.destroy();
        sort.destroy();
        oit.destroy();
        for (const buffer of [positions, looks, identity]) buffer.destroy();
        puffUniforms.destroy();
        drawUniforms.destroy();
        camera.destroy();
        tail.destroy();
      },
    };
  },
});
