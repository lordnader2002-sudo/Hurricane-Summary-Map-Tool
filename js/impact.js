/* global turf */
/*
 * Compute which properties are impacted by a storm.
 *
 * Inputs:
 *   - properties: [{ id, name, address, lat, lon, ... }]
 *   - storm: parsed KMZ object { trackLine, cone, ... }
 *   - bufferMiles: number (distance from track centerline)
 *
 * Returns: same property objects with three fields appended:
 *   { inCone: bool, distMiles: number|null, impacted: bool }
 *
 * `impacted` is true if the property is inside the cone polygon OR within
 * `bufferMiles` of the track line.
 */
(function () {
  'use strict';

  function computeImpact(properties, storm, bufferMiles) {
    if (!Array.isArray(properties)) return [];
    const cone = storm && storm.cone;
    const line = storm && storm.trackLine;
    const buffer = Math.max(0, +bufferMiles || 0);

    return properties.map(p => {
      const pt = turf.point([p.lon, p.lat]);

      let inCone = false;
      if (cone) {
        try { inCone = turf.booleanPointInPolygon(pt, cone); }
        catch (_) { inCone = false; }
      }

      let distMiles = null;
      if (line) {
        try {
          distMiles = turf.pointToLineDistance(pt, line, { units: 'miles' });
        } catch (_) { distMiles = null; }
      }

      const inBuffer = distMiles != null && distMiles <= buffer;
      return Object.assign({}, p, {
        inCone,
        distMiles,
        impacted: inCone || inBuffer,
      });
    });
  }

  window.ImpactEngine = { computeImpact };
})();
