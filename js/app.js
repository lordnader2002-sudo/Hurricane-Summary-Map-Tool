/* global HurricaneKMZ, PropertiesCSV, ImpactEngine, HurricaneMap, HurricaneExport, HurricaneSession, HurricaneShare, HurricaneTimeline, HurricaneCompare, HurricaneToast */
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
      exportPdfBtn: document.getElementById('exportPdfBtn'),
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
      shareBtn: document.getElementById('shareBtn'),
      restoreBanner: document.getElementById('restoreBanner'),
      restoreBannerText: document.getElementById('restoreBannerText'),
      restoreBtn: document.getElementById('restoreBtn'),
      dismissRestoreBtn: document.getElementById('dismissRestoreBtn'),
      timeline: document.getElementById('timeline'),
      timelineSlider: document.getElementById('timelineSlider'),
      timelineTime: document.getElementById('timelineTime'),
      timelineClearBtn: document.getElementById('timelineClearBtn'),
      scrubPanel: document.getElementById('scrubPanel'),
      scrubMeta: document.getElementById('scrubMeta'),
      scrubList: document.getElementById('scrubList'),
      scrubCount: document.getElementById('scrubCount'),
      compareInput: document.getElementById('compareInput'),
      comparePanel: document.getElementById('comparePanel'),
      compareMeta: document.getElementById('compareMeta'),
      compareClearBtn: document.getElementById('compareClearBtn'),
      newlyImpactedList: document.getElementById('newlyImpactedList'),
      newlyImpactedCount: document.getElementById('newlyImpactedCount'),
      droppedList: document.getElementById('droppedList'),
      droppedCount: document.getElementById('droppedCount'),
      unchangedList: document.getElementById('unchangedList'),
      unchangedCount: document.getElementById('unchangedCount'),
      shortcutHelp: document.getElementById('shortcutHelp'),
      shortcutHelpClose: document.getElementById('shortcutHelpClose'),
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
      // Pending share payload from #s=… on the URL, applied after upload
      pendingShare: null,
      // Advisory comparison (transient — not persisted to localStorage or share)
      compareParts: [],
      compareStorm: null,
      compareImpacted: [],
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

    els.compareInput.addEventListener('change', e => {
      handleCompareUpload(e.target.files);
      e.target.value = '';
    });
    els.compareClearBtn.addEventListener('click', clearCompare);

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

    els.timelineSlider.addEventListener('input', () => updateScrub(true));
    els.timelineClearBtn.addEventListener('click', () => {
      ctrl.setScrubPosition(null);
      els.scrubPanel.hidden = true;
      els.timelineTime.textContent = '';
    });

    els.shareBtn.addEventListener('click', async () => {
      if (state.parts.length === 0 && state.rawProperties.length === 0) {
        setStatus('Nothing to share yet — upload a storm or CSV first', 'error');
        HurricaneToast.show('Nothing to share yet — upload a storm or CSV first', 'warn');
        return;
      }
      try {
        const url = HurricaneShare.encode(state, ctrl);
        await navigator.clipboard.writeText(url);
        const sizeKb = Math.round(url.length / 1024);
        const bits = [];
        if (state.parts.length) bits.push(`${state.storm ? state.storm.trackPoints.features.length + ' track points' : 'storm'}`);
        if (state.rawProperties.length) bits.push(`${state.rawProperties.length} properties`);
        if (state.compareParts.length) bits.push('comparison advisory');
        setStatus(
          `Copied share URL (${sizeKb} KB) to clipboard — recipient opens it and the view loads automatically.`,
          'success'
        );
        HurricaneToast.show(
          `Share URL copied (${sizeKb} KB)`,
          'success',
          { detail: 'Embeds: ' + (bits.join(', ') || 'customisations only') }
        );
      } catch (err) {
        // Clipboard API can fail (insecure context, permissions); fall back to
        // setting a prompt-like input so the user can copy manually.
        try {
          const url = HurricaneShare.encode(state, ctrl);
          window.prompt('Copy this URL:', url);
          setStatus('Share URL ready (copy from the prompt)', 'success');
        } catch (e2) {
          setStatus('Share failed', 'error');
          HurricaneToast.show('Share failed: ' + (err && err.message ? err.message : err),
            'error', { detail: err && err.stack });
        }
      }
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
        HurricaneToast.show(`Downloaded ${filename}`, 'success');
      } catch (err) {
        setStatus('Export failed', 'error');
        HurricaneToast.show('PNG export failed: ' + (err && err.message ? err.message : err),
          'error', { detail: err && err.stack });
      } finally {
        els.exportBtn.disabled = !state.storm;
      }
    });

    els.exportPdfBtn.addEventListener('click', async () => {
      if (!state.storm) return;
      setStatus('Rendering PDF…');
      els.exportPdfBtn.disabled = true;
      try {
        const filename = await HurricaneExport.exportPdf(ctrl);
        setStatus(`Downloaded ${filename}`, 'success');
        HurricaneToast.show(`Downloaded ${filename}`, 'success');
      } catch (err) {
        setStatus('PDF export failed', 'error');
        HurricaneToast.show('PDF export failed: ' + (err && err.message ? err.message : err),
          'error', { detail: err && err.stack });
      } finally {
        els.exportPdfBtn.disabled = !state.storm;
      }
    });

    els.exportCsvBtn.addEventListener('click', () => {
      try {
        const impacted = state.properties.filter(p => p.impacted);
        if (impacted.length === 0) {
          setStatus('No impacted properties to export', 'error');
          HurricaneToast.show('No impacted properties to export', 'warn');
          return;
        }
        const csv = buildImpactedCsv(impacted);
        const filename = buildExportFilename(state.storm, 'impacted', 'csv');
        HurricaneExport.triggerDownload(
          new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
          filename
        );
        setStatus(`Downloaded ${filename} (${impacted.length} rows)`, 'success');
        HurricaneToast.show(`Downloaded ${filename} (${impacted.length} rows)`, 'success');
      } catch (err) {
        setStatus('CSV export failed', 'error');
        HurricaneToast.show('CSV export failed: ' + (err && err.message ? err.message : err),
          'error', { detail: err && err.stack });
      }
    });

    els.sortBy.addEventListener('change', renderImpactedList);

    initTrackControls();
    initKeyboardShortcuts();

    function initKeyboardShortcuts() {
      els.shortcutHelpClose.addEventListener('click', () => setShortcutHelp(false));
      els.shortcutHelp.addEventListener('click', e => {
        if (e.target === els.shortcutHelp) setShortcutHelp(false);
      });

      document.addEventListener('keydown', e => {
        const inField = e.target && e.target.matches &&
          e.target.matches('input,textarea,select,[contenteditable="true"]');

        // Modifier combos work even from inside fields so power users can
        // export/share without re-focusing the page.
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey
            && (e.key === 'e' || e.key === 'E')) {
          e.preventDefault();
          if (!els.exportBtn.disabled) els.exportBtn.click();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey
            && (e.key === 'S' || e.key === 's')) {
          e.preventDefault();
          if (!els.shareBtn.disabled) els.shareBtn.click();
          return;
        }

        if (e.key === 'Escape') {
          if (!els.shortcutHelp.hidden) {
            setShortcutHelp(false);
            return;
          }
          if (!els.scrubPanel.hidden) {
            ctrl.setScrubPosition(null);
            els.scrubPanel.hidden = true;
            els.timelineTime.textContent = '';
            return;
          }
          if (!els.comparePanel.hidden) {
            clearCompare();
            return;
          }
          return;
        }

        // The remaining shortcuts are single keystrokes — suppress them when
        // the user is typing into a field.
        if (inField) return;

        if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
          e.preventDefault();
          setShortcutHelp(els.shortcutHelp.hidden);
          return;
        }

        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight')
            && !els.timeline.hidden) {
          e.preventDefault();
          if (e.key === 'ArrowLeft') els.timelineSlider.stepDown();
          else els.timelineSlider.stepUp();
          els.timelineSlider.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }

    function setShortcutHelp(show) {
      els.shortcutHelp.hidden = !show;
      if (show) els.shortcutHelpClose.focus();
    }

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
        refreshTimelineRange();
        recomputeAndRender();
        ctrl.fit();
        els.exportBtn.disabled = false;
        els.exportPdfBtn.disabled = false;
        els.exportCsvBtn.disabled = false;
        els.shareBtn.disabled = false;
        await maybeApplyPendingShare();
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
        setStatus('Load failed', 'error');
        HurricaneToast.show('Load failed: ' + (err && err.message ? err.message : err),
          'error', { detail: err && err.stack });
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
        els.shareBtn.disabled = false;
        await maybeApplyPendingShare();
        scheduleSave();
        const skipMsg = skipped > 0 ? ` (${skipped} row(s) skipped — no usable lat/lon)` : '';
        setStatus(`Loaded ${properties.length} properties${skipMsg}`, 'success');
      } catch (err) {
        setStatus('CSV load failed', 'error');
        HurricaneToast.show('CSV load failed: ' + (err && err.message ? err.message : err),
          'error', { detail: err && err.stack });
      }
    }

    function recomputeAndRender() {
      if (state.rawProperties.length === 0) {
        state.properties = [];
        ctrl.setProperties([]);
        renderImpactedList();
        recomputeCompareImpact();
        renderComparePanel();
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
      // Keep the comparison view in sync with the same buffer/overrides
      recomputeCompareImpact();
      renderComparePanel();
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
          refreshTimelineRange();
          els.exportBtn.disabled = false;
          els.exportPdfBtn.disabled = false;
          els.exportCsvBtn.disabled = false;
          els.shareBtn.disabled = false;
        }
        recomputeAndRender();
        if (state.compareStorm) {
          recomputeCompareImpact();
          renderComparePanel();
        }
        if (state.storm || state.rawProperties.length) ctrl.fit();

        const bits = [];
        if (state.storm) bits.push(`storm: ${state.storm.stormName}`);
        if (state.rawProperties.length) bits.push(`${state.rawProperties.length} properties`);
        if (state.compareStorm) bits.push(`comparison: ${state.compareStorm.stormName}`);
        setStatus(`Restored saved session (${bits.join(', ')})`, 'success');
      } finally {
        state.suppressSave = false;
      }
    }

    async function maybeApplyPendingShare() {
      if (!state.pendingShare) return;
      state.suppressSave = true;
      try {
        const result = await HurricaneShare.applyPending(state.pendingShare, state, ctrl);
        if (!result.applied) return;   // still waiting on primary/CSV
        // Sync UI controls and surface any filename mismatch as a warning
        els.bufferSlider.value = String(state.bufferMiles);
        els.bufferValue.textContent = `${state.bufferMiles} mi`;
        els.labelsToggle.checked = state.labelsVisible !== false;
        const defaults = ctrl.getTrackDefaults();
        els.trackShapeDefault.value = defaults.shape;
        els.trackColorByCategory.checked = defaults.colorByCategory;
        els.trackColorDefault.value = defaults.color;
        els.trackColorDefault.disabled = defaults.colorByCategory;
        renderTrackPointList();
        recomputeAndRender();
        if (state.compareStorm) {
          recomputeCompareImpact();
          renderComparePanel();
        }

        const mm = HurricaneShare.filenameMismatchSummary(state.pendingShare, state);
        const warnings = [];
        if (mm.missing.length) warnings.push('missing: ' + mm.missing.join(', '));
        if (!mm.csvOk && mm.csvExpected) {
          warnings.push(`expected CSV "${mm.csvExpected}", got "${mm.csvGot || '(none)'}"`);
        }
        if (warnings.length) {
          setStatus('Shared view applied with warnings — ' + warnings.join('; '), 'error');
        } else {
          setStatus('Shared view applied', 'success');
        }

        // If a comparison file was part of the share but isn't loaded yet,
        // keep pendingShare alive so a later compare upload finishes the job.
        if (result.needsCompare && result.needsCompare.length) {
          HurricaneToast.show(
            'Comparison advisory still needed: ' + result.needsCompare.join(', '),
            'info', { timeout: 10000 }
          );
          return;
        }

        state.pendingShare = null;
        // Clear the share hash so a follow-up refresh doesn't re-prompt
        if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      } finally {
        state.suppressSave = false;
      }
    }

    // Pending share decode on page load. v3 shares embed the data and apply
    // immediately; legacy v2 shares carry only filenames and wait for the
    // receiver to upload before maybeApplyPendingShare() completes.
    (async function maybeDecodeShare() {
      const payload = HurricaneShare.decodePendingShare();
      if (!payload) return;
      state.pendingShare = payload;
      if (payload.v === 3) {
        setStatus('Loading shared view…');
        await applyEmbeddedShare();
        return;
      }
      // Legacy v2: explain what to upload.
      const expected = [];
      if (payload.fileNames && payload.fileNames.length) {
        expected.push(payload.fileNames.join(', '));
      }
      if (payload.csvFileName) expected.push(payload.csvFileName);
      if (payload.compareFileNames && payload.compareFileNames.length) {
        expected.push(payload.compareFileNames.join(', ') + ' (comparison)');
      }
      setStatus(
        'Shared view detected. Upload to apply: ' + (expected.join(' + ') || '(no files needed)'),
        'success'
      );
    })();

    async function applyEmbeddedShare() {
      await maybeApplyPendingShare();
      // Refresh the UI surfaces that handleFilesUpload/handleCsvUpload would
      // normally render after a fresh upload.
      if (state.storm) {
        renderStormMeta();
        renderCategoryLegend();
        renderWWLegend();
        renderTrackPointList();
        refreshTimelineRange();
        els.exportBtn.disabled = false;
        els.exportPdfBtn.disabled = false;
        els.exportCsvBtn.disabled = false;
      }
      if (state.storm || state.rawProperties.length) {
        els.shareBtn.disabled = false;
        ctrl.fit();
      }
    }

    // Restore prompt on page load. A pending share URL takes precedence —
    // we don't want the user restoring an old session that would clobber
    // what the share link wants to apply on top of their fresh uploads.
    (function maybePromptRestore() {
      if (state.pendingShare) return;
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

    // --- Advisory comparison ---

    async function handleCompareUpload(fileList) {
      const files = Array.from(fileList || []);
      if (files.length === 0) return;
      if (!state.storm) {
        setStatus('Load a primary storm first, then upload a comparison advisory', 'error');
        HurricaneToast.show('Load a primary storm first, then upload a comparison advisory', 'warn');
        return;
      }
      setStatus(`Loading comparison (${files.length} file(s))…`);
      try {
        const newParts = await HurricaneKMZ.parseToParts(files);
        // Accumulate by kind, just like the primary upload
        newParts.forEach(np => {
          state.compareParts = state.compareParts.filter(p => p.kind !== np.kind);
          state.compareParts.push(np);
        });
        state.compareStorm = HurricaneKMZ.mergeParts(state.compareParts);
        ctrl.setCompareStorm(state.compareStorm);
        recomputeCompareImpact();
        renderComparePanel();
        scheduleSave();
        // If we're mid-share-restore and the share asked for a comparison,
        // try to finish applying now that the file is loaded.
        await maybeApplyPendingShare();
        setStatus(
          `Comparison: "${state.compareStorm.stormName}" loaded `
          + `(${state.compareStorm.sources.join(' + ') || 'storm'})`,
          'success'
        );
        HurricaneToast.show(`Comparison "${state.compareStorm.stormName}" loaded`, 'success');
      } catch (err) {
        setStatus('Comparison load failed', 'error');
        HurricaneToast.show('Comparison load failed: '
          + (err && err.message ? err.message : err),
          'error', { detail: err && err.stack });
      }
    }

    function clearCompare() {
      state.compareParts = [];
      state.compareStorm = null;
      state.compareImpacted = [];
      ctrl.setCompareStorm(null);
      els.comparePanel.hidden = true;
      scheduleSave();
    }

    function recomputeCompareImpact() {
      if (!state.compareStorm || state.rawProperties.length === 0) {
        state.compareImpacted = [];
        return;
      }
      const annotated = ImpactEngine.computeImpact(
        state.rawProperties, state.compareStorm, state.bufferMiles
      );
      // Apply manual overrides to the comparison too — the user's manual flag
      // is about the property, not the advisory.
      annotated.forEach(p => {
        if (state.manualOverride.has(p.id)) p.impacted = state.manualOverride.get(p.id);
      });
      state.compareImpacted = annotated;
    }

    function renderComparePanel() {
      if (!state.compareStorm) {
        els.comparePanel.hidden = true;
        return;
      }
      const diff = HurricaneCompare.diffImpacts(state.properties, state.compareImpacted);
      const shift = HurricaneCompare.trackShift(state.storm, state.compareStorm);

      const metaBits = [];
      metaBits.push('vs <strong>' + escapeHtml(state.compareStorm.stormName) + '</strong>'
        + (state.compareStorm.advisoryDate ? ' (' + state.compareStorm.advisoryDate + ')' : ''));
      if (shift) {
        metaBits.push(
          'Track shift: max ' + shift.maxMiles.toFixed(1) + ' mi · avg '
          + shift.avgMiles.toFixed(1) + ' mi'
        );
      }
      els.compareMeta.innerHTML = metaBits.join('<br>');

      fillCompareList(els.newlyImpactedList, els.newlyImpactedCount, diff.newlyImpacted);
      fillCompareList(els.droppedList, els.droppedCount, diff.dropped);
      fillCompareList(els.unchangedList, els.unchangedCount, diff.unchanged);

      els.comparePanel.hidden = false;
    }

    function fillCompareList(listEl, countEl, rows) {
      countEl.textContent = String(rows.length);
      listEl.innerHTML = '';
      if (rows.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = '— none —';
        listEl.appendChild(li);
        return;
      }
      const frag = document.createDocumentFragment();
      rows.forEach(p => {
        const li = document.createElement('li');
        li.title = 'Click to zoom to property';
        li.addEventListener('click', () => ctrl.flyTo(p.lat, p.lon));
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = p.name;
        li.appendChild(name);
        const meta = document.createElement('span');
        meta.className = 'meta';
        const distTxt = p.distMiles != null ? p.distMiles.toFixed(1) + ' mi from track' : '';
        meta.textContent = [p.address, distTxt].filter(Boolean).join(' · ');
        li.appendChild(meta);
        frag.appendChild(li);
      });
      listEl.appendChild(frag);
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // --- Timeline scrubber ---

    function refreshTimelineRange() {
      const range = state.storm
        ? HurricaneTimeline.getTimeRange(state.storm.trackPoints)
        : null;
      if (!range) {
        els.timeline.hidden = true;
        els.scrubPanel.hidden = true;
        ctrl.setScrubPosition(null);
        return;
      }
      els.timeline.hidden = false;
      els.timelineSlider.min = String(range.tMin);
      els.timelineSlider.max = String(range.tMax);
      els.timelineSlider.step = String(Math.max(60_000, Math.round((range.tMax - range.tMin) / 200)));
      els.timelineSlider.value = String(range.tMin);
      els.timelineTime.textContent = HurricaneTimeline.formatTime(range.tMin) + '  (drag →)';
      ctrl.setScrubPosition(null);
      els.scrubPanel.hidden = true;
    }

    function updateScrub(showPanel) {
      if (!state.storm) return;
      const t = parseInt(els.timelineSlider.value, 10);
      const pos = HurricaneTimeline.interpolatePosition(state.storm.trackPoints, t);
      if (!pos) return;
      ctrl.setScrubPosition([pos.lat, pos.lon], {
        bufferMiles: state.bufferMiles,
      });
      els.timelineTime.textContent = HurricaneTimeline.formatTime(t);

      if (showPanel) {
        const near = HurricaneTimeline.propertiesNear(
          state.properties, pos, state.bufferMiles
        );
        els.scrubCount.textContent = String(near.length);
        els.scrubMeta.textContent =
          `Storm at ${pos.lat.toFixed(2)}, ${pos.lon.toFixed(2)}`
          + (pos.label ? ' · ' + pos.label : '')
          + ` · within ${state.bufferMiles} mi of ${near.length} property` + (near.length === 1 ? '' : 'ies');
        els.scrubList.innerHTML = '';
        if (near.length === 0) {
          const li = document.createElement('li');
          li.className = 'empty';
          li.textContent = 'No properties within buffer at this time';
          els.scrubList.appendChild(li);
        } else {
          const frag = document.createDocumentFragment();
          near.forEach(p => {
            const li = document.createElement('li');
            li.title = 'Click to zoom to property';
            li.addEventListener('click', () => ctrl.flyTo(p.lat, p.lon));
            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = p.name;
            li.appendChild(name);
            const meta = document.createElement('span');
            meta.className = 'meta';
            meta.textContent = [p.address, p.distMiles.toFixed(1) + ' mi'].filter(Boolean).join(' · ');
            li.appendChild(meta);
            frag.appendChild(li);
          });
          els.scrubList.appendChild(frag);
        }
        els.scrubPanel.hidden = false;
      }
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
