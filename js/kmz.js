/* global JSZip, turf */
/*
 * KMZ / KML parser for NOAA hurricane track files.
 *
 * Returns a normalized object:
 *   {
 *     stormName,
 *     trackPoints: GeoJSON FeatureCollection (Point features),
 *     trackLine:   GeoJSON Feature (LineString) connecting the points in order,
 *     cone:        GeoJSON Feature (MultiPolygon) — union of all polygon
 *                  placemarks (cone of uncertainty and/or wind radii),
 *     iconMap:     { [category]: dataURL } for category icons embedded in the KMZ,
 *     advisoryDate (optional ISO date string parsed from KMZ description)
 *   }
 *
 * Tolerates either a .kmz (zip with embedded .kml + icon PNGs) or a raw .kml file.
 */
(function () {
  'use strict';

  const MONTHS = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };

  // styleUrl → category key (drives which icon to use)
  const STYLE_TO_CATEGORY = {
    cat1: 'cat1', cat2: 'cat2', cat3: 'cat3', cat4: 'cat4', cat5: 'cat5',
    ts: 'ts', td: 'td', ex: 'ex', ss: 'ts', lo: 'ex', db: 'ex', pt: 'ex',
  };

  const CATEGORY_LABEL = {
    cat1: 'Cat 1 Hurricane',
    cat2: 'Cat 2 Hurricane',
    cat3: 'Cat 3 Hurricane',
    cat4: 'Cat 4 Hurricane',
    cat5: 'Cat 5 Hurricane',
    ts: 'Tropical Storm',
    td: 'Tropical Depression',
    ex: 'Extratropical / Other',
  };

  async function parseKmzFile(file) {
    const isZip = /\.kmz$/i.test(file.name);
    if (isZip) {
      const buf = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);

      let kmlText = null;
      const iconMap = {};

      for (const path of Object.keys(zip.files)) {
        const entry = zip.files[path];
        if (entry.dir) continue;
        const lower = path.toLowerCase();
        if (lower.endsWith('.kml') && !kmlText) {
          kmlText = await entry.async('string');
        } else if (/\.(png|jpe?g|gif)$/i.test(lower)) {
          const base64 = await entry.async('base64');
          const ext = lower.split('.').pop();
          const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : ext === 'gif' ? 'image/gif'
              : 'image/png';
          // Key by basename without extension so we can look up by category
          const base = path.split('/').pop().replace(/\.[^.]+$/, '');
          iconMap[base] = `data:${mime};base64,${base64}`;
        }
      }
      if (!kmlText) throw new Error('No .kml file found inside the .kmz archive');
      return parseKmlString(kmlText, iconMap);
    }
    // Raw KML
    const text = await file.text();
    return parseKmlString(text, {});
  }

  function parseKmlString(kmlText, iconMap) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(kmlText, 'text/xml');
    const parserError = xml.querySelector('parsererror');
    if (parserError) throw new Error('KML XML parse error: ' + parserError.textContent.slice(0, 200));

    const docName = textOf(xml.querySelector('Document > name'))
      || textOf(xml.querySelector('kml > name'))
      || 'Storm';

    const description = textOf(xml.querySelector('Document > description')) || '';
    const advisoryDate = extractAdvisoryDate(description);

    const placemarks = Array.from(xml.getElementsByTagName('Placemark'));

    const points = [];
    const polygons = [];
    const lines = [];

    placemarks.forEach((pm, idx) => {
      const name = textOf(pm.querySelector(':scope > name')) || '';
      const styleUrl = (textOf(pm.querySelector(':scope > styleUrl')) || '').replace(/^#/, '');
      const description = textOf(pm.querySelector(':scope > description')) || '';

      // Point
      const pointEl = pm.querySelector('Point > coordinates');
      if (pointEl) {
        const coord = parseCoordTriple(pointEl.textContent);
        if (coord) {
          const category = STYLE_TO_CATEGORY[styleUrl] || 'ex';
          const ts = parseAdvisoryTimestamp(name);
          points.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [coord[0], coord[1]] },
            properties: {
              name,
              styleUrl,
              category,
              categoryLabel: CATEGORY_LABEL[category] || category,
              description,
              timestamp: ts,
              order: idx,
            },
          });
          return;
        }
      }

      // Polygon
      const polyRings = pm.querySelectorAll('Polygon outerBoundaryIs LinearRing coordinates');
      if (polyRings.length) {
        polyRings.forEach(coordsEl => {
          const ring = parseCoordList(coordsEl.textContent);
          if (ring.length >= 4) {
            polygons.push({
              type: 'Feature',
              geometry: { type: 'Polygon', coordinates: [ring] },
              properties: { name, styleUrl, description },
            });
          }
        });
        return;
      }

      // LineString
      const lineEl = pm.querySelector('LineString > coordinates');
      if (lineEl) {
        const coords = parseCoordList(lineEl.textContent);
        if (coords.length >= 2) {
          lines.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: { name, styleUrl, description },
          });
        }
      }
    });

    // Sort track points by parsed timestamp; fall back to document order
    points.sort((a, b) => {
      const ta = a.properties.timestamp;
      const tb = b.properties.timestamp;
      if (ta != null && tb != null) return ta - tb;
      if (ta != null) return -1;
      if (tb != null) return 1;
      return a.properties.order - b.properties.order;
    });

    // Synthesize track line if no LineString was provided
    let trackLine = lines[0] || null;
    if (!trackLine && points.length >= 2) {
      trackLine = {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: points.map(p => p.geometry.coordinates),
        },
        properties: { synthesized: true },
      };
    }

    // Build a single (Multi)Polygon from all polygon placemarks
    let cone = null;
    if (polygons.length === 1) {
      cone = polygons[0];
    } else if (polygons.length > 1) {
      try {
        // Try to union them; if turf union fails, fall back to MultiPolygon
        let acc = polygons[0];
        for (let i = 1; i < polygons.length; i += 1) {
          const u = turf.union(acc, polygons[i]);
          if (u) acc = u;
        }
        cone = acc;
      } catch (err) {
        cone = {
          type: 'Feature',
          geometry: {
            type: 'MultiPolygon',
            coordinates: polygons.map(p => p.geometry.coordinates),
          },
          properties: {},
        };
      }
    }

    // Map category → icon dataURL using KMZ's embedded PNGs (e.g. cat3_nhemi.png)
    const categoryIconMap = buildCategoryIconMap(iconMap);

    const trackPoints = { type: 'FeatureCollection', features: points };

    return {
      stormName: docName.trim(),
      trackPoints,
      trackLine,
      cone,
      iconMap: categoryIconMap,
      rawIconMap: iconMap,
      advisoryDate,
    };
  }

  function buildCategoryIconMap(iconMap) {
    const out = {};
    const lookup = key => {
      // Match cat3_nhemi, cat3, cat3_xxx, etc.
      const exact = Object.keys(iconMap).find(k => k.toLowerCase() === key);
      if (exact) return iconMap[exact];
      const prefix = Object.keys(iconMap).find(k => k.toLowerCase().startsWith(key + '_') || k.toLowerCase().startsWith(key));
      return prefix ? iconMap[prefix] : null;
    };
    ['cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'ts', 'td', 'ex'].forEach(c => {
      const url = lookup(c);
      if (url) out[c] = url;
    });
    return out;
  }

  function textOf(node) {
    return node ? node.textContent.trim() : '';
  }

  function parseCoordTriple(text) {
    if (!text) return null;
    const parts = text.trim().split(/[,\s]+/).map(Number);
    if (parts.length < 2 || !isFinite(parts[0]) || !isFinite(parts[1])) return null;
    return [parts[0], parts[1]]; // [lon, lat]
  }

  function parseCoordList(text) {
    if (!text) return [];
    const tokens = text.trim().split(/\s+/);
    const coords = [];
    for (const tok of tokens) {
      const parts = tok.split(',').map(Number);
      if (parts.length >= 2 && isFinite(parts[0]) && isFinite(parts[1])) {
        coords.push([parts[0], parts[1]]);
      }
    }
    return coords;
  }

  // Parse "0600 UTC OCT 21" → ms since epoch (year inferred as current year if missing).
  function parseAdvisoryTimestamp(name) {
    if (!name) return null;
    const m = name.match(/(\d{3,4})\s*UTC\s+([A-Z]{3})\s+(\d{1,2})(?:\s+(\d{4}))?/i);
    if (!m) return null;
    const hhmm = m[1].padStart(4, '0');
    const hour = parseInt(hhmm.slice(0, 2), 10);
    const minute = parseInt(hhmm.slice(2), 10);
    const month = MONTHS[m[2].toUpperCase()];
    const day = parseInt(m[3], 10);
    const year = m[4] ? parseInt(m[4], 10) : new Date().getUTCFullYear();
    if (month == null) return null;
    return Date.UTC(year, month, day, hour, minute);
  }

  function extractAdvisoryDate(description) {
    const m = description.match(/Date Created:\s*<\/B>\s*(\d{1,2})-(\d{1,2})-(\d{2,4})/i);
    if (!m) return null;
    const dd = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    let yy = parseInt(m[3], 10);
    if (yy < 100) yy += 2000;
    return new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10);
  }

  window.HurricaneKMZ = { parseKmzFile, CATEGORY_LABEL };
})();
