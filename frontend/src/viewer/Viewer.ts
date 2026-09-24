/**
 * Viewer — Three.js viewport.
 *
 * Preserves the original behaviours from main.ts: PLY loading with cache-bust,
 * vertex colours, OrbitControls with damping, bounding-box auto-fit, geometry
 * disposal. Adds view presets with tweens, axis gizmo, scale bar, cursor XYZ
 * readout, FPS stats, elevation colour mode, and the measure tool.
 *
 * World frame: +X East, +Y Up, −Z North (right-handed, from lib.rs).
 */

import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createControls, tweenCamera, cancelTween, updateTween, presetOffset, type ViewPreset } from './controls.ts';
import { applyColorMode } from './colorModes.ts';
import { AxisGizmo } from './gizmo.ts';
import { ScaleBar } from './scaleBar.ts';
import { MeasureTool } from './measure.ts';
import { el } from '../ui/icons.ts';
import type { ViewMode, ColorMode, ViewportBg } from '../state/store.ts';

export interface ModelInfo {
  vertices: number;
  faces: number;
  hasFaces: boolean;
}

const BG: Record<ViewportBg, number> = { dark: 0x1a1a1a, mid: 0x3f3f3f };

export class Viewer {
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly measure: MeasureTool;
  readonly gpuName: string;

  private grid: THREE.GridHelper;
  private gizmo: AxisGizmo;
  private scaleBar: ScaleBar;
  private statsEl: HTMLDivElement;
  private emptyEl: HTMLDivElement;
  private loadingEl: HTMLDivElement;
  private loadingStageEl: HTMLSpanElement;

  private geometry: THREE.BufferGeometry | null = null;
  private modelObject: THREE.Object3D | null = null;
  private raycastProxy: THREE.Points | null = null;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private pendingCursor: { x: number; y: number } | null = null;

  private mode: ViewMode = 'mesh';
  private colorMode: ColorMode = 'rgb';
  private pointSize = 2.0;
  private modelRad = 40;

  private fpsFrames = 0;
  private fpsLast = performance.now();

  onCursor: ((pos: [number, number, number] | null) => void) | null = null;
  onStats: ((points: number, faces: number, fps: number) => void) | null = null;
  /** Called on any left-click that hits the model (used by the measure tool). */
  onModelClick: ((point: THREE.Vector3) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = el('canvas', 'webgl') as HTMLCanvasElement;
    container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG.dark);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 10_000);
    this.camera.position.set(0, 80, 150);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      powerPreference: 'high-performance',
      antialias: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.controls = createControls(this.camera, this.canvas);
    this.controls.addEventListener('start', () => cancelTween());

    this.grid = new THREE.GridHelper(500, 100, 0x4a4a4a, 0x2c2c2c);
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.5;
    this.scene.add(this.grid);

    // GPU name for the status bar
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'WebGL';

    // Overlays
    this.gizmo = new AxisGizmo(container);
    this.scaleBar = new ScaleBar(container);
    this.statsEl = el('div', 'vp-overlay vp-stats');
    this.statsEl.hidden = true;
    container.appendChild(this.statsEl);

    this.emptyEl = el('div', 'vp-empty');
    container.appendChild(this.emptyEl);
    this.loadingEl = el('div', 'vp-loading');
    this.loadingEl.hidden = true;
    const chip = el('div', 'load-stage');
    this.loadingStageEl = el('span', undefined, 'Working…');
    chip.appendChild(this.loadingStageEl);
    this.loadingEl.appendChild(chip);
    container.appendChild(this.loadingEl);

    this.measure = new MeasureTool(this.scene, this.camera, container);

    // Events
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.pendingCursor = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.pendingCursor = null;
      this.onCursor?.(null);
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.onModelClick) return;
      const p = this.pickAt(e.clientX, e.clientY);
      if (p) this.onModelClick(p);
    });

    this.animate();
  }

  /* ── layout ──────────────────────────────────────────── */

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  }

  /* ── overlays ────────────────────────────────────────── */

  setEmptyState(htmlTitle: string, htmlHint: string | null): void {
    this.emptyEl.innerHTML = '';
    if (!htmlTitle) {
      this.emptyEl.hidden = true;
      return;
    }
    this.emptyEl.hidden = false;
    const t = el('div', 'empty-title', htmlTitle);
    this.emptyEl.appendChild(t);
    if (htmlHint) {
      const hint = el('div', 'empty-hint');
      hint.innerHTML = htmlHint;
      this.emptyEl.appendChild(hint);
    }
  }

  setLoading(stage: string | null): void {
    this.loadingEl.hidden = stage === null;
    if (stage !== null) this.loadingStageEl.textContent = stage;
  }

  /* ── model lifecycle ─────────────────────────────────── */

  private disposeModel(): void {
    if (this.modelObject) {
      const obj = this.modelObject;
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
        (obj.material as THREE.Material).dispose();
      }
      this.scene.remove(obj);
      this.modelObject = null;
    }
    if (this.raycastProxy) {
      (this.raycastProxy.material as THREE.Material).dispose();
      this.scene.remove(this.raycastProxy);
      this.raycastProxy = null;
    }
    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }
    this.measure.clearAll();
  }

  async loadModel(url: string): Promise<ModelInfo> {
    const loader = new PLYLoader();
    const geometry = await new Promise<THREE.BufferGeometry>((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });

    geometry.computeBoundingBox();
    const bbox = geometry.boundingBox!;
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    // Bounding-box centre → world origin; minimum Y rests on the grid plane.
    geometry.translate(-center.x, -bbox.min.y, -center.z);

    this.disposeModel();
    this.geometry = geometry;
    this.renderModel();
    this.frameAll();

    geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    geometry.boundingBox!.getSize(size);
    this.modelRad = Math.max(size.x, size.y, size.z) / 2;
    this.raycaster.params.Points = { threshold: Math.max(0.05, this.modelRad * 0.01) };
    this.measure.markerRadius = Math.max(0.05, this.modelRad * 0.012);

    const faces = geometry.index ? geometry.index.count / 3 : 0;
    const info: ModelInfo = { vertices: geometry.getAttribute('position').count, faces, hasFaces: faces > 0 };
    return info;
  }

  renderModel(): void {
    if (!this.geometry) return;
    if (this.modelObject) {
      const obj = this.modelObject;
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
        (obj.material as THREE.Material).dispose();
      }
      this.scene.remove(obj);
      this.modelObject = null;
    }

    applyColorMode(this.geometry, this.colorMode);
    const wantMesh = this.mode === 'mesh' && Boolean(this.geometry.index);
    if (wantMesh) {
      const mesh = new THREE.Mesh(
        this.geometry,
        new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
      );
      this.modelObject = mesh;
    } else {
      const pts = new THREE.Points(
        this.geometry,
        new THREE.PointsMaterial({ size: this.pointSize, vertexColors: true, sizeAttenuation: false })
      );
      this.modelObject = pts;
    }
    this.scene.add(this.modelObject);

    // Cheap raycast proxy: Points raycast is O(n) and far cheaper than mesh.
    if (!this.raycastProxy) {
      this.raycastProxy = new THREE.Points(
        this.geometry,
        new THREE.PointsMaterial({ size: 1 })
      );
      this.raycastProxy.visible = false;
      this.scene.add(this.raycastProxy);
    }
  }

  /* ── settings ────────────────────────────────────────── */

  setViewMode(mode: ViewMode): void {
    this.mode = mode;
    if (this.geometry) this.renderModel();
  }

  setColorMode(mode: ColorMode): void {
    this.colorMode = mode;
    if (this.geometry) this.renderModel();
  }

  setPointSize(px: number): void {
    this.pointSize = px;
    this.scene.traverse((o) => {
      if (o instanceof THREE.Points && o !== this.raycastProxy) {
        (o.material as THREE.PointsMaterial).size = px;
        o.material.needsUpdate = true;
      }
    });
  }

  setGrid(on: boolean): void {
    this.grid.visible = on;
  }

  setBackground(bg: ViewportBg): void {
    this.scene.background = new THREE.Color(BG[bg]);
  }

  /* ── camera ──────────────────────────────────────────── */

  frameAll(): void {
    if (!this.geometry) return;
    this.geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    this.geometry.boundingBox!.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 20);
    tweenCamera(
      this.camera,
      this.controls,
      new THREE.Vector3(0, maxDim * 0.7, maxDim * 1.0),
      new THREE.Vector3(0, size.y * 0.2, 0),
      new THREE.Vector3(0, 1, 0),
      this.modelObject ? 420 : 0
    );
  }

  setPreset(preset: ViewPreset): void {
    const { pos, up } = presetOffset(preset, this.modelRad * 2);
    const target = this.geometry
      ? this.geometry.boundingBox!.getCenter(new THREE.Vector3())
      : new THREE.Vector3(0, 0, 0);
    tweenCamera(this.camera, this.controls, pos, target, up);
  }

  /** Raycast the model (via the points proxy) at viewport px coords. */
  pickAt(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.raycastProxy) return null;
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.raycastProxy, false);
    return hits.length ? hits[0].point : null;
  }

  hasModel(): boolean {
    return this.geometry !== null;
  }

  /* ── render loop ─────────────────────────────────────── */

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    updateTween(this.camera, this.controls);
    this.controls.update();

    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.gizmo.draw(this.camera);
    this.scaleBar.update(this.camera, this.controls, h);
    this.measure.updateLabels(w, h);

    // Cursor readout — one raycast per frame max.
    if (this.pendingCursor) {
      const { x, y } = this.pendingCursor;
      this.pendingCursor = null;
      const r = this.canvas.getBoundingClientRect();
      const p = this.pickAt(x + r.left, y + r.top);
      this.onCursor?.(p ? [p.x, p.y, p.z] : null);
    }

    // FPS + stats (once per second)
    this.fpsFrames++;
    const now = performance.now();
    if (now - this.fpsLast >= 1000) {
      const fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsLast));
      this.fpsFrames = 0;
      this.fpsLast = now;
      if (this.geometry) {
        const pts = this.geometry.getAttribute('position').count;
        const faces = this.geometry.index ? this.geometry.index.count / 3 : 0;
        this.statsEl.hidden = false;
        this.statsEl.innerHTML =
          `<div class="stat-row"><span class="stat-k">Points</span><span class="stat-v">${pts.toLocaleString('en-US')}</span></div>` +
          `<div class="stat-row"><span class="stat-k">Faces</span><span class="stat-v">${faces.toLocaleString('en-US')}</span></div>` +
          `<div class="stat-row"><span class="stat-k">FPS</span><span class="stat-v">${fps}</span></div>`;
        this.onStats?.(pts, faces, fps);
      } else {
        this.statsEl.hidden = true;
      }
    }

    this.renderer.render(this.scene, this.camera);
  };
}
