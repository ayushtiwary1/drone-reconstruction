/**
 * colorModes — vertex-colour modes for the loaded geometry.
 *   rgb       — original per-vertex colours from the PLY
 *   elevation — frontend-only height ramp computed from the Y attribute
 */

import * as THREE from 'three';
import type { ColorMode } from '../state/store.ts';

const ORIGINAL_COLORS = 'origColors';

// Muted survey elevation ramp (low → high).
const STOPS: [number, [number, number, number]][] = [
  [0.0, [49, 76, 138]],
  [0.25, [44, 130, 160]],
  [0.5, [83, 158, 92]],
  [0.75, [196, 160, 72]],
  [1.0, [190, 74, 62]],
];

function ramp(t: number): [number, number, number] {
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const k = (t - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

function ensureOriginalColors(geometry: THREE.BufferGeometry): void {
  if (geometry.userData[ORIGINAL_COLORS]) return;
  const col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!col) return;
  geometry.userData[ORIGINAL_COLORS] = new Float32Array(col.array as ArrayLike<number>);
}

export function applyColorMode(geometry: THREE.BufferGeometry, mode: ColorMode): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return;
  ensureOriginalColors(geometry);
  const original = geometry.userData[ORIGINAL_COLORS] as Float32Array | undefined;

  if (mode === 'rgb') {
    if (original) {
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(original), 3));
      geometry.getAttribute('color').needsUpdate = true;
    }
    return;
  }

  // Elevation ramp over the local Y range.
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(1e-6, maxY - minY);
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) - minY) / span;
    const [r, g, b] = ramp(t);
    colors[i * 3] = r / 255;
    colors[i * 3 + 1] = g / 255;
    colors[i * 3 + 2] = b / 255;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
