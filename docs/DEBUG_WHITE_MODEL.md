# M1 — White / Colourless Model: Investigation Log

## Verdict up front

The literal "white model" could **not be reproduced** on KABR data through the
application's own render path: the produced PLY contains real per-vertex colour,
PLYLoader parses it, and both mesh and point views render correctly (screenshots
below). The investigation did, however, confirm **three real defects** that
produce a white/colourless/stale-looking model in plausible real-world flows —
all three are fixed in this milestone, and a permanent regression gate now fails
CI if any output ever loses colour.

## Reproduction attempt

1. Ran the unchanged pipeline headlessly (`baseline_pipeline_headless` test,
   `mock_app`) on `data/kabr/DJI_0212_trimmed.mp4` + `DJI_0212.SRT`.
   → output `recon_output.ply`: 476,715 verts, r mean 109 σ33 / g 94 σ22 /
   b 80 σ19 — savanna palette, **not white**.
2. Rendered the file through the same code path the viewer uses
   (three.js PLYLoader + `MeshBasicMaterial{vertexColors}` and
   `PointsMaterial{vertexColors}`) in headless Chromium:
   `eval/results/m0_mesh.png`, `eval/results/m0_points.png` — coloured.
3. Same for the `.glb` and `.obj` exports — both render coloured in three.js.

## Hypothesis table

| # | Hypothesis | Result | Evidence |
|---|---|---|---|
| H1 | File has no colour | **RULED OUT** | Byte-level PLY parse: uchar red/green/blue props present; channel stats above; %sat=0, %gray=0.017 |
| H2 | Colour sampled from ImageNet-normalised tensor | **RULED OUT** | `raw_rgb` is the u8 RGB buffer; `chw` is never used for colour (lib.rs projection loop reads `raw_rgb[p_idx]`); commit history shows same code |
| H3 | u8 overflow/saturation in running average / hole fill | **RULED OUT** | `r,g,b` are f32 accumulators, weighted-mean in f64 domain, `.round().clamp(0,255)` at write; math verified in code + output stats |
| H4 | RGB/BGR swap, stride, or letterbox-offset error | **RULED OUT** | RGB JPEG → `to_rgb8()` → `raw_rgb` interleaved R,G,B → written as red,green,blue; letterbox rows excluded from the projection loop (`active_y_start..active_y_end`); render shows correct savanna hues |
| H5 | PLYLoader property-name/type mismatch | **RULED OUT for PLY; later UI regression found** | Three@0.186 reads `uchar red/green/blue` as a **normalized Uint8BufferAttribute**; `getX/Y/Z()` returns linear 0–1. The redesigned UI erroneously copied the underlying raw Uint8 array (0–255) into a non-normalized Float32 attribute, causing white clipping. See update below. |
| H6 | Stale / wrong file served | **CONFIRMED DEFECT (fixed)** | Outputs were written CWD-relative to `frontend/public/`, but `frontendDist` is `frontend/dist` — in packaged builds the webview serves the file baked at build time, never the new run; in dev it serves whatever previous run left. A stale colourless artifact would be shown as if fresh. Fix: outputs now go to a per-run dir under app-data (`$APPDATA/recon/runs/<ts>`), `pipeline-artifact` events carry absolute paths, viewer loads via `convertFileSrc` (asset protocol scoped to `$APPDATA`/`$TEMP`) |
| H7 | Bad frames (overexposed/decode) | **RULED OUT** | Extracted JPEGs inspected — well-exposed savanna (zebras, giraffe visible); identical bytes with and without `-hwaccel cuda` |

## Additional defects found while investigating (fixed)

- **GLB had no `material`** → per glTF 2.0 spec the client must substitute a
  default material (`baseColor` WHITE, metallic 1, roughness 1). three.js still
  multiplies `COLOR_0` (coloured here), but strict viewers (several glTF
  viewers/importers) render the default white material — a plausible
  "white model" report. **Fix:** explicit material,
  `metallicFactor 0, roughnessFactor 1, baseColorFactor white` +
  `KHR_materials_unlit`.
- **OBJ has no MTL and `v x y z r g b` is non-standard** → most tools
  (Blender, MeshLab, Windows 3D Viewer) ignore OBJ vertex colours → white mesh.
  Documented; real UV texture is M4 scope. PLY/LAS/GLB all carry colour and are
  the recommended artefacts meanwhile.

## Regression gate (permanent)

- `engine/tools/check_colour.py` — parses PLY, **exits 1** when
  mean channel std < 10 OR >50 % verts r,g,b≥250 OR >90 % r==g==b; exits 2 when
  colour props are absent entirely.
- `cargo test` additions: `test_ply_roundtrip_has_color` (byte-level parse of a
  written PLY) and `test_ply_white_stats_catches_white` (all-white buffer must
  trigger the condition).
- `check_colour` is wired into the engine CLI so **every run** validates its own
  output and reports the verdict in the manifest.

## Screenshots

| Before (baseline run, this machine) | After (fixed pipeline) |
|---|---|
| eval/results/m0_mesh.png (already coloured — bug not reproducible here) | eval/results/m1_mesh_after.png |
| eval/results/m0_points.png | eval/results/m1_glb_after.png (GLB now carries a material) |

## Remaining unverified possibility

If the original report came from a **packaged** build (not dev), H6 fully
explains it: the bundled `recon_output.*` from a months-old run is what the
viewer always loaded. That path is now eliminated, not patched over — the
viewer only ever loads the absolute path of the artifact the current run just
wrote.

## 2026-09-29 update — regression in `features-all`

The reported white screenshot is reproducible with the redesigned UI. Byte-level
PLY from the same 30 s clip has **0.0% saturated vertices**; its RGB means are
113.6/94.9/81.0 out of 255 with σ 37.5/26.1/23.0. Three@0.186 parses uchar
colour as normalized `Uint8BufferAttribute` and converts sRGB to linear. The
new `colorModes.ensureOriginalColors()` copied `.array` into Float32 **without
normalization**; after `rgb` mode `vertexColors` received values up to 138,
clipped to white. Fixed by reading `getX/getY/getZ` before creating Float32
colour attributes; `Viewer.renderModel()` now refreshes the tint baseline when
switching colour modes. No export or material hacks.

Evidence: `eval/debug.json` (baseline in commit `9eef975`),
`eval/debug_after.json`, `eval/evidence_colour.png`. After: **0% saturated**
raw PLY, σ sRGB ≈ 0.147/0.102/0.090; the image shows coloured terrain. The
full-frame source mean includes sky which is intentionally excluded from the
3D surface; comparison with source **ground ROI** differs by 0.018/0.037/0.050
per channel, while full-frame blue differs by 0.156 (literal C1 mean test fails
for sky-inclusive frames).
