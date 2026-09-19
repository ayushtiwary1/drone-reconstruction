/**
 * Tactical 3D Reconstruction Engine — Frontend
 *
 * Coordinate contract: Rust outputs Right-Handed world space:
 *   +X = East / Right
 *   +Y = Up   / Elevation
 *   −Z = North / Forward
 * PLY is loaded at position(0,0,0) rotation(0,0,0) — NO compensatory rotations.
 */

import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { invoke } from '@tauri-apps/api/core';
import { listen, type Event } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

// ─────────────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────────────

/**
 * Must match HardwareProfile enum variants in lib.rs (serde snake_case).
 */
type HardwareProfile = 'edge_fast' | 'balanced' | 'high_accuracy';

// ─────────────────────────────────────────────────────────────
// DOM References
// ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('canvas3d') as HTMLCanvasElement;
const logBox = document.getElementById('log-box') as HTMLDivElement;
const runBtn = document.getElementById('runBtn') as HTMLButtonElement;
const profileSelect = document.getElementById('profileSelect') as HTMLSelectElement;
const cameraAngleSelect = document.getElementById('cameraAngleSelect') as HTMLSelectElement | null;
const viewModeSelect = document.getElementById('viewModeSelect') as HTMLSelectElement | null;
const videoFileBtn = document.getElementById('videoFile') as HTMLInputElement;
const telemetryFileBtn = document.getElementById('telemetryFile') as HTMLInputElement;
const progressBar = document.getElementById('recon-progress') as HTMLProgressElement;
const pointSizeSlider = document.getElementById('pointSizeSlider') as HTMLInputElement | null;
const pointSizeVal = document.getElementById('pointSizeVal') as HTMLSpanElement | null;
let currentPointSize = 2.0;
let currentGeometry: THREE.BufferGeometry | null = null;

if (pointSizeSlider) {
    pointSizeSlider.addEventListener('input', () => {
        currentPointSize = parseFloat(pointSizeSlider.value);
        if (pointSizeVal) {
            pointSizeVal.textContent = `${currentPointSize.toFixed(1)}px`;
        }
        scene.traverse((child) => {
            if (child instanceof THREE.Points && child.material instanceof THREE.PointsMaterial) {
                child.material.size = currentPointSize;
                child.material.needsUpdate = true;
            }
        });
    });
}

// ─────────────────────────────────────────────────────────────
// 3D Viewport — Three.js Scene
// ─────────────────────────────────────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f19);

const camera = new THREE.PerspectiveCamera(
    60,
    canvas.clientWidth / canvas.clientHeight,
    0.1,
    10_000
);
camera.position.set(0, 80, 150);

/**
 * Explicitly request the discrete high-performance GPU (RTX 2050).
 * WebView2 defaults to the integrated AMD iGPU without this hint.
 */
const renderer = new THREE.WebGLRenderer({
    canvas,
    powerPreference: 'high-performance',
    antialias: true,
});
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 1;
controls.maxDistance = 5_000;

// Reference grid
const grid = new THREE.GridHelper(500, 100, 0x0284c7, 0x1f2937);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.15;
scene.add(grid);

// Detect and log active GPU for WebGL viewport
const gl = renderer.getContext();
const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
if (debugInfo) {
    const glRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
    console.log('[GPU] Active WebGL Renderer:', glRenderer);
}

// ─────────────────────────────────────────────────────────────
// Animation Loop
// ─────────────────────────────────────────────────────────────

function animate(): void {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}
animate();

// ─────────────────────────────────────────────────────────────
// Resize Handler
// ─────────────────────────────────────────────────────────────

window.addEventListener('resize', () => {
    const parent = canvas.parentElement;
    const w = parent ? parent.clientWidth : window.innerWidth;
    const h = parent ? parent.clientHeight : window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function appendLog(html: string): void {
    logBox.innerHTML += `\n${html}`;
    logBox.scrollTop = logBox.scrollHeight;
}

/**
 * Dispose all Three.Points and Three.Mesh objects currently in the scene to prevent
 * WebGL memory leaks before loading a new model.
 */
function disposePointClouds(): void {
    const toRemove = scene.children.filter(
        (c): c is THREE.Points | THREE.Mesh => c instanceof THREE.Points || c instanceof THREE.Mesh
    );
    for (const p of toRemove) {
        p.geometry.dispose();
        if (Array.isArray(p.material)) {
            p.material.forEach((m) => m.dispose());
        } else {
            (p.material as THREE.Material).dispose();
        }
        scene.remove(p);
    }
}

function renderGeometry(geometry: THREE.BufferGeometry): void {
    disposePointClouds();

    const isMesh = Boolean(geometry.index && viewModeSelect?.value === 'mesh');
    if (isMesh) {
        const material = new THREE.MeshBasicMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
    } else {
        const material = new THREE.PointsMaterial({
            size: currentPointSize,
            vertexColors: true,
            sizeAttenuation: false,
        });
        const pointCloud = new THREE.Points(geometry, material);
        scene.add(pointCloud);
    }
}

if (viewModeSelect) {
    viewModeSelect.addEventListener('change', () => {
        if (currentGeometry) {
            renderGeometry(currentGeometry);
        }
    });
}

/**
 * Load a PLY point cloud / mesh, centre it on the grid floor, and auto-fit the camera.
 * Rust outputs standard world coordinates — no rotations applied here.
 */
function loadPointCloud(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const loader = new PLYLoader();
        loader.load(
            url,
            (geometry) => {
                geometry.computeBoundingBox();
                const bbox = geometry.boundingBox!;
                const center = new THREE.Vector3();
                bbox.getCenter(center);

                // Translate so bounding box centre is at world origin (XZ),
                // with the minimum Y resting on the grid plane (Y=0).
                geometry.translate(-center.x, -bbox.min.y, -center.z);
                currentGeometry = geometry;

                renderGeometry(geometry);

                // Auto-fit camera to the extents of the loaded cloud
                geometry.computeBoundingBox();
                const newBbox = geometry.boundingBox!;
                const size = new THREE.Vector3();
                newBbox.getSize(size);
                const maxDim = Math.max(size.x, size.z, 20);
                camera.position.set(0, maxDim * 0.7, maxDim * 1.0);
                camera.near = 0.1;
                camera.far = 10_000;
                camera.updateProjectionMatrix();
                controls.target.set(0, size.y * 0.2, 0);
                controls.update();

                const count = geometry.attributes['position'].count.toLocaleString('en-US');
                const hasFaces = Boolean(geometry.index);
                appendLog(
                    `<span style="color:#4ade80;">[SUCCESS] ✓ Rendered ${count} ${hasFaces ? 'fused surface elements (Mesh)' : 'fused voxels (Points)'}.</span>`
                );
                progressBar.value = 100;
                resolve();
            },
            (_xhr) => {
                // Progress intentionally omitted — PLY is served locally
            },
            (error) => {
                appendLog('<span style="color:#ef4444;">[FATAL] PLY load error. Check browser console.</span>');
                console.error('[PLYLoader]', error);
                reject(error);
            }
        );
    });
}

// ─────────────────────────────────────────────────────────────
appendLog('[SYS] Viewport initialised. Standing by for payload...');
if (debugInfo) {
    const glRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
    appendLog(`<span style="color:#a78bfa;">[GPU] Viewport WebGL: ${glRenderer}</span>`);
}
appendLog('[SYS] Ready. Select video and telemetry, then click START RECONSTRUCTION.');

// ─────────────────────────────────────────────────────────────
// Backend Event Listener
// ─────────────────────────────────────────────────────────────

let frameTotal = 0;
let framesDone = 0;

listen<string>('pipeline-log', (event: Event<string>) => {
    const msg: string = event.payload;

    // Parse frame-count from FFMPEG extraction message to drive progress bar
    const extractMatch = msg.match(/\[FFMPEG\]\s+(\d+)\s+frames extracted/);
    if (extractMatch) {
        frameTotal = parseInt(extractMatch[1], 10);
        framesDone = 0;
        progressBar.max = frameTotal;
        progressBar.value = 0;
    }

    // Advance progress bar on each processed frame
    const frameMatch = msg.match(/\[FRAME\s+(\d+)\/(\d+)\]/);
    if (frameMatch) {
        framesDone = parseInt(frameMatch[1], 10);
        frameTotal = parseInt(frameMatch[2], 10);
        progressBar.max = frameTotal;
        progressBar.value = framesDone;
    }

    // Colour-code log severity prefixes
    let coloured: string;
    if (msg.includes('[SUCCESS]') || msg.includes('✓')) {
        coloured = `<span style="color:#4ade80;">${msg}</span>`;
    } else if (msg.includes('[WARN]') || msg.includes('✗')) {
        coloured = `<span style="color:#fb923c;">${msg}</span>`;
    } else if (msg.includes('[FATAL]') || msg.includes('CUDA EP failed')) {
        coloured = `<span style="color:#ef4444;">${msg}</span>`;
    } else if (msg.includes('[GPU]')) {
        coloured = `<span style="color:#a78bfa;">${msg}</span>`;
    } else {
        coloured = `<span style="color:#38bdf8;">${msg}</span>`;
    }
    appendLog(coloured);
}).catch(console.error);

// ─────────────────────────────────────────────────────────────
// File Picker — Video Payload
// ─────────────────────────────────────────────────────────────

let selectedVideoPath = '';
let selectedCsvPath = '';

videoFileBtn.addEventListener('click', async (e: MouseEvent) => {
    e.preventDefault();
    const selected = await open({
        multiple: false,
        filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv'] }],
    });
    if (selected && typeof selected === 'string') {
        selectedVideoPath = selected;
        appendLog(`[SYS] Video payload: <em>${selected.split(/[\\/]/).pop()}</em>`);
    }
});

// ─────────────────────────────────────────────────────────────
// File Picker — Telemetry CSV
// ─────────────────────────────────────────────────────────────

telemetryFileBtn.addEventListener('click', async (e: MouseEvent) => {
    e.preventDefault();
    const selected = await open({
        multiple: false,
        filters: [{ name: 'Telemetry', extensions: ['csv', 'srt', 'txt'] }],
    });
    if (selected && typeof selected === 'string') {
        selectedCsvPath = selected;
        appendLog(`[SYS] Telemetry: <em>${selected.split(/[\\/]/).pop()}</em>`);
    }
});

// ─────────────────────────────────────────────────────────────
// Reconstruction — Run Button
// ─────────────────────────────────────────────────────────────

runBtn.addEventListener('click', async () => {
    if (!selectedVideoPath) {
        appendLog('<span style="color:#ef4444;">[ERROR] Select a video payload before starting.</span>');
        return;
    }

    const profile = profileSelect.value as HardwareProfile;
    runBtn.disabled = true;
    progressBar.value = 0;
    progressBar.max = 100;

    appendLog(`[INFO] Starting reconstruction — profile: <strong>${profile}</strong>`);

    try {
        const cameraPitch = cameraAngleSelect ? parseFloat(cameraAngleSelect.value) : -45.0;
        await invoke<string>('run_reconstruction', {
            videoPath: selectedVideoPath,
            telemetryPath: selectedCsvPath,
            hardwareProfile: profile,         // ← wired to Rust HardwareProfile enum
            cameraPitchDeg: cameraPitch,
        });

        // Bust cache so Vite serves the freshly written PLY
        await loadPointCloud(`/recon_output.ply?v=${Date.now()}`);
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(`<span style="color:#ef4444;">[FATAL] ${msg}</span>`);
        progressBar.value = 0;
    } finally {
        runBtn.disabled = false;
    }
});