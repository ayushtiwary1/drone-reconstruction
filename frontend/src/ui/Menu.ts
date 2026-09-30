/**
 * Menu — application menu bar (File / View / Help) with dark popovers,
 * shortcut hints, checkmarks, and one level of submenu.
 */

import { icon, el } from './icons.ts';

export interface MenuItem {
  label?: string;
  shortcut?: string;
  action?: () => void;
  checked?: () => boolean;
  disabled?: boolean | (() => boolean);
  submenu?: MenuItem[];
  separator?: boolean;
}

interface MenuDef {
  label: string;
  items: MenuItem[];
}

export class MenuBar {
  readonly el: HTMLDivElement;
  private openMenu: { btn: HTMLButtonElement; pop: HTMLDivElement } | null = null;

  constructor(appTitle: string, appSub: string, menus: MenuDef[]) {
    this.el = el('div', 'menubar');
    const title = el('div', 'app-title');
    title.appendChild(el('span', undefined, appTitle));
    title.appendChild(el('span', 'app-sub', appSub));
    this.el.appendChild(title);

    for (const def of menus) {
      const btn = el('button', 'menu-btn', def.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (this.openMenu?.btn === btn) this.close();
        else this.open(btn, def.items);
      });
      btn.addEventListener('pointerenter', () => {
        if (this.openMenu && this.openMenu.btn !== btn) this.open(btn, def.items);
      });
      this.el.appendChild(btn);
    }
  }

  close(): void {
    this.openMenu?.pop.remove();
    this.openMenu?.btn.classList.remove('open');
    this.openMenu = null;
    document.removeEventListener('pointerdown', this.outside, true);
    document.removeEventListener('keydown', this.onKey, true);
  }

  private outside = (e: Event): void => {
    if (this.openMenu && !this.openMenu.pop.contains(e.target as Node) && !this.openMenu.btn.contains(e.target as Node)) {
      this.close();
    }
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close();
  };

  private open(btn: HTMLButtonElement, items: MenuItem[]): void {
    this.close();
    btn.classList.add('open');
    const pop = this.buildMenu(items);
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 2}px`;
    pop.style.left = `${Math.max(4, r.left)}px`;
    this.openMenu = { btn, pop };
    document.addEventListener('pointerdown', this.outside, true);
    document.addEventListener('keydown', this.onKey, true);
  }

  private buildMenu(items: MenuItem[]): HTMLDivElement {
    const pop = el('div', 'menu-popover');
    pop.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.separator || !item.label) {
        pop.appendChild(el('div', 'menu-separator'));
        continue;
      }
      const disabled = typeof item.disabled === 'function' ? item.disabled() : item.disabled;
      const row = el('button', 'menu-item');
      row.type = 'button';
      if (disabled) row.classList.add('disabled');
      const check = el('span', 'item-check');
      if (item.checked?.()) check.appendChild(icon('check', 12));
      row.appendChild(check);
      row.appendChild(el('span', 'item-label', item.label));
      if (item.shortcut) {
        const k = document.createElement('kbd');
        k.textContent = item.shortcut;
        row.appendChild(k);
      }
      if (item.submenu) {
        const arrow = icon('chevron-right', 12);
        arrow.classList.add('submenu-arrow');
        row.appendChild(arrow);
        let sub: HTMLDivElement | null = null;
        row.addEventListener('pointerenter', () => {
          if (disabled) return;
          sub?.remove();
          sub = this.buildMenu(item.submenu!);
          document.body.appendChild(sub);
          const rr = row.getBoundingClientRect();
          const sw = 200;
          let left = rr.right - 2;
          if (left + sw > window.innerWidth) left = rr.left - sw;
          sub.style.top = `${rr.top - 4}px`;
          sub.style.left = `${left}px`;
          sub.style.minWidth = `${sw}px`;
        });
        row.addEventListener('pointerleave', (e) => {
          if (sub && !sub.contains(e.relatedTarget as Node)) {
            sub.remove();
            sub = null;
          }
        });
        pop.addEventListener('pointerleave', () => {
          sub?.remove();
          sub = null;
        });
      }
      row.addEventListener('click', () => {
        if (disabled || item.submenu) return;
        this.close();
        item.action?.();
      });
      pop.appendChild(row);
    }
    return pop;
  }
}
