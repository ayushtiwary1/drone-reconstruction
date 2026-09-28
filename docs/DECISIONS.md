# Engineering Decisions Log

Format: Decision | Alternatives considered | Evidence | Why chosen

## D1 — Python 3.12 for the engine (not 3.11, not system 3.14)
- Alt: system Python 3.14 (no binary wheels for pycolmap/open3d yet); mise python 3.12.14 available.
- Evidence: `mise ls`, wheel availability.
- Why: mission spec says 3.11, but 3.12 has full wheel coverage and is already installed. Deviating recorded here.

## D2 — Branch `engine-v2` from `main`, keep `ui-redesign` untouched
- The checkout was on `ui-redesign` (frontend shell redesign). Per mission, pipeline work branches from `main`; viewer features go in `frontend/src/features/*` for clean merges.

## D3 — Baseline harness via `tauri::test::mock_app()`
- Alt: driving the GUI (needs webview automation), or a separate Rust bin duplicating logic (not "unchanged").
- Evidence: `cargo test --release -- --ignored baseline_pipeline_headless` runs the real `run_reconstruction_inner` verbatim; only signature genericized to `AppHandle<R>`.
- Why: smallest possible diff, exercises production code path, repeatable in CI.

## D4 — DJI_0210.MP4 downloaded in M0 (not deferred to M6)
- The mission says defer the 3.7 GB MP4 to M6, but M0 gate needs 3 behavioural clips and the only available 30 s source cannot yield them. Downloading now in background; documented deviation.

## D5 — onnxruntime-gpu 1.30 + CUDA 13 note
- ort-gpu 1.30 requires CUDA 13 + cuDNN 9 shared libs; not present → CPU EP fallback. Rust `ort` CUDA EP works (its bundled ORT found compatible libs). Decision: attempt `nvidia-*-cu13` pip wheels; if unavailable, the engine runs CPU with measured timings, never silently. Recorded for finals risk #3.

## D6 — M2: sync-offset estimator via motion↔speed correlation
- Alt: per-frame `FrameCnt`/`SrtCnt` mapping (new-format SRT only — old format has no reliable frame→wallclock map once the video is trimmed); audio beacon (no audio in DJI files); manual field only (fails trimmed clips).
- Evidence: on `DJI_0212_trimmed.mp4` + full `DJI_0212.SRT` the estimator recovered **+16.0 s (r=0.63)** and H_agl then rose 15.6→40.3 m matching the climb seen in the SRT window; on a self-consistent clip it correctly rejected (r≈0 → keeps 0). Implemented in `estimate_sync_offset()` (Pearson over 1-Hz GPS speed vs ZNCC pixel drift, ±full-range search + 0.1 s refine, confidence gate 0.3, manual override via `syncOffsetSec` arg/UI field).
- Why: works on the *old* DJI format actually present in KABR.

## D7 — LAS now stores real UTM coordinates
- Points written as UTM easting/northing (WGS-84 → UTM hand-rolled projection, verified <5 cm vs pyproj at Nairobi + KABR), GeoTIFF `ProjectedCSTypeGeoKey` VLR, offsets = min bounds (mm scale 0.001), return counts set. PLY/OBJ/GLB stay in ENU-local metres (documented in georef.json).

## D8 — gimbal pitch: telemetry first, dropdown is the override
- New `<option value="auto">` default sends `cameraPitchDeg: null` → backend uses `gb_pitch`/`gimbal_pitch` when present, else −45°. Per mission spec ("manual override").
