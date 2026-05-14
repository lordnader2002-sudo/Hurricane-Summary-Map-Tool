/* global leafletImage, HurricaneMap */
/*
 * PNG export for the live Leaflet map.
 *
 * leaflet-image rasterizes tiles + vector overlays (cone, watch/warning lines,
 * track line, leader lines) + image markers (track-point SVG icons, property
 * dots). It cannot capture HTML divIcons or tooltips, so after it returns we
 * draw two things onto the same canvas using the live map's projection:
 *   - the property callout boxes, at their current (possibly dragged) spots
 *   - the track-point text labels
 * then trigger a file download.
 */
(function () {
  'use strict';

  const TRACK_LABEL_FONT =
    '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  function exportPng(controller) {
    const map = controller.getMap();
    const { storm } = controller.getCurrent();
    const overlays = controller.getOverlayLabels();

    return new Promise((resolve, reject) => {
      leafletImage(map, (err, canvas) => {
        if (err) return reject(err);
        try {
          drawCallouts(canvas, map, overlays.callouts);
          drawTrackLabels(canvas, map, overlays.trackLabels);
          drawAttribution(canvas, storm);
          canvas.toBlob(blob => {
            const filename = buildFilename(storm);
            triggerDownload(blob, filename);
            resolve(filename);
          }, 'image/png');
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  function drawCallouts(canvas, map, callouts) {
    if (!callouts || callouts.length === 0) return;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.font = HurricaneMap.CALLOUT_FONT;
    ctx.textBaseline = 'top';

    const padX = HurricaneMap.CALLOUT_PAD_X;
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

  function drawTrackLabels(canvas, map, trackLabels) {
    if (!trackLabels || trackLabels.length === 0) return;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.font = TRACK_LABEL_FONT;
    ctx.textBaseline = 'top';

    const padX = 6;
    const padY = 2;
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
      ctx.fillText(l.text, x + padX, y + padY + 2);
    });
    ctx.restore();
  }

  function drawAttribution(canvas, storm) {
    const ctx = canvas.getContext('2d');
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

  function buildFilename(storm) {
    const name = storm && storm.stormName
      ? storm.stormName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
      : 'hurricane';
    const date = (storm && storm.advisoryDate)
      ? storm.advisoryDate.replace(/-/g, '')
      : new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `${name || 'hurricane'}_${date}_summary.png`;
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

  window.HurricaneExport = { exportPng };
})();
