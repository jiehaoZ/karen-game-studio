/**
 * Compression search: squeeze one canvas as far as it will go without showing.
 *
 * The search walks a quality axis downward and stops at the last setting whose
 * output is still visually indistinguishable from the source.
 *
 * It does not stop on file size, because that rule has no stopping point.
 * Measured on real content, every 5-point quality drop still removes 7-15% of
 * the file all the way to the bottom of the usable range — the size curve
 * never flattens, so a size-only rule just bottoms out at whatever floor it is
 * handed, at whatever quality that happens to be. SSIM against the original
 * gives the search something real to stop at: compress until it would start to
 * show, then back off one step.
 *
 * The size threshold is kept as a secondary brake for content that genuinely
 * does flatten out, such as flat-colour artwork. It is two tests, not one — a
 * relative one and an absolute one — and the search only stops once both agree
 * there is nothing left to win; see MIN_ABSOLUTE_SAVING.
 *
 * ## Two axes, one stopping rule
 *
 * WebP and JPEG have a quality knob, so the axis is quality. PNG does not —
 * but "PNG is lossless, so there is nothing to search" was wrong, and it was
 * the single biggest thing this tool got wrong. A canvas always hands back
 * 32-bit truecolour, and for the artwork these tools produce that is the wrong
 * container by a factor of three or four: one real export was a 512x512 sprite
 * built from 18 distinct colours, stored in 92,649 bytes. The axis PNG has is
 * *palette size*, and walking it down is exactly what every "PNG compressor"
 * on the web is doing to get the numbers it advertises.
 *
 * So both formats run the same descent under the same similarity floor. Only
 * the knob differs — see findQualityKnee and findPaletteKnee.
 *
 * This file is shared verbatim between the tools on the rack, the same way
 * zip.js is. Each tool directory stays runnable on its own from file://, which
 * is worth more here than removing the duplication.
 */
(function (App) {
  'use strict';

  // Quality 100 is not a useful starting point: on lossy codecs it disables
  // most of the quantisation and inflates files several-fold for a difference
  // no measurement can find. The search starts one step below it.
  const QUALITY_CEILING = 0.95;
  const QUALITY_FLOOR = 0.3;
  const QUALITY_STEP = 0.05;

  /** SSIM below this counts as visible damage. */
  const DEFAULT_MIN_SSIM = 0.99;

  /**
   * Smallest per-step gain worth another round of compression, in bytes.
   *
   * The relative brake alone gives up too early on the files where there is
   * still real money on the table: at 0.5%, a 400 KB layer halts on a rung that
   * just shed 1.9 KB, because 1.9 KB happens to be 0.47% of it. Nobody
   * exporting sprite sheets considers 1.9 KB per file a rounding error.
   *
   * So the search keeps stepping while *either* brake still sees progress, and
   * only stops once a step gains less than this AND less than sizeThreshold —
   * that is, once compressing again is not worth the round trip. Keeping the
   * relative test in the disjunction is what protects small files: on a 6 KB
   * icon no single rung will ever gain a kilobyte, and an absolute-only rule
   * would stop the descent on its first step.
   */
  const MIN_ABSOLUTE_SAVING = 1024;

  /**
   * Whether another round of compression is still buying anything.
   *
   * @param {number} bestSize bytes of the best result so far
   * @param {number} candidateSize bytes of the step just measured
   * @param {{sizeThreshold: number, minAbsoluteSaving: number}} settings
   */
  function worthAnotherRound(bestSize, candidateSize, settings) {
    const saved = bestSize - candidateSize;
    return saved >= settings.minAbsoluteSaving || saved / bestSize >= settings.sizeThreshold;
  }

  /**
   * Palette sizes the PNG search walks, largest first.
   *
   * Spaced roughly geometrically because that is how the size curve behaves —
   * the step from 256 to 192 buys about as much as the step from 32 to 24. The
   * rungs below 16 exist for flat artwork, where two or four colours is the
   * honest answer and the bit-depth drop that comes with it (8 bits per pixel
   * down to 1) is worth more than anything deflate can do.
   */
  const PALETTE_LADDER = Object.freeze([
    256, 192, 128, 96, 64, 48, 32, 24, 16, 12, 8, 6, 4, 3, 2,
  ]);

  /** A palette index is one byte, so no image can carry more entries. */
  const MAX_PALETTE = 256;

  /**
   * How far a pixel's transparency may move, and how much of the image is
   * allowed to be worse than that.
   *
   * This exists because SSIM cannot see the failure it prevents, and that is
   * worth spelling out rather than discovering again later.
   *
   * A palette has 256 entries to spend on colour *and* alpha together. A
   * cut-out with a soft edge arrives with something like 254 distinct alpha
   * levels; measured on real exports, the palette search was landing on rungs
   * that left four, turning an anti-aliased rim into a stair-step — while SSIM
   * reported 0.9925 and waved it through. That is not a bug in the
   * implementation, it is what SSIM measures: inside an 8x8 window a
   * quantisation step in a smooth ramp looks like a small constant offset, and
   * SSIM is deliberately built to ignore those. No threshold on it would have
   * caught this, so the constraint is stated directly instead.
   *
   * A percentile rather than the maximum, because the maximum is decided by a
   * handful of outlier pixels: on one real export the worst pixel moved by 29
   * while the 99.9th percentile moved by 5, and rejecting that palette would
   * have thrown away a 4.7x saving to protect a few dozen pixels nobody can
   * find.
   */
  const MAX_ALPHA_DRIFT = 16;
  const ALPHA_DRIFT_PERCENTILE = 0.999;

  /**
   * The same bound for someone who asked for the smallest file.
   *
   * 16 is a conservative number, and on a soft-edged subject it — not SSIM —
   * is what ends the descent: on a real 256x256 export the search stopped at
   * 32 colours with the rim still drifting only 15, while every rung below it
   * was rejected on drift alone at similarity scores above 0.99.
   *
   * The reference point for "how much drift do people actually accept" is
   * tinypng.com, which is what this is measured against: its output for that
   * same image drifts 27 at the same percentile, and nobody files bugs about
   * it. So the strict presets keep 16, and the preset that says "smallest
   * file" is allowed past it — up to a bound that is still under what the
   * industry tool ships.
   */
  const RELAXED_ALPHA_DRIFT = 32;

  /** Preset at or below this similarity floor counts as "smallest file". */
  const RELAXED_SSIM = 0.96;

  /** Drift bound implied by the similarity floor the user chose. */
  function maxAlphaDriftFor(minSsim) {
    return minSsim <= RELAXED_SSIM ? RELAXED_ALPHA_DRIFT : MAX_ALPHA_DRIFT;
  }

  /**
   * Above this share of partially transparent pixels, the image is treated as a
   * gradient and left as truecolour.
   *
   * The drift bound above catches a ramp whose *steps* are too tall. It cannot
   * catch a ramp with many small steps, because there is no such thing as a
   * large per-pixel error there: 46 levels spread over a full fade is a step of
   * 5.5, well inside any sane tolerance, and it still shows — as concentric
   * bands rather than as a hard edge. Banding is a property of the gradient, not
   * of any one pixel, which is why neither SSIM nor a per-pixel bound reports it.
   *
   * What separates the two cases cleanly is how much of the frame is actually
   * translucent. Measured across real exports: an anti-aliased sprite is 0.6-3%
   * partially transparent, because the ramp is a rim one or two pixels wide. A
   * genuine soft subject — a radial fade, smoke, hair — runs above 40%. There is
   * more than an order of magnitude between them, so the threshold does not have
   * to be clever.
   *
   * The rule that falls out: when the ramp *is* the subject, a 256-entry palette
   * shared between colour and alpha cannot hold it, and the honest answer is not
   * to try. Those images are also the ones where quantisation saves least, so
   * little is given up.
   */
  const MAX_SOFT_SHARE = 0.15;

  const FORMATS = Object.freeze({
    'image/webp': { extension: 'webp', lossy: true, alpha: true, label: 'WebP' },
    'image/jpeg': { extension: 'jpg', lossy: true, alpha: false, label: 'JPEG' },
    'image/png': { extension: 'png', lossy: false, alpha: true, label: 'PNG' },
  });

  function encode(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error(`${mime} encoding failed`))),
        mime,
        quality
      );
    });
  }

  /** Pixels of an encoded blob, for comparing against the source. */
  async function decodeToImageData(blob, width, height) {
    const bitmap = await createImageBitmap(blob);
    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return ctx.getImageData(0, 0, width, height);
  }

  /**
   * Walk quality down and keep the lowest setting that still looks identical.
   *
   * Stops on whichever comes first: SSIM dropping below `minSsim`, the size
   * curve flattening past both brakes (see worthAnotherRound), or the quality
   * floor.
   *
   * @returns {{blob, quality, ssim, trail, stoppedBy}}
   */
  async function findQualityKnee(canvas, mime, options, onProgress) {
    const settings = {
      sizeThreshold: 0.005,
      minAbsoluteSaving: MIN_ABSOLUTE_SAVING,
      minSsim: DEFAULT_MIN_SSIM,
      // Injectable so tests can drive the search with a declared similarity
      // curve instead of a real decoder.
      decode: decodeToImageData,
      measure: (reference, candidate) => App.ssim.compare(reference, candidate),
      ...options,
    };
    const { decode, measure } = settings;

    const reference = canvas
      .getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, canvas.width, canvas.height);

    let best = await encode(canvas, mime, QUALITY_CEILING);
    let bestQuality = QUALITY_CEILING;
    let bestSsim = 1;
    let stoppedBy = 'floor';
    const trail = [];

    for (let q = QUALITY_CEILING; q >= QUALITY_FLOOR - 1e-9; q -= QUALITY_STEP) {
      const quality = Math.round(q * 100) / 100;
      const candidate =
        quality === QUALITY_CEILING ? best : await encode(canvas, mime, quality);
      const pixels = await decode(candidate, canvas.width, canvas.height);
      const ssim = measure(reference, pixels);

      trail.push({ quality, bytes: candidate.size, ssim });
      if (onProgress) onProgress(quality, candidate.size, ssim);

      if (ssim < settings.minSsim) {
        if (trail.length === 1) {
          // Even the ceiling misses the bar. There is nothing better to fall
          // back to, so return it and report the similarity actually measured
          // rather than the unmeasured 1.0 the search started from.
          return { blob: candidate, quality, ssim, trail, stoppedBy: 'ceiling' };
        }
        // Visible damage — the previous step is as far as this can go.
        return { blob: best, quality: bestQuality, ssim: bestSsim, trail, stoppedBy: 'quality' };
      }

      if (
        quality !== QUALITY_CEILING &&
        !worthAnotherRound(best.size, candidate.size, settings)
      ) {
        return { blob: best, quality: bestQuality, ssim: bestSsim, trail, stoppedBy: 'size' };
      }

      best = candidate;
      bestQuality = quality;
      bestSsim = ssim;
    }

    return { blob: best, quality: bestQuality, ssim: bestSsim, trail, stoppedBy };
  }

  /**
   * The pixels a decoder will produce from a palette and an index stream.
   *
   * The lossy path has to encode a candidate and decode it back to find out
   * what it did. Quantisation does not: the mapping is the loss, and the
   * result is known exactly before the file is written. Reconstructing it here
   * skips a full encode/decode round trip per rung, which is most of the cost
   * of the search.
   */
  function expandIndexed(result) {
    const { palette, indices, width, height } = result;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < indices.length; p++) {
      const from = indices[p] * 4;
      const to = p * 4;
      data[to] = palette[from];
      data[to + 1] = palette[from + 1];
      data[to + 2] = palette[from + 2];
      data[to + 3] = palette[from + 3];
    }
    return { data, width, height };
  }

  /** Share of pixels that are neither fully opaque nor fully transparent. */
  function softShare(imageData) {
    const { data } = imageData;
    let soft = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0 && data[i] < 255) soft++;
    }
    return soft / (data.length >>> 2);
  }

  /**
   * How far transparency shifted, at ALPHA_DRIFT_PERCENTILE.
   *
   * Deviations are whole numbers in 0-255, so a 256-bucket tally gives the
   * exact percentile in one pass — no sort, and no allocation per pixel.
   */
  function alphaDrift(reference, candidate, percentile = ALPHA_DRIFT_PERCENTILE) {
    const tally = new Uint32Array(256);
    const pixels = reference.data.length >>> 2;
    for (let i = 3; i < reference.data.length; i += 4) {
      tally[Math.abs(reference.data[i] - candidate.data[i])]++;
    }

    // Walk down from the worst deviation until the tail is bigger than the
    // share allowed to exceed the bound; that bucket is the percentile.
    const allowed = pixels * (1 - percentile);
    let tail = 0;
    for (let deviation = 255; deviation > 0; deviation--) {
      tail += tally[deviation];
      if (tail > allowed) return deviation;
    }
    return 0;
  }

  /**
   * Walk palette size down and keep the smallest palette that still looks
   * identical.
   *
   * Same stopping rule as the quality search, on a different knob. Two details
   * are specific to this axis:
   *
   * Rungs at or above the number of colours actually present are skipped. A
   * sprite with 18 distinct colours encodes byte-for-byte identically at 256,
   * 128 and 32, so probing all three wastes time and — worse — trips the size
   * brake on a 0% saving and halts the search before it reaches the rungs that
   * would have helped.
   *
   * The plain canvas PNG is kept as a floor. Quantisation wins overwhelmingly
   * on the flat, few-colour artwork this tool exists for, but a photographic
   * layer can genuinely be smaller stored as truecolour, and in that case the
   * lossless file is both smaller and perfect.
   *
   * @returns {{blob, colors, quality, ssim, trail, stoppedBy}}
   */
  async function findPaletteKnee(canvas, options, onProgress) {
    const settings = {
      sizeThreshold: 0.005,
      minAbsoluteSaving: MIN_ABSOLUTE_SAVING,
      minSsim: DEFAULT_MIN_SSIM,
      // Injectable so tests can drive the search with a declared size and
      // similarity curve instead of a real quantiser and encoder.
      histogram: (imageData) => App.quantize.histogram(imageData),
      quantize: (imageData, colors, opts) => App.quantize.reduce(imageData, colors, opts),
      encodeIndexed: (indexed) => App.png.encodeIndexed(indexed),
      expand: (indexed) => expandIndexed(indexed),
      measure: (reference, candidate) => App.ssim.compare(reference, candidate),
      measureAlphaDrift: (reference, candidate) => alphaDrift(reference, candidate),
      // Null rather than a number: the default depends on minSsim, which the
      // caller may also be overriding, so it cannot be resolved until both are
      // known. An explicit value still wins.
      maxAlphaDrift: null,
      measureSoftShare: (imageData) => softShare(imageData),
      maxSoftShare: MAX_SOFT_SHARE,
      ...options,
    };
    if (settings.maxAlphaDrift == null) {
      settings.maxAlphaDrift = maxAlphaDriftFor(settings.minSsim);
    }

    const context = canvas.getContext('2d', { willReadFrequently: true });
    const reference = context.getImageData(0, 0, canvas.width, canvas.height);

    const lossless = await encode(canvas, 'image/png');

    // A soft subject cannot survive a 256-entry palette; see MAX_SOFT_SHARE.
    // Checked before any quantising, because the answer does not depend on the
    // palette and probing the whole ladder to arrive here would be wasted work.
    const soft = settings.measureSoftShare(reference);
    if (soft > settings.maxSoftShare) {
      return {
        blob: lossless,
        colors: null,
        quality: null,
        ssim: 1,
        trail: [{ colors: null, bytes: lossless.size, ssim: 1, softShare: soft }],
        stoppedBy: 'soft',
      };
    }

    const histogram = settings.histogram(reference);

    const rungs = [
      ...(histogram.size <= MAX_PALETTE ? [histogram.size] : []),
      ...PALETTE_LADDER.filter((colors) => colors < histogram.size),
    ].filter((colors) => colors >= 2);

    let best = null;
    let stoppedBy = 'floor';
    const trail = [];

    for (const colors of rungs) {
      const indexed = settings.quantize(reference, colors, { histogram });
      const blob = await settings.encodeIndexed(indexed);
      const decoded = settings.expand(indexed);
      const ssim = settings.measure(reference, decoded);
      const drift = settings.measureAlphaDrift(reference, decoded);
      const candidate = { blob, colors: indexed.colors, ssim };

      trail.push({ colors: indexed.colors, bytes: blob.size, ssim, drift });
      if (onProgress) onProgress(indexed.colors, blob.size, ssim);

      // The soft edge has started to stair-step. See MAX_ALPHA_DRIFT — this is
      // the failure SSIM is structurally unable to report.
      if (drift > settings.maxAlphaDrift) {
        if (!best) {
          return {
            blob: lossless,
            colors: null,
            quality: null,
            ssim: 1,
            trail,
            stoppedBy: 'lossless',
          };
        }
        stoppedBy = 'alpha';
        break;
      }

      if (ssim < settings.minSsim) {
        // Visible damage. If even the first rung misses the bar, there is no
        // earlier step to fall back to — but there is still the lossless file,
        // which is always perfect, so that becomes the answer.
        if (!best) {
          return {
            blob: lossless,
            colors: null,
            quality: null,
            ssim: 1,
            trail,
            stoppedBy: 'lossless',
          };
        }
        stoppedBy = 'quality';
        break;
      }

      if (best && !worthAnotherRound(best.blob.size, blob.size, settings)) {
        stoppedBy = 'size';
        break;
      }

      best = candidate;
    }

    if (!best || lossless.size <= best.blob.size) {
      return {
        blob: lossless,
        colors: null,
        quality: null,
        ssim: 1,
        trail,
        stoppedBy: 'lossless',
      };
    }

    return {
      blob: best.blob,
      colors: best.colors,
      quality: null,
      ssim: best.ssim,
      trail,
      stoppedBy,
    };
  }

  /** Dispatch to whichever search fits the format's compression knob. */
  function squeeze(canvas, mime, options, onProgress) {
    return FORMATS[mime].lossy
      ? findQualityKnee(canvas, mime, options, onProgress)
      : findPaletteKnee(canvas, options, onProgress);
  }

  function formatBytes(size) {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  }

  App.compress = {
    ALPHA_DRIFT_PERCENTILE,
    DEFAULT_MIN_SSIM,
    MAX_ALPHA_DRIFT,
    MAX_SOFT_SHARE,
    MIN_ABSOLUTE_SAVING,
    RELAXED_ALPHA_DRIFT,
    RELAXED_SSIM,
    FORMATS,
    MAX_PALETTE,
    PALETTE_LADDER,
    QUALITY_CEILING,
    QUALITY_FLOOR,
    QUALITY_STEP,
    alphaDrift,
    decodeToImageData,
    encode,
    expandIndexed,
    findPaletteKnee,
    findQualityKnee,
    formatBytes,
    maxAlphaDriftFor,
    softShare,
    squeeze,
    worthAnotherRound,
  };
})((window.App = window.App || {}));
