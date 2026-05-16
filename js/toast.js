/*
 * Toast notifications for terminal events.
 *
 * Lives alongside the inline #status text in the toolbar: setStatus() still
 * narrates short-lived progress ("Parsing…", "Rendering PNG…"), and toasts
 * mark terminal outcomes that the user shouldn't miss — failures (with the
 * full error stack tucked inside a <details>) and key successes (download
 * complete, share URL copied, comparison loaded).
 *
 * Public API (window.HurricaneToast):
 *   show(msg, kind, opts)   -> id   kind: 'error' | 'warn' | 'success' | 'info'
 *   dismiss(id)
 *   dismissAll()
 *
 * opts:
 *   detail   - extra text shown inside a collapsed <details>
 *   timeout  - ms before auto-dismiss; 0 / null = sticky.
 *              Defaults: error 8s, success/info 4s, warn sticky.
 *   actions  - [{ label, onClick }] rendered as buttons
 */
(function () {
  'use strict';

  let region = null;
  let nextId = 1;
  const live = new Map(); // id -> { el, timer }

  function ensureRegion() {
    if (region && document.body.contains(region)) return region;
    region = document.createElement('div');
    region.id = 'toastRegion';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Notifications');
    region.setAttribute('aria-live', 'assertive');
    document.body.appendChild(region);
    return region;
  }

  function defaultTimeout(kind) {
    if (kind === 'error') return 8000;
    if (kind === 'warn') return 0;
    return 4000;
  }

  function show(msg, kind, opts) {
    ensureRegion();
    kind = kind || 'info';
    opts = opts || {};
    const id = nextId++;

    const el = document.createElement('div');
    el.className = 'toast toast-' + kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.dataset.id = String(id);

    const body = document.createElement('div');
    body.className = 'toast-body';

    const text = document.createElement('div');
    text.className = 'toast-msg';
    text.textContent = msg || '';
    body.appendChild(text);

    if (opts.detail) {
      const det = document.createElement('details');
      det.className = 'toast-detail';
      const sum = document.createElement('summary');
      sum.textContent = 'Details';
      det.appendChild(sum);
      const pre = document.createElement('pre');
      pre.textContent = String(opts.detail);
      det.appendChild(pre);
      body.appendChild(det);
    }

    if (Array.isArray(opts.actions) && opts.actions.length) {
      const row = document.createElement('div');
      row.className = 'toast-actions';
      opts.actions.forEach(a => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'toast-action';
        b.textContent = a.label;
        b.addEventListener('click', () => {
          try { a.onClick && a.onClick(); } finally { dismiss(id); }
        });
        row.appendChild(b);
      });
      body.appendChild(row);
    }

    el.appendChild(body);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    close.addEventListener('click', () => dismiss(id));
    el.appendChild(close);

    region.appendChild(el);

    const ms = opts.timeout == null ? defaultTimeout(kind) : opts.timeout;
    let timer = null;
    if (ms > 0) timer = setTimeout(() => dismiss(id), ms);

    live.set(id, { el, timer });
    return id;
  }

  function dismiss(id) {
    const entry = live.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    live.delete(id);
    entry.el.classList.add('toast-leaving');
    setTimeout(() => {
      if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    }, 180);
  }

  function dismissAll() {
    Array.from(live.keys()).forEach(dismiss);
  }

  window.HurricaneToast = { show, dismiss, dismissAll };
})();
