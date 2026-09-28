/**
 * EKDRSHTI — Tactical 3D Recon. Frontend bootstrap only:
 * assembles the shell (menubar, toolbar, panels, dock, statusbar),
 * wires the backend contract, and manages layout + shortcuts.
 *
 * Coordinate contract (unchanged): +X East, +Y Up, −Z North.
 */

import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';

import * as THREE from 'three';
import { store, freshStages } from './state/store.ts';
import { backend, EXPORT_FILES } from './pipeline/backend.ts';
import { inferStageEvents, parseFramesExtracted, parseFrameProgress, STAGE_ORDER, STAGE_LABELS } from './pipeline/logParser.ts';
import { initTooltips } from './ui/Tooltip.ts';
import { toast } from './ui/Toast.ts';
import { icon, el } from './ui/icons.ts';
import { MenuBar } from './ui/Menu.ts';
import { Segmented } from './ui/Segmented.ts';
import { Splitter } from './ui/Splitter.ts';
import { Tabs } from './ui/Tabs.ts';
import { ProjectPanel } from './panels/ProjectPanel.ts';
import { InspectorPanel } from './panels/InspectorPanel.ts';
import { ConsolePanel } from './panels/ConsolePanel.ts';
import { PipelinePanel, applyStageEvents } from './panels/PipelinePanel.ts';
import { OutputsPanel } from './panels/OutputsPanel.ts';
import { StatusBar } from './panels/StatusBar.ts';
import { Viewer } from './viewer/Viewer.ts';
import type { ViewPreset } from './viewer/controls.ts';

/* ────────────────────────────────────────────────────────────
   Layout persistence
   ──────────────────────────────────────────────────────────── */

const LAYOUT_KEY = 'ekdrshti.layout.v1';
interface LayoutState {
  leftW: number;
  rightW: number;
  dockH: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  dockCollapsed: boolean;
}
const DEFAULT_LAYOUT: LayoutState = {
  leftW: 268,
  rightW: 296,
  dockH: 170,
  leftCollapsed: false,
  rightCollapsed: false,
  dockCollapsed: false,
};

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? { ...DEFAULT_LAYOUT, ...JSON.parse(raw) } : { ...DEFAULT_LAYOUT };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}
const layout = loadLayout();
function saveLayout(): void {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
}

/* ────────────────────────────────────────────────────────────
   Shell assembly
   ──────────────────────────────────────────────────────────── */

const app = document.getElementById('app')!;

const project = new ProjectPanel();
const inspector = new InspectorPanel();
const consolePanel = new ConsolePanel();
const pipelinePanel = new PipelinePanel();
const outputsPanel = new OutputsPanel();
const statusBar = new StatusBar();

const workbench = el('div', 'workbench');
const centerCol = el('div', 'center-col');
const viewportWrap = el('div', 'viewport-wrap');
const dock = el('div', 'panel panel-bottom');

const viewer = new Viewer(viewportWrap);
store.set('gpuName', shortGpu(viewer.gpuName));
// Debug/testing handle (harmless in production).
(window as unknown as Record<string, unknown>).__viewer = viewer;

/** Compact GPU label for the status bar (unwraps ANGLE strings). */
function shortGpu(name: string): string {
  let s = name.replace(/^ANGLE\s*\(/, '').replace(/\)+$/, '');
  if (/swiftshader/i.test(s)) return 'SwiftShader (software)';
  const inner = s.match(/\(([^()]+)\)/);
  const first = s.split(',')[0].trim();
  if (/^(Google|Microsoft|Mozilla)$/i.test(first) && inner) return inner[1].trim();
  return first.slice(0, 48);
}

/* ── Dock tabs ────────────────────────────────────────────── */

const dockHeader = el('div', 'dock-header');
const tabs = new Tabs([
  { id: 'console', label: 'Console', icon: 'terminal', badge: () => String(consolePanel.count()) || null },
  { id: 'pipeline', label: 'Pipeline', icon: 'layers' },
  { id: 'outputs', label: 'Outputs', icon: 'package' },
]);
dockHeader.appendChild(tabs.el);
const dockCollapseBtn = el('button', 'btn-icon');
dockCollapseBtn.appendChild(icon('chevron-down', 14));
dockCollapseBtn.setAttribute('data-tooltip', 'Collapse panel');
dockHeader.appendChild(dockCollapseBtn);
dock.appendChild(dockHeader);

const dockBody = el('div', 'dock-body');
dockBody.appendChild(consolePanel.el);
dockBody.appendChild(pipelinePanel.el);
dockBody.appendChild(outputsPanel.el);
dock.appendChild(dockBody);

function selectDockTab(id: string): void {
  consolePanel.el.style.display = id === 'console' ? '' : 'none';
  pipelinePanel.el.style.display = id === 'pipeline' ? '' : 'none';
  outputsPanel.el.style.display = id === 'outputs' ? '' : 'none';
}
selectDockTab('console');
tabs.onChange(selectDockTab);
setInterval(() => tabs.refreshBadges(), 1000);

/* ── Splitters ────────────────────────────────────────────── */

const leftSplitter = new Splitter({
  direction: 'vertical',
  getSize: () => project.panel.el.offsetWidth,
  setSize: (px) => {
    layout.leftW = px;
    project.panel.el.style.width = `${px}px`;
  },
  min: 200,
  max: () => Math.min(440, window.innerWidth * 0.4),
  grow: 1,
  onCollapseToggle: () => setLeftCollapsed(true),
  onChange: () => saveLayout(),
});
const rightSplitter = new Splitter({
  direction: 'vertical',
  getSize: () => inspector.panel.el.offsetWidth,
  setSize: (px) => {
    layout.rightW = px;
    inspector.panel.el.style.width = `${px}px`;
  },
  min: 220,
  max: () => Math.min(520, window.innerWidth * 0.45),
  grow: -1,
  onCollapseToggle: () => setRightCollapsed(true),
  onChange: () => saveLayout(),
});
const dockSplitter = new Splitter({
  direction: 'horizontal',
  getSize: () => dock.offsetHeight,
  setSize: (px) => {
    layout.dockH = px;
    dock.style.height = `${px}px`;
  },
  min: 90,
  max: () => Math.min(420, window.innerHeight * 0.5),
  grow: -1,
  onCollapseToggle: () => setDockCollapsed(true),
  onChange: () => saveLayout(),
});

/* ── Panel collapse → rail ────────────────────────────────── */

function makeRail(side: 'left' | 'right', label: string, iconName: string, restore: () => void): HTMLDivElement {
  const rail = el('div', `panel-rail ${side}`);
  rail.appendChild(icon(iconName, 14));
  rail.appendChild(el('span', 'rail-label', label));
  rail.setAttribute('data-tooltip', `Expand ${label}`);
  rail.addEventListener('click', restore);
  return rail;
}
const leftRail = makeRail('left', 'Project', 'panel-left', () => setLeftCollapsed(false));
const rightRail = makeRail('right', 'Inspector', 'panel-right', () => setRightCollapsed(false));
const dockRail = el('div');
dockRail.style.cssText =
  'flex:none;height:20px;background:var(--bg-panel-alt);border-top:1px solid var(--border);display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;';
dockRail.appendChild(icon('panel-bottom', 13));
const dockRailLabel = el('span', undefined, 'Dock');
dockRailLabel.style.cssText =
  'font-size:10px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.5px;';
dockRail.appendChild(dockRailLabel);
dockRail.setAttribute('data-tooltip', 'Expand dock (`)');
dockRail.addEventListener('click', () => setDockCollapsed(false));

function setLeftCollapsed(v: boolean): void {
  layout.leftCollapsed = v;
  project.panel.el.style.display = v ? 'none' : '';
  leftSplitter.el.style.display = v ? 'none' : '';
  leftRail.style.display = v ? '' : 'none';
  saveLayout();
}
function setRightCollapsed(v: boolean): void {
  layout.rightCollapsed = v;
  inspector.panel.el.style.display = v ? 'none' : '';
  rightSplitter.el.style.display = v ? 'none' : '';
  rightRail.style.display = v ? '' : 'none';
  saveLayout();
}
function setDockCollapsed(v: boolean): void {
  layout.dockCollapsed = v;
  dock.style.display = v ? 'none' : '';
  dockSplitter.el.style.display = v ? 'none' : '';
  dockRail.style.display = v ? '' : 'none';
  saveLayout();
}

project.panel.onCollapse(() => setLeftCollapsed(true));
inspector.panel.onCollapse(() => setRightCollapsed(true));
dockCollapseBtn.addEventListener('click', () => setDockCollapsed(true));

/* ── Assemble workbench ───────────────────────────────────── */

project.panel.el.style.width = `${layout.leftW}px`;
inspector.panel.el.style.width = `${layout.rightW}px`;
dock.style.height = `${layout.dockH}px`;

workbench.appendChild(project.panel.el);
workbench.appendChild(leftRail);
workbench.appendChild(leftSplitter.el);
centerCol.appendChild(viewportWrap);
centerCol.appendChild(dockSplitter.el);
centerCol.appendChild(dock);
centerCol.appendChild(dockRail);
workbench.appendChild(centerCol);
workbench.appendChild(rightSplitter.el);
workbench.appendChild(rightRail);
workbench.appendChild(inspector.panel.el);

setLeftCollapsed(layout.leftCollapsed);
setRightCollapsed(layout.rightCollapsed);
setDockCollapsed(layout.dockCollapsed);

/* ── Menus ────────────────────────────────────────────────── */

function downloadArtifact(file: string): void {
  const a = document.createElement('a');
  a.href = `${file}?v=${Date.now()}`;
  a.download = file.split('/').pop() ?? 'export';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const menubar = new MenuBar('EKDRSHTI', 'Tactical 3D Recon', [
  {
    label: 'File',
    items: [
      { label: 'Open Video…', shortcut: 'Ctrl+O', action: () => void pickVideo() },
      { label: 'Open Telemetry…', shortcut: 'Ctrl+Shift+O', action: () => void pickTelemetry() },
      { separator: true },
      {
        label: 'Export',
        submenu: [
          ...EXPORT_FILES.map((f) => ({
            label: `${f.label} — ${f.file.slice(1)}`,
            action: () => downloadArtifact(f.file),
          })),
          { separator: true },
          { label: 'GeoTIFF (planned)', disabled: true },
          { label: 'FBX (planned)', disabled: true },
        ],
      },
      { separator: true },
      { label: 'Quit', action: () => backend.quit() },
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Project Panel', checked: () => !layout.leftCollapsed, action: () => setLeftCollapsed(!layout.leftCollapsed) },
      { label: 'Inspector Panel', checked: () => !layout.rightCollapsed, action: () => setRightCollapsed(!layout.rightCollapsed) },
      { label: 'Bottom Dock', shortcut: '`', checked: () => !layout.dockCollapsed, action: () => setDockCollapsed(!layout.dockCollapsed) },
      { separator: true },
      { label: 'Front View', shortcut: '1', action: () => viewer.setPreset('front') },
      { label: 'Side View', shortcut: '3', action: () => viewer.setPreset('side') },
      { label: 'Top View', shortcut: '7', action: () => viewer.setPreset('top') },
      { label: 'Isometric', shortcut: '5', action: () => viewer.setPreset('iso') },
      { label: 'Frame All', shortcut: 'F', action: () => viewer.frameAll() },
      { separator: true },
      { label: 'Reset Layout', action: resetLayout },
    ],
  },
  {
    label: 'Help',
    items: [
      { label: 'Keyboard Shortcuts', shortcut: '?', action: showShortcuts },
      { label: 'About EKDRSHTI', action: showAbout },
    ],
  },
]);

function resetLayout(): void {
  Object.assign(layout, DEFAULT_LAYOUT);
  project.panel.el.style.width = `${layout.leftW}px`;
  inspector.panel.el.style.width = `${layout.rightW}px`;
  dock.style.height = `${layout.dockH}px`;
  setLeftCollapsed(false);
  setRightCollapsed(false);
  setDockCollapsed(false);
  saveLayout();
}

/* ── Toolbar ──────────────────────────────────────────────── */

const toolbar = el('div', 'toolbar');

function toolBtn(iconName: string, label: string, shortcut: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'btn-tool');
  b.appendChild(icon(iconName, 15));
  b.appendChild(el('span', undefined, label));
  b.setAttribute('data-tooltip', label);
  if (shortcut) b.setAttribute('data-shortcut', shortcut);
  b.addEventListener('click', onClick);
  return b;
}

const g1 = el('div', 'tb-group');
const orbitBtn = toolBtn('orbit', 'Orbit', '', () => setPanMode(false));
const panBtn = toolBtn('hand', 'Pan', '', () => setPanMode(true));
orbitBtn.classList.add('active');
function setPanMode(pan: boolean): void {
  viewer.controls.mouseButtons.LEFT = pan ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  orbitBtn.classList.toggle('active', !pan);
  panBtn.classList.toggle('active', pan);
}
g1.appendChild(orbitBtn);
g1.appendChild(panBtn);
g1.appendChild(toolBtn('house', 'Fit', 'F', () => viewer.frameAll()));
toolbar.appendChild(g1);
toolbar.appendChild(el('div', 'tb-sep'));

const g2 = el('div', 'tb-group');
const presets: [string, ViewPreset, string][] = [
  ['Top', 'top', '7'],
  ['Front', 'front', '1'],
  ['Side', 'side', '3'],
  ['Iso', 'iso', '5'],
];
for (const [label, preset, key] of presets) {
  g2.appendChild(toolBtn('camera', label, key, () => viewer.setPreset(preset)));
}
toolbar.appendChild(g2);
toolbar.appendChild(el('div', 'tb-sep'));

const g3 = el('div', 'tb-group');
const viewSeg = new Segmented(
  [
    { value: 'mesh', label: 'Mesh', icon: 'box' },
    { value: 'points', label: 'Points', icon: 'grid' },
  ],
  store.get('viewMode')
);
viewSeg.onChange((v) => store.set('viewMode', v as 'mesh' | 'points'));
store.on('viewMode', (v) => viewSeg.setValue(v));
g3.appendChild(viewSeg.el);
toolbar.appendChild(g3);
toolbar.appendChild(el('div', 'tb-sep'));

const measureBtn = toolBtn('ruler', 'Measure', 'M', () => {
  store.set('measureMode', !store.get('measureMode'));
});
store.on('measureMode', (on) => {
  measureBtn.classList.toggle('active', on);
  viewportWrap.classList.toggle('measure-armed', on);
  if (!on) {
    store.set('measurePending', null);
    viewer.measure.setPendingPoint(null);
  }
});
toolbar.appendChild(measureBtn);

toolbar.appendChild(el('div', 'tb-spacer'));

/* ── Modals ───────────────────────────────────────────────── */

function modal(title: string, body: HTMLElement): void {
  const overlay = el('div', 'modal-overlay');
  const box = el('div', 'modal');
  const head = el('div', 'modal-header');
  head.appendChild(el('span', undefined, title));
  const x = el('button', 'btn-icon');
  x.appendChild(icon('x', 14));
  x.setAttribute('aria-label', 'Close');
  x.addEventListener('click', () => overlay.remove());
  head.appendChild(x);
  box.appendChild(head);
  const b = el('div', 'modal-body');
  b.appendChild(body);
  box.appendChild(b);
  overlay.appendChild(box);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const esc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', esc, true);
    }
  };
  document.addEventListener('keydown', esc, true);
  document.body.appendChild(overlay);
}

function showShortcuts(): void {
  const grid = el('div', 'shortcut-grid');
  const add = (label: string, keys: string): void => {
    grid.appendChild(el('span', 'sc-label', label));
    const k = el('span', 'sc-keys');
    const kbd = document.createElement('kbd');
    kbd.textContent = keys;
    k.appendChild(kbd);
    grid.appendChild(k);
  };
  const section = (t: string): void => {
    grid.appendChild(el('div', 'sc-section', t));
  };
  section('Files');
  add('Open video', 'Ctrl+O');
  add('Open telemetry', 'Ctrl+Shift+O');
  add('Start reconstruction', 'Ctrl+Enter');
  section('Viewport');
  add('Frame all', 'F');
  add('Front / Side / Top / Iso', '1 / 3 / 7 / 5');
  add('Measure tool', 'M');
  add('Cancel measurement / exit tool', 'Esc');
  section('Workspace');
  add('Toggle bottom dock', '`');
  add('This overlay', '?');
  modal('Keyboard Shortcuts', grid);
}

function showAbout(): void {
  const body = el('div');
  body.innerHTML =
    '<div style="font-weight:600;color:var(--text);margin-bottom:4px">EKDRSHTI — Tactical 3D Recon</div>' +
    '<div class="mono" style="margin-bottom:10px">v0.1.0</div>' +
    '<div>Single-pass UAV aerial mapping: video + telemetry → georeferenced 3D mesh.</div>' +
    '<div style="margin-top:10px">Team Atikrantah</div>';
  modal('About', body);
}

/* ── File picking / drops ─────────────────────────────────── */

async function pickVideo(): Promise<void> {
  const f = await backend.pickFile('video');
  if (f) store.set('video', f);
}
async function pickTelemetry(): Promise<void> {
  const f = await backend.pickFile('telemetry');
  if (f) store.set('telemetry', f);
}

backend.onFileDrop((paths, x, y) => {
  // Route by which drop zone is under the cursor.
  const at = document.elementFromPoint(x, y)?.closest('.dropzone');
  const kind = at?.querySelector('.dz-placeholder')?.textContent?.includes('Telemetry')
    ? 'telemetry'
    : (at as HTMLElement | null)?.dataset.kind ?? inferKind(paths[0]);
  const path = paths[0];
  if (!path) return;
  const input = { path, name: path.split(/[\\/]/).pop() ?? path, sizeBytes: null };
  store.set(kind === 'telemetry' ? 'telemetry' : 'video', input);
  toast('info', 'File loaded', input.name);
});
function inferKind(path: string): 'video' | 'telemetry' {
  return /\.(csv|srt|txt)$/i.test(path) ? 'telemetry' : 'video';
}

/* ── Run pipeline ─────────────────────────────────────────── */

backend.onPipelineLog((msg) => {
  consolePanel.add(msg);
  applyStageEvents(inferStageEvents(msg));

  const extracted = parseFramesExtracted(msg);
  if (extracted !== null) {
    store.patch({ frameTotal: extracted, frameDone: 0 });
  }
  const fp = parseFrameProgress(msg);
  if (fp) store.patch({ frameDone: fp.done, frameTotal: fp.total });

  syncLoadingOverlay();
});

function runningStageLabel(): string | null {
  const stages = store.get('stages');
  const running = STAGE_ORDER.find((id) => stages[id].status === 'running');
  return running ? STAGE_LABELS[running] : null;
}

function syncLoadingOverlay(): void {
  if (store.get('status') !== 'running') {
    viewer.setLoading(null);
    return;
  }
  const stage = runningStageLabel() ?? 'Initialising';
  viewer.setLoading(`${stage}…`);
}

async function startRun(): Promise<void> {
  const video = store.get('video');
  if (!video || store.get('status') === 'running') return;

  const telemetry = store.get('telemetry');
  store.patch({
    status: 'running',
    statusText: 'Running',
    runStartedAt: Date.now(),
    stages: freshStages(),
    frameDone: 0,
    frameTotal: 0,
    modelLoaded: false,
  });
  viewer.setEmptyState('', null);
  syncLoadingOverlay();
  consolePanel.add(
    `[INFO] Starting reconstruction — profile=${store.get('hardwareProfile')} pitch=${store.get('cameraPitchDeg')}° telemetry=${telemetry ? telemetry.name : 'none'}`
  );

  try {
    await backend.runReconstruction({
      videoPath: video.path,
      telemetryPath: telemetry?.path ?? '',
      hardwareProfile: store.get('hardwareProfile'),
      cameraPitchDeg: store.get('cameraPitchDeg'),
    });

    const url = await backend.modelUrl();
    const info = await viewer.loadModel(url);
    store.patch({
      status: 'done',
      statusText: 'Complete',
      modelLoaded: true,
      pointCount: info.vertices,
      faceCount: info.faces,
    });
    viewer.setLoading(null);
    consolePanel.add(
      `[SUCCESS] ✓ Rendered ${info.vertices.toLocaleString('en-US')} ${info.hasFaces ? 'fused surface elements (Mesh)' : 'fused voxels (Points)'}.`
    );
    toast('success', 'Reconstruction complete', `${info.vertices.toLocaleString('en-US')} vertices, ${info.faces.toLocaleString('en-US')} faces`);

    // Scene info — fetch georef JSON; show "—" fields if unavailable.
    try {
      const res = await fetch(`/recon_georeference.json?v=${Date.now()}`);
      store.set('georef', res.ok ? ((await res.json()) as Record<string, unknown>) : null);
    } catch {
      store.set('georef', null);
    }
    outputsPanel.refresh();
    inspector.renderExports('refresh');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    consolePanel.add(`[FATAL] ${msg}`);
    applyStageEvents(inferStageEvents(msg));
    // If the error string carried no stage info, mark the running stage failed.
    const stages = { ...store.get('stages') };
    const running = STAGE_ORDER.find((id) => stages[id].status === 'running');
    if (running && inferStageEvents(msg).length === 0) {
      const cur = { ...stages[running] };
      cur.status = 'error';
      cur.elapsedMs = cur.startedAt ? Date.now() - cur.startedAt : null;
      stages[running] = cur;
      store.set('stages', stages);
    }
    store.patch({ status: 'error', statusText: 'Error' });
    viewer.setLoading(null);
    toast('error', 'Reconstruction failed', msg.slice(0, 140));
    if (!viewer.hasModel()) {
      showEmptyState();
    }
  }
}

project.onStart = () => void startRun();

/* ── Empty state + measure wiring ─────────────────────────── */

function showEmptyState(): void {
  viewer.setEmptyState(
    'Load a video and telemetry to begin',
    '<kbd>Ctrl+O</kbd> open video &nbsp;·&nbsp; <kbd>Ctrl+Enter</kbd> start reconstruction'
  );
}
if (!viewer.hasModel()) showEmptyState();

viewer.onCursor = (p) => store.set('cursor', p);

viewer.onModelClick = (p) => {
  if (!store.get('measureMode')) return;
  const pending = store.get('measurePending');
  if (!pending) {
    store.set('measurePending', [p.x, p.y, p.z]);
    viewer.measure.setPendingPoint([p.x, p.y, p.z]);
  } else {
    const m = { id: Date.now(), a: pending, b: [p.x, p.y, p.z] as [number, number, number] };
    store.set('measurements', [...store.get('measurements'), m]);
    store.set('measurePending', null);
    viewer.measure.setPendingPoint(null);
  }
};
store.on('measurements', (ms) => {
  // Sync 3D objects: add new, drop removed.
  viewer.measure.clearAll();
  for (const m of ms) viewer.measure.add(m);
});

/* ── Store → viewer bindings ──────────────────────────────── */

store.on('viewMode', (v) => viewer.setViewMode(v));
store.on('colorMode', (v) => viewer.setColorMode(v));
store.on('pointSize', (v) => viewer.setPointSize(v));
store.on('showGrid', (v) => viewer.setGrid(v));
store.on('viewportBg', (v) => viewer.setBackground(v));

/* ── Keyboard shortcuts ───────────────────────────────────── */

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

  if (e.ctrlKey && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    if (e.shiftKey) void pickTelemetry();
    else void pickVideo();
    return;
  }
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    void startRun();
    return;
  }
  if (typing) return;

  switch (e.key) {
    case 'f':
    case 'F':
      viewer.frameAll();
      break;
    case '1':
      viewer.setPreset('front');
      break;
    case '3':
      viewer.setPreset('side');
      break;
    case '7':
      viewer.setPreset('top');
      break;
    case '5':
      viewer.setPreset('iso');
      break;
    case 'm':
    case 'M':
      store.set('measureMode', !store.get('measureMode'));
      break;
    case '`':
      setDockCollapsed(!layout.dockCollapsed);
      break;
    case '?':
      showShortcuts();
      break;
    case 'Escape':
      if (store.get('measurePending')) {
        store.set('measurePending', null);
        viewer.measure.setPendingPoint(null);
      } else if (store.get('measureMode')) {
        store.set('measureMode', false);
      }
      break;
  }
});

/* ── Boot ─────────────────────────────────────────────────── */

app.appendChild(menubar.el);
app.appendChild(toolbar);
app.appendChild(workbench);
app.appendChild(statusBar.el);
initTooltips();

consolePanel.add('[SYS] Viewport initialised. Standing by for payload…');
consolePanel.add(`[GPU] Viewport WebGL: ${viewer.gpuName}`);
consolePanel.add('[SYS] Ready. Select video and telemetry, then Start Reconstruction.');
if (backend.isMock) {
  consolePanel.add('[SYS] Mock backend active — no Tauri runtime detected.');
}
