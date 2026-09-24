/**
 * Tooltip — singleton hover tooltip. Elements opt in with `data-tooltip`
 * (text) and optional `data-shortcut` (e.g. "Ctrl+O" → rendered as kbd).
 */

let tipEl: HTMLDivElement | null = null;
let showTimer: number | null = null;
let currentTarget: Element | null = null;

function ensureEl(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

function hide(): void {
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (tipEl) tipEl.hidden = true;
  currentTarget = null;
}

function show(target: Element): void {
  const text = target.getAttribute('data-tooltip');
  if (!text) return;
  const tip = ensureEl();
  tip.textContent = text;

  const shortcut = target.getAttribute('data-shortcut');
  if (shortcut) {
    const kbd = document.createElement('kbd');
    kbd.textContent = shortcut;
    tip.appendChild(kbd);
  }

  const r = target.getBoundingClientRect();
  tip.hidden = false;
  // Measure after visibility
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2;
  let y = r.bottom + 6;
  if (y + th > window.innerHeight - 4) y = r.top - th - 6;
  x = Math.max(4, Math.min(window.innerWidth - tw - 4, x));
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

/** Attach global delegation once at bootstrap. */
export function initTooltips(): void {
  document.addEventListener('pointerover', (e) => {
    const t = (e.target as Element).closest?.('[data-tooltip]');
    if (t === currentTarget) return;
    hide();
    if (!t) return;
    currentTarget = t;
    showTimer = window.setTimeout(() => {
      if (currentTarget === t) show(t);
    }, 450);
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
}
