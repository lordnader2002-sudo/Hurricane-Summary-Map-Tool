/* global shp, turf, HurricaneKMZ */
/*
 * Shapefile (.zip) parser for NHC GIS bundles.
 *
 * NHC distributes the 5-day forecast (and other products) as a zipped
 * shapefile set, e.g.:
 *   al092022-015Aadv_5day_pgn.shp  -> cone-of-uncertainty polygon
 *   al092022-015Aadv_5day_lin.shp  -> forecast track line
 *   al092022-015Aadv_5day_pts.shp  -> forecast position points (w/ intensity)
 *   ..._ww_*.shp                   -> coastal watches & warnings
 *
 * shpjs unzips and parses these into GeoJSON FeatureCollections (one per
 * shapefile, each tagged with `.fileName`). This module classifies them and
 * normalizes to the same shape js/kmz.js produces:
 *   { cone, trackLine, trackPoints, ww, iconMap }
 */
(function () {
  'use strict';

  async function parseShapefileZip(arrayBuffer) {
    const result = await shp(arrayBuffer);
    const collections = Array.isArray(result) ? result : [result];

    const out = {
      stormName: '',
      advisoryDate: null,
      cone: null,
      trackLine: null,
      trackPoints: null,
      ww: [],
      iconMap: {},
    };

    collections.forEach(fc => {
      if (!fc || !fc.features) return;
      const fname = (fc.fileName || '').toLowerCase();
      const geom = dominantGeometryType(fc);

      const isWW = /ww|watch|warn/.test(fname)
        || fc.features.some(f => classifyFeatureWW(f));

      if (/_pgn|polygon|cone/.test(fname) || (geom === 'Polygon' && !isWW)) {
        out.cone = mergePolygonFeatures(fc.features);
      } else if (isWW) {
        out.ww = out.ww.concat(extractWWFromFeatures(fc.features));
      } else if (/_pts|point/.test(fname) || geom === 'Point') {
        out.trackPoints = normalizeTrackPoints(fc.features);
        if (!out.stormName) out.stormName = stormNameFromFeatures(fc.features);
      } else if (/_lin|line|track/.test(fname) || geom === 'LineString') {
        out.trackLine = firstLineFeature(fc.features);
      }
    });

    // Fall back to a synthesized line if the bundle had points but no _lin
    if (!out.trackLine && out.trackPoints) {
      out.trackLine = HurricaneKMZ.synthesizeLine(out.trackPoints);
    }
    if (out.trackPoints && out.trackPoints.features.length === 0) {
      out.trackPoints = null;
    }
    return out;
  }

  function dominantGeometryType(fc) {
    const counts = {};
    fc.features.forEach(f => {
      const t = f.geometry && f.geometry.type;
      if (!t) return;
      const base = t.replace(/^Multi/, '');
      counts[base] = (counts[base] || 0) + 1;
    });
    let best = null;
    let bestN = -1;
    Object.keys(counts).forEach(k => {
      if (counts[k] > bestN) { best = k; bestN = counts[k]; }
    });
    return best;
  }

  function mergePolygonFeatures(features) {
    const polys = features.filter(
      f => f.geometry && /Polygon$/.test(f.geometry.type)
    );
    if (polys.length === 0) return null;
    if (polys.length === 1) return polys[0];
    try {
      let acc = polys[0];
      for (let i = 1; i < polys.length; i += 1) {
        const u = turf.union(acc, polys[i]);
        if (u) acc = u;
      }
      return acc;
    } catch (err) {
      // Fall back to a MultiPolygon of every ring
      const coords = [];
      polys.forEach(f => {
        if (f.geometry.type === 'Polygon') coords.push(f.geometry.coordinates);
        else f.geometry.coordinates.forEach(c => coords.push(c));
      });
      return {
        type: 'Feature',
        geometry: { type: 'MultiPolygon', coordinates: coords },
        properties: {},
      };
    }
  }

  function firstLineFeature(features) {
    const line = features.find(f => f.geometry && /LineString$/.test(f.geometry.type));
    if (!line) return null;
    // Normalize MultiLineString -> first/longest LineString for the buffer math
    if (line.geometry.type === 'MultiLineString') {
      const longest = line.geometry.coordinates
        .slice()
        .sort((a, b) => b.length - a.length)[0];
      return {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: longest },
        properties: line.properties || {},
      };
    }
    return line;
  }

  function normalizeTrackPoints(features) {
    const pts = features
      .filter(f => f.geometry && f.geometry.type === 'Point')
      .map((f, idx) => {
        const props = f.properties || {};
        const category = intensityToCategory(props);
        return {
          type: 'Feature',
          geometry: f.geometry,
          properties: {
            name: pointLabel(props),
            category,
            categoryLabel: HurricaneKMZ.CATEGORY_LABEL[category] || category,
            description: '',
            timestamp: pointTimestamp(props),
            order: idx,
          },
        };
      });
    return HurricaneKMZ.sortTrackPoints(pts);
  }

  // NHC forecast-point .dbf fields vary by product/year. Be defensive: try a
  // Saffir-Simpson number, then a max-wind value, then a development label.
  function intensityToCategory(props) {
    const ss = pickNumber(props, ['SSNUM', 'SS', 'SAFFIR']);
    if (ss != null && ss >= 1) return 'cat' + Math.min(5, Math.round(ss));

    const wind = pickNumber(props, ['MAXWIND', 'INTENSITY', 'WINDSPEED', 'VMAX', 'WIND']);
    if (wind != null) return windToCategory(wind);

    const label = pickString(props, ['DVLBL', 'STORMTYPE', 'TYPE', 'STORMNAME', 'TCDVLP', 'DEVELOPMEN']);
    if (label) {
      const t = label.toLowerCase();
      if (/major|\bcat\s*[345]\b/.test(t)) return 'cat3';
      if (/hurricane|\bhu\b|^\s*h\s*$/.test(t)) return 'cat1';
      if (/tropical storm|\bts\b|^\s*s\s*$/.test(t)) return 'ts';
      if (/depression|\btd\b|^\s*d\s*$/.test(t)) return 'td';
      if (/subtropical|\bst[sd]?\b/.test(t)) return 'ts';
    }
    return 'ex';
  }

  function windToCategory(kt) {
    if (kt >= 137) return 'cat5';
    if (kt >= 113) return 'cat4';
    if (kt >= 96) return 'cat3';
    if (kt >= 83) return 'cat2';
    if (kt >= 64) return 'cat1';
    if (kt >= 34) return 'ts';
    return 'td';
  }

  function pointLabel(props) {
    const dt = pickString(props, ['FLDATELBL', 'DATELBL', 'VALIDTIME', 'ADVDATE', 'SYNOPTIME']);
    const dv = pickString(props, ['DVLBL', 'STORMTYPE', 'TYPE']);
    return [dt, dv].filter(Boolean).join(' ') || pickString(props, ['STORMNAME']) || 'Forecast point';
  }

  function pointTimestamp(props) {
    const s = pickString(props, ['ADVDATE', 'SYNOPTIME', 'VALIDTIME', 'FLDATELBL', 'DATELBL']);
    if (!s) return null;
    const t = Date.parse(s);
    return isFinite(t) ? t : null;
  }

  function extractWWFromFeatures(features) {
    const out = [];
    features.forEach(f => {
      if (!f.geometry || !/LineString$/.test(f.geometry.type)) return;
      const cls = classifyFeatureWW(f);
      if (!cls) return;
      // Split a MultiLineString into individual segments for cleaner styling
      if (f.geometry.type === 'MultiLineString') {
        f.geometry.coordinates.forEach(seg => {
          out.push({
            category: cls.category, label: cls.label, color: cls.color,
            geometry: { type: 'LineString', coordinates: seg },
          });
        });
      } else {
        out.push({
          category: cls.category, label: cls.label, color: cls.color,
          geometry: f.geometry,
        });
      }
    });
    return out;
  }

  function classifyFeatureWW(f) {
    const props = f.properties || {};
    const blob = Object.keys(props)
      .map(k => props[k])
      .filter(v => typeof v === 'string' || typeof v === 'number')
      .join(' ');
    return HurricaneKMZ.classifyWW(blob);
  }

  function stormNameFromFeatures(features) {
    for (const f of features) {
      const n = pickString(f.properties || {}, ['STORMNAME', 'STORMNUM', 'STORM']);
      if (n) return String(n);
    }
    return '';
  }

  function pickNumber(props, keys) {
    for (const k of keys) {
      const found = findKey(props, k);
      if (found != null) {
        const n = typeof props[found] === 'number'
          ? props[found] : parseFloat(props[found]);
        if (isFinite(n)) return n;
      }
    }
    return null;
  }

  function pickString(props, keys) {
    for (const k of keys) {
      const found = findKey(props, k);
      if (found != null && props[found] != null && String(props[found]).trim() !== '') {
        return String(props[found]).trim();
      }
    }
    return null;
  }

  function findKey(props, wanted) {
    const w = wanted.toLowerCase();
    return Object.keys(props).find(k => k.toLowerCase() === w) || null;
  }

  window.Shapefile = { parseShapefileZip };
})();
