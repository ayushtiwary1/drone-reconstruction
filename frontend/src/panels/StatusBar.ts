/**
 * StatusBar — bottom strip: status dot, stage i/N, elapsed, cursor XYZ, GPU.
 */

import { el } from '../ui/icons.ts';
import { store } from '../state/store.ts';
import { STAGE_ORDER, STAGE_LABELS } from '../pipeline/logParser.ts';

export class StatusBar {
  readonly el: HTMLDivElement;
  private dot: HTMLSpanElement;
  private statusText: HTMLSpanElement;
  private stageEl: HTMLSpanElement;
  private elapsedEl: HTMLSpanElement;
  private cursorEl: HTMLSpanElement;
  private gpuEl: HTMLSpanElement;
  private gpsEl!: HTMLSpanElement;
  private timer: number | null = null;

  constructor() {
    this.el = el('div', 'statusbar');

    const stItem = el('span', 'st-item');
    this.dot = el('span', 'st-dot ready');
    this.statusText = el('span', undefined, 'Ready');
    stItem.appendChild(this.dot);
    stItem.appendChild(this.statusText);
    this.el.appendChild(stItem);

    this.stageEl = el('span', 'st-item mono', '');
    this.el.appendChild(this.stageEl);
    this.elapsedEl = el('span', 'st-item mono', '');
    this.el.appendChild(this.elapsedEl);

    this.el.appendChild(el('span', 'st-spacer'));

    this.cursorEl = el('span', 'st-item mono', 'cursor —');
    this.el.appendChild(this.cursorEl);
    this.gpsEl = el('span', 'st-item mono', 'GPS —');
    this.gpsEl.setAttribute('data-tooltip', 'GPS integrity (visual cross-check)');
    this.el.appendChild(this.gpsEl);
    this.gpuEl = el('span', 'st-item mono', '');
    this.el.appendChild(this.gpuEl);

    store.bind('status', (s) => this.setStatus(s, store.get('statusText')));
    store.bind('statusText', (t) => this.setStatus(store.get('status'), t));
    store.on('stages', () => this.updateStage());
    store.on('frameDone', () => this.updateStage());
    store.on('frameTotal', () => this.updateStage());
    store.bind('cursor', (c) => this.setCursor(c));
    store.bind('gpuName', (g) => {
      this.gpuEl.textContent = `GPU ${g}`;
      this.gpuEl.setAttribute('data-tooltip', g);
    });
    store.bind('gpsIntegrity', (v) => {
      this.gpsEl.textContent = `GPS ${v}`;
      this.gpsEl.style.color = String(v).startsWith('Suspect')
        ? '#e2a7a7'
        : String(v).startsWith('OK')
          ? '#a7e2a7'
          : '';
    });
    store.on('runStartedAt', () => this.syncTimer());
    store.on('status', () => this.syncTimer());
    this.updateStage();
  }

  private setStatus(status: string, text: string): void {
    this.dot.className =
      'st-dot ' + (status === 'running' ? 'running' : status === 'error' ? 'error' : 'ready');
    this.statusText.textContent = text;
  }

  private updateStage(): void {
    const stages = store.get('stages');
    const doneCount = STAGE_ORDER.filter((id) => stages[id].status === 'done').length;
    const running = STAGE_ORDER.find((id) => stages[id].status === 'running');
    if (store.get('status') === 'idle' && doneCount === 0) {
      this.stageEl.textContent = '';
      return;
    }
    if (running) {
      const idx = STAGE_ORDER.indexOf(running) + 1;
      const fd = store.get('frameDone');
      const ft = store.get('frameTotal');
      const extra = running === 'inference' && ft ? ` · frame ${fd}/${ft}` : '';
      this.stageEl.textContent = `Stage ${idx}/${STAGE_ORDER.length} · ${STAGE_LABELS[running]}${extra}`;
    } else {
      this.stageEl.textContent = `${doneCount}/${STAGE_ORDER.length} stages done`;
    }
  }

  private setCursor(c: [number, number, number] | null): void {
    this.cursorEl.textContent = c
      ? `X ${c[0].toFixed(2)}  Y ${c[1].toFixed(2)}  Z ${c[2].toFixed(2)}`
      : 'cursor —';
  }

  private syncTimer(): void {
    const running = store.get('status') === 'running';
    if (running && this.timer === null) {
      this.timer = window.setInterval(() => this.tick(), 500);
      this.tick();
    } else if (!running && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.tick(); // final value
    }
  }

  private tick(): void {
    const t0 = store.get('runStartedAt');
    if (!t0) {
      this.elapsedEl.textContent = '';
      return;
    }
    const secs = Math.floor((Date.now() - t0) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    this.elapsedEl.textContent = `${mm}:${ss}`;
  }
}
