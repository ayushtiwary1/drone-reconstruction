import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

// --- 1. SETUP 3D VIEWPORT ---
const canvas = document.getElementById('canvas3d') as HTMLCanvasElement;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f19);

const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
camera.position.set(0, 50, 100); 

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

const grid = new THREE.GridHelper(200, 200, 0x0284c7, 0x1f2937);
(grid.material as THREE.Material).transparent = true;
(grid.material as THREE.Material).opacity = 0.2;
scene.add(grid);
scene.add(new THREE.AxesHelper(20));

// --- 2. LOAD THE INITIAL POINT CLOUD ---
const logBox = document.getElementById('log-box') as HTMLDivElement;
logBox.innerHTML += `\n[SYS] Loading Point Cloud Data...`;

const loader = new PLYLoader();
loader.load(
    '/recon_output.ply', 
    (geometry) => {
        const material = new THREE.PointsMaterial({ size: 0.15, vertexColors: true });
        const pointCloud = new THREE.Points(geometry, material);
        
        geometry.computeBoundingBox();
        const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
        pointCloud.position.sub(center);
        pointCloud.rotation.x = -Math.PI / 2; 
        
        scene.add(pointCloud);
        logBox.innerHTML += `\n<span style="color:#4ade80;">[SUCCESS] Rendered Initial Points.</span>`;
        logBox.scrollTop = logBox.scrollHeight;
    },
    (xhr) => {
        console.log((xhr.loaded / xhr.total) * 100 + '% loaded');
    },
    (error) => {
        logBox.innerHTML += `\n<span style="color:#ef4444;">[FATAL] Error loading .ply file.</span>`;
        console.error(error);
    }
);

function animate() {
    requestAnimationFrame(animate);
    controls.update(); 
    renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
    const width = canvas.parentElement ? canvas.parentElement.clientWidth : window.innerWidth;
    const height = canvas.parentElement ? canvas.parentElement.clientHeight : window.innerHeight;
    
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

// --- 3. UI CONTROLS & EVENT LISTENERS ---
const runBtn = document.getElementById('runBtn') as HTMLButtonElement;

listen<string>("pipeline-log", (event: any) => {
    logBox.innerHTML += `\n<span style="color:#38bdf8;">${event.payload}</span>`;
    logBox.scrollTop = logBox.scrollHeight;
});

let selectedVideoPath = "";
let selectedCsvPath = "";

const videoInput = document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement;
const csvInput = document.querySelectorAll('input[type="file"]')[1] as HTMLInputElement;

videoInput.addEventListener('click', async (e) => {
    e.preventDefault();
    const selected = await open({ 
        multiple: false, 
        filters: [{ name: 'Video', extensions: ['mp4', 'mov'] }] 
    });
    if (selected && typeof selected === 'string') {
        selectedVideoPath = selected;
        logBox.innerHTML += `\n[SYS] Payload loaded: ${selected}`;
        logBox.scrollTop = logBox.scrollHeight;
    }
});

csvInput.addEventListener('click', async (e) => {
    e.preventDefault();
    const selected = await open({ 
        multiple: false, 
        filters: [{ name: 'Data', extensions: ['csv', 'srt'] }] 
    });
    if (selected && typeof selected === 'string') {
        selectedCsvPath = selected;
        logBox.innerHTML += `\n[SYS] Telemetry loaded: ${selected}`;
        logBox.scrollTop = logBox.scrollHeight;
    }
});

runBtn.addEventListener('click', async () => {
    if (!selectedVideoPath) {
        logBox.innerHTML += `\n<span style="color:#ef4444;">[ERROR] Please select a video payload.</span>`;
        return;
    }

    logBox.innerHTML += `\n[INFO] Connecting to hardware AI...`;

    try {
        await invoke("run_reconstruction", { 
            videoPath: selectedVideoPath, 
            telemetryPath: selectedCsvPath 
        });

        scene.children = scene.children.filter(c => !(c instanceof THREE.Points));

        loader.load('/recon_output.ply?v=' + Date.now(), (geometry) => {
            
            // 1. Scale the geometry
            geometry.scale(1.2, 1.2, 1.2);
            
            // 2. ONLY rotate X to map the backend's 'forward' (PLY Y) to Three.js depth (-Z)
            // Removed the rotateZ and scale(1, -1, 1) that were mangling the stackment
            geometry.rotateX(-Math.PI / 2);
            
            // 3. Center and drop to grid floor
            geometry.computeBoundingBox();
            const bbox = geometry.boundingBox!;
            const offsetX = -(bbox.min.x + bbox.max.x) / 2;
            const offsetZ = -(bbox.min.z + bbox.max.z) / 2;
            const offsetY = -bbox.min.y;
            geometry.translate(offsetX, offsetY, offsetZ);

            const material = new THREE.PointsMaterial({ size: 0.15, vertexColors: true });
            const pointCloud = new THREE.Points(geometry, material);
            
            scene.add(pointCloud);
        });

    } catch (error) {
        logBox.innerHTML += `\n<span style="color:#ef4444;">[FATAL ERROR] ${error}</span>`;
    }
});