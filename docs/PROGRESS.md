# EKDRSHTI v2 — Mission Progress

## Status board (updated live)

| Milestone | State | Notes |
|---|---|---|
| M0 env+data+baseline | ✅ DONE | GPU yes (RTX 5050/8GB); baseline 30.7s on 30s clip; all audit bugs verified |
| M1 white model | ✅ DONE | not reproduced on KABR; 3 real defects fixed (stale-file serving, GLB material, OBJ MTL); regression gate in place |
| M2 correctness fixes | ✅ DONE | SRT old+new formats, alt-error, yaw wrap, gimbal pitch auto, sync-offset estimator (verified +16s on trimmed clip), native-res ffmpeg, LAS UTM+VLR+offsets, georef bounds+CRS — 15 tests green |
| **features-all (T1–T16)** | ✅ DONE | provenance (frames.bin/views.bin/cameras.json + thumbs), filmstrip Frames tab, lasso+box, instant regen + rebuild, confidence/hillshade/unobserved, capture report + GPS integrity, flood/LZ/viewshed/area/volume |
| M3+ (COLMAP/TSDF true-3D) | ⬜ planned | see docs/ROADMAP.md — engine/ prototype incomplete, not demoed |
| M7 features | ✅ partial | covered by features-all tasks |
| M8 robustness | ⬜ | |

## Latest verified numbers (features-all, branch)
- Full run (30 frames, balanced): **40.2 s** → 1,429,506 verts / 2,010,260 faces — `runs/demo_s1/`
- Range rebuild (frames 10–19): ~13 s inference → 803,635 verts — `runs/feat_t2/`
- `recon_frames.bin`: 1,429,506 u16 ids (0–29 + 65535 holes) matching PLY order — `runs/demo_s1/recon_frames.bin`
- `recon_cameras.json`: 30 entries with cam/yaw/pitch/footprint/sharpness/exposure/gps_ok — `runs/feat_t2/`
- `capture_report.json`: verdict GO, blur 0%, clip 0%, gps gaps 0, sync +16 s (r=0.63) — `runs/feat_t2/`
- `recon_views.bin`: view_count histogram (0=253 k holes, 1–7 views)
- Frontend: `npm run build` clean; backend `cargo test` 15/16 pass.

## Verified numbers so far
- Baseline pipeline (unchanged): 30.71 s for a 30 s 5.4K clip → 476,715 verts / 903,687 faces — `eval/results/m0_baseline_run.log`
- PLY colour stats: std_mean 24.6, 0% saturated, 0% gray — coloured output confirmed.
- Video 30.023 s vs SRT 88.22 s → clock offset unknown, needs estimator (M2).

## Top risks for the finals (running list)
1. Consumer-GPS-only absolute accuracy cannot honestly reach ≤1 m — mitigated by honest uncertainty + synthetic-GT harness (M5a).
2. Unseen-video robustness: SfM failure modes must degrade gracefully (M8 matrix).
3. onnxruntime-gpu (Python) needs CUDA-13 + cuDNN-9 wheels — currently CPU-only; Rust `ort` CUDA EP works. Pin nvidia-*-cu13 wheels or document CPU fallback.
4. 15 GB RAM ceiling for full-pipeline on 4K/long video — tiled processing needed (M6).
5. DJI_0210.MP4 download is slow (~1 MB/s) — if it stalls, M6 uses a looped/segmented strategy on available media.

## Log
### 2026-09-28 — M0
- Branched `engine-v2` from `main`. Env report + data verified — `eval/results/m0_baseline.md`.
- Built headless baseline harness: `baseline_pipeline_headless` #[ignore] test via `tauri::test::mock_app()` (needed `tauri` `test` feature in dev-deps; `run_reconstruction_inner`/`extract_frames`/`build_ort_session` genericized over `R: Runtime` — no behaviour change).
- Track plots: `eval/results/m0_track_0212.png`, `m0_track_0210.png`.
- Clips a/b/c pending DJI_0210.MP4 (30-s source clip can't yield 3×30 s).
- Wrote engine/tools/srt.py (shared parser: old + new DJI formats), eval/srt_track_plot.py, eval/clip_srt.py.
- Verified every audit bug claim by reading code + parsing artifacts (table in m0_baseline.md).
- WHITE MODEL: reproduced pipeline end-to-end; output IS coloured; rendered screenshots coloured. Proceeding to M1 evidence doc.
