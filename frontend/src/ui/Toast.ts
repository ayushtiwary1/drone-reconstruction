/**
 * Toast — bottom-right auto-dismissing notifications.
 */

import { icon, el } from './icons.ts';

export type ToastKind = 'success' | 'error' | 'info';

const ICONS: Record<ToastKind, string> = {
  success: 'check-circle',
  error: 'error',
  info: 'info',
};

let stack: HTMLDivElement | null = null;

function ensureStack(): HTMLDivElement {
  if (!stack) {
    stack = el('div', 'toast-stack');
    document.body.appendChild(stack);
  }
  return stack;
}

export function toast(kind: ToastKind, title: string, detail?: string): void {
  const holder = ensureStack();
  const t = el('div', `toast ${kind}`);
  t.setAttribute('role', 'status');
  t.appendChild(icon(ICONS[kind]));

  const body = el('div', 'toast-body');
  body.appendChild(el('div', 'toast-title', title));
  if (detail) body.appendChild(el('div', undefined, detail));
  t.appendChild(body);

  const close = el('button', 'btn-icon');
  close.appendChild(icon('x', 12));
  close.setAttribute('aria-label', 'Dismiss');
  close.addEventListener('click', () => dismiss());
  t.appendChild(close);

  holder.appendChild(t);
  const timer = window.setTimeout(dismiss, 5500);
  function dismiss(): void {
    clearTimeout(timer);
    t.classList.add('leaving');
    window.setTimeout(() => t.remove(), 160);
  }
}
