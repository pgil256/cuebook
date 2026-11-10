// Confirmation dialogs and toast messages.

import { h } from './util.js';
import { icon } from './icons.js';

let finishOpen = null;

export const isModalOpen = () => !!finishOpen;
export function closeModal(value = null) { if (finishOpen) finishOpen(value); }

/** buttons: [{ label, value, primary, danger }]. Resolves with the clicked value, or null if dismissed. */
export function modal({ title, body, buttons, focusCancel = false }) {
  closeModal(null);
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    const finish = (value) => {
      if (finishOpen !== finish) return;
      finishOpen = null;
      root.innerHTML = '';
      resolve(value);
    };
    const btns = buttons.map((b) => h('button', {
      type: 'button',
      class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
      onclick: () => finish(b.value),
    }, b.label));
    const box = h('div', { class: 'modal', role: 'dialog' },
      h('div', { class: 'modal-head' }, h('h2', { text: title }),
        h('button', { class: 'tb-btn icon-only', type: 'button', title: 'Close', onclick: () => finish(null) }, icon('close'))),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-buttons' }, btns));
    root.append(h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === e.currentTarget) finish(null); } }, box));
    finishOpen = finish;
    // For risky actions the safe button gets focus, so a stray Space or Enter does nothing harmful.
    const focusBtn = focusCancel ? btns[0] : btns.find((b, i) => buttons[i].primary) || btns[0];
    requestAnimationFrame(() => focusBtn && focusBtn.focus());
  });
}

export function confirmDialog(title, message, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return modal({
    title,
    body: h('p', { class: 'modal-text', text: message }),
    buttons: [{ label: cancel, value: false }, { label: ok, value: true, primary: !danger, danger }],
    focusCancel: danger,
  }).then((v) => v === true);
}

/** Show a short message. `action`: optional { label, run } button, e.g. Undo. */
export function toast(message, type = 'info', { ms, action } = {}) {
  const root = document.getElementById('toasts');
  for (const t of [...root.children]) if (t.dataset.msg === message) t.remove();
  const el = h('div', { class: `toast ${type}`, dataset: { msg: message } },
    icon(type === 'info' ? 'info' : 'warn'),
    h('span', { class: 'toast-text', text: message }),
    action ? h('button', { class: 'toast-action', onclick: () => { el.remove(); action.run(); } }, action.label) : null,
    h('button', { class: 'toast-x', title: 'Dismiss', onclick: () => el.remove() }, icon('close')));
  root.append(el);
  while (root.children.length > 3) root.firstChild.remove();
  const life = ms ?? (type === 'error' ? 9000 : type === 'warn' ? 6000 : action ? 6000 : 3500);
  setTimeout(() => el.classList.add('leaving'), life);
  setTimeout(() => el.remove(), life + 400);
}

export function clearToasts() {
  document.getElementById('toasts').innerHTML = '';
}
