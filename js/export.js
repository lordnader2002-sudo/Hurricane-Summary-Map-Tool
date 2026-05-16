/* global HurricaneMap */
/*
 * PNG export for the live Leaflet map.
 *
 * Rather than re-fetching tiles/markers (the old leaflet-image approach, which
 * could hang indefinitely when an image failed to load), this composites the
 * export straight from what the browser has *already rendered* in the DOM:
 *
 *   1. Tile <img> elements from the tile pane
 *   2. The canvas the Leaflet canvas-renderer already drew vectors onto
 *      (cone, watch/warning lines, track line, property dots, leader lines)
 *   3. Track-point marker <img> icons from the marker pane
 *
 * Then the callout boxes and track-point text labels are drawn on top (those
 * are HTML divIcons / tooltips, which aren't pixels we can copy). The whole
 * thing is synchronous except the final toBlob — it cannot hang.
 */
(function () {
  'use strict';

  const TRACK_LABEL_FONT =
    '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  function buildExportCanvas(controller) {
    const map = controller.getMap();
    const { storm } = controller.getCurrent();
    const overlays = controller.getOverlayLabels();
    const container = map.getContainer();

    const size = map.getSize();
    const canvas = document.createElement('canvas');
    canvas.width = size.x;
    canvas.height = size.y;
    const ctx = canvas.getContext('2d');
    const base = container.getBoundingClientRect();

    // Background (shows through where tiles haven't loaded)
    ctx.fillStyle = '#dfe6ec';
    ctx.fillRect(0, 0, size.x, size.y);

    // 1. Map tiles — already loaded <img> elements in the tile pane
    container.querySelectorAll('.leaflet-tile-pane img').forEach(img => {
      if (!img.complete || !img.naturalWidth) return;
      const r = img.getBoundingClientRect();
      ctx.drawImage(img, r.left - base.left, r.top - base.top, r.width, r.height);
    });

    // 2. Vector overlays — the canvas-renderer canvas(es) in the overlay
    //    pane already have the cone, ww lines, track line, property dots,
    //    and red leader lines drawn on them.
    container.querySelectorAll('.leaflet-overlay-pane canvas').forEach(c => {
      const r = c.getBoundingClientRect();
      ctx.drawImage(c, r.left - base.left, r.top - base.top, r.width, r.height);
    });

    // 3. Track-point marker icons (image markers, not divIcons)
    container.querySelectorAll('.leaflet-marker-pane img').forEach(img => {
      if (!img.complete || !img.naturalWidth) return;
      const r = img.getBoundingClientRect();
      ctx.drawImage(img, r.left - base.left, r.top - base.top, r.width, r.height);
    });

    // 4. Callout boxes + track labels (HTML overlays — drawn by hand)
    drawCallouts(ctx, map, overlays.callouts);
    drawTrackLabels(ctx, map, overlays.trackLabels);
    drawAttribution(ctx, storm);

    return { canvas, storm };
  }

  function exportPng(controller) {
    return new Promise((resolve, reject) => {
      try {
        const { canvas, storm } = buildExportCanvas(controller);
        canvas.toBlob(blob => {
          if (!blob) {
            reject(new Error(
              'Could not encode the image — a map tile may have tainted the '
              + 'canvas. Try reloading the page so tiles load with CORS.'
            ));
            return;
          }
          const filename = buildFilename(storm, 'png');
          triggerDownload(blob, filename);
          resolve(filename);
        }, 'image/png');
      } catch (e) {
        reject(e);
      }
    });
  }

  function exportPdf(controller) {
    return new Promise((resolve, reject) => {
      try {
        const jspdfNS = window.jspdf;
        if (!jspdfNS || !jspdfNS.jsPDF) {
          reject(new Error('PDF library failed to load — check vendor/jspdf.umd.min.js'));
          return;
        }
        const { canvas, storm } = buildExportCanvas(controller);
        let dataUrl;
        try {
          dataUrl = canvas.toDataURL('image/png');
        } catch (_) {
          reject(new Error(
            'Could not encode the image — a map tile may have tainted the '
            + 'canvas. Try reloading the page so tiles load with CORS.'
          ));
          return;
        }

        // Landscape Letter; fit the canvas inside the page minus a small margin.
        const doc = new jspdfNS.jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const margin = 24;
        const availW = pageW - margin * 2;
        const availH = pageH - margin * 2;
        const scale = Math.min(availW / canvas.width, availH / canvas.height);
        const drawW = canvas.width * scale;
        const drawH = canvas.height * scale;
        const x = (pageW - drawW) / 2;
        const y = (pageH - drawH) / 2;

        doc.addImage(dataUrl, 'PNG', x, y, drawW, drawH);
        const filename = buildFilename(storm, 'pdf');
        doc.save(filename);
        resolve(filename);
      } catch (e) {
        reject(e);
      }
    });
  }

  function drawCallouts(ctx, map, callouts) {
    if (!callouts || callouts.length === 0) return;
    ctx.save();
    ctx.font = HurricaneMap.CALLOUT_FONT;
    ctx.textBaseline = 'top';

    const padY = HurricaneMap.CALLOUT_PAD_Y;
    const lineH = HurricaneMap.CALLOUT_LINE_H;
    const border = HurricaneMap.CALLOUT_BORDER;

    callouts.forEach(c => {
      const box = HurricaneMap.measureCalloutBox(c.lines);
      const center = map.latLngToContainerPoint([c.position.lat, c.position.lng]);
      const x = Math.round(center.x - box.width / 2);
      const y = Math.round(center.y - box.height / 2);

      // Black box with red border (matches the .property-callout slide style)
      ctx.fillStyle = '#000';
      ctx.strokeStyle = '#c00000';
      ctx.lineWidth = border;
      roundRect(ctx, x + border / 2, y + border / 2,
        box.width - border, box.height - border, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#fff';
      c.lines.forEach((t, i) => {
        const tw = ctx.measureText(t).width;
        const lineX = x + (box.width - tw) / 2;
        const lineY = y + border + padY + i * lineH + 1;
        ctx.fillText(t, lineX, lineY);
      });
    });
    ctx.restore();
  }

  function drawTrackLabels(ctx, map, trackLabels) {
    if (!trackLabels || trackLabels.length === 0) return;
    ctx.save();
    ctx.font = TRACK_LABEL_FONT;
    ctx.textBaseline = 'top';

    const padX = 6;
    const h = 18;

    trackLabels.forEach(l => {
      const pt = map.latLngToContainerPoint([l.lat, l.lon]);
      const tw = ctx.measureText(l.text).width;
      const w = tw + padX * 2;
      // Centered above the track point (mirrors the permanent tooltip)
      const x = Math.round(pt.x - w / 2);
      const y = Math.round(pt.y - 14 - h);

      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#999999';
      ctx.lineWidth = 1;
      roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#1d2733';
      ctx.fillText(l.text, x + padX, y + 4);
    });
    ctx.restore();
  }

  function drawAttribution(ctx, storm) {
    const text = (storm && storm.stormName ? storm.stormName : 'Hurricane')
      + ' summary'
      + (storm && storm.advisoryDate ? ` — advisory ${storm.advisoryDate}` : '');

    ctx.save();
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const padX = 10;
    const w = ctx.measureText(text).width + padX * 2;
    const h = 22;
    const x = 12;
    const y = 12;

    ctx.fillStyle = 'rgba(31, 78, 121, 0.92)';
    roundRect(ctx, x, y, w, h, 3);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + padX, y + h / 2);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  function buildFilename(storm, ext) {
    const name = storm && storm.stormName
      ? storm.stormName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
      : 'hurricane';
    const date = (storm && storm.advisoryDate)
      ? storm.advisoryDate.replace(/-/g, '')
      : new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `${name || 'hurricane'}_${date}_summary.${ext || 'png'}`;
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  window.HurricaneExport = { exportPng, exportPdf, triggerDownload };
})();
