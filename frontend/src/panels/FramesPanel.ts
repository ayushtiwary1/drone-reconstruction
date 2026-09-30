/**
 * FramesPanel — dock tab "Frames".
 * Filmstrip of the run's source frames with per-frame quality badges
 * (sharpness / exposure / GPS-agreement), click-selection semantics,
 * exclude toggle, and a GNSS-integrity timeline strip.
 */

import { el } from '../ui/icons.ts';
import type { Provenance } from '../features/provenance.ts';

export class FramesPanel {
    readonly el: HTMLDivElement;
    private strip: HTMLDivElement;
    private integrity: HTMLDivElement;
    private hint: HTMLDivElement;
    private prov: Provenance | null = null;
    /** point counts from the current region selection (frame → n) */
    private regionCounts = new Map<number, number>();

    constructor() {
        this.el = el('div');
        this.el.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;';
        this.integrity = el('div', 'gps-strip');
        this.hint = el('div', 'footnote', 'Run a reconstruction to see source frames.');
        this.strip = el('div', 'frames-strip');
        this.el.appendChild(this.hint);
        this.el.appendChild(this.integrity);
        this.el.appendChild(this.strip);
    }

    setProvenance(p: Provenance): void {
        this.prov = p;
        p.onChange = () => this.refresh();
    }

    refresh(): void {
        const p = this.prov;
        this.strip.innerHTML = '';
        this.integrity.innerHTML = '';
        if (!p || !p.loaded || !p.frameCount) {
            this.hint.style.display = '';
            return;
        }
        this.hint.style.display = 'none';
        this.regionCounts = p.regionFrameCounts();

        const medSharp = median(p.cams.map((c) => c.sharpness));

        // GNSS integrity strip — one segment per frame
        const gpsEl = el('div', 'gps-track');
        gpsEl.setAttribute('data-tooltip', 'GPS integrity (visual cross-check)');
        for (const c of p.cams) {
            const seg = el('div', 'gps-seg' + (c.gps_ok ? '' : ' bad'));
            seg.setAttribute('data-tooltip', `F${c.frame} · ${c.gps_ok ? 'GPS/VO agree' : 'GPS/VO disagree'}`);
            gpsEl.appendChild(seg);
        }
        const lbl = el('span', 'gps-label', 'GPS integrity (visual cross-check):');
        this.integrity.appendChild(lbl);
        this.integrity.appendChild(gpsEl);

        for (let i = 0; i < p.frameCount; i++) {
            const c = p.cams.find((x) => x.frame === i);
            const cell = el('div', 'fs-cell');
            cell.dataset.frame = String(i);
            const url = p.thumbUrl(i);
            if (url) {
                const img = document.createElement('img');
                img.src = url;
                img.loading = 'lazy';
                cell.appendChild(img);
            }
            const lab = el('div', 'fs-label', `F${i}${c ? ` · ${c.time_s.toFixed(0)}s` : ''}`);
            cell.appendChild(lab);

            // quality flags
            const flags: string[] = [];
            if (c) {
                if (c.sharpness < medSharp * 0.35) flags.push('blur');
                if (c.exposure_clip > 0.05) flags.push('clip');
                if (!c.gps_ok) flags.push('gps');
            }
            if (flags.length) {
                const fl = el('div', 'fs-flags', flags.join(' '));
                fl.setAttribute('data-tooltip', `flags: ${flags.join(', ')}`);
                cell.appendChild(fl);
            }
            const rc = this.regionCounts.get(i);
            if (rc) {
                const badge = el('div', 'fs-badge', `${rc.toLocaleString('en-US')} pts`);
                cell.appendChild(badge);
            }
            cell.classList.toggle('sel', p.selected.has(i));
            cell.classList.toggle('exc', p.excluded.has(i));
            cell.addEventListener('click', (e) => p.selectClick(i, e));
            cell.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                p.toggleExclude(i);
            });
            this.strip.appendChild(cell);
        }
    }
}

function median(a: number[]): number {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
}
