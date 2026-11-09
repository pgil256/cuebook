// Modal dialogs and toast notifications.

import { h } from './util.js';
import { icon } from './icons.js';

let openModal = null;

export function isModalOpen() { return !!openModal; }

/**
 * Show a modal. `buttons`: [{ label, value, primary, danger }].
 * Resolves with the clicked button's value (or null when dismissed).
 * `onSubmit` (optional) can validate/transform before closing; return undefined to keep it open.
 */
export function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], wide = false, onSubmit = null, initialFocus = null }) {
  closeModal(null);
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    const finish = (value) => {
      if (!openModal || openModal.finish !== finish) return;
      openModal = null;
      root.innerHTML = '';
      root.classList.remove('open');
      resolve(value);
    };
    const btnRow = h('div', { class: 'modal-buttons' }, ...buttons.map((b) => h('button', {
      class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
      type: b.primary ? 'submit' : 'button',
      onclick: async (e) => {
        e.preventDefault();
        if (b.primary && onSubmit) {
          const v = await onSubmit();
          if (v === undefined) return;
          finish(v);
        } else finish(b.value);
      },
    }, b.label)));
    const form = h('form', { class: `modal ${wide ? 'wide' : ''}`, onsubmit: (e) => e.preventDefault() },
      h('div', { class: 'modal-head' }, h('h2', { text: title }), h('button', { class: 'tb-btn icon-only', type: 'button', title: 'Close', onclick: () => finish(null) }, icon('close'))),
      h('div', { class: 'modal-body' }, body),
      btnRow);
    root.append(h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === e.currentTarget) finish(null); } }, form));
    root.classList.add('open');
    openModal = { finish };
    requestAnimationFrame(() => {
      const f = initialFocus || form.querySelector('input:not([type=hidden]), textarea, select') || form.querySelector('.btn.primary');
      if (f) f.focus();
    });
  });
}

export function closeModal(value = null) {
  if (openModal) openModal.finish(value);
}

export function confirmDialog(title, message, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return modal({
    title,
    body: h('p', { class: 'modal-text', text: message }),
    buttons: [{ label: cancel, value: false }, { label: ok, value: true, primary: !danger, danger }],
  }).then((v) => v === true);
}

export function toast(message, type = 'info', ms) {
  const root = document.getElementById('toasts');
  const el = h('div', { class: `toast ${type}` },
    icon(type === 'error' || type === 'warn' ? 'warn' : 'note'),
    h('span', { text: message }),
    h('button', { class: 'toast-x', title: 'Dismiss', onclick: () => el.remove() }, icon('close')));
  // Don't stack the same message twice.
  for (const t of [...root.children]) if (t.dataset.msg === message) t.remove();
  el.dataset.msg = message;
  root.append(el);
  while (root.children.length > 3) root.firstChild.remove();
  setTimeout(() => el.classList.add('leaving'), (ms ?? (type === 'error' ? 9000 : type === 'warn' ? 7000 : 4000)));
  setTimeout(() => el.remove(), (ms ?? (type === 'error' ? 9000 : type === 'warn' ? 7000 : 4000)) + 400);
  return el;
}
