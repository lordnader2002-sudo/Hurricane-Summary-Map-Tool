# Hurricane Summary Map Tool — Tech One-Pager

Static-file web app, no backend, no build step. Vanilla JS modules wired
together in `index.html`; each library does one job and the seams between
them are thin.

## Language & runtime
- **HTML5 / CSS3 / vanilla JavaScript (ES2017+)**. No framework, no
  transpiler. Each `js/*.js` is an IIFE that publishes one namespace on
  `window` (e.g. `HurricaneKMZ`, `HurricaneMap`, `ImpactEngine`). Load
  order is set by the `<script>` tags in `index.html`.

## Map rendering — Leaflet 1.9.x
Leaflet provides the pan/zoom map, the tile layer, and the coordinate
system (Web Mercator). We pin two non-default choices: the **canvas
renderer** (not SVG) for vector overlays, so the exporter can copy the
canvas straight into a PNG; and **fractional zoom** for finer framing.
The base layer is OpenStreetMap raster tiles — no API key.

## Geospatial math — Turf.js 6.5.x
Three Turf calls do all the analysis:
- `turf.booleanPointInPolygon(point, cone)` → "is this property inside
  the forecast cone?"
- `turf.pointToLineDistance(point, trackLine, {units:'miles'})` → "how
  far is this property from the track centerline?"
- `turf.distance(a, b, {units:'miles'})` → used by the comparison view
  to compute per-track-point shift between two advisories.
A property is *impacted* if it's in the cone OR within the buffer.

## KMZ / KML ingest — JSZip + native DOMParser
NHC publishes each advisory as three KMZs (`CONE`, `TRACK`, `WW`).
**JSZip** unpacks the `.kmz` (it's just a zipped KML); we then walk the
KML with the browser's built-in **`DOMParser`** — no KML library — to
pull out `<Point>`, `<LineString>`, `<Polygon>`, and `<styleUrl>`.
`kmz.js` classifies each file by name + content sniffing and merges all
parts into one normalized storm object.

## Shapefile ingest — shpjs 4.x
For the NHC 5-day shapefile bundle (`.shp/.dbf/.shx/.prj` in a zip),
**shpjs** does the heavy lifting, returning GeoJSON we normalize to the
same internal shape KMZ produces.

## CSV ingest — PapaParse 5.x + Nominatim
**PapaParse** parses the properties CSV with alias-tolerant headers (six
columns, ~25 accepted names). Rows that already have `lat`/`lon` are
used directly; rows with only an address are queued for
**OpenStreetMap Nominatim** (rate-limited 1 req/sec; results cached in
`localStorage`).

## State persistence — LZ-String 1.5.x
The full session — parsed parts, properties, callouts, manual overrides,
comparison advisory — is JSON-stringified and either:
- written to `localStorage` (key `hurricane-tool-session-v3`,
  debounced), surfaced as a yellow Restore banner on the next visit; or
- **LZ-String-compressed** into a URL hash (`#s=…`) for **Share view**.
  A typical advisory + 30 properties compresses to ~3 KB — recipients
  open the URL and the map auto-populates, no re-upload.

## Export pipeline — DOM compositing + jsPDF 2.5.x
PNG export doesn't re-fetch anything; it composites what the browser
*already painted* — tile `<img>`s from the tile pane, Leaflet's vector
`<canvas>`, and marker icons — onto one canvas, then draws callouts and
track-point labels on top in 2D `Canvas` calls. `canvas.toBlob()`
downloads it. **jsPDF** wraps the same canvas in a single-page landscape
PDF via `addImage()` with fit-to-page scaling. The pipeline is
synchronous except the final encode and **cannot hang** (the old
`leaflet-image` approach could).

## Vendoring & deploy
All libraries are **self-hosted in `vendor/`** — no CDN. The deploy
artifact is the folder. GitHub Pages serves `main` directly; any static
host works the same way.

## Testing
`scripts/smoke-test.js` runs the parse + merge + impact stack headless
under **Node + jsdom + @turf/turf + jszip + papaparse + @mapbox/shp-write**
against synthesized KMZ, multi-file CONE/TRACK/WW merge, and shapefile-zip
fixtures. `npm run smoke-test`.
