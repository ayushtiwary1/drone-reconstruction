/**
 * PipelinePanel — horizontal stage strip driven by parsed pipeline-log events.
 * Stages that can't be inferred stay "—" rather than guessing.
 */

import { icon, el } from '../ui/icons.ts';
import { store, freshStages, type StageId } from '../state/store.ts';
import { STAGE_ORDER, STAGE_LABELS } from '../pipeline/logParser.ts';

export class PipelinePanel {
  readonly el: HTMLDivElement;
  private stageEls = new Map<StageId, HTMLDivElement>();
  private statusEls = new Map<StageId, HTMLDivElement>();
  private barEls = new Map<StageId, HTMLDivElement>();
  private ticker: number | null = null;

  constructor() {
    this.el = el('div');
    this.el.style.cssText = 'flex:1;min-height:0;overflow:auto;';
    const strip = el('div', 'pipeline-strip');
    STAGE_ORDER.forEach((id, i) => {
      const card = el('div', 'stage pending');
      card.appendChild(el('div', 'stage-name', `${i + 1}. ${STAGE_LABELS[id]}`));
      const status = el('div', 'stage-status');
      status.appendChild(icon('circle', 13));
      status.appendChild(el('span', 'st-text', '—'));
      card.appendChild(status);
      const barWrap = el('div', 'stage-bar');
      const bar = el('div');
      barWrap.appendChild(bar);
      card.appendChild(barWrap);
      strip.appendChild(card);
      if (i < STAGE_ORDER.length - 1) strip.appendChild(el('div', 'stage-connector'));
      this.stageEls.set(id, card);
      this.statusEls.set(id, status);
      this.barEls.set(id, bar);
    });
    this.el.appendChild(strip);

    store.on('stages', () => this.render());
    store.on('frameDone', () => this.render());
    store.on('status', (s) => {
      if (s === 'running' && this.ticker === null) {
        this.ticker = window.setInterval(() => this.render(), 500);
      } else if (s !== 'running' && this.ticker !== null) {
        clearInterval(this.ticker);
        this.ticker = null;
        this.render();
      }
    });
    this.render();
  }

  private render(): void {
    const stages = store.get('stages');
    const fd = store.get('frameDone');
    const ft = store.get('frameTotal');
    for (const id of STAGE_ORDER) {
      const card = this.stageEls.get(id)!;
      const statusEl = this.statusEls.get(id)!;
      const bar = this.barEls.get(id)!;
      const info = stages[id];
      card.className = `stage ${info.status}`;

      const text = statusEl.querySelector('.st-text') as HTMLSpanElement;
      const iconEl = statusEl.querySelector('svg');
      iconEl?.remove();

      switch (info.status) {
        case 'pending':
          statusEl.prepend(icon('circle', 13));
          text.textContent = '—';
          bar.style.width = '0%';
          break;
        case 'running': {
          const spin = icon('spinner', 13);
          spin.classList.add('spin');
          statusEl.prepend(spin);
          const elapsed = info.startedAt ? fmtElapsed(Date.now() - info.startedAt) : '';
          const prog =
            (id === 'inference' || id === 'fusion') && ft > 0 ? ` ${fd}/${ft}` : '';
          text.textContent = `running${prog}${elapsed ? ' · ' + elapsed : ''}`;
          bar.style.width = id === 'inference' && ft > 0 ? `${(fd / ft) * 100}%` : '100%';
          bar.style.opacity = id === 'inference' && ft > 0 ? '1' : '0.35';
          break;
        }
        case 'done': {
          statusEl.prepend(icon('check-circle', 13));
          text.textContent = info.elapsedMs !== null ? fmtElapsed(info.elapsedMs) : 'done';
          bar.style.opacity = '1';
          break;
        }
        case 'error':
          statusEl.prepend(icon('error', 13));
          text.textContent = 'error';
          bar.style.width = '100%';
          bar.style.opacity = '1';
          break;
      }
    }
  }
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Apply parsed stage events to the store (single source of truth). */
export function applyStageEvents(events: { stage: StageId; kind: string }[]): void {
  if (events.length === 0) return;
  const stages = { ...store.get('stages') };
  const now = Date.now();
  for (const ev of events) {
    const cur = { ...stages[ev.stage] };
    switch (ev.kind) {
      case 'start':
        if (cur.status === 'pending') {
          cur.status = 'running';
          cur.startedAt = now;
        }
        break;
      case 'progress':
        if (cur.status === 'pending') {
          cur.status = 'running';
          cur.startedAt = now;
        }
        break;
      case 'done':
        cur.status = 'done';
        cur.elapsedMs = cur.startedAt ? now - cur.startedAt : null;
        break;
      case 'error':
        cur.status = 'error';
        cur.elapsedMs = cur.startedAt ? now - cur.startedAt : null;
        break;
    }
    stages[ev.stage] = cur;
  }
  store.set('stages', stages);
}

export function resetStages(): void {
  store.set('stages', freshStages());
}
