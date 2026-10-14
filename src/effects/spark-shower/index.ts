import { trackDomRects, type ObstacleRect } from '../../gpu/dom-rects.ts';
import { createFullscreenPipeline, renderFullscreen } from '../../gpu/fullscreen.ts';
import { overlayCamera, type Collider } from '../../gpu/particles/index.ts';
import { createHdrTail, OVERLAY_PARAMS, TAIL_PARAMS } from '../../gpu/post/index.ts';
import { CameraUniform, setCameraUniform } from '../../gpu/scene/camera.ts';
import { withChunks } from '../../gpu/shader.ts';
import { createExcitation, EXCITATIONS, type Excitation } from '../../gpu/sim/excitation.ts';
import { createPointerIgnition } from '../../gpu/sim/ignition.ts';
import { createSpriteRenderer, SPRITE_FLOATS, writeSprite } from '../../gpu/sprites.ts';
import { createUniformBuffer, defineUniformStruct, uniformArray } from '../../gpu/uniforms.ts';
import { defineEffect } from '../types.ts';
import { meta } from './meta.ts';
import scene from './scene.wgsl';
import {
  applyShower,
  applyShowerLook,
  boxFromRect,
  createShowerRenderer,
  createShowerSim,
  DEFAULT_SHOWER,
  FLOOR_Y,
  MAX_BOXES,
  rectContains,
  setShowerColliders,
  showerCapacity,
  type ShowerSettings,
  type ShowerSim,
} from './shower.ts';

// Story 7.3: a grinder, welding or forge shower of sparks on the particle framework
// (src/gpu/particles/). Hot sparks are thrown from a source, streak (velocity stretch sized as a
// camera exposure), arc under gravity against quadratic drag, cool along the blackbody curve,
// bounce off a floor, an anvil (an SDF collider) and the page's marked elements (box colliders from
// trackDomRects), and split on impact into smaller, cooler children (GPU spawning from hook_collide;
// hooks.wgsl). shower.ts owns the particle system; this file is the page: parameters, the pointer,
// the DOM, the backdrop (scene.wgsl) and the tail.

const DEGREES = Math.PI / 180;
/** Full drive (scroll or sound) raises the rate by this share of the calm rate. */
const DRIVE_SHARE = 0.6;
/** A pressed pointer bites harder: this many times the rate. */
const PRESS_RATE = 1.8;
/** Seconds without a pointer before the source drifts home. */
const POINTER_HOLD = 1.2;

const SceneParams = defineUniformStruct('Params', {
  aspect: 'f32',
  pixel: 'f32',
  floor_y: 'f32',
  count: 'u32',
  anvil: 'vec4f',
  stand_ins: 'u32',
  boxes: uniformArray('vec4f', MAX_BOXES),
});

/**
 * Stand-in cards for a canvas with no marked page elements (canvas uv, top-left origin): two plates
 * in the path of the default grinder's arc and one under the source, placed in canvas heights from
 * the default source so they catch the same arc on any landscape canvas, so sparks land on a card,
 * skid off its edge and split on the floor below.
 */
export function standInRects(aspect: number): ObstacleRect[] {
  if (aspect < 1) {
    return [
      { x: 0.12, y: 0.52, width: 0.42, height: 0.08, radius: 0.012 },
      { x: 0.5, y: 0.72, width: 0.42, height: 0.1, radius: 0.012 },
    ];
  }
  const source = 0.2 * aspect;
  const plates: [number, number, number, number][] = [
    [source + 0.32, source + 0.62, 0.5, 0.37],
    [source + 0.75, source + 1.1, 0.38, 0.22],
    [source - 0.11, source + 0.14, 0.2, 0.1],
  ];
  return plates
    .filter(([, x1]) => x1 < aspect - 0.02)
    .map(([x0, x1, top, bottom]) => ({
      x: x0 / aspect,
      y: 1 - top,
      width: (x1 - x0) / aspect,
      height: top - bottom,
      radius: 0.012,
    }));
}

export const effect = defineEffect({
  meta,
  params: {
    rate: { type: 'number', default: 1400, min: 0, max: 4000, step: 10, label: 'sparks / s' },
    speed: { type: 'number', default: 2, min: 0.1, max: 4, step: 0.01, label: 'speed (heights/s)' },
    aim: { type: 'number', default: -12, min: -180, max: 180, step: 1, label: 'aim (degrees)' },
    spread: { type: 'number', default: 15, min: 0, max: 180, step: 1, label: 'spread (degrees)' },
    sourceX: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'source x' },
    sourceY: { type: 'number', default: 0.66, min: 0, max: 1, step: 0.01, label: 'source y' },
    sweep: {
      type: 'number',
      default: 0.03,
      min: 0,
      max: 0.45,
      step: 0.01,
      label: 'idle sweep (share of width)',
    },
    gravity: { type: 'number', default: 2.4, min: 0, max: 6, step: 0.01 },
    drag: { type: 'number', default: 0.8, min: 0, max: 4, step: 0.01 },
    life: { type: 'number', default: 2, min: 0.2, max: 4, step: 0.05, label: 'life (s)' },
    temperature: {
      type: 'number',
      default: 2800,
      min: 1600,
      max: 3400,
      step: 10,
      label: 'temperature (K)',
    },
    cooling: { type: 'number', default: 0.5, min: 0, max: 4, step: 0.01, label: 'cooling (1/s)' },
    restitution: { type: 'number', default: 0.42, min: 0, max: 1, step: 0.01 },
    friction: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01 },
    split: { type: 'number', default: 3, min: 0, max: 6, step: 1, label: 'children per split' },
    splitChance: {
      type: 'number',
      default: 0.7,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'split chance',
    },
    generations: { type: 'number', default: 2, min: 0, max: 3, step: 1 },
    size: { type: 'number', default: 1, min: 0.3, max: 4, step: 0.05 },
    shutter: {
      type: 'number',
      default: 45,
      min: 0,
      max: 100,
      step: 1,
      label: 'streak (exposure ms)',
    },
    intensity: { type: 'number', default: 3.5, min: 0, max: 20, step: 0.1 },
    glow: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'source glow' },
    hammer: { type: 'number', default: 0, min: 0, max: 2.5, step: 0.05, label: 'strikes / s' },
    hammerBurst: {
      type: 'number',
      default: 260,
      min: 20,
      max: 1500,
      step: 10,
      label: 'sparks per strike',
    },
    anvil: { type: 'boolean', default: false },
    cards: { type: 'boolean', default: true, label: 'bounce off page elements' },
    onTop: { type: 'boolean', default: true, label: 'canvas above content' },
    follow: { type: 'boolean', default: true, label: 'source follows pointer' },
    drive: { type: 'select', default: 'none', options: EXCITATIONS },
    ...TAIL_PARAMS,
    ...OVERLAY_PARAMS,
  },
  presets: {
    grinder: {},
    welding: {
      rate: 1100,
      speed: 1.1,
      aim: 90,
      spread: 80,
      sourceX: 0.31,
      sourceY: 0.3,
      gravity: 2.6,
      drag: 1.6,
      life: 0.9,
      temperature: 3100,
      cooling: 1.3,
      restitution: 0.3,
      friction: 0.4,
      split: 2,
      splitChance: 0.45,
      generations: 1,
      size: 0.8,
      shutter: 30,
      intensity: 5,
      glow: 1.4,
    },
    'forge hammer': {
      rate: 25,
      speed: 0.7,
      aim: 90,
      spread: 50,
      gravity: 2.2,
      drag: 0.9,
      life: 1.5,
      temperature: 2400,
      cooling: 0.9,
      restitution: 0.38,
      split: 2,
      splitChance: 0.5,
      generations: 1,
      size: 1.25,
      shutter: 40,
      intensity: 4,
      glow: 0,
      hammer: 0.75,
      hammerBurst: 280,
      anvil: true,
    },
    'sparks on cards': {
      rate: 500,
      speed: 0.55,
      aim: -90,
      spread: 30,
      sourceX: 0.5,
      sourceY: 0.98,
      sweep: 0.36,
      gravity: 2,
      drag: 0.6,
      life: 2.2,
      temperature: 2700,
      cooling: 0.55,
      restitution: 0.5,
      friction: 0.2,
      split: 3,
      splitChance: 0.9,
      generations: 2,
      glow: 0,
    },
  },

  async create({ device, format, hdr, canvas, params, profiler }) {
    const tail = createHdrTail(device, { format, hdr, label: 'spark-shower' });
    const camera = createUniformBuffer(device, CameraUniform, 'spark-shower camera');
    const sceneUniforms = createUniformBuffer(device, SceneParams, 'spark-shower scene');
    const scenePipeline = createFullscreenPipeline(device, {
      fragment: withChunks(scene, { 'params.wgsl': SceneParams.wgsl }),
      format: tail.scene.format,
    });
    const glowSprite = createSpriteRenderer(device, {
      capacity: 1,
      camera: camera.buffer,
      format: tail.scene.format,
      label: 'spark-shower hot spot',
    });
    glowSprite.settings.depth = 'none';
    const glowData = new Float32Array(SPRITE_FLOATS);
    const sceneGroup = device.createBindGroup({
      label: 'spark-shower scene',
      layout: scenePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: sceneUniforms.buffer } }],
    });

    // The pointer through the shared igniters: hovering reports at half strength, a press at full,
    // so one source tells where the pointer is and whether it is pressed. No capture: over a page
    // a touch must still scroll it.
    const pointer = createPointerIgnition(canvas, { hover: 0.5, capture: false, radius: 0.02 });
    let drive: Excitation = createExcitation(params.drive, canvas);

    // Where the page's marked elements are (inert without a DOM: stand-ins are used then).
    const dom = trackDomRects(canvas, { epsilon: 2e-4 });

    // Sparks over the page's cards have to be drawn over them, so the canvas is raised above its
    // siblings while page elements are the solids (as fire-obstacles and dom-fuel do).
    const style = canvas.style as Partial<CSSStyleDeclaration> | undefined;
    const before = { position: style?.position ?? '', zIndex: style?.zIndex ?? '' };
    let raised = false;
    const raise = (on: boolean) => {
      if (!style || on === raised) return;
      style.position = on ? 'relative' : before.position;
      style.zIndex = on ? '5' : before.zIndex;
      raised = on;
    };

    interface Sim {
      capacity: number;
      sim: ShowerSim;
      renderer: ReturnType<typeof createShowerRenderer>;
      warm: boolean;
    }
    let current: Sim | undefined;
    let width = 1;
    let height = 1;
    let clock = 0;
    let hammerClock = 0;
    let wasPressed = false;
    let pointerAt: [number, number] | undefined;
    let pointerAge = Infinity;
    let pressed = false;

    function settings(level: number): ShowerSettings {
      // On a canvas narrower than 16:10 the whole throw scales down with the width: speeds and
      // gravity by k, quadratic drag by 1/k, which scales every path by k and keeps its timing.
      const k = Math.min(1, width / height / 1.6);
      const speed = params.speed * k;
      const life = params.life;
      const sizeScale = params.size;
      const t = params.temperature;
      // Pressure breathes slowly (well under 1 Hz), so the stream is never mechanical.
      const breathe = 1 + 0.12 * Math.sin(clock * 1.7) * Math.sin(clock * 0.61 + 1);
      return {
        ...DEFAULT_SHOWER,
        rate: params.rate * breathe * (1 + DRIVE_SHARE * level) * (pressed ? PRESS_RATE : 1),
        speed: [speed * 0.72, speed * 1.28],
        aim: (params.aim + 4 * Math.sin(clock * 0.43)) * DEGREES,
        spread: params.spread * DEGREES,
        life: [life * 0.75, life * 1.25],
        temperature: [t - 200, t + 200],
        size: [0.0016 * sizeScale, 0.0026 * sizeScale],
        gravity: params.gravity * k,
        dragQuadratic: params.drag / k,
        cooling: params.cooling,
        restitution: params.restitution,
        friction: params.friction,
        children: params.split,
        splitChance: params.splitChance,
        generations: params.generations,
        hammerTemperature: [t - 450, t - 100],
        hammerSpeed: [DEFAULT_SHOWER.hammerSpeed[0] * k, DEFAULT_SHOWER.hammerSpeed[1] * k],
      };
    }

    function anvil() {
      if (!params.anvil) return undefined;
      const aspect = width / height;
      const scale = Math.min(0.9, aspect * 0.55);
      // Feet on the floor: the face's top is 0.268 anvil units above the bottom of the feet.
      return { x: aspect * 0.5 - 0.05 * scale, y: FLOOR_Y + 0.268 * scale, scale };
    }

    /** The page's elements (or stand-ins) as boxes, leaving out any that holds the source. */
    function boxes(source: readonly [number, number], rects: readonly ObstacleRect[]): Collider[] {
      const aspect = width / height;
      return rects
        .filter((rect) => !rectContains(rect, aspect, source, 0.01))
        .slice(0, MAX_BOXES)
        .map((rect) => boxFromRect(rect, aspect));
    }

    /** Where the source is: on the anvil's bar, under the pointer, or drifting round its home. */
    function sourcePosition(): [number, number] {
      const aspect = width / height;
      const a = anvil();
      if (a) return [a.x + 0.02 * a.scale, a.y + 0.04 * a.scale];
      const home: [number, number] = [
        (params.sourceX + params.sweep * Math.sin(clock * 0.37)) * aspect,
        params.sourceY + 0.02 * Math.sin(clock * 0.53 + 2),
      ];
      if (!params.follow || !pointerAt) return home;
      // Follow the pointer; drift back home over a second once it has gone.
      const w = Math.min(1, Math.max(0, (pointerAge - POINTER_HOLD) / 1));
      const s = w * w * (3 - 2 * w);
      return [
        pointerAt[0] + (home[0] - pointerAt[0]) * s,
        pointerAt[1] + (home[1] - pointerAt[1]) * s,
      ];
    }

    function build(capacity: number): Sim {
      const sim = createShowerSim(device, { capacity, profiler });
      const renderer = createShowerRenderer(sim, camera.buffer, tail.scene.format, profiler);
      return { capacity, sim, renderer, warm: false };
    }

    return {
      resize(newWidth, newHeight) {
        width = newWidth;
        height = newHeight;
        tail.resize(width, height);
        setCameraUniform(camera, overlayCamera(width, height), width, height);
        camera.upload();
      },

      frame(time, encoder, target) {
        const delta = Math.min(Math.max(time.delta, 0), 0.25);
        clock += delta;
        if (drive.kind !== params.drive) {
          drive.destroy();
          drive = createExcitation(params.drive, canvas);
        }
        const level = drive.update(delta);
        const aspect = width / height;

        // The pointer: the last point of its path this frame, and whether it is pressed.
        const igniters = pointer.collect(delta);
        const last = igniters[igniters.length - 1];
        pointerAge += delta;
        if (last) {
          pointerAt = [last.toX * aspect, 1 - last.toY];
          pointerAge = 0;
        }
        pressed = pointer.pressed > 0;
        const strike = pressed && !wasPressed;
        wasPressed = pressed;

        const s = settings(level);
        const hammerRate = params.hammer > 0 ? params.hammer * params.hammerBurst : 0;
        // Sized for the most the controls can ask for at once (breathing, a press, full drive), so
        // pressing or a loud song never rebuilds the pool mid-shower.
        const peak = params.rate * 1.12 * PRESS_RATE * (1 + DRIVE_SHARE);
        const capacity = showerCapacity({ ...s, rate: peak }, hammerRate);
        if (!current || current.capacity !== capacity) {
          current?.renderer.destroy();
          current?.sim.system.destroy();
          current = build(capacity);
        }
        const { sim, renderer } = current;

        // Solids: the page's marked elements, or stand-ins on a bare canvas.
        const page = dom.update(delta);
        const usePage = page.rects.length > 0;
        const rects = usePage ? page.rects : standInRects(aspect);
        const source = sourcePosition();
        const a = anvil();
        applyShower(sim, s);
        setShowerColliders(sim, {
          floor: true,
          anvil: a,
          boxes: params.cards && !a ? boxes(source, rects) : [],
          restitution: params.restitution,
          friction: params.friction,
        });
        raise(params.onTop && params.cards && usePage && !a);
        applyShowerLook(renderer, {
          intensity: params.intensity,
          shutter: params.shutter / 1000,
          size: 0.0021 * params.size,
        });

        if (a) {
          sim.source.direction = [0, 1, 0];
          sim.hammer.jumpTo([a.x + 0.02 * a.scale, a.y + 0.04 * a.scale, 0]);
          sim.hammer.extent = [0.08 * a.scale, 0, 0];
        } else {
          sim.hammer.jumpTo([source[0], source[1], 0]);
          sim.hammer.extent = [0, 0, 0];
        }

        if (!current.warm) {
          // Start mid-shower, also for a still frame under reduced motion.
          current.warm = true;
          sim.source.jumpTo([source[0], source[1], 0]);
          sim.system.warmup(Math.min(2.5, params.life * 1.4));
        }
        sim.source.moveTo([source[0], source[1], 0]);

        // Hammer strikes: on the clock, and on every press when there is an anvil.
        if (params.hammer > 0) {
          hammerClock += delta * params.hammer;
          if (hammerClock >= 1) {
            hammerClock %= 1;
            sim.hammer.burst(params.hammerBurst);
          }
        }
        if (strike && a) sim.hammer.burst(params.hammerBurst);

        sim.system.advance(encoder, time.delta);
        renderer.encode(encoder, time.delta);

        const boxData = new Float32Array(MAX_BOXES * 4);
        const drawn = usePage ? [] : rects.slice(0, MAX_BOXES);
        drawn.forEach((rect, k) => {
          const box = boxFromRect(rect, aspect);
          if (box.type === 'box')
            boxData.set([box.center[0], box.center[1], box.half[0], box.half[1]], k * 4);
        });
        // The backdrop pass only runs when it has something to draw (stand-ins, the anvil); over a
        // page the sparks clear the target themselves.
        const backdrop = !usePage || a !== undefined;
        if (backdrop) {
          sceneUniforms.set({
            aspect,
            pixel: 1 / height,
            floor_y: FLOOR_Y,
            count: params.cards && !a ? drawn.length : 0,
            anvil: a ? [a.x, a.y, a.scale, 1] : [0, 0, 1, 0],
            stand_ins: usePage ? 0 : 1,
            boxes: boxData,
          });
          sceneUniforms.upload();
          renderFullscreen(encoder, tail.scene.view, scenePipeline, [sceneGroup], {
            label: 'spark-shower scene',
            timestampWrites: profiler.pass('scene'),
          });
        }
        renderer.draw(encoder, {
          target: tail.scene.view,
          clear: backdrop ? undefined : { r: 0, g: 0, b: 0, a: 0 },
          timestampWrites: profiler.pass('sparks'),
        });
        // The hot spot where the grinder bites: one steady sprite. A spot that pulsed would be the
        // flash risk, not the sparks.
        const glow = a ? 0 : params.glow;
        if (glow > 0) {
          writeSprite(glowData, 0, {
            position: [source[0], source[1], 0],
            size: 0.009 * Math.sqrt(params.size),
            color: [7 * glow, 5.4 * glow, 3.6 * glow],
          });
          glowSprite.update(glowData, 1);
          glowSprite.draw(encoder, {
            target: tail.scene.view,
            label: 'spark-shower hot spot',
            timestampWrites: profiler.pass('hot spot'),
          });
        }
        tail.encode(encoder, target, time, params, profiler);
      },

      destroy() {
        raise(false);
        current?.renderer.destroy();
        current?.sim.system.destroy();
        dom.destroy();
        pointer.destroy();
        drive.destroy();
        sceneUniforms.destroy();
        glowSprite.destroy();
        camera.destroy();
        tail.destroy();
      },
    };
  },
});
