# Pitch Facts — only measured numbers

All numbers below are measured on this machine (RTX 5050 Laptop 8 GB)
with `data/kabr/DJI_0212_trimmed.mp4` (30 s hover clip, 30 frames @1 fps)
on profile `balanced`. Evidence paths given per claim.

## Measured

- **End-to-end**: 40.2 s wall-clock for a 30-frame run — 12.3 s FFmpeg
  extraction (CUDA), ~14.5 s ONNX inference + fusion, 0.35 s meshing,
  ~6 s export of 5 artifacts.
  Evidence: `runs/feat_t2/` log, `cargo test --release baseline_pipeline_headless`.
- **Output**: 803,635 vertices / 1,515,680 faces on a 10-frame subset;
  1,429,506 vertices / 2,010,260 faces on the full 30 frames.
  Evidence: `runs/demo_s1/recon_output.ply` header.
- **Sync**: video↔telemetry offset estimated at +16.0 s, Pearson r=0.63
  — the trimmed clip's real temporal offset.
  Evidence: pipeline log `[SYNC]` line; `capture_report.json`.
- **Georeference**: LAS 1.2 point-format-2 with EPSG:32637 GeoTIFF VLR,
  mm offsets; validated with laspy (independent reader).
  Evidence: `runs/demo_s1/recon_output.las`, eval scripts.
- **Provenance**: per-vertex frame provenance + view counts exported —
  `recon_frames.bin` / `recon_views.bin` verified to match PLY vertex
  order and count; hole-filled cells tagged 65535.
- **Instant region regen**: client-side kNN refill in tens of ms on
  ~800k-vertex models.
- **Frame-range rebuild**: verified headless — frames 10–19 only produce
  a coherent partial model with provenance restricted to those frames.

## Demoable workflows
1. Video+telemetry → Start → georeferenced coloured mesh (~40 s).
2. Frames tab → select frames → their contributed vertices light up.
3. Lasso a region → see which frames built it (badges + sort).
4. Exclude a frame → instant regen → undo.
5. Rebuild from a frame range → fresh model.
6. Confidence / hillshade / unobserved-hide display modes.
7. Capture report GO/PARTIAL/RE-FLY; GPS integrity strip.
8. Flood / landing-zone / viewshed / area / volume (all "est.").

## Do NOT claim
- True 3D (facades, building sides) — this is a 2.5D heightmap mode.
- Survey-grade accuracy — GPS-limited, no GCPs, monocular depth prior.
- COLMAP-quality poses — odometry is visual + GPS, not bundle-adjusted.
- Real-time — it's ~40 s for 30 frames on this laptop.
- GeoTIFF/FBX export — shown as "Planned" in the UI.
