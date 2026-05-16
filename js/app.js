/* global HurricaneKMZ, PropertiesCSV, ImpactEngine, HurricaneMap, HurricaneExport, HurricaneSession */
/*
 * App bootstrap — wires the UI controls (file inputs, slider, export button,
 * impacted-property side list) to the parsing/impact/render modules.
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    const els = {
      kmzInput: document.getElementById('kmzInput'),
      csvInput: document.getElementById('csvInput'),
      bufferSlider: document.getElementById('bufferSlider'),
      bufferValue: document.getElementById('bufferValue'),
      labelsToggle: document.getElementById('labelsToggle'),
      exportBtn: document.getElementById('exportBtn'),
      exportCsvBtn: document.getElementById('exportCsvBtn'),
      status: document.getElementById('status'),
      stormMeta: document.getElementById('stormMeta'),
      categoryLegend: document.getElementById('categoryLegend'),
      wwLegend: document.getElementById('wwLegend'),
      impactedCount: document.getElementById('impactedCount'),
      impactedList: document.getElementById('impactedList'),
      sortBy: document.getElementById('sortBy'),
      trackShapeDefault: document.getElementById('trackShapeDefault'),
      trackColorByCategory: document.getElementById('trackColorByCategory'),
      trackColorDefault: document.getElementById('trackColorDefault'),
      trackPointsList: document.getElementById('trackPointsList'),
      trackPointsCount: document.getElementById('trackPointsCount'),
      resetBtn: document.getElementById('resetBtn'),
      restoreBanner: document.getElementById('restoreBanner'),
      restoreBannerText: document.getElementById('restoreBannerText'),
      restoreBtn: document.getElementById('restoreBtn'),
      dismissRestoreBtn: document.getElementById('dismissRestoreBtn'),
    };

    const state = {
      storm: null,
      parts: [],           // accumulated parsed parts (cone/track/ww/combined)
      rawProperties: [],   // un-impact-annotated
      properties: [],      // with inCone/distMiles/impacted
      propertiesSource: '',
      bufferMiles: parseInt(els.bufferSlider.value, 10),
      labelsVisible: true,
      // id -> forced impacted value; overrides the algorithm's verdict.
      manualOverride: new Map(),
      // Suppress session.save() while we're restoring a snapshot
      suppressSave: false,
    };

    const ctrl = HurricaneMap.init('map');
    ctrl.setOnTrackStyleChange(() => { renderTrackPointList(); scheduleSave(); });
    ctrl.setOnPropertyToggle((id, value) => {
      const p = state.properties.find(pp => pp.id === id);
      // If the new value matches what the algorithm said, drop the override
      // rather than persisting a redundant entry.
      if (p && value === p.algoImpacted) state.manualOverride.delete(id);
      else state.manualOverride.set(id, value);
      recomputeAndRender();
      scheduleSave();
    });
    ctrl.setOnCalloutChange(scheduleSave);

    function scheduleSave() {
      if (state.suppressSave) return;
      // Only persist after the user has uploaded at least one of storm/props,
      // so an opened-then-closed empty tab doesn't overwrite a real session.
      if (state.parts.length === 0 && state.rawProperties.length === 0) return;
      HurricaneSession.save(HurricaneSession.captureSnapshot(state, ctrl));
    }

    // --- Event wiring ---
    els.kmzInput.addEventListener('change', e => {
      handleFilesUpload(e.target.files);
      e.target.value = '';   // allow re-selecting the same file later
    });
    els.csvInput.addEventListener('change', e => handleCsvUpload(e.target.files[0]));

    els.bufferSlider.addEventListener('input', e => {
      state.bufferMiles = parseInt(e.target.value, 10);
      els.bufferValue.textContent = `${state.bufferMiles} mi`;
      recomputeAndRender();
      scheduleSave();
    });

    els.labelsToggle.addEventListener('change', e => {
      state.labelsVisible = e.target.checked;
      ctrl.setLabelsVisible(e.target.checked);
      scheduleSave();
    });

    els.resetBtn.addEventListener('click', () => {
      const ok = window.confirm(
        'This will clear your saved session (storm, properties, customisations) '
        + 'and reload the page. Continue?'
      );
      if (!ok) return;
      HurricaneSession.clear();
      location.reload();
    });

    els.dismissRestoreBtn.addEventListener('click', () => {
      els.restoreBanner.hidden = true;
      // User declined restore — discard the saved snapshot so it doesn't keep
      // re-prompting on future reloads.
      HurricaneSession.clear();
    });
    els.restoreBtn.addEventListener('click', async () => {
      els.restoreBanner.hidden = true;
      const snap = HurricaneSession.load();
      if (!snap) return;
      await restoreFromSnapshot(snap);
    });

    els.exportBtn.addEventListener('click', async () => {
      if (!state.storm) return;
      setStatus('Rendering PNG…');
      els.exportBtn.disabled = true;
      try {
        const filename = await HurricaneExport.exportPng(ctrl);
        setStatus(`Downloaded ${filename}`, 'success');
      } catch (err) {
        console.error(err);
        setStatus('Export failed: ' + (err && err.message ? err.message : err), 'error');
      } finally {
        els.exportBtn.disabled = !state.storm;
      }
    });

    els.exportCsvBtn.addEventListener('click', () => {
      try {
        const impacted = state.properties.filter(p => p.impacted);
        if (impacted.length === 0) {
          setStatus('No impacted properties to export', 'error');
          return;
        }
        const csv = buildImpactedCsv(impacted);
        const filename = buildExportFilename(state.storm, 'impacted', 'csv');
        HurricaneExport.triggerDownload(
          new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
          filename
        );
        setStatus(`Downloaded ${filename} (${impacted.length} rows)`, 'success');
      } catch (err) {
        console.error(err);
        setStatus('CSV export failed: ' + (err && err.message ? err.message : err), 'error');
      }
    });

    els.sortBy.addEventListener('change', renderImpactedList);

    initTrackControls();

    // --- Track point default controls ---
    function initTrackControls() {
      HurricaneMap.TRACK_SHAPES.forEach(shape => {
        const o = document.createElement('option');
        o.value = shape;
        o.textContent = HurricaneMap.TRACK_SHAPE_LABEL[shape];
        els.trackShapeDefault.appendChild(o);
      });
      const defaults = ctrl.getTrackDefaults();
      els.trackShapeDefault.value = defaults.shape;
      els.trackColorByCategory.checked = defaults.colorByCategory;
      els.trackColorDefault.value = defaults.color;
      els.trackColorDefault.disabled = defaults.colorByCategory;

      els.trackShapeDefault.addEventListener('change', applyTrackDefaults);
      els.trackColorByCategory.addEventListener('change', () => {
        els.trackColorDefault.disabled = els.trackColorByCategory.checked;
        applyTrackDefaults();
      });
      els.trackColorDefault.addEventListener('input', applyTrackDefaults);
    }

    function applyTrackDefaults() {
      ctrl.setTrackDefaults({
        shape: els.trackShapeDefault.value,
        color: els.trackColorDefault.value,
        colorByCategory: els.trackColorByCategory.checked,
      });
      scheduleSave();
    }

    // --- Handlers ---
    async function handleFilesUpload(fileList) {
      const files = Array.from(fileList || []);
      if (files.length === 0) return;
      setStatus(`Loading ${files.length} file(s)…`);
      try {
        const newParts = await HurricaneKMZ.parseToParts(files);
        // Accumulate parts across uploads; a newly-uploaded part replaces any
        // existing part of the same kind (e.g. re-uploading an updated CONE).
        newParts.forEach(np => {
          state.parts = state.parts.filter(p => p.kind !== np.kind);
          state.parts.push(np);
        });
        const storm = HurricaneKMZ.mergeParts(state.parts);
        state.storm = storm;
        ctrl.setStorm(storm);
        renderStormMeta();
        renderCategoryLegend();
        renderWWLegend();
        renderTrackPointList();
        recomputeAndRender();
        ctrl.fit();
        els.exportBtn.disabled = false;
        els.exportCsvBtn.disabled = false;
        scheduleSave();

        const bits = [
          `${storm.trackPoints.features.length} track points`,
          storm.cone ? 'cone present' : 'no cone',
          storm.ww.length ? `${storm.ww.length} watch/warning segment(s)` : null,
        ].filter(Boolean);
        const srcTxt = storm.sources.length ? storm.sources.join(' + ') : 'storm';
        setStatus(
          `Loaded ${srcTxt} for "${storm.stormName}" — ${bits.join(', ')}`,
          'success'
        );
      } catch (err) {
        console.error(err);
        setStatus('Load failed: ' + (err && err.message ? err.message : err), 'error');
      }
    }

    async function handleCsvUpload(file) {
      if (!file) return;
      setStatus(`Parsing ${file.name}…`);
      try {
        const { properties, skipped } = await PropertiesCSV.parseCsvFile(file, {
          onProgress: msg => setStatus(msg),
        });
        state.rawProperties = properties;
        state.propertiesSource = file.name;
        recomputeAndRender();
        ctrl.fit();
        scheduleSave();
        const skipMsg = skipped > 0 ? ` (${skipped} row(s) skipped — no usable lat/lon)` : '';
        setStatus(`Loaded ${properties.length} properties${skipMsg}`, 'success');
      } catch (err) {
        console.error(err);
        setStatus('CSV load failed: ' + (err && err.message ? err.message : err), 'error');
      }
    }

    function recomputeAndRender() {
      if (state.rawProperties.length === 0) {
        state.properties = [];
        ctrl.setProperties([]);
        renderImpactedList();
        return;
      }
      state.properties = ImpactEngine.computeImpact(
        state.rawProperties, state.storm, state.bufferMiles
      );
      // Preserve the algorithm's verdict and apply any manual overrides on top.
      state.properties.forEach(p => {
        p.algoImpacted = p.impacted;
        if (state.manualOverride.has(p.id)) p.impacted = state.manualOverride.get(p.id);
      });
      ctrl.setProperties(state.properties);
      renderImpactedList();
    }

    function renderImpactedList() {
      const impacted = state.properties.filter(p => p.impacted);
      els.impactedCount.textContent = String(impacted.length);

      const sortBy = els.sortBy.value;
      const sorted = impacted.slice().sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'cone') {
          if (a.inCone !== b.inCone) return a.inCone ? -1 : 1;
          return (a.distMiles ?? Infinity) - (b.distMiles ?? Infinity);
        }
        // distance
        return (a.distMiles ?? Infinity) - (b.distMiles ?? Infinity);
      });

      els.impactedList.innerHTML = '';
      if (sorted.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = state.storm && state.rawProperties.length
          ? 'No properties in cone or buffer'
          : 'Upload a KMZ and CSV to see impacted properties';
        els.impactedList.appendChild(li);
        return;
      }

      const frag = document.createDocumentFragment();
      sorted.forEach(p => {
        const li = document.createElement('li');
        li.title = 'Click to zoom to property';
        li.addEventListener('click', () => ctrl.flyTo(p.lat, p.lon));

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = p.name;
        if (p.inCone) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'IN CONE';
          name.appendChild(badge);
        }
        li.appendChild(name);

        const meta = document.createElement('span');
        meta.className = 'meta';
        const distTxt = p.distMiles != null ? `${p.distMiles.toFixed(1)} mi from track` : '';
        meta.textContent = [p.address, distTxt].filter(Boolean).join(' · ');
        li.appendChild(meta);

        frag.appendChild(li);
      });
      els.impactedList.appendChild(frag);
    }

    function renderStormMeta() {
      if (!state.storm) {
        els.stormMeta.textContent = 'No storm loaded';
        return;
      }
      const meta = [state.storm.stormName];
      if (state.storm.advisoryDate) meta.push(state.storm.advisoryDate);
      const tp = state.storm.trackPoints && state.storm.trackPoints.features.length;
      if (tp) meta.push(`${tp} track points`);
      if (state.storm.sources && state.storm.sources.length) {
        meta.push(state.storm.sources.join(' + '));
      }
      els.stormMeta.textContent = meta.join(' · ');
    }

    function renderCategoryLegend() {
      els.categoryLegend.innerHTML = '';
      if (!state.storm || !state.storm.iconMap) return;
      const labels = HurricaneKMZ.CATEGORY_LABEL;
      Object.keys(state.storm.iconMap).forEach(cat => {
        const li = document.createElement('li');
        const img = document.createElement('img');
        img.src = state.storm.iconMap[cat];
        img.alt = cat;
        li.appendChild(img);
        li.appendChild(document.createTextNode(' ' + (labels[cat] || cat)));
        els.categoryLegend.appendChild(li);
      });
    }

    function renderTrackPointList() {
      if (!els.trackPointsList) return;
      const points = ctrl.getTrackPointsWithStyle();
      if (els.trackPointsCount) {
        els.trackPointsCount.textContent = String(points.length);
      }
      els.trackPointsList.innerHTML = '';
      if (points.length === 0) return;

      const frag = document.createDocumentFragment();
      points.forEach(({ feature, style }) => {
        const li = document.createElement('li');
        li.className = 'track-point-row';
        if (style.label) li.classList.add('has-label');
        if (style.description) li.classList.add('has-description');
        li.title = 'Click to fly to and edit this track point';
        li.addEventListener('click', () => ctrl.openTrackPoint(style.order));

        const head = document.createElement('div');
        head.className = 'track-point-head';
        const time = document.createElement('span');
        time.className = 'track-point-time';
        time.textContent = feature.properties.name || ('Point ' + style.order);
        head.appendChild(time);
        const cat = document.createElement('span');
        cat.className = 'track-point-cat';
        cat.textContent = feature.properties.categoryLabel || '';
        head.appendChild(cat);
        li.appendChild(head);

        if (style.label) {
          const lbl = document.createElement('div');
          lbl.className = 'track-point-label';
          lbl.textContent = style.label;
          li.appendChild(lbl);
        }
        if (style.description) {
          const desc = document.createElement('div');
          desc.className = 'track-point-desc';
          desc.textContent = style.description;
          li.appendChild(desc);
        }
        frag.appendChild(li);
      });
      els.trackPointsList.appendChild(frag);
    }

    function renderWWLegend() {
      els.wwLegend.innerHTML = '';
      if (!state.storm || !state.storm.ww || state.storm.ww.length === 0) return;
      // One legend row per distinct watch/warning category present
      const seen = new Map();
      state.storm.ww.forEach(seg => {
        if (!seen.has(seg.category)) seen.set(seg.category, seg);
      });
      seen.forEach(seg => {
        const li = document.createElement('li');
        const sw = document.createElement('span');
        sw.className = 'swatch ww-line';
        sw.style.background = seg.color;
        li.appendChild(sw);
        li.appendChild(document.createTextNode(' ' + seg.label));
        els.wwLegend.appendChild(li);
      });
    }

    function setStatus(msg, kind) {
      els.status.textContent = msg || '';
      els.status.className = 'status' + (kind ? ' ' + kind : '');
    }

    async function restoreFromSnapshot(snap) {
      state.suppressSave = true;
      try {
        setStatus('Restoring saved session…');
        await HurricaneSession.applySnapshot(snap, state, ctrl);

        // Sync the UI controls that aren't auto-driven by ctrl
        els.bufferSlider.value = String(state.bufferMiles);
        els.bufferValue.textContent = `${state.bufferMiles} mi`;
        els.labelsToggle.checked = state.labelsVisible !== false;
        const defaults = ctrl.getTrackDefaults();
        els.trackShapeDefault.value = defaults.shape;
        els.trackColorByCategory.checked = defaults.colorByCategory;
        els.trackColorDefault.value = defaults.color;
        els.trackColorDefault.disabled = defaults.colorByCategory;

        if (state.storm) {
          renderStormMeta();
          renderCategoryLegend();
          renderWWLegend();
          renderTrackPointList();
          els.exportBtn.disabled = false;
          els.exportCsvBtn.disabled = false;
        }
        recomputeAndRender();
        if (state.storm || state.rawProperties.length) ctrl.fit();

        const bits = [];
        if (state.storm) bits.push(`storm: ${state.storm.stormName}`);
        if (state.rawProperties.length) bits.push(`${state.rawProperties.length} properties`);
        setStatus(`Restored saved session (${bits.join(', ')})`, 'success');
      } finally {
        state.suppressSave = false;
      }
    }

    // Restore prompt on page load
    (function maybePromptRestore() {
      const snap = HurricaneSession.load();
      if (!snap) return;
      const when = snap.savedAt ? new Date(snap.savedAt) : null;
      const ago = when ? timeAgo(when) : 'recently';
      const bits = [];
      if (snap.storm && snap.storm.fileNames && snap.storm.fileNames.length) {
        bits.push(snap.storm.fileNames.join(', '));
      }
      if (snap.properties && snap.properties.rows) {
        bits.push(`${snap.properties.rows.length} properties`);
      }
      els.restoreBannerText.textContent =
        `Saved session from ${ago}${bits.length ? ' (' + bits.join(' · ') + ')' : ''}.`;
      els.restoreBanner.hidden = false;
    })();

    function timeAgo(date) {
      const sec = Math.max(1, Math.round((Date.now() - date.getTime()) / 1000));
      if (sec < 60) return sec + 's ago';
      const min = Math.round(sec / 60);
      if (min < 60) return min + 'm ago';
      const hr = Math.round(min / 60);
      if (hr < 24) return hr + 'h ago';
      const day = Math.round(hr / 24);
      return day + 'd ago';
    }

    function csvField(v) {
      if (v == null) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function buildImpactedCsv(impacted) {
      const headers = [
        'property_id', 'name', 'address', 'postal_code',
        'lat', 'lon', 'dist_miles', 'in_cone', 'manually_flagged',
      ];
      const lines = [headers.join(',')];
      impacted.forEach(p => {
        lines.push([
          p.id,
          p.name,
          p.address || '',
          p.postalCode || '',
          p.lat,
          p.lon,
          p.distMiles != null ? p.distMiles.toFixed(2) : '',
          p.inCone ? 'true' : 'false',
          state.manualOverride.has(p.id) ? 'true' : 'false',
        ].map(csvField).join(','));
      });
      return lines.join('\n') + '\n';
    }

    function buildExportFilename(storm, suffix, ext) {
      const name = storm && storm.stormName
        ? storm.stormName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
        : 'hurricane';
      const date = (storm && storm.advisoryDate)
        ? storm.advisoryDate.replace(/-/g, '')
        : new Date().toISOString().slice(0, 10).replace(/-/g, '');
      return `${name || 'hurricane'}_${date}_${suffix}.${ext}`;
    }
  });
})();
