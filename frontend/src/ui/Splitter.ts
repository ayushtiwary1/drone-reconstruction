/**
 * Splitter — 4px drag handle resizing an adjacent panel.
 * Double-click collapses/expands the panel.
 */

import { el } from './icons.ts';

export interface SplitterOptions {
  direction: 'vertical' | 'horizontal'; // vertical = left/right panels
  /** Panel whose size changes. For vertical: width; horizontal: height. */
  getSize: () => number;
  setSize: (px: number) => void;
  min: number;
  max: () => number;
  /** delta sign: +1 when dragging right/down grows the panel */
  grow: 1 | -1;
  onCollapseToggle?: () => void;
  onChange?: (px: number) => void;
}

export class Splitter {
  readonly el: HTMLDivElement;
  private opts: SplitterOptions;

  constructor(opts: SplitterOptions) {
    this.opts = opts;
    this.el = el('div', `splitter splitter-${opts.direction === 'vertical' ? 'v' : 'h'}`);
    this.el.addEventListener('pointerdown', (e) => this.startDrag(e));
    this.el.addEventListener('dblclick', () => opts.onCollapseToggle?.());
    this.el.setAttribute('data-tooltip', 'Drag to resize · double-click to collapse');
  }

  private startDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.el.classList.add('dragging');
    document.body.classList.add(this.opts.direction === 'vertical' ? 'dragging-col' : 'dragging-row');
    const startPos = this.opts.direction === 'vertical' ? e.clientX : e.clientY;
    const startSize = this.opts.getSize();

    const move = (ev: PointerEvent): void => {
      const pos = this.opts.direction === 'vertical' ? ev.clientX : ev.clientY;
      const delta = (pos - startPos) * this.opts.grow;
      const size = Math.min(this.opts.max(), Math.max(this.opts.min, startSize + delta));
      this.opts.setSize(size);
      this.opts.onChange?.(size);
    };
    const up = (): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      this.el.classList.remove('dragging');
      document.body.classList.remove('dragging-col', 'dragging-row');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
  }
}
