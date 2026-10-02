/**
 * Structural similarity between two images, used to decide how far a lossy
 * encoder can be pushed before the damage becomes visible.
 *
 * Why this exists: file size alone cannot answer "compress until it stops
 * getting smaller". Measured across real content, every extra quality step
 * still buys 7-15% of the file, all the way to the bottom of the scale — the
 * curve never flattens, so a size-only rule always bottoms out at whatever
 * floor it is given. Quality is the axis that actually has a stopping point.
 *
 * Standard SSIM over 8x8 windows. Windowed rather than global because a global
 * mean hides local damage — blocking in a smooth gradient is exactly what a
 * whole-image average washes out.
 *
 * ## Two planes, and the score is the worse of them
 *
 * Luma alone is not enough once alpha is in play. Compare a soft-edged cut-out
 * on premultiplied luma and a palette that has collapsed a two-hundred-step
 * alpha fade into forty-odd steps still scores above 0.99: the fade is dark
 * where it is transparent, so the banding lands in the part of the signal that
 * contributes least. Composited onto a light background the same file shows
 * concentric rings.
 *
 * So alpha is measured as its own plane and the result is the minimum of the
 * two. Minimum rather than average because the question the search asks is
 * "would anything visible break", and an average lets a plane that is fine
 * pay for a plane that is not. On an image with no transparency the alpha
 * plane is constant, scores exactly 1, and changes nothing.
 *
 * Known limit: the score is a mean over windows, so damage confined to a small
 * part of the frame moves it only in proportion to the area it covers. That
 * suits this use — encoder artefacts appear across the whole image — but it
 * makes the metric a poor detector of a single ruined corner.
 */
(function (App) {
  'use strict';

  const WINDOW = 8;
  const L = 255;
  const C1 = (0.01 * L) ** 2;
  const C2 = (0.03 * L) ** 2;

  /**
   * Rec. 601 luma, premultiplied by alpha.
   *
   * Chroma damage matters less to the eye and costs a third more work to track
   * for little change in the resulting decision, so only luma is compared.
   *
   * The alpha term is not optional. A transparent pixel still carries RGB —
   * whatever was in the buffer before it was keyed out — and that colour is
   * not preserved by any encoder, because no encoder has a reason to preserve
   * something nobody can see. Reading it anyway makes the score punish changes
   * that are invisible by definition, and on a cut-out sprite, where most of
   * the frame is transparent, that phantom error is large enough to halt the
   * compression search long before anything visible has been touched.
   *
   * Multiplying by alpha is the same as compositing both images onto the same
   * black background and comparing that, which is a fair question to ask:
   * "would these two look different once drawn?"
   */
  function toLuma(imageData) {
    const { data, width, height } = imageData;
    const luma = new Float32Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const value = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      luma[p] = (value * data[i + 3]) / 255;
    }
    return { luma, width, height };
  }

  /** The alpha channel on its own, as a plane to be compared like any other. */
  function toAlpha(imageData) {
    const { data, width, height } = imageData;
    const alpha = new Float32Array(width * height);
    for (let i = 3, p = 0; i < data.length; i += 4, p++) {
      alpha[p] = data[i];
    }
    return alpha;
  }

  function windowStats(a, b, width, x0, y0, size) {
    let sumA = 0;
    let sumB = 0;
    let sumAA = 0;
    let sumBB = 0;
    let sumAB = 0;
    const n = size * size;

    for (let y = 0; y < size; y++) {
      const row = (y0 + y) * width + x0;
      for (let x = 0; x < size; x++) {
        const va = a[row + x];
        const vb = b[row + x];
        sumA += va;
        sumB += vb;
        sumAA += va * va;
        sumBB += vb * vb;
        sumAB += va * vb;
      }
    }

    const meanA = sumA / n;
    const meanB = sumB / n;
    return {
      meanA,
      meanB,
      varA: sumAA / n - meanA * meanA,
      varB: sumBB / n - meanB * meanB,
      covAB: sumAB / n - meanA * meanB,
    };
  }

  /** Mean SSIM over one plane. */
  function comparePlane(reference, candidate, width, height) {
    let total = 0;
    let windows = 0;

    for (let y = 0; y + WINDOW <= height; y += WINDOW) {
      for (let x = 0; x + WINDOW <= width; x += WINDOW) {
        const s = windowStats(reference, candidate, width, x, y, WINDOW);
        const numerator =
          (2 * s.meanA * s.meanB + C1) * (2 * s.covAB + C2);
        const denominator =
          (s.meanA * s.meanA + s.meanB * s.meanB + C1) * (s.varA + s.varB + C2);
        total += numerator / denominator;
        windows++;
      }
    }

    return windows ? total / windows : 1;
  }

  /**
   * Similarity of two images: the worse of their luma and alpha planes.
   *
   * 1.0 is identical; below ~0.98 artefacts are generally findable by eye on
   * flat or gradient areas.
   *
   * @returns {number} 0-1
   */
  function compare(referenceData, candidateData) {
    const ref = toLuma(referenceData);
    const cand = toLuma(candidateData);

    if (ref.width !== cand.width || ref.height !== cand.height) {
      throw new Error('SSIM needs two images of the same size');
    }

    const { width, height } = ref;
    const luma = comparePlane(ref.luma, cand.luma, width, height);
    const alpha = comparePlane(
      toAlpha(referenceData),
      toAlpha(candidateData),
      width,
      height
    );
    return Math.min(luma, alpha);
  }

  App.ssim = { WINDOW, compare, comparePlane, toAlpha, toLuma };
})((window.App = window.App || {}));
