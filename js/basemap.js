/* global L */
/*
 * Offline vector basemap rendered from bundled Natural Earth data.
 *
 * Drawn into a custom "basemap" pane that sits BELOW the tile pane, so when
 * OpenStreetMap tiles load they simply cover it; offline (or when the tile
 * server is unreachable) the vector basemap shows through — coastlines,
 * country/state borders, large lakes, and major-city labels. Enough context
 * to brief from, with zero network dependency.
 *
 * Data is loaded via <script> tags (offline/basemap-*.js) rather than
 * fetch() so the tool also works when opened directly from disk (file://),
 * where browsers block XHR to local files.
 *
 * Public API (window.HurricaneBasemap):
 *   init(map) -> { getVisibleCityLabels }   // labels for the PNG/PDF export
 */
(function () {
  'use strict';

  const LAND_STYLE = {
    fillColor: '#f4f1ea',
    fillOpacity: 1,
    color: '#9aa7b1',        // coastline / country border
    weight: 0.8,
    opacity: 0.9,
  };
  const STATE_STYLE = { color: '#b7c0c8', weight: 0.7, opacity: 0.8, dashArray: '3 2' };
  const LAKE_STYLE = {
    fillColor: '#dfe6ec',    // matches the map/ocean background
    fillOpacity: 1,
    color: '#9aa7b1',
    weight: 0.5,
    opacity: 0.8,
  };
  const CITY_DOT_STYLE = {
    radius: 2.5,
    color: '#5c6873',
    weight: 1,
    fillColor: '#ffffff',
    fillOpacity: 1,
    interactive: false,
  };
  const MAX_VISIBLE_CITIES = 80;

  // City importance rank (Natural Earth scalerank, lower = more major)
  // allowed at each zoom level.
  function maxRankForZoom(z) {
    if (z < 3) return 0;
    if (z < 4) return 2;
    if (z < 5) return 4;
    if (z < 6) return 6;
    return 8;
  }

  function init(map) {
    const data = window.OFFLINE_BASEMAP;
    if (!data || !data.countries) {
      // Bundles not present (e.g. a trimmed deployment) — expose a no-op.
      return { getVisibleCityLabels: () => [] };
    }

    // Below tilePane (z-index 200), above the map background.
    map.createPane('basemap');
    map.getPane('basemap').style.zIndex = 150;
    const renderer = L.canvas({ pane: 'basemap' });

    L.geoJSON(data.countries, {
      pane: 'basemap', renderer, style: () => LAND_STYLE, interactive: false,
    }).addTo(map);
    if (data.states) {
      L.geoJSON(data.states, {
        pane: 'basemap', renderer, style: () => STATE_STYLE, interactive: false,
      }).addTo(map);
    }
    if (data.lakes) {
      L.geoJSON(data.lakes, {
        pane: 'basemap', renderer, style: () => LAKE_STYLE, interactive: false,
      }).addTo(map);
    }

    // City dots go through the same canvas renderer (so the exporter captures
    // them with the pane canvas); the text labels are divIcons, which the
    // exporter draws separately via getVisibleCityLabels().
    const cityLayer = L.layerGroup().addTo(map);
    let visibleCities = [];

    function renderCities() {
      cityLayer.clearLayers();
      visibleCities = [];
      if (!Array.isArray(data.cities)) return;
      const z = map.getZoom();
      const maxRank = maxRankForZoom(z);
      const bounds = map.getBounds().pad(0.1);
      const picked = [];
      for (const c of data.cities) {
        if (c.r > maxRank) continue;
        const ll = L.latLng(c.c[1], c.c[0]);
        if (!bounds.contains(ll)) continue;
        picked.push({ city: c, ll });
        if (picked.length >= MAX_VISIBLE_CITIES) break;
      }
      picked.forEach(({ city, ll }) => {
        L.circleMarker(ll, Object.assign({ pane: 'basemap', renderer }, CITY_DOT_STYLE))
          .addTo(cityLayer);
        const label = L.marker(ll, {
          pane: 'basemap',
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'basemap-city-label',
            html: `<span>${escapeHtml(city.n)}</span>`,
            iconSize: [0, 0],
            iconAnchor: [-5, 6],
          }),
        });
        label.addTo(cityLayer);
        visibleCities.push({ name: city.n, lat: ll.lat, lon: ll.lng });
      });
    }

    let cityTimer = null;
    function scheduleRenderCities() {
      if (cityTimer) clearTimeout(cityTimer);
      cityTimer = setTimeout(renderCities, 120);
    }
    map.on('zoomend moveend', scheduleRenderCities);
    renderCities();

    return {
      getVisibleCityLabels: () => visibleCities.slice(),
    };
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.HurricaneBasemap = { init };
})();
