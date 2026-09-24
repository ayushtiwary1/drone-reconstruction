/**
 * controls — OrbitControls setup, camera tweening, and view presets.
 * World frame (backend contract): +X East, +Y Up, −Z North.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ViewPreset = 'top' | 'front' | 'side' | 'iso';

export function createControls(camera: THREE.PerspectiveCamera, dom: HTMLElement): OrbitControls {
  const controls = new OrbitControls(camera, dom);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.minDistance = 1;
  controls.maxDistance = 5_000;
  return controls;
}

interface Tween {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromUp: THREE.Vector3;
  toUp: THREE.Vector3;
  t0: number;
  dur: number;
}

let activeTween: Tween | null = null;

const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Smoothly move camera to a new position/target. Cancelled by user input. */
export function tweenCamera(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  toPos: THREE.Vector3,
  toTarget: THREE.Vector3,
  toUp = new THREE.Vector3(0, 1, 0),
  dur = 420
): void {
  activeTween = {
    fromPos: camera.position.clone(),
    toPos: toPos.clone(),
    fromTarget: controls.target.clone(),
    toTarget: toTarget.clone(),
    fromUp: camera.up.clone(),
    toUp: toUp.clone(),
    t0: performance.now(),
    dur,
  };
  controls.enabled = false;
}

export function cancelTween(): void {
  activeTween = null;
}

export function updateTween(camera: THREE.PerspectiveCamera, controls: OrbitControls): void {
  if (!activeTween) return;
  const t = Math.min(1, (performance.now() - activeTween.t0) / activeTween.dur);
  const k = easeInOut(t);
  camera.position.lerpVectors(activeTween.fromPos, activeTween.toPos, k);
  controls.target.lerpVectors(activeTween.fromTarget, activeTween.toTarget, k);
  camera.up.lerpVectors(activeTween.fromUp, activeTween.toUp, k).normalize();
  if (t >= 1) {
    activeTween = null;
    controls.enabled = true;
  }
}

/**
 * Camera offset for a preset, given the model radius and target.
 *   Top  = directly above, looking down −Y (north-up screen via up=−Z)
 *   Front = south side (+Z), looking north (−Z)
 *   Side  = east side (+X), looking west (−X)
 *   Iso   = south-east elevated diagonal
 */
export function presetOffset(preset: ViewPreset, radius: number): { pos: THREE.Vector3; up: THREE.Vector3 } {
  const d = Math.max(radius * 1.9, 10);
  switch (preset) {
    case 'top':
      return { pos: new THREE.Vector3(0, d, 0), up: new THREE.Vector3(0, 0, -1) };
    case 'front':
      return { pos: new THREE.Vector3(0, d * 0.12, d), up: new THREE.Vector3(0, 1, 0) };
    case 'side':
      return { pos: new THREE.Vector3(d, d * 0.12, 0), up: new THREE.Vector3(0, 1, 0) };
    case 'iso':
      return { pos: new THREE.Vector3(d * 0.72, d * 0.6, d * 0.72), up: new THREE.Vector3(0, 1, 0) };
  }
}
