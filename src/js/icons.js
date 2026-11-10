// Inline SVG icons (24px grid) so the UI looks the same everywhere.

const svg = (body) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const solid = 'fill="currentColor" stroke="none"';

const icons = {
  play: svg(`<path d="M7 4.5v15l12-7.5z" ${solid}/>`),
  pause: svg(`<rect x="6" y="5" width="4" height="14" rx="1" ${solid}/><rect x="14" y="5" width="4" height="14" rx="1" ${solid}/>`),
  stop: svg(`<rect x="6" y="6" width="12" height="12" rx="1.5" ${solid}/>`),
  prev: svg(`<rect x="5" y="5" width="2.6" height="14" rx="1" ${solid}/><path d="M19 5.5v13L9 12z" ${solid}/>`),
  next: svg(`<rect x="16.4" y="5" width="2.6" height="14" rx="1" ${solid}/><path d="M5 5.5v13L15 12z" ${solid}/>`),
  volume: svg('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
  mute: svg('<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M16 9l5 6M21 9l-5 6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  music: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  warn: svg('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.01"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>'),
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `icon ${cls}`.trim();
  span.innerHTML = icons[name] || '';
  return span;
}
