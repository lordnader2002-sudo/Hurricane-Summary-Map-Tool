/* global HurricaneToast */
/*
 * Bounded undo/redo stack.
 *
 * Mutation sites that want to be undoable push a { undo, redo, label }
 * triple; the controller exposes undo() / redo() which call the closures
 * and surface a small info toast labelled with the action.
 *
 * Scope (deliberate): callout text edits, callout drags, manual-override
 * toggles, drawn-zone add/remove. Buffer slider, file uploads, and
 * track-point styling are intentionally NOT undoable — they're either
 * trivially reversible or destructive in a way the stack can't faithfully
 * reverse (you'd undo a file upload to what — nothing? a previous storm?).
 *
 * Public API (window.HurricaneUndo):
 *   push({ undo, redo, label }) -> pushes onto the stack
 *   undo() / redo()             -> step the stack
 *   canUndo() / canRedo()
 *   clear()
 */
(function () {
  'use strict';

  const MAX = 20;
  const past = [];
  const future = [];

  function push(action) {
    if (!action || typeof action.undo !== 'function' || typeof action.redo !== 'function') {
      return;
    }
    past.push(action);
    while (past.length > MAX) past.shift();
    future.length = 0;
  }

  function undo() {
    const a = past.pop();
    if (!a) return false;
    try { a.undo(); } catch (err) { console.warn('Undo failed:', err); }
    future.push(a);
    toast('Undid: ' + (a.label || 'last action'));
    return true;
  }

  function redo() {
    const a = future.pop();
    if (!a) return false;
    try { a.redo(); } catch (err) { console.warn('Redo failed:', err); }
    past.push(a);
    toast('Redid: ' + (a.label || 'last action'));
    return true;
  }

  function toast(msg) {
    if (typeof HurricaneToast === 'undefined') return;
    HurricaneToast.show(msg, 'info', { timeout: 2500 });
  }

  function canUndo() { return past.length > 0; }
  function canRedo() { return future.length > 0; }
  function clear() { past.length = 0; future.length = 0; }

  window.HurricaneUndo = { push, undo, redo, canUndo, canRedo, clear };
})();
