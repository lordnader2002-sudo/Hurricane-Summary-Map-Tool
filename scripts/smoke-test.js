/*
 * Offline smoke test for the hurricane file pipeline.
 *
 * Exercises, without a browser:
 *   1. A combined best-track .kmz                          (real sample file)
 *   2. Multi-file merge of separate CONE / TRACK / WW KMLs  (synthesized)
 *   3. A shapefile .zip bundle                             (synthesized)
 *   4. Impact computation against the properties CSV
 *
 * Run from the repo root:
 *   node scripts/smoke-test.js <path-to.kmz> <path-to.csv>
 *
 * The KMZ + CSV args are optional; tests 2 and 3 run regardless.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { JSDOM } = require('jsdom');
const Papa = require('papaparse');
const turf = require('@turf/turf');
const shpwrite = require('@mapbox/shp-write');

// jsdom window so the modules see a browser-like DOM
const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.JSZip = JSZip;
global.DOMParser = dom.window.DOMParser;
global.Papa = Papa;
global.turf = turf;
global.shp = require(path.join(__dirname, '..', 'vendor', 'shp.min.js'));
global.window = global;
global.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] || null; },
  setItem(k, v) { this._s[k] = String(v); },
};
global.fetch = async () => { throw new Error('geocoding disabled in smoke test'); };

function loadModule(p) {
  // eslint-disable-next-line no-new-func
  new Function(fs.readFileSync(p, 'utf8')).call(global);
}
['kmz.js', 'shapefile.js', 'csv.js', 'impact.js'].forEach(
  m => loadModule(path.join(__dirname, '..', 'js', m))
);

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('  ✓ ' + msg);
  } else {
    console.log('  ✗ ' + msg);
    failures += 1;
  }
}

// Helper: wrap a string/buffer as a File-like object the parser accepts
function fakeFile(name, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return {
    name,
    text: async () => buf.toString('utf8'),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

async function testCombinedKmz(kmzPath, csvPath) {
  console.log('\n[1] Combined best-track .kmz');
  if (!kmzPath || !fs.existsSync(kmzPath)) {
    console.log('  - skipped (no .kmz arg provided)');
    return;
  }
  const kmzBuf = fs.readFileSync(kmzPath);
  const storm = await global.HurricaneKMZ.parseFiles([fakeFile(path.basename(kmzPath), kmzBuf)]);
  assert(!!storm.stormName, `storm name parsed: "${storm.stormName}"`);
  assert(storm.trackPoints.features.length > 0,
    `track points: ${storm.trackPoints.features.length}`);
  assert(!!storm.cone, 'cone polygon present');
  assert(!!storm.trackLine, 'track line present');

  if (csvPath && fs.existsSync(csvPath)) {
    const csvBuf = fs.readFileSync(csvPath);
    const { properties } = await global.PropertiesCSV.parseCsvFile(
      fakeFile(path.basename(csvPath), csvBuf), { onProgress: () => {} }
    );
    assert(properties.length > 0, `properties parsed: ${properties.length}`);
    [100, 400].forEach(b => {
      const annotated = global.ImpactEngine.computeImpact(properties, storm, b);
      const n = annotated.filter(p => p.impacted).length;
      console.log(`    buffer=${b}mi → impacted=${n}`);
    });
  }
}

async function testMultiFileMerge() {
  console.log('\n[2] Multi-file merge: separate CONE + TRACK + WW KMLs');

  const coneKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://earth.google.com/kml/2.2"><Document><name>AL092022</name>
  <Placemark><name>Cone</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
    -84,24 -84,30 -78,31 -78,24 -84,24
  </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Document></kml>`;

  const trackKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://earth.google.com/kml/2.2"><Document><name>AL092022</name>
  <Placemark><name>1200 UTC SEP 28</name><styleUrl>#cat4</styleUrl>
    <Point><coordinates>-82.5,26.5,0</coordinates></Point></Placemark>
  <Placemark><name>0000 UTC SEP 29</name><styleUrl>#cat2</styleUrl>
    <Point><coordinates>-81.0,28.0,0</coordinates></Point></Placemark>
  <Placemark><name>Forecast Track</name><LineString><coordinates>
    -82.5,26.5,0 -81.0,28.0,0 -79.5,30.0,0
  </coordinates></LineString></Placemark>
</Document></kml>`;

  const wwKml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://earth.google.com/kml/2.2"><Document><name>AL092022</name>
  <Placemark><name>Hurricane Warning</name><LineString><coordinates>
    -82.8,26.0,0 -82.6,27.2,0 -82.3,28.1,0
  </coordinates></LineString></Placemark>
  <Placemark><name>Tropical Storm Warning</name><LineString><coordinates>
    -81.9,28.6,0 -81.2,29.4,0
  </coordinates></LineString></Placemark>
</Document></kml>`;

  const storm = await global.HurricaneKMZ.parseFiles([
    fakeFile('AL092022_015Aadv_CONE.kml', coneKml),
    fakeFile('AL092022_015Aadv_TRACK.kml', trackKml),
    fakeFile('AL092022_015Aadv_WW.kml', wwKml),
  ]);

  assert(!!storm.cone, 'cone merged in from CONE file');
  assert(storm.trackPoints.features.length === 2,
    `track points merged in from TRACK file: ${storm.trackPoints.features.length}`);
  assert(!!storm.trackLine, 'track line merged in from TRACK file');
  assert(storm.ww.length === 2, `WW segments merged in from WW file: ${storm.ww.length}`);
  assert(storm.ww.some(w => w.category === 'hurricane-warning'), 'WW: hurricane warning classified');
  assert(storm.ww.some(w => w.category === 'ts-warning'), 'WW: tropical storm warning classified');
  assert(storm.sources.length === 3, `sources: ${storm.sources.join(' + ')}`);

  // Impact: a point inside the cone should be flagged
  const inside = global.ImpactEngine.computeImpact(
    [{ id: 'X', name: 'Inside', lat: 27, lon: -81 }], storm, 0
  )[0];
  assert(inside.inCone === true, 'property inside the merged cone is flagged inCone');
}

async function testShapefileZip() {
  console.log('\n[3] Shapefile .zip bundle');

  // Build a 5-day-style bundle: cone polygon + forecast line + forecast points
  const bundle = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { TCWW: '' },
        geometry: { type: 'Polygon', coordinates: [[
          [-84, 24], [-84, 30], [-78, 31], [-78, 24], [-84, 24],
        ]] } },
      { type: 'Feature', properties: { STORMNAME: 'TESTSTORM' },
        geometry: { type: 'LineString', coordinates: [
          [-82.5, 26.5], [-81, 28], [-79.5, 30],
        ] } },
      { type: 'Feature',
        properties: { STORMNAME: 'TESTSTORM', MAXWIND: 115, FLDATELBL: '2022-09-28 14:00' },
        geometry: { type: 'Point', coordinates: [-82.5, 26.5] } },
      { type: 'Feature',
        properties: { STORMNAME: 'TESTSTORM', MAXWIND: 75, FLDATELBL: '2022-09-29 02:00' },
        geometry: { type: 'Point', coordinates: [-81, 28] } },
    ],
  };
  const zipBuf = await shpwrite.zip(bundle, { outputType: 'nodebuffer', compression: 'STORE' });
  const storm = await global.HurricaneKMZ.parseFiles([fakeFile('al092022_5day.zip', zipBuf)]);

  assert(!!storm.cone, 'cone polygon parsed from shapefile');
  assert(storm.trackPoints.features.length === 2,
    `track points parsed from shapefile: ${storm.trackPoints.features.length}`);
  assert(!!storm.trackLine, 'track line parsed from shapefile');
  const cats = storm.trackPoints.features.map(f => f.properties.category);
  assert(cats.includes('cat4'), `intensity → category mapping works (got ${cats.join(',')})`);

  // WW shapefile as its own zip
  const wwBundle = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { TCWW: 'HWW' },
        geometry: { type: 'LineString', coordinates: [[-82.8, 26], [-82.3, 28]] } },
      { type: 'Feature', properties: { TCWW: 'TWW' },
        geometry: { type: 'LineString', coordinates: [[-81.9, 28.6], [-81.2, 29.4]] } },
    ],
  };
  const wwZip = await shpwrite.zip(wwBundle, { outputType: 'nodebuffer', compression: 'STORE' });
  const wwStorm = await global.HurricaneKMZ.parseFiles([fakeFile('al092022_ww.zip', wwZip)]);
  assert(wwStorm.ww.length === 2, `WW segments parsed from shapefile: ${wwStorm.ww.length}`);
  assert(wwStorm.ww.some(w => w.category === 'hurricane-warning'),
    'WW shapefile: HWW → hurricane warning');
}

async function run() {
  await testCombinedKmz(process.argv[2], process.argv[3]);
  await testMultiFileMerge();
  await testShapefileZip();

  console.log('\n' + (failures === 0
    ? 'All smoke-test assertions passed.'
    : `${failures} assertion(s) FAILED.`));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FAILED:', (err && err.stack) || err);
  process.exit(1);
});
