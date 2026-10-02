/**
 * Export: render each visible layer at canvas size, squeeze it, pack the ZIP.
 *
 * The squeeze itself — how far each image can be compressed before the damage
 * would show — lives in compress.js, which the other tools on the rack share.
 * What is specific to this tool is here: rendering a layer in isolation,
 * naming the files, and reporting what the search decided.
 */
(function (App) {
  'use strict';

  const { FORMATS, encode, formatBytes, squeeze } = App.compress;

  function sanitizeName(name) {
    return name.replace(/\.[^.]+$/, '').replace(/[\/\\:*?"<>|]/g, '_') || 'layer';
  }

  /** Disambiguate repeats so a ZIP never carries two identical paths. */
  function uniqueName(base, extension, taken) {
    let candidate = `${base}.${extension}`;
    let counter = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${counter++}.${extension}`;
    }
    taken.add(candidate);
    return candidate;
  }

  async function blobToBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  /**
   * Export every visible layer.
   *
   * @param {object} state
   * @param {(done: number, total: number, label: string) => void} onProgress
   * @returns {{zip: Blob, entries: object[]}}
   */
  async function exportAll(state, onProgress) {
    const format = FORMATS[state.exportFormat];
    const layers = state.layers.filter((layer) => layer.visible);
    if (!layers.length) {
      throw new Error('No visible layers to export');
    }

    // JPEG has no alpha channel; without a fill, transparent areas turn black
    // in most decoders. White matches what a browser would show.
    const background = format.alpha ? null : '#ffffff';

    const taken = new Set();
    const entries = [];

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (onProgress) onProgress(i, layers.length, layer.name);

      const canvas = App.render.renderLayerForExport(layer, state.canvas, background);
      // Baseline is a plain maximum-quality encode, so the reported saving is
      // measured against what a naive export would have produced.
      const original = await encode(canvas, state.exportFormat, 1.0);
      const result = await squeeze(canvas, state.exportFormat, {
        minSsim: state.minSsim,
        sizeThreshold: state.exportThreshold,
        minAbsoluteSaving: state.exportMinSaving ?? App.compress.MIN_ABSOLUTE_SAVING,
      });

      entries.push({
        name: uniqueName(sanitizeName(layer.name), format.extension, taken),
        bytes: await blobToBytes(result.blob),
        quality: result.quality,
        colors: result.colors ?? null,
        ssim: result.ssim,
        stoppedBy: result.stoppedBy,
        bytes_at_max: original.size,
        finalBytes: result.blob.size,
        steps: result.trail.length,
        layerName: layer.name,
      });

      // Let the progress bar actually paint between images.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (onProgress) onProgress(layers.length, layers.length, 'packing');
    return { zip: App.zip.build(entries), entries };
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoking immediately can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  App.exporter = {
    FORMATS,
    download,
    exportAll,
    formatBytes,
    sanitizeName,
    uniqueName,
  };
})((window.App = window.App || {}));
