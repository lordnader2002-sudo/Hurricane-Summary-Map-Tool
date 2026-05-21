# Hurricane Summary Map Tool — Architecture & Integration Overview

## 1. What the tool does

It takes the GIS files NOAA's National Hurricane Center (NHC) publishes
for an active storm and a list of locations the user cares about
(stores, depots, customer sites, anything with an address or lat/lon),
and produces a single decision-ready map: storm cone, forecast track,
coastal watches/warnings, and every location highlighted as either
*at risk* (inside the cone or within an adjustable distance buffer of
the track centerline) or *not*.

Outputs:

- **Live interactive map** in the browser (pan, zoom, click).
- **PNG snapshot** of the map suitable for dropping into briefings.
- **PDF** — single landscape page of the same composited map.
- **CSV of impacted locations** with distance-to-track and a
  manually-flagged column.
- **Shareable URL** that captures the full state (parsed storm,
  property list, callouts, manual overrides, comparison) so any
  recipient opens the URL and sees exactly the same view, no
  re-upload required.

It replaces a manual Google Maps + screenshot + drag-on-KMZ workflow.

## 2. Stack

| Layer | Technology | Notes |
|---|---|---|
| Language | Vanilla **JavaScript (ES2017+)** | No framework, no build step. |
| Markup / styling | **HTML5**, **CSS3** | Plain, no preprocessor. |
| Map engine | **[Leaflet](https://leafletjs.com/) 1.9.x** | OpenStreetMap raster tiles. |
| Geospatial math | **[Turf.js](https://turfjs.org/) 6.5.x** | `booleanPointInPolygon`, `pointToLineDistance`, `distance`, `boolean-point-in-polygon`. |
| KMZ / ZIP extraction | **[JSZip](https://stuk.github.io/jszip/) 3.x** | Unpacks the `.kmz` / `.zip` containers. |
| KML parsing | Native **`DOMParser`** | No KML library; the tool walks the XML directly to extract coordinates and styles. |
| Shapefile parsing | **[shpjs](https://github.com/calvinmetcalf/shapefile-js) 4.x** | Reads the NHC 5-day shapefile bundle. |
| CSV parsing | **[PapaParse](https://www.papaparse.com/) 5.x** | Auto-detected headers, alias mapping. |
| Geocoding (fallback) | **OpenStreetMap Nominatim** | Free, no API key; rate-limited to 1 req/s; results cached in `localStorage`. |
| URL state compression | **[LZ-String](https://github.com/pieroxy/lz-string) 1.5.x** | Compresses the embedded share payload. |
| PDF emission | **[jsPDF](https://github.com/parallax/jsPDF) 2.5.x (UMD)** | Single-page landscape, fit-to-page. |
| Headless test harness | **Node.js + jsdom + @turf/turf + jszip + papaparse + @mapbox/shp-write** | `scripts/smoke-test.js`. |

**Vendor libraries are all self-hosted** in `vendor/` and referenced by
relative path — no CDN at runtime. The only external network requests
at runtime are (1) OpenStreetMap raster tiles and (2) Nominatim if a
CSV row needs geocoding. Both can be swapped (see §10).

No backend. No database. No build step. The entire tool is static
files; serve `index.html` and any sibling assets from any HTTP server
or CDN.

## 3. Repository layout

```
index.html                 UI shell (toolbar, side panel, dialogs)
css/style.css              Styling
js/
  toast.js                 Dismissible notification stack
  kmz.js                   KMZ/KML parse + CONE/TRACK/WW classification + multi-file merge
  shapefile.js             NHC shapefile .zip parsing (via shpjs)
  csv.js                   CSV parse + Nominatim fallback geocoding
  impact.js                Cone-containment + buffer-distance impact logic
  map.js                   Leaflet rendering — cone, track, callouts, markers
  export.js                PNG, PDF, CSV export
  session.js               Snapshot to localStorage (debounced, restore banner)
  share.js                 Compressed URL hash state (embeds parsed data)
  timeline.js              Interpolated storm position + properties-near helpers
  compare.js               Diff between two advisories
  app.js                   Wires UI controls to the modules above
vendor/                    Self-hosted libraries (no CDN)
scripts/smoke-test.js      Headless Node test for the parse pipeline
package.json               Dev dependencies for the smoke test only
```

Module pattern: each file is an IIFE that publishes one namespace on
`window` (e.g. `window.HurricaneMap`, `window.ImpactEngine`,
`window.HurricaneToast`). There is no module bundler; load order is
specified in `index.html`. This keeps the deploy artifact a literal
folder of files.

## 4. Data formats consumed

### 4.1 NHC KMZ — combined best-track
A single `.kmz` containing track points and wind-radii polygons. KML
parsed via `DOMParser`; the tool walks `<Placemark>` elements to
extract `<Point>` coordinates, `<LineString>` for the track,
`<Polygon>` for cone/wind radii, and `<styleUrl>` to map each point
to a Saffir-Simpson category icon embedded in the KMZ.

### 4.2 NHC per-advisory KMZ trio
For an active storm the NHC publishes three KMZs per advisory:

- `…_5day_xx.kmz` — forecast cone polygon
- `…_track_5day_xx.kmz` — forecast points + line
- `…_ww_xx.kmz` — coastal watches & warnings as `<LineString>`s
  colored by category (Hurricane Warning, Hurricane Watch, Tropical
  Storm Warning, Tropical Storm Watch, Storm Surge Warning/Watch)

The user uploads them together (multi-select); `kmz.js` classifies
each file by name pattern + content sniffing and merges into one
normalized storm object. Re-uploading a file of the same type (e.g.
a newer CONE) replaces the old one.

### 4.3 NHC shapefile bundle
A `.zip` containing the `.shp/.dbf/.shx/.prj` quadruple. Parsed via
shpjs into GeoJSON, then normalized to match the same internal storm
shape the KMZ path produces. Watch/warning shapefiles inside the
bundle are detected by attribute (`TCWW`, `TYPE`, etc.) and mapped to
the same five WW categories.

### 4.4 Properties CSV
Headers are alias-tolerant:

| Field | Accepted column names |
|---|---|
| id | `property_id`, `id`, `code`, `store_id`, `store_code` |
| name | `name`, `property_name`, `property`, `store_name` |
| address | `address`, `street`, `full_address`, `street_address` |
| postal_code | `postal_code`, `postcode`, `zip`, `zipcode` |
| lat | `lat`, `latitude`, `y` |
| lon | `lon`, `lng`, `long`, `longitude`, `x` |

Rows with finite lat/lon use them directly. Rows with only an address
are queued for Nominatim geocoding; results are cached in
`localStorage` keyed by the normalized address.

### 4.5 Normalized internal storm object
After parsing/merging, every code path downstream works against this
shape (defined in `js/kmz.js`):

```js
{
  stormName,            // string
  advisoryDate,         // 'YYYY-MM-DD' or null
  trackPoints,          // GeoJSON FeatureCollection of Points
                        //   each feature.properties: { name, timestamp, category, categoryLabel }
  trackLine,            // GeoJSON Feature<LineString> | null
  cone,                 // GeoJSON Feature<Polygon|MultiPolygon> | null
  ww: [                 // watch/warning segments
    { category, label, color, geometry }
  ],
  iconMap,              // { [category]: dataURL }  — extracted from KMZ styles
  sources,              // ['CONE','TRACK','WW', ...]
}
```

This is the *contract* between the parse layer and everything above
it (impact, map, export, timeline, compare). A partner system that
already has a normalized advisory object can skip the parse layer
entirely and feed this shape directly into `HurricaneMap`.

## 5. Impact algorithm

`js/impact.js`. For each property:

1. **In cone**: `turf.booleanPointInPolygon(point, cone)` — if true, impacted.
2. **Within buffer**: `turf.pointToLineDistance(point, trackLine, {units:'miles'})` — if ≤ slider value, impacted.

A property is **impacted** if either is true. The user can override
either verdict per-property by clicking the dot on the map (the
manual override Map is keyed by property id and is included in the
session snapshot and share URL).

Buffer is user-adjustable 0–500 miles. Recompute is O(n) per
property and runs on every slider input, every file upload, and
every manual-override toggle. Sub-second for ≤10k properties in
practice.

## 6. Rendering

`js/map.js`. Leaflet map with OpenStreetMap tiles (no API key, no
billing). Vector overlays are drawn into Leaflet's
**canvas renderer** rather than SVG so the exporter can copy the
canvas straight into the PNG (see §8).

Layers, from bottom up:

1. OSM raster tiles.
2. Cone polygon (blue, 35% fill).
3. Watch/warning line segments (colored per category).
4. Forecast track line (black).
5. Property dots (gray = unaffected, red = impacted).
6. Red leader lines from clustered impacted properties to their callout box.
7. Track-point markers — choice of category icon, hurricane glyph,
   dot, square, or triangle; per-point color override.
8. Callout boxes — HTML `divIcon` overlays, draggable, clickable to
   edit text. One box per cluster of impacted properties (within
   `CALLOUT_CLUSTER_MILES = 30 mi` of each other).
9. Optional scrub marker (yellow halo at interpolated storm
   position) when the timeline scrubber is active.

State changes go through a single `recomputeAndRender()` in
`js/app.js` so the side-panel impacted list, the map, and the
comparison diff stay in sync.

## 7. Persistence

### 7.1 localStorage (`js/session.js`)
The full state — parts, properties, customizations, comparison
advisory, manual overrides — is debounced-written under the key
`hurricane-tool-session-v3`. On page load, if a snapshot exists, a
yellow banner offers **Restore** or **Start fresh**. The toolbar
**Reset** button clears the snapshot and reloads.

### 7.2 Shareable URL (`js/share.js`)
The same state, with the parsed parts embedded, is JSON-stringified,
LZ-String-compressed, and placed in the URL hash fragment
(`#s=<encoded>`). Recipients open the URL and `applyPending()`
hydrates the state directly — no upload step.

Typical URL size for a 5-day advisory + a few dozen properties:
**3–15 KB**. Well within email, Slack, and clipboard limits. The
toast shown on **Share view** displays the exact size so the sender
knows.

Backward compatibility: older filenames-only share URLs (v2) are
still accepted and route through a fall-back upload-and-replay
flow.

## 8. Export pipeline (`js/export.js`)

A common `buildExportCanvas()` does the heavy lifting; PNG and PDF
each wrap it.

The exporter does **not** re-fetch tiles or markers (the old
`leaflet-image` approach could hang indefinitely if any tile failed
to load). Instead it composites straight from what the browser has
*already rendered* into the DOM:

1. Tile `<img>` elements from the tile pane (`.complete` and non-zero
   `naturalWidth` only).
2. Leaflet's canvas-renderer `<canvas>` from the overlay pane — which
   already has the cone, WW lines, track line, property dots, and
   red leader lines drawn into it.
3. Track-point marker `<img>` icons from the marker pane.
4. Callout boxes and track-point text labels — these are HTML
   divIcons/tooltips, not pixels, so they're drawn by hand on top
   using `CanvasRenderingContext2D` against the same coordinate
   system Leaflet uses (`map.latLngToContainerPoint`).

The composited canvas is encoded to PNG via `canvas.toBlob()` and
downloaded. For PDF the same canvas is wrapped in a single-page
landscape Letter via `jsPDF.addImage()` with fit-to-page scaling.

The whole pipeline is synchronous except the final `toBlob` — it
cannot hang. A CORS-tainted canvas (rare, but possible if a tile
server omits the right headers) fails with a clear error toast
rather than silently producing a blank PNG.

## 9. Notification, accessibility, keyboard

- **Toasts** (`js/toast.js`) — dismissible bottom-right stack with
  `aria-live="assertive"`. Errors include a collapsed `<details>`
  with the full stack.
- **ARIA landmarks** on toolbar (`role="toolbar"`), status
  (`aria-live="polite"`), banner, timeline region; explicit
  `aria-label` on the icon-only timeline-clear button.
- **Focus-visible outlines** on every interactive control.
- **Keyboard shortcuts**:

  | Action | Shortcut |
  |---|---|
  | Export PNG | `Ctrl/⌘ + E` |
  | Share view | `Ctrl/⌘ + Shift + S` |
  | Step timeline | `← / →` |
  | Clear scrub / comparison | `Esc` |
  | Toggle help overlay | `?` |

## 10. Runtime, hosting, and offline behaviour

- **Static hosting**: any HTTP server. GitHub Pages is used today at
  https://lordnader2002-sudo.github.io/hurricane-summary-map-tool/ —
  no build, deploys on push to `main`.
- **CSP**: the tool only needs `script-src 'self'`, `style-src 'self'`,
  `connect-src https://nominatim.openstreetmap.org`,
  `img-src 'self' https://*.tile.openstreetmap.org data: blob:`. No
  inline scripts; no `eval`. `data:` is needed for the category
  icons embedded in NHC KMZs; `blob:` for the PNG/PDF download
  flow.
- **Offline**: everything runs locally except map tiles and
  geocoding. If you pre-geocode the CSV (so lat/lon is populated)
  and pre-warm tiles in the browser cache, the tool works offline.
  For a permanently-offline deployment, swap the tile URL in
  `js/map.js` to an internal MBTiles / vector-tile server.
- **No telemetry, no analytics, no third-party scripts** beyond the
  vendor libraries listed in §2 (all self-hosted).
- **Same-origin only for state**: localStorage and the share URL hash
  stay on the deploying origin; nothing is sent off-box.

## 11. Integration touchpoints for a host system

If MappedIN (or any partner) wants to embed or interoperate with this
tool, the cleanest seams are:

### 11.1 Embed as-is (iframe)
- Drop the static folder behind a path on your domain and load
  `index.html` in an `<iframe>`. The tool is responsive and uses a
  two-column grid that collapses to single-column under 900px wide.
- Use the `#s=…` share URL as the iframe `src` to launch the
  iframe in a pre-populated state.
- `postMessage` is not wired today but is a one-function add if
  you want bidirectional state sync.

### 11.2 Programmatic state injection
Skip the file upload UI entirely by:

1. Building a v3 share payload server-side (it's just a JSON shape
   matching `share.js encode()`'s output — see §7.2 and §4.5).
2. LZ-String-compressing it.
3. Loading the tool with `#s=<compressed>` in the URL.

This lets a host system push *its* parsed advisory + property list
into the tool without the user touching a file picker. All four
exports (PNG, PDF, CSV, share-URL) and the comparison view work
identically.

### 11.3 Reuse individual modules
Each `js/*.js` module is independently usable in another browser
context (they only depend on `window` globals declared in their
header comments). Particularly useful headless:

- `HurricaneKMZ.parseToParts(files)` / `mergeParts(parts)` — NHC
  parse pipeline that yields the normalized storm object in §4.5.
- `PropertiesCSV.parseCsvFile(file, {onProgress})` — alias-tolerant
  CSV ingest + geocoding fallback.
- `ImpactEngine.computeImpact(properties, storm, bufferMiles)` —
  pure function, returns annotated properties; no DOM.
- `HurricaneCompare.diffImpacts(a, b)` / `trackShift(s1, s2)` — pure.
- `HurricaneTimeline.interpolatePosition(trackPoints, t)` — pure.

`scripts/smoke-test.js` shows how to run the parse + impact stack
under Node + jsdom without a browser.

### 11.4 Replace the tile layer
One line in `js/map.js` (`L.tileLayer(...)` call) — swap in your
own raster or vector tile source. Coordinate system is Web Mercator
(EPSG:3857), same as OSM.

### 11.5 Replace geocoding
`js/csv.js` calls `https://nominatim.openstreetmap.org/search?…`.
Swap to your geocoder by editing `NOMINATIM_URL` and the response
parsing (~20 lines). The rate-limit delay constant
`GEOCODE_DELAY_MS = 1100` exists only to comply with Nominatim's
ToS; remove for a commercial geocoder.

## 12. Verification & testing

- **Headless smoke test**: `npm install && npm run smoke-test` runs
  `scripts/smoke-test.js` — exercises the full parse + merge +
  impact pipeline under Node + jsdom against synthesized KMZ,
  multi-file CONE/TRACK/WW merge, and shapefile-zip fixtures.
- **Browser smoke**: `python3 -m http.server 8000 && open
  http://localhost:8000/`. Drop any NHC `.kmz` and a properties
  `.csv` in.
- **Round-trip share check**: load the tool, upload data, click
  **Share view**, paste the URL into a private window — the map
  should populate identically with no upload step.

There is no DOM/UI test harness today (no Puppeteer/Playwright). A
manual checklist is recommended for the export, share, and
comparison surfaces.

## 13. License & dependencies inventory

The application code is the project owner's; vendored libraries
retain their original licenses:

| Library | License |
|---|---|
| Leaflet | BSD-2-Clause |
| JSZip | MIT or GPLv3 (dual) |
| PapaParse | MIT |
| Turf.js | MIT |
| shpjs | MIT |
| LZ-String | MIT or WTFPL |
| jsPDF | MIT |

All are widely used in commercial GIS dashboards.

## 14. Open extension points worth mentioning

Items the tool intentionally does not do today but could:

- **Vector tiles** (vs. raster OSM) — would improve offline /
  high-density rendering.
- **Multi-property batch override** — currently one click per dot.
- **Postal-code polygon impact** — currently point-based only;
  could ingest a ZIP-code shapefile and color polygons.
- **PostMessage / event bus** for embed-in-iframe coordination.
- **Server-driven advisories** — currently file-driven; a
  background fetcher of the NHC `wsr/` GIS endpoint could keep the
  tool live without manual upload.

---

*For questions on any of the above, see the inline comments at the
top of each `js/*.js` module — they document the contract and
caller-visible API for each piece.*
