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
