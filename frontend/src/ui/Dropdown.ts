/**
 * Dropdown — custom dark-popover select. Keyboard: ↑/↓ navigate,
 * Enter/Space select, Esc close. Checkmark on the selected item.
 */

import { icon, el } from './icons.ts';

export interface DropdownOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export class Dropdown {
  readonly el: HTMLDivElement;
  private btn: HTMLButtonElement;
  private labelEl: HTMLSpanElement;
  private popover: HTMLDivElement | null = null;
  private options: DropdownOption[];
  private value: string;
  private highlighted = -1;
  private changeHandlers = new Set<(v: string) => void>();

  constructor(options: DropdownOption[], initial?: string) {
    this.options = options;
    this.value = initial ?? options[0]?.value ?? '';
    this.el = el('div', 'dropdown');
    this.btn = el('button', 'dropdown-btn');
    this.btn.type = 'button';
    this.btn.setAttribute('aria-haspopup', 'listbox');
    this.labelEl = el('span', 'dropdown-label');
    this.btn.appendChild(this.labelEl);
    this.btn.appendChild(icon('chevron-down', 14));
    this.el.appendChild(this.btn);
    this.renderLabel();

    this.btn.addEventListener('click', () => (this.popover ? this.close() : this.open()));
    this.btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.open();
      }
    });
  }

  getValue(): string {
    return this.value;
  }

  setValue(v: string): void {
    if (!this.options.some((o) => o.value === v)) return;
    this.value = v;
    this.renderLabel();
    this.markSelected();
  }

  setOptions(options: DropdownOption[]): void {
    this.options = options;
    if (!options.some((o) => o.value === this.value)) {
      this.value = options[0]?.value ?? '';
    }
    this.renderLabel();
    this.markSelected();
  }

  onChange(cb: (v: string) => void): void {
    this.changeHandlers.add(cb);
  }

  private emit(): void {
    for (const h of this.changeHandlers) h(this.value);
  }

  private renderLabel(): void {
    const opt = this.options.find((o) => o.value === this.value);
    this.labelEl.textContent = opt?.label ?? '—';
  }

  private markSelected(): void {
    this.popover?.querySelectorAll('.dropdown-item').forEach((item) => {
      const v = (item as HTMLElement).dataset.value;
      item.classList.toggle('selected', v === this.value);
      const check = item.querySelector('.item-check');
      if (check) check.innerHTML = v === this.value ? '' : '';
      if (check && v === this.value) check.appendChild(icon('check', 14));
    });
  }

  private open(): void {
    if (this.popover) return;
    this.el.classList.add('open');
    const pop = el('div', 'dropdown-popover');
    pop.setAttribute('role', 'listbox');
    this.popover = pop;

    this.options.forEach((opt, i) => {
      const item = el('button', 'dropdown-item');
      item.type = 'button';
      item.dataset.value = opt.value;
      item.setAttribute('role', 'option');
      if (opt.disabled) item.classList.add('disabled');
      const check = el('span', 'item-check');
      if (opt.value === this.value) check.appendChild(icon('check', 14));
      item.appendChild(check);
      item.appendChild(el('span', 'item-label', opt.label));
      if (opt.hint) item.appendChild(el('span', 'item-hint', opt.hint));
      if (opt.value === this.value) item.classList.add('selected');
      item.addEventListener('click', () => {
        if (opt.disabled) return;
        this.value = opt.value;
        this.renderLabel();
        this.close();
        this.emit();
      });
      item.addEventListener('pointerenter', () => this.highlight(i));
      pop.appendChild(item);
    });

    document.body.appendChild(pop);
    this.position();
    this.highlight(Math.max(0, this.options.findIndex((o) => o.value === this.value)));

    pop.addEventListener('keydown', (e) => this.onKey(e));
    this.btn.addEventListener('keydown', this.btnKeyHandler);
    document.addEventListener('pointerdown', this.outsideHandler, true);
    window.addEventListener('resize', this.close);
    window.addEventListener('blur', this.close);
  }

  private btnKeyHandler = (e: KeyboardEvent): void => this.onKey(e);
  private outsideHandler = (e: Event): void => {
    if (this.popover && !this.popover.contains(e.target as Node) && !this.btn.contains(e.target as Node)) {
      this.close();
    }
  };

  private position(): void {
    if (!this.popover) return;
    const r = this.btn.getBoundingClientRect();
    this.popover.style.minWidth = `${r.width}px`;
    const ph = Math.min(320, this.popover.scrollHeight || 320);
    let top = r.bottom + 4;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
    this.popover.style.top = `${top}px`;
    this.popover.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - this.popover.offsetWidth - 8))}px`;
  }

  private highlight(i: number): void {
    if (!this.popover) return;
    const items = Array.from(this.popover.querySelectorAll<HTMLElement>('.dropdown-item'));
    items.forEach((it, idx) => it.classList.toggle('highlighted', idx === i));
    this.highlighted = i;
    items[i]?.scrollIntoView({ block: 'nearest' });
  }

  private step(dir: number): void {
    if (!this.popover) return;
    let i = this.highlighted;
    for (let n = 0; n < this.options.length; n++) {
      i = (i + dir + this.options.length) % this.options.length;
      if (!this.options[i].disabled) break;
    }
    this.highlight(i);
  }

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.step(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.step(-1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (this.highlighted >= 0) {
          const opt = this.options[this.highlighted];
          if (opt && !opt.disabled) {
            this.value = opt.value;
            this.renderLabel();
            this.close();
            this.emit();
          }
        }
        break;
      case 'Escape':
      case 'Tab':
        this.close();
        this.btn.focus();
        break;
    }
  }

  close = (): void => {
    if (!this.popover) return;
    this.el.classList.remove('open');
    this.popover.remove();
    this.popover = null;
    this.btn.removeEventListener('keydown', this.btnKeyHandler);
    document.removeEventListener('pointerdown', this.outsideHandler, true);
    window.removeEventListener('resize', this.close);
    window.removeEventListener('blur', this.close);
  };
}
