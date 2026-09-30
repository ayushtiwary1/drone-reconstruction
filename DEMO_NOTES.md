# DEMO_NOTES — EKDRSHTI (branch `features-all`)

## 90-second demo script

1. **Load**: video `data/kabr/DJI_0212_trimmed.mp4` + telemetry
   `DJI_0212.SRT` → **Start Reconstruction** (~40 s; pipeline stages in
   the dock show extract → telemetry → inference → fusion → mesh → export).
2. **Capture report**: Inspector → *Capture Report* — verdict **GO**,
   0% blur, 0% overexposed, sync offset +16 s (r=0.63), flight type.
   *Accuracy & Limits* — mode "Rapid 2.5D", hole-fill %, GPS integrity.
3. **Frames tab** (dock): filmstrip with quality flags + the GPS
   integrity strip on top. Click **F20** → its vertices tint cyan and its
   camera marker brightens. Shift-click a range. Right-click = exclude.
4. **Lasso (L)**: draw around the vehicle/track patch → region goes
   orange; filmstrip auto-highlights contributing frames with badges
   (`F12 · 3,410 pts`). Plain click on the model = provenance toast
   ("Vertex → frame F12").
5. **Exclude** that frame (right-click or X) → **Regen** → the region's
   excluded points are refilled from neighbours instantly; toast shows
   real counts. **Undo** restores.
6. **Rebuild**: select a frame range → Rebuild → the actual pipeline
   reruns on just those frames; model reloads in ~15 s.
7. **Trust layer**: Colour mode → *Confidence* (red = unobserved),
   *Hillshade*, toggle *Hide unobserved* to drop hole-filled faces.
8. **Measure**: M for distance (± estimate), A for polygon area +
   cut/fill volume in m³ + truckloads.
9. **Analysis**: Flood slider (m² submerged), *Find landing zones*
   (25 m² flat, <7° slope), *Viewshed* (dead ground in red).
10. **Exports**: PLY/OBJ/LAS (UTM 37N, RGB) + GLB + GeoRef — all from
    the actual run's app-data folder.

## Known rough edges
- `frame_id` = highest-weight contributing frame — tint is attribution,
  not ownership (cells remain fused averages).
- Instant regen uses a fixed 2 m kNN grid — sparse regions may leave a
  few unfilled points.
- Viewshed/LZ/flood are estimates on the heightmap — no facade geometry.
- Confidence is heuristic (views + distance + local smoothness); it is
  not a calibrated error model — ± values are labelled "est.".
- Lasso projects ~1.4 M vertices synchronously — a brief pause is normal.
- Mock mode (`npm run dev` in a plain browser) exercises the UI shell;
  provenance data only appears after a real Tauri run.
