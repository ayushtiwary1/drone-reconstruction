import { describe, it, expect } from 'vitest';
import {
  classifySeverity,
  parseFramesExtracted,
  parseFrameProgress,
  parseSurfacePoints,
  parseTelemetryRecords,
  parseMeshCounts,
  inferStageEvents,
  isRunComplete,
  logTag,
} from './logParser.ts';

describe('classifySeverity', () => {
  it('marks FATAL/ERROR tags as error', () => {
    expect(classifySeverity('[FATAL] Background thread execution failed: x')).toBe('error');
    expect(classifySeverity('[ERROR] Select a video payload before starting.')).toBe('error');
  });
  it('marks backend error strings (IO/ONNX/CPU/IMAGE) as error', () => {
    expect(classifySeverity('[IO] Cannot create PLY: Permission denied')).toBe('error');
    expect(classifySeverity('[ONNX] Inference failed on frame 3: oom')).toBe('error');
    expect(classifySeverity('[CPU] Session build failed: missing')).toBe('error');
    expect(classifySeverity('[IMAGE] Cannot open first frame: io error')).toBe('error');
  });
  it('marks WARN and ✗ as warn', () => {
    expect(classifySeverity('[WARN] RUNNING ON CPU: CUDA EP failed: nope')).toBe('warn');
    expect(classifySeverity('[WARN] Video duration (47.0s) and telemetry duration (45.0s) differ by >2s!')).toBe('warn');
  });
  it('marks SUCCESS and ✓ as success', () => {
    expect(classifySeverity('[SUCCESS] ✓ Reconstruction complete in 78.9s — 1 vertices, 2 faces written (PLY, OBJ, LAS, GLB & GeoRef). Export time: 1.0s')).toBe('success');
    expect(classifySeverity('[GPU] ✓ CUDA Execution Provider engaged — device 0 (NVIDIA RTX 2050).')).toBe('success');
  });
  it('marks pipeline tag chatter as dim', () => {
    expect(classifySeverity('[FFMPEG] Slicing video into 1-fps frames...')).toBe('dim');
    expect(classifySeverity('[FRAME 3/47] fused surface points=12 | H_agl=15.6m')).toBe('dim');
    expect(classifySeverity('[TIME] Session initialization: 1.23s')).toBe('dim');
    expect(classifySeverity('[CAMERA] HFOV = 77.6°, fx = fy = 441.2px | Input = 756x420 (letterbox rows 0..420)')).toBe('dim');
    expect(classifySeverity('[TELEMETRY] Loaded 42 smoothed records. Trajectory aligned.')).toBe('dim');
    expect(classifySeverity('[MESH] Triangulation generated 10 vertices and 20 faces. (Time: 2.34s)')).toBe('dim');
  });
  it('marks frontend system/info lines as info', () => {
    expect(classifySeverity('[SYS] Viewport initialised.')).toBe('info');
    expect(classifySeverity('[INFO] Starting reconstruction')).toBe('info');
  });
});

describe('parseFramesExtracted', () => {
  it('parses the count', () => {
    expect(parseFramesExtracted('[FFMPEG] 47 frames extracted. (Time: 3.42s)')).toBe(47);
    expect(parseFramesExtracted('[FFMPEG] 1 frames extracted.')).toBe(1);
  });
  it('rejects unrelated lines', () => {
    expect(parseFramesExtracted('[FFMPEG] Slicing video into 1-fps frames...')).toBeNull();
    expect(parseFramesExtracted('[FRAME 1/47] fused surface points=1 | H_agl=1.0m')).toBeNull();
  });
});

describe('parseFrameProgress', () => {
  it('parses i/N progress', () => {
    expect(parseFrameProgress('[FRAME 12/47] fused surface points=999 | H_agl=15.6m')).toEqual({ done: 12, total: 47 });
    expect(parseFrameProgress('[FRAME 1/1] fused surface points=0 | H_agl=0.0m')).toEqual({ done: 1, total: 1 });
  });
  it('rejects non-frame lines', () => {
    expect(parseFrameProgress('[FFMPEG] 47 frames extracted.')).toBeNull();
  });
});

describe('parseSurfacePoints / parseTelemetryRecords / parseMeshCounts', () => {
  it('parses surface point counts', () => {
    expect(parseSurfacePoints('[FRAME 1/47] fused surface points=12345 | H_agl=15.6m')).toBe(12345);
  });
  it('parses telemetry record counts', () => {
    expect(parseTelemetryRecords('[TELEMETRY] Loaded 123 smoothed records. Trajectory aligned.')).toBe(123);
    expect(parseTelemetryRecords('[ODOMETRY] No external telemetry provided.')).toBeNull();
  });
  it('parses mesh counts from [MESH] and [SUCCESS] summary lines', () => {
    expect(parseMeshCounts('[MESH] Triangulation generated 476378 vertices and 902911 faces. (Time: 2.34s)')).toEqual({ vertices: 476378, faces: 902911 });
    expect(parseMeshCounts('[SUCCESS] ✓ Reconstruction complete in 78.9s — 476378 vertices, 902911 faces written (PLY, OBJ, LAS, GLB & GeoRef). Export time: 1.23s')).toEqual({ vertices: 476378, faces: 902911 });
    expect(parseMeshCounts('[MESH] something else')).toBeNull();
  });
});

describe('inferStageEvents', () => {
  it('maps the happy-path sequence in order', () => {
    const seq: [string, { stage: string; kind: string }[]][] = [
      ['[FFMPEG] Slicing video into 1-fps frames...', [{ stage: 'extract', kind: 'start' }]],
      ['[FFMPEG] Hardware acceleration engaged (-hwaccel cuda).', [{ stage: 'extract', kind: 'progress' }]],
      ['[FFMPEG] Falling back to software frame decoding...', [{ stage: 'extract', kind: 'progress' }]],
      ['[FFMPEG] 47 frames extracted. (Time: 3.42s)', [
        { stage: 'extract', kind: 'done' },
        { stage: 'telemetry', kind: 'start' },
      ]],
      ['[TELEMETRY] Loaded 42 smoothed records. Trajectory aligned.', [{ stage: 'telemetry', kind: 'done' }]],
      ['[CAMERA] HFOV = 77.6°, fx = fy = 441.2px | Input = 756x420 (letterbox rows 0..420)', [{ stage: 'inference', kind: 'start' }]],
      ['[FRAME 1/47] fused surface points=100 | H_agl=15.6m', [
        { stage: 'inference', kind: 'progress' },
        { stage: 'fusion', kind: 'progress' },
      ]],
      ['[TIME] Neural inference & fusion (47 frames): 65.23s', [
        { stage: 'inference', kind: 'done' },
        { stage: 'fusion', kind: 'done' },
        { stage: 'meshing', kind: 'start' },
      ]],
      ['[MESH] Triangulation generated 476378 vertices and 902911 faces. (Time: 2.34s)', [
        { stage: 'meshing', kind: 'done' },
        { stage: 'export', kind: 'start' },
      ]],
      ['[SUCCESS] ✓ Reconstruction complete in 78.9s — 476378 vertices, 902911 faces written (PLY, OBJ, LAS, GLB & GeoRef). Export time: 1.23s', [{ stage: 'export', kind: 'done' }]],
    ];
    for (const [msg, expected] of seq) {
      expect(inferStageEvents(msg), msg).toEqual(expected);
    }
  });

  it('handles the visual-odometry telemetry path', () => {
    expect(inferStageEvents('[ODOMETRY] No external telemetry provided. Pure visual odometry driving 3D trajectory.')).toEqual([
      { stage: 'telemetry', kind: 'done' },
    ]);
  });

  it('keeps duration-mismatch warnings inside the telemetry stage', () => {
    expect(inferStageEvents('[WARN] Video duration (47.0s) and telemetry duration (45.0s) differ by >2s!')).toEqual([
      { stage: 'telemetry', kind: 'progress' },
    ]);
  });

  it('maps error strings to the failing stage', () => {
    expect(inferStageEvents('[FFMPEG] No frames were extracted. Verify the video file is valid.')).toEqual([{ stage: 'extract', kind: 'error' }]);
    expect(inferStageEvents("[TELEMETRY] Failed to open CSV '/x.csv': io")).toEqual([{ stage: 'telemetry', kind: 'error' }]);
    expect(inferStageEvents('[ONNX] Inference failed on frame 2: x')).toEqual([{ stage: 'inference', kind: 'error' }]);
    expect(inferStageEvents('[IO] Cannot create PLY: disk full')).toEqual([{ stage: 'export', kind: 'error' }]);
    expect(inferStageEvents('[IO] Cannot list frames: gone')).toEqual([{ stage: 'extract', kind: 'error' }]);
    expect(inferStageEvents('[FATAL] Background thread execution failed: x')).toEqual([]);
  });

  it('ignores non-pipeline lines', () => {
    expect(inferStageEvents('[SYS] Viewport initialised.')).toEqual([]);
    expect(inferStageEvents('[GPU] ✓ CUDA Execution Provider engaged — device 0 (NVIDIA RTX 2050).')).toEqual([]);
    expect(inferStageEvents('[TIME] Session initialization: 1.23s')).toEqual([]);
  });
});

describe('isRunComplete / logTag', () => {
  it('detects completion', () => {
    expect(isRunComplete('[SUCCESS] ✓ Reconstruction complete in 1.0s — 1 vertices, 1 faces written')).toBe(true);
    expect(isRunComplete('[FRAME 1/2] fused surface points=1 | H_agl=1.0m')).toBe(false);
  });
  it('extracts tag prefixes', () => {
    expect(logTag('[FFMPEG] x')).toBe('FFMPEG');
    expect(logTag('[FRAME 3/47] x')).toBe('FRAME 3/47');
    expect(logTag('no tag')).toBeNull();
  });
});
