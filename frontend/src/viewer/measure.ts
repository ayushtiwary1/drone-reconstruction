/**
 * measure — click-two-points measurement tool (frontend-only).
 * Renders a 3D line + endpoint markers and an HTML label with
 * 3D distance, horizontal distance and ΔY.
 */

import * as THREE from 'three';
import { el } from '../ui/icons.ts';
import { store, type Measurement } from '../state/store.ts';

const ACCENT = 0x2d8ceb;
const PENDING = 0x4a9ef0;

interface RenderedMeasurement {
  group: THREE.Group;
  label: HTMLDivElement;
}

export interface MeasureStats {
  dist3d: number;
  horizontal: number;
  dy: number;
}

export function measureStats(m: Measurement): MeasureStats {
  const a = new THREE.Vector3(...m.a);
  const b = new THREE.Vector3(...m.b);
  const d = a.distanceTo(b);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return { dist3d: d, horizontal: Math.hypot(dx, dz), dy: Math.abs(b.y - a.y) };
}

export class MeasureTool {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private layer: HTMLDivElement;
  private rendered = new Map<number, RenderedMeasurement>();
  private pendingMarker: THREE.Mesh | null = null;
  private pendingLabel: HTMLDivElement | null = null;
  private v = new THREE.Vector3();
  /** Marker radius in world units — scaled to the model size. */
  markerRadius = 0.35;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, layerParent: HTMLElement) {
    this.scene = scene;
    this.camera = camera;
    this.layer = el('div', 'vp-measure-layer');
    layerParent.appendChild(this.layer);
  }

  setPendingPoint(p: [number, number, number] | null): void {
    this.clearPending();
    if (!p) return;
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(this.markerRadius, 16, 12),
      new THREE.MeshBasicMaterial({ color: PENDING })
    );
    marker.position.set(p[0], p[1], p[2]);
    this.pendingMarker = marker;
    this.scene.add(marker);

    const lab = el('div', 'measure-label');
    lab.innerHTML = '<span class="ml-sub">pick second point — Esc cancels</span>';
    this.pendingLabel = lab;
    this.layer.appendChild(lab);
  }

  private clearPending(): void {
    if (this.pendingMarker) {
      this.pendingMarker.geometry.dispose();
      (this.pendingMarker.material as THREE.Material).dispose();
      this.scene.remove(this.pendingMarker);
      this.pendingMarker = null;
    }
    this.pendingLabel?.remove();
    this.pendingLabel = null;
  }

  add(m: Measurement): void {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: ACCENT });
    for (const p of [m.a, m.b]) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(this.markerRadius, 16, 12), mat);
      s.position.set(p[0], p[1], p[2]);
      group.add(s);
    }
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...m.a),
      new THREE.Vector3(...m.b),
    ]);
    group.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: ACCENT })));
    this.scene.add(group);

    const st = measureStats(m);
    // ± estimated from the confidence field at the endpoints (if loaded)
    let errTxt = '';
    const conf = this.scene.userData.confidence as Float32Array | undefined;
    if (conf && m.ia !== undefined && m.ib !== undefined) {
      const c = (conf[m.ia] + conf[m.ib]) / 2;
      const sigma = 0.05 + 0.2 * (1 - c);
      errTxt = ` ±${sigma.toFixed(2)} (est.)`;
    }
    const label = el('div', 'measure-label');
    label.innerHTML =
      `<span class="ml-dist">${st.dist3d.toFixed(2)} m${errTxt}</span>` +
      `<br><span class="ml-sub">ΔY ${st.dy.toFixed(2)} · horiz ${st.horizontal.toFixed(2)}</span>`;
    this.layer.appendChild(label);
    this.rendered.set(m.id, { group, label });
  }

  remove(id: number): void {
    const r = this.rendered.get(id);
    if (!r) return;
    r.group.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.scene.remove(r.group);
    r.label.remove();
    this.rendered.delete(id);
  }

  clearAll(): void {
    for (const id of Array.from(this.rendered.keys())) this.remove(id);
    this.clearPending();
  }

  /** Project measurement midpoints to screen-space label positions. */
  updateLabels(viewW: number, viewH: number): void {
    const place = (world: THREE.Vector3, label: HTMLDivElement): void => {
      this.v.copy(world).project(this.camera);
      if (this.v.z > 1) {
        label.style.display = 'none';
        return;
      }
      label.style.display = '';
      label.style.left = `${(this.v.x * 0.5 + 0.5) * viewW}px`;
      label.style.top = `${(-this.v.y * 0.5 + 0.5) * viewH - 8}px`;
    };

    const pending = store.get('measurePending');
    if (pending && this.pendingLabel) {
      place(new THREE.Vector3(...pending), this.pendingLabel);
    }
    for (const [id, r] of this.rendered) {
      const m = store.get('measurements').find((x) => x.id === id);
      if (!m) continue;
      const mid = new THREE.Vector3(...m.a).lerp(new THREE.Vector3(...m.b), 0.5);
      place(mid, r.label);
    }
  }
}
