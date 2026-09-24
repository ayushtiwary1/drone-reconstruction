# Frontend

Professional panel-based UI for the drone reconstruction app — vanilla TypeScript + Three.js, styled after dense desktop tools (Blender / DaVinci Resolve).

## Commands

```bash
npm run dev        # vite dev (inside Tauri via npm run tauri dev, or standalone)
npm run dev:mock   # browser-only mock backend — replays pipeline logs, loads bundled sample PLY
npm run build      # tsc + vite build
npm run test       # vitest — log-parser unit tests
```

`dev:mock` needs no GPU or Tauri runtime; file dialogs return fake paths and the pipeline replays real backend log formats.

## Structure

```
src/
  main.ts        bootstrap — shell assembly, menus, toolbar, shortcuts, run wiring
  styles/        tokens.css (palette/typography), base, components, layout
  state/         store.ts — single app-state store (bind/on subscriptions)
  pipeline/      backend.ts (only file importing @tauri-apps/*), logParser.ts (+tests),
                 samplePly.ts (procedural fallback terrain)
  ui/            Menu, Dropdown, Segmented, Slider, Splitter, Panel, Tabs, Toast, Tooltip, icons
  panels/        ProjectPanel, InspectorPanel, ConsolePanel, PipelinePanel, OutputsPanel, StatusBar
  viewer/        Viewer (three.js), controls (OrbitControls + preset tweens), gizmo, scaleBar,
                 measure, colorModes (RGB / elevation ramp)
```

## Backend contract (unchanged)

`invoke("run_reconstruction", { videoPath, telemetryPath, hardwareProfile, cameraPitchDeg })` with `listen("pipeline-log")`. Outputs are read from `/recon_output.{ply,obj,las,glb}` and `/recon_georeference.json` (served from `frontend/public/`, which maps to the app's output directory at runtime).
