/**
 * ProjectPanel — left sidebar. Inputs (video / telemetry drop zones) plus the
 * pinned "Start Reconstruction" action with inline progress while running.
 */

import { icon, el } from '../ui/icons.ts';
import { store, type FileInput } from '../state/store.ts';
import { backend, formatBytes } from '../pipeline/backend.ts';
import { toast } from '../ui/Toast.ts';
import { Panel } from '../ui/Panel.ts';

export class ProjectPanel {
  readonly panel: Panel;
  private videoZone: DropZone;
  private telemetryZone: DropZone;
  private telemetryHint: HTMLDivElement;
  private startBtn: HTMLButtonElement;
  private startLabel: HTMLSpanElement;
  private startIcon: SVGSVGElement;
  private progressBar: HTMLDivElement;
  onStart: (() => void) | null = null;

  constructor() {
    this.panel = new Panel('Project', 'panel-left');
    this.panel.body.classList.add('pad');

    const inputsLabel = el('div', 'field-label', 'Inputs');
    this.panel.body.appendChild(inputsLabel);

    this.videoZone = new DropZone('video', 'Video — .mp4 .mov .mkv', 'video');
    this.telemetryZone = new DropZone('telemetry', 'Telemetry — .csv .srt (optional)', 'file-text');
    this.panel.body.appendChild(this.videoZone.el);
    this.panel.body.appendChild(this.telemetryZone.el);

    this.telemetryHint = el('div', 'field-hint');
    const hintIcon = icon('info', 13);
    this.telemetryHint.appendChild(hintIcon);
    this.telemetryHint.appendChild(
      el('span', undefined, 'No telemetry → visual-odometry mode, reduced accuracy.')
    );
    this.panel.body.appendChild(this.telemetryHint);

    // Pinned footer with the primary action
    const footer = el('div', 'panel-footer');
    this.startBtn = el('button', 'btn btn-accent');
    this.startBtn.style.width = '100%';
    this.startBtn.style.position = 'relative';
    this.startBtn.style.overflow = 'hidden';
    this.startBtn.disabled = true;
    this.startIcon = icon('play', 14);
    this.startBtn.appendChild(this.startIcon);
    this.startLabel = el('span', undefined, 'Start Reconstruction');
    this.startBtn.appendChild(this.startLabel);
    this.progressBar = el('div');
    this.progressBar.style.cssText =
      'position:absolute;left:0;bottom:0;height:2px;background:#fff;width:0%;opacity:0.85;transition:width .15s;';
    this.startBtn.appendChild(this.progressBar);
    this.startBtn.setAttribute('data-shortcut', 'Ctrl+Enter');
    this.startBtn.addEventListener('click', () => this.onStart?.());
    footer.appendChild(this.startBtn);
    this.panel.el.appendChild(footer);

    // Bind after all fields exist — bind() fires immediately.
    store.bind('video', (v) => {
      this.videoZone.setFile(v);
      this.syncStartBtn();
    });
    store.bind('telemetry', (t) => {
      this.telemetryZone.setFile(t);
      this.telemetryHint.hidden = t !== null;
    });
    store.bind('status', () => this.syncStartBtn());
    store.on('frameDone', () => this.syncProgress());
    store.on('frameTotal', () => this.syncProgress());
  }

  private syncStartBtn(): void {
    const running = store.get('status') === 'running';
    const hasVideo = store.get('video') !== null;
    this.startBtn.disabled = running || !hasVideo;
    this.startLabel.textContent = running ? 'Running…' : 'Start Reconstruction';
    const next = running ? spinnerIcon() : icon('play', 14);
    this.startIcon.replaceWith(next);
    this.startIcon = next;
    if (!running) this.progressBar.style.width = '0%';
    this.startBtn.setAttribute(
      'data-tooltip',
      running ? 'Reconstruction in progress' : hasVideo ? 'Run the pipeline' : 'Select a video first'
    );
  }

  private syncProgress(): void {
    const total = store.get('frameTotal');
    const done = store.get('frameDone');
    if (total > 0) this.progressBar.style.width = `${Math.round((done / total) * 100)}%`;
  }
}

function spinnerIcon(): SVGSVGElement {
  const s = icon('spinner', 14);
  s.classList.add('spin');
  return s;
}

/* ── Drop zone ──────────────────────────────────────────── */

class DropZone {
  readonly el: HTMLDivElement;
  private iconEl: HTMLSpanElement;
  private body: HTMLDivElement;
  private kind: 'video' | 'telemetry';

  constructor(kind: 'video' | 'telemetry', placeholder: string, iconName: string) {
    this.kind = kind;
    this.el = el('div', 'dropzone');
    this.el.dataset.kind = kind;
    this.el.setAttribute('role', 'button');
    this.el.setAttribute('tabindex', '0');
    this.iconEl = el('span', 'dz-icon');
    this.iconEl.appendChild(icon(iconName, 18));
    this.body = el('div', 'dz-body');
    this.body.appendChild(el('div', 'dz-placeholder', placeholder));
    this.el.appendChild(this.iconEl);
    this.el.appendChild(this.body);
    this.el.setAttribute(
      'data-tooltip',
      'Click to browse, or drop a file anywhere on this zone'
    );

    this.el.addEventListener('click', () => void this.pick());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void this.pick();
      }
    });
    this.el.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.el.classList.add('dragover');
    });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('dragover'));
    this.el.addEventListener('drop', (e) => {
      e.preventDefault();
      this.el.classList.remove('dragover');
      const f = e.dataTransfer?.files?.[0];
      // In the browser mock there is no absolute path — synthesise one.
      if (f && backend.isMock) {
        this.assign({ path: `/mock/dropped/${f.name}`, name: f.name, sizeBytes: f.size });
      }
    });
  }

  private async pick(): Promise<void> {
    const picked = await backend.pickFile(this.kind);
    if (picked) this.assign(picked);
  }

  assign(f: FileInput): void {
    store.set(this.kind, f);
    toast('info', `${this.kind === 'video' ? 'Video' : 'Telemetry'} loaded`, f.name);
  }

  /** External assignment from the Tauri drag-drop event (real absolute path). */
  assignPath(path: string): void {
    this.assign({ path, name: path.split(/[\\/]/).pop() ?? path, sizeBytes: null });
  }

  setFile(f: FileInput | null): void {
    this.body.innerHTML = '';
    this.el.classList.toggle('filled', f !== null);
    this.el.querySelector('.dz-clear')?.remove();
    if (!f) {
      this.body.appendChild(
        el(
          'div',
          'dz-placeholder',
          this.kind === 'video' ? 'Video — .mp4 .mov .mkv' : 'Telemetry — .csv .srt (optional)'
        )
      );
      return;
    }
    this.body.appendChild(el('div', 'dz-name', f.name));
    this.body.appendChild(
      el('div', 'dz-meta', `${formatBytes(f.sizeBytes)} · ${f.path}`)
    );
    const clear = el('button', 'btn-icon dz-clear');
    clear.appendChild(icon('x', 13));
    clear.setAttribute('data-tooltip', 'Clear file');
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      store.set(this.kind, null);
    });
    this.el.appendChild(clear);
  }
}
