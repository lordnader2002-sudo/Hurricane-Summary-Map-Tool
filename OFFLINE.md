# Offline & Desktop Use

The Hurricane Map Tool runs **fully offline**. Everything — parsing NHC
files, impact analysis, callouts, exports, sessions, share links — happens
in the browser with no server. The two features that normally use the
internet degrade gracefully without it:

| Feature | Online | Offline |
|---|---|---|
| Basemap | OpenStreetMap street tiles | Bundled Natural Earth vector map (coastlines, borders, states, lakes, major cities) |
| Geocoding (CSV rows without lat/lon) | OpenStreetMap Nominatim (address-level) | Bundled US ZIP-code centroid table (neighborhood-level) |

Everything else behaves identically offline.

## Getting the offline builds

Both distributables are built automatically by GitHub Actions
(`.github/workflows/offline-build.yml`):

1. **Tag a release**: `git tag offline-v1.0.0 && git push origin offline-v1.0.0`
   — the workflow attaches both files to a GitHub Release.
2. **Or run manually**: repository → Actions → "Build offline
   distributables" → Run workflow — grab the files from the run's
   Artifacts.

The two files:

- **`HurricaneMapTool-<version>.exe`** — Windows, portable. No install:
  copy it anywhere (USB stick, network share, Desktop) and double-click.
  Built with Electron from `desktop/`.
- **`HurricaneMapTool-portable.zip`** — any OS. Unzip, then double-click
  `launcher/Start Hurricane Map Tool.bat` (Windows) or
  `launcher/start-hurricane-map-tool.command` (macOS/Linux). It opens
  `index.html` in your default browser straight from disk — no install,
  no server, no admin rights.

> **Handoff note:** if nobody is around to run builds, the portable zip
> is literally just this repository's files — zipping up a checkout of
> `main` (minus `.git`, `scripts`, `desktop`) produces the same thing.

## Working offline — analyst workflow

1. **Get the advisory files** from any internet-connected machine:
   NHC GIS page (https://www.nhc.noaa.gov/gis/) → download the CONE /
   TRACK / WW KMZs (or the 5-day shapefile zip) for the active storm.
   Transfer them however you normally move files.
2. Open the tool (exe or launcher) and upload as usual.
3. **Properties CSV**: include `lat`/`lon` columns if at all possible —
   that's exact and instant. Rows with only an address:
   - Online: geocoded via Nominatim as usual.
   - Offline: placed at their **ZIP-code centroid** (approximate —
     right neighborhood, not the rooftop; fine for a 100-mile buffer,
     misleading for street-level judgments).
4. Exports (PNG / PDF / CSV), sessions, bookmarks, measuring, zones —
   all identical offline. Share links work too: the URL embeds all data,
   so it can be pasted into email/chat and opened by another analyst
   later, online or off.

## What the offline basemap is

Natural Earth 1:50m public-domain data (countries, state lines, large
lakes, ~1,250 major cities), compiled into `offline/*.js` bundles
(~3.4 MB). It renders under the OSM tiles — when tiles load they cover
it; when the tile server is unreachable the tool removes the tile layer
and the vector map shows through, with a toast telling you it happened.

To regenerate the bundles (e.g. to update Natural Earth data):

```sh
# download the four ne_50m_*.geojson files and GeoNames US.txt
# (URLs in the script header), then:
node scripts/build-offline-data.js <dir-with-geojson> <path-to-US.txt>
```

## Desktop shell (`desktop/`)

A ~60-line Electron wrapper: one window, no menu, no auto-update, no
IPC. It loads the same `index.html` everyone else uses. Local dev:

```sh
cd desktop && npm install && npm start          # run it
npx electron-builder --win portable              # build the exe (on Windows)
```

The exe embeds a copy of the web app (`extraResources` in
`desktop/package.json`), so it does **not** pick up later changes to the
repo — rebuild to update it.

## Known offline limitations

- Address-level geocoding needs the internet; ZIP centroids are the
  offline fallback (US only).
- The vector basemap has no streets — city dots and labels only. For
  briefings that need street context, export while online.
- Session auto-save uses the browser's localStorage. In the portable-zip
  flow that's tied to the machine *and* the folder path (file:// origin);
  move the folder and the saved session won't follow. Share links and
  bookmarks-in-share-links are the reliable way to move work around.
