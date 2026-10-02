/**
 * Reading the backdrop off an image, and judging whether it is one at all.
 *
 * Two jobs, and the second is the more useful of the pair. Picking the mode
 * saves a few clicks; deciding that the border *isn't* a flat colour is what
 * stops someone spending ten minutes fighting sliders on a photograph that
 * unmixing was never going to handle. That verdict is what routes the image to
 * the model instead.
 */
(function (App) {
  'use strict';

  /** Fraction of the shorter edge sampled as "border". */
  const BORDER_FRACTION = 0.06;
  const MIN_BORDER = 2;

  /** Channel spread, 0-1, above which the border stops counting as flat. */
  const FLATNESS_LIMIT = 0.055;

  /** How close to 0 or 255 a backdrop must be to key as a black/white plate. */
  const PLATE_TOLERANCE = 26;

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  /**
   * Collect the border pixels.
   *
   * The whole frame would be dominated by the subject; the four corners alone
   * are too few to survive a subject that bleeds into one. A band around the
   * edge is the compromise every keyer makes.
   */
  function borderPixels(image) {
    const { data, width, height } = image;
    const band = Math.max(MIN_BORDER, Math.round(Math.min(width, height) * BORDER_FRACTION));
    const out = [];

    for (let y = 0; y < height; y++) {
      const vertical = y < band || y >= height - band;
      for (let x = 0; x < width; x++) {
        if (!vertical && x >= band && x < width - band) {
          // Skip the interior in one jump rather than testing every pixel.
          x = width - band - 1;
          continue;
        }
        const i = (y * width + x) * 4;
        if (data[i + 3] < 8) continue; // already transparent, not backdrop
        out.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
    return out;
  }

  function mean(samples) {
    const sum = [0, 0, 0];
    for (const p of samples) {
      sum[0] += p[0];
      sum[1] += p[1];
      sum[2] += p[2];
    }
    const n = samples.length || 1;
    return sum.map((v) => v / n);
  }

  /**
   * How uniform the border is, 0 (varied) to 1 (perfectly flat).
   *
   * Standard deviation per channel, averaged and inverted. A gradient
   * backdrop, a photograph, or a subject running off the edge all push this
   * down — which is exactly the signal we want, because all three break the
   * assumption that there is a single B to subtract.
   */
  function flatness(samples) {
    if (samples.length < 2) return 0;
    const avg = mean(samples);
    let acc = 0;
    for (const p of samples) {
      acc += (p[0] - avg[0]) ** 2 + (p[1] - avg[1]) ** 2 + (p[2] - avg[2]) ** 2;
    }
    const deviation = Math.sqrt(acc / (samples.length * 3)) / 255;
    return clamp(1 - deviation / FLATNESS_LIMIT, 0, 1);
  }

  /**
   * Inspect an image and recommend how to key it.
   *
   * @returns {{mode, bgColor, flatness, flat, reason}}
   */
  function detect(image) {
    const samples = borderPixels(image);
    if (!samples.length) {
      return {
        mode: 'black',
        bgColor: [0, 0, 0],
        flatness: 0,
        flat: false,
        reason: 'empty',
      };
    }

    const avg = mean(samples).map((v) => Math.round(v));
    const uniformity = flatness(samples);
    const flat = uniformity > 0;

    const nearBlack = Math.max(...avg) <= PLATE_TOLERANCE;
    const nearWhite = Math.min(...avg) >= 255 - PLATE_TOLERANCE;

    let mode = 'color';
    let reason = 'color';
    if (nearBlack) {
      mode = 'black';
      reason = 'black-plate';
    } else if (nearWhite) {
      mode = 'white';
      reason = 'white-plate';
    }

    if (!flat) reason = 'not-flat';

    return { mode, bgColor: avg, flatness: uniformity, flat, reason };
  }

  /** Colour of a single pixel, for the eyedropper. */
  function sampleAt(image, x, y) {
    const px = clamp(Math.round(x), 0, image.width - 1);
    const py = clamp(Math.round(y), 0, image.height - 1);
    const i = (py * image.width + px) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  }

  App.detect = {
    BORDER_FRACTION,
    FLATNESS_LIMIT,
    PLATE_TOLERANCE,
    borderPixels,
    detect,
    flatness,
    mean,
    sampleAt,
  };
})((window.App = window.App || {}));
