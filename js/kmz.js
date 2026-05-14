/* global JSZip, turf, Shapefile */
/*
 * Hurricane geospatial file parser.
 *
 * Entry point: HurricaneKMZ.parseFiles(fileList) -> Promise<storm>
 *
 * Accepts any mix of:
 *   - A combined best-track .kmz (track points + wind-radii polygons in one file)
 *   - NHC per-advisory .kmz files: CONE / TRACK / WW (uploaded together)
 *   - A .zip that is either an NHC shapefile bundle (.shp/.dbf/.shx) or a zip
 *     of .kmz/.kml files
 *
 * Each input file is parsed into a "part", classified (cone | track | ww |
 * combined), then all parts are merged into a single normalized storm object:
 *
 *   {
 *     stormName,
 *     advisoryDate,
 *     trackPoints: GeoJSON FeatureCollection (Point features),
 *     trackLine:   GeoJSON Feature (LineString) | null,
 *     cone:        GeoJSON Feature (Polygon/MultiPolygon) | null,
 *     ww:          [{ category, label, color, geometry }]   // watches/warnings
 *     iconMap:     { [category]: dataURL },
 *     sources:     ['CONE','TRACK','WW', ...]   // what was loaded, for the UI
 *   }
 */
(function () {
  'use strict';

  const MONTHS = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };

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

  // NHC-standard watch/warning categories. `test` is matched against a blob of
  // a feature's name + styleUrl + description + dbf string values.
  const WW_CATEGORIES = [
    { category: 'hurricane-warning', label: 'Hurricane Warning', color: '#e60000',
      test: /hurricane\s*warning|\bhww\b|\bhuw\b/i },
    { category: 'hurricane-watch', label: 'Hurricane Watch', color: '#ff66cc',
      test: /hurricane\s*watch|\bhwa\b|\bhua\b/i },
    { category: 'ts-warning', label: 'Tropical Storm Warning', color: '#1f4ee6',
      test: /(tropical\s*storm|trop\.?\s*stm|\bts\b)\s*warning|\btww\b|\btsw\b/i },
    { category: 'ts-watch', label: 'Tropical Storm Watch', color: '#ffd11a',
      test: /(tropical\s*storm|trop\.?\s*stm|\bts\b)\s*watch|\btwa\b|\btsa\b/i },
    { category: 'surge-warning', label: 'Storm Surge Warning', color: '#b300b3',
      test: /storm\s*surge\s*warning|\bssw\b/i },
    { category: 'surge-watch', label: 'Storm Surge Watch', color: '#00c2c2',
      test: /storm\s*surge\s*watch|\bssa\b/i },
  ];

  function classifyWW(text) {
    if (!text) return null;
    for (const c of WW_CATEGORIES) {
      if (c.test.test(text)) {
        return { category: c.category, label: c.label, color: c.color };
      }
    }
    return null;
  }

  // ---- Top-level entry --------------------------------------------------

  // Parse a FileList into classified parts (cone/track/ww/combined) without
  // merging — lets the UI accumulate parts across separate uploads.
  async function parseToParts(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) throw new Error('No files selected');

    const parts = [];
    for (const file of files) {
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.zip')) {
        const zipParts = await parseZipFile(file);
        parts.push(...zipParts);
      } else if (lower.endsWith('.kmz') || lower.endsWith('.kml')) {
        parts.push(await parseKmlOrKmzFile(file));
      } else {
        throw new Error(`Unsupported file type: ${file.name}`);
      }
    }
    return parts;
  }

  async function parseFiles(fileList) {
    return mergeParts(await parseToParts(fileList));
  }

  // ---- .zip handling (shapefile bundle OR zip of kmz/kml) ---------------

  async function parseZipFile(file) {
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);

    const hasShp = names.some(n => /\.shp$/i.test(n));
    const kmlNames = names.filter(n => /\.(kmz|kml)$/i.test(n));

    if (hasShp) {
      if (!window.Shapefile) {
        throw new Error('Shapefile support not loaded (vendor/shp.min.js missing)');
      }
      const shpResult = await Shapefile.parseShapefileZip(buf);
      return [Object.assign({ fileName: file.name, kind: 'combined' }, shpResult)];
    }

    if (kmlNames.length > 0) {
      const out = [];
      for (const n of kmlNames) {
        if (/\.kml$/i.test(n)) {
          const text = await zip.files[n].async('string');
          out.push(parseKmlString(text, {}, n));
        } else {
          // nested .kmz — unzip again
          const nestedBuf = await zip.files[n].async('arraybuffer');
          out.push(await parseKmzArrayBuffer(nestedBuf, n));
        }
      }
      return out;
    }

    throw new Error(`Zip "${file.name}" contains neither shapefiles nor KML/KMZ`);
  }

  // ---- .kmz / .kml handling ---------------------------------------------

  async function parseKmlOrKmzFile(file) {
    if (/\.kmz$/i.test(file.name)) {
      const buf = await file.arrayBuffer();
      return parseKmzArrayBuffer(buf, file.name);
    }
    const text = await file.text();
    return parseKmlString(text, {}, file.name);
  }

  async function parseKmzArrayBuffer(buf, fileName) {
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
          : ext === 'gif' ? 'image/gif' : 'image/png';
        const base = path.split('/').pop().replace(/\.[^.]+$/, '');
        iconMap[base] = `data:${mime};base64,${base64}`;
      }
    }
    if (!kmlText) throw new Error(`No .kml found inside ${fileName}`);
    return parseKmlString(kmlText, iconMap, fileName);
  }

  // ---- KML parsing into a classified "part" -----------------------------

  function parseKmlString(kmlText, iconMap, fileName) {
    const xml = new DOMParser().parseFromString(kmlText, 'text/xml');
    const parserError = xml.querySelector('parsererror');
    if (parserError) {
      throw new Error('KML XML parse error: ' + parserError.textContent.slice(0, 200));
    }

    const docName = textOf(xml.querySelector('Document > name'))
      || textOf(xml.querySelector('kml > name')) || '';
    const description = textOf(xml.querySelector('Document > description')) || '';
    const advisoryDate = extractAdvisoryDate(description);

    const placemarks = Array.from(xml.getElementsByTagName('Placemark'));
    const points = [];
    const polygons = [];
    const lines = [];

    placemarks.forEach((pm, idx) => {
      const name = textOf(pm.querySelector(':scope > name')) || '';
      const styleUrl = (textOf(pm.querySelector(':scope > styleUrl')) || '').replace(/^#/, '');
      const desc = textOf(pm.querySelector(':scope > description')) || '';

      const pointEl = pm.querySelector('Point > coordinates');
      if (pointEl) {
        const coord = parseCoordTriple(pointEl.textContent);
        if (coord) {
          const category = STYLE_TO_CATEGORY[styleUrl] || 'ex';
          points.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [coord[0], coord[1]] },
            properties: {
              name, styleUrl, category,
              categoryLabel: CATEGORY_LABEL[category] || category,
              description: desc,
              timestamp: parseAdvisoryTimestamp(name),
              order: idx,
            },
          });
          return;
        }
      }

      const polyRings = pm.querySelectorAll('Polygon outerBoundaryIs LinearRing coordinates');
      if (polyRings.length) {
        polyRings.forEach(coordsEl => {
          const ring = parseCoordList(coordsEl.textContent);
          if (ring.length >= 4) {
            polygons.push({
              type: 'Feature',
              geometry: { type: 'Polygon', coordinates: [ring] },
              properties: { name, styleUrl, description: desc },
            });
          }
        });
        return;
      }

      const lineEls = pm.querySelectorAll('LineString > coordinates');
      if (lineEls.length) {
        lineEls.forEach(lineEl => {
          const coords = parseCoordList(lineEl.textContent);
          if (coords.length >= 2) {
            lines.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: coords },
              properties: { name, styleUrl, description: desc },
            });
          }
        });
      }
    });

    const raw = { points, polygons, lines };
    const kind = classifyKind(fileName, raw);
    return buildPart(kind, fileName, docName, advisoryDate, raw, iconMap);
  }

  function classifyKind(fileName, raw) {
    const fn = (fileName || '').toLowerCase();
    const hasPts = raw.points.length > 0;
    const hasPoly = raw.polygons.length > 0;
    const hasLine = raw.lines.length > 0;

    // A file with both points and polygons is a combined product (e.g. a
    // best-track .kmz) regardless of what its filename says — content wins.
    if (hasPts && hasPoly) return 'combined';

    // Filename hints, trusted only when the content is consistent with them
    if (/cone/.test(fn) && hasPoly) return 'cone';
    if (/(^|[^a-z])ww([^a-z]|$)|watch|warn/.test(fn)) return 'ww';
    if (/track/.test(fn) && hasPts) return 'track';

    // Content-based fallback
    if (hasPoly && !hasPts) return 'cone';
    if (hasPts) return 'track';
    if (hasLine) {
      // Lines only: if any line classifies as a watch/warning, call it ww
      const anyWW = raw.lines.some(l => classifyWW(
        [l.properties.name, l.properties.styleUrl, l.properties.description].join(' ')
      ));
      return anyWW ? 'ww' : 'track';
    }
    return 'combined';
  }

  function buildPart(kind, fileName, docName, advisoryDate, raw, iconMap) {
    const part = {
      fileName,
      kind,
      stormName: (docName || '').trim(),
      advisoryDate,
      cone: null,
      trackLine: null,
      trackPoints: null,
      ww: [],
      iconMap: buildCategoryIconMap(iconMap),
    };

    if (kind === 'cone') {
      part.cone = unionPolygons(raw.polygons);
      return part;
    }
    if (kind === 'ww') {
      part.ww = extractWWSegments(raw.lines);
      return part;
    }
    if (kind === 'track') {
      part.trackPoints = sortTrackPoints(raw.points);
      part.trackLine = raw.lines[0] || synthesizeLine(part.trackPoints);
      return part;
    }
    // combined
    part.trackPoints = sortTrackPoints(raw.points);
    part.cone = unionPolygons(raw.polygons);
    part.trackLine = raw.lines[0] || synthesizeLine(part.trackPoints);
    return part;
  }

  function extractWWSegments(lines) {
    const out = [];
    lines.forEach(l => {
      const blob = [l.properties.name, l.properties.styleUrl, l.properties.description].join(' ');
      const cls = classifyWW(blob);
      if (cls) {
        out.push({
          category: cls.category,
          label: cls.label,
          color: cls.color,
          geometry: l.geometry,
        });
      }
    });
    return out;
  }

  // ---- Merge parts into one storm ---------------------------------------

  function mergeParts(parts) {
    const sourceLabels = [];
    let stormName = '';
    let advisoryDate = null;
    let cone = null;
    let trackLine = null;
    let trackPoints = null;
    let ww = [];
    let iconMap = {};

    const KIND_LABEL = { cone: 'CONE', track: 'TRACK', ww: 'WW', combined: 'TRACK+CONE' };

    parts.forEach(p => {
      if (!stormName && p.stormName) stormName = p.stormName;
      if (!advisoryDate && p.advisoryDate) advisoryDate = p.advisoryDate;
      if (!cone && p.cone) cone = p.cone;
      if (!trackLine && p.trackLine) trackLine = p.trackLine;
      if (!trackPoints && p.trackPoints && p.trackPoints.features.length) {
        trackPoints = p.trackPoints;
      }
      if (p.ww && p.ww.length) ww = ww.concat(p.ww);
      if (p.iconMap) iconMap = Object.assign(iconMap, p.iconMap);
      const label = KIND_LABEL[p.kind] || p.kind.toUpperCase();
      if (sourceLabels.indexOf(label) === -1) sourceLabels.push(label);
    });

    // If a track line wasn't supplied but points were, synthesize it
    if (!trackLine && trackPoints) trackLine = synthesizeLine(trackPoints);

    return {
      stormName: stormName || 'Storm',
      advisoryDate,
      trackPoints: trackPoints || { type: 'FeatureCollection', features: [] },
      trackLine,
      cone,
      ww,
      iconMap,
      sources: sourceLabels,
    };
  }

  // ---- Shared helpers ---------------------------------------------------

  function sortTrackPoints(points) {
    const sorted = points.slice().sort((a, b) => {
      const ta = a.properties.timestamp;
      const tb = b.properties.timestamp;
      if (ta != null && tb != null) return ta - tb;
      if (ta != null) return -1;
      if (tb != null) return 1;
      return a.properties.order - b.properties.order;
    });
    return { type: 'FeatureCollection', features: sorted };
  }

  function synthesizeLine(trackPoints) {
    if (!trackPoints || trackPoints.features.length < 2) return null;
    return {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: trackPoints.features.map(p => p.geometry.coordinates),
      },
      properties: { synthesized: true },
    };
  }

  function unionPolygons(polygons) {
    if (!polygons || polygons.length === 0) return null;
    if (polygons.length === 1) return polygons[0];
    try {
      let acc = polygons[0];
      for (let i = 1; i < polygons.length; i += 1) {
        const u = turf.union(acc, polygons[i]);
        if (u) acc = u;
      }
      return acc;
    } catch (err) {
      return {
        type: 'Feature',
        geometry: {
          type: 'MultiPolygon',
          coordinates: polygons.map(p => p.geometry.coordinates),
        },
        properties: {},
      };
    }
  }

  function buildCategoryIconMap(iconMap) {
    const out = {};
    if (!iconMap) return out;
    const lookup = key => {
      const exact = Object.keys(iconMap).find(k => k.toLowerCase() === key);
      if (exact) return iconMap[exact];
      const prefix = Object.keys(iconMap).find(
        k => k.toLowerCase().startsWith(key + '_') || k.toLowerCase().startsWith(key)
      );
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
    return [parts[0], parts[1]];
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

  window.HurricaneKMZ = {
    parseFiles,
    parseToParts,
    mergeParts,
    parseKmlString,        // exported for tests
    classifyWW,
    sortTrackPoints,
    synthesizeLine,
    unionPolygons,
    CATEGORY_LABEL,
    WW_CATEGORIES,
  };
})();
