/* global L, turf */
/*
 * Leaflet map rendering for the hurricane summary tool.
 *
 * Public API (window.HurricaneMap):
 *   init(containerId)            -> map controller
 *   ctrl.setStorm(storm)         -> draw cone + ww + track + track-point markers
 *   ctrl.setProperties(props)    -> draw property markers and impacted callouts
 *   ctrl.fit()                   -> fit bounds to current data
 *   ctrl.flyTo(lat, lon)
 *   ctrl.setLabelsVisible(bool)
 *   ctrl.setTrackDefaults({shape, color, colorByCategory})
 *   ctrl.getTrackDefaults()
 *   ctrl.getMap()                -> raw L.Map instance
 *   ctrl.getCurrent()            -> { storm, properties }
 *   ctrl.getOverlayLabels()      -> { callouts, trackLabels }  (for PNG export)
 *
 * Also exposes HurricaneMap.measureCalloutBox / CALLOUT_* for the exporter.
 */
(function () {
  'use strict';

  // --- Callout box geometry (kept in sync with .property-callout in style.css)
  const CALLOUT_FONT =
    '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const CALLOUT_PAD_X = 7;
  const CALLOUT_PAD_Y = 4;
  const CALLOUT_LINE_H = 14;
  const CALLOUT_BORDER = 2;

  // Impacted properties within this many miles of each other share one callout.
  const CALLOUT_CLUSTER_MILES = 30;

  const CONE_STYLE = {
    fillColor: '#5b9bd5', fillOpacity: 0.35,
    color: '#1f4e79', weight: 2, opacity: 0.85,
  };
  const TRACK_STYLE = { color: '#000', weight: 3, opacity: 0.85 };
  const LEADER_STYLE = { color: '#c00000', weight: 2, opacity: 0.95 };

  const TRACK_SHAPES = ['category', 'hurricane', 'dot', 'square', 'triangle'];
  const TRACK_SHAPE_LABEL = {
    category: 'Category icon', hurricane: 'Hurricane symbol',
    dot: 'Dot', square: 'Square', triangle: 'Triangle',
  };

  // Offscreen canvas for measuring callout text width
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');

  function measureCalloutBox(lines) {
    measureCtx.font = CALLOUT_FONT;
    let contentW = 0;
    lines.forEach(t => {
      contentW = Math.max(contentW, measureCtx.measureText(t).width);
    });
    return {
      width: Math.ceil(contentW) + CALLOUT_PAD_X * 2 + CALLOUT_BORDER * 2,
      height: lines.length * CALLOUT_LINE_H + CALLOUT_PAD_Y * 2 + CALLOUT_BORDER * 2,
    };
  }

  // --- SVG icon generation -------------------------------------------------

  function svgIcon(shape, color, size) {
    const s = size || 24;
    const stroke = '#ffffff';
    let inner;
    if (shape === 'square') {
      inner = `<rect x="3" y="3" width="18" height="18" rx="2"
        fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`;
    } else if (shape === 'triangle') {
      inner = `<path d="M12 2 L22 21 L2 21 Z"
        fill="${color}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`;
    } else if (shape === 'hurricane') {
      // Colored disc + a white tropical-cyclone glyph: two point-symmetric
      // comma arms curling around an open eye — the swirl used on NHC /
      // Google Maps storm markers.
      const arm = '<path d="M11.3 5.6 A 4.0 4.0 0 1 1 13.1 14.6"/>';
      inner =
        `<circle cx="12" cy="12" r="11.25" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>` +
        `<g fill="none" stroke="${stroke}" stroke-width="3.2" stroke-linecap="round">` +
          `<g>${arm}</g>` +
          `<g transform="rotate(180 12 12)">${arm}</g>` +
        `</g>`;
    } else {
      // dot
      inner = `<circle cx="12" cy="12" r="9" fill="${color}" stroke="${stroke}" stroke-width="1.5"/>`;
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${s}" height="${s}">${inner}</svg>`;
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  function categoryColor(cat) {
    return ({
      cat5: '#7b1fa2', cat4: '#c2185b', cat3: '#d32f2f',
      cat2: '#f57c00', cat1: '#fbc02d', ts: '#388e3c', td: '#0288d1', ex: '#616161',
    })[cat] || '#616161';
  }

  // --- Map controller ------------------------------------------------------

  function init(containerId) {
    const map = L.map(containerId, {
      preferCanvas: true,
      worldCopyJump: true,
    }).setView([30, -75], 4);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors',
      crossOrigin: true,
    }).addTo(map);

    const layers = {
      cone: L.layerGroup().addTo(map),
      ww: L.layerGroup().addTo(map),
      track: L.layerGroup().addTo(map),
      trackPoints: L.layerGroup().addTo(map),
      properties: L.layerGroup().addTo(map),
      callouts: L.layerGroup().addTo(map),
    };

    L.control.layers(null, {
      'Forecast cone / wind radii': layers.cone,
      'Watches & warnings': layers.ww,
      'Storm track': layers.track,
      'Track points': layers.trackPoints,
      'Properties': layers.properties,
      'Impacted callouts': layers.callouts,
    }, { collapsed: true, position: 'topright' }).addTo(map);

    let currentStorm = null;
    let currentProperties = [];
    let labelsVisible = true;

    // Per-point style overrides, keyed by track point `order` (stable index)
    const trackPointStyles = {};
    // Default style applied to points without an override
    let trackDefaults = { shape: 'category', color: '#1f4e79', colorByCategory: true };
    // order -> L.marker, so the click-editor can update a point in place
    const trackMarkers = {};

    // Callout drag positions, keyed by stable cluster id (sorted property ids).
    // Survives buffer-slider re-renders so manual placement isn't lost.
    const calloutPositions = {};
    // Live callout descriptors, for the PNG exporter
    let calloutData = [];

    // ---- Storm layers ----------------------------------------------------

    function setStorm(storm) {
      currentStorm = storm;
      layers.cone.clearLayers();
      layers.ww.clearLayers();
      layers.track.clearLayers();
      layers.trackPoints.clearLayers();
      Object.keys(trackMarkers).forEach(k => delete trackMarkers[k]);

      if (!storm) return;

      if (storm.cone) {
        L.geoJSON(storm.cone, { style: () => CONE_STYLE }).addTo(layers.cone);
      }
      if (storm.ww && storm.ww.length) {
        storm.ww.forEach(seg => {
          L.geoJSON(seg.geometry, {
            style: () => ({ color: seg.color, weight: 5, opacity: 0.9, lineCap: 'butt' }),
          }).bindTooltip(seg.label, { sticky: true }).addTo(layers.ww);
        });
      }
      if (storm.trackLine) {
        L.geoJSON(storm.trackLine, { style: () => TRACK_STYLE }).addTo(layers.track);
      }
      renderTrackPoints();
    }

    function resolveTrackStyle(feature) {
      const order = feature.properties.order;
      const cat = feature.properties.category;
      const override = trackPointStyles[order] || {};
      const shape = override.shape || trackDefaults.shape;
      let color = override.color;
      if (!color) {
        color = trackDefaults.colorByCategory ? categoryColor(cat) : trackDefaults.color;
      }
      const label = override.label != null ? override.label : '';
      return { shape, color, label, order, cat };
    }

    function makeTrackIcon(style) {
      // 'category' shape uses the KMZ-embedded icon when available
      if (style.shape === 'category' && currentStorm
          && currentStorm.iconMap && currentStorm.iconMap[style.cat]) {
        return L.icon({
          iconUrl: currentStorm.iconMap[style.cat],
          iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -11],
        });
      }
      const shape = style.shape === 'category' ? 'dot' : style.shape;
      return L.icon({
        iconUrl: svgIcon(shape, style.color, 24),
        iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12],
      });
    }

    function renderTrackPoints() {
      layers.trackPoints.clearLayers();
      Object.keys(trackMarkers).forEach(k => delete trackMarkers[k]);
      if (!currentStorm || !currentStorm.trackPoints) return;

      currentStorm.trackPoints.features.forEach(f => {
        const [lon, lat] = f.geometry.coordinates;
        const style = resolveTrackStyle(f);
        const marker = L.marker([lat, lon], { icon: makeTrackIcon(style) });
        if (style.label) {
          marker.bindTooltip(style.label, {
            permanent: true, direction: 'top', offset: [0, -10],
            className: 'track-label',
          });
        }
        marker.bindPopup(() => buildTrackEditor(f));
        marker.addTo(layers.trackPoints);
        trackMarkers[style.order] = marker;
      });
    }

    // Re-style a single track point in place (keeps an open popup open)
    function applyTrackStyle(feature) {
      const marker = trackMarkers[feature.properties.order];
      if (!marker) return;
      const style = resolveTrackStyle(feature);
      marker.setIcon(makeTrackIcon(style));
      if (style.label) {
        if (marker.getTooltip()) marker.setTooltipContent(style.label);
        else marker.bindTooltip(style.label, {
          permanent: true, direction: 'top', offset: [0, -10], className: 'track-label',
        });
      } else if (marker.getTooltip()) {
        marker.unbindTooltip();
      }
    }

    function buildTrackEditor(feature) {
      const order = feature.properties.order;
      const current = trackPointStyles[order] || {};
      const style = resolveTrackStyle(feature);

      const wrap = document.createElement('div');
      wrap.className = 'track-editor';

      const title = document.createElement('div');
      title.className = 'track-editor-title';
      title.textContent = feature.properties.name || 'Track point';
      wrap.appendChild(title);

      const sub = document.createElement('div');
      sub.className = 'track-editor-sub';
      sub.textContent = feature.properties.categoryLabel || '';
      wrap.appendChild(sub);

      // Label
      wrap.appendChild(fieldRow('Label', (() => {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = 'e.g. Current Location';
        inp.value = current.label || '';
        inp.addEventListener('input', () => {
          trackPointStyles[order] = Object.assign({}, trackPointStyles[order], {
            label: inp.value,
          });
          applyTrackStyle(feature);
        });
        return inp;
      })()));

      // Shape
      wrap.appendChild(fieldRow('Icon', (() => {
        const sel = document.createElement('select');
        sel.appendChild(opt('', 'Use default (' + TRACK_SHAPE_LABEL[trackDefaults.shape] + ')'));
        TRACK_SHAPES.forEach(s => sel.appendChild(opt(s, TRACK_SHAPE_LABEL[s])));
        sel.value = current.shape || '';
        sel.addEventListener('change', () => {
          trackPointStyles[order] = Object.assign({}, trackPointStyles[order], {
            shape: sel.value || undefined,
          });
          applyTrackStyle(feature);
        });
        return sel;
      })()));

      // Color
      wrap.appendChild(fieldRow('Color', (() => {
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = current.color || style.color || '#1f4e79';
        inp.addEventListener('input', () => {
          trackPointStyles[order] = Object.assign({}, trackPointStyles[order], {
            color: inp.value,
          });
          applyTrackStyle(feature);
        });
        return inp;
      })()));

      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'track-editor-reset';
      reset.textContent = 'Reset to default';
      reset.addEventListener('click', () => {
        delete trackPointStyles[order];
        applyTrackStyle(feature);
        map.closePopup();
      });
      wrap.appendChild(reset);

      return wrap;
    }

    function fieldRow(labelText, control) {
      const row = document.createElement('label');
      row.className = 'track-editor-row';
      const span = document.createElement('span');
      span.textContent = labelText;
      row.appendChild(span);
      row.appendChild(control);
      return row;
    }

    function opt(value, text) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      return o;
    }

    function setTrackDefaults(defaults) {
      trackDefaults = Object.assign({}, trackDefaults, defaults);
      renderTrackPoints();
    }

    function getTrackDefaults() {
      return Object.assign({}, trackDefaults);
    }

    // ---- Property markers + callouts -------------------------------------

    function setProperties(properties) {
      currentProperties = properties || [];
      layers.properties.clearLayers();

      currentProperties.forEach(p => {
        const m = p.impacted
          ? L.circleMarker([p.lat, p.lon], {
              radius: 6, color: '#600', weight: 2,
              fillColor: '#c00000', fillOpacity: 0.9,
            })
          : L.circleMarker([p.lat, p.lon], {
              radius: 3.5, color: '#3d4147', weight: 1,
              fillColor: '#6c757d', fillOpacity: 0.65,
            });
        m.bindTooltip(
          `<strong>${escapeHtml(p.name)}</strong><br>` +
          `${escapeHtml(p.address || '')}` +
          (p.distMiles != null ? `<br>${p.distMiles.toFixed(1)} mi from track` : '') +
          (p.inCone ? '<br><em>In cone</em>' : ''),
          { direction: 'top' }
        );
        m.propertyData = p;
        m.addTo(layers.properties);
      });

      renderCallouts();
    }

    // Cluster impacted properties geographically (once), then place a
    // draggable callout box for each cluster with a red leader line back to
    // the cluster's location.
    function renderCallouts() {
      layers.callouts.clearLayers();
      calloutData = [];
      if (!labelsVisible) return;

      const impacted = currentProperties.filter(p => p.impacted);
      if (impacted.length === 0) return;

      const clusters = clusterByMiles(impacted, CALLOUT_CLUSTER_MILES);

      clusters.forEach(cluster => {
        const id = cluster.map(p => p.id).slice().sort().join('|');
        const lines = cluster.map(p => p.name);
        const target = clusterCenter(cluster);
        const box = measureCalloutBox(lines);

        // Use the user's dragged position if there is one; otherwise place the
        // box up-and-right of the cluster, offset by pixels at the current
        // zoom so it doesn't sit on top of the property dots. Only dragged
        // positions are persisted, so defaults always track the current zoom.
        let position = calloutPositions[id];
        if (!position) {
          const tp = map.latLngToLayerPoint([target.lat, target.lon]);
          const offsetPt = L.point(
            tp.x + box.width / 2 + 18,
            tp.y - box.height / 2 - 26
          );
          const ll = map.layerPointToLatLng(offsetPt);
          position = { lat: ll.lat, lng: ll.lng };
        }

        const targetLL = [target.lat, target.lon];
        const boxLL = [position.lat, position.lng];

        const leader = L.polyline([boxLL, targetLL], LEADER_STYLE).addTo(layers.callouts);

        const html = '<div class="property-callout">' +
          lines.map(n => `<span class="callout-line">${escapeHtml(n)}</span>`).join('') +
          '</div>';
        const icon = L.divIcon({
          className: 'callout-wrapper',
          html,
          iconSize: [box.width, box.height],
          iconAnchor: [box.width / 2, box.height / 2],
        });
        const marker = L.marker(boxLL, {
          icon,
          draggable: true,
          autoPan: false,
          zIndexOffset: 1000,
        }).addTo(layers.callouts);

        const descriptor = { id, lines, target, position };
        calloutData.push(descriptor);

        marker.on('drag', () => {
          const ll = marker.getLatLng();
          leader.setLatLngs([ll, targetLL]);
          descriptor.position = { lat: ll.lat, lng: ll.lng };
          calloutPositions[id] = descriptor.position;
        });
      });
    }

    function clusterByMiles(items, thresholdMiles) {
      const clusters = [];
      const used = new Set();
      for (let i = 0; i < items.length; i += 1) {
        if (used.has(i)) continue;
        const group = [items[i]];
        used.add(i);
        for (let j = i + 1; j < items.length; j += 1) {
          if (used.has(j)) continue;
          const d = turf.distance(
            turf.point([items[i].lon, items[i].lat]),
            turf.point([items[j].lon, items[j].lat]),
            { units: 'miles' }
          );
          if (d <= thresholdMiles) {
            group.push(items[j]);
            used.add(j);
          }
        }
        clusters.push(group);
      }
      return clusters;
    }

    function clusterCenter(cluster) {
      const lat = cluster.reduce((s, p) => s + p.lat, 0) / cluster.length;
      const lon = cluster.reduce((s, p) => s + p.lon, 0) / cluster.length;
      return { lat, lon };
    }

    // ---- View helpers ----------------------------------------------------

    function fit() {
      const bounds = L.latLngBounds([]);
      let any = false;
      if (currentStorm) {
        if (currentStorm.cone) extendBoundsFromGeoJSON(bounds, currentStorm.cone);
        if (currentStorm.trackLine) extendBoundsFromGeoJSON(bounds, currentStorm.trackLine);
        if (currentStorm.trackPoints) extendBoundsFromGeoJSON(bounds, currentStorm.trackPoints);
        if (currentStorm.ww) {
          currentStorm.ww.forEach(seg => extendBoundsFromGeoJSON(bounds, seg.geometry));
        }
        any = currentStorm.cone || currentStorm.trackLine
          || (currentStorm.trackPoints && currentStorm.trackPoints.features.length)
          || (currentStorm.ww && currentStorm.ww.length);
      }
      currentProperties.filter(p => p.impacted).forEach(p => {
        bounds.extend([p.lat, p.lon]);
        any = true;
      });
      if (any && bounds.isValid()) {
        // animate:false so the view updates synchronously and the callout
        // default positions below are computed at the final zoom level.
        map.fitBounds(bounds, { padding: [40, 40], animate: false });
      }
      // Recompute callout default positions for the new zoom (dragged
      // positions are keyed by cluster id and survive this).
      renderCallouts();
    }

    function flyTo(lat, lon) {
      map.flyTo([lat, lon], Math.max(map.getZoom(), 8), { duration: 0.6 });
    }

    function setLabelsVisible(v) {
      labelsVisible = !!v;
      renderCallouts();
    }

    function getOverlayLabels() {
      const trackLabels = [];
      if (currentStorm && currentStorm.trackPoints) {
        currentStorm.trackPoints.features.forEach(f => {
          const style = resolveTrackStyle(f);
          if (style.label) {
            const [lon, lat] = f.geometry.coordinates;
            trackLabels.push({ text: style.label, lat, lon });
          }
        });
      }
      return {
        callouts: calloutData.map(c => ({
          lines: c.lines.slice(),
          position: { lat: c.position.lat, lng: c.position.lng },
        })),
        trackLabels,
      };
    }

    return {
      setStorm, setProperties, fit, flyTo, setLabelsVisible,
      setTrackDefaults, getTrackDefaults,
      getMap: () => map,
      getLayers: () => layers,
      getCurrent: () => ({ storm: currentStorm, properties: currentProperties }),
      getOverlayLabels,
    };
  }

  // --- Shared geometry helpers --------------------------------------------

  function extendBoundsFromGeoJSON(bounds, gj) {
    if (!gj) return;
    const features = gj.type === 'FeatureCollection' ? gj.features
      : gj.type === 'Feature' ? [gj]
        : [{ geometry: gj }];
    features.forEach(f => {
      const g = f.geometry;
      if (!g) return;
      eachCoord(g.coordinates, g.type, ([lon, lat]) => bounds.extend([lat, lon]));
    });
  }

  function eachCoord(coords, type, fn) {
    if (type === 'Point') return fn(coords);
    if (type === 'LineString' || type === 'MultiPoint') return coords.forEach(fn);
    if (type === 'Polygon' || type === 'MultiLineString') {
      return coords.forEach(ring => ring.forEach(fn));
    }
    if (type === 'MultiPolygon') {
      return coords.forEach(poly => poly.forEach(ring => ring.forEach(fn)));
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.HurricaneMap = {
    init,
    measureCalloutBox,
    CALLOUT_FONT,
    CALLOUT_PAD_X,
    CALLOUT_PAD_Y,
    CALLOUT_LINE_H,
    CALLOUT_BORDER,
    TRACK_SHAPES,
    TRACK_SHAPE_LABEL,
  };
})();
