/**
 * OutputsPanel — bottom-dock table of deliverables (same data as Inspector ›
 * Exports, in table form). Sizes are fetched via HEAD; "—" when unavailable.
 */

import { icon, el } from '../ui/icons.ts';
import { EXPORT_FILES, exportFileSize, exportUrl, formatBytes } from '../pipeline/backend.ts';

export class OutputsPanel {
  readonly el: HTMLDivElement;
  private tbody: HTMLTableSectionElement;

  constructor() {
    this.el = el('div');
    this.el.style.cssText = 'flex:1;min-height:0;overflow:auto;';
    const table = el('table', 'table');
    const thead = el('thead');
    const htr = el('tr');
    for (const h of ['Format', 'File', 'Size', 'Status', '']) {
      htr.appendChild(el('th', undefined, h));
    }
    thead.appendChild(htr);
    table.appendChild(thead);
    this.tbody = el('tbody');
    table.appendChild(this.tbody);
    this.el.appendChild(table);
    this.refresh();
  }

  refresh(): void {
    this.tbody.innerHTML = '';
    for (const f of EXPORT_FILES) {
      const tr = el('tr');
      const nameTd = el('td');
      const nameWrap = el('span');
      nameWrap.style.cssText = 'display:inline-flex;align-items:center;gap:7px;';
      const ic = el('span', 'fmt-icon');
      ic.appendChild(icon(f.icon, 14));
      nameWrap.appendChild(ic);
      nameWrap.appendChild(el('span', undefined, f.label));
      nameTd.appendChild(nameWrap);
      tr.appendChild(nameTd);
      tr.appendChild(el('td', 'mono', f.file.slice(1)));
      const sizeTd = el('td', 'mono', '—');
      tr.appendChild(sizeTd);
      const statusTd = el('td', 'mono', '…');
      tr.appendChild(statusTd);
      const dlTd = el('td');
      dlTd.style.textAlign = 'right';
      const a = el('a', 'btn-icon') as HTMLAnchorElement;
      a.href = exportUrl(f.file);
      a.download = f.file.slice(1);
      a.appendChild(icon('download', 14));
      a.setAttribute('data-tooltip', `Download ${f.label}`);
      dlTd.appendChild(a);
      tr.appendChild(dlTd);
      this.tbody.appendChild(tr);

      void exportFileSize(f.file).then((s) => {
        sizeTd.textContent = formatBytes(s);
        statusTd.textContent = s !== null ? 'available' : '—';
      });
    }
    for (const planned of ['GeoTIFF', 'FBX']) {
      const tr = el('tr');
      tr.style.opacity = '0.45';
      const nameTd = el('td');
      const nameWrap = el('span');
      nameWrap.style.cssText = 'display:inline-flex;align-items:center;gap:7px;';
      const ic = el('span', 'fmt-icon');
      ic.appendChild(icon('image', 14));
      nameWrap.appendChild(ic);
      nameWrap.appendChild(el('span', undefined, planned));
      nameTd.appendChild(nameWrap);
      tr.appendChild(nameTd);
      tr.appendChild(el('td', 'mono', '—'));
      tr.appendChild(el('td', 'mono', '—'));
      tr.appendChild(el('td', 'mono', 'planned'));
      tr.appendChild(el('td'));
      tr.setAttribute('data-tooltip', 'Planned — not yet implemented');
      this.tbody.appendChild(tr);
    }
  }
}
