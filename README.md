# Tactical 3D Recon Engine

> **High-Performance, Air-Gapped, Single-Pass UAV Video-to-3D Reconstruction System**  
> Converts standard monocular drone footage and telemetry into metric-accurate, photorealistic 3D point clouds and textured meshes in real time.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Neural Depth Estimation Engine](#3-neural-depth-estimation-engine)
4. [Telemetry Ingestion & Kinematic Smoothing](#4-telemetry-ingestion--kinematic-smoothing)
5. [Mathematical Formulation & Geometric Projection](#5-mathematical-formulation--geometric-projection)
6. [Spatial Fusion, Filtering & Mesh Triangulation](#6-spatial-fusion-filtering--mesh-triangulation)
7. [Hardware Acceleration & 4GB VRAM Discipline](#7-hardware-acceleration--4gb-vram-discipline)
8. [Multi-Format Deliverables & Geospatial Export](#8-multi-format-deliverables--geospatial-export)
9. [Frontend Visualization & Control Interface](#9-frontend-visualization--control-interface)
10. [Repository Structure](#10-repository-structure)
11. [Prerequisites & Build Instructions](#11-prerequisites--build-instructions)
12. [Verification & Automated Test Suite](#12-verification--automated-test-suite)

---

## 1. Executive Summary

The **Tactical 3D Recon Engine** is an offline, standalone application engineered to reconstruct dense 3D terrain and structural surfaces from a **single pass** of monocular aerial video accompanied by flight telemetry (DJI SRT subtitles or CSV flight logs).

### Key Differentiators

- **Zero Cloud Dependency**: 100% air-gapped runtime. No external APIs, CDNs, telemetry callbacks, or remote fonts.
- **Single-Pass Photogrammetry**: Unlike conventional Structure-from-Motion (SfM) pipelines (e.g., COLMAP) that require overlapping multi-pass flight paths, feature track matching across hundreds of images, and hours of bundle adjustment, this engine reconstructs dense metric 3D surfaces in **under 60 seconds** for an 88-second 1080p video.
- **Hardware-Aware Engineering**: Engineered specifically for mobile workstations equipped with 4GB dedicated GPUs (e.g., NVIDIA GeForce RTX 2050 Mobile), strictly bypassing the integrated GPU (Intel/AMD iGPU) while maintaining peak VRAM under 3.5 GB.
- **Unified Dual Engine**: A high-concurrency Rust backend (Tauri v2) paired with a responsive TypeScript/Three.js WebGL viewport.

---

## 2. System Architecture

The system operates as two decoupled layers communicating over asynchronous IPC:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TAURI RUST BACKEND                                  │
│                                                                             │
│  Video (.mp4) ──► FFmpeg Subprocess ──► 1-fps JPEGs (Letterboxed 16:9)      │
│                         │                                                   │
│  Telemetry    ──► parse_dji_srt() ──► Centred Moving Average (±2s)          │
│  (.srt/.csv)            │              Bearing & AGL Derivation             │
│                         ▼                                                   │
│               Depth-Anything-V2 ViT-S (ONNX Runtime CUDA EP)                │
│                         │                                                   │
│                         ▼ Per-Pixel Ray-Plane Back-Projection                │
│               Camera Pose (Yaw, Pitch, Roll=0) + AGL Invariance             │
│                         │                                                   │
│                         ▼                                                   │
│               Spatial Fusion Grid (Distance-Weighted HashMap)               │
│                         │                                                   │
│                         ▼                                                   │
│               3x3 Median + 3*MAD Outlier Filter & Hole Filling              │
│                         │                                                   │
│                         ▼                                                   │
│               Grid Triangulation (Indexed Mesh Generation)                  │
│                         │                                                   │
│          ┌──────────────┼──────────────┬──────────────┬──────────────┐      │
│          ▼              ▼              ▼              ▼              ▼      │
│     Binary PLY      Wavefront      ASPRS LAS      glTF 2.0       WGS-84     │
│    (with faces)        OBJ            1.2           (GLB)        GeoRef     │
└──────────┬──────────────────────────────────────────────────────────────────┘
           │ IPC Event Stream ("pipeline-log") & Binary Model Delivery
┌──────────▼──────────────────────────────────────────────────────────────────┐
│                     FRONTEND (TypeScript + Three.js)                         │
│                                                                             │
│  • Edge Chromium WebView2 forced to Discrete High-Performance GPU           │
│  • OrbitControls 3D Viewport with Grid Floor & Auto-Fit Bounding Box        │
│  • Real-Time Points / Textured Mesh View Toggle                             │
│  • Precision Point Size Attenuation Slider (1.0px - 4.0px)                  │
│  • Direct Local File Download (PLY, OBJ, LAS, GLB)                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Neural Depth Estimation Engine

### 3.1 Model Selection: Depth Anything V2 (ViT-S)

The pipeline utilizes **Depth Anything V2 (Vision Transformer Small)** bundled as a 99 MB ONNX model (`models/depth_anything_v2_vits.onnx`).

#### Why Depth Anything V2 Over Classical SfM or MiDaS?

1. **Monocular Boundary Precision**: Classical monocular depth models (such as MiDaS v2.1/v3.1) produce rounded, blurry depth maps around vegetation, building edges, and powerlines, causing "floating point halos" in 3D. Depth Anything V2 is trained on synthetic and large-scale pseudo-labeled datasets, producing razor-sharp depth boundaries.
2. **Dense Geometry from Textureless Regions**: Classical feature-matching SfM fails on homogeneous terrain (roads, bodies of water, uniform grass). Depth Anything V2 infers relative depth from semantic context and perspective cues across every pixel.
3. **Execution Efficiency**: The ViT-S variant balances high spatial resolution with minimal latency, completing an inference pass in ~25 ms on an RTX 2050 (compared to >150 ms for ViT-L or Depth Anything Large).

### 3.2 Tensor Normalization & Resolution Handling

- **Color Normalization**: Frames are converted to RGB planar CHW tensors and normalized using ImageNet statistics:
  $$\hat{I}_c(x, y) = \frac{I_c(x, y) / 255.0 - \mu_c}{\sigma_c}$$
  where $\mu = [0.485, 0.456, 0.406]$ and $\sigma = [0.229, 0.224, 0.225]$.
- **Dynamic 16:9 Resolution Support**:
  - The model input resolution is queried at runtime. If dynamic axes are supported, the engine feeds tensors at $756 \times 420$ (both dimensions exact multiples of the 14-pixel ViT patch size), preserving 16:9 drone aspect ratios natively.
  - If fixed $518 \times 518$ input is enforced, the engine performs **aspect-ratio preserving letterboxing**: 16:9 images are resized to $518 \times 291$ and placed on a 518-square canvas with 113 px top and 114 px bottom padding. During 3D back-projection, pad rows are strictly skipped to prevent edge distortion.

---

## 4. Telemetry Ingestion & Kinematic Smoothing

### 4.1 DJI SRT Subtitle Parser (`parse_dji_srt`)

Modern drone footage records per-frame metadata inside SubRip (`.SRT`) subtitle streams. The custom, zero-dependency parser extracts:

```text
1
00:00:00,033 --> 00:00:00,066
<font size="36">SrtCnt : 1, DiffTime : 33ms
2023-01-21 15:08:55,429,228
[iso : 100] [shutter : 1/2000.0] [fnum : 280] [ev : 0] [ct : 5067] [color_md : default] [focal_len : 224] [latitude: 0.394028] [longitude: 36.883816] [altitude: 15.600000] 
</font>
```

- **Timestamp Parsing**: Line `HH:MM:SS,mmm --> ` is converted into floating-point seconds:
  $$t_{\text{sec}} = 3600 \cdot H + 60 \cdot M + S + \frac{ms}{1000}$$
- **Bracket Tokenizer**: Extracts `latitude`, `longitude`, `altitude`, and `focal_len` without requiring regex crates.
- **Focal Length Extraction**: `focal_len: 224` corresponds to a $22.4\text{ mm}$ 35mm-equivalent lens, from which camera field of view is calibrated.

### 4.2 CSV Telemetry Parser (`parse_telemetry_csv`)

For telemetry logged by ArduPilot, PX4, or custom ground stations, a fuzzy header matcher cleans column names:
$$\text{clean\_header}(h) = \text{lowercase}(\text{alphanumeric}(h))$$
It resolves variations like `lat`, `latitude`, `gps_lat`, `height_agl`, `relative_alt`, `yaw`, and `gimbal_pitch`.

### 4.3 Kinematic Smoothing & Heading Estimation (`smooth_trajectory`)

1. **Centred Moving Average Filter**: Raw GPS readings exhibit barometric and multi-path satellite jitter. Each point at time $t$ is averaged over a $\pm 2.0\text{ s}$ temporal window:
   $$\bar{p}_i = \frac{1}{|J_i|} \sum_{j \in J_i} p_j, \quad J_i = \{j \mid |t_j - t_i| \le 2.0\text{ s}\}$$
2. **Missing Heading (Yaw) Calculation**: When telemetry lacks compass or IMU yaw (standard in DJI consumer SRTs), heading is derived from the smoothed ground-track trajectory:
   $$\Delta x = (\text{lon}_2 - \text{lon}_1) \cdot \frac{\pi}{180} \cdot R_{\text{earth}} \cdot \cos(\text{lat}_1)$$
   $$\Delta z = (\text{lat}_2 - \text{lat}_1) \cdot \frac{\pi}{180} \cdot R_{\text{earth}}$$
   $$\text{speed} = \frac{\sqrt{\Delta x^2 + \Delta z^2}}{\Delta t}$$
   - If $\text{speed} \ge 0.3\text{ m/s}$: $\psi = \text{atan2}(\Delta x, \Delta z)$ (clockwise from true North).
   - If $\text{speed} < 0.3\text{ m/s}$ (hover): the system holds the previous heading, preventing erratic rotation noise.
3. **Altitude-Above-Ground-Level (AGL)**: Raw altitude is clamped to safe physical limits:
   $$h_{\text{AGL}} = \text{clamp}(\text{altitude}, 3.0\text{ m}, 400.0\text{ m})$$

### 4.4 Visual Odometry (Zero-Mean Normalized Cross-Correlation)

When GPS is absent or degraded, the system executes an inter-frame Zero-Mean NCC (ZNCC) tracker on $96 \times 96$ downsampled grayscale patches across a search window of $\Delta x \in [-20, 20]$, $\Delta y \in [-15, 45]$:
$$\text{ZNCC}(\Delta x, \Delta y) = \frac{\sum (I_{t-1} - \bar{I}_{t-1})(I_t - \bar{I}_t)}{\sqrt{\sum (I_{t-1} - \bar{I}_{t-1})^2 \sum (I_t - \bar{I}_t)^2}}$$
A dual-tier threshold monitors GPS step size against optical forward flow; if telemetry disagrees with visual odometry by $>3\times$, visual odometry temporarily overrides GPS to prevent trajectory tearing.

---

## 5. Mathematical Formulation & Geometric Projection

### 5.1 Coordinate Frame Contract

The engine uses a **Right-Handed Metric Cartesian World Frame**:
- $+X$: **East** (Right)
- $+Y$: **Up** (Elevation)
- $-Z$: **North** (Flight Direction)

World origin $(0, 0, 0)$ is established at the drone's first frame ground position.

### 5.2 Pinhole Optics & Field of View

From the 35mm-equivalent focal length $f_{35}$ (e.g., $22.4\text{ mm}$) and standard full-frame sensor width $W_{35} = 36.0\text{ mm}$:
$$\text{HFOV} = 2 \cdot \arctan\left(\frac{W_{35}}{2 \cdot f_{35}}\right) = 2 \cdot \arctan\left(\frac{36.0}{44.8}\right) \approx 77.56^\circ$$
Focal lengths in pixel units:
$$f_x = f_y = \frac{W / 2}{\tan(\text{HFOV} / 2)}, \quad c_x = \frac{W}{2}, \quad c_y = \frac{H}{2}$$

### 5.3 Camera Pose Orthonormal Basis

Given drone yaw $\psi$, operator-selected camera pitch $\theta$ (e.g., $-45^\circ$ oblique, $-90^\circ$ nadir), and roll $\phi = 0$:
$$\text{Right} = \begin{bmatrix} c_\psi c_\phi + s_\psi s_\theta s_\phi \\ -c_\theta s_\phi \\ s_\psi c_\phi - c_\psi s_\theta s_\phi \end{bmatrix}, \quad
\text{Down} = \begin{bmatrix} -c_\psi s_\phi + s_\psi s_\theta c_\phi \\ -c_\theta c_\phi \\ -s_\psi s_\phi - c_\psi s_\theta c_\phi \end{bmatrix}, \quad
\text{Forward} = \begin{bmatrix} s_\psi c_\theta \\ s_\theta \\ -c_\psi c_\theta \end{bmatrix}$$

### 5.4 Ray-Plane Intersection & Metric Relief Modulation

For each pixel $(x, y)$ in the active frame area:
1. **Ray Direction in Camera Space**:
   $$u = \frac{x - c_x}{f_x}, \quad v = \frac{y - c_y}{f_y}$$
   $$\mathbf{r}_{\text{unnorm}} = u \cdot \text{Right} + v \cdot \text{Down} + \text{Forward}$$
   $$\mathbf{r} = \frac{\mathbf{r}_{\text{unnorm}}}{\|\mathbf{r}_{\text{unnorm}}\|}$$
2. **Horizon & Sky Rejection**:
   If $-r_y < 0.15$, the ray points horizontally or towards the sky; the pixel is discarded immediately.
3. **Planar Intersection Distance**:
   $$t_{\text{plane}} = \frac{h_{\text{AGL}}}{-r_y}$$
4. **Metric Relief Modulation**:
   Using the depth model's normalized inverse depth $\text{norm\_inv} \in [0, 1]$ (where $1.0$ is nearest and $0.0$ is farthest):
   $$t = t_{\text{plane}} \cdot \left(1.0 + \text{RELIEF\_FRAC} \cdot (0.5 - \text{norm\_inv})\right), \quad \text{RELIEF\_FRAC} = 0.30$$
5. **Metric 3D World Point**:
   With drone camera position $\mathbf{C} = [X_{\text{world}}, h_{\text{AGL}}, -Z_{\text{world}}]$:
   $$\mathbf{P} = \mathbf{C} + t \cdot \mathbf{r}$$

#### Proof of Altitude Invariance

At mean surface level ($\text{norm\_inv} = 0.5$):
$$t = t_{\text{plane}} = \frac{h_{\text{AGL}}}{-r_y}$$
$$P_y = C_y + t \cdot r_y = h_{\text{AGL}} + \left(\frac{h_{\text{AGL}}}{-r_y}\right) \cdot r_y = h_{\text{AGL}} - h_{\text{AGL}} \equiv 0.0$$
The ground plane stays firmly anchored at $Y = 0.0$ regardless of whether the drone climbs, descends, or cruises at varying altitudes.

---

## 6. Spatial Fusion, Filtering & Mesh Triangulation

### 6.1 Temporal Depth Range Smoothing (EMA)

To eliminate inter-frame scale flickering inherent to monocular depth estimation, the 5th and 95th depth percentiles ($p_5, p_{95}$) are extracted in $O(N)$ time via `select_nth_unstable_by` and smoothed across frames using an Exponential Moving Average:
$$\text{EMA}_t(p) = 0.30 \cdot p_t + 0.70 \cdot \text{EMA}_{t-1}(p)$$

### 6.2 Flying Pixel Rejection (Depth Discontinuity Masking)

Pixels near high-contrast depth silhouettes (e.g., roof edges, tree canopies against distant ground) are prone to edge smearing. The engine evaluates local spatial gradients:
$$\nabla_x = \frac{|\text{norm\_inv}(x+1, y) - \text{norm\_inv}(x-1, y)|}{2}, \quad \nabla_y = \frac{|\text{norm\_inv}(x, y+1) - \text{norm\_inv}(x, y-1)|}{2}$$
If $\nabla_x > 0.08$ or $\nabla_y > 0.08$, the pixel is rejected.

### 6.3 Spatial Surface Grid Fusion

Points are inserted into a metric 2D hash grid `HashMap<(i32, i32), SurfacePoint>` keyed by cell index:
$$\text{key} = \left(\left\lfloor \frac{P_x}{\Delta s} \right\rfloor, \left\lfloor \frac{P_z}{\Delta s} \right\rfloor\right)$$
where $\Delta s$ is determined by the operator's hardware profile ($0.10\text{ m}, 0.05\text{ m}, 0.025\text{ m}$). Overlapping observations from subsequent frames are merged using distance-weighted averaging:
$$w = \max\left(0.1, 1.0 - \text{clamp}\left(\frac{t}{150.0}, 0.0, 0.9\right)\right)$$
$$\mathbf{P}_{\text{cell}} \leftarrow \frac{\mathbf{P}_{\text{cell}} \cdot w_{\text{cell}} + \mathbf{P}_{\text{new}} \cdot w_{\text{new}}}{w_{\text{cell}} + w_{\text{new}}}$$

### 6.4 3×3 Median & 3×MAD Outlier Rejection

The sparse hash map is converted into a regular 2D elevation grid. For each cell, the elevation $Y$ is compared against the median of its 8-neighborhood. An observation is purged if:
$$|Y - \text{median}| > 3.0 \cdot \text{MAD}, \quad \text{MAD} = \text{median}(|Y_i - \text{median}|)$$

### 6.5 Morphological Hole Filling & Indexed Triangulation

1. **Hole Filling**: Up to 3 passes of morphological dilation fill missing cells that have $\ge 3$ valid 8-neighbors with the neighbor average for height and color.
2. **Triangulation**: For each quad grid cell $(i, j)$, two counter-clockwise triangles are generated:
   - $T_1 = [(i, j), (i+1, j), (i, j+1)]$
   - $T_2 = [(i+1, j), (i+1, j+1), (i, j+1)]$
3. **Discontinuity Guard**: If any edge in a candidate triangle has a height jump $|Y_a - Y_b| > 2.0\text{ m}$, the triangle is culled. This prevents artificial vertical "curtains" across terrain cliffs or building drop-offs.

---

## 7. Hardware Acceleration & 4GB VRAM Discipline

### 7.1 Windows DirectX & WebView2 GPU Enforcement

Dual-GPU laptops (e.g., AMD Ryzen CPU with integrated Radeon graphics + NVIDIA RTX 2050 Mobile) default to the integrated GPU for desktop applications. To enforce dedicated execution without user intervention:

1. **Registry Injection (`main.rs`)**: On startup, before launching Tauri, the executable path and all installed `msedgewebview2.exe` binaries are registered with DirectX High Performance:
   ```cmd
   reg add "HKCU\Software\Microsoft\DirectX\UserGpuPreferences" /v "<EXE_PATH>" /t REG_SZ /d "GpuPreference=2;" /f
   ```
2. **Chromium Environment Flags**:
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` is set to:
   `--force-high-performance-gpu --force_high_performance_gpu --enable-gpu-rasterization --gpu-preference=2`
3. **Optimus & PowerXpress Linker Exports**:
   ```rust
   #[no_mangle] pub static NvOptimusEnablement: std::os::raw::c_ulong = 0x00000001;
   #[no_mangle] pub static AmdPowerXpressRequestHighPerformance: std::os::raw::c_int = 1;
   ```

### 7.2 ONNX Runtime CUDA Execution Provider & Session Caching

- **Provider Priority**: The ORT session is created with `ort::ep::CUDA::default().with_device_id(0).build()`. If NVIDIA CUDA libraries (`nvcuda.dll`, `cudnn64_8.dll`) are missing, it falls back to multi-threaded CPU with a warning.
- **Session Cache**: The neural network session is cached inside a static `OnceLock<Mutex<Session>>`, avoiding redundant model parsing and GPU allocation during repeat reconstruction runs.

### 7.3 Memory Footprint Budget (4GB Target)

| Allocation | Memory Footprint | Strategy |
|---|---|---|
| **ViT-S Weights & Graph** | ~99 MB VRAM | Static allocation via ORT |
| **Inference Activations** | ~450 MB VRAM | Batch size 1, FP32 / FP16 fallback |
| **FFmpeg Frame Extraction** | ~120 MB RAM / VRAM | Sliced to temp disk, `-q:v 2` JPEG |
| **Surface Fusion Grid** | ~250 MB RAM | Metric hash map with cell de-duplication |
| **WebGL Viewport (Three.js)** | ~300 MB VRAM | Interleaved buffer geometries |
| **Total Peak Budget** | **< 1.5 GB VRAM** | Safely within the 4.0 GB physical limit |

---

## 8. Multi-Format Deliverables & Geospatial Export

Every completed reconstruction writes five deliverables into `frontend/public/` for download:

### 8.1 Binary PLY (`recon_output.ply`)

- **Format**: `binary_little_endian 1.0`
- **Header**: Contains `element vertex N` (float $x, y, z$, uchar $r, g, b$) and `element face M` (`property list uchar int vertex_indices`).
- **Compatibility**: Direct high-speed rendering in Three.js `PLYLoader`, CloudCompare, MeshLab, Blender.

### 8.2 Wavefront OBJ (`recon_output.obj`)

- **Format**: Standard ASCII Wavefront OBJ with 64 KB chunk-buffered streaming.
- **Contents**: Full vertex list (`v x y z r g b`) and 1-indexed triangle definitions (`f v1 v2 v3`).

### 8.3 ASPRS LAS 1.2 (`recon_output.las`)

- **Standard**: American Society for Photogrammetry and Remote Sensing (ASPRS) LAS 1.2 Specification.
- **Record Type**: Point Data Record Format 2 (3D coordinates, intensity, return number, classification, 16-bit RGB).
- **Coordinate Mapping**:
  $$\text{LAS}_X = P_x, \quad \text{LAS}_Y = -P_z \text{ (North)}, \quad \text{LAS}_Z = P_y \text{ (Elevation)}$$
- **Header Offsets**: Exact IEEE 754 64-bit bounds stored at:
  - Max X: `179..187`, Min X: `187..195`
  - Max Y: `195..203`, Min Y: `203..211`
  - Max Z: `211..219`, Min Z: `219..227`

### 8.4 glTF 2.0 Binary (`recon_output.glb`)

- **Format**: Hand-written binary container (no external crates).
- **Header**: 12-byte glTF 2.0 container (`0x46546C67`).
- **Chunk 0 (JSON)**: Declares `POSITION` (Vec3 float, accessor 0), `COLOR_0` (Vec3 float normalized, accessor 1), and `INDICES` (Scalar uint32, accessor 2).
- **Chunk 1 (BIN)**: 4-byte aligned binary buffer packing positions, colors, and face indices.

### 8.5 WGS-84 Georeference Metadata (`recon_georeference.json`)

Contains geospatial bounding coordinates calculated from the origin GPS reference:
$$\text{lat} = \text{lat}_{\text{orig}} - P_z \cdot \frac{180}{\pi R_{\text{earth}}}, \quad \text{lon} = \text{lon}_{\text{orig}} + P_x \cdot \frac{180}{\pi R_{\text{earth}} \cos(\text{lat}_{\text{orig}})}$$
Documents bounding coordinates, metric relief extents, total point counts, camera pitch, HFOV, and accuracy specifications.

---

## 9. Frontend Visualization & Control Interface

Built with **TypeScript, Vite, and Three.js**:

- **Active GPU Diagnostic**: Queries `WEBGL_debug_renderer_info` and logs the active unmasked renderer to confirm discrete GPU engagement.
- **Dynamic Render Modes**:
  - **Textured Mesh (Full HD)**: Renders `THREE.Mesh` with `THREE.MeshBasicMaterial` using interpolated vertex colors and `side: THREE.DoubleSide`.
  - **Point Cloud**: Renders `THREE.Points` with `THREE.PointsMaterial`.
- **View Mode Switcher**: Toggles between Mesh and Points instantaneously in-memory without reloading the PLY from disk.
- **Interactive OrbitControls**: Damped rotation, panning, zooming, and auto-centering on the model's bounding box center with bottom plane at $Y = 0$.
- **Camera Angle Selector**: Nadir ($-90^\circ$), $-60^\circ$, Oblique ($-45^\circ$), $-30^\circ$, $-20^\circ$.

---

## 10. Repository Structure

```text
drone-reconstruction-anti/
├── Cargo.toml                    # Workspace metadata
├── package.json                  # Root orchestration scripts
├── models/
│   └── depth_anything_v2_vits.onnx # Pre-trained Vision Transformer model (99 MB)
├── test media/
│   ├── DJI_0212_trimmed_1080p.mp4 # Real drone flight video (1080p, 88 seconds)
│   └── DJI_0212.SRT              # Real DJI telemetry subtitle stream
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml                # Dependencies: tauri, ort (cuda), image, csv, rayon
│   ├── tauri.conf.json           # Tauri v2 window and security configuration
│   └── src/
│       ├── main.rs               # Windows DirectX GPU registry setup & entry point
│       └── lib.rs                # Full reconstruction pipeline & test suite (1,800+ lines)
└── frontend/                     # TypeScript + Three.js client
    ├── index.html                # Sidebar controls, progress bar, export buttons
    ├── package.json              # Dependencies: three, @types/three, vite, typescript
    ├── vite.config.ts            # Local build and asset bundling config
    ├── public/                   # Generated deliverables (served via local HTTP)
    │   ├── recon_output.ply
    │   ├── recon_output.obj
    │   ├── recon_output.las
    │   ├── recon_output.glb
    │   └── recon_georeference.json
    └── src/
        └── main.ts               # Three.js scene, PLYLoader, IPC listener, UI events
```

---

## 11. Prerequisites & Build Instructions

### 11.1 System Requirements

- **Operating System**: Windows 10 / 11 (64-bit).
- **GPU**: NVIDIA GeForce RTX series (RTX 2050 4GB or higher recommended).
- **Dependencies on System PATH**:
  - [Rust](https://rustup.rs/) (version 1.77.2 or newer).
  - [Node.js](https://nodejs.org/) (v18 or v20 LTS) & `npm`.
  - [FFmpeg](https://ffmpeg.org/) (must be executable via terminal as `ffmpeg`).
  - [NVIDIA CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit) & cuDNN (provides `nvcuda.dll`).

### 11.2 Installation & Build

1. **Install Frontend Dependencies**:
   ```powershell
   cd "d:\Coding Journey\drone-reconstruction-anti\frontend"
   npm install
   npm run build
   ```

2. **Run Unit Tests**:
   ```powershell
   cd "d:\Coding Journey\drone-reconstruction-anti\src-tauri"
   cargo test
   ```

3. **Compile Optimized Release Binary**:
   ```powershell
   cargo build --release
   ```

4. **Launch Application**:
   ```powershell
   cd "d:\Coding Journey\drone-reconstruction-anti"
   npm run tauri dev
   ```

---

## 12. Verification & Automated Test Suite

The Rust backend includes unit tests covering the core mathematical and parsing operations:

```powershell
cargo test
```

### Verified Test Cases

1. `test_parse_dji_srt_block`: Validates timestamp parsing from `HH:MM:SS,mmm --> ` and extraction of `latitude`, `longitude`, `altitude`, and `focal_len` from DJI SRT blocks.
2. `test_camera_pose_orthonormal_level`: Confirms camera basis vectors ($\text{Right}, \text{Down}, \text{Forward}$) are mutually orthogonal ($\mathbf{u} \cdot \mathbf{v} = 0$) and normalized for level flight ($\text{Pitch} = 0, \text{Roll} = 0$).
3. `test_camera_pose_pitched_down`: Verifies forward vector points downward and toward flight direction for negative pitch angles.
4. `test_nadir_projection_ground_level`: Tests that nadir ($-90^\circ$) projection with $\text{norm\_inv} = 0.5$ places ground points exactly at $Y = 0.0 \pm 0.001\text{ m}$ across altitudes from $10\text{ m}$ to $300\text{ m}$.
5. `test_altitude_change_does_not_move_ground`: Proves changing flight altitude does not shift existing ground geometry.
6. `test_oblique_ray_distance`: Verifies center-pixel oblique ray at $-45^\circ$ pitch intersects the ground plane at exactly $h / \sin(45^\circ) = h \sqrt{2}$.
7. `test_las_header_bounds_offsets`: Serializes and deserializes the ASPRS LAS 1.2 header, verifying 64-bit IEEE bounds at offsets 179 through 227.
