/**
 * Tiny typed observable store — no framework.
 * Panels subscribe to individual keys; `set` notifies synchronously.
 */

export type HardwareProfile = 'edge_fast' | 'balanced' | 'high_accuracy';
export type ViewMode = 'mesh' | 'points';
export type ColorMode = 'rgb' | 'elevation';
export type ViewportBg = 'dark' | 'mid';
export type RunStatus = 'idle' | 'running' | 'done' | 'error';
export type StageId =
  | 'extract'
  | 'telemetry'
  | 'inference'
  | 'fusion'
  | 'meshing'
  | 'export';
export type StageStatus = 'pending' | 'running' | 'done' | 'error';

export interface StageInfo {
  status: StageStatus;
  startedAt: number | null;
  elapsedMs: number | null;
}

export interface LogEntry {
  id: number;
  time: number;
  text: string;
  severity: 'info' | 'warn' | 'error' | 'success' | 'dim';
}

export interface FileInput {
  path: string;
  name: string;
  sizeBytes: number | null;
}

export interface Measurement {
  id: number;
  a: [number, number, number];
  b: [number, number, number];
}

export interface AppState {
  video: FileInput | null;
  telemetry: FileInput | null;
  hardwareProfile: HardwareProfile;
  cameraPitchDeg: number;
  viewMode: ViewMode;
  colorMode: ColorMode;
  pointSize: number;
  showGrid: boolean;
  viewportBg: ViewportBg;
  status: RunStatus;
  statusText: string;
  runStartedAt: number | null;
  frameDone: number;
  frameTotal: number;
  stages: Record<StageId, StageInfo>;
  modelLoaded: boolean;
  pointCount: number;
  faceCount: number;
  cursor: [number, number, number] | null;
  gpuName: string;
  measureMode: boolean;
  measurePending: [number, number, number] | null;
  measurements: Measurement[];
  georef: Record<string, unknown> | null;
  consoleFilter: 'all' | 'info' | 'warn' | 'error';
}

export function freshStages(): Record<StageId, StageInfo> {
  const blank = (): StageInfo => ({ status: 'pending', startedAt: null, elapsedMs: null });
  return {
    extract: blank(),
    telemetry: blank(),
    inference: blank(),
    fusion: blank(),
    meshing: blank(),
    export: blank(),
  };
}

type Handler<K extends keyof AppState> = (value: AppState[K]) => void;

export class Store {
  private state: AppState;
  private handlers = new Map<keyof AppState, Set<Handler<never>>>();

  constructor(initial: AppState) {
    this.state = initial;
  }

  get<K extends keyof AppState>(key: K): AppState[K] {
    return this.state[key];
  }

  set<K extends keyof AppState>(key: K, value: AppState[K]): void {
    if (Object.is(this.state[key], value)) return;
    this.state = { ...this.state, [key]: value };
    const set = this.handlers.get(key);
    if (set) for (const h of set) (h as Handler<K>)(value);
  }

  patch(patch: Partial<AppState>): void {
    for (const k of Object.keys(patch) as (keyof AppState)[]) {
      this.set(k, patch[k] as never);
    }
  }

  on<K extends keyof AppState>(key: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  /** Subscribe to a key and immediately invoke with the current value. */
  bind<K extends keyof AppState>(key: K, handler: Handler<K>): () => void {
    handler(this.state[key]);
    return this.on(key, handler);
  }
}

export function createInitialState(): AppState {
  return {
    video: null,
    telemetry: null,
    hardwareProfile: 'balanced',
    cameraPitchDeg: -45,
    viewMode: 'mesh',
    colorMode: 'rgb',
    pointSize: 2.0,
    showGrid: true,
    viewportBg: 'dark',
    status: 'idle',
    statusText: 'Ready',
    runStartedAt: null,
    frameDone: 0,
    frameTotal: 0,
    stages: freshStages(),
    modelLoaded: false,
    pointCount: 0,
    faceCount: 0,
    cursor: null,
    gpuName: '—',
    measureMode: false,
    measurePending: null,
    measurements: [],
    georef: null,
    consoleFilter: 'all',
  };
}

export const store = new Store(createInitialState());
