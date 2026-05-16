/* global LZString, HurricaneSession */
/*
 * Shareable URL state.
 *
 * A typical "share this view with the team" workflow: the sender clicks
 * Share view, the tool builds a compact #s=<encoded> hash that captures
 * every customisation (track-point styling, callout positions/text, manual
 * impact flags, default styles, buffer, labels toggle) plus the file names
 * the storm and CSV came from. The receiver opens the URL, uploads the
 * same files (storm + CSV — too big to fit in a URL), and the tool replays
 * the customisations on top.
 *
 * Public API (window.HurricaneShare):
 *   encode(state, ctrl)         -> URL string (https://…/#s=…)
 *   decodePendingShare()        -> share payload | null (reads location.hash)
 *   applyPending(payload, state, ctrl) -> applies what it can given current state
 */
(function () {
  'use strict';

  const VERSION = 2;
  const HASH_PARAM = 's';

  function encode(state, ctrl) {
    const payload = {
      v: VERSION,
      ts: Date.now(),
      fileNames: (state.parts || []).map(p => p.fileName || ''),
      csvFileName: state.propertiesSource || '',
      compareFileNames: (state.compareParts || []).map(p => p.fileName || ''),
      bufferMiles: state.bufferMiles,
      labelsVisible: state.labelsVisible !== false,
      trackPointStyles: ctrl.getTrackPointStyles(),
      trackDefaults: ctrl.getTrackDefaults(),
      callouts: ctrl.getCalloutState(),
      manualOverride: Array.from((state.manualOverride || new Map()).entries()),
    };
    const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(payload));
    const base = location.origin + location.pathname + location.search;
    return `${base}#${HASH_PARAM}=${compressed}`;
  }

  function decodePendingShare() {
    const hash = (location.hash || '').replace(/^#/, '');
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const encoded = params.get(HASH_PARAM);
    if (!encoded) return null;
    try {
      const json = LZString.decompressFromEncodedURIComponent(encoded);
      if (!json) return null;
      const payload = JSON.parse(json);
      if (!payload || payload.v !== VERSION) return null;
      return payload;
      // (older v1 shares are silently ignored — comparison support is new)
    } catch (err) {
      console.warn('Share decode failed:', err && err.message ? err.message : err);
      return null;
    }
  }

  // Apply whichever pieces are loadable given the current state. Comparison
  // is treated as optional — primary + CSV applies as soon as both are
  // present, and a comparison-still-needed signal is returned so the app can
  // surface a follow-up prompt.
  //
  // Return shape:
  //   { applied: false }                       waiting on primary/CSV
  //   { applied: true, needsCompare: [...] }   ready; comparison may still be missing
  async function applyPending(payload, state, ctrl) {
    if (!payload) return { applied: true, needsCompare: [] };
    const needStorm = (payload.fileNames || []).length > 0;
    const needCsv = !!payload.csvFileName;
    const needCompare = (payload.compareFileNames || []).length > 0;
    const haveStorm = state.parts.length > 0;
    const haveCsv = state.rawProperties.length > 0;
    const haveCompare = (state.compareParts || []).length > 0;

    // Hold off until the receiver has uploaded the prerequisites — callout
    // positions and manual flags only make sense once those are present.
    if (needStorm && !haveStorm) return { applied: false, needsCompare: [] };
    if (needCsv && !haveCsv) return { applied: false, needsCompare: [] };

    // Build a snapshot-shaped object keeping whatever the user just uploaded
    // and feed it through the session restore path so logic stays in one
    // place.
    const snap = {
      version: 3,
      storm: { parts: state.parts.slice(), fileNames: payload.fileNames || [] },
      properties: { rows: state.rawProperties.slice(), source: state.propertiesSource },
      compareStorm: {
        parts: (state.compareParts || []).slice(),
        fileNames: payload.compareFileNames || [],
      },
      bufferMiles: payload.bufferMiles,
      labelsVisible: payload.labelsVisible,
      trackPointStyles: payload.trackPointStyles || {},
      trackDefaults: payload.trackDefaults || ctrl.getTrackDefaults(),
      callouts: payload.callouts || { positions: {}, textOverrides: {} },
      manualOverride: payload.manualOverride || [],
    };

    await HurricaneSession.applySnapshot(snap, state, ctrl);
    const stillNeeded = (needCompare && !haveCompare) ? payload.compareFileNames : [];
    return { applied: true, needsCompare: stillNeeded };
  }

  function filenameMismatchSummary(payload, state) {
    const expected = (payload.fileNames || []).slice().sort();
    const got = (state.parts || []).map(p => p.fileName || '').sort();
    const missing = expected.filter(n => !got.includes(n));
    const extra = got.filter(n => n && !expected.includes(n));
    const csvOk = !payload.csvFileName || payload.csvFileName === state.propertiesSource;
    const expectedCompare = (payload.compareFileNames || []).slice().sort();
    const gotCompare = (state.compareParts || []).map(p => p.fileName || '').sort();
    const compareMissing = expectedCompare.filter(n => !gotCompare.includes(n));
    return { missing, extra, csvOk,
      csvExpected: payload.csvFileName, csvGot: state.propertiesSource,
      compareMissing };
  }

  window.HurricaneShare = { encode, decodePendingShare, applyPending, filenameMismatchSummary };
})();
