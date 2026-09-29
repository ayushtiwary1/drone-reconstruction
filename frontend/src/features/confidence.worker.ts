interface CameraSample { frame: number; cam: number[] }

self.onmessage = (event: MessageEvent<{
  positions: ArrayBuffer;
  ids: ArrayBuffer;
  views: ArrayBuffer | null;
  cams: CameraSample[];
  translate: number[];
}>) => {
  const { positions, ids, views, cams, translate } = event.data;
  const pos = new Float32Array(positions);
  const frameIds = new Uint16Array(ids);
  const viewCounts = views ? new Uint16Array(views) : null;
  const n = frameIds.length;
  const conf = new Float32Array(n);
  const camMap = new Map(cams.map((c) => [c.frame, c.cam]));
  const dists = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = camMap.get(frameIds[i]);
    if (!c) continue;
    const j = i * 3;
    const dx = pos[j] - c[0] - translate[0];
    const dy = pos[j + 1] - c[1] - translate[1];
    const dz = pos[j + 2] - c[2] - translate[2];
    dists[i] = Math.hypot(dx, dy, dz);
  }
  const sample = new Float32Array(Math.ceil(n / 16));
  for (let i = 0; i < sample.length; i++) sample[i] = dists[Math.min(n - 1, i * 16)];
  sample.sort();
  const d90 = Math.max(sample[Math.floor(sample.length * .9)], 1e-3);
  const cell = 1.5;
  const grid = new Map<string, { sum: number; count: number }>();
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const key = `${Math.floor(pos[j] / cell)},${Math.floor(pos[j + 2] / cell)}`;
    const entry = grid.get(key) ?? { sum: 0, count: 0 };
    entry.sum += pos[j + 1];
    entry.count++;
    grid.set(key, entry);
  }
  for (let i = 0; i < n; i++) {
    if (frameIds[i] === 65535) { conf[i] = .02; continue; }
    const j = i * 3;
    const key = `${Math.floor(pos[j] / cell)},${Math.floor(pos[j + 2] / cell)}`;
    const entry = grid.get(key)!;
    const gradient = Math.abs(pos[j + 1] - entry.sum / entry.count);
    const views = viewCounts ? viewCounts[i] : 1;
    conf[i] = Math.min(1, views / 6) * .45 + Math.max(0, 1 - dists[i] / d90) * .35 + Math.exp(-gradient * .7) * .2;
  }
  self.postMessage(conf.buffer, { transfer: [conf.buffer] });
};
