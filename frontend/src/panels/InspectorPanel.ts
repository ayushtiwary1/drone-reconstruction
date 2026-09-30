/**
 * InspectorPanel — right sidebar. Collapsible sections:
 *   Reconstruction (profile segmented + camera pitch dropdown)
 *   Display (mesh/points, point size, colour mode, grid, background)
 *   Measurements (list + footnote)
 *   Scene Info (georef JSON key/value table)
 *   Exports (one row per format + planned rows)
 */

import { icon, el } from '../ui/icons.ts';
import { store, type HardwareProfile } from '../state/store.ts';
import { Panel, Section, field } from '../ui/Panel.ts';
import { Segmented } from '../ui/Segmented.ts';
import { Dropdown } from '../ui/Dropdown.ts';
import { Slider } from '../ui/Slider.ts';
import { EXPORT_FILES, exportFileSize, exportUrl, formatBytes } from '../pipeline/backend.ts';
import { measureStats } from '../viewer/measure.ts';

const PROFILE_CELL: Record<HardwareProfile, string> = {
  edge_fast: '10 cm fusion cell',
  balanced: '5 cm fusion cell',
  high_accuracy: '1.5 cm fusion cell',
};

export class InspectorPanel {
  readonly panel: Panel;
  private profileSub: HTMLDivElement;
  private measurementsBody: HTMLDivElement;
  private georefBody: HTMLDivElement;
  private exportsBody: HTMLDivElement;
  private captureBody!: HTMLDivElement;
  private limitsBody!: HTMLDivElement;

  constructor() {
    this.panel = new Panel('Inspector', 'panel-right');

    /* ── Reconstruction ────────────────────────────────── */
    const recon = new Section('Reconstruction');
    const profileSeg = new Segmented(
      [
        { value: 'edge_fast', label: 'Fast', tooltip: '10 cm fusion cell — quickest, coarsest' },
        { value: 'balanced', label: 'Balanced', tooltip: '5 cm fusion cell' },
        { value: 'high_accuracy', label: 'High Detail', tooltip: '1.5 cm fusion cell — slowest, densest' },
      ],
      store.get('hardwareProfile'),
      true
    );
    this.profileSub = el('div', 'field-sub', PROFILE_CELL[store.get('hardwareProfile')]);
    profileSeg.onChange((v) => {
      const p = v as HardwareProfile;
      store.set('hardwareProfile', p);
      this.profileSub.textContent = PROFILE_CELL[p];
    });
    recon.body.appendChild(field('Hardware Profile', profileSeg.el));
    recon.body.appendChild(this.profileSub);

    const pitchDrop = new Dropdown(
      [
        { value: '-90', label: 'Nadir (−90°)' },
        { value: '-60', label: '−60°' },
        { value: '-45', label: '−45° (Standard Oblique)' },
        { value: '-30', label: '−30°' },
        { value: '-20', label: '−20°' },
      ],
      String(store.get('cameraPitchDeg'))
    );
    pitchDrop.onChange((v) => store.set('cameraPitchDeg', parseFloat(v)));
    const pitchField = field(
      'Camera Pitch (manual override)',
      pitchDrop.el,
      undefined,
      'Will auto-read from gimbal telemetry in a future build.'
    );
    recon.body.appendChild(pitchField);
    this.panel.body.appendChild(recon.el);

    /* ── Display ───────────────────────────────────────── */
    const display = new Section('Display');
    const viewSeg = new Segmented(
      [
        { value: 'mesh', label: 'Coloured Mesh', icon: 'box' },
        { value: 'points', label: 'Points', icon: 'grid' },
      ],
      store.get('viewMode'),
      true
    );
    viewSeg.onChange((v) => store.set('viewMode', v as 'mesh' | 'points'));
    store.on('viewMode', (v) => viewSeg.setValue(v));
    display.body.appendChild(field('Geometry', viewSeg.el));

    const sizeSlider = new Slider(1, 4, 0.5, store.get('pointSize'), '');
    sizeSlider.onChange((v) => store.set('pointSize', v));
    store.on('pointSize', (v) => sizeSlider.setValue(v));
    display.body.appendChild(field('Point size (px)', sizeSlider.el));

    const colorDrop = new Dropdown(
      [
        { value: 'rgb', label: 'RGB (camera colour)' },
        { value: 'elevation', label: 'Elevation (height ramp)' },
        { value: 'confidence', label: 'Confidence (view/distance/holes)' },
        { value: 'hillshade', label: 'Hillshade (multi-light)' },
      ],
      store.get('colorMode')
    );
    colorDrop.onChange((v) => store.set('colorMode', v as 'rgb' | 'elevation' | 'confidence' | 'hillshade'));
    store.on('colorMode', (v) => colorDrop.setValue(v));
    display.body.appendChild(field('Colour mode', colorDrop.el));

    const unobsRow = el('div');
    unobsRow.style.display = 'flex';
    unobsRow.style.alignItems = 'center';
    unobsRow.style.justifyContent = 'space-between';
    unobsRow.appendChild(el('span', 'field-label', 'Hide unobserved (hole-filled)'));
    const unobsToggle = el('button', 'toggle');
    unobsToggle.setAttribute('role', 'switch');
    unobsToggle.addEventListener('click', () => {
      store.set('hideUnobserved', !store.get('hideUnobserved'));
    });
    store.on('hideUnobserved', (on) => unobsToggle.classList.toggle('on', on));
    unobsRow.appendChild(unobsToggle);
    display.body.appendChild(unobsRow);

    const exagSlider = new Slider(1, 5, 0.25, store.get('reliefExag'), '×');
    exagSlider.onChange((v) => store.set('reliefExag', v));
    store.on('reliefExag', (v) => exagSlider.setValue(v));
    display.body.appendChild(field('Relief exaggeration', exagSlider.el));

    const gridRow = el('div');
    gridRow.style.display = 'flex';
    gridRow.style.alignItems = 'center';
    gridRow.style.justifyContent = 'space-between';
    gridRow.appendChild(el('span', 'field-label', 'Grid'));
    const gridToggle = el('button', 'toggle on');
    gridToggle.setAttribute('role', 'switch');
    gridToggle.addEventListener('click', () => {
      store.set('showGrid', !store.get('showGrid'));
    });
    store.on('showGrid', (on) => gridToggle.classList.toggle('on', on));
    gridRow.appendChild(gridToggle);
    display.body.appendChild(gridRow);

    const bgSeg = new Segmented(
      [
        { value: 'dark', label: 'Dark' },
        { value: 'mid', label: 'Mid-grey' },
      ],
      store.get('viewportBg'),
      true
    );
    bgSeg.onChange((v) => store.set('viewportBg', v as 'dark' | 'mid'));
    display.body.appendChild(field('Background', bgSeg.el));
    this.panel.body.appendChild(display.el);

    /* ── Measurements ──────────────────────────────────── */
    const measSection = new Section('Measurements');
    this.measurementsBody = el('div');
    this.measurementsBody.appendChild(el('div', 'footnote', 'No measurements. Press M to measure.'));
    measSection.body.appendChild(this.measurementsBody);
    measSection.body.appendChild(
      el(
        'div',
        'footnote',
        "Measurements are in the model's local frame; accuracy depends on reconstruction quality."
      )
    );
    this.panel.body.appendChild(measSection.el);
    store.on('measurements', () => this.renderMeasurements());

    /* ── Capture Report (T10) ──────────────────────────── */
    const capSection = new Section('Capture Report');
    this.captureBody = el('div');
    this.captureBody.appendChild(el('div', 'footnote', 'Run a reconstruction to see the GO / NO-GO verdict.'));
    capSection.body.appendChild(this.captureBody);
    this.panel.body.appendChild(capSection.el);
    store.on('captureReport', () => this.renderCapture());

    /* ── Accuracy & Limits (T15) ───────────────────────── */
    const accSection = new Section('Accuracy & Limits');
    this.limitsBody = el('div');
    this.limitsBody.appendChild(el('div', 'footnote', 'Mode: Rapid 2.5D heightmap — not validated with GCPs.'));
    accSection.body.appendChild(this.limitsBody);
    this.panel.body.appendChild(accSection.el);

    /* ── Scene Info ────────────────────────────────────── */
    const infoSection = new Section('Scene Info');
    this.georefBody = el('div');
    infoSection.body.appendChild(this.georefBody);
    this.panel.body.appendChild(infoSection.el);
    store.bind('georef', () => this.renderGeoref());

    /* ── Exports ───────────────────────────────────────── */
    const expSection = new Section('Exports');
    this.exportsBody = el('div');
    expSection.body.appendChild(this.exportsBody);
    this.panel.body.appendChild(expSection.el);
    this.renderExports(null);
    store.on('status', (s) => {
      if (s === 'done') this.renderExports('refresh');
    });
  }

  /* ── measurements list ───────────────────────────────── */

  private renderMeasurements(): void {
    const ms = store.get('measurements');
    this.measurementsBody.innerHTML = '';
    if (ms.length === 0) {
      this.measurementsBody.appendChild(
        el('div', 'footnote', 'No measurements. Press M to measure.')
      );
      return;
    }
    ms.forEach((m, i) => {
      const row = el('div', 'measure-row');
      row.appendChild(el('span', 'm-name', `M${i + 1}`));
      const st = measureStats(m);
      row.appendChild(
        el('span', 'm-val', `${st.dist3d.toFixed(2)} m (ΔY ${st.dy.toFixed(2)})`)
      );
      const del = el('button', 'btn-icon');
      del.appendChild(icon('trash', 13));
      del.setAttribute('data-tooltip', 'Delete measurement');
      del.addEventListener('click', () => {
        const next = store.get('measurements').filter((x) => x.id !== m.id);
        store.set('measurements', next);
      });
      row.appendChild(del);
      this.measurementsBody.appendChild(row);
    });
  }

  /* ── georef table ────────────────────────────────────── */

  private renderGeoref(): void {
    const data = store.get('georef');
    this.georefBody.innerHTML = '';
    const table = el('table', 'table kv-table');
    const tbody = el('tbody');
    table.appendChild(tbody);
    if (!data) {
      const tr = el('tr');
      tr.appendChild(el('td', undefined, 'Scene info'));
      tr.appendChild(el('td', undefined, '—'));
      tbody.appendChild(tr);
      this.georefBody.appendChild(table);
      return;
    }
    const addRows = (obj: Record<string, unknown>, prefix: string, depth: number): void => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          const tr = el('tr', 'kv-group');
          const td = el('td', undefined, key);
          td.colSpan = 2;
          tr.appendChild(td);
          tbody.appendChild(tr);
          addRows(v as Record<string, unknown>, '', depth + 1);
        } else {
          const tr = el('tr');
          tr.appendChild(el('td', undefined, key));
          const val = Array.isArray(v) ? (v as unknown[]).join(', ') : String(v);
          tr.appendChild(el('td', undefined, val));
          tbody.appendChild(tr);
        }
      }
    };
    addRows(data, '', 0);
    this.georefBody.appendChild(table);
  }

  /* ── capture report (T10) ────────────────────────────── */

  private renderCapture(): void {
    const r = store.get('captureReport');
    this.captureBody.innerHTML = '';
    if (!r) {
      this.captureBody.appendChild(el('div', 'footnote', 'Run a reconstruction to see the GO / NO-GO verdict.'));
      return;
    }
    const verdict = String(r.verdict ?? '—');
    const chip = el('div', `verdict ${verdict === 'GO' ? 'go' : verdict === 'PARTIAL' ? 'partial' : 'nogo'}`, verdict);
    this.captureBody.appendChild(chip);
    const table = el('table', 'table kv-table');
    const tbody = el('tbody');
    table.appendChild(tbody);
    const rows: [string, string][] = [
      ['Frames', String(r.frames ?? '—')],
      ['Blurry frames', `${Number(r.blur_pct ?? 0).toFixed(0)} %`],
      ['Overexposed', `${Number(r.overexposed_pct ?? 0).toFixed(0)} %`],
      ['GPS gaps', String(r.gps_gaps ?? 0)],
      ['GPS/VO disagreements', String(r.gps_disagree_frames ?? 0)],
      ['Sync offset (est.)', `${Number(r.sync_offset_sec ?? 0).toFixed(1)} s`],
      ['Sync confidence', `r=${Number(r.sync_confidence ?? 0).toFixed(2)}`],
      ['Flight type', String(r.flight_type ?? '—')],
    ];
    for (const [k, v] of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', undefined, k));
      tr.appendChild(el('td', undefined, v));
      tbody.appendChild(tr);
    }
    this.captureBody.appendChild(table);
  }

  /* ── accuracy & limits (T15) ─────────────────────────── */

  updateLimits(o: { holePct: number; syncOff: number | null; syncConf: number | null; gpsIntegrity: string }): void {
    this.limitsBody.innerHTML = '';
    const table = el('table', 'table kv-table');
    const tbody = el('tbody');
    table.appendChild(tbody);
    const rows: [string, string][] = [
      ['Mode', 'Rapid 2.5D (heightmap — no facades)'],
      ['GPS integrity', o.gpsIntegrity],
      ['Hole-filled verts', `${o.holePct.toFixed(1)} %`],
      ['Sync offset', o.syncOff !== null ? `${o.syncOff.toFixed(1)} s (r=${(o.syncConf ?? 0).toFixed(2)})` : '—'],
      ['Absolute accuracy', 'GPS-limited (no GCPs)'],
      ['Vertical', 'Depth-model relative relief ± noise'],
    ];
    for (const [k, v] of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', undefined, k));
      tr.appendChild(el('td', undefined, v));
      tbody.appendChild(tr);
    }
    this.limitsBody.appendChild(table);
    this.limitsBody.appendChild(
      el('div', 'footnote',
        'Honest limits: 2.5D only (no building facades/undersides), absolute position is GPS-limited, no GCP validation. Confidence = views + camera distance + local smoothness.')
    );
  }

  /* ── exports list ────────────────────────────────────── */

  renderExports(_mode: string | null): void {
    this.exportsBody.innerHTML = '';
    for (const f of EXPORT_FILES) {
      const row = el('div', 'export-row');
      const ic = el('span', 'fmt-icon');
      ic.appendChild(icon(f.icon, 15));
      row.appendChild(ic);
      row.appendChild(el('span', 'fmt-name', f.label));
      const sizeEl = el('span', 'fmt-size', '—');
      row.appendChild(sizeEl);
      const a = el('a', 'btn-icon') as HTMLAnchorElement;
      a.href = exportUrl(f.file);
      a.download = f.file.split('/').pop() ?? f.label;
      a.appendChild(icon('download', 14));
      a.setAttribute('data-tooltip', `Download ${f.label}`);
      row.appendChild(a);
      this.exportsBody.appendChild(row);
      void exportFileSize(f.file).then((s) => {
        sizeEl.textContent = formatBytes(s);
      });
    }
    for (const planned of ['GeoTIFF', 'FBX']) {
      const row = el('div', 'export-row planned');
      const ic = el('span', 'fmt-icon');
      ic.appendChild(icon('image', 15));
      row.appendChild(ic);
      row.appendChild(el('span', 'fmt-name', planned));
      row.appendChild(el('span', 'fmt-size', '—'));
      const tag = el('span', 'planned-tag', 'Planned');
      row.appendChild(tag);
      row.setAttribute('data-tooltip', 'Planned — not yet implemented');
      this.exportsBody.appendChild(row);
    }
  }
}
