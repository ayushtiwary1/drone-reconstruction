# DEMO_NOTES — Frame + Region Selection (branch `demo-selection`)

## 60-second demo script

1. Pick `data/kabr/DJI_0212_trimmed.mp4` + `DJI_0212.SRT` → **Start Reconstruction**.
   (~40 s on this machine; watch the log stream, sync estimate, CUDA EP.)
2. When the model lands, the **filmstrip** slides in at the bottom —
   30 thumbnails, one per extracted frame (1 fps).
3. **Click F20** → its contributed vertices light up cyan; other frames dim.
   Shift-click F25 extends to a range. Camera positions appear as grey dots;
   selected ones glow cyan.
4. Press **L** → drag a freehand loop over part of the model (e.g. the
   vehicle/track patch). Region turns **orange**; the filmstrip auto-sorts
   contributions — badges like `F12 · 3,410 pts` show which frames built it.
5. **Alt-click F12** (or select + X) → frame excluded (dimmed red, `EXC`).
6. **Regen region** → the region's excluded-frame points are replaced
   instantly by neighbours' average (toast: "N points replaced…").
   **Undo** restores.
7. Select a range, press **Rebuild frames** → real backend run on only
   those frames → fresh model reloads; toast/log shows wall-time.
8. **Esc** clears selection/region.

## What's real here

- `recon_frames.bin` maps every PLY vertex to the frame that contributed
  the largest fusion weight; hole-filled cells = 65535.
- `recon_cameras.json` carries each processed frame's camera centre in
  PLY world coords — markers match the mesh exactly.
- Instant regenerate modifies the actual vertex buffers (positions +
  colours) — it is a local fill, not a re-mesh.
- "Rebuild from selected frames" re-runs the *actual* Rust pipeline with
  `frame_range`, skipping inference/fusion for excluded frames.

## Known rough edges

- Frame↔point mapping survives on `frame_id = highest-weight frame` —
  a cell's colour/geometry is still the *fused* average, so tinting is
  attribution, not ownership.
- Instant regen fill uses a fixed 2 m grid hash (good for this scene's
  density); sparse regions may leave unreplaced points.
- The lasso screen-projection walks all vertices — ~1.4 M pts ≈ a brief
  pause, no Web Worker.
- Camera markers are unscaled spheres (fixed 1.2 m radius).
- The `frame_id` only travels to the frontend via recon_frames.bin —
  PLY/OBJ/GLB files themselves do not embed it.
- If the asset protocol can't `fetch()` in a packaged build (it works in
  dev), thumbnails/artifacts fall back silently to a logged warning.
