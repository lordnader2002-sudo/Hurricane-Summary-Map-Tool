/* global turf */
/*
 * Advisory comparison helpers.
 *
 * Given the impact verdict for the current advisory and a previous (or
 * alternative) advisory's impact verdict against the same properties, compute
 * which properties newly entered the impacted set, which dropped out, and
 * which were impacted in both. Also computes a simple "max track shift"
 * metric — useful as a headline in the comparison panel.
 *
 * Public API (window.HurricaneCompare):
 *   diffImpacts(currentImpacted, prevImpacted)  -> { newlyImpacted, dropped, unchanged }
 *   trackShift(currentStorm, prevStorm)         -> { maxMiles, avgMiles, pairs }
 */
(function () {
  'use strict';

  function diffImpacts(current, previous) {
    const cur = current || [];
    const prev = previous || [];
    const curSet = new Set(cur.filter(p => p.impacted).map(p => p.id));
    const prevSet = new Set(prev.filter(p => p.impacted).map(p => p.id));
    return {
      newlyImpacted: cur.filter(p => p.impacted && !prevSet.has(p.id)),
      dropped: prev.filter(p => p.impacted && !curSet.has(p.id)),
      unchanged: cur.filter(p => p.impacted && prevSet.has(p.id)),
    };
  }

  // Pair current track points to previous ones by timestamp (or by ordinal
  // if timestamps are missing); return max/avg pairwise distance in miles.
  function trackShift(current, previous) {
    if (!current || !previous) return null;
    const a = (current.trackPoints && current.trackPoints.features) || [];
    const b = (previous.trackPoints && previous.trackPoints.features) || [];
    if (a.length === 0 || b.length === 0) return null;

    const byTime = new Map();
    b.forEach(f => {
      const t = f.properties && f.properties.timestamp;
      if (typeof t === 'number') byTime.set(t, f);
    });

    const pairs = [];
    a.forEach((af, i) => {
      let bf = null;
      const t = af.properties && af.properties.timestamp;
      if (typeof t === 'number' && byTime.has(t)) {
        bf = byTime.get(t);
      } else if (b[i]) {
        bf = b[i];
      }
      if (!bf) return;
      const ac = af.geometry.coordinates;
      const bc = bf.geometry.coordinates;
      const d = turf.distance(turf.point(ac), turf.point(bc), { units: 'miles' });
      pairs.push({ timestamp: t, distMiles: d });
    });

    if (pairs.length === 0) return null;
    const maxMiles = pairs.reduce((m, p) => Math.max(m, p.distMiles), 0);
    const avgMiles = pairs.reduce((s, p) => s + p.distMiles, 0) / pairs.length;
    return { maxMiles, avgMiles, pairs };
  }

  window.HurricaneCompare = { diffImpacts, trackShift };
})();
