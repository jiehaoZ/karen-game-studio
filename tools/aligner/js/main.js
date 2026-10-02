/**
 * Wiring: owns the single state reference, renders it, and translates every
 * control into a state transition.
 *
 * State is replaced wholesale on each change and the whole UI redraws from it.
 * At this size that is simpler and less bug-prone than tracking which widget
 * needs updating, and the canvas has to repaint on almost every change anyway.
 */
(function (App) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /**
   * Inline SVG rather than glyphs. `◉` and `✕` render at whatever weight and
   * baseline the fallback font decides, which on a mixed Chinese/Latin stack
   * is not the same box twice.
   */
  const ICON = {
    eye:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">' +
      '<path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z"/>' +
      '<circle cx="8" cy="8" r="1.9"/></svg>',
    eyeOff:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">' +
      '<path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8Z"/>' +
      '<path d="M2.5 13.5 13.5 2.5"/></svg>',
    close:
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">' +
      '<path d="M4 4l8 8M12 4l-8 8"/></svg>',
  };

  const els = {
    stage: $('stage'),
    stack: $('canvasStack'),
    wrap: $('canvasWrap'),
    overflow: $('overflowCanvas'),
    artwork: $('artworkCanvas'),
    overlay: $('overlayCanvas'),
    stageHint: $('stageHint'),
    stageStatus: $('stageStatus'),
    canvasW: $('canvasW'),
    canvasH: $('canvasH'),
    squareLock: $('squareLock'),
    undoBtn: $('undoBtn'),
    redoBtn: $('redoBtn'),
    importBtn: $('importBtn'),
    fileInput: $('fileInput'),
    layerList: $('layerList'),
    layerCount: $('layerCount'),
    layerEmpty: $('layerEmpty'),
    layerHint: $('layerHint'),
    transformBlock: $('transformBlock'),
    scaleSlider: $('scaleSlider'),
    scaleInput: $('scaleInput'),
    renderedSize: $('renderedSize'),
    posX: $('posX'),
    posY: $('posY'),
    centerBtn: $('centerBtn'),
    fitBtn: $('fitBtn'),
    resetBtn: $('resetBtn'),
    matchBtn: $('matchBtn'),
    blendSelect: $('blendSelect'),
    onionSlider: $('onionSlider'),
    onionValue: $('onionValue'),
    soloToggle: $('soloToggle'),
    snapToggle: $('snapToggle'),
    guideToggle: $('guideToggle'),
    guidePercent: $('guidePercent'),
    guideValue: $('guideValue'),
    formatSelect: $('formatSelect'),
    ssimSelect: $('ssimSelect'),
    exportBtn: $('exportBtn'),
    progress: $('progress'),
    progressFill: $('progressFill'),
    progressLabel: $('progressLabel'),
    exportLog: $('exportLog'),
    dropVeil: $('dropVeil'),
  };

  let state = App.state.DEFAULT_STATE;
  let squareLocked = true;
  let viewScale = 1;
  let bleed = 0;
  const artworkCtx = els.artwork.getContext('2d');
  const overlayCtx = els.overlay.getContext('2d');
  const overflowCtx = els.overflow.getContext('2d');

  /**
   * How far the out-of-canvas preview reaches, as a fraction of the canvas.
   *
   * The whole bleed has to fit on screen — resize grips live out there now, and
   * a grip past the viewport edge cannot be clicked at all. So this trades
   * directly against how large the canvas itself is drawn, and 0.3 is the point
   * where a 512px document still renders around 1:1 on a normal window.
   */
  const BLEED_RATIO = 0.3;

  /** Total extent of the interactive area, canvas plus bleed on both sides. */
  const BLEED_SPAN = 1 + BLEED_RATIO * 2;

  function setState(next) {
    state = next;
    render();
  }

  const getState = () => state;
  const getViewScale = () => viewScale;

  /* ---------- undo plumbing ---------- */

  /** Continuous input within this window folds into one restore point. */
  const COALESCE_WINDOW_MS = 450;
  const lastCoalesced = new Map();

  /** Open a restore point holding the document as it stands right now. */
  function commit() {
    lastCoalesced.clear();
    state = App.state.commit(state);
  }

  /**
   * Same, but only if this kind of edit has paused. Sliders, wheels and held
   * arrow keys fire continuously; without this a single drag would bury sixty
   * entries in the stack and Cmd+Z would crawl back one pixel at a time.
   */
  function commitCoalesced(key) {
    const now = Date.now();
    const previous = lastCoalesced.get(key) || 0;
    lastCoalesced.set(key, now);
    if (now - previous < COALESCE_WINDOW_MS) return;
    state = App.state.commit(state);
  }

  /**
   * Apply a discrete edit, recording a restore point only if it changed
   * something.
   *
   * The guard is load-bearing, not tidiness. Clicking undo blurs whatever
   * field has focus, and the browser fires a native `change` on the way out if
   * its value was ever edited — so a no-op edit lands *just before* the undo
   * runs, snapshots the current document, and undo then restores the state it
   * was already in. The button appears dead.
   */
  function edit(transform) {
    const preview = transform(state);
    if (App.state.sameDocument(preview, state)) {
      render();
      return;
    }
    // commit() only touches past/future, so the preview's document still holds.
    const committed = App.state.commit(state);
    setState({ ...preview, past: committed.past, future: committed.future });
  }

  /**
   * Fit the canvas into the stage without ever enlarging it past 1:1 — showing
   * a 256px canvas blown up to fill the pane would misrepresent the pixels
   * you are judging.
   */
  /**
   * Fit the canvas into the stage, never enlarging past 1:1.
   *
   * Sized against canvas *plus bleed*, not the canvas alone: the grips sit out
   * in the bleed, and anything scrolled past the viewport edge is unclickable.
   * Fitting the whole interactive area guarantees every grip stays reachable,
   * at the cost of drawing the canvas itself somewhat smaller.
   */
  function computeViewScale() {
    const padding = 40;
    const available = {
      width: els.stage.clientWidth - padding,
      height: els.stage.clientHeight - padding - 26,
    };
    if (available.width <= 0 || available.height <= 0) return 1;
    return Math.min(
      1,
      available.width / (state.canvas.width * BLEED_SPAN),
      available.height / (state.canvas.height * BLEED_SPAN)
    );
  }

  function syncCanvasElements() {
    const { width, height } = state.canvas;
    if (els.artwork.width !== width) els.artwork.width = width;
    if (els.artwork.height !== height) els.artwork.height = height;
    viewScale = computeViewScale();
    const cssWidth = Math.round(width * viewScale);
    const cssHeight = Math.round(height * viewScale);
    els.stack.style.width = `${cssWidth}px`;
    els.stack.style.height = `${cssHeight}px`;
    els.artwork.style.width = `${cssWidth}px`;
    els.artwork.style.height = `${cssHeight}px`;

    bleed = Math.round(Math.min(width, height) * BLEED_RATIO);
    const overflowW = width + bleed * 2;
    const overflowH = height + bleed * 2;
    if (els.overflow.width !== overflowW) els.overflow.width = overflowW;
    if (els.overflow.height !== overflowH) els.overflow.height = overflowH;
    els.overflow.style.width = `${Math.round(overflowW * viewScale)}px`;
    els.overflow.style.height = `${Math.round(overflowH * viewScale)}px`;

    // The overlay matches the bleed so grips can follow a layer past the frame.
    if (els.overlay.width !== overflowW) els.overlay.width = overflowW;
    if (els.overlay.height !== overflowH) els.overlay.height = overflowH;
    els.overlay.style.width = `${Math.round(overflowW * viewScale)}px`;
    els.overlay.style.height = `${Math.round(overflowH * viewScale)}px`;
  }

  function renderLayerList() {
    els.layerCount.textContent = String(state.layers.length);
    els.layerEmpty.hidden = state.layers.length > 0;
    els.layerHint.hidden = state.layers.length < 2;
    els.layerList.textContent = '';

    // Topmost layer first, matching the stacking order on the canvas.
    for (const layer of [...state.layers].reverse()) {
      const item = document.createElement('li');
      item.className = `layer${layer.id === state.selectedId ? ' selected' : ''}`;
      item.dataset.id = layer.id;

      const thumb = document.createElement('img');
      thumb.className = 'layer-thumb';
      thumb.src = layer.image.src;
      thumb.alt = '';

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = layer.name;
      name.title = layer.name;

      const scale = document.createElement('span');
      scale.className = 'layer-scale';
      scale.textContent = `${(layer.scale * 100).toFixed(0)}%`;

      const actions = document.createElement('span');
      actions.className = 'layer-actions';

      const visibility = document.createElement('button');
      visibility.type = 'button';
      visibility.className = layer.visible ? '' : 'off';
      visibility.innerHTML = layer.visible ? ICON.eye : ICON.eyeOff;
      visibility.title = layer.visible ? '隐藏' : '显示';
      visibility.setAttribute('aria-label', layer.visible ? '隐藏图层' : '显示图层');
      visibility.addEventListener('click', (event) => {
        event.stopPropagation();
        edit((s) => App.state.updateLayer(s, layer.id, { visible: !layer.visible }));
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.innerHTML = ICON.close;
      remove.title = '移除';
      remove.setAttribute('aria-label', '移除图层');
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        edit((s) => App.state.removeLayer(s, layer.id));
      });

      actions.append(visibility, remove);
      item.append(thumb, name, scale, actions);
      item.addEventListener('click', () => setState({ ...state, selectedId: layer.id }));
      els.layerList.appendChild(item);
    }
  }

  function renderTransformPanel() {
    const layer = App.state.selectedLayer(state);
    els.transformBlock.hidden = !layer;
    if (!layer) return;

    const percent = layer.scale * 100;
    els.scaleInput.value = percent.toFixed(1);
    // The slider tops out at 400%; beyond that it pins while the number field
    // stays authoritative, rather than silently clamping the actual scale.
    els.scaleSlider.value = String(Math.min(percent, Number(els.scaleSlider.max)));
    els.posX.value = String(Math.round(layer.x));
    els.posY.value = String(Math.round(layer.y));

    const bounds = App.state.layerBounds(layer, state.canvas);
    const long = Math.round(Math.max(bounds.width, bounds.height));
    const shareOfCanvas = (long / Math.min(state.canvas.width, state.canvas.height)) * 100;
    // The share is the number you actually align on, so it carries the amber
    // that means "registration target" everywhere else in the interface.
    els.renderedSize.innerHTML =
      `${Math.round(bounds.width)} × ${Math.round(bounds.height)} px<br />` +
      `长边占画布 <b>${shareOfCanvas.toFixed(0)}%</b>` +
      `  ·  源 ${layer.image.naturalWidth}×${layer.image.naturalHeight}`;
  }

  function renderStatus() {
    const parts = [`画布 ${state.canvas.width}×${state.canvas.height}`];
    if (viewScale < 1) parts.push(`显示 ${(viewScale * 100).toFixed(0)}%`);
    const layer = App.state.selectedLayer(state);
    if (layer) {
      const b = App.state.layerBounds(layer, state.canvas);
      parts.push(
        `${layer.name}`,
        `缩放 ${(layer.scale * 100).toFixed(1)}%`,
        `${Math.round(b.width)}×${Math.round(b.height)}`,
        `偏移 ${Math.round(layer.x)}, ${Math.round(layer.y)}`
      );
    }
    if (state.guide.enabled) {
      const guide = Math.round(
        (Math.min(state.canvas.width, state.canvas.height) * state.guide.percent) / 100
      );
      parts.push(`参考框 ${guide}px`);
    }
    els.stageStatus.textContent = parts.join('   ·   ');
  }

  function render() {
    syncCanvasElements();
    App.render.renderOverflow(overflowCtx, state, bleed);
    App.render.renderArtwork(artworkCtx, state);
    App.render.renderOverlay(overlayCtx, state, viewScale, bleed);
    renderLayerList();
    renderTransformPanel();
    renderStatus();

    els.stageHint.hidden = state.layers.length > 0;
    els.exportBtn.disabled = !state.layers.some((layer) => layer.visible);
    els.undoBtn.disabled = !App.state.canUndo(state);
    els.redoBtn.disabled = !App.state.canRedo(state);
    els.canvasW.value = String(state.canvas.width);
    els.canvasH.value = String(state.canvas.height);
    els.onionValue.textContent = `${Math.round(state.onionOpacity * 100)}%`;
    els.onionSlider.value = String(Math.round(state.onionOpacity * 100));
    els.guideValue.textContent = `${state.guide.percent}%`;
    els.blendSelect.value = state.blendMode;
    els.snapToggle.checked = state.snapEnabled;
    els.soloToggle.checked = state.soloSelected;
    els.formatSelect.value = state.exportFormat;
    els.ssimSelect.value = String(state.minSsim);
  }

  /* ---------- importing ---------- */

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => resolve({ image, name: file.name });
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`无法读取 ${file.name}`));
      };
      image.src = url;
    });
  }

  /**
   * Mean brightness of an image's border, used to pick a blend mode.
   *
   * Sampled from a small downscale rather than the full image: the border is
   * all that matters and a 32px thumbnail resolves it fine, at a fraction of
   * the pixels. Transparent artwork reports null — it needs no blending.
   */
  function borderLuma(image) {
    const size = 32;
    const scratch = document.createElement('canvas');
    scratch.width = scratch.height = size;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, size, size);

    const { data } = ctx.getImageData(0, 0, size, size);
    let total = 0;
    let counted = 0;
    let transparent = 0;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const onBorder = x === 0 || y === 0 || x === size - 1 || y === size - 1;
        if (!onBorder) continue;
        const i = (y * size + x) * 4;
        if (data[i + 3] < 16) {
          transparent++;
          continue;
        }
        total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        counted++;
      }
    }

    if (transparent > counted) return null;
    return counted ? total / counted : null;
  }

  function blendModeFor(image) {
    const luma = borderLuma(image);
    if (luma === null) return 'normal';
    return luma > 127 ? 'multiply' : 'screen';
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList).filter((file) => file.type.startsWith('image/'));
    if (!files.length) return;

    const results = await Promise.allSettled(files.map(readImage));
    const loaded = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results.filter((r) => r.status === 'rejected');

    if (loaded.length) {
      let next = App.state.addLayers(state, loaded);
      // Only on the first import: after that the choice is the user's.
      if (!state.layers.length) {
        next = { ...next, blendMode: blendModeFor(loaded[0].image) };
      }
      commit();
      setState(next);
    }
    if (failed.length) {
      els.stageStatus.textContent = `${failed.length} 个文件无法读取，已跳过`;
    }
  }

  /* ---------- exporting ---------- */

  const STOP_REASON = {
    quality: '压到画质临界',
    alpha: '柔边透明度已到临界',
    soft: '柔边占比大，保留真彩色',
    size: '体积已无收益',
    floor: '触及质量下限',
    ceiling: '最高质量已达临界',
    lossless: '无损',
  };

  function renderExportLog(entries, format) {
    const rows = entries.map((entry) => {
      const saved = 1 - entry.finalBytes / entry.bytes_at_max;
      // PNG's knob is palette size, not quality, so it reports colours. A PNG
      // that came back with neither was left as plain truecolour.
      const quality =
        entry.quality !== null
          ? `q${Math.round(entry.quality * 100)}`
          : entry.colors
            ? `${entry.colors} 色`
            : '无损';
      const similarity =
        entry.ssim === 1 ? '' : ` · 相似度 ${(entry.ssim * 100).toFixed(2)}%`;
      const title = `${STOP_REASON[entry.stoppedBy] || entry.stoppedBy} · 试了 ${entry.steps} 档`;
      return (
        `<div class="row" title="${title}"><span>${entry.name}</span>` +
        `<span>${quality}${similarity} · ${App.exporter.formatBytes(entry.finalBytes)} ` +
        `<span class="saved">−${(saved * 100).toFixed(0)}%</span></span></div>`
      );
    });

    const total = entries.reduce((sum, e) => sum + e.finalBytes, 0);
    const totalMax = entries.reduce((sum, e) => sum + e.bytes_at_max, 0);
    rows.push(
      `<div class="row total"><span>${entries.length} 个文件 · ${format}</span>` +
        `<span>${App.exporter.formatBytes(total)} <span class="saved">−${(
          (1 - total / totalMax) *
          100
        ).toFixed(0)}%</span></span></div>`
    );

    els.exportLog.innerHTML = rows.join('');
    els.exportLog.hidden = false;
  }

  async function runExport() {
    els.exportBtn.disabled = true;
    els.progress.hidden = false;
    els.exportLog.hidden = true;
    els.progressFill.style.width = '0%';
    els.progressLabel.textContent = '准备中…';

    try {
      const { zip, entries } = await App.exporter.exportAll(state, (done, total, label) => {
        els.progressFill.style.width = `${Math.round((done / total) * 100)}%`;
        els.progressLabel.textContent =
          label === 'packing' ? '打包 ZIP…' : `搜索质量下限 ${done + 1}/${total} · ${label}`;
      });

      els.progressFill.style.width = '100%';
      els.progressLabel.textContent = `完成 · ${App.exporter.formatBytes(zip.size)}`;
      renderExportLog(entries, App.exporter.FORMATS[state.exportFormat].label);

      const stamp = new Date().toISOString().slice(0, 10);
      App.exporter.download(zip, `aligned-${state.canvas.width}x${state.canvas.height}-${stamp}.zip`);
    } catch (error) {
      els.progressLabel.textContent = `导出失败：${error.message}`;
    } finally {
      els.exportBtn.disabled = false;
    }
  }

  /* ---------- control wiring ---------- */

  function applyCanvasSize(source) {
    const width = Number(els.canvasW.value);
    const height = squareLocked && source === 'w' ? width : Number(els.canvasH.value);
    const finalWidth = squareLocked && source === 'h' ? height : width;
    edit((s) => App.state.setCanvasSize(s, finalWidth, height));
  }

  function bindControls() {
    els.importBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', (event) => {
      importFiles(event.target.files);
      event.target.value = '';
    });

    els.canvasW.addEventListener('change', () => applyCanvasSize('w'));
    els.canvasH.addEventListener('change', () => applyCanvasSize('h'));
    els.squareLock.addEventListener('click', () => {
      squareLocked = !squareLocked;
      els.squareLock.setAttribute('aria-pressed', String(squareLocked));
      if (squareLocked) {
        edit((s) => App.state.setCanvasSize(s, s.canvas.width, s.canvas.width));
      }
    });

    els.scaleSlider.addEventListener('input', () => {
      const layer = App.state.selectedLayer(state);
      if (!layer) return;
      commitCoalesced('scale-slider');
      setState(App.state.setScale(state, layer.id, Number(els.scaleSlider.value) / 100));
    });

    els.scaleInput.addEventListener('change', () => {
      const layer = App.state.selectedLayer(state);
      const value = Number(els.scaleInput.value);
      if (layer && Number.isFinite(value) && value > 0) {
        edit((s) => App.state.setScale(s, layer.id, value / 100));
      } else {
        render();
      }
    });

    for (const [element, key] of [[els.posX, 'x'], [els.posY, 'y']]) {
      element.addEventListener('change', () => {
        const layer = App.state.selectedLayer(state);
        const value = Number(element.value);
        if (layer && Number.isFinite(value)) {
          edit((s) => App.state.updateLayer(s, layer.id, { [key]: value }));
        } else {
          render();
        }
      });
    }

    els.centerBtn.addEventListener('click', () => {
      const layer = App.state.selectedLayer(state);
      if (layer) edit((s) => App.state.updateLayer(s, layer.id, { x: 0, y: 0 }));
    });

    els.fitBtn.addEventListener('click', () => {
      const layer = App.state.selectedLayer(state);
      if (layer) {
        edit((s) => App.state.setScale(s, layer.id, App.state.fitScale(layer.image, s.canvas)));
      }
    });

    els.resetBtn.addEventListener('click', () => {
      const layer = App.state.selectedLayer(state);
      if (layer) edit((s) => App.state.resetLayer(s, layer.id));
    });

    els.matchBtn.addEventListener('click', () => edit(App.state.matchScaleToSelected));

    els.blendSelect.addEventListener('change', () =>
      setState({ ...state, blendMode: els.blendSelect.value })
    );

    els.onionSlider.addEventListener('input', () =>
      setState({ ...state, onionOpacity: Number(els.onionSlider.value) / 100 })
    );

    els.soloToggle.addEventListener('change', () =>
      setState({ ...state, soloSelected: els.soloToggle.checked })
    );

    els.snapToggle.addEventListener('change', () =>
      setState({ ...state, snapEnabled: els.snapToggle.checked })
    );

    els.guideToggle.addEventListener('change', () =>
      setState({ ...state, guide: { ...state.guide, enabled: els.guideToggle.checked } })
    );

    els.guidePercent.addEventListener('input', () =>
      setState({ ...state, guide: { ...state.guide, percent: Number(els.guidePercent.value) } })
    );

    for (const button of document.querySelectorAll('.segmented button')) {
      button.addEventListener('click', () => {
        for (const sibling of button.parentElement.children) {
          const active = sibling === button;
          sibling.classList.toggle('active', active);
          sibling.setAttribute('aria-checked', String(active));
        }
        setState({ ...state, guide: { ...state.guide, shape: button.dataset.shape } });
      });
    }

    els.formatSelect.addEventListener('change', () =>
      setState({ ...state, exportFormat: els.formatSelect.value })
    );

    els.ssimSelect.addEventListener('change', () =>
      setState({ ...state, minSsim: Number(els.ssimSelect.value) })
    );

    els.undoBtn.addEventListener('click', () => setState(App.state.undo(state)));
    els.redoBtn.addEventListener('click', () => setState(App.state.redo(state)));

    els.exportBtn.addEventListener('click', runExport);

    window.addEventListener('resize', render);
  }


  /**
   * Accept images from the clipboard.
   *
   * Screenshots and "copy image" from a browser never touch the filesystem, so
   * requiring a file picker for them means saving to disk purely to load it
   * back — the most common way an image arrives is the one that was missing.
   *
   * Text paste is deliberately left alone: the handler only claims the event
   * when the clipboard actually carries an image, and never while a field has
   * focus and plain text is on offer.
   */
  function bindClipboard() {
    window.addEventListener('paste', (event) => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;

      const items = Array.from(clipboard.items || []);
      const images = items
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (!images.length) return;

      const tag = document.activeElement && document.activeElement.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const hasText = items.some((item) => item.kind === 'string' && item.type === 'text/plain');
      if (typing && hasText) return;

      event.preventDefault();

      // Clipboard images arrive named "image.png" or unnamed, so a pasted batch
      // would collide on export. Stamp them instead.
      const stamp = new Date()
        .toTimeString()
        .slice(0, 8)
        .replace(/:/g, '');
      const named = images.map((file, index) => {
        const generic = !file.name || /^image\.\w+$/i.test(file.name);
        if (!generic) return file;
        const extension = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const suffix = images.length > 1 ? `-${index + 1}` : '';
        return new File([file], `paste-${stamp}${suffix}.${extension}`, { type: file.type });
      });

      importFiles(named);
    });
  }

  function bindDropTarget() {
    let depth = 0;

    window.addEventListener('dragenter', (event) => {
      event.preventDefault();
      depth += 1;
      els.dropVeil.hidden = false;
    });

    window.addEventListener('dragover', (event) => event.preventDefault());

    window.addEventListener('dragleave', (event) => {
      event.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) els.dropVeil.hidden = true;
    });

    window.addEventListener('drop', (event) => {
      event.preventDefault();
      depth = 0;
      els.dropVeil.hidden = true;
      if (event.dataTransfer && event.dataTransfer.files.length) {
        importFiles(event.dataTransfer.files);
      }
    });
  }

  function init() {
    // WebP encoding is near-universal now, but silently producing PNGs under a
    // WebP filename would be worse than saying so.
    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    if (!probe.toDataURL('image/webp').startsWith('data:image/webp')) {
      els.formatSelect.querySelector('option[value="image/webp"]').disabled = true;
      // Only rescue a state that actually asked for WebP; the default is PNG,
      // which every browser can write.
      if (state.exportFormat === 'image/webp') {
        els.formatSelect.value = 'image/jpeg';
        state = { ...state, exportFormat: 'image/jpeg' };
      }
    }

    bindControls();
    bindDropTarget();
    bindClipboard();
    App.interact.attach({
      // The overlay, not the plate: it spans the bleed, so grips that follow a
      // layer past the frame are still clickable where they are drawn.
      element: els.overlay,
      getState,
      setState,
      getViewScale,
      getBleed: () => bleed,
      commit,
      commitCoalesced,
      edit,
    });
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  App.main = { getState, setState };
})((window.App = window.App || {}));
