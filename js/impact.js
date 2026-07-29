/* global turf */
/*
 * Compute which properties are impacted by a storm.
 *
 * Inputs:
 *   - properties: [{ id, name, address, lat, lon, ... }]
 *   - storm: parsed KMZ object { trackLine, cone, trackPoints, ... }
 *   - bufferMiles: number (distance from track centerline)
 *
 * Returns: same property objects with four fields appended:
 *   { inCone: bool, distMiles: number|null, distStormMiles: number|null, impacted: bool }
 *
 * `impacted` is true if the property is inside the cone polygon OR within
 * `bufferMiles` of the track line. `distMiles` (distance to the track
 * centerline) drives that buffer test; `distStormMiles` is the distance to
 * the storm's CURRENT position (first track point — NHC forecast products
 * list the present location first) and is what the UI displays.
 */
(function () {
  'use strict';

  // The storm's current position: first track point of the advisory.
  function currentStormPoint(storm) {
    const feats = storm && storm.trackPoints && storm.trackPoints.features;
    if (!feats || feats.length === 0) return null;
    const g = feats[0] && feats[0].geometry;
    if (!g || !Array.isArray(g.coordinates)) return null;
    return turf.point(g.coordinates);
  }

  function computeImpact(properties, storm, bufferMiles) {
    if (!Array.isArray(properties)) return [];
    const cone = storm && storm.cone;
    const line = storm && storm.trackLine;
    const stormPt = currentStormPoint(storm);
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

      let distStormMiles = null;
      if (stormPt) {
        try {
          distStormMiles = turf.distance(pt, stormPt, { units: 'miles' });
        } catch (_) { distStormMiles = null; }
      }

      const inBuffer = distMiles != null && distMiles <= buffer;
      return Object.assign({}, p, {
        inCone,
        distMiles,
        distStormMiles,
        impacted: inCone || inBuffer,
      });
    });
  }

  window.ImpactEngine = { computeImpact };
})();
