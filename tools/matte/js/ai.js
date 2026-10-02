/**
 * The optional AI layer — BiRefNet, fetched on demand.
 *
 * Deliberately not shipped with the repository. Most work here is on flat
 * plates, which the unmixer handles exactly and instantly; making everyone
 * carry half a gigabyte for the minority case is the wrong default. So the
 * model is downloaded the first time someone actually asks for it, cached, and
 * from then on works offline like everything else.
 *
 * The runtime comes from a CDN via a <script> tag rather than `fetch`: a
 * file:// page has a null origin, so a cross-origin fetch of the runtime would
 * be blocked, while classic script tags are not subject to that check. The
 * model weights still go through fetch, which is why availability is probed
 * before anything is promised to the user.
 */
(function (App) {
  'use strict';

  /*
   * The WebGPU bundle specifically. `ort.min.js` ships wasm only, so asking it
   * for a webgpu provider fails with "backend not found".
   *
   * WebGPU is not an optimisation here, it is the requirement. This model has a
   * fixed 1024x1024 input, and its activations at that size exceed what the
   * wasm heap can hold — the wasm path aborts with an allocation failure rather
   * than running slowly. Measured, not assumed.
   */
  const RUNTIME_URL =
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.webgpu.min.js';
  const RUNTIME_WASM_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';

  /**
   * The lite variant at half precision. The full model is ~940 MB and better on
   * hair, but this is the difference between a download people accept and one
   * they abandon; the flat-plate path already covers the cases where that extra
   * fidelity would matter most.
   */
  const MODEL = Object.freeze({
    id: 'birefnet-lite-fp16',
    label: 'BiRefNet lite (fp16)',
    url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx',
    approxBytes: 111 * 1024 * 1024,
    /** The resolution BiRefNet was trained at; input is letterboxed to it. */
    inputSize: 1024,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
  });

  const DB_NAME = 'matte-models';
  const STORE = 'files';

  /* ── cache ────────────────────────────────────────────────────────── */

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbGet(key) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readonly');
          const request = tx.objectStore(STORE).get(key);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error);
        })
    );
  }

  function idbPut(key, value) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(value, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        })
    );
  }

  function idbDelete(key) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        })
    );
  }

  /** Whether the weights are already on this machine. */
  async function isInstalled() {
    try {
      return Boolean(await idbGet(MODEL.id));
    } catch {
      return false;
    }
  }

  async function uninstall() {
    await idbDelete(MODEL.id);
  }

  /* ── download ─────────────────────────────────────────────────────── */

  /**
   * Fetch the weights, reporting progress.
   *
   * Streams rather than awaiting `arrayBuffer()` so the progress bar reflects
   * reality — on a slow line a hundred-megabyte download with no feedback is
   * indistinguishable from a hang.
   */
  async function download(onProgress) {
    const response = await fetch(MODEL.url);
    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }

    const total = Number(response.headers.get('content-length')) || MODEL.approxBytes;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress) onProgress(received, total);
    }

    const buffer = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }

    await idbPut(MODEL.id, buffer);
    return buffer;
  }

  /* ── runtime ──────────────────────────────────────────────────────── */

  let runtimePromise = null;

  function loadRuntime() {
    if (window.ort) return Promise.resolve(window.ort);
    if (runtimePromise) return runtimePromise;

    runtimePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = RUNTIME_URL;
      script.onload = () => {
        if (!window.ort) {
          reject(new Error('运行时加载了但没有初始化'));
          return;
        }
        window.ort.env.wasm.wasmPaths = RUNTIME_WASM_BASE;
        resolve(window.ort);
      };
      script.onerror = () => reject(new Error('无法加载 ONNX 运行时，请检查网络'));
      document.head.appendChild(script);
    });
    return runtimePromise;
  }

  /* ── inference ────────────────────────────────────────────────────── */

  let session = null;

  /**
   * Whether this browser can host the model at all.
   *
   * Checked before anything is downloaded — asking someone to pull 109 MB and
   * only then discovering their browser cannot run it is the worst possible
   * ordering.
   */
  function support() {
    if (!window.isSecureContext && location.protocol !== 'file:') {
      return { ok: false, reason: 'WebGPU 需要安全上下文（https 或本地文件）' };
    }
    if (!navigator.gpu) {
      return {
        ok: false,
        reason:
          '这个浏览器没有 WebGPU。模型固定 1024×1024 输入，' +
          '纯 CPU（wasm）后端装不下它的中间结果，所以无法降级运行。',
      };
    }
    return { ok: true };
  }

  async function getSession(onProgress) {
    if (session) return session;

    const can = support();
    if (!can.ok) throw new Error(can.reason);

    const ort = await loadRuntime();
    let weights = await idbGet(MODEL.id);
    if (!weights) weights = await download(onProgress);

    try {
      session = await ort.InferenceSession.create(weights, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
    } catch (error) {
      throw new Error(`模型加载失败：${describeFailure(error)}`);
    }
    return session;
  }

  /**
   * Turn ONNX Runtime's failures into something actionable.
   *
   * It reports out-of-memory as a bare allocation size — a number like
   * "252472736" with no context, which tells the user nothing about what went
   * wrong or what to do next.
   */
  function describeFailure(error) {
    const raw = String((error && error.message) || error);
    if (/^\d+$/.test(raw.trim())) {
      const mb = (Number(raw) / 1048576).toFixed(0);
      return `显存不足（需要约 ${mb} MB）。关掉其他标签页再试，或改用纯色背景抠图。`;
    }
    if (/backend not found/i.test(raw)) {
      return 'WebGPU 后端不可用，请确认浏览器已启用 WebGPU。';
    }
    if (/invalid dimensions/i.test(raw)) {
      return '输入尺寸与模型不符（这是程序缺陷，请反馈）。';
    }
    return raw.slice(0, 160);
  }

  /**
   * Letterbox an image into the model's square input, preserving aspect.
   *
   * Squashing to a square instead would distort the subject and the mask would
   * come back distorted with it.
   */
  function toInputTensor(ort, image, size) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const scale = Math.min(size / image.width, size / image.height);
    const w = Math.round(image.width * scale);
    const h = Math.round(image.height * scale);
    const dx = Math.floor((size - w) / 2);
    const dy = Math.floor((size - h) / 2);

    const staging = document.createElement('canvas');
    staging.width = image.width;
    staging.height = image.height;
    staging.getContext('2d').putImageData(image, 0, 0);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(staging, dx, dy, w, h);

    const { data } = ctx.getImageData(0, 0, size, size);
    const tensor = new Float32Array(3 * size * size);
    const plane = size * size;

    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      tensor[p] = (data[i] / 255 - MODEL.mean[0]) / MODEL.std[0];
      tensor[plane + p] = (data[i + 1] / 255 - MODEL.mean[1]) / MODEL.std[1];
      tensor[2 * plane + p] = (data[i + 2] / 255 - MODEL.mean[2]) / MODEL.std[2];
    }

    return {
      tensor: new ort.Tensor('float32', tensor, [1, 3, size, size]),
      box: { dx, dy, w, h },
    };
  }

  /** Crop the letterbox back off and resample the mask to the source size. */
  function maskToAlpha(mask, size, box, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(size, size);

    for (let i = 0; i < size * size; i++) {
      const v = Math.round(Math.min(1, Math.max(0, mask[i])) * 255);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const outCtx = out.getContext('2d', { willReadFrequently: true });
    outCtx.imageSmoothingQuality = 'high';
    outCtx.drawImage(canvas, box.dx, box.dy, box.w, box.h, 0, 0, width, height);

    const scaled = outCtx.getImageData(0, 0, width, height);
    const alpha = new Uint8ClampedArray(width * height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = scaled.data[i * 4];
    return alpha;
  }

  /**
   * Run the model over an image.
   * @returns {Uint8ClampedArray} one alpha byte per pixel
   */
  async function segment(image, onProgress) {
    const ort = await loadRuntime();
    const runner = await getSession(onProgress);
    const { tensor, box } = toInputTensor(ort, image, MODEL.inputSize);

    const feeds = { [runner.inputNames[0]]: tensor };
    let results;
    try {
      results = await runner.run(feeds);
    } catch (error) {
      throw new Error(describeFailure(error));
    }

    // This export emits a single refined map; take the last name regardless so
    // a multi-output build still works.
    const names = runner.outputNames;
    const output = results[names[names.length - 1]];

    return maskToAlpha(output.data, MODEL.inputSize, box, image.width, image.height);
  }

  /** Apply a model alpha to an image, unpremultiplied against a known backdrop. */
  function applyAlpha(image, alpha, options = {}) {
    const { low = 0.02, high = 0.98, bgColor = null, scope = 'outside' } = options;
    const src = image.data;
    const out = new Uint8ClampedArray(src.length);

    // The model has its own opinion about what the subject is, but it produces
    // a soft map, not a watertight one — a dark eye socket comes back as a
    // low-confidence dip in the middle of a confident subject. Same treatment
    // as the colour keyer: a dip the frame edge cannot reach is not background.
    const mask =
      scope === 'all'
        ? alpha
        : App.key.sealEnclosed(alpha, image.width, image.height, { opaque: 255 });

    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
      let a = App.key.levels(mask[p] / 255, low, high);
      if (src[i + 3] < 255) a *= src[i + 3] / 255;

      if (a <= 0) {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
        continue;
      }

      if (bgColor) {
        out[i] = App.key.unmix(src[i], a, bgColor[0]);
        out[i + 1] = App.key.unmix(src[i + 1], a, bgColor[1]);
        out[i + 2] = App.key.unmix(src[i + 2], a, bgColor[2]);
      } else {
        out[i] = src[i];
        out[i + 1] = src[i + 1];
        out[i + 2] = src[i + 2];
      }
      out[i + 3] = Math.round(a * 255);
    }

    return new ImageData(out, image.width, image.height);
  }

  function formatBytes(size) {
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  App.ai = {
    MODEL,
    applyAlpha,
    describeFailure,
    support,
    download,
    formatBytes,
    isInstalled,
    loadRuntime,
    maskToAlpha,
    segment,
    uninstall,
  };
})((window.App = window.App || {}));
