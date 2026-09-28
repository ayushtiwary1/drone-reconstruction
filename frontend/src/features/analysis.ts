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

    /** level in scene-Y metres; null clears */
    setFlood(level: number | null): { area: number; isolated: number } | null {
        const g = this.viewer.getGeometry();
        if (!g || !this.prov.frameIds) return null;
        // clear previous
        if (this.waterMesh) {
            this.viewer.scene.remove(this.waterMesh);
            this.waterMesh.geometry.dispose();
            this.waterMesh = null;
        }
        if (level === null) {
            this.prov.applyTints();
            return null;
        }
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const n = pos.count;
        const col = g.getAttribute('color') as THREE.BufferAttribute | undefined;
        const base = g.userData.baseTint as Float32Array | undefined;
        if (!col || !base) return null;
        const ca = col.array as Float32Array;
        // cell size estimate: sqrt(area/n) — from bounding box
        g.computeBoundingBox();
        const size = new THREE.Vector3();
        g.boundingBox!.getSize(size);
        const cellArea = (size.x * size.z) / n;
        let wet = 0;
        // connectivity check for "isolated raised structures": cells above
        // water fully surrounded by water — skip for simplicity, just tint
        for (let i = 0; i < n; i++) {
            if (pos.getY(i) <= level && this.prov.frameIds[i] !== 65535) {
                ca[i * 3] = WATER.r; ca[i * 3 + 1] = WATER.g; ca[i * 3 + 2] = WATER.b;
                wet++;
            } else if (pos.getY(i) <= level) {
                ca[i * 3] = WATER.r * 0.5; ca[i * 3 + 1] = WATER.g * 0.5; ca[i * 3 + 2] = WATER.b * 0.6;
                wet++;
            } else {
                ca[i * 3] = base[i * 3]; ca[i * 3 + 1] = base[i * 3 + 1]; ca[i * 3 + 2] = base[i * 3 + 2];
            }
        }
        col.needsUpdate = true;
        // translucent water plane
        g.computeBoundingBox();
        const bb = g.boundingBox!;
        const water = new THREE.Mesh(
            new THREE.PlaneGeometry(bb.max.x - bb.min.x + 4, bb.max.z - bb.min.z + 4),
            new THREE.MeshBasicMaterial({
                color: 0x2d6fec, transparent: true, opacity: 0.22,
                depthWrite: false, side: THREE.DoubleSide,
            })
        );
        water.rotation.x = -Math.PI / 2;
        water.position.set((bb.max.x + bb.min.x) / 2, level, (bb.max.z + bb.min.z) / 2);
        this.viewer.scene.add(water);
        this.waterMesh = water;
        return { area: wet * cellArea, isolated: 0 };
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
