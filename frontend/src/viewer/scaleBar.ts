/**
 * scaleBar — DOM overlay showing a metric scale bar that tracks zoom.
 */

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { el } from '../ui/icons.ts';

const NICE = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

export class ScaleBar {
  private wrap: HTMLDivElement;
  private bar: HTMLDivElement;
  private label: HTMLDivElement;
  private lastText = '';
  private lastWidth = -1;

  constructor(parent: HTMLElement) {
    this.wrap = el('div', 'vp-overlay vp-scalebar');
    this.label = el('div', 'sb-label');
    this.bar = el('div', 'sb-bar');
    this.wrap.appendChild(this.label);
    this.wrap.appendChild(this.bar);
    parent.appendChild(this.wrap);
  }

  update(camera: THREE.PerspectiveCamera, controls: OrbitControls, viewportH: number): void {
    const dist = camera.position.distanceTo(controls.target);
    if (dist <= 0 || viewportH <= 0) return;
    const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewportH;

    // Aim for a bar of ~110 CSS px.
    const targetMeters = worldPerPx * 110;
    let nice = NICE[NICE.length - 1];
    for (const n of NICE) {
      if (n <= targetMeters * 1.4) nice = n;
      else break;
    }
    const px = nice / worldPerPx;
    const text = nice >= 1000 ? `${(nice / 1000).toFixed(nice % 1000 ? 1 : 0)} km` : `${nice} m`;

    if (text !== this.lastText) {
      this.label.textContent = text;
      this.lastText = text;
    }
    const w = Math.round(px);
    if (w !== this.lastWidth) {
      this.bar.style.width = `${w}px`;
      this.lastWidth = w;
    }
  }
}
