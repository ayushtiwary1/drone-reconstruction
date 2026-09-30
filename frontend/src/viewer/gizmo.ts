/**
 * gizmo — 2D-canvas axis gizmo, bottom-left of the viewport.
 * Axes follow the backend world frame: +X = E, +Y = Up, −Z = N.
 */

import * as THREE from 'three';

const AXES: { dir: THREE.Vector3; label: string; color: string }[] = [
  { dir: new THREE.Vector3(1, 0, 0), label: 'E', color: '#c25a52' },
  { dir: new THREE.Vector3(0, 1, 0), label: 'Up', color: '#5bb974' },
  { dir: new THREE.Vector3(0, 0, -1), label: 'N', color: '#4a9ef0' },
];

export class AxisGizmo {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size = 76;
  private qInv = new THREE.Quaternion();
  private v = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'vp-gizmo';
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.size}px`;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    this.ctx = ctx;
    this.ctx.scale(dpr, dpr);
    parent.appendChild(this.canvas);
  }

  /** Redraw for the current camera orientation. Called each frame. */
  draw(camera: THREE.PerspectiveCamera): void {
    const ctx = this.ctx;
    const s = this.size;
    const c = s / 2;
    const R = s * 0.32;
    ctx.clearRect(0, 0, s, s);

    this.qInv.copy(camera.quaternion).invert();

    // Painter's order: draw far-pointing axes first.
    const projected = AXES.map((a) => {
      this.v.copy(a.dir).applyQuaternion(this.qInv);
      return { ...a, x: this.v.x, y: this.v.y, z: this.v.z };
    }).sort((a, b) => a.z - b.z); // +z = toward viewer → draw last

    for (const a of projected) {
      const px = c + a.x * R;
      const py = c - a.y * R; // canvas y down
      const toward = a.z > 0;
      ctx.strokeStyle = a.color;
      ctx.globalAlpha = toward ? 0.95 : 0.45;
      ctx.lineWidth = toward ? 1.6 : 1.1;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.fillStyle = a.color;
      ctx.font = '600 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lx = c + a.x * (R + 9);
      const ly = c - a.y * (R + 9);
      ctx.fillText(a.label, lx, ly);
      ctx.globalAlpha = 1;
    }
  }
}
