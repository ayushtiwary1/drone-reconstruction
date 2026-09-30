/**
 * ConsolePanel — virtualised log view with severity filter chips, search,
 * copy-all, clear, and auto-scroll that pauses when the user scrolls up.
 */

import { icon, el } from '../ui/icons.ts';
import { toast } from '../ui/Toast.ts';
import { classifySeverity } from '../pipeline/logParser.ts';
import type { Severity } from '../pipeline/logParser.ts';

interface Entry {
  time: string;
  text: string;
  severity: Severity;
}

const ROW_H = 18;
const MAX_ENTRIES = 5000;

export class ConsolePanel {
  readonly el: HTMLDivElement;
  private view: HTMLDivElement;
  private spacer: HTMLDivElement;
  private windowEl: HTMLDivElement;
  private searchInput: HTMLInputElement;
  private entries: Entry[] = [];
  private filtered: Entry[] = [];
  private filter: 'all' | 'info' | 'warn' | 'error' = 'all';
  private stick = true;

  constructor() {
    this.el = el('div');
    this.el.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;';

    // Toolbar
    const bar = el('div', 'console-toolbar');
    const chips: [typeof this.filter, string][] = [
      ['all', 'All'],
      ['info', 'Info'],
      ['warn', 'Warn'],
      ['error', 'Error'],
    ];
    const chipEls = new Map<string, HTMLButtonElement>();
    for (const [id, label] of chips) {
      const c = el('button', 'filter-chip' + (id === 'all' ? ' active' : ''), label);
      c.addEventListener('click', () => {
        this.filter = id;
        for (const [cid, elc] of chipEls) elc.classList.toggle('active', cid === id);
        this.refilter();
      });
      chipEls.set(id, c);
      bar.appendChild(c);
    }

    const searchWrap = el('div', 'console-search');
    const sIcon = icon('search', 13);
    searchWrap.appendChild(sIcon);
    this.searchInput = el('input', 'input mono') as HTMLInputElement;
    this.searchInput.placeholder = 'Filter log…';
    this.searchInput.addEventListener('input', () => this.refilter());
    searchWrap.appendChild(this.searchInput);
    bar.appendChild(searchWrap);

    const copyBtn = el('button', 'btn-icon');
    copyBtn.appendChild(icon('copy', 14));
    copyBtn.setAttribute('data-tooltip', 'Copy all');
    copyBtn.addEventListener('click', () => this.copyAll());
    bar.appendChild(copyBtn);

    const clearBtn = el('button', 'btn-icon');
    clearBtn.appendChild(icon('trash', 14));
    clearBtn.setAttribute('data-tooltip', 'Clear console');
    clearBtn.addEventListener('click', () => this.clear());
    bar.appendChild(clearBtn);
    this.el.appendChild(bar);

    // Virtualised list
    this.view = el('div', 'log-view');
    this.spacer = el('div', 'log-spacer');
    this.windowEl = el('div', 'log-window');
    this.view.appendChild(this.spacer);
    this.view.appendChild(this.windowEl);
    this.view.addEventListener('scroll', () => {
      const atBottom = this.view.scrollTop + this.view.clientHeight >= this.view.scrollHeight - 8;
      this.stick = atBottom;
      this.renderWindow();
    });
    new ResizeObserver(() => this.renderWindow()).observe(this.view);
    this.el.appendChild(this.view);
  }

  add(text: string, severity?: Severity): void {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const entry: Entry = {
      time: `${hh}:${mm}:${ss}`,
      text,
      severity: severity ?? classifySeverity(text),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
      this.refilter();
      return;
    }
    if (this.matches(entry)) {
      this.filtered.push(entry);
      this.syncHeight();
      if (this.stick) this.view.scrollTop = this.view.scrollHeight;
      this.renderWindow();
    }
  }

  private matches(e: Entry): boolean {
    if (this.filter !== 'all') {
      const sev = e.severity === 'success' ? 'info' : e.severity === 'dim' ? 'info' : e.severity;
      if (sev !== this.filter) return false;
    }
    const q = this.searchInput.value.trim().toLowerCase();
    if (q && !e.text.toLowerCase().includes(q)) return false;
    return true;
  }

  private refilter(): void {
    this.filtered = this.entries.filter((e) => this.matches(e));
    this.syncHeight();
    if (this.stick) this.view.scrollTop = this.view.scrollHeight;
    this.renderWindow();
  }

  private syncHeight(): void {
    this.spacer.style.height = `${this.filtered.length * ROW_H}px`;
  }

  private renderWindow(): void {
    const scrollTop = this.view.scrollTop;
    const viewH = this.view.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
    const end = Math.min(this.filtered.length, Math.ceil((scrollTop + viewH) / ROW_H) + 4);

    this.windowEl.style.transform = `translateY(${start * ROW_H}px)`;
    this.windowEl.innerHTML = '';
    if (this.filtered.length === 0) {
      const empty = el('div', 'log-empty', this.entries.length ? 'No lines match this filter.' : 'Console output will appear here.');
      this.windowEl.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const e = this.filtered[i];
      const row = el('div', `log-row sev-${e.severity}`);
      row.appendChild(el('span', 'log-ts', e.time));
      const txt = el('span', 'log-text', e.text);
      txt.title = e.text;
      row.appendChild(txt);
      frag.appendChild(row);
    }
    this.windowEl.appendChild(frag);
  }

  private copyAll(): void {
    const text = this.filtered.map((e) => `${e.time} ${e.text}`).join('\n');
    void navigator.clipboard
      .writeText(text)
      .then(() => toast('info', 'Console copied', `${this.filtered.length} lines`))
      .catch(() => toast('error', 'Copy failed', 'Clipboard API unavailable'));
  }

  private clear(): void {
    this.entries = [];
    this.filtered = [];
    this.syncHeight();
    this.renderWindow();
  }

  count(): number {
    return this.entries.length;
  }
}
