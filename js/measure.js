/* global L, turf */
/*
 * Right-click distance measuring tool.
 *
 * Flow:
 *   1. Right-click the map -> small popup with "Measure from here"
 *   2. Left-click each waypoint; cumulative miles show in a tooltip
 *      on every point
 *   3. Double-click or Esc to finish; the line stays on the map
 *   4. Right-click again -> "Clear measurement" / "New measurement from here"
 *
 * Math via turf.distance({units:'miles'}) so it matches the buffer-slider
 * unit the rest of the tool uses. The measurement is transient — it is
 * not persisted to the session snapshot or the share URL.
 *
 * Public API (window.HurricaneMeasure):
 *   init(map) -> { clear, finish, isActive, hasMeasurement }
 */
(function () {
  'use strict';

  const LINE_STYLE = {
    color: '#ed7d31',
    weight: 3,
    opacity: 0.95,
    dashArray: '6,5',
    interactive: false,
  };
  const WAYPOINT_STYLE = {
    radius: 5,
    color: '#ed7d31',
    weight: 2,
    fillColor: '#ffffff',
    fillOpacity: 1,
    interactive: false,
  };

  function formatMiles(n) {
    if (n < 10) return n.toFixed(2) + ' mi';
    if (n < 100) return n.toFixed(1) + ' mi';
    return Math.round(n).toLocaleString() + ' mi';
  }

  function segmentMiles(a, b) {
    return turf.distance(
      turf.point([a.lng, a.lat]),
      turf.point([b.lng, b.lat]),
      { units: 'miles' }
    );
  }

  // 16-point compass — turf.bearing returns -180..180 from true north.
  const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                   'S','SSW','SW','WSW','W','WNW','NW','NNW'];
  function bearingLabel(a, b) {
    const deg = turf.bearing(
      turf.point([a.lng, a.lat]),
      turf.point([b.lng, b.lat])
    );
    const normalized = (deg + 360) % 360;
    return COMPASS[Math.round(normalized / 22.5) % 16];
  }

  const SNAP_PIXELS = 15;

  function init(map) {
    const layer = L.layerGroup().addTo(map);
    let polyline = null;
    let markers = [];
    let points = [];     // L.LatLng[]
    let active = false;
    let openPopup = null;
    let snapTargets = [];  // [{ lat, lon, id, name }]

    function setSnapTargets(props) {
      snapTargets = Array.isArray(props) ? props.filter(p =>
        typeof p.lat === 'number' && typeof p.lon === 'number'
      ) : [];
    }

    function snapClick(latlng) {
      if (snapTargets.length === 0) return { latlng, snapped: null };
      const clickPx = map.latLngToContainerPoint(latlng);
      let best = null;
      let bestDist = SNAP_PIXELS;
      snapTargets.forEach(t => {
        const px = map.latLngToContainerPoint([t.lat, t.lon]);
        const d = clickPx.distanceTo(px);
        if (d < bestDist) { bestDist = d; best = t; }
      });
      if (!best) return { latlng, snapped: null };
      return { latlng: L.latLng(best.lat, best.lon), snapped: best };
    }

    function flashSnap(latlng) {
      const ring = L.circleMarker(latlng, {
        radius: 12,
        color: '#ed7d31',
        weight: 3,
        fillOpacity: 0,
        interactive: false,
      }).addTo(layer);
      setTimeout(() => layer.removeLayer(ring), 600);
    }

    function totalMiles() {
      let total = 0;
      for (let i = 1; i < points.length; i++) {
        total += segmentMiles(points[i - 1], points[i]);
      }
      return total;
    }

    function redraw() {
      if (polyline) { layer.removeLayer(polyline); polyline = null; }
      if (points.length >= 2) {
        polyline = L.polyline(points, LINE_STYLE);
        layer.addLayer(polyline);
      }
      markers.forEach(m => layer.removeLayer(m));
      markers = [];
      let cum = 0;
      points.forEach((p, i) => {
        if (i > 0) cum += segmentMiles(points[i - 1], p);
        const m = L.circleMarker(p, WAYPOINT_STYLE);
        const label = i === 0
          ? 'Start'
          : `${formatMiles(cum)} · ${bearingLabel(points[i - 1], p)}`;
        m.bindTooltip(label, {
          permanent: true,
          direction: 'top',
          offset: [0, -8],
          className: 'measure-label',
        });
        layer.addLayer(m);
        markers.push(m);
      });
    }

    function start(latlng) {
      clear();
      points = [latlng];
      active = true;
      map.doubleClickZoom.disable();
      L.DomUtil.addClass(map.getContainer(), 'measure-cursor');
      redraw();
    }

    function addPoint(latlng) {
      points.push(latlng);
      redraw();
    }

    function finish() {
      if (!active) return;
      active = false;
      map.doubleClickZoom.enable();
      L.DomUtil.removeClass(map.getContainer(), 'measure-cursor');
      // One-point measurements aren't useful; discard so a stray Esc
      // doesn't leave a lonely marker behind.
      if (points.length < 2) clear();
    }

    function clear() {
      active = false;
      points = [];
      map.doubleClickZoom.enable();
      L.DomUtil.removeClass(map.getContainer(), 'measure-cursor');
      if (polyline) { layer.removeLayer(polyline); polyline = null; }
      markers.forEach(m => layer.removeLayer(m));
      markers = [];
      closePopup();
    }

    function closePopup() {
      if (openPopup) { map.closePopup(openPopup); openPopup = null; }
    }

    function makeButton(label, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = label;
      L.DomEvent.on(b, 'click', e => {
        L.DomEvent.stop(e);
        closePopup();
        onClick();
      });
      return b;
    }

    function showActionPopup(latlng) {
      const hasLine = points.length >= 2;
      const container = document.createElement('div');
      container.className = 'measure-actions';

      if (hasLine) {
        const head = document.createElement('div');
        head.className = 'measure-actions-total';
        head.textContent = 'Total: ' + formatMiles(totalMiles());
        container.appendChild(head);
      }

      if (!active) {
        container.appendChild(makeButton(
          hasLine ? 'New measurement from here' : 'Measure from here',
          () => start(latlng)
        ));
      } else {
        container.appendChild(makeButton('Finish here', () => {
          addPoint(latlng);
          finish();
        }));
      }
      if (hasLine || active) {
        container.appendChild(makeButton('Clear measurement', clear));
      }

      const popup = L.popup({
        closeButton: false,
        className: 'measure-popup',
        autoPan: false,
      })
        .setLatLng(latlng)
        .setContent(container)
        .openOn(map);
      openPopup = popup;
    }

    // --- Event wiring ---

    map.on('contextmenu', e => {
      // Suppress the browser's native right-click menu so ours shows alone.
      L.DomEvent.preventDefault(e.originalEvent);
      showActionPopup(e.latlng);
    });

    map.on('click', e => {
      if (!active) return;
      // Ignore clicks that originated inside Leaflet popups or controls —
      // those are UI interactions, not waypoints.
      const t = e.originalEvent && e.originalEvent.target;
      if (t && t.closest && t.closest('.leaflet-popup, .leaflet-control')) return;
      const { latlng, snapped } = snapClick(e.latlng);
      if (snapped) flashSnap(latlng);
      addPoint(latlng);
    });

    map.on('dblclick', () => {
      if (active) finish();
    });

    return {
      clear,
      finish,
      isActive: () => active,
      hasMeasurement: () => points.length >= 2,
      setSnapTargets,
    };
  }

  window.HurricaneMeasure = { init };
})();
