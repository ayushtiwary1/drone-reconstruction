/**
 * Slider — styled range input paired with a numeric field.
 */

import { el } from './icons.ts';

export class Slider {
  readonly el: HTMLDivElement;
  private range: HTMLInputElement;
  private num: HTMLInputElement;
  private handlers = new Set<(v: number) => void>();
  private step: number;
  private suffix: string;

  constructor(min: number, max: number, step: number, initial: number, suffix = '') {
    this.step = step;
    this.suffix = suffix;
    this.el = el('div', 'slider-row');
    this.range = el('input', 'slider') as HTMLInputElement;
    this.range.type = 'range';
    this.range.min = String(min);
    this.range.max = String(max);
    this.range.step = String(step);
    this.range.value = String(initial);
    this.num = el('input', 'input') as HTMLInputElement;
    this.num.type = 'number';
    this.num.min = String(min);
    this.num.max = String(max);
    this.num.step = String(step);
    this.num.value = this.fmt(initial);
    this.num.setAttribute('aria-label', 'value');
    this.el.appendChild(this.range);
    this.el.appendChild(this.num);

    this.range.addEventListener('input', () => {
      const v = parseFloat(this.range.value);
      this.num.value = this.fmt(v);
      this.emit(v);
    });
    this.num.addEventListener('change', () => {
      let v = parseFloat(this.num.value);
      if (Number.isNaN(v)) v = initial;
      v = Math.min(max, Math.max(min, v));
      v = Math.round(v / step) * step;
      this.range.value = String(v);
      this.num.value = this.fmt(v);
      this.emit(v);
    });
  }

  private fmt(v: number): string {
    const decimals = this.step < 1 ? 1 : 0;
    return v.toFixed(decimals) + this.suffix;
  }

  getValue(): number {
    return parseFloat(this.range.value);
  }

  setValue(v: number): void {
    this.range.value = String(v);
    this.num.value = this.fmt(v);
  }

  private emit(v: number): void {
    for (const h of this.handlers) h(v);
  }

  onChange(cb: (v: number) => void): void {
    this.handlers.add(cb);
  }
}
