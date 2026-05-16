/* global LZString, HurricaneSession, HurricaneKMZ */
/*
 * Shareable URL state.
 *
 * The "share this view with the team" workflow: the sender clicks Share view,
 * the tool builds a compressed #s=<encoded> hash that captures the storm
 * parts, properties rows, comparison advisory parts, and every customisation
 * (track-point styling, callout positions/text, manual impact flags, default
 * styles, buffer, labels toggle). The receiver opens the URL and the tool
 * replays everything — no re-upload needed.
 *
 * Older v1/v2 share URLs only carried filenames and customisations; if one
 * shows up the receiver still has to upload the listed files, then the tool
 * replays the customisations on top.
 *
 * Public API (window.HurricaneShare):
 *   encode(state, ctrl)         -> URL string (https://…/#s=…)
 *   decodePendingShare()        -> share payload | null (reads location.hash)
 *   applyPending(payload, state, ctrl) -> { applied, needsCompare }
 *   filenameMismatchSummary(payload, state) -> warning info for legacy shares
 */
(function () {
  'use strict';

  const VERSION = 3;
  const HASH_PARAM = 's';

  function encode(state, ctrl) {
    const payload = {
      v: VERSION,
      ts: Date.now(),
      // Embedded data — receiver doesn't need to re-upload.
      parts: state.parts || [],
      properties: state.rawProperties || [],
      compareParts: state.compareParts || [],
      // Filenames kept for display ("you're viewing X.kmz + Y.csv") and
      // backward compatibility with the legacy applyPending() flow.
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
      // Accept v3 (embedded data) and v2 (filenames only — legacy receiver
      // flow re-uploads files). v1 is ignored — comparison support didn't
      // exist yet so the payload shape is too divergent to replay safely.
      if (!payload || (payload.v !== 3 && payload.v !== 2)) return null;
      return payload;
    } catch (err) {
      console.warn('Share decode failed:', err && err.message ? err.message : err);
      return null;
    }
  }

  // Apply the share payload. With v3 shares (embedded data) this populates
  // the storm / properties / comparison immediately. With legacy v2 shares
  // the receiver still has to upload files; we gate on having them.
  //
  // Return shape:
  //   { applied: false }                       waiting on primary/CSV upload (v2 only)
  //   { applied: true, needsCompare: [...] }   ready; comparison may still be missing (v2 only)
  async function applyPending(payload, state, ctrl) {
    if (!payload) return { applied: true, needsCompare: [] };

    const embedded = payload.v === 3;

    if (embedded) {
      // Hydrate state directly from the payload — no upload required.
      if (Array.isArray(payload.parts) && payload.parts.length) {
        state.parts = payload.parts.slice();
      }
      if (Array.isArray(payload.properties) && payload.properties.length) {
        state.rawProperties = payload.properties.slice();
        state.propertiesSource = payload.csvFileName || '';
      }
      if (Array.isArray(payload.compareParts) && payload.compareParts.length) {
        state.compareParts = payload.compareParts.slice();
      }
    } else {
      // Legacy v2: filenames only. Wait until the receiver has uploaded.
      const needStorm = (payload.fileNames || []).length > 0;
      const needCsv = !!payload.csvFileName;
      const haveStorm = state.parts.length > 0;
      const haveCsv = state.rawProperties.length > 0;
      if (needStorm && !haveStorm) return { applied: false, needsCompare: [] };
      if (needCsv && !haveCsv) return { applied: false, needsCompare: [] };
    }

    // Feed everything through the session restore path so the merge/setStorm
    // logic stays in one place.
    const snap = {
      version: 3,
      storm: {
        parts: state.parts.slice(),
        fileNames: payload.fileNames || (state.parts || []).map(p => p.fileName || ''),
      },
      properties: {
        rows: state.rawProperties.slice(),
        source: state.propertiesSource,
      },
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

    // v3 shares are always complete. v2 may still need a comparison upload.
    if (embedded) return { applied: true, needsCompare: [] };
    const needCompare = (payload.compareFileNames || []).length > 0;
    const haveCompare = (state.compareParts || []).length > 0;
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
