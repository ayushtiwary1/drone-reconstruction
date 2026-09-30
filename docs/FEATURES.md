# Features — SIH26158 (NTRO) · EKDRSHTI

What each shipped feature does and which challenge/gap it addresses.

## Core pipeline (existing)
- **Video → 2.5D heightmap** (Rapid 2.5D mode): 1-fps frames → monocular depth
  (ONNX, CUDA/CPU) → per-pixel back-projection with telemetry yaw/pitch/AGL →
  weighted surface fusion → triangulated mesh + point cloud.
- **Georeferenced exports**: PLY/OBJ/GLB in local ENU; LAS 1.2 with UTM CRS
  VLR (EPSG:32637 for KABR data), mm-scale offsets, RGB per point; GeoRef JSON.
- **Video↔telemetry sync**: estimated cross-correlation offset or manual
  override; per-frame GPS↔visual-odometry agreement cross-check.
- **Addresses**: offline single-laptop reconnaissance — no cloud, no GPU farm
  required (CUDA when present, CPU fallback).

## Provenance (demo core)
- **Per-vertex frame_id** (`recon_frames.bin`): which source frame contributed
  the largest fusion weight → "click a point, see the frame that made it".
- **Per-vertex view_count** (`recon_views.bin`): how many frames saw a cell.
  Hole-filled cells (65535) are flagged, tintable, and hidable — unobserved
  areas are never silently filled.
- **recon_cameras.json**: per-frame camera position, yaw/pitch/AGL, ground
  footprint, sharpness (Laplacian), exposure, GPS-agreement flag.

## Frame selection — Frames dock tab
- Filmstrip of extracted frames with number + time, per-frame quality flags
  (blur/clip/gps), region-contribution badges (F12 · 3,410 pts).
- Click / Shift-click / Ctrl-click select; right-click or Alt-click toggles
  Exclude; X toggles exclude on selected.
- Selecting frames tints their contributed vertices cyan in 3D + brightens
  the camera markers + draws ground footprints.
- **GNSS integrity strip**: per-frame green/red visual-vs-GPS agreement.

## Region selection — viewport toolbar
- **Lasso (L) / Box (B)**: freehand or box draw → all vertices inside are
  tinted and their contributing frames highlighted in the filmstrip sorted
  by point count.
- **Esc** clears. Plain click on the model selects that vertex's source frame.

## Regeneration
- **Regen (instant, client-side)**: inside the region, vertices whose
  source frames are excluded are refilled from their nearest remaining
  neighbours (grid kNN). Undo restores the previous buffers.
- **Rebuild (real)**: re-runs the actual Rust pipeline with `frameRange` /
  `excludedFrames` — fresh model reloads.

## Accuracy & trust layer
- **Confidence colour mode**: per-vertex score from view_count + camera
  distance + local smoothness (hole-filled → near-zero, shown red).
- **Hillshade colour mode**: multi-direction shading for faint relief.
- **Hide unobserved**: drops faces whose vertices are all hole-filled.
- **Measurements with ± estimate**: distance (3D/horizontal/ΔY), polygon
  area, cut/fill volume vs a base plane — each labelled "est." with an
  uncertainty derived from the confidence of the points used.
- **Capture report** (`capture_report.json` + Inspector panel): blur %,
  overexposed %, GPS gaps/disagreements, sync offset+confidence, flight
  type → verdict **GO / PARTIAL / RE-FLY**.

## Terrain analysis (client-side, honest estimates)
- **Flood level** slider: water plane + submerged-area m².
- **Landing zones**: ≥25×25 m patches, slope <7°, low roughness,
  confidence-filtered — marked and listed.
- **Viewshed**: observer click → visible vs "dead ground" shading.
- **Relief exaggeration** 1–5×.

## What is explicitly NOT claimed
- No true-3D facades/undersides (Rapid 2.5D only).
- No metric accuracy guarantees — GPS-limited, no GCP validation.
- Depth is a monocular prior — heights are relative relief.
