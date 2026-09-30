/**
 * features/provenance.ts — frame↔vertex provenance, filmstrip selection,
 * lasso/box region tools, instant region regenerate, confidence field.
 *
 * Real-data contract (written by src-tauri next to the PLY):
 *   recon_frames.bin   : u16 LE per PLY vertex — dominant source frame
 *   recon_views.bin    : u16 LE per PLY vertex — view_count (0 = hole-filled)
 *   recon_cameras.json : per-frame {frame, time_s, cam, yaw_deg, pitch_deg,
 *                        h_agl, footprint[[x,z]×4], sharpness, exposure_clip,
 *                        gps_ok}
 *   frames/frame_NNNN.jpg : 320-px thumbnails (NNNN = zero-based frame id)
 */
import * as THREE from 'three';
import { backend } from '../pipeline/backend.ts';
import type { Viewer } from '../viewer/Viewer.ts';

export interface CameraMeta {
    frame: number;
    time_s: number;
    cam: number[];
    yaw_deg: number;
    pitch_deg: number;
    h_agl: number;
    footprint: number[][];
    sharpness: number;
    exposure_clip: number;
    gps_ok: boolean;
}

export const ACCENT = new THREE.Color(0x2d8ceb);
const REGION = new THREE.Color(0xe8a33d);
const EXC = new THREE.Color(0xd4504a);

export type RegionTool = 'off' | 'lasso' | 'box';
export type Notify = () => void;

export class Provenance {
    viewer: Viewer;
    frameIds: Uint16Array | null = null;
    viewCounts: Uint16Array | null = null;
    confidence: Float32Array | null = null;
    cams: CameraMeta[] = [];
    framesDir: string | null = null;
    frameCount = 0;
    loaded = false;

    selected = new Set<number>();
    excluded = new Set<number>();
    regionMask: Uint8Array | null = null;
    private undoPos: Float32Array | null = null;
    private undoCol: Float32Array | null = null;

    markers = new THREE.Group();
    footprints = new THREE.Group();
    private markerInstances: THREE.InstancedMesh | null = null;

    tool: RegionTool = 'off';
    private pts: { x: number; y: number }[] = [];
    private boxStart: { x: number; y: number } | null = null;
    private overlay: HTMLCanvasElement;

    onChange: Notify | null = null;          // filmstrip repaint
    onLog: ((msg: string) => void) | null = null;

    constructor(viewer: Viewer) {
        this.viewer = viewer;
        viewer.scene.add(this.markers);
        viewer.scene.add(this.footprints);

        this.overlay = document.createElement('canvas');
        this.overlay.className = 'vp-select-overlay';
        this.overlay.style.cssText =
            'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:6;';
        viewer.container.appendChild(this.overlay);
        this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
        this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
        this.overlay.addEventListener('pointerup', (e) => this.onUp(e));

        viewer.afterColor = () => this.applyTints();
    }

    /* ── loading ──────────────────────────────────────────── */

    async load(): Promise<boolean> {
        this.clearAll();
        this.loaded = false;
        this.frameIds = null;
        this.viewCounts = null;
        this.confidence = null;
        this.cams = [];
        const fb = backend.artifactPath('frames_bin');
        const vb = backend.artifactPath('views_bin');
        const cj = backend.artifactPath('cameras');
        this.framesDir = backend.artifactPath('frames_dir');
        this.frameCount = backend.framesCount();
        if (!fb || !cj) return false;
        try {
            const fbBuf = await (await fetch(backend.artifactUrl(fb))).arrayBuffer();
            this.frameIds = new Uint16Array(fbBuf);
            if (vb) {
                const vBuf = await (await fetch(backend.artifactUrl(vb))).arrayBuffer();
                this.viewCounts = new Uint16Array(vBuf);
            }
            this.cams = JSON.parse(await (await fetch(backend.artifactUrl(cj))).text());
            this.loaded = true;
            this.buildMarkers();
            await this.computeConfidence();
            return true;
        } catch (err) {
            this.onLog?.(`[SEL] provenance artifacts unavailable: ${err}`);
            return false;
        }
    }

    thumbUrl(frame: number): string | null {
        if (!this.framesDir) return null;
        const name = `frame_${String(frame).padStart(4, '0')}.jpg`;
        return backend.artifactUrl(`${this.framesDir}/${name}`);
    }

    /* ── camera markers + footprints ──────────────────────── */

    private buildMarkers(): void {
        for (const group of [this.markers, this.footprints]) {
            for (const child of group.children) {
                if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
                    child.geometry.dispose();
                    (child.material as THREE.Material).dispose();
                }
            }
            group.clear();
        }
        this.markerInstances = null;
        if (!this.cams.length) return;
        const instances = new THREE.InstancedMesh(
            new THREE.SphereGeometry(1, 8, 8),
            new THREE.MeshBasicMaterial({ color: 0xffffff }),
            this.cams.length
        );
        const transform = new THREE.Object3D();
        const t = this.viewer.translateVec;
        const lines: number[] = [];
        for (let i = 0; i < this.cams.length; i++) {
            const c = this.cams[i];
            transform.position.set(c.cam[0] + t.x, c.cam[1] + t.y, c.cam[2] + t.z);
            transform.updateMatrix();
            instances.setMatrixAt(i, transform.matrix);
            instances.setColorAt(i, this.markerColor(c.frame));
            if (c.footprint?.length === 4) {
                for (const [a, b] of [[0, 1], [1, 3], [3, 2], [2, 0]]) {
                    for (const j of [a, b]) {
                        lines.push(c.footprint[j][0] + t.x, 0.15, c.footprint[j][1] + t.z);
                    }
                }
            }
        }
        instances.instanceMatrix.needsUpdate = true;
        this.markerInstances = instances;
        this.markers.add(instances);
        if (lines.length) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
            this.footprints.add(new THREE.LineSegments(geo,
                new THREE.LineBasicMaterial({ color: 0x8a8a8a, transparent: true, opacity: 0.35 })));
        }
        this.viewer.invalidate();
    }

    private markerColor(f: number): THREE.Color {
        return this.excluded.has(f) ? EXC
            : this.selected.has(f) ? ACCENT
            : new THREE.Color(0x9a9a9a);
    }

    refreshMarkers(): void {
        if (!this.markerInstances) return;
        this.cams.forEach((c, i) => this.markerInstances!.setColorAt(i, this.markerColor(c.frame)));
        if (this.markerInstances.instanceColor) this.markerInstances.instanceColor.needsUpdate = true;
        this.viewer.invalidate();
    }

    /* ── confidence field (T7) ────────────────────────────── */

    private async computeConfidence(): Promise<void> {
        const pos = this.viewer.getGeometry()?.getAttribute('position');
        if (!pos || !this.frameIds?.length) return;
        const positions = new Float32Array(pos.array as Float32Array);
        const ids = new Uint16Array(this.frameIds);
        const views = this.viewCounts ? new Uint16Array(this.viewCounts) : null;
        const worker = new Worker(new URL('./confidence.worker.ts', import.meta.url), { type: 'module' });
        try {
            this.confidence = await new Promise<Float32Array>((resolve, reject) => {
                worker.onmessage = (e: MessageEvent<ArrayBuffer>) => resolve(new Float32Array(e.data));
                worker.onerror = (e) => reject(new Error(e.message));
                worker.postMessage({
                    positions: positions.buffer,
                    ids: ids.buffer,
                    views: views?.buffer ?? null,
                    cams: this.cams,
                    translate: this.viewer.translateVec.toArray(),
                }, { transfer: [positions.buffer, ids.buffer, ...(views ? [views.buffer] : [])] });
            });
        } finally {
            worker.terminate();
        }
    }

    /* ── tints ────────────────────────────────────────────── */

    applyTints(): void {
        const g = this.viewer.getGeometry();
        if (!g || !this.frameIds) return;
        const pos = g.getAttribute('position');
        const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
        if (!col) return;
        const n = pos.count;
        const out = col.array as Float32Array;
        const base = (g.userData.baseTint as Float32Array | undefined)
            ?? new Float32Array(out);
        if (!g.userData.baseTint) g.userData.baseTint = new Float32Array(out);
        const sel = this.selected;
        const noSel = sel.size === 0 && !this.regionMask && this.excluded.size === 0;
        const dim = 0.3;
        for (let i = 0; i < n; i++) {
            const f = this.frameIds[i];
            const j = i * 3;
            if (this.regionMask?.[i]) {
                out[j] = REGION.r; out[j + 1] = REGION.g; out[j + 2] = REGION.b;
            } else if (this.excluded.has(f)) {
                out[j] = base[j] * 0.3 + EXC.r * 0.7;
                out[j + 1] = base[j + 1] * 0.3 + EXC.g * 0.7;
                out[j + 2] = base[j + 2] * 0.3 + EXC.b * 0.7;
            } else if (!noSel && sel.has(f)) {
                out[j] = ACCENT.r; out[j + 1] = ACCENT.g; out[j + 2] = ACCENT.b;
            } else {
                const k = noSel ? 1.0 : dim;
                out[j] = base[j] * k;
                out[j + 1] = base[j + 1] * k;
                out[j + 2] = base[j + 2] * k;
            }
        }
        col.needsUpdate = true;
        this.viewer.invalidate();
    }

    /* ── selection ops ────────────────────────────────────── */

    selectClick(i: number, e: MouseEvent): void {
        if (e.altKey) {
            this.excluded.has(i) ? this.excluded.delete(i) : this.excluded.add(i);
        } else if (e.shiftKey && this.selected.size > 0) {
            const anchor = Math.max(...this.selected);
            for (let f = Math.min(anchor, i); f <= Math.max(anchor, i); f++) this.selected.add(f);
        } else if (e.ctrlKey || e.metaKey) {
            this.selected.has(i) ? this.selected.delete(i) : this.selected.add(i);
        } else {
            this.selected.clear();
            this.selected.add(i);
        }
        this.refreshMarkers();
        this.applyTints();
        this.onChange?.();
    }

    toggleExclude(f: number): void {
        this.excluded.has(f) ? this.excluded.delete(f) : this.excluded.add(f);
        this.refreshMarkers();
        this.applyTints();
        this.onChange?.();
    }

    clearAll(): void {
        this.selected.clear();
        this.regionMask = null;
        this.pts = [];
        this.boxStart = null;
        this.clearOverlay();
        this.refreshMarkers();
        this.applyTints();
        this.onChange?.();
    }

    getFrameRange(): [number, number] | null {
        if (!this.selected.size) return null;
        const a = [...this.selected];
        return [Math.min(...a), Math.max(...a)];
    }

    /* ── region tools ─────────────────────────────────────── */

    setTool(t: RegionTool): void {
        this.tool = t;
        this.overlay.style.pointerEvents = t === 'off' ? 'none' : 'auto';
        this.overlay.style.cursor = t === 'off' ? '' : 'crosshair';
        if (t === 'off') {
            this.viewer.controls.enabled = true;
            this.clearOverlay();
        } else {
            this.viewer.controls.enabled = false;
        }
    }

    private evXY(e: PointerEvent): { x: number; y: number } {
        const r = this.overlay.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    private onDown(e: PointerEvent): void {
        if (this.tool === 'off') return;
        this.sizeOverlay();
        const p = this.evXY(e);
        if (this.tool === 'box') {
            this.boxStart = p;
            this.pts = [p];
        } else {
            this.pts = [p];
        }
        this.overlay.setPointerCapture(e.pointerId);
    }

    private onMove(e: PointerEvent): void {
        if (!this.pts.length && !this.boxStart) return;
        const p = this.evXY(e);
        if (this.tool === 'box' && this.boxStart) {
            this.pts = [
                this.boxStart,
                { x: p.x, y: this.boxStart.y },
                p,
                { x: this.boxStart.x, y: p.y },
            ];
        } else {
            this.pts.push(p);
        }
        this.drawOverlay();
    }

    private onUp(_e: PointerEvent): void {
        if (this.pts.length > 2) {
            void this.applyRegion(this.pts.slice()).finally(() => {
                this.pts = [];
                this.boxStart = null;
                this.setTool('off');
            });
        } else {
            this.pts = [];
            this.boxStart = null;
            this.setTool('off');
        }
    }

    private sizeOverlay(): void {
        const w = this.viewer.canvas.clientWidth;
        const h = this.viewer.canvas.clientHeight;
        this.overlay.width = w * devicePixelRatio;
        this.overlay.height = h * devicePixelRatio;
    }

    private drawOverlay(): void {
        const ctx = this.overlay.getContext('2d')!;
        ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
        if (this.pts.length < 2) return;
        ctx.save();
        ctx.scale(devicePixelRatio, devicePixelRatio);
        ctx.strokeStyle = '#e8a33d';
        ctx.fillStyle = 'rgba(232,163,61,0.12)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(this.pts[0].x, this.pts[0].y);
        for (const p of this.pts) ctx.lineTo(p.x, p.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    private clearOverlay(): void {
        const c = this.overlay.getContext('2d');
        c?.clearRect(0, 0, this.overlay.width, this.overlay.height);
    }

    /* ── region → frames ──────────────────────────────────── */

    private async applyRegion(poly: { x: number; y: number }[]): Promise<void> {
        const g = this.viewer.getGeometry();
        if (!g || !this.frameIds) return;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const n = pos.count;
        const w = this.viewer.canvas.clientWidth;
        const h = this.viewer.canvas.clientHeight;
        const v = new THREE.Vector3();
        this.viewer.camera.updateMatrixWorld();
        const mvp = new THREE.Matrix4().multiplyMatrices(this.viewer.camera.projectionMatrix, this.viewer.camera.matrixWorldInverse);
        this.regionMask = new Uint8Array(n);
        let inside = 0;
        for (let offset = 0; offset < n; offset += 100_000) {
            for (let i = offset; i < Math.min(n, offset + 100_000); i++) {
                v.fromBufferAttribute(pos, i).applyMatrix4(mvp);
                if (v.z > 1) continue;
                const sx = (v.x * 0.5 + 0.5) * w;
                const sy = (-v.y * 0.5 + 0.5) * h;
                if (pointInPoly(sx, sy, poly)) {
                    this.regionMask[i] = 1;
                    inside++;
                }
            }
            if (offset + 100_000 < n) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        if (!inside) {
            this.regionMask = null;
            this.onLog?.('[SEL] Region contained no points.');
            this.onChange?.();
            return;
        }
        const counts = this.regionFrameCounts();
        const sorted = [...counts.entries()]
            .filter(([f]) => f !== 65535)
            .sort((a, b) => b[1] - a[1]);
        this.selected = new Set(sorted.slice(0, 12).map(([f]) => f));
        this.refreshMarkers();
        this.applyTints();
        this.onChange?.();
        this.onLog?.(
            `[SEL] Region: ${inside.toLocaleString('en-US')} pts from ${sorted.length} frames ` +
            `(top: ${sorted.slice(0, 4).map(([f, c]) => `F${f}·${c.toLocaleString('en-US')}`).join(', ')})`
        );
    }

    /** frame → point count inside the region (sorted desc) */
    regionFrameCounts(): Map<number, number> {
        const counts = new Map<number, number>();
        if (!this.regionMask || !this.frameIds) return counts;
        for (let i = 0; i < this.frameIds.length; i++) {
            if (this.regionMask[i]) {
                const f = this.frameIds[i];
                counts.set(f, (counts.get(f) ?? 0) + 1);
            }
        }
        return counts;
    }

    /* ── instant regenerate (T5) ──────────────────────────── */

    regenerateRegion(): { replaced: number; frames: number; ms: number } | null {
        const g = this.viewer.getGeometry();
        if (!g || !this.frameIds || !this.regionMask || !this.excluded.size) return null;
        const t0 = performance.now();
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const col = g.getAttribute('color') as THREE.BufferAttribute;
        const pa = pos.array as Float32Array;
        const ca = col.array as Float32Array;
        const n = pos.count;
        this.undoPos = new Float32Array(pa);
        this.undoCol = new Float32Array(ca);
        const cell = 2.0;
        const grid = new Map<string, number[]>();
        const bad: number[] = [];
        for (let i = 0; i < n; i++) {
            if (!this.regionMask[i]) continue;
            if (this.excluded.has(this.frameIds[i])) bad.push(i);
            else {
                const k = `${Math.floor(pa[i * 3] / cell)},${Math.floor(pa[i * 3 + 1] / cell)},${Math.floor(pa[i * 3 + 2] / cell)}`;
                (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
            }
        }
        if (!bad.length) return null;
        let replaced = 0;
        const ring = [-1, 0, 1];
        for (const i of bad) {
            const cx = Math.floor(pa[i * 3] / cell);
            const cy = Math.floor(pa[i * 3 + 1] / cell);
            const cz = Math.floor(pa[i * 3 + 2] / cell);
            let found: number[] = [];
            for (let R = 0; R <= 2 && found.length < 4; R++) {
                found = [];
                for (const dx of ring) for (const dy of ring) for (const dz of ring) {
                    if (R > 0 && Math.abs(dx) < R && Math.abs(dy) < R && Math.abs(dz) < R) continue;
                    const lst = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
                    if (lst) found.push(...lst);
                }
            }
            if (!found.length) continue;
            found.sort((a, b) => dist2(pa, a, i) - dist2(pa, b, i));
            const k = Math.min(4, found.length);
            let sx = 0, sy = 0, sz = 0, sr = 0, sgc = 0, sb = 0;
            for (let q = 0; q < k; q++) {
                const j = found[q] * 3;
                sx += pa[j]; sy += pa[j + 1]; sz += pa[j + 2];
                sr += ca[j]; sgc += ca[j + 1]; sb += ca[j + 2];
            }
            pa[i * 3] = sx / k; pa[i * 3 + 1] = sy / k; pa[i * 3 + 2] = sz / k;
            ca[i * 3] = sr / k; ca[i * 3 + 1] = sgc / k; ca[i * 3 + 2] = sb / k;
            const base = g.userData.baseTint as Float32Array | undefined;
            if (base) { base[i * 3] = ca[i * 3]; base[i * 3 + 1] = ca[i * 3 + 1]; base[i * 3 + 2] = ca[i * 3 + 2]; }
            replaced++;
        }
        pos.needsUpdate = true;
        g.computeBoundingSphere();
        this.applyTints();
        return { replaced, frames: this.excluded.size, ms: performance.now() - t0 };
    }

    undo(): boolean {
        const g = this.viewer.getGeometry();
        if (!g || !this.undoPos || !this.undoCol) return false;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const col = g.getAttribute('color') as THREE.BufferAttribute;
        (pos.array as Float32Array).set(this.undoPos);
        (col.array as Float32Array).set(this.undoCol);
        pos.needsUpdate = true;
        col.needsUpdate = true;
        g.computeBoundingSphere();
        g.userData.baseTint = new Float32Array(this.undoCol);
        this.undoPos = null;
        this.undoCol = null;
        return true;
    }
}

function dist2(pa: Float32Array, a: number, b: number): number {
    const dx = pa[a * 3] - pa[b * 3];
    const dy = pa[a * 3 + 1] - pa[b * 3 + 1];
    const dz = pa[a * 3 + 2] - pa[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
}

function pointInPoly(x: number, y: number, poly: { x: number; y: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}
