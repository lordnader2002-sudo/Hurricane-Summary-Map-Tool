/* global leafletImage */
/*
 * PNG export for the live Leaflet map.
 *
 * leaflet-image rasterizes tiles + vector overlays + image markers, but it
 * cannot capture HTML divIcons (our orange-bordered callout boxes). After it
 * returns, we draw the callouts onto the same canvas using the live map's
 * coordinate→pixel projection, then trigger a file download.
 */
(function () {
  'use strict';

  function exportPng(controller, opts) {
    opts = opts || {};
    const map = controller.getMap();
    const { storm, properties } = controller.getCurrent();

    return new Promise((resolve, reject) => {
      leafletImage(map, (err, canvas) => {
        if (err) return reject(err);
        try {
          drawCallouts(canvas, map, properties);
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

  function drawCallouts(canvas, map, properties) {
    const ctx = canvas.getContext('2d');
    const impacted = (properties || []).filter(p => p.impacted);
    if (impacted.length === 0) return;

    // Re-cluster the same way map.js does so the export matches what's on screen
    const projected = impacted.map(p => ({
      item: p,
      pt: map.latLngToContainerPoint([p.lat, p.lon]),
    }));
    const clusters = [];
    const used = new Set();
    const threshold = 36;
    for (let i = 0; i < projected.length; i += 1) {
      if (used.has(i)) continue;
      const group = [projected[i]];
      used.add(i);
      for (let j = i + 1; j < projected.length; j += 1) {
        if (used.has(j)) continue;
        if (projected[i].pt.distanceTo(projected[j].pt) <= threshold) {
          group.push(projected[j]);
          used.add(j);
        }
      }
      clusters.push(group);
    }

    ctx.save();
    ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'top';

    clusters.forEach(group => {
      const lines = group.map(g => g.item.name);
      const cx = group.reduce((s, g) => s + g.pt.x, 0) / group.length;
      const cy = group.reduce((s, g) => s + g.pt.y, 0) / group.length;

      const padX = 7, padY = 4, lineH = 14;
      const widths = lines.map(t => ctx.measureText(t).width);
      const w = Math.max.apply(null, widths) + padX * 2;
      const h = lines.length * lineH + padY * 2;

      // Anchor the box just above-right of the cluster centroid
      const x = Math.round(cx + 6);
      const y = Math.round(cy - h - 6);

      // Black box w/ red border (matches the slide style)
      ctx.fillStyle = '#000';
      ctx.strokeStyle = '#c00000';
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, w, h, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#fff';
      lines.forEach((t, i) => {
        const tw = widths[i];
        ctx.fillText(t, x + (w - tw) / 2, y + padY + i * lineH);
      });
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
    const padX = 10, padY = 6;
    const w = ctx.measureText(text).width + padX * 2;
    const h = 22;
    const x = 12, y = 12;

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
