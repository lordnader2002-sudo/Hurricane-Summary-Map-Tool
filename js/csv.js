/* global Papa */
/*
 * Parse the properties CSV.
 *
 * Returns: Promise<Property[]>
 *   Property = { id, name, address, postalCode, lat, lon, geocoded, raw }
 *
 * Lat/lon columns are used directly when present and finite. Otherwise the
 * row's address is queued for Nominatim geocoding (1 req/sec, results cached
 * in localStorage).
 */
(function () {
  'use strict';

  const COL_ALIASES = {
    id: ['property_id', 'id', 'code', 'store_id', 'store_code'],
    name: ['name', 'property_name', 'property', 'store_name'],
    address: ['address', 'street', 'full_address', 'street_address'],
    city: ['city'],
    state: ['state', 'province', 'region'],
    postalCode: ['postal_code', 'postalcode', 'postcode', 'zip', 'zipcode'],
    lat: ['lat', 'latitude', 'y'],
    lon: ['lon', 'lng', 'long', 'longitude', 'x'],
  };

  const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
  const GEOCODE_DELAY_MS = 1100; // Nominatim's policy is <= 1 req/sec

  function buildColumnLookup(fields) {
    const map = {};
    const lower = fields.map(f => f.toLowerCase().trim());
    for (const [key, aliases] of Object.entries(COL_ALIASES)) {
      for (const alias of aliases) {
        const i = lower.indexOf(alias);
        if (i !== -1) { map[key] = fields[i]; break; }
      }
    }
    return map;
  }

  function pickNumber(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).trim());
    return isFinite(n) ? n : null;
  }

  async function parseCsvFile(file, opts) {
    opts = opts || {};
    const onProgress = opts.onProgress || (() => {});

    const text = await file.text();
    const result = Papa.parse(text, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: h => h.trim(),
    });

    if (!result.meta.fields || result.meta.fields.length === 0) {
      throw new Error('CSV has no header row');
    }
    const cols = buildColumnLookup(result.meta.fields);

    const rows = result.data.map((row, idx) => {
      const lat = cols.lat ? pickNumber(row[cols.lat]) : null;
      const lon = cols.lon ? pickNumber(row[cols.lon]) : null;
      const id = (cols.id ? String(row[cols.id] || '').trim() : '') || `row-${idx + 1}`;
      const name = (cols.name ? String(row[cols.name] || '').trim() : '') || id;
      const address = cols.address ? String(row[cols.address] || '').trim() : '';
      const postalCode = cols.postalCode ? String(row[cols.postalCode] || '').trim() : '';
      const city = cols.city ? String(row[cols.city] || '').trim() : '';
      const state = cols.state ? String(row[cols.state] || '').trim() : '';
      return {
        id, name, address, postalCode, city, state,
        lat, lon, geocoded: false, raw: row,
      };
    });

    const needGeocode = rows.filter(r => r.lat == null || r.lon == null);

    if (needGeocode.length > 0) {
      onProgress(`Geocoding ${needGeocode.length} row(s) without lat/lon (rate-limited 1/sec)…`);
      for (let i = 0; i < needGeocode.length; i += 1) {
        const r = needGeocode[i];
        const query = buildAddressQuery(r);
        if (!query) continue;
        try {
          const result = await geocodeAddress(query);
          if (result) {
            r.lat = result.lat;
            r.lon = result.lon;
            r.geocoded = true;
          }
        } catch (err) {
          // Log but keep going; row will be skipped from the map
          console.warn('Geocode failed for', query, err);
        }
        onProgress(`Geocoded ${i + 1} / ${needGeocode.length}…`);
        if (i < needGeocode.length - 1) await sleep(GEOCODE_DELAY_MS);
      }
    }

    // Drop rows that still have no usable coordinates
    const usable = rows.filter(r => r.lat != null && r.lon != null);
    return { properties: usable, skipped: rows.length - usable.length };
  }

  function buildAddressQuery(r) {
    const parts = [r.address, r.city, r.state, r.postalCode].filter(Boolean);
    return parts.join(', ').trim() || null;
  }

  async function geocodeAddress(query) {
    const cacheKey = 'geocode:' + query.toLowerCase();
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && isFinite(parsed.lat) && isFinite(parsed.lon)) return parsed;
      }
    } catch (_) { /* ignore */ }

    const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!Array.isArray(json) || json.length === 0) return null;
    const hit = json[0];
    const out = { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon) };
    if (!isFinite(out.lat) || !isFinite(out.lon)) return null;
    try { localStorage.setItem(cacheKey, JSON.stringify(out)); } catch (_) { /* ignore quota */ }
    return out;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  window.PropertiesCSV = { parseCsvFile };
})();
