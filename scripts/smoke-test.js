/*
 * Offline smoke test: exercise the KMZ + CSV + impact logic against the sample
 * files using Node. Mirrors what the browser does end-to-end (minus Leaflet
 * rendering and PNG export).
 *
 * Run from the repo root:
 *   node scripts/smoke-test.js <path-to.kmz> <path-to.csv>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { JSDOM } = require('jsdom');
const Papa = require('papaparse');
const turf = require('@turf/turf');

// Use a jsdom window so the modules see a real browser-like DOM (querySelector,
// localStorage, DOMParser, etc).
const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.JSZip = JSZip;
global.DOMParser = dom.window.DOMParser;
global.Papa = Papa;
global.turf = turf;
global.window = global;
global.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] || null; },
  setItem(k, v) { this._s[k] = String(v); },
};
global.fetch = async () => { throw new Error('geocoding disabled in smoke test'); };

function loadModule(p) {
  const src = fs.readFileSync(p, 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src).call(global);
}

loadModule(path.join(__dirname, '..', 'js', 'kmz.js'));
loadModule(path.join(__dirname, '..', 'js', 'csv.js'));
loadModule(path.join(__dirname, '..', 'js', 'impact.js'));

async function run() {
  const kmzPath = process.argv[2];
  const csvPath = process.argv[3];
  if (!kmzPath || !csvPath) {
    console.error('Usage: node scripts/smoke-test.js <kmz> <csv>');
    process.exit(1);
  }

  // --- KMZ ---
  const kmzBuf = fs.readFileSync(kmzPath);
  const kmzFile = {
    name: path.basename(kmzPath),
    arrayBuffer: async () => kmzBuf.buffer.slice(kmzBuf.byteOffset, kmzBuf.byteOffset + kmzBuf.byteLength),
    text: async () => kmzBuf.toString('utf8'),
  };
  const storm = await global.HurricaneKMZ.parseKmzFile(kmzFile);
  console.log('--- KMZ ---');
  console.log('Storm name:', storm.stormName);
  console.log('Advisory date:', storm.advisoryDate);
  console.log('Track points:', storm.trackPoints.features.length);
  console.log('Has cone polygon:', !!storm.cone);
  console.log('Track line vertices:', storm.trackLine ? storm.trackLine.geometry.coordinates.length : 0);
  console.log('Icon categories embedded:', Object.keys(storm.iconMap));
  if (storm.trackPoints.features.length) {
    const f0 = storm.trackPoints.features[0];
    const fN = storm.trackPoints.features[storm.trackPoints.features.length - 1];
    console.log('First point:', f0.properties.name, f0.properties.category, f0.geometry.coordinates);
    console.log('Last point: ', fN.properties.name, fN.properties.category, fN.geometry.coordinates);
  }

  // --- CSV ---
  const csvBuf = fs.readFileSync(csvPath);
  const csvFile = {
    name: path.basename(csvPath),
    text: async () => csvBuf.toString('utf8'),
  };
  const { properties, skipped } = await global.PropertiesCSV.parseCsvFile(csvFile, {
    onProgress: msg => process.stderr.write('  ' + msg + '\n'),
  });
  console.log('\n--- CSV ---');
  console.log('Properties parsed:', properties.length, 'skipped:', skipped);
  if (properties.length) {
    console.log('Sample:', properties[0]);
  }

  // --- Impact ---
  const buffers = [0, 50, 100, 200];
  console.log('\n--- Impact ---');
  buffers.forEach(b => {
    const annotated = global.ImpactEngine.computeImpact(properties, storm, b);
    const impacted = annotated.filter(p => p.impacted);
    const inCone = annotated.filter(p => p.inCone);
    console.log(`buffer=${b}mi → impacted=${impacted.length} (in cone=${inCone.length})`);
    if (b === 100) {
      const sample = impacted
        .sort((a, b) => (a.distMiles ?? Infinity) - (b.distMiles ?? Infinity))
        .slice(0, 8)
        .map(p => `${p.name} (${p.distMiles != null ? p.distMiles.toFixed(1) + ' mi' : '–'}${p.inCone ? ', in cone' : ''})`);
      console.log('   nearest 8:', sample);
    }
  });
}

run().catch(err => {
  console.error('FAILED:', err && err.stack || err);
  process.exit(1);
});
