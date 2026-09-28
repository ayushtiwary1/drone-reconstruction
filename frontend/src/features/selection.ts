/**
 * features/selection.ts — demo: filmstrip selection, lasso region,
 * region→frame mapping, instant regenerate, rebuild-from-frames.
 *
 * Real-data contract:
 *   recon_frames.bin  : u16 LE per PLY vertex (same order as position attr)
 *   recon_cameras.json: [{frame, time_s, cam:[x,y,z]}] in PLY world coords
 *   frames/frame_NNNN.jpg : thumbnails (zero-based NNNN == frame id)
 */
import * as THREE from 'three';
import { convertFileSrc } from '@tauri-apps/api/core';

export interface SelectionDeps {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    canvas: HTMLCanvasElement;
    controls: { enabled: boolean };
    appendLog: (html: string) => void;
    getGeometry: () => THREE.BufferGeometry | null;
    reloadArtifacts: () => Promise<void>;
}

const ACCENT = new THREE.Color(0x22d3ee);   // selected-frame tint
const REGION = new THREE.Color(0xf59e0b);   // lasso region tint
const BAD = new THREE.Color(0xef4444);      // excluded-frame tint

export class SelectionDemo {
    private d: SelectionDeps;
    private frameIds: Uint16Array | null = null;
    private cameras: { frame: number; time_s: number; cam: number[] }[] = [];
    private framesDir = '';
    private frameCount = 0;
    private translate = new THREE.Vector3();

    private selectedFrames = new Set<number>();
    private excludedFrames = new Set<number>();
    private regionMask: Uint8Array | null = null;
    private baseColors: Float32Array | null = null;
    private undoPos: Float32Array | null = null;
    private undoCol: Float32Array | null = null;

    private markerGroup = new THREE.Group();
    private lassoing = false;
    private lassoPts: { x: number; y: number }[] = [];

    private el = {
        strip: document.getElementById('filmstrip') as HTMLDivElement,
        lasso: document.getElementById('lassoCanvas') as HTMLCanvasElement,
        lassoBtn: document.getElementById('lassoBtn') as HTMLButtonElement,
        regenBtn: document.getElementById('regenBtn') as HTMLButtonElement,
        undoBtn: document.getElementById('undoBtn') as HTMLButtonElement,
        rebuildBtn: document.getElementById('rebuildBtn') as HTMLButtonElement,
        clearBtn: document.getElementById('clearBtn') as HTMLButtonElement,
        toast: document.getElementById('toast') as HTMLDivElement,
    };

    constructor(d: SelectionDeps) {
        this.d = d;
        d.scene.add(this.markerGroup);
        this.el.lassoBtn.onclick = () => this.toggleLasso();
        this.el.regenBtn.onclick = () => this.regenerateRegion();
        this.el.undoBtn.onclick = () => this.undo();
        this.el.clearBtn.onclick = () => this.clearAll();
        window.addEventListener('keydown', (e) => {
            if (e.key === 'l' || e.key === 'L') this.toggleLasso();
            if (e.key === 'Escape') this.clearAll();
            if (e.key === 'x' || e.key === 'X') this.toggleExcludeSelected();
        });
        const lc = this.el.lasso;
        lc.addEventListener('pointerdown', (e) => this.onLassoDown(e));
        lc.addEventListener('pointermove', (e) => this.onLassoMove(e));
        lc.addEventListener('pointerup', () => this.onLassoUp());
    }

    /** Called by main.ts when artifacts for the current run are known. */
    async loadArtifacts(framesBin: string, camerasJson: string,
                        framesDir: string, frameCount: number,
                        geomTranslate: THREE.Vector3): Promise<void> {
        this.translate.copy(geomTranslate);
        this.framesDir = framesDir;
        this.frameCount = frameCount;
        this.frameIds = null;
        this.regionMask = null;
        this.selectedFrames.clear();
        this.excludedFrames.clear();
        try {
            const buf = await (await fetch(convertFileSrc(framesBin))).arrayBuffer();
            this.frameIds = new Uint16Array(buf);
            this.cameras = JSON.parse(
                await (await fetch(convertFileSrc(camerasJson))).text());
            this.buildStrip();
            this.buildMarkers();
            this.d.appendLog(
                `<span style="color:#22d3ee;">[SEL] ${this.frameIds.length.toLocaleString()} vertices tagged to ${this.cameras.length} camera frames.</span>`);
        } catch (err) {
            this.d.appendLog(`<span style="color:#fb923c;">[SEL] artifacts unavailable: ${err}</span>`);
        }
    }

    // ── filmstrip ──────────────────────────────────────────────
    private buildStrip(): void {
        const strip = this.el.strip;
        strip.innerHTML = '';
        if (!this.frameCount) { strip.style.display = 'none'; return; }
        strip.style.display = 'flex';
        for (let i = 0; i < this.frameCount; i++) {
            const cell = document.createElement('div');
            cell.className = 'fs-cell';
            cell.dataset.frame = String(i);
            const img = document.createElement('img');
            const name = `frame_${String(i).padStart(4, '0')}.jpg`;
            img.src = convertFileSrc(`${this.framesDir}/${name}`);
            img.loading = 'lazy';
            const lab = document.createElement('div');
            lab.className = 'fs-label';
            const t = this.cameras.find((c) => c.frame === i)?.time_s ?? i;
            lab.textContent = `F${i} · ${t.toFixed(0)}s`;
            const badge = document.createElement('div');
            badge.className = 'fs-badge';
            cell.append(img, lab, badge);
            cell.addEventListener('click', (e) => this.onFrameClick(i, e));
            strip.appendChild(cell);
        }
    }

    private onFrameClick(i: number, e: MouseEvent): void {
        if (e.altKey) {
            // Alt-click toggles exclude
            if (this.excludedFrames.has(i)) this.excludedFrames.delete(i);
            else this.excludedFrames.add(i);
            this.refreshStrip();
            this.applyTints();
            return;
        }
        if (e.shiftKey && this.selectedFrames.size > 0) {
            const anchor = Math.max(...this.selectedFrames);
            const [lo, hi] = [Math.min(anchor, i), Math.max(anchor, i)];
            for (let f = lo; f <= hi; f++) this.selectedFrames.add(f);
        } else if (e.ctrlKey || e.metaKey) {
            this.selectedFrames.has(i)
                ? this.selectedFrames.delete(i)
                : this.selectedFrames.add(i);
        } else {
            this.selectedFrames.clear();
            this.selectedFrames.add(i);
        }
        this.refreshStrip();
        this.applyTints();
    }

    private toggleExcludeSelected(): void {
        for (const f of this.selectedFrames) {
            this.excludedFrames.has(f)
                ? this.excludedFrames.delete(f)
                : this.excludedFrames.add(f);
        }
        this.refreshStrip();
        this.applyTints();
    }

    private refreshStrip(): void {
        const cells = this.el.strip.children;
        for (let k = 0; k < cells.length; k++) {
            const c = cells[k] as HTMLElement;
            const f = Number(c.dataset.frame);
            c.classList.toggle('sel', this.selectedFrames.has(f));
            c.classList.toggle('exc', this.excludedFrames.has(f));
        }
        for (const m of this.markerGroup.children) {
            const f = (m.userData.frame as number);
            (m as THREE.Mesh).material = this.markerMaterial(f);
        }
    }

    // ── camera markers ─────────────────────────────────────────
    private markerMaterial(f: number): THREE.Material {
        const col = this.excludedFrames.has(f) ? BAD
            : this.selectedFrames.has(f) ? ACCENT
            : new THREE.Color(0x94a3b8);
        return new THREE.MeshBasicMaterial({ color: col });
    }

    private buildMarkers(): void {
        this.markerGroup.clear();
        const geo = new THREE.SphereGeometry(1.2, 8, 8);
        for (const c of this.cameras) {
            const m = new THREE.Mesh(geo, this.markerMaterial(c.frame));
            m.position.set(c.cam[0], c.cam[1], c.cam[2]).add(this.translate);
            m.userData.frame = c.frame;
            this.markerGroup.add(m);
        }
    }

    // ── tinting ────────────────────────────────────────────────
    private applyTints(): void {
        const g = this.d.getGeometry();
        if (!g || !this.frameIds) return;
        const pos = g.getAttribute('position');
        const col = g.getAttribute('color') as THREE.BufferAttribute;
        if (!col) return;
        const n = pos.count;
        if (!this.baseColors || this.baseColors.length !== n * 3) {
            this.baseColors = new Float32Array(col.array as Float32Array);
        }
        const out = col.array as Float32Array;
        const sel = this.selectedFrames;
        const exc = this.excludedFrames;
        const noSel = sel.size === 0;
        const dim = 0.25;
        for (let i = 0; i < n; i++) {
            const f = this.frameIds[i];
            const j = i * 3;
            if (this.regionMask && this.regionMask[i]) {
                out[j] = REGION.r; out[j + 1] = REGION.g; out[j + 2] = REGION.b;
            } else if (!noSel && sel.has(f)) {
                out[j] = ACCENT.r; out[j + 1] = ACCENT.g; out[j + 2] = ACCENT.b;
            } else if (exc.has(f)) {
                out[j] = this.baseColors[j] * 0.25 + BAD.r * 0.75;
                out[j + 1] = this.baseColors[j + 1] * 0.25 + BAD.g * 0.75;
                out[j + 2] = this.baseColors[j + 2] * 0.25 + BAD.b * 0.75;
            } else {
                const k = noSel ? 1.0 : dim;
                out[j] = this.baseColors[j] * k;
                out[j + 1] = this.baseColors[j + 1] * k;
                out[j + 2] = this.baseColors[j + 2] * k;
            }
        }
        col.needsUpdate = true;
    }

    // ── lasso ──────────────────────────────────────────────────
    private toggleLasso(): void {
        this.lassoing = !this.lassoing;
        const lc = this.el.lasso;
        lc.style.pointerEvents = this.lassoing ? 'auto' : 'none';
        lc.classList.toggle('active', this.lassoing);
        this.d.controls.enabled = !this.lassoing;
        this.el.lassoBtn.classList.toggle('on', this.lassoing);
        if (!this.lassoing) this.clearLassoCanvas();
    }

    private sizeLasso(): void {
        const lc = this.el.lasso;
        lc.width = this.d.canvas.clientWidth * devicePixelRatio;
        lc.height = this.d.canvas.clientHeight * devicePixelRatio;
        lc.style.width = `${this.d.canvas.clientWidth}px`;
        lc.style.height = `${this.d.canvas.clientHeight}px`;
    }

    private onLassoDown(e: PointerEvent): void {
        this.sizeLasso();
        this.lassoPts = [this.evXY(e)];
        this.el.lasso.setPointerCapture(e.pointerId);
    }

    private onLassoMove(e: PointerEvent): void {
        if (this.lassoPts.length === 0) return;
        this.lassoPts.push(this.evXY(e));
        this.drawLasso();
    }

    private onLassoUp(): void {
        if (this.lassoPts.length > 8) this.applyLasso();
        this.lassoPts = [];
        this.clearLassoCanvas();
        this.toggleLasso();
    }

    private evXY(e: PointerEvent): { x: number; y: number } {
        const r = this.el.lasso.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    private drawLasso(): void {
        const lc = this.el.lasso;
        const ctx = lc.getContext('2d')!;
        ctx.clearRect(0, 0, lc.width, lc.height);
        ctx.save();
        ctx.scale(devicePixelRatio, devicePixelRatio);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(this.lassoPts[0].x, this.lassoPts[0].y);
        for (const p of this.lassoPts) ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.restore();
    }

    private clearLassoCanvas(): void {
        const lc = this.el.lasso;
        lc.getContext('2d')?.clearRect(0, 0, lc.width, lc.height);
    }

    private applyLasso(): void {
        const g = this.d.getGeometry();
        if (!g || !this.frameIds) return;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const n = pos.count;
        const w = this.d.canvas.clientWidth;
        const h = this.d.canvas.clientHeight;
        const v = new THREE.Vector3();
        this.regionMask = new Uint8Array(n);
        let inside = 0;
        for (let i = 0; i < n; i++) {
            v.fromBufferAttribute(pos, i).project(this.d.camera);
            if (v.z > 1) continue;
            const sx = (v.x * 0.5 + 0.5) * w;
            const sy = (-v.y * 0.5 + 0.5) * h;
            if (pointInPoly(sx, sy, this.lassoPts)) {
                this.regionMask[i] = 1;
                inside++;
            }
        }
        if (!inside) {
            this.regionMask = null;
            this.d.appendLog('[SEL] Lasso contained no points.');
            return;
        }
        // region → frame contributions
        const counts = new Map<number, number>();
        for (let i = 0; i < n; i++) {
            if (this.regionMask[i]) {
                const f = this.frameIds[i];
                counts.set(f, (counts.get(f) ?? 0) + 1);
            }
        }
        const sorted = [...counts.entries()]
            .filter(([f]) => f !== 65535)
            .sort((a, b) => b[1] - a[1]);
        this.selectedFrames = new Set(sorted.slice(0, 12).map(([f]) => f));
        this.refreshStrip();
        this.applyTints();
        // badges + sort strip by contribution
        for (const [f, c] of sorted) {
            const cell = this.el.strip.children[f] as HTMLElement;
            const badge = cell?.querySelector('.fs-badge') as HTMLElement;
            if (badge) badge.textContent = `${c.toLocaleString()} pts`;
        }
        this.d.appendLog(
            `<span style="color:#f59e0b;">[SEL] Region: ${inside.toLocaleString()} pts from ${sorted.length} frames ` +
            `(top: ${sorted.slice(0, 4).map(([f, c]) => `F${f}·${c}`).join(', ')}).</span>`);
    }

    // ── regenerate (instant, client-side) ──────────────────────
    private regenerateRegion(): void {
        const g = this.d.getGeometry();
        if (!g || !this.frameIds || !this.regionMask) {
            this.toast('Lasso a region first (L)');
            return;
        }
        const t0 = performance.now();
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const col = g.getAttribute('color') as THREE.BufferAttribute;
        const pa = pos.array as Float32Array;
        const ca = col.array as Float32Array;
        const n = pos.count;
        // snapshot for undo
        this.undoPos = new Float32Array(pa);
        this.undoCol = new Float32Array(ca);
        // grid hash over good region verts
        const cell = 2.0;
        const grid = new Map<string, number[]>();
        const bad: number[] = [];
        for (let i = 0; i < n; i++) {
            if (!this.regionMask[i]) continue;
            if (this.excludedFrames.has(this.frameIds[i])) bad.push(i);
            else {
                const k = `${Math.floor(pa[i * 3] / cell)},${Math.floor(pa[i * 3 + 1] / cell)},${Math.floor(pa[i * 3 + 2] / cell)}`;
                (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
            }
        }
        if (!bad.length) {
            this.toast('No excluded frames inside the region (Alt-click frames to exclude)');
            return;
        }
        let replaced = 0;
        const ring = [-1, 0, 1];
        for (const i of bad) {
            const cx = Math.floor(pa[i * 3] / cell);
            const cy = Math.floor(pa[i * 3 + 1] / cell);
            const cz = Math.floor(pa[i * 3 + 2] / cell);
            // nearest good verts: search expanding rings up to 2 cells
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
            // k nearest of the found set
            found.sort((a, b) => dist2(pa, a, i) - dist2(pa, b, i));
            const k = Math.min(4, found.length);
            let sx = 0, sy = 0, sz = 0, sr = 0, sg = 0, sb = 0;
            for (let q = 0; q < k; q++) {
                const j = found[q] * 3;
                sx += pa[j]; sy += pa[j + 1]; sz += pa[j + 2];
                sr += ca[j]; sg += ca[j + 1]; sb += ca[j + 2];
            }
            pa[i * 3] = sx / k; pa[i * 3 + 1] = sy / k; pa[i * 3 + 2] = sz / k;
            if (this.baseColors) {
                ca[i * 3] = sr / k; ca[i * 3 + 1] = sg / k; ca[i * 3 + 2] = sb / k;
                this.baseColors[i * 3] = ca[i * 3];
                this.baseColors[i * 3 + 1] = ca[i * 3 + 1];
                this.baseColors[i * 3 + 2] = ca[i * 3 + 2];
            }
            replaced++;
        }
        pos.needsUpdate = true;
        g.computeBoundingBox();
        g.computeBoundingSphere();
        this.applyTints();
        const ms = performance.now() - t0;
        this.toast(`Region regenerated: ${replaced.toLocaleString()} points replaced from ${this.excludedFrames.size} excluded frames (${ms.toFixed(0)} ms)`);
    }

    private undo(): void {
        const g = this.d.getGeometry();
        if (!g || !this.undoPos || !this.undoCol) return;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const col = g.getAttribute('color') as THREE.BufferAttribute;
        (pos.array as Float32Array).set(this.undoPos);
        (col.array as Float32Array).set(this.undoCol);
        pos.needsUpdate = true;
        col.needsUpdate = true;
        g.computeBoundingSphere();
        if (this.baseColors) this.baseColors = new Float32Array(this.undoCol);
        this.toast('Undo: previous geometry restored');
    }

    private clearAll(): void {
        this.selectedFrames.clear();
        this.regionMask = null;
        this.lassoPts = [];
        this.clearLassoCanvas();
        this.refreshStrip();
        this.applyTints();
        for (const c of Array.from(this.el.strip.children)) {
            (c.querySelector('.fs-badge') as HTMLElement | null)?.replaceChildren();
        }
    }

    /** selected frame range for backend rebuild */
    getFrameRange(): [number, number] | null {
        if (!this.selectedFrames.size) return null;
        const arr = [...this.selectedFrames];
        return [Math.min(...arr), Math.max(...arr)];
    }

    private toast(msg: string): void {
        const t = this.el.toast;
        t.textContent = msg;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3500);
        this.d.appendLog(`<span style="color:#22d3ee;">[SEL] ${msg}</span>`);
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
        if ((yi > y) !== (yj > y) &&
            x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}
