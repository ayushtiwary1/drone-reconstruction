/**
 * features/analysis.ts — client-side terrain analysis on the loaded mesh.
 *
 * Operates on the actual vertex buffers: hide-unobserved (face-drop),
 * vertical exaggeration, flood fill level, landing-zone finder,
 * viewshed ("dead ground"), and polygon area/volume measurement.
 * Everything is labelled "estimated" — heights are depth-model relative.
 */
import * as THREE from 'three';
import type { Viewer } from '../viewer/Viewer.ts';
import type { Provenance } from './provenance.ts';

const WATER = new THREE.Color(0x2d6fec);
const LZ = new THREE.Color(0x4ea84e);
const DEAD = new THREE.Color(0xd4504a);

export class Analysis {
    viewer: Viewer;
    prov: Provenance;
    private origIndex: THREE.BufferAttribute | null = null;
    private exagApplied = 1;
    private waterMesh: THREE.Mesh | null = null;
    private floodOriginal: Float32Array | null = null;
    private floodGeometry: THREE.BufferGeometry | null = null;
    onLog: ((m: string) => void) | null = null;

    constructor(viewer: Viewer, prov: Provenance) {
        this.viewer = viewer;
        this.prov = prov;
    }

    /* ── hide unobserved (T7) ─────────────────────────────── */

    setUnobservedHidden(hide: boolean): void {
        const g = this.viewer.getGeometry();
        if (!g || !this.prov.frameIds) return;
        const idx = g.getIndex();
        if (!idx) return;
        if (!this.origIndex) this.origIndex = idx.clone();
        if (!hide) {
            g.setIndex(this.origIndex.clone());
            this.viewer.renderModel();
            return;
        }
        const n = idx.count;
        const keep = new Uint32Array(n);
        let m = 0;
        const ids = this.prov.frameIds;
        const ia = idx.array;
        for (let t = 0; t < n; t += 3) {
            const a = ia[t], b = ia[t + 1], c = ia[t + 2];
            // drop faces where all verts are unobserved
            if (ids[a] !== 65535 || ids[b] !== 65535 || ids[c] !== 65535) {
                keep[m++] = a; keep[m++] = b; keep[m++] = c;
            }
        }
        g.setIndex(new THREE.BufferAttribute(keep.slice(0, m), 1));
        this.viewer.renderModel();
    }

    /* ── relief exaggeration (T14) ────────────────────────── */

    setExaggeration(k: number): void {
        const g = this.viewer.getGeometry();
        if (!g) return;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const pa = pos.array as Float32Array;
        const prev = this.exagApplied;
        if (k === prev) return;
        // scale Y around minimum, restoring the previous scale first
        let minY = Infinity;
        for (let i = 1; i < pa.length; i += 3) if (pa[i] < minY) minY = pa[i];
        const f = k / prev;
        for (let i = 1; i < pa.length; i += 3) pa[i] = minY + (pa[i] - minY) * f;
        pos.needsUpdate = true;
        g.computeBoundingBox();
        g.computeBoundingSphere();
        this.exagApplied = k;
    }

    /* ── flood simulation (T11) ───────────────────────────── */

    heightRange(): { min: number; p1: number; p10: number; p99: number; max: number } | null {
        const g = this.viewer.getGeometry();
        const ids = this.prov.frameIds;
        if (!g || !ids) return null;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const heights: number[] = [];
        for (let i = 0; i < pos.count; i++) {
            if (ids[i] !== 65535) heights.push(pos.getY(i));
        }
        if (!heights.length) return null;
        heights.sort((a, b) => a - b);
        const at = (p: number) => heights[Math.floor((heights.length - 1) * p)];
        return { min: heights[0], p1: at(0.01), p10: at(0.1), p99: at(0.99), max: heights[heights.length - 1] };
    }

    resetFlood(): void {
        if (this.waterMesh) {
            this.viewer.scene.remove(this.waterMesh);
            this.waterMesh.geometry.dispose();
            (this.waterMesh.material as THREE.Material).dispose();
            this.waterMesh = null;
        }
        this.floodOriginal = null;
        this.floodGeometry = null;
    }

    /** level in scene-Y metres; null restores the exact original colour buffer */
    setFlood(level: number | null): { area: number; volume: number; maxDepth: number; wetPct: number } | null {
        const g = this.viewer.getGeometry();
        if (!g || !this.prov.frameIds) return null;
        const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
        if (!col || !(col.array instanceof Float32Array)) return null;
        const ca = col.array;
        if (level === null) {
            if (this.floodOriginal && this.floodGeometry === g && ca.length === this.floodOriginal.length) {
                ca.set(this.floodOriginal);
                col.needsUpdate = true;
            }
            this.resetFlood();
            return null;
        }
        if (this.floodGeometry !== g || !this.floodOriginal) {
            this.floodOriginal = new Float32Array(ca);
            this.floodGeometry = g;
        }
        const base = this.floodOriginal;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const n = pos.count;
        g.computeBoundingBox();
        const bb = g.boundingBox!;
        const dx = bb.max.x - bb.min.x;
        const dz = bb.max.z - bb.min.z;
        const cellSize = Math.sqrt((dx * dz) / n);
        const cellArea = cellSize * cellSize;
        const cells = new Map<string, { sum: number; count: number }>();
        let wet = 0, maxDepth = 0;
        for (let i = 0; i < n; i++) {
            const j = i * 3;
            const depth = level - pos.getY(i);
            if (depth > 0 && this.prov.frameIds[i] !== 65535) {
                const blend = 0.35 + 0.5 * Math.min(depth / 2, 1);
                ca[j] = base[j] * (1 - blend) + WATER.r * blend;
                ca[j + 1] = base[j + 1] * (1 - blend) + WATER.g * blend;
                ca[j + 2] = base[j + 2] * (1 - blend) + WATER.b * blend;
                const key = `${Math.floor((pos.getX(i) - bb.min.x) / cellSize)},${Math.floor((pos.getZ(i) - bb.min.z) / cellSize)}`;
                const cell = cells.get(key) ?? { sum: 0, count: 0 };
                cell.sum += depth;
                cell.count++;
                cells.set(key, cell);
                maxDepth = Math.max(maxDepth, depth);
                wet++;
            } else {
                ca[j] = base[j]; ca[j + 1] = base[j + 1]; ca[j + 2] = base[j + 2];
            }
        }
        col.needsUpdate = true;
        if (this.waterMesh) {
            this.viewer.scene.remove(this.waterMesh);
            this.waterMesh.geometry.dispose();
            (this.waterMesh.material as THREE.Material).dispose();
        }
        this.waterMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(dx, dz),
            new THREE.MeshBasicMaterial({ color: WATER, transparent: true, opacity: 0.4,
                depthWrite: false, side: THREE.DoubleSide })
        );
        this.waterMesh.rotation.x = -Math.PI / 2;
        this.waterMesh.position.set((bb.min.x + bb.max.x) / 2, level, (bb.min.z + bb.max.z) / 2);
        this.viewer.scene.add(this.waterMesh);
        let volume = 0;
        for (const cell of cells.values()) volume += (cell.sum / cell.count) * cellArea;
        return { area: cells.size * cellArea, volume, maxDepth, wetPct: wet * 100 / n };
    }

    /* ── landing zones (T12) ──────────────────────────────── */

    /** Grid the heightmap, find flat patches ≥ minSide m, slope < maxDeg. */
    findLandingZones(minSide = 25, maxSlopeDeg = 7): { x: number; z: number; side: number; slopeDeg: number; conf: number }[] {
        const g = this.viewer.getGeometry();
        if (!g || !this.prov.frameIds) return [];
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const n = pos.count;
        const cell = 2.0;
        interface Bin { s: number; c: number; min: number; max: number; conf: number }
        const bins = new Map<string, Bin>();
        let minX = Infinity, minZ = Infinity;
        for (let i = 0; i < n; i++) {
            if (this.prov.frameIds[i] === 65535) continue;
            const x = pos.getX(i), z = pos.getZ(i);
            if (x < minX) minX = x;
            if (z < minZ) minZ = z;
            const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
            const b = bins.get(k) ?? { s: 0, c: 0, min: Infinity, max: -Infinity, conf: 0 };
            const y = pos.getY(i);
            b.s += y; b.c++;
            if (y < b.min) b.min = y;
            if (y > b.max) b.max = y;
            b.conf += this.prov.confidence ? this.prov.confidence[i] : 0.5;
            bins.set(k, b);
        }
        const half = Math.floor(minSide / cell / 2);
        const tanMax = Math.tan((maxSlopeDeg * Math.PI) / 180);
        const out: { x: number; z: number; side: number; slopeDeg: number; conf: number }[] = [];
        for (const [k, b] of bins) {
            const [bx, bz] = k.split(',').map(Number);
            const h = b.s / b.c;
            let ok = true;
            let maxGrad = 0;
            let minConf = 1;
            outer: for (let dx = -half; dx <= half && ok; dx++) {
                for (let dz = -half; dz <= half && ok; dz++) {
                    const nb = bins.get(`${bx + dx},${bz + dz}`);
                    if (!nb || nb.c < 3) { ok = false; break outer; }
                    const nh = nb.s / nb.c;
                    const grad = Math.abs(nh - h) / (Math.abs(dx) * cell + Math.abs(dz) * cell + 1e-6);
                    if (grad > maxGrad) maxGrad = grad;
                    minConf = Math.min(minConf, nb.conf / nb.c);
                    const rough = nb.max - nb.min;
                    if (rough > 1.5) { ok = false; break outer; }
                }
            }
            if (ok && maxGrad <= tanMax && minConf > 0.25) {
                out.push({
                    x: (bx + 0.5) * cell, z: (bz + 0.5) * cell,
                    side: minSide, slopeDeg: Math.atan(maxGrad) * 180 / Math.PI,
                    conf: minConf,
                });
            }
        }
        // dedupe — keep best per ~patch neighbourhood
        out.sort((a, b) => a.slopeDeg - b.slopeDeg);
        const chosen: typeof out = [];
        for (const c of out) {
            if (chosen.every((o) => Math.hypot(o.x - c.x, o.z - c.z) > minSide)) chosen.push(c);
        }
        // tint chosen patches
        if (chosen.length) {
            const col = g.getAttribute('color') as THREE.BufferAttribute;
            const base = g.userData.baseTint as Float32Array | undefined;
            const ca = col.array as Float32Array;
            for (let i = 0; i < n; i++) {
                const x = pos.getX(i), z = pos.getZ(i);
                for (const p of chosen) {
                    if (Math.abs(x - p.x) < minSide / 2 && Math.abs(z - p.z) < minSide / 2) {
                        ca[i * 3] = LZ.r; ca[i * 3 + 1] = LZ.g; ca[i * 3 + 2] = LZ.b;
                        break;
                    } else if (base) {
                        // untouched
                    }
                }
            }
            col.needsUpdate = true;
        }
        return chosen;
    }

    /* ── viewshed (T13) ───────────────────────────────────── */

    /** Observer at (x,z)+hOffset; tint unreachable cells red. */
    viewshed(obs: THREE.Vector3, hOffset = 2): { visible: number; dead: number } | null {
        const g = this.viewer.getGeometry();
        if (!g) return null;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const n = pos.count;
        const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
        const base = g.userData.baseTint as Float32Array | undefined;
        if (!col || !base) return null;
        // heightmap grid (cell 1.5m) — mean height per bin
        const cell = 1.5;
        const bins = new Map<string, { s: number; c: number }>();
        for (let i = 0; i < n; i++) {
            const k = `${Math.floor(pos.getX(i) / cell)},${Math.floor(pos.getZ(i) / cell)}`;
            const b = bins.get(k) ?? { s: 0, c: 0 };
            b.s += pos.getY(i); b.c++;
            bins.set(k, b);
        }
        const hAt = (x: number, z: number): number | null => {
            const b = bins.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`);
            return b ? b.s / b.c : null;
        };
        const oy = obs.y + hOffset;
        const ca = col.array as Float32Array;
        let vis = 0, dead = 0;
        for (let i = 0; i < n; i++) {
            const x = pos.getX(i), z = pos.getZ(i), y = pos.getY(i);
            const dx = x - obs.x, dz = z - obs.z;
            const d = Math.hypot(dx, dz);
            if (d < cell) { vis++; continue; }
            const steps = Math.min(200, Math.floor(d / cell));
            let blocked = false;
            for (let s = 1; s < steps; s++) {
                const sx = obs.x + (dx * s) / steps;
                const sz = obs.z + (dz * s) / steps;
                const sh = hAt(sx, sz);
                if (sh === null) continue;
                const sy = oy + ((y - oy) * s) / steps;
                if (sh > sy + 0.3) { blocked = true; break; }
            }
            if (blocked) {
                ca[i * 3] = DEAD.r; ca[i * 3 + 1] = DEAD.g; ca[i * 3 + 2] = DEAD.b;
                dead++;
            } else {
                ca[i * 3] = base[i * 3]; ca[i * 3 + 1] = base[i * 3 + 1]; ca[i * 3 + 2] = base[i * 3 + 2];
                vis++;
            }
        }
        col.needsUpdate = true;
        // observer marker
        const marker = new THREE.Mesh(
            new THREE.SphereGeometry(Math.max(0.5, g.boundingSphere!.radius * 0.008), 12, 10),
            new THREE.MeshBasicMaterial({ color: 0xffe08a })
        );
        marker.position.copy(obs).setY(oy);
        this.viewer.scene.add(marker);
        window.setTimeout(() => this.viewer.scene.remove(marker), 12000);
        return { visible: vis, dead };
    }

    /* ── area + volume for the region mask (T8) ───────────── */

    /** Region (lasso/box mask) → area + cut/fill volume vs base plane. */
    regionMeasure(): { area: number; volume: number; conf: number; baseY: number } | null {
        const g = this.viewer.getGeometry();
        const mask = this.prov.regionMask;
        if (!g || !mask) return null;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const n = pos.count;
        g.computeBoundingBox();
        const size = new THREE.Vector3();
        g.boundingBox!.getSize(size);
        const cellA = (size.x * size.z) / n;
        const ys: number[] = [];
        let confSum = 0;
        for (let i = 0; i < n; i++) {
            if (mask[i]) {
                ys.push(pos.getY(i));
                confSum += this.prov.confidence ? this.prov.confidence[i] : 0.5;
            }
        }
        if (!ys.length) return null;
        const cnt = ys.length;
        ys.sort((a, b) => a - b);
        const base = ys[Math.floor(ys.length * 0.1)] ?? 0;
        let vol = 0;
        for (const y of ys) vol += Math.max(0, y - base) * cellA;
        return { area: cnt * cellA, volume: vol, conf: confSum / cnt, baseY: base };
    }

    /** polygon given as world-space (x,z) ring — area + volume vs base */
    polygonMeasure(pts: { x: number; z: number }[]): { area: number; volume: number; conf: number } | null {
        const g = this.viewer.getGeometry();
        if (!g || pts.length < 3) return null;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const n = pos.count;
        // shoelace
        let area = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            area += (pts[j].x + pts[i].x) * (pts[j].z - pts[i].z);
        }
        area = Math.abs(area / 2);
        // collect verts inside
        const ys: number[] = [];
        let confSum = 0;
        let cnt = 0;
        for (let i = 0; i < n; i++) {
            if (pointInPoly2(pos.getX(i), pos.getZ(i), pts)) {
                ys.push(pos.getY(i));
                confSum += this.prov.confidence ? this.prov.confidence[i] : 0.5;
                cnt++;
            }
        }
        if (!cnt) return { area, volume: 0, conf: 0 };
        // base plane = lowest decile height inside polygon
        ys.sort((a, b) => a - b);
        const base = ys[Math.floor(ys.length * 0.1)] ?? 0;
        let vol = 0;
        const cellA = area / cnt;
        for (const y of ys) vol += Math.max(0, y - base) * cellA;
        return { area, volume: vol, conf: confSum / cnt };
    }
}

function pointInPoly2(x: number, z: number, poly: { x: number; z: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, zi = poly[i].z;
        const xj = poly[j].x, zj = poly[j].z;
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}
