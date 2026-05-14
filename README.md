# Hurricane Summary Map Tool

A self-contained, browser-based tool for producing the hurricane summary map
deliverable: upload a NOAA hurricane KMZ and a properties CSV, and the tool
overlays the storm track + cone on a map and auto-highlights any company
properties that fall inside the cone or within an adjustable distance of the
track centerline. Export the result as a PNG for inclusion in your summary
slides.

It replaces the current manual process (Google Maps + screenshot of pinned
properties + dragged-on KMZ).

## How to use

1. Open `index.html` in any modern browser, either by double-clicking the file
   or by serving the folder with a tiny static server, e.g.

   ```sh
   python3 -m http.server 8000
   # then visit http://localhost:8000/
   ```

2. **Upload KMZ** — pick the latest NOAA file (e.g.
   `al132025_best_track.kmz` or a 5-day forecast KMZ). The tool understands
   both best-track files (point markers + wind-radii polygons) and forecast
   files (cone of uncertainty polygon).

3. **Upload Properties CSV** — pick a CSV containing your retail properties.
   The expected columns are flexible:

   | Column | Aliases accepted |
   |---|---|
   | id | `property_id`, `id`, `code`, `store_id`, `store_code` |
   | name | `name`, `property_name`, `property`, `store_name` |
   | address | `address`, `street`, `full_address`, `street_address` |
   | postal_code | `postal_code`, `postcode`, `zip`, `zipcode` |
   | lat | `lat`, `latitude`, `y` |
   | lon | `lon`, `lng`, `long`, `longitude`, `x` |

   If a row already has lat/lon they're used directly. If only an address is
   present, the tool will geocode it via OpenStreetMap's free Nominatim
   service (1 request/sec, results cached in your browser's localStorage).

4. **Adjust the buffer slider** to widen or narrow the highlight radius around
   the track centerline (0–500 mi). Properties inside the cone polygon are
   *always* highlighted regardless of the slider.

5. **Toggle "Show callout labels"** to show/hide the on-map name boxes for
   impacted properties (mirrors the labeled callouts on the existing
   PowerPoint slide).

6. **Export PNG** — downloads a snapshot of the live map with the callout
   labels rendered onto it. The filename includes the storm name and advisory
   date, e.g. `AL132025_20251030_summary.png`.

The right-hand side panel always lists the impacted properties, sortable by
distance to track, name, or in-cone status. Click a row to fly the map to
that property.

## What gets highlighted

A property is "impacted" if **either**:

- It lies inside the cone / wind-radii polygon from the KMZ, **or**
- It is within the user-chosen buffer distance (default 100 mi) of the storm
  track centerline.

The cone test uses `@turf/boolean-point-in-polygon`; the buffer test uses
`@turf/point-to-line-distance`. Both run client-side in the browser.

## Tech

- [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles (no API key, no billing)
- [JSZip](https://stuk.github.io/jszip/) for unzipping the `.kmz`
- [PapaParse](https://www.papaparse.com/) for CSV
- [Turf.js](https://turfjs.org/) for geospatial math
- [leaflet-image](https://github.com/mapbox/leaflet-image) for PNG export

All vendor libraries are pulled from CDN by `index.html`. To run fully offline,
download them into a local `vendor/` folder and update the `<script>` tags.

## File layout

```
index.html        - UI shell
css/style.css     - Styling (mimics the existing summary-slide aesthetic)
js/kmz.js         - KMZ → KML → track points / cone / icons
js/csv.js         - CSV parsing + Nominatim fallback geocoding
js/impact.js      - Cone-containment + buffer-distance impact logic
js/map.js         - Leaflet map setup, layers, callout rendering
js/export.js      - PNG export (canvas + manual callout rendering)
js/app.js         - Wires the UI controls to the modules above
```

## Sample data

Provide your own. NOAA hurricane KMZs are available from the National
Hurricane Center (https://www.nhc.noaa.gov/), under "GIS data" for each
active or historical storm.

Note on KMZ types:

- **Forecast KMZ** (e.g. the 5-day cone) contains a large cone-of-uncertainty
  polygon. Properties under the cone will be flagged immediately — this is
  the typical "what's at risk?" workflow.
- **Best-track KMZ** (post-storm historical track) contains the actual storm
  centerline plus tighter wind-radii polygons. Many fewer properties will
  fall inside; you may need to widen the buffer slider to see impacts on
  storms that stayed offshore.

## Verifying parsing locally (optional)

For headless testing, the repo includes a Node smoke test that exercises the
KMZ + CSV + impact pipeline without a browser:

```sh
npm install jszip jsdom papaparse @turf/turf
node scripts/smoke-test.js path/to/storm.kmz path/to/properties.csv
```

## Known limitations (v1)

- PNG export only — PDF / CSV-of-impacted exports are not yet implemented.
- Geocoding is rate-limited to 1 req/sec (Nominatim policy). If your CSV
  has many rows missing lat/lon, expect a wait. Pre-geocoding is strongly
  recommended.
- No persistence — uploaded files are not retained between page reloads.
- One storm at a time.
