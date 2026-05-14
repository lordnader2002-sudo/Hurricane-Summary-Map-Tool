/* global HurricaneKMZ, PropertiesCSV, ImpactEngine, HurricaneMap, HurricaneExport */
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
    };

    const state = {
      storm: null,
      parts: [],           // accumulated parsed parts (cone/track/ww/combined)
      rawProperties: [],   // un-impact-annotated
      properties: [],      // with inCone/distMiles/impacted
      bufferMiles: parseInt(els.bufferSlider.value, 10),
    };

    const ctrl = HurricaneMap.init('map');

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
    });

    els.labelsToggle.addEventListener('change', e => {
      ctrl.setLabelsVisible(e.target.checked);
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
        recomputeAndRender();
        ctrl.fit();
        els.exportBtn.disabled = false;

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
        recomputeAndRender();
        ctrl.fit();
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
  });
})();
