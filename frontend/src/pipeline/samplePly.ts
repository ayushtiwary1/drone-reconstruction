/**
 * samplePly — generates a small procedural terrain (~50k vertices) as a binary
 * PLY matching the backend's format (float xyz + uchar rgb + face list).
 * Only ever loaded by the mock backend via dynamic import, so it stays out of
 * the production code path.
 */

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function terrainHeight(x: number, z: number): number {
  return (
    Math.sin(x * 0.045) * Math.cos(z * 0.06) * 5.5 +
    Math.sin(x * 0.13 + 1.7) * Math.cos(z * 0.11 - 0.4) * 2.2 +
    Math.sin(x * 0.31 - 0.8) * Math.sin(z * 0.27 + 2.1) * 0.9 +
    (hash2(Math.floor(x * 0.5), Math.floor(z * 0.5)) - 0.5) * 0.4
  );
}

function terrainColor(h: number, x: number, z: number): [number, number, number] {
  // Earthy aerial-survey palette: low = dark olive, high = light tan.
  const t = Math.min(1, Math.max(0, (h + 8) / 16));
  const n = hash2(x * 7.3, z * 9.1) * 0.12 - 0.06;
  const r = 74 + t * 128 + n * 255;
  const g = 82 + t * 118 + n * 220;
  const b = 56 + t * 88 + n * 180;
  return [
    Math.min(255, Math.max(0, Math.round(r))),
    Math.min(255, Math.max(0, Math.round(g))),
    Math.min(255, Math.max(0, Math.round(b))),
  ];
}

let cachedUrl: string | null = null;

export function samplePlyUrl(): string {
  if (cachedUrl) return cachedUrl;

  const N = 224; // 224×224 ≈ 50k vertices
  const EXTENT = 120; // metres
  const verts = N * N;
  const quads = (N - 1) * (N - 1);
  const faces = quads * 2;

  const header =
    'ply\nformat binary_little_endian 1.0\n' +
    `element vertex ${verts}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\n' +
    `element face ${faces}\n` +
    'property list uchar int vertex_indices\nend_header\n';

  const headerBytes = new TextEncoder().encode(header);
  const vertBytes = verts * 15;
  const faceBytes = faces * 13;
  const buf = new ArrayBuffer(headerBytes.length + vertBytes + faceBytes);
  const u8 = new Uint8Array(buf);
  u8.set(headerBytes, 0);
  const dv = new DataView(buf);

  let off = headerBytes.length;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const x = (ix / (N - 1) - 0.5) * EXTENT;
      const z = (iz / (N - 1) - 0.5) * EXTENT;
      const y = terrainHeight(x, z);
      const [r, g, b] = terrainColor(y, x, z);
      dv.setFloat32(off, x, true);
      dv.setFloat32(off + 4, y, true);
      dv.setFloat32(off + 8, z, true);
      u8[off + 12] = r;
      u8[off + 13] = g;
      u8[off + 14] = b;
      off += 15;
    }
  }
  for (let iz = 0; iz < N - 1; iz++) {
    for (let ix = 0; ix < N - 1; ix++) {
      const i00 = iz * N + ix;
      const i10 = i00 + 1;
      const i01 = i00 + N;
      const i11 = i01 + 1;
      for (const tri of [[i00, i10, i01], [i10, i11, i01]]) {
        u8[off] = 3;
        dv.setInt32(off + 1, tri[0], true);
        dv.setInt32(off + 5, tri[1], true);
        dv.setInt32(off + 9, tri[2], true);
        off += 13;
      }
    }
  }

  cachedUrl = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
  return cachedUrl;
}
