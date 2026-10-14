import { mat4 } from 'wgpu-matrix';
import { createCameraMatrices, type CameraMatrices } from '../scene/camera.ts';

// Cameras for two-dimensional particle systems (z = 0), producing the same CameraMatrices as
// `computeCamera`, so they feed the same `CameraUniform` and the same sprite renderer. World +x is
// right and +y is up on screen, the camera looks down -z, depth runs 0 (near) .. 1 (far).
//
// The eye sits at z = +1 by default, so particles on z = 0 are at a view distance of exactly 1: the
// sprite renderer's pixel floor (`minPixels`), which divides by the view distance as a perspective
// camera needs, is then right for the orthographic one too.

export interface OrthographicDescription {
  /** World point at the centre of the screen (x, y). */
  center: readonly [number, number];
  /** Half the visible height in world units; the width follows from `aspect`. */
  halfHeight: number;
  /** Canvas width / height. */
  aspect: number;
  /** Depth range along -z from the eye. Defaults 0.5 and 1.5 (the eye at z = 1). */
  near?: number;
  far?: number;
}

export function orthographicCamera(
  description: OrthographicDescription,
  dst: CameraMatrices = createCameraMatrices(),
): CameraMatrices {
  const { center, halfHeight, aspect, near = 0.5, far = 1.5 } = description;
  const distance = (near + far) / 2;
  const halfWidth = halfHeight * aspect;
  const eye: [number, number, number] = [center[0], center[1], distance];
  mat4.lookAt(eye, [center[0], center[1], 0], [0, 1, 0], dst.view);
  mat4.ortho(-halfWidth, halfWidth, -halfHeight, halfHeight, near, far, dst.proj);
  mat4.multiply(dst.proj, dst.view, dst.viewProj);
  mat4.invert(dst.view, dst.invView);
  mat4.invert(dst.proj, dst.invProj);
  mat4.invert(dst.viewProj, dst.invViewProj);
  dst.position[0] = eye[0];
  dst.position[1] = eye[1];
  dst.position[2] = eye[2];
  dst.near = near;
  dst.far = far;
  return dst;
}

/**
 * The overlay camera: world units are CANVAS HEIGHTS, the origin is the bottom-left corner, x runs
 * 0..aspect and y 0..1 upwards. A size of 0.01 is 1% of the canvas height on any canvas, and the
 * Epic 6 fluid's velocity (image heights per second) is already in these units (`overlayFieldMapping`).
 */
export function overlayCamera(
  width: number,
  height: number,
  dst: CameraMatrices = createCameraMatrices(),
): CameraMatrices {
  const aspect = width / Math.max(1, height);
  return orthographicCamera({ center: [aspect / 2, 0.5], halfHeight: 0.5, aspect }, dst);
}

/** Canvas uv (0..1, top-left origin, as pointers and igniters report it) to overlay world space. */
export function overlayPoint(u: number, v: number, aspect: number): [number, number, number] {
  return [u * aspect, 1 - v, 0];
}
