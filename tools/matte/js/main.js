/**
 * Wiring: owns the state, keys the preview, and drives export.
 *
 * Keying is pure and fast enough to re-run on every slider move, so there is no
 * incremental update machinery here — a change replaces the state and the
 * preview is recomputed from scratch. The one concession to speed is that the
 * interactive path keys a downscaled raster; export always uses the original.
 */
(function (App) {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    stage: $('stage'),
    plate: $('plate'),
    canvas: $('previewCanvas'),
    stageHint: $('stageHint'),
    stageStatus: $('stageStatus'),
    importBtn: $('importBtn'),
    fileInput: $('fileInput'),
    itemList: $('itemList'),
    itemCount: $('itemCount'),
    itemEmpty: $('itemEmpty'),
    keyBlock: $('keyBlock'),
    scopeBlock: $('scopeBlock'),
    scopeHint: $('scopeHint'),
    levelBlock: $('levelBlock'),
    colorField: $('colorField'),
    bgSwatch: $('bgSwatch'),
    bgValue: $('bgValue'),
    pickBtn: $('pickBtn'),
    softness: $('softness'),
    softnessValue: $('softnessValue'),
    verdict: $('verdict'),
    low: $('low'),
    lowValue: $('lowValue'),
    high: $('high'),
    highValue: $('highValue'),
    despillField: $('despillField'),
    despill: $('despill'),
    despillValue: $('despillValue'),
    applyAllBtn: $('applyAllBtn'),
    aiBlock: $('aiBlock'),
    aiState: $('aiState'),
    aiHint: $('aiHint'),
    aiToggleRow: $('aiToggleRow'),
    aiToggle: $('aiToggle'),
    aiRunBtn: $('aiRunBtn'),
    aiRemoveBtn: $('aiRemoveBtn'),
    aiProgress: $('aiProgress'),
    aiProgressFill: $('aiProgressFill'),
    aiProgressLabel: $('aiProgressLabel'),
    formatSelect: $('formatSelect'),
    exportBtn: $('exportBtn'),
    progress: $('progress'),
    progressFill: $('progressFill'),
    progressLabel: $('progressLabel'),
    exportLog: $('exportLog'),
    dropVeil: $('dropVeil'),
  };

  let state = App.state.DEFAULT_STATE;
  let picking = false;
  const ctx = els.canvas.getContext('2d');

  function setState(next) {
    state = next;
    render();
  }

  /* ── keying ───────────────────────────────────────────────────────── */

  /** Key one item's preview raster with its current settings. */
  function keyPreview(item) {
    if (item.useAi && item.aiAlpha) {
      return {
        data: App.ai.applyAlpha(item.preview, item.aiAlpha, {
          low: item.settings.low,
          high: item.settings.high,
          scope: item.settings.scope,
        }),
        stats: null,
      };
    }
    return App.key.key(item.preview, item.settings);
  }

  /** Paint the chosen view onto the preview canvas. */
  function paint(item) {
    const keyed = keyPreview(item);
    const { width, height } = item.preview;

    els.canvas.width = width;
    els.canvas.height = height;

    if (state.view === 'source') {
      ctx.putImageData(item.preview, 0, 0);
    } else if (state.view === 'alpha') {
      // Alpha as greyscale: the only way to see whether an edge is a clean
      // ramp or a stack of jaggies.
      const src = keyed.data.data;
      const out = ctx.createImageData(width, height);
      for (let i = 0; i < src.length; i += 4) {
        out.data[i] = out.data[i + 1] = out.data[i + 2] = src[i + 3];
        out.data[i + 3] = 255;
      }
      ctx.putImageData(out, 0, 0);
    } else {
      ctx.putImageData(keyed.data, 0, 0);
    }

    return keyed;
  }

  /* ── rendering ────────────────────────────────────────────────────── */

  function renderItemList() {
    els.itemCount.textContent = String(state.items.length);
    els.itemEmpty.hidden = state.items.length > 0;
    els.itemList.textContent = '';

    for (const item of state.items) {
      const li = document.createElement('li');
      li.className = `item${item.id === state.selectedId ? ' selected' : ''}`;

      const thumb = document.createElement('canvas');
      thumb.className = 'item-thumb';
      thumb.width = thumb.height = 28;
      const tctx = thumb.getContext('2d');
      const scale = Math.min(28 / item.preview.width, 28 / item.preview.height);
      const staging = document.createElement('canvas');
      staging.width = item.preview.width;
      staging.height = item.preview.height;
      staging.getContext('2d').putImageData(item.preview, 0, 0);
      tctx.drawImage(
        staging,
        (28 - item.preview.width * scale) / 2,
        (28 - item.preview.height * scale) / 2,
        item.preview.width * scale,
        item.preview.height * scale
      );

      const name = document.createElement('span');
      name.className = 'item-name';
      name.textContent = item.name;
      name.title = item.name;

      const mark = document.createElement('span');
      mark.className = `item-mark${item.useAi && item.aiAlpha ? ' ai' : ''}`;
      mark.textContent = item.useAi && item.aiAlpha ? 'AI' : App.key.MODES[item.settings.mode].label;

      const actions = document.createElement('span');
      actions.className = 'item-actions';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
      remove.title = '移除';
      remove.setAttribute('aria-label', '移除');
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        setState(App.state.removeItem(state, item.id));
      });
      actions.append(remove);

      li.append(thumb, name, mark, actions);
      li.addEventListener('click', () => setState({ ...state, selectedId: item.id }));
      els.itemList.appendChild(li);
    }
  }

  function renderVerdict(item) {
    const { detection } = item;
    const percent = Math.round(detection.flatness * 100);

    if (!detection.flat) {
      els.verdict.className = 'verdict rough';
      els.verdict.innerHTML =
        `边缘颜色不一致（一致度 <b>${percent}%</b>），<b>这不是纯色背景</b>。` +
        `纯色抠图对它无能为力，请用下面的 AI 抠图。`;
      return;
    }

    const labels = { black: '黑底', white: '白底', color: '纯色' };
    els.verdict.className = 'verdict flat';
    els.verdict.innerHTML =
      `检测到<b>${labels[detection.mode] || '纯色'}背景</b>，边缘一致度 <b>${percent}%</b>。`;
  }

  /** What each scope does, said in terms of the image on screen. */
  const SCOPE_HINTS = {
    outside:
      '只抠掉从画面边缘连过来的背景。主体<strong>内部</strong>和背景同色的地方会保留 —— ' +
      '黑底上熊猫的黑眼睛、白底上人物的白衣领，都不会被一起抠掉。',
    all: '整张图里凡是符合背景色的像素都抠掉，包括主体内部的。主体真的有镂空、或者要从贴图里剔掉某个颜色时用它。',
  };

  function renderControls(item) {
    const s = item.settings;
    const isColor = s.mode === 'color';
    const scope = App.key.SCOPES[s.scope] ? s.scope : 'outside';

    for (const button of document.querySelectorAll('.mode-switch button')) {
      const active = button.dataset.mode === s.mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }

    for (const button of document.querySelectorAll('.scope-switch button')) {
      const active = button.dataset.scope === scope;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    els.scopeHint.innerHTML = SCOPE_HINTS[scope];

    els.colorField.hidden = !isColor;
    els.despillField.hidden = !isColor;

    const hex = `#${s.bgColor.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    els.bgSwatch.value = hex;
    els.bgValue.textContent = hex.toUpperCase();

    els.softness.value = String(Math.round(s.softness * 100));
    els.softnessValue.textContent = `${Math.round(s.softness * 100)}%`;
    els.low.value = String(Math.round(s.low * 100));
    els.lowValue.textContent = `${Math.round(s.low * 100)}%`;
    els.high.value = String(Math.round(s.high * 100));
    els.highValue.textContent = `${Math.round(s.high * 100)}%`;
    els.despill.value = String(Math.round(s.despill * 100));
    els.despillValue.textContent = `${Math.round(s.despill * 100)}%`;

    els.aiToggleRow.hidden = !item.aiAlpha;
    els.aiToggle.checked = Boolean(item.useAi);
    els.aiRunBtn.textContent = item.aiAlpha ? '重新运行 AI' : '对这张图运行';
  }

  function renderStatus(item, keyed) {
    if (!item) {
      els.stageStatus.textContent = '';
      return;
    }
    const parts = [
      `${item.source.width}×${item.source.height}`,
      item.preview !== item.source ? `预览 ${item.preview.width}×${item.preview.height}` : null,
      item.useAi && item.aiAlpha ? 'AI 抠图' : App.key.MODES[item.settings.mode].label,
      // Only when it is not the default — a status line that repeats what
      // everything is already doing stops being read.
      item.settings.scope === 'all' ? '抠全图同色' : null,
    ].filter(Boolean);

    if (keyed && keyed.stats) {
      const s = keyed.stats;
      parts.push(
        `保留 ${(s.keptRatio * 100).toFixed(1)}%`,
        `半透明 ${((s.partial / s.total) * 100).toFixed(1)}%`
      );
    }
    els.stageStatus.textContent = parts.join('   ·   ');
  }

  function render() {
    const item = App.state.selectedItem(state);

    renderItemList();
    els.keyBlock.hidden = !item;
    els.scopeBlock.hidden = !item;
    els.levelBlock.hidden = !item;
    els.aiBlock.hidden = !state.items.length;
    els.stageHint.hidden = state.items.length > 0;
    els.plate.hidden = !item;
    els.exportBtn.disabled = !state.items.length || Boolean(state.busy);

    for (const button of document.querySelectorAll('.view-switch button')) {
      const active = button.dataset.view === state.view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    for (const button of document.querySelectorAll('.backdrop-switch button')) {
      const active = button.dataset.backdrop === state.backdrop;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
    els.plate.dataset.backdrop = state.backdrop;

    if (!item) {
      renderStatus(null);
      return;
    }

    renderControls(item);
    renderVerdict(item);
    const keyed = paint(item);
    renderStatus(item, keyed);
  }

  /* ── importing ────────────────────────────────────────────────────── */

  function decode(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const full = document.createElement('canvas');
        full.width = image.naturalWidth;
        full.height = image.naturalHeight;
        const fctx = full.getContext('2d', { willReadFrequently: true });
        fctx.drawImage(image, 0, 0);
        const source = fctx.getImageData(0, 0, full.width, full.height);

        const scale = App.state.previewScale(full.width, full.height);
        let preview = source;
        if (scale < 1) {
          const small = document.createElement('canvas');
          small.width = Math.round(full.width * scale);
          small.height = Math.round(full.height * scale);
          const sctx = small.getContext('2d', { willReadFrequently: true });
          sctx.imageSmoothingQuality = 'high';
          sctx.drawImage(full, 0, 0, small.width, small.height);
          preview = sctx.getImageData(0, 0, small.width, small.height);
        }

        URL.revokeObjectURL(url);
        resolve({ name: file.name, source, preview, detection: App.detect.detect(preview) });
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`无法读取 ${file.name}`));
      };
      image.src = url;
    });
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;

    const results = await Promise.allSettled(files.map(decode));
    const loaded = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results.length - loaded.length;

    if (loaded.length) setState(App.state.addItems(state, loaded));
    if (failed) els.stageStatus.textContent = `${failed} 个文件无法读取，已跳过`;
  }

  /* ── AI layer ─────────────────────────────────────────────────────── */

  async function refreshAiState() {
    const can = App.ai.support();
    if (!can.ok) {
      els.aiState.textContent = '不可用';
      els.aiState.classList.remove('ready');
      els.aiRunBtn.disabled = true;
      els.aiRemoveBtn.hidden = true;
      els.aiHint.innerHTML =
        `<strong>这台机器上跑不了。</strong>${can.reason}<br />` +
        `纯色背景的图仍然可以用上面的方式抠，不受影响。`;
      return false;
    }

    const installed = await App.ai.isInstalled();
    els.aiState.textContent = installed ? '已安装' : '未安装';
    els.aiState.classList.toggle('ready', installed);
    els.aiRemoveBtn.hidden = !installed;
    els.aiRunBtn.disabled = false;
    return installed;
  }

  async function runAi() {
    const item = App.state.selectedItem(state);
    if (!item || state.busy) return;

    const can = App.ai.support();
    if (!can.ok) {
      window.alert(can.reason);
      return;
    }

    const installed = await App.ai.isInstalled();
    if (!installed) {
      const size = App.ai.formatBytes(App.ai.MODEL.approxBytes);
      const ok = window.confirm(
        `AI 抠图需要先下载模型：\n\n${App.ai.MODEL.label}，约 ${size}\n\n` +
          `只下载这一次，之后存在本机、离线可用。\n` +
          `需要 WebGPU 和约 1GB 显存。\n\n现在下载吗？`
      );
      if (!ok) return;
    }

    setState({ ...state, busy: 'ai' });
    els.aiProgress.hidden = false;
    els.aiProgressFill.style.width = '0%';
    els.aiProgressLabel.textContent = installed ? '加载模型…' : '下载模型…';
    els.aiRunBtn.disabled = true;

    try {
      const alpha = await App.ai.segment(item.preview, (received, total) => {
        const pct = Math.round((received / total) * 100);
        els.aiProgressFill.style.width = `${pct}%`;
        els.aiProgressLabel.textContent =
          `下载模型 ${App.ai.formatBytes(received)} / ${App.ai.formatBytes(total)}`;
      });

      els.aiProgressFill.style.width = '100%';
      els.aiProgressLabel.textContent = '完成';
      setState(
        App.state.updateItem({ ...state, busy: null }, item.id, { aiAlpha: alpha, useAi: true })
      );
      await refreshAiState();
      setTimeout(() => {
        els.aiProgress.hidden = true;
      }, 1200);
    } catch (error) {
      els.aiProgressLabel.textContent = `失败：${error.message}`;
      setState({ ...state, busy: null });
    } finally {
      els.aiRunBtn.disabled = false;
    }
  }

  /* ── export ───────────────────────────────────────────────────────── */

  /**
   * How close the compressed file has to stay to the keyed result.
   *
   * A cut-out is the case palette compression was made for — flat artwork,
   * large uniform regions, and a subject sitting on nothing at all — so the
   * default sits where the saving is large and the search still refuses to
   * touch anything visible. See compress.js for how the descent works.
   */
  const MIN_SSIM = 0.99;

  /** Key an item at full resolution — the preview raster is never exported. */
  function keyFull(item) {
    if (item.useAi && item.aiAlpha) {
      // The mask was computed on the preview; rescale it to the source.
      const alpha =
        item.preview === item.source
          ? item.aiAlpha
          : rescaleAlpha(item.aiAlpha, item.preview, item.source);
      return App.ai.applyAlpha(item.source, alpha, {
        low: item.settings.low,
        high: item.settings.high,
        scope: item.settings.scope,
      });
    }
    return App.key.key(item.source, item.settings).data;
  }

  function rescaleAlpha(alpha, from, to) {
    const src = document.createElement('canvas');
    src.width = from.width;
    src.height = from.height;
    const sctx = src.getContext('2d');
    const img = sctx.createImageData(from.width, from.height);
    for (let i = 0; i < alpha.length; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = alpha[i];
      img.data[i * 4 + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);

    const dst = document.createElement('canvas');
    dst.width = to.width;
    dst.height = to.height;
    const dctx = dst.getContext('2d', { willReadFrequently: true });
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(src, 0, 0, to.width, to.height);

    const scaled = dctx.getImageData(0, 0, to.width, to.height);
    const out = new Uint8ClampedArray(to.width * to.height);
    for (let i = 0; i < out.length; i++) out[i] = scaled.data[i * 4];
    return out;
  }

  /** One row per file: what the search settled on, and what it saved. */
  function renderExportLog(entries) {
    const rows = entries.map((entry) => {
      const knob =
        entry.quality !== null
          ? `q${Math.round(entry.quality * 100)}`
          : entry.colors
            ? `${entry.colors} 色`
            : '无损';
      const saved = 1 - entry.size / entry.before;
      return (
        `<div class="row"><span>${entry.name}</span>` +
        `<span>${knob} · ${App.ai.formatBytes(entry.size)} ` +
        `<span class="saved">−${(saved * 100).toFixed(0)}%</span></span></div>`
      );
    });

    const total = entries.reduce((sum, e) => sum + e.size, 0);
    const before = entries.reduce((sum, e) => sum + e.before, 0);
    rows.push(
      `<div class="row total"><span>${entries.length} 个文件</span>` +
        `<span>${App.ai.formatBytes(total)} ` +
        `<span class="saved">−${((1 - total / before) * 100).toFixed(0)}%</span></span></div>`
    );

    els.exportLog.innerHTML = rows.join('');
    els.exportLog.hidden = false;
  }

  async function runExport() {
    if (!state.items.length || state.busy) return;

    setState({ ...state, busy: 'export' });
    els.progress.hidden = false;
    els.exportLog.hidden = true;
    els.progressFill.style.width = '0%';

    const mime = els.formatSelect.value;
    const extension = mime === 'image/webp' ? 'webp' : 'png';
    const entries = [];
    const taken = new Set();

    try {
      for (let i = 0; i < state.items.length; i++) {
        const item = state.items[i];
        els.progressFill.style.width = `${Math.round((i / state.items.length) * 100)}%`;
        els.progressLabel.textContent = `处理 ${i + 1}/${state.items.length} · ${item.name}`;
        await new Promise((r) => setTimeout(r, 0));

        const keyed = keyFull(item);
        const canvas = document.createElement('canvas');
        canvas.width = keyed.width;
        canvas.height = keyed.height;
        canvas.getContext('2d').putImageData(keyed, 0, 0);

        // Baseline is what a plain canvas encode would have produced, so the
        // saving reported below is measured against the naive export.
        const original = await App.compress.encode(canvas, mime, 1.0);
        const result = await App.compress.squeeze(canvas, mime, { minSsim: MIN_SSIM });
        const blob = result.blob;

        const stem = item.name.replace(/\.[^.]+$/, '').replace(/[\/\\:*?"<>|]/g, '_') || 'image';
        let name = `${stem}.${extension}`;
        let n = 2;
        while (taken.has(name)) name = `${stem}-${n++}.${extension}`;
        taken.add(name);

        entries.push({
          name,
          bytes: new Uint8Array(await blob.arrayBuffer()),
          size: blob.size,
          before: original.size,
          quality: result.quality,
          colors: result.colors ?? null,
        });
      }

      els.progressFill.style.width = '100%';
      const zip = App.zip.build(entries);
      els.progressLabel.textContent = `完成 · ${App.ai.formatBytes(zip.size)}`;

      renderExportLog(entries);

      const url = URL.createObjectURL(zip);
      const a = document.createElement('a');
      a.href = url;
      a.download = `matte-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (error) {
      els.progressLabel.textContent = `导出失败：${error.message}`;
    } finally {
      setState({ ...state, busy: null });
    }
  }

  /* ── controls ─────────────────────────────────────────────────────── */

  function settingsChange(changes) {
    const item = App.state.selectedItem(state);
    if (item) setState(App.state.updateSettings(state, item.id, changes));
  }

  function bind() {
    els.importBtn.addEventListener('click', () => els.fileInput.click());
    els.fileInput.addEventListener('change', (e) => {
      importFiles(e.target.files);
      e.target.value = '';
    });

    for (const button of document.querySelectorAll('.view-switch button')) {
      button.addEventListener('click', () => setState({ ...state, view: button.dataset.view }));
    }
    for (const button of document.querySelectorAll('.backdrop-switch button')) {
      button.addEventListener('click', () =>
        setState({ ...state, backdrop: button.dataset.backdrop })
      );
    }
    for (const button of document.querySelectorAll('.mode-switch button')) {
      button.addEventListener('click', () => settingsChange({ mode: button.dataset.mode }));
    }
    for (const button of document.querySelectorAll('.scope-switch button')) {
      button.addEventListener('click', () => settingsChange({ scope: button.dataset.scope }));
    }

    els.bgSwatch.addEventListener('input', () => {
      const hex = els.bgSwatch.value;
      settingsChange({
        bgColor: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
      });
    });

    els.pickBtn.addEventListener('click', () => {
      picking = !picking;
      els.pickBtn.setAttribute('aria-pressed', String(picking));
      els.plate.classList.toggle('picking', picking);
    });

    els.canvas.addEventListener('click', (event) => {
      if (!picking) return;
      const item = App.state.selectedItem(state);
      if (!item) return;
      const rect = els.canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * item.preview.width;
      const y = ((event.clientY - rect.top) / rect.height) * item.preview.height;
      const colour = App.detect.sampleAt(item.preview, x, y);

      picking = false;
      els.pickBtn.setAttribute('aria-pressed', 'false');
      els.plate.classList.remove('picking');
      settingsChange({ mode: 'color', bgColor: colour });
    });

    const sliders = [
      [els.softness, 'softness'],
      [els.low, 'low'],
      [els.high, 'high'],
      [els.despill, 'despill'],
    ];
    for (const [el, keyName] of sliders) {
      el.addEventListener('input', () => settingsChange({ [keyName]: Number(el.value) / 100 }));
    }

    els.applyAllBtn.addEventListener('click', () => setState(App.state.applySettingsToAll(state)));

    els.aiRunBtn.addEventListener('click', runAi);
    els.aiToggle.addEventListener('change', () => {
      const item = App.state.selectedItem(state);
      if (item) setState(App.state.updateItem(state, item.id, { useAi: els.aiToggle.checked }));
    });
    els.aiRemoveBtn.addEventListener('click', async () => {
      if (!window.confirm('删除已下载的模型？下次使用需要重新下载。')) return;
      await App.ai.uninstall();
      await refreshAiState();
    });

    els.exportBtn.addEventListener('click', runExport);

    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      els.dropVeil.hidden = false;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (!depth) els.dropVeil.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      els.dropVeil.hidden = true;
      if (e.dataTransfer && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
    });
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
  /**
   * Backspace and Delete remove the selected image.
   *
   * The row already has an X button; this is for the hand that is on the
   * keyboard, and Backspace is the key people reach for. Both are bound because
   * a Mac keyboard often has no Delete at all.
   *
   * Guarded on focus: inside a text or number field these keys mean "erase a
   * character", and stealing them there would make the inputs unusable.
   */
  function bindKeys() {
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const item = App.state.selectedItem(state);
      if (!item || state.busy) return;

      // Backspace navigates back in some browser configurations.
      event.preventDefault();
      setState(App.state.removeItem(state, item.id));
    });
  }

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

  function init() {
    bind();
    bindClipboard();
    bindKeys();
    refreshAiState();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  App.main = { getState: () => state, setState };
})((window.App = window.App || {}));
