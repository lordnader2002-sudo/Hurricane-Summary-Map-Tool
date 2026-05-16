/* global turf */
/*
 * Storm timeline helpers.
 *
 * Drives the scrubber UI: given the storm's time-ordered track points and a
 * target time t, return the interpolated storm position and the properties
 * within a buffer of that position. The scrubber is a purely analytical
 * overlay — it does NOT alter the cone/buffer impact set surfaced in the
 * "Impacted Properties" panel.
 *
 * Public API (window.HurricaneTimeline):
 *   getTimeRange(trackPoints)            -> { tMin, tMax, count } | null
 *   interpolatePosition(trackPoints, t)  -> { lat, lon, category, label } | null
 *   propertiesNear(properties, position, miles) -> [{ ...property, distMiles }]
 *   formatTime(ms)                       -> "0600 UTC OCT 23 2025"
 */
(function () {
  'use strict';

  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

  function timestampedFeatures(trackPoints) {
    if (!trackPoints || !trackPoints.features) return [];
    return trackPoints.features
      .filter(f => f.properties && typeof f.properties.timestamp === 'number')
      .slice()
      .sort((a, b) => a.properties.timestamp - b.properties.timestamp);
  }

  function getTimeRange(trackPoints) {
    const feats = timestampedFeatures(trackPoints);
    if (feats.length < 2) return null;
    return {
      tMin: feats[0].properties.timestamp,
      tMax: feats[feats.length - 1].properties.timestamp,
      count: feats.length,
    };
  }

  function interpolatePosition(trackPoints, t) {
    const feats = timestampedFeatures(trackPoints);
    if (feats.length === 0) return null;
    if (t <= feats[0].properties.timestamp) {
      const f = feats[0];
      const [lon, lat] = f.geometry.coordinates;
      return { lat, lon, category: f.properties.category, label: f.properties.name, t };
    }
    if (t >= feats[feats.length - 1].properties.timestamp) {
      const f = feats[feats.length - 1];
      const [lon, lat] = f.geometry.coordinates;
      return { lat, lon, category: f.properties.category, label: f.properties.name, t };
    }
    // Linear interp between the bracketing points (6-h spacing — linear is
    // fine and avoids great-circle complexity over short segments)
    for (let i = 0; i < feats.length - 1; i += 1) {
      const a = feats[i], b = feats[i + 1];
      const ta = a.properties.timestamp, tb = b.properties.timestamp;
      if (t >= ta && t <= tb) {
        const f = tb === ta ? 0 : (t - ta) / (tb - ta);
        const [alon, alat] = a.geometry.coordinates;
        const [blon, blat] = b.geometry.coordinates;
        return {
          lat: alat + (blat - alat) * f,
          lon: alon + (blon - alon) * f,
          category: (f < 0.5 ? a : b).properties.category,
          label: (f < 0.5 ? a : b).properties.name,
          t,
        };
      }
    }
    return null;
  }

  function propertiesNear(properties, position, miles) {
    if (!position || !properties || properties.length === 0) return [];
    const pt = turf.point([position.lon, position.lat]);
    const out = [];
    properties.forEach(p => {
      const d = turf.distance(pt, turf.point([p.lon, p.lat]), { units: 'miles' });
      if (d <= miles) out.push(Object.assign({}, p, { distMiles: d }));
    });
    out.sort((a, b) => a.distMiles - b.distMiles);
    return out;
  }

  function formatTime(ms) {
    const d = new Date(ms);
    const h = String(d.getUTCHours()).padStart(2, '0');
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    return `${h}${m} UTC ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')} ${d.getUTCFullYear()}`;
  }

  window.HurricaneTimeline = {
    getTimeRange, interpolatePosition, propertiesNear, formatTime,
  };
})();
