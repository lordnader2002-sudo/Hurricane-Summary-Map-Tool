/*
 * Session auto-save for the hurricane summary map tool.
 *
 * Captures the full user state — parsed storm parts, properties, slider
 * values, track-point styling, callout positions/text, manual flags — and
 * persists it to localStorage so a page refresh, browser crash, or accidental
 * tab close doesn't wipe out the customisations.
 *
 * Public API (window.HurricaneSession):
 *   captureSnapshot(state, ctrl)         -> JSON-serialisable snapshot
 *   applySnapshot(snap, state, ctrl)     -> async, restores the snapshot
 *   save(snapshot)                       -> debounced localStorage write
 *   saveNow(snapshot)                    -> synchronous localStorage write
 *   load()                               -> snapshot | null
 *   clear()                              -> remove the saved snapshot
 *
 * applySnapshot uses ctrl.applyTrackPointStyles / applyCalloutState — both
 * of which restore internal state without firing the change callbacks, so
 * restoring doesn't trigger another save.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'hurricane-tool-session-v3';
  const SAVE_DEBOUNCE_MS = 400;

  let saveTimer = null;

  function captureSnapshot(state, ctrl) {
    return {
      version: 3,
      savedAt: Date.now(),
      storm: {
        parts: state.parts || [],
        fileNames: (state.parts || []).map(p => p.fileName || ''),
      },
      properties: {
        rows: state.rawProperties || [],
        source: state.propertiesSource || '',
      },
      compareStorm: {
        parts: state.compareParts || [],
        fileNames: (state.compareParts || []).map(p => p.fileName || ''),
      },
      bufferMiles: state.bufferMiles,
      labelsVisible: state.labelsVisible !== false,
      trackPointStyles: ctrl.getTrackPointStyles(),
      trackDefaults: ctrl.getTrackDefaults(),
      callouts: ctrl.getCalloutState(),
      manualOverride: Array.from((state.manualOverride || new Map()).entries()),
    };
  }

  async function applySnapshot(snap, state, ctrl) {
    if (!snap) return;

    // Storm
    if (snap.storm && snap.storm.parts && snap.storm.parts.length) {
      state.parts = snap.storm.parts.slice();
      const storm = window.HurricaneKMZ.mergeParts(state.parts);
      state.storm = storm;
      ctrl.setStorm(storm);
    }

    // Properties
    if (snap.properties && Array.isArray(snap.properties.rows)) {
      state.rawProperties = snap.properties.rows.slice();
      state.propertiesSource = snap.properties.source || '';
    }

    // Comparison advisory
    if (snap.compareStorm && Array.isArray(snap.compareStorm.parts)
        && snap.compareStorm.parts.length) {
      state.compareParts = snap.compareStorm.parts.slice();
      const compareStorm = window.HurricaneKMZ.mergeParts(state.compareParts);
      state.compareStorm = compareStorm;
      ctrl.setCompareStorm(compareStorm);
    }

    // Buffer + labels
    if (typeof snap.bufferMiles === 'number') state.bufferMiles = snap.bufferMiles;
    if (typeof snap.labelsVisible === 'boolean') state.labelsVisible = snap.labelsVisible;

    // Manual override map
    state.manualOverride = new Map(snap.manualOverride || []);

    // Track defaults must be applied BEFORE per-point styles, since they affect
    // the resolved style for points without an override.
    if (snap.trackDefaults) ctrl.setTrackDefaults(snap.trackDefaults);
    if (snap.trackPointStyles) ctrl.applyTrackPointStyles(snap.trackPointStyles);
    if (snap.callouts) ctrl.applyCalloutState(snap.callouts);
  }

  function save(snapshot) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow(snapshot);
    }, SAVE_DEBOUNCE_MS);
  }

  function saveNow(snapshot) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (err) {
      // Quota exceeded or storage disabled — fail silently to avoid breaking
      // the foreground UX. The user will just lose unsaved state on reload.
      console.warn('Session save failed:', err && err.message ? err.message : err);
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const snap = JSON.parse(raw);
      if (!snap || snap.version !== 3) return null;
      return snap;
    } catch (err) {
      console.warn('Session load failed:', err && err.message ? err.message : err);
      return null;
    }
  }

  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
  }

  window.HurricaneSession = {
    captureSnapshot, applySnapshot, save, saveNow, load, clear,
  };
})();
