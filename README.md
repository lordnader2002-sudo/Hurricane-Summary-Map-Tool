# Hurricane Summary Map Tool

A self-contained, browser-based tool for producing the hurricane summary map
deliverable: upload NOAA hurricane GIS file(s) and a properties CSV, and the
tool overlays the storm track, cone, and coastal watches/warnings on a map and
auto-highlights any company properties that fall inside the cone or within an
adjustable distance of the track centerline. Export the result as a PNG for
inclusion in your summary slides.

It replaces the current manual process (Google Maps + screenshot of pinned
properties + dragged-on KMZ).

## How to use

1. Open `index.html` in any modern browser, either by double-clicking the file
   or by serving the folder with a tiny static server, e.g.

   ```sh
   python3 -m http.server 8000
   # then visit http://localhost:8000/
   ```

2. **Upload KMZ / ZIP** — pick the latest NOAA file(s). The button accepts
   **multiple files at once**, so you can select all the pieces of an advisory
   together. Supported inputs:

   - A combined **best-track `.kmz`** (track points + wind-radii polygons in
     one file).
   - The NHC per-advisory **`CONE` / `TRACK` / `WW` `.kmz` files** — for an
     active storm the NHC splits each advisory into three KMZs (cone,
     forecast track, coastal watches & warnings). Select all three together,
     or add them one at a time; the tool classifies each by name/content and
     merges them into one storm. Re-uploading a file of the same type (e.g. a
     newer `CONE`) replaces the old one.
   - The NHC **5-day shapefile bundle (`.zip`)** — the zipped `.shp/.dbf/.shx`
     set. The tool reads the cone polygon, forecast track line, forecast
     points, and any watch/warning shapefiles inside it.
   - A `.zip` containing `.kmz`/`.kml` files also works.

   Watches & warnings are drawn as colored coastal segments (Hurricane
   Warning red, Hurricane Watch pink, TS Warning blue, TS Watch yellow,
   Storm Surge purple/teal) and listed in the legend.

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

- It lies inside the cone / wind-radii polygon from the KMZ or shapefile, **or**
- It is within the user-chosen buffer distance (default 100 mi) of the storm
  track centerline.

The cone test uses `@turf/boolean-point-in-polygon`; the buffer test uses
`@turf/point-to-line-distance`. Both run client-side in the browser.

## Tech

- [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles (no API key, no billing)
- [JSZip](https://stuk.github.io/jszip/) for unzipping the `.kmz` / `.zip`
- [shpjs](https://github.com/calvinmetcalf/shapefile-js) for parsing shapefile bundles
- [PapaParse](https://www.papaparse.com/) for CSV
- [Turf.js](https://turfjs.org/) for geospatial math
- [leaflet-image](https://github.com/mapbox/leaflet-image) for PNG export

All vendor libraries are self-hosted in the `vendor/` folder and referenced by
`index.html` with relative paths — no CDN, so the tool works on locked-down
networks and fully offline (map tiles still need internet, but everything else
runs locally). The only external request at runtime is OpenStreetMap tiles
(and Nominatim, if a CSV row needs geocoding).

## File layout

```
index.html        - UI shell
css/style.css     - Styling (mimics the existing summary-slide aesthetic)
js/kmz.js         - KMZ/KML parsing, CONE/TRACK/WW classification, multi-file merge
js/shapefile.js   - NHC shapefile .zip parsing (via shpjs)
js/csv.js         - CSV parsing + Nominatim fallback geocoding
js/impact.js      - Cone-containment + buffer-distance impact logic
js/map.js         - Leaflet map setup, layers, callout + watch/warning rendering
js/export.js      - PNG export (canvas + manual callout rendering)
js/app.js         - Wires the UI controls to the modules above
vendor/           - Self-hosted Leaflet, JSZip, PapaParse, Turf, leaflet-image, shpjs
scripts/          - Headless Node smoke test
```

## Hosting it for the team (GitHub Pages)

Because the tool is plain static files, GitHub Pages can host it for free —
coworkers just open a URL, no install. The repo's Pages is configured to
deploy from the `main` branch root, so anything merged to `main` goes live at:

```
https://lordnader2002-sudo.github.io/hurricane-summary-map-tool/
```

Allow ~1 minute after a merge for the deploy to finish.

## Sample data

Provide your own. NOAA hurricane KMZs are available from the National
Hurricane Center (https://www.nhc.noaa.gov/), under "GIS data" for each
active or historical storm.

Note on file types:

- **Forecast products** (the 5-day cone, as either a KMZ or a shapefile
  `.zip`) contain a large cone-of-uncertainty polygon. Properties under the
  cone are flagged immediately — this is the typical "what's at risk?"
  workflow. For an active storm the NHC splits the advisory into separate
  `CONE` / `TRACK` / `WW` KMZ files; upload them together.
- **Best-track KMZ** (post-storm historical track) contains the actual storm
  centerline plus tighter wind-radii polygons. Many fewer properties will
  fall inside; you may need to widen the buffer slider to see impacts on
  storms that stayed offshore.

## Verifying parsing locally (optional)

For headless testing, the repo includes a Node smoke test that exercises the
KMZ, multi-file merge, shapefile `.zip`, CSV, and impact pipeline without a
browser:

```sh
npm install
npm run smoke-test -- path/to/storm.kmz path/to/properties.csv
```

The `.kmz` and `.csv` arguments are optional — the multi-file-merge and
shapefile tests run on synthesized fixtures regardless.

## Known limitations (v1)

- PNG export only — PDF / CSV-of-impacted exports are not yet implemented.
- Geocoding is rate-limited to 1 req/sec (Nominatim policy). If your CSV
  has many rows missing lat/lon, expect a wait. Pre-geocoding is strongly
  recommended.
- No persistence — uploaded files are not retained between page reloads.
- One storm at a time.
