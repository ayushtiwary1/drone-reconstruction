/**
 * backend.ts — the ONLY module that imports @tauri-apps/*.
 *
 * If Tauri internals are absent (plain browser dev) or Vite was started with
 * `--mode mock` (`npm run dev:mock`), a scripted mock is used instead so the UI
 * can be exercised without Rust/GPU. The real-Tauri path is the default and
 * is identical to the frozen backend contract:
 *   invoke("run_reconstruction", { videoPath, telemetryPath, hardwareProfile, cameraPitchDeg })
 *   listen("pipeline-log", ...)
 */

import type { FileInput, HardwareProfile } from '../state/store.ts';

export interface RunArgs {
  videoPath: string;
  telemetryPath: string;
  hardwareProfile: HardwareProfile;
  cameraPitchDeg: number;
}

export interface Backend {
  readonly isMock: boolean;
  pickFile(kind: 'video' | 'telemetry'): Promise<FileInput | null>;
  runReconstruction(args: RunArgs): Promise<string>;
  onPipelineLog(cb: (msg: string) => void): void;
  onFileDrop(cb: (paths: string[], x: number, y: number) => void): void;
  /** URL the viewer should load after a successful run. */
  modelUrl(): Promise<string>;
  quit(): void;
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const FORCE_MOCK = import.meta.env.MODE === 'mock';

export const MODEL_PATH = '/recon_output.ply';
export const EXPORT_FILES = [
  { id: 'ply', label: 'PLY', file: '/recon_output.ply', icon: 'box' },
  { id: 'obj', label: 'OBJ', file: '/recon_output.obj', icon: 'file-box' },
  { id: 'las', label: 'LAS', file: '/recon_output.las', icon: 'database' },
  { id: 'glb', label: 'GLB', file: '/recon_output.glb', icon: 'package' },
  { id: 'georef', label: 'GeoRef JSON', file: '/recon_georeference.json', icon: 'file-json' },
] as const;

const VIDEO_FILTERS = [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv'] }];
const TELEMETRY_FILTERS = [{ name: 'Telemetry', extensions: ['csv', 'srt', 'txt'] }];

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/* ── Real Tauri backend ─────────────────────────────────── */

function createTauriBackend(): Backend {
  return {
    isMock: false,

    async pickFile(kind) {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        filters: kind === 'video' ? VIDEO_FILTERS : TELEMETRY_FILTERS,
      });
      if (!selected || typeof selected !== 'string') return null;
      // Size requires fs permissions we don't hold — report unknown.
      return { path: selected, name: fileName(selected), sizeBytes: null };
    },

    async runReconstruction(args) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<string>('run_reconstruction', {
        videoPath: args.videoPath,
        telemetryPath: args.telemetryPath,
        hardwareProfile: args.hardwareProfile,
        cameraPitchDeg: args.cameraPitchDeg,
      });
    },

    onPipelineLog(cb) {
      import('@tauri-apps/api/event')
        .then(({ listen }) => listen<string>('pipeline-log', (e) => cb(e.payload)))
        .catch((err) => console.error('[backend] listen failed', err));
    },

    onFileDrop(cb) {
      import('@tauri-apps/api/webview')
        .then(({ getCurrentWebview }) =>
          getCurrentWebview().onDragDropEvent((event) => {
            if (event.payload.type === 'drop') {
              cb(event.payload.paths, event.payload.position.x, event.payload.position.y);
            }
          })
        )
        .catch((err) => console.error('[backend] drag-drop listener failed', err));
    },

    async modelUrl() {
      // Bust cache so Vite serves the freshly written PLY.
      return `${MODEL_PATH}?v=${Date.now()}`;
    },

    quit() {
      import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().close())
        .catch(() => window.close());
    },
  };
}

/* ── Browser mock backend ───────────────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scripted replay — strings copied verbatim from lib.rs emit! calls. */
const MOCK_SCRIPT: [delayMs: number, msg: string][] = [
  [200, '[SYSTEM] Initializing tactical 3D reconstruction pipeline...'],
  [500, '[GPU] ✓ CUDA Execution Provider engaged — device 0 (NVIDIA RTX 2050).'],
  [150, '[TIME] Session initialization: 0.84s'],
  [250, '[FFMPEG] Slicing video into 1-fps frames...'],
  [900, '[FFMPEG] Hardware acceleration engaged (-hwaccel cuda).'],
  [1200, '[FFMPEG] 47 frames extracted. (Time: 3.42s)'],
];

const MOCK_SCRIPT_TELEMETRY: [number, string][] = [
  [350, '[TELEMETRY] Loaded 46 smoothed records. Trajectory aligned.'],
];
const MOCK_SCRIPT_ODOMETRY: [number, string][] = [
  [350, '[ODOMETRY] No external telemetry provided. Pure visual odometry driving 3D trajectory.'],
];

const MOCK_SCRIPT_TAIL: [number, string][] = [
  [250, '[CAMERA] HFOV = 77.6°, fx = fy = 441.2px | Input = 756x420 (letterbox rows 0..420)'],
];

function createMockBackend(): Backend {
  let logCb: ((msg: string) => void) | null = null;

  return {
    isMock: true,

    async pickFile(kind) {
      await sleep(120);
      const path =
        kind === 'video'
          ? '/mock/sortie_0412_survey.mp4'
          : '/mock/sortie_0412_telemetry.srt';
      return { path, name: fileName(path), sizeBytes: kind === 'video' ? 214_734_848 : 62_012 };
    },

    async runReconstruction(args) {
      const emit = (m: string) => logCb?.(m);
      for (const [d, m] of MOCK_SCRIPT) {
        await sleep(d);
        emit(m);
      }
      const mid = args.telemetryPath ? MOCK_SCRIPT_TELEMETRY : MOCK_SCRIPT_ODOMETRY;
      for (const [d, m] of mid) {
        await sleep(d);
        emit(m);
      }
      for (const [d, m] of MOCK_SCRIPT_TAIL) {
        await sleep(d);
        emit(m);
      }
      const total = 24; // abbreviated frame count for a quick mock run
      for (let i = 1; i <= total; i++) {
        await sleep(110);
        emit(`[FRAME ${i}/${total}] fused surface points=${(i * 19847).toLocaleString('en-US').replaceAll(',', '')} | H_agl=15.6m`);
      }
      await sleep(300);
      emit('[TIME] Neural inference & fusion (47 frames): 4.12s');
      await sleep(700);
      emit('[MESH] Triangulation generated 476378 vertices and 902911 faces. (Time: 1.90s)');
      await sleep(800);
      const msg =
        '[SUCCESS] ✓ Reconstruction complete in 12.4s — 476378 vertices, 902911 faces written (PLY, OBJ, LAS, GLB & GeoRef). Export time: 0.61s';
      emit(msg);
      return msg;
    },

    onPipelineLog(cb) {
      logCb = cb;
    },

    onFileDrop() {
      /* Browser drops are handled by the dropzone DOM fallback. */
    },

    async modelUrl() {
      // Prefer the real tracked sample output; fall back to a generated terrain.
      try {
        const res = await fetch(MODEL_PATH, { method: 'HEAD' });
        if (res.ok && Number(res.headers.get('content-length')) > 1024) {
          return `${MODEL_PATH}?v=${Date.now()}`;
        }
      } catch {
        /* fall through */
      }
      const mod = await import('./samplePly.ts');
      return mod.samplePlyUrl();
    },

    quit() {
      window.close();
    },
  };
}

export const backend: Backend = isTauri && !FORCE_MOCK ? createTauriBackend() : createMockBackend();

/** Fetch sizes of export artifacts via HEAD; null when unavailable. */
export async function exportFileSize(file: string): Promise<number | null> {
  try {
    const res = await fetch(`${file}?v=${Date.now()}`, { method: 'HEAD' });
    if (!res.ok) return null;
    const len = res.headers.get('content-length');
    return len ? parseInt(len, 10) : null;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}
