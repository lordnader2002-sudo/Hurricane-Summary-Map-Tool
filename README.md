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
   PowerPoint slide). Each box scales to fit its text, and you can **drag a
   box anywhere on the map** — a red leader line keeps it tied to the
   properties it labels. Nearby properties (within ~30 mi) share one box.
   **Click a callout box to edit the text inside** — e.g. to consolidate
   names or add a note — and Reset restores the original property names.

6. **Manually flag any property as impacted.** Click any property dot on the
   map and the popup includes a *Mark as impacted* toggle. Flipping it on
   turns the dot red and pulls it into the nearest callout cluster, even if
   the algorithm wouldn't otherwise have flagged it; flipping it off does the
   reverse. The override survives buffer-slider changes.

7. **Style the track points.** In the **Track Points** side-panel section,
   set a default icon (category icon, hurricane symbol, dot, square, or
   triangle) and color (per-category or a single uniform color). The
   hurricane symbol is a colored circular badge with a white typhoon glyph,
   matching the NHC / Google Maps storm markers. To label or restyle an
   individual point — e.g. tagging one as "Current Location" — **click it on
   the map** and use the editor popup to set its label, icon, color, or a
   free-form description. Labels show on the map and in the exported PNG;
   descriptions stay off the map and surface in the side-panel track-point
   list (expand "Track point list" to see all points and their notes).

8. **Export PNG** — downloads a snapshot of the live map with the callout
   boxes, leader lines, and track-point labels rendered onto it. The filename
   includes the storm name and advisory date, e.g.
   `AL132025_20251030_summary.png`.

9. **Export PDF** — same composited map, emitted as a single-page landscape
   PDF that drops cleanly into incident reports without an intermediate
   screenshot step. Built from the same canvas as the PNG export.

10. **Export Impacted CSV** — downloads a CSV containing only the impacted
    properties, with columns `property_id, name, address, postal_code, lat,
    lon, dist_miles, in_cone, manually_flagged`. Use it to email or hand off
    the at-risk list.

The right-hand side panel also lists the impacted properties, sortable by
distance to track, name, or in-cone status. Click a row to fly the map to
that property.

The map supports **fractional zoom** — the +/- buttons step half a zoom
level and the scroll wheel is finer still — so you can frame the full
forecast track precisely before exporting, instead of being stuck between
one zoom level that's too tight and the next that's too loose.

## Operational features

- **Session auto-save & Restore.** Every customisation (track-point
  labels/descriptions/icons/colors, callout positions and text, manual
  flags, default styles, slider and label-toggle values) is written to
  `localStorage` as you work. Refresh the page and a yellow banner offers
  **Restore last session** or **Start fresh**. The toolbar **Reset** button
  (red) clears the saved session and reloads — handy when starting a new
  storm from scratch.
- **Share view.** Click **Share view** in the toolbar to copy a URL that
  encodes all of your customisations (compressed in the URL hash). The
  recipient opens the URL, uploads the same NHC files + properties CSV
  (filenames are listed in the status bar), and the tool replays your
  configuration on top. The URL stays well under browser size limits even
  for heavily customised views.
- **Timeline scrubber.** When a storm with timestamped track points is
  loaded, a horizontal time slider appears between the toolbar and the
  map. Dragging it animates a yellow haloed scrub marker along the
  forecast track and lists the properties within the buffer of that
  position in a side-panel section — useful for "where will the storm be
  in 24 hours, and what's at risk then?" The scrubber is additive; it
  doesn't change the main Impacted Properties list.
- **Advisory comparison.** Click **Compare advisory…** to load a second
  advisory's KMZ/zip files. The older cone renders as a dashed lighter
  polygon, the older track as a dashed black line, and a side-panel
  **Comparison** section diff's the impacted sets — newly impacted,
  dropped, unchanged — plus a max/avg track-shift number in miles. The
  same buffer slider and manual flags apply to both advisories so the diff
  is apples-to-apples. Comparison state is persisted to the saved session
  and rides the **Share view** URL so reviewers can pick up the diff
  without re-loading files.
- **Toast notifications.** Failures (parse errors, export errors, share
  failures) surface as dismissible toasts in the bottom-right corner with
  the full stack tucked inside a collapsible `Details` block — no more
  silently console-logged errors. Successful exports and share copies
  raise a green confirmation toast.
- **Keyboard shortcuts.**

  | Action | Shortcut |
  |---|---|
  | Export PNG | <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>E</kbd> |
  | Share view (copy URL) | <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd> |
  | Step the timeline scrub | <kbd>←</kbd> / <kbd>→</kbd> |
  | Clear scrub or comparison | <kbd>Esc</kbd> |
  | Toggle the keyboard help overlay | <kbd>?</kbd> |

  Toolbar controls also gain visible focus rings and ARIA landmarks so the
  tool is usable with keyboard-only navigation and assistive tech.

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
- [LZ-String](https://github.com/pieroxy/lz-string) for compact share-URL encoding

PNG export composites the already-rendered map tiles, vector canvas, and
marker icons straight from the DOM — no extra library, and it can't hang.
PDF export reuses the same canvas and wraps it in a single-page landscape
document via [jsPDF](https://github.com/parallax/jsPDF) (vendored under
`vendor/jspdf.umd.min.js`). Session state and the optional share URL stay
client-side; nothing leaves the browser.

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
js/map.js         - Leaflet map setup, track-point styling, callouts, watch/warning rendering
js/export.js      - PNG + PDF + CSV export helpers
js/session.js     - Snapshot/restore to localStorage (debounced save)
js/share.js       - Encode/decode the share URL hash (via LZ-String)
js/timeline.js    - Interpolated storm position + properties-near helpers
js/compare.js     - Impacted-set diff and track-shift between two advisories
js/toast.js       - Dismissible toast notifications (errors + key successes)
js/app.js         - Wires the UI controls to the modules above
vendor/           - Self-hosted Leaflet, JSZip, PapaParse, Turf, shpjs, lz-string, jsPDF
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

## Known limitations

- Geocoding is rate-limited to 1 req/sec (Nominatim policy). If your CSV
  has many rows missing lat/lon, expect a wait. Pre-geocoding is strongly
  recommended.
- Session save is per-browser. Open the tool in a different browser or
  private window and you start fresh — use **Share view** to move a
  configured session between users/browsers.
- The saved session format bumped to `v3` for comparison persistence;
  upgrading from an older version drops the previous saved session once
  (per browser).
