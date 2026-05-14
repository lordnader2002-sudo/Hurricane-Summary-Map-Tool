/* global L */
/*
 * Leaflet map rendering for the hurricane summary tool.
 *
 * Public API (window.HurricaneMap):
 *   init(containerId)       -> map controller
 *   ctrl.setStorm(storm)    -> draw cone + track + track-point markers
 *   ctrl.setProperties(props, opts) -> draw property markers and impacted callouts
 *   ctrl.fit()              -> fit bounds to current data
 *   ctrl.flyTo(lat, lon)
 *   ctrl.setLabelsVisible(bool)
 *   ctrl.getMap()           -> raw L.Map instance
 */
(function () {
  'use strict';

  // Cluster impacted properties whose pixel positions are within this distance
  // (at the current zoom) into a single multi-line callout, mimicking how the
  // reference slide stacks property names per region.
  const CALLOUT_CLUSTER_PX = 36;

  const CONE_STYLE = {
    fillColor: '#5b9bd5', fillOpacity: 0.35,
    color: '#1f4e79', weight: 2, opacity: 0.85,
  };
  const TRACK_STYLE = { color: '#000', weight: 3, opacity: 0.85 };

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

    // Layer groups so we can clear/redraw cleanly
    const layers = {
      cone: L.layerGroup().addTo(map),
      track: L.layerGroup().addTo(map),
      trackPoints: L.layerGroup().addTo(map),
      properties: L.layerGroup().addTo(map),
      callouts: L.layerGroup().addTo(map),
    };

    L.control.layers(null, {
      'Forecast cone / wind radii': layers.cone,
      'Storm track': layers.track,
      'Track points': layers.trackPoints,
      'Properties': layers.properties,
      'Impacted callouts': layers.callouts,
    }, { collapsed: true, position: 'topright' }).addTo(map);

    let currentStorm = null;
    let currentProperties = [];
    let labelsVisible = true;

    function setStorm(storm) {
      currentStorm = storm;
      layers.cone.clearLayers();
      layers.track.clearLayers();
      layers.trackPoints.clearLayers();

      if (!storm) return;

      if (storm.cone) {
        L.geoJSON(storm.cone, { style: () => CONE_STYLE }).addTo(layers.cone);
      }
      if (storm.trackLine) {
        L.geoJSON(storm.trackLine, { style: () => TRACK_STYLE }).addTo(layers.track);
      }
      if (storm.trackPoints && storm.trackPoints.features) {
        storm.trackPoints.features.forEach(f => {
          const [lon, lat] = f.geometry.coordinates;
          const cat = f.properties.category;
          const iconUrl = storm.iconMap && storm.iconMap[cat];
          let marker;
          if (iconUrl) {
            marker = L.marker([lat, lon], {
              icon: L.icon({
                iconUrl,
                iconSize: [22, 22],
                iconAnchor: [11, 11],
              }),
            });
          } else {
            marker = L.circleMarker([lat, lon], {
              radius: 5, color: '#000', weight: 1, fillColor: categoryColor(cat),
              fillOpacity: 0.9,
            });
          }
          marker.bindPopup(
            `<strong>${escapeHtml(f.properties.name || '')}</strong><br>` +
            `${escapeHtml(f.properties.categoryLabel || '')}`
          );
          marker.addTo(layers.trackPoints);
        });
      }
    }

    function setProperties(properties, opts) {
      opts = opts || {};
      currentProperties = properties || [];
      layers.properties.clearLayers();
      layers.callouts.clearLayers();

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

      if (labelsVisible) renderCallouts();
    }

    function renderCallouts() {
      layers.callouts.clearLayers();
      const impacted = currentProperties.filter(p => p.impacted);
      if (impacted.length === 0) return;

      // Cluster impacted properties by pixel proximity at the current zoom.
      const clusters = clusterByPixel(map, impacted, CALLOUT_CLUSTER_PX);
      clusters.forEach(cluster => {
        const center = clusterCenter(cluster);
        const html = '<div class="property-callout">' +
          cluster.map(p => `<span class="callout-line">${escapeHtml(p.name)}</span>`).join('') +
          '</div>';
        const icon = L.divIcon({
          className: 'callout-wrapper',
          html,
          iconAnchor: [0, 0],
        });
        L.marker([center.lat, center.lon], { icon, interactive: false })
          .addTo(layers.callouts);
      });
    }

    function clusterByPixel(map, items, threshold) {
      const projected = items.map(p => ({
        item: p,
        pt: map.latLngToLayerPoint([p.lat, p.lon]),
      }));
      const clusters = [];
      const used = new Set();
      for (let i = 0; i < projected.length; i += 1) {
        if (used.has(i)) continue;
        const group = [projected[i].item];
        used.add(i);
        for (let j = i + 1; j < projected.length; j += 1) {
          if (used.has(j)) continue;
          if (projected[i].pt.distanceTo(projected[j].pt) <= threshold) {
            group.push(projected[j].item);
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

    function fit() {
      const bounds = L.latLngBounds([]);
      let any = false;
      if (currentStorm) {
        if (currentStorm.cone) extendBoundsFromGeoJSON(bounds, currentStorm.cone);
        if (currentStorm.trackLine) extendBoundsFromGeoJSON(bounds, currentStorm.trackLine);
        if (currentStorm.trackPoints) extendBoundsFromGeoJSON(bounds, currentStorm.trackPoints);
        any = currentStorm.cone || currentStorm.trackLine
          || (currentStorm.trackPoints && currentStorm.trackPoints.features.length);
      }
      // Only include impacted properties in the bounds; otherwise CONUS-wide
      // datasets would zoom the map out to a useless extent.
      currentProperties.filter(p => p.impacted).forEach(p => {
        bounds.extend([p.lat, p.lon]);
        any = true;
      });
      if (any && bounds.isValid()) {
        map.fitBounds(bounds, { padding: [40, 40] });
      }
    }

    function flyTo(lat, lon) {
      map.flyTo([lat, lon], Math.max(map.getZoom(), 8), { duration: 0.6 });
    }

    function setLabelsVisible(v) {
      labelsVisible = !!v;
      if (labelsVisible) renderCallouts();
      else layers.callouts.clearLayers();
    }

    map.on('zoomend moveend', () => {
      if (labelsVisible) renderCallouts();
    });

    return {
      setStorm, setProperties, fit, flyTo, setLabelsVisible,
      getMap: () => map,
      getLayers: () => layers,
      getCurrent: () => ({ storm: currentStorm, properties: currentProperties }),
    };
  }

  function categoryColor(cat) {
    return ({
      cat5: '#7b1fa2', cat4: '#c2185b', cat3: '#d32f2f',
      cat2: '#f57c00', cat1: '#fbc02d', ts: '#388e3c', td: '#0288d1', ex: '#616161',
    })[cat] || '#616161';
  }

  function extendBoundsFromGeoJSON(bounds, gj) {
    const features = gj.type === 'FeatureCollection' ? gj.features : [gj];
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

  window.HurricaneMap = { init };
})();
