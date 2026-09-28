# M0 — Environment + Data + Baseline

## Environment (measured)

| Item | Value | Evidence |
|---|---|---|
| OS | Arch Linux, kernel 7.1.8-arch1-3 | `uname -a` |
| CPU | Intel Core 5 210H, 12 cores | `lscpu` |
| RAM | 15 GiB | `free -h` |
| GPU | **YES** — NVIDIA RTX 5050 Laptop, 8151 MiB VRAM, driver 610.57.04, CUDA UMD 13.3 | `nvidia-smi` |
| Rust | 1.97.1 | `rustc --version` |
| Node / npm | 26.7.0 / 11.19.0 | `node --version` |
| FFmpeg | n9.0.1 | `ffmpeg -version` |
| Python | 3.12.14 (uv venv `.venv`; system py 3.14 avoided — poor wheel support) | `.venv/bin/python -V` |
| Tauri sysdeps | webkit2gtk-4.1 2.52.5, gtk3 3.24.52, libsoup3 3.6.6 — all present | `pkg-config` |
| colmap / pdal / gdal / blender | absent — using pycolmap 4.2.0, laspy, rasterio (bundled GDAL) | `which` |
| Rust CUDA EP | engaged (`[GPU] ✓ CUDA Execution Provider engaged`, no CPU fallback msg) | m0_baseline_run.log |
| Python onnxruntime-gpu 1.30 | CUDA EP FAILS — needs `libcublasLt.so.13` + cuDNN 9 (CUDA 13 libs absent); CPU works | see note below |

NOTE on python ORT: `onnxruntime-gpu==1.30.0` targets CUDA 13 + cuDNN 9.
nvidia pip wheels were not installed yet (flaky network). The Rust `ort` crate
already accelerates; the Python engine will pin nvidia-*-cu13 wheels or fall back
to CPU with recorded timings.

## Data (verified vs HF API listing)

Source: `imageomics/KABR-raw-videos` · `21_01_2023_session_5/` (Mpala, 2023-01-21,
DJI Air 2S). NB: an earlier session used a wrong fork URL — all artefacts below
are confirmed against this dataset.

| File | Listed | Downloaded | Status |
|---|---|---|---|
| DJI_0212_trimmed.mp4 | 580.3 MB | 580,250,663 B | OK |
| DJI_0212.SRT | 0.8 MB | 769,975 B | OK |
| DJI_0210.SRT | 1.7 MB | 1,694,890 B | OK |
| DJI_0210.MP4 | 3,758.8 MB | downloading (bg) | PENDING |

## ffprobe — DJI_0212_trimmed.mp4

- codec: `hevc` (Main), **5472×3078 (5.4K)**, 29.97 fps, yuv420p, 900 frames
- duration **30.023 s**, bitrate 154.6 Mbps, creation_time 2025-08-26 (trim date)
- **SRT duration = 88.22 s** (2645 records @ ~33 ms) → the SRT spans the full
  untrimmed recording; the 30 s clip is an UNKNOWN sub-window of it. Clock-offset
  estimation is required (M2). Current pipeline warns ">2 s mismatch" but then
  wrongly maps frame N ↔ telemetry second N.

## SRT key format (verified)

Old-style DJI block, one record PER VIDEO FRAME (~30 Hz):

```
2645
00:01:28,216 --> 00:01:28,250
<font size="36">SrtCnt : 2645, DiffTime : 34ms
2023-01-21 15:10:23,646,142
[iso : 100] [shutter : 1/1500.0] [fnum : 280] [ev : 0] [ct : 5089] [color_md : default] [focal_len : 224] [latitude: 0.394611] [longitude: 36.885915] [altitude: 0.000000]
</font>
```

- keys: `iso, shutter ("1/1500.0"), fnum (280 → f/2.8), ev, ct, color_md,
  focal_len (224 → 22.4 mm 35-mm-equiv, matches DJI Air 2S), latitude, longitude,
  altitude (AGL rel to takeoff; 0.0 on the last records = landed)`
- `SrtCnt` = frame counter, `DiffTime` ≈ frame period; per-record UTC datetime
  line to microsecond precision.
- **NO gimbal/yaw keys** in this old format → gimbal pitch must come from the
  manual control or be estimated; yaw derived from GPS track bearing.
- No `rel_alt/abs_alt`/`drone_*` keys (those are the newer format — M2 adds them).

## Flight dynamics (from SRT, 1-s windows)

DJI_0212.SRT (88.2 s): fastest sustained 30 s ≈ **8.3 m/s** at t=32–62 s;
slowest ≈ **0.1 m/s** at t=0–30 s (hover); sharpest turn ≈ 5.5 °/s at t=44–74 s.
Altitude −3.3 → 40.7 m.

DJI_0210.SRT (193.9 s, matches the 3.7 GB MP4 at ~155 Mbps):
fastest 30 s ≈ **4.9 m/s** at t=70–100 s; slowest ≈ **0.3 m/s** at t=154–184 s;
sharpest turn ≈ 6.0 °/s at t=41–71 s. Altitude steady ≈ 15.5 m.

Plots: `eval/results/m0_track_0212.png`, `eval/results/m0_track_0210.png`.

## Baseline run (pipeline UNCHANGED) — evidence: eval/results/m0_baseline_run.log

Command: `BASELINE_VIDEO=../data/kabr/DJI_0212_trimmed.mp4
BASELINE_TELEMETRY=../data/kabr/DJI_0212.SRT cargo test --release -- --ignored
baseline_pipeline_headless` (mock_app harness, genericized `run_reconstruction_inner<R: Runtime>`)

- ffmpeg extraction (cuda hwaccel): **7.46 s**, 30 frames @1 fps, 1920×1080 stretched from 5.4K
- neural inference + fusion (30 frames): **21.70 s**
- mesh: 0.11 s → **476,715 verts / 903,687 faces**
- export: 0.44 s
- **total: 30.7 s wall**
- output PLY colour stats: r mean 109 σ33, g mean 94 σ22, b mean 79 σ19 —
  savanna palette, **NOT white** (screenshots eval/results/m0_mesh.png,
  m0_points.png rendered through three.js PLYLoader headless chromium)

## Known-bug verification (audit claims re-checked)

| Claim | Verified |
|---|---|
| georef lat bounds use elevation extents | **CONFIRMED** — `min_lat_wgs = orig_lat - max_z*deg_per_m` where z=elevation (lib.rs ~1594) |
| LAS XYZ offsets left 0 while pts quantized rel. min | **CONFIRMED** — header bytes 155–178 = 0.0, decoded pts shifted by −min |
| frame N == telemetry second N | CONFIRMED — `target_time = frame_idx` (with fps=1 → seconds), no clock offset |
| yaw lerp ignores 360° wrap | CONFIRMED — linear lerp in `lerp_point` |
| ffmpeg stretches to 1920×1080 | CONFIRMED — `scale=1920:1080` breaks aspect on 5472×3078 (1.778 vs 1.777 — mild) and kills 4K/5.4K detail |
| new DJI SRT keys unsupported → silent 20 m | CONFIRMED — `alt.unwrap_or(20.0)` |
| gimbal pitch parsed but ignored | CONFIRMED — `gimbal_pitch_deg` parsed, never used; dropdown-only |
| CWD-relative output paths | CONFIRMED — `../frontend/public/...` |
| rayon unused | CONFIRMED — declared, never `use`d |
| white model | **NOT reproduced on KABR** — see docs/DEBUG_WHITE_MODEL.md |
