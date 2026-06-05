/* global L, turf */
/*
 * User-drawn risk zones.
 *
 * Click "Draw zone here" from the map context menu to enter drawing mode;
 * left-click each polygon vertex; double-click or Enter closes the polygon.
 * Closed zones get a default name "Zone N" and persist in the array the
 * controller manages; rename / delete are popup actions on the zone itself.
 *
 * Properties inside any zone are flagged impacted regardless of cone/buffer;
 * that integration happens in app.js (recomputeAndRender) by checking each
 * property against the zone polygons returned by getZones().
 *
 * Zones are part of the session snapshot AND the share-URL embed so they
 * survive reload and travel with shared views.
 *
 * Public API (window.HurricaneDraw):
 *   init(map) -> {
 *     beginDraw(latlng), cancelDraw(), isDrawing(),
 *     getZones(), setZones(zones),
 *     setOnZonesChange(fn),
 *   }
 *
 * Zone shape: { id, name, geometry: { type: 'Polygon', coordinates } }
 */
(function () {
  'use strict';

  const ZONE_STYLE = {
    color: '#7b1fa2',
    weight: 2,
    fillColor: '#7b1fa2',
    fillOpacity: 0.18,
    dashArray: '4,3',
  };
  const DRAFT_LINE_STYLE = {
    color: '#7b1fa2',
    weight: 2,
    dashArray: '4,4',
    interactive: false,
  };
  const DRAFT_POINT_STYLE = {
    radius: 4,
    color: '#7b1fa2',
    weight: 2,
    fillColor: '#ffffff',
    fillOpacity: 1,
    interactive: false,
  };

  function init(map) {
    const layer = L.layerGroup().addTo(map);
    const draftLayer = L.layerGroup().addTo(map);
    let zones = [];                // [{id, name, geometry}]
    let zonePolygons = new Map();  // id -> L.polygon
    let draftPoints = [];          // [L.LatLng]
    let drafting = false;
    let nextId = 1;
    let onZonesChange = () => {};

    let lastBroadcast = [];
    function emitChange() {
      const snapshot = getZones();
      const prev = lastBroadcast;
      lastBroadcast = snapshot;
      try { onZonesChange(snapshot, prev); } catch (_) { /* ignore */ }
    }

    function getZones() {
      return zones.map(z => ({
        id: z.id,
        name: z.name,
        geometry: JSON.parse(JSON.stringify(z.geometry)),
      }));
    }

    function setZones(next) {
      zones = Array.isArray(next) ? next.map(z => ({
        id: z.id || ('z' + (nextId++)),
        name: z.name || 'Zone',
        geometry: z.geometry,
      })) : [];
      // Keep nextId past anything we just imported.
      zones.forEach(z => {
        const m = /^z(\d+)$/.exec(z.id);
        if (m) nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
      });
      renderZones();
      emitChange();
    }

    function renderZones() {
      layer.clearLayers();
      zonePolygons.clear();
      zones.forEach(z => {
        const coords = z.geometry && z.geometry.coordinates &&
          z.geometry.coordinates[0];
        if (!coords) return;
        const latlngs = coords.map(([lon, lat]) => [lat, lon]);
        const poly = L.polygon(latlngs, ZONE_STYLE);
        poly.bindPopup(() => buildZoneEditor(z.id));
        poly.bindTooltip(z.name, { sticky: true, className: 'zone-label' });
        poly.addTo(layer);
        zonePolygons.set(z.id, poly);
      });
    }

    function buildZoneEditor(id) {
      const z = zones.find(zz => zz.id === id);
      const wrap = document.createElement('div');
      wrap.className = 'zone-editor';
      const title = document.createElement('div');
      title.className = 'zone-editor-title';
      title.textContent = 'Risk zone';
      wrap.appendChild(title);
      const input = document.createElement('input');
      input.type = 'text';
      input.value = z ? z.name : '';
      input.placeholder = 'Zone name';
      input.className = 'zone-editor-name';
      input.addEventListener('input', () => {
        if (z) {
          z.name = input.value.trim() || 'Zone';
          const poly = zonePolygons.get(id);
          if (poly) poly.setTooltipContent(z.name);
          emitChange();
        }
      });
      wrap.appendChild(input);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn small danger';
      del.textContent = 'Delete zone';
      del.addEventListener('click', () => {
        const poly = zonePolygons.get(id);
        if (poly) map.closePopup(poly.getPopup());
        removeZone(id);
      });
      wrap.appendChild(del);
      return wrap;
    }

    function removeZone(id) {
      zones = zones.filter(z => z.id !== id);
      renderZones();
      emitChange();
    }

    function beginDraw(latlng) {
      cancelDraw();
      drafting = true;
      L.DomUtil.addClass(map.getContainer(), 'measure-cursor');
      map.doubleClickZoom.disable();
      draftPoints = [latlng];
      redrawDraft();
    }

    function addDraftPoint(latlng) {
      draftPoints.push(latlng);
      redrawDraft();
    }

    function redrawDraft() {
      draftLayer.clearLayers();
      if (draftPoints.length === 0) return;
      if (draftPoints.length >= 2) {
        L.polyline(draftPoints, DRAFT_LINE_STYLE).addTo(draftLayer);
      }
      draftPoints.forEach(p => L.circleMarker(p, DRAFT_POINT_STYLE).addTo(draftLayer));
    }

    function commitDraft() {
      if (!drafting) return;
      if (draftPoints.length < 3) {
        cancelDraw();
        return;
      }
      // Close the ring.
      const ring = draftPoints.map(p => [p.lng, p.lat]);
      ring.push(ring[0].slice());
      const id = 'z' + (nextId++);
      zones.push({
        id,
        name: 'Zone ' + (zones.length + 1),
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
      cancelDraw();
      renderZones();
      emitChange();
      // Open the rename popup straight away so the user can name it.
      const poly = zonePolygons.get(id);
      if (poly) poly.openPopup();
    }

    function cancelDraw(clearOnly) {
      drafting = false;
      L.DomUtil.removeClass(map.getContainer(), 'measure-cursor');
      map.doubleClickZoom.enable();
      draftPoints = [];
      draftLayer.clearLayers();
    }

    // Event wiring — listens on the map for left-click and double-click
    // while drafting; otherwise the map is unaffected.
    map.on('click', e => {
      if (!drafting) return;
      const t = e.originalEvent && e.originalEvent.target;
      if (t && t.closest && t.closest('.leaflet-popup, .leaflet-control')) return;
      addDraftPoint(e.latlng);
    });

    map.on('dblclick', () => {
      if (drafting) commitDraft();
    });

    return {
      beginDraw,
      cancelDraw,
      isDrawing: () => drafting,
      commitDraft,
      getZones,
      setZones,
      hasZones: () => zones.length > 0,
      setOnZonesChange: fn => { onZonesChange = typeof fn === 'function' ? fn : () => {}; },
    };
  }

  window.HurricaneDraw = { init };
})();
