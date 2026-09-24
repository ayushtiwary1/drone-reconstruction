/**
 * Tabs — dock tab strip (Console / Pipeline / Outputs).
 */

import { icon, el } from './icons.ts';

export interface TabDef {
  id: string;
  label: string;
  icon?: string;
  badge?: () => string | null;
}

export class Tabs {
  readonly el: HTMLDivElement;
  private tabs = new Map<string, HTMLButtonElement>();
  private badges = new Map<string, HTMLSpanElement>();
  private defs: TabDef[];
  private active: string;
  private handlers = new Set<(id: string) => void>();

  constructor(defs: TabDef[]) {
    this.defs = defs;
    this.active = defs[0]?.id ?? '';
    this.el = el('div', 'tabs');
    for (const def of defs) {
      const b = el('button', 'tab');
      b.type = 'button';
      if (def.icon) b.appendChild(icon(def.icon, 14));
      b.appendChild(el('span', undefined, def.label));
      const badge = el('span', 'tab-badge');
      badge.hidden = true;
      b.appendChild(badge);
      this.badges.set(def.id, badge);
      b.classList.toggle('active', def.id === this.active);
      b.addEventListener('click', () => this.select(def.id));
      this.tabs.set(def.id, b);
      this.el.appendChild(b);
    }
  }

  select(id: string): void {
    if (!this.tabs.has(id)) return;
    this.active = id;
    for (const [tid, b] of this.tabs) b.classList.toggle('active', tid === id);
    for (const h of this.handlers) h(id);
  }

  getActive(): string {
    return this.active;
  }

  onChange(cb: (id: string) => void): void {
    this.handlers.add(cb);
  }

  refreshBadges(): void {
    for (const def of this.defs) {
      const badge = this.badges.get(def.id);
      const text = def.badge?.() ?? null;
      if (!badge) continue;
      if (text) {
        badge.textContent = text;
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    }
  }
}
