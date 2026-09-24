/**
 * Segmented — compact segmented-toggle control.
 */

import { icon, el } from './icons.ts';

export interface SegmentOption {
  value: string;
  label: string;
  icon?: string;
  tooltip?: string;
  disabled?: boolean;
}

export class Segmented {
  readonly el: HTMLDivElement;
  private options: SegmentOption[];
  private value: string;
  private handlers = new Set<(v: string) => void>();
  private btns = new Map<string, HTMLButtonElement>();

  constructor(options: SegmentOption[], initial?: string, stretch = false) {
    this.options = options;
    this.value = initial ?? options[0]?.value ?? '';
    this.el = el('div', 'segmented');
    if (stretch) this.el.classList.add('stretch');
    for (const opt of options) {
      const b = el('button', 'seg-btn');
      b.type = 'button';
      if (opt.icon) b.appendChild(icon(opt.icon, 14));
      b.appendChild(el('span', undefined, opt.label));
      if (opt.tooltip) b.setAttribute('data-tooltip', opt.tooltip);
      if (opt.disabled) b.disabled = true;
      b.classList.toggle('selected', opt.value === this.value);
      b.addEventListener('click', () => this.select(opt.value));
      this.btns.set(opt.value, b);
      this.el.appendChild(b);
    }
  }

  getValue(): string {
    return this.value;
  }

  setValue(v: string): void {
    this.value = v;
    for (const [val, b] of this.btns) b.classList.toggle('selected', val === v);
  }

  private select(v: string): void {
    const opt = this.options.find((o) => o.value === v);
    if (!opt || opt.disabled || v === this.value) return;
    this.setValue(v);
    for (const h of this.handlers) h(v);
  }

  onChange(cb: (v: string) => void): void {
    this.handlers.add(cb);
  }
}
