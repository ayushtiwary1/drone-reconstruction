/**
 * logParser — pure, unit-testable parsing of `pipeline-log` strings emitted by
 * the Rust backend (src-tauri/src/lib.rs). Keep the patterns below in sync with
 * the emit! / format! strings there.
 *
 * Backend emits (as of the frozen contract):
 *   [SYSTEM] Initializing tactical 3D reconstruction pipeline...
 *   [TIME] Session initialization: 1.23s
 *   [FFMPEG] Slicing video into 1-fps frames...
 *   [FFMPEG] Hardware acceleration engaged (-hwaccel cuda).
 *   [FFMPEG] Falling back to software frame decoding...
 *   [FFMPEG] 47 frames extracted. (Time: 3.42s)
 *   [TELEMETRY] Loaded 123 smoothed records. Trajectory aligned.
 *   [WARN] Video duration (47.0s) and telemetry duration (45.0s) differ by >2s!
 *   [ODOMETRY] No external telemetry provided. Pure visual odometry driving 3D trajectory.
 *   [CAMERA] HFOV = 77.6°, fx = fy = 441.2px | Input = 756x420 (letterbox rows 0..420)
 *   [FRAME 1/47] fused surface points=12345 | H_agl=15.6m
 *   [TIME] Neural inference & fusion (47 frames): 65.23s
 *   [MESH] Triangulation generated 476378 vertices and 902911 faces. (Time: 2.34s)
 *   [SUCCESS] ✓ Reconstruction complete in 78.9s — N vertices, M faces written ...
 *   [GPU] ✓ CUDA Execution Provider engaged — device 0 (NVIDIA RTX 2050).
 *   [WARN] RUNNING ON CPU: CUDA EP failed: ...
 *
 * Errors arrive via invoke() rejection, same bracket-tag style:
 *   [FFMPEG] ... / [TELEMETRY] ... / [IMAGE] ... / [ONNX] ... / [CPU] ...
 *   [IO] ... / Session lock poisoned: ... / [FATAL] ...
 */

export type StageId =
  | 'extract'
  | 'telemetry'
  | 'inference'
  | 'fusion'
  | 'meshing'
  | 'export';

export const STAGE_ORDER: StageId[] = [
  'extract',
  'telemetry',
  'inference',
  'fusion',
  'meshing',
  'export',
];

export const STAGE_LABELS: Record<StageId, string> = {
  extract: 'Extract Frames',
  telemetry: 'Telemetry',
  inference: 'Depth Inference',
  fusion: 'Fusion',
  meshing: 'Meshing',
  export: 'Export',
};

export type Severity = 'info' | 'warn' | 'error' | 'success' | 'dim';

/** Tag prefixes that count as routine pipeline chatter → rendered dim. */
const DIM_TAGS = /^\[(FRAME\s+\d+\s*\/\s*\d+|FFMPEG|TIME|MESH|CAMERA|TELEMETRY|ODOMETRY|GPU|IO|IMAGE|ONNX|CPU|SYSTEM)\]/;

/** Classify a raw log line into a severity for console colouring. */
export function classifySeverity(msg: string): Severity {
  if (/\[(FATAL|ERROR)\]/.test(msg)) return 'error';
  if (/\[WARN\]|✗/.test(msg)) return 'warn';
  if (/\[SUCCESS\]|✓/.test(msg)) return 'success';
  // Error strings returned by invoke() use these tags without FATAL prefix.
  if (/^\[(IO|IMAGE|ONNX|CPU)\].*(fail|cannot|error)/i.test(msg)) return 'error';
  if (DIM_TAGS.test(msg)) return 'dim';
  if (/error|fail/i.test(msg)) return 'error';
  return 'info';
}

/** `[FFMPEG] 47 frames extracted.` → 47 */
export function parseFramesExtracted(msg: string): number | null {
  const m = msg.match(/\[FFMPEG\]\s+(\d+)\s+frames extracted/);
  return m ? parseInt(m[1], 10) : null;
}

/** `[FRAME 3/47] fused surface points=12 | H_agl=15.6m` → {done:3, total:47} */
export function parseFrameProgress(msg: string): { done: number; total: number } | null {
  const m = msg.match(/\[FRAME\s+(\d+)\s*\/\s*(\d+)\]/);
  return m ? { done: parseInt(m[1], 10), total: parseInt(m[2], 10) } : null;
}

/** Fused-surface point count reported inside each [FRAME] line. */
export function parseSurfacePoints(msg: string): number | null {
  const m = msg.match(/fused surface points=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** `[TELEMETRY] Loaded 123 smoothed records.` → 123 */
export function parseTelemetryRecords(msg: string): number | null {
  const m = msg.match(/\[TELEMETRY\] Loaded (\d+) smoothed records/);
  return m ? parseInt(m[1], 10) : null;
}

/** Vertex/face counts from the [MESH] triangulation line or the [SUCCESS] summary. */
export function parseMeshCounts(msg: string): { vertices: number; faces: number } | null {
  let m = msg.match(/\[MESH\] Triangulation generated (\d+) vertices and (\d+) faces/);
  if (m) return { vertices: parseInt(m[1], 10), faces: parseInt(m[2], 10) };
  m = msg.match(/—\s*(\d+)\s+vertices,\s*(\d+)\s+faces\s+written/);
  if (m) return { vertices: parseInt(m[1], 10), faces: parseInt(m[2], 10) };
  return null;
}

export interface StageEvent {
  stage: StageId;
  kind: 'start' | 'progress' | 'done' | 'error';
}

/** Map an error tag like [FFMPEG] to the stage that produced it. */
function stageForErrorTag(msg: string): StageId | null {
  const tag = msg.match(/^\[([A-Z]+)\]/)?.[1];
  switch (tag) {
    case 'FFMPEG':
      return 'extract';
    case 'TELEMETRY':
      return 'telemetry';
    case 'IMAGE':
    case 'ONNX':
    case 'CPU':
    case 'GPU':
      return 'inference';
    case 'MESH':
      return 'meshing';
    case 'IO':
      // "[IO] Cannot list frames" happens during extraction; other IO is export.
      return /frames/i.test(msg) ? 'extract' : 'export';
    default:
      return null;
  }
}

/**
 * Map one pipeline-log line to zero or more stage transitions.
 * The mapping mirrors the order of operations in run_reconstruction_inner():
 *   extract → telemetry → inference+fusion (interleaved) → meshing → export.
 */
/** Does this line report a backend failure? (invoke() rejections use the same [TAG] style). */
export function isErrorMessage(msg: string): boolean {
  if (/\[(FATAL|ERROR)\]/.test(msg)) return true;
  if (/lock poisoned/i.test(msg)) return true;
  // Tagged lines that carry failure wording — but not WARN lines (those are recoverable).
  if (/^\[WARN\]/.test(msg)) return false;
  if (/^\[(FFMPEG|TELEMETRY|IO|IMAGE|ONNX|CPU|MESH)\]/.test(msg) && /fail|cannot|error|non-zero|no frames/i.test(msg)) {
    return true;
  }
  return false;
}

export function inferStageEvents(msg: string): StageEvent[] {
  // Errors first — they can arrive via invoke() rejection mid-stage.
  if (isErrorMessage(msg)) {
    const stage = stageForErrorTag(msg);
    return stage ? [{ stage, kind: 'error' }] : [];
  }

  if (/\[FFMPEG\] Slicing video/.test(msg)) {
    return [{ stage: 'extract', kind: 'start' }];
  }
  if (parseFramesExtracted(msg) !== null) {
    return [
      { stage: 'extract', kind: 'done' },
      { stage: 'telemetry', kind: 'start' },
    ];
  }
  if (/^\[FFMPEG\]/.test(msg)) {
    return [{ stage: 'extract', kind: 'progress' }];
  }

  if (/\[WARN\] Video duration .*telemetry duration/.test(msg)) {
    return [{ stage: 'telemetry', kind: 'progress' }];
  }
  if (parseTelemetryRecords(msg) !== null || /^\[ODOMETRY\]/.test(msg)) {
    return [{ stage: 'telemetry', kind: 'done' }];
  }

  if (/^\[CAMERA\]/.test(msg)) {
    return [{ stage: 'inference', kind: 'start' }];
  }
  if (parseFrameProgress(msg) !== null) {
    // Fusion is interleaved with inference in the backend loop — the [FRAME]
    // line reports fused-surface counts, so both advance together.
    return [
      { stage: 'inference', kind: 'progress' },
      { stage: 'fusion', kind: 'progress' },
    ];
  }
  if (/\[TIME\].*inference.*fusion/i.test(msg)) {
    return [
      { stage: 'inference', kind: 'done' },
      { stage: 'fusion', kind: 'done' },
      { stage: 'meshing', kind: 'start' },
    ];
  }

  if (/^\[MESH\] Triangulation generated/.test(msg)) {
    return [
      { stage: 'meshing', kind: 'done' },
      { stage: 'export', kind: 'start' },
    ];
  }

  if (/\[SUCCESS\]|Reconstruction complete/.test(msg)) {
    return [{ stage: 'export', kind: 'done' }];
  }

  return [];
}

/** Elapsed-time suffix "(Time: 3.42s)" / ": 65.23s" in [TIME]/[MESH] lines. */
export function parseReportedTime(msg: string): string | null {
  const m = msg.match(/(?:\(Time:\s*|:\s*)(\d+(?:\.\d+)?(?:ms|s|m))\)?\s*$/) ?? msg.match(/Time:\s*([\d.]+\w+)/);
  return m ? m[1] : null;
}

/** Is this message a run-completion summary? */
export function isRunComplete(msg: string): boolean {
  return /\[SUCCESS\]/.test(msg) || /Reconstruction complete/.test(msg);
}

/** Extract the [TAG] prefix for display, if present. */
export function logTag(msg: string): string | null {
  const m = msg.match(/^\[([A-Z]+(?:\s+\d+\/\d+)?)\]/);
  return m ? m[1] : null;
}
