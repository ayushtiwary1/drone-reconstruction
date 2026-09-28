# Roadmap — planned, NOT working in this build

These are planned capabilities that need new installs or significant
engineering. They are listed for the pitch/roadmap and are deliberately
NOT shown as working in the UI (some appear as disabled "Planned" rows).

## Reconstruction quality
- **COLMAP/pycolmap SfM poses + GPS Sim3 alignment** — replaces the
  heuristic camera track with bundle-adjusted metric poses.
- **Metric depth scaling** — align the monocular depth prior to SfM
  sparse depths / telemetry for true metric heights.
- **TSDF true-3D fusion with facades** (Open3D/CUDA) — building sides,
  undercuts, trees; replaces the 2.5D surface grid.
- **UV-textured meshes** (OpenMVS) — real image-texture surfaces.
- **Synthetic accuracy benchmark** — known-geometry scenes vs GCPs.

## Dynamic scenes / intelligence
- **YOLO dynamic-object masking** — mask people/vehicles before fusion.
- **4D replay** — multi-temporal runs, change detection.
- **Shadow-based height check** — independent height validation cue.
- **Virtual GCPs** — survey-markers auto-detected in frames.
- **Signed chain of custody** — provenance-signed exports for evidence.

## Export / interop
- **GeoTIFF DEM + orthophoto export**
- **FBX export**
- **DEM prior ingest** (SRTM/local DEM) for absolute vertical anchoring.

## Perf
- **rayon** parallel per-pixel loop (single-threaded now — still hits
  ~14 s inference+fusion for 30 frames on RTX 5050).

## Status of the Python `engine/` prototype
An earlier "v2" engine (pycolmap + Open3D + metric depth) exists as
untracked prototype files in `engine/` — it is *incomplete* (SfM runs,
TSDF fusion produced empty meshes). It is kept for the roadmap, not part
of the demo build. The demo uses only the Rust pipeline.
