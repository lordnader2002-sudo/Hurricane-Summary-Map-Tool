/* global HurricaneSession */
/*
 * Named bookmarks — a personal collection of saved views.
 *
 * Each bookmark is a (name, savedAt, snapshot) triple where snapshot is the
 * same shape HurricaneSession.captureSnapshot produces. Restored via
 * HurricaneSession.applySnapshot, so the bookmark workflow rides on the
 * existing session restore plumbing — no parallel logic to maintain.
 *
 * Bookmarks live in localStorage under their own key (separate from the
 * session snapshot) and travel inside the share URL so a recipient sees
 * the sender's saved views.
 *
 * Public API (window.HurricaneBookmarks):
 *   list()                  -> [{ name, savedAt, snapshot }, ...]
 *   add(name, snapshot)     -> updated list
 *   remove(name)            -> updated list
 *   importMany(items)       -> merged list (dedupe by name; collision suffix)
 *   clearAll()
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'hurricane-tool-bookmarks-v1';

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function save(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }
    catch (err) { console.warn('Bookmark save failed:', err && err.message ? err.message : err); }
  }

  function list() { return load(); }

  function add(name, snapshot) {
    const cur = load();
    const trimmed = String(name || '').trim() || 'Untitled view';
    // Replace if a bookmark with this exact name already exists.
    const filtered = cur.filter(b => b.name !== trimmed);
    filtered.push({ name: trimmed, savedAt: Date.now(), snapshot });
    save(filtered);
    return filtered;
  }

  function remove(name) {
    const cur = load();
    const next = cur.filter(b => b.name !== name);
    save(next);
    return next;
  }

  function suffixCollision(name, takenNames, ts) {
    if (!takenNames.has(name)) return name;
    const stamp = new Date(ts || Date.now()).toISOString().slice(0, 10);
    let candidate = `${name} (shared ${stamp})`;
    let n = 2;
    while (takenNames.has(candidate)) {
      candidate = `${name} (shared ${stamp} #${n++})`;
    }
    return candidate;
  }

  // Merge incoming bookmarks into the local set, deduping by name.
  function importMany(items) {
    if (!Array.isArray(items) || items.length === 0) return load();
    const cur = load();
    const taken = new Set(cur.map(b => b.name));
    let added = 0;
    items.forEach(item => {
      if (!item || !item.snapshot) return;
      const baseName = String(item.name || '').trim() || 'Shared view';
      const finalName = suffixCollision(baseName, taken, item.savedAt);
      taken.add(finalName);
      cur.push({ name: finalName, savedAt: item.savedAt || Date.now(), snapshot: item.snapshot });
      added++;
    });
    save(cur);
    return { list: cur, added };
  }

  function clearAll() { save([]); }

  window.HurricaneBookmarks = { list, add, remove, importMany, clearAll };
})();
