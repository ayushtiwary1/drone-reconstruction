/**
 * Panel — titled panel with header + collapse chevron + scrollable body.
 * Also provides `Section`, the collapsible sub-section used in the Inspector.
 */

import { icon, el } from './icons.ts';

export class Panel {
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly header: HTMLDivElement;
  private chevron: HTMLButtonElement;
  private collapseHandlers = new Set<() => void>();

  constructor(title: string, cls = '') {
    this.el = el('div', `panel ${cls}`);
    this.header = el('div', 'panel-header');
    this.header.appendChild(el('span', 'panel-title', title));
    this.chevron = el('button', 'btn-icon collapse-btn');
    this.chevron.appendChild(icon('chevron-down', 14));
    this.chevron.setAttribute('data-tooltip', 'Collapse panel');
    this.chevron.addEventListener('click', () => {
      for (const h of this.collapseHandlers) h();
    });
    this.header.appendChild(this.chevron);
    this.body = el('div', 'panel-body');
    this.el.appendChild(this.header);
    this.el.appendChild(this.body);
  }

  onCollapse(cb: () => void): void {
    this.collapseHandlers.add(cb);
  }
}

export class Section {
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  private collapsed = false;

  constructor(title: string, open = true) {
    this.el = el('div', 'section');
    const head = el('button', 'section-header');
    head.type = 'button';
    const chev = icon('chevron-down', 14);
    chev.classList.add('chev');
    head.appendChild(chev);
    head.appendChild(el('span', undefined, title));
    head.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.body = el('div', 'section-body');
    this.el.appendChild(head);
    this.el.appendChild(this.body);
    this.setCollapsed(!open);
  }

  setCollapsed(v: boolean): void {
    this.collapsed = v;
    this.el.classList.toggle('collapsed', v);
  }
}

/** A labelled field row used inside sections. */
export function field(label: string, control: HTMLElement, sub?: string, infoTip?: string): HTMLDivElement {
  const f = el('div', 'field');
  const lab = el('div', 'field-label');
  lab.appendChild(el('span', undefined, label));
  if (infoTip) {
    const i = el('span', 'info-btn');
    i.appendChild(icon('info', 13));
    i.setAttribute('data-tooltip', infoTip);
    lab.appendChild(i);
  }
  f.appendChild(lab);
  f.appendChild(control);
  if (sub) f.appendChild(el('div', 'field-sub', sub));
  return f;
}
