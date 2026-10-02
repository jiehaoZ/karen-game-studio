/**
 * Colour quantisation: reduce an RGBA image to an indexed palette.
 *
 * Why this exists: a canvas PNG is always 32-bit truecolour. That is the wrong
 * container for the artwork this tool produces. A keyed-out sprite or a flat
 * game asset has tens of distinct colours, not millions, and storing four
 * bytes per pixel to say so wastes most of the file. Measured on real exports
 * from this tool, a 512x512 sprite with 18 distinct colours came out of the
 * canvas encoder at 92,649 bytes; the same pixels as an indexed PNG are 26,131.
 * Nothing was thrown away to get there — 18 colours fit in a 256-entry palette
 * exactly.
 *
 * That is also the whole trick behind every "PNG compressor" on the web: they
 * are running this step, not a better deflate. Below the point where the
 * palette stops being exact it becomes lossy, which is what makes it worth
 * putting under the same similarity search the lossy codecs already use.
 *
 * The pipeline is the standard one:
 *
 *   1. histogram      — collapse pixels to unique colours with counts
 *   2. median cut     — split the colour cloud into `maxColors` boxes,
 *                       always splitting whichever box carries the most error
 *   3. Voronoi/k-means— re-fit the palette to the pixels it actually owns
 *   4. map            — assign each pixel an index, optionally diffusing the
 *                       error into its neighbours (Floyd-Steinberg)
 *
 * Step 3 is the one that is easy to skip and shouldn't be: median cut picks
 * box centres, and a box centre is not the colour that minimises error over
 * the pixels in the box. Two passes of k-means are cheap and measurably
 * tighten the result.
 *
 * ## Everything happens in premultiplied space
 *
 * This is the detail that decides whether the result is any good, so it is
 * worth stating plainly. A transparent pixel's RGB is invisible — it is
 * whatever happened to be left in the buffer — and a quantiser that compares
 * straight RGBA will spend palette entries telling apart colours nobody can
 * see. The obvious patch is to scale the colour error by how opaque the two
 * colours are, and it does not work: that factor depends on *both* operands,
 * which stops the result being a metric. Distances stop obeying the triangle
 * inequality, the arithmetic mean stops being the error-minimising centroid,
 * and k-means walks away from the optimum instead of toward it. Measured on a
 * real export, two refinement passes took a 32-colour render from SSIM 0.961
 * down to 0.838 — the step meant to improve the palette was destroying it.
 *
 * Premultiplying instead — storing r*a, g*a, b*a alongside a — gets the same
 * property for free and stays a plain weighted Euclidean space: an invisible
 * pixel's colour components are zero because they are multiplied by zero, not
 * because a special case discounted them. Centroids are meaningful again and
 * k-means converges. The palette is converted back to straight RGBA on the way
 * out, because that is what PLTE and tRNS store.
 */
(function (App) {
  'use strict';

  /** A palette index is one byte, so this is a hard ceiling, not a tuning knob. */
  const MAX_COLORS = 256;

  /**
   * Perceptual channel weights for the distance metric.
   *
   * Green carries most of the luminance signal and blue the least, so equal
   * weighting spends palette entries on blue detail nobody can see.
   *
   * Alpha is weighted below the colour channels, which looks wrong until you
   * remember the space is premultiplied: an alpha error already shows up in
   * all three colour terms, because those terms are scaled by alpha. Weighting
   * it heavily on top of that double-counts it, and the palette drains into
   * the anti-aliased edge — on a real export, 14 of 32 entries went to an
   * alpha ramp covering 2.4% of the pixels.
   */
  const W_R = 2;
  const W_G = 4;
  const W_B = 3;
  const W_A = 3;

  /**
   * Building the histogram from every pixel of an 8192x8192 canvas costs more
   * than it buys — the palette is decided by which colours dominate, and that
   * is already settled long before the millionth sample. Larger images get
   * sampled on a regular stride. Mapping still visits every pixel; only the
   * palette decision is sampled.
   */
  const HISTOGRAM_SAMPLE_BUDGET = 1 << 20;

  /**
   * Cap on distinct colours carried into median cut.
   *
   * A photograph can present 200k+ unique colours, and both median cut and the
   * k-means passes are linear in that number. Posterising the histogram keys
   * (not the pixels) collapses near-duplicates that would never have earned
   * their own palette entry anyway.
   */
  const MAX_HISTOGRAM_ENTRIES = 20000;

  /**
   * How far from fully opaque or fully clear an entry can sit before it is
   * snapped to the endpoint.
   *
   * 0 and 255 are not ordinary points on the alpha scale, they are the two that
   * mean something: "this pixel is part of the artwork" and "this pixel is not
   * there". A palette entry that lands on 254 makes an entire solid subject
   * very slightly translucent, which composites visibly against a light
   * background and is not the kind of error the similarity search can see —
   * SSIM is built to ignore a small uniform offset, so a whole image shifting
   * from 255 to 254 barely moves the score.
   *
   * It happens for a mundane reason: on a cut-out, alpha 255 has an enormous
   * pixel count, and the handful of near-opaque pixels along the anti-aliased
   * edge drag the centroid of that box a fraction below 255.
   */
  const ALPHA_SNAP = 4;

  /** Premultiply a straight-alpha channel value. Result is an int in 0-255. */
  function premultiply(value, alpha) {
    return ((value * alpha + 127) / 255) | 0;
  }

  /**
   * Recover a straight-alpha channel value from a premultiplied one.
   *
   * Near-transparent entries divide by a very small alpha, which amplifies
   * whatever rounding survived premultiplication into a wildly saturated
   * colour. It is invisible either way — alpha is nearly zero — but clamping
   * keeps the palette readable and stops the value wrapping.
   */
  function unpremultiply(value, alpha) {
    if (alpha === 0) return 0;
    const straight = Math.round((value * 255) / alpha);
    return straight > 255 ? 255 : straight;
  }

  /**
   * Squared distance between two premultiplied RGBA colours.
   *
   * A plain weighted Euclidean metric — no operand-dependent terms, so the
   * arithmetic centroid of a set of colours really is the colour that
   * minimises this over the set, which is what k-means needs to converge.
   */
  function distance(r1, g1, b1, a1, r2, g2, b2, a2) {
    const dr = r1 - r2;
    const dg = g1 - g2;
    const db = b1 - b2;
    const da = a1 - a2;
    return W_R * dr * dr + W_G * dg * dg + W_B * db * db + W_A * da * da;
  }

  /**
   * Unique colours and their pixel counts, in premultiplied space.
   *
   * Fully transparent pixels collapse onto a single entry automatically:
   * premultiplying by zero erases whatever RGB they were carrying, so they are
   * all the same colour as far as the rest of the pipeline is concerned.
   *
   * @returns {{r,g,b,a: Uint8Array, count: Float64Array, size: number}}
   *   `r`, `g`, `b` are premultiplied.
   */
  function histogram(imageData) {
    const { data } = imageData;
    const pixels = data.length >>> 2;
    const stride = Math.max(1, Math.ceil(pixels / HISTOGRAM_SAMPLE_BUDGET));

    let shift = 0;
    let counts = new Map();

    // Posterise one bit at a time until the table fits. Starting coarse would
    // damage images that never needed it; almost everything this tool exports
    // finishes on the first pass.
    for (;;) {
      counts = new Map();
      const mask = (0xff << shift) & 0xff;
      let overflow = false;

      for (let p = 0; p < pixels; p += stride) {
        const i = p << 2;
        const a = data[i + 3];
        const key =
          a === 0
            ? 0
            : (((premultiply(data[i], a) & mask) << 24) |
                ((premultiply(data[i + 1], a) & mask) << 16) |
                ((premultiply(data[i + 2], a) & mask) << 8) |
                a) >>>
              0;
        const seen = counts.get(key);
        if (seen === undefined) {
          if (counts.size >= MAX_HISTOGRAM_ENTRIES && shift < 7) {
            overflow = true;
            break;
          }
          counts.set(key, 1);
        } else {
          counts.set(key, seen + 1);
        }
      }

      if (!overflow) break;
      shift++;
    }

    const size = counts.size;
    const r = new Uint8Array(size);
    const g = new Uint8Array(size);
    const b = new Uint8Array(size);
    const a = new Uint8Array(size);
    const count = new Float64Array(size);

    let n = 0;
    for (const [key, hits] of counts) {
      r[n] = (key >>> 24) & 0xff;
      g[n] = (key >>> 16) & 0xff;
      b[n] = (key >>> 8) & 0xff;
      a[n] = key & 0xff;
      count[n] = hits;
      n++;
    }

    return { r, g, b, a, count, size };
  }

  /**
   * Weighted mean and total squared error of a range of histogram entries.
   *
   * The error is what decides which box gets split next, and the per-channel
   * variances decide where. Both fall out of the same pass.
   */
  function boxStats(hist, order, start, end) {
    const { r, g, b, a, count } = hist;
    let total = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sa = 0;

    for (let i = start; i < end; i++) {
      const e = order[i];
      const w = count[e];
      total += w;
      sr += r[e] * w;
      sg += g[e] * w;
      sb += b[e] * w;
      sa += a[e] * w;
    }

    if (total === 0) {
      return { total: 0, r: 0, g: 0, b: 0, a: 0, error: 0, axis: 0 };
    }

    const mr = sr / total;
    const mg = sg / total;
    const mb = sb / total;
    const ma = sa / total;

    let vr = 0;
    let vg = 0;
    let vb = 0;
    let va = 0;
    for (let i = start; i < end; i++) {
      const e = order[i];
      const w = count[e];
      const dr = r[e] - mr;
      const dg = g[e] - mg;
      const db = b[e] - mb;
      const da = a[e] - ma;
      vr += w * dr * dr;
      vg += w * dg * dg;
      vb += w * db * db;
      va += w * da * da;
    }

    // Same weights as the distance metric, so "which axis is worst" and "which
    // colour is closest" cannot disagree with each other.
    const wr = W_R * vr;
    const wg = W_G * vg;
    const wb = W_B * vb;
    const wa = W_A * va;

    let axis = 0;
    let worst = wr;
    if (wg > worst) {
      worst = wg;
      axis = 1;
    }
    if (wb > worst) {
      worst = wb;
      axis = 2;
    }
    if (wa > worst) {
      worst = wa;
      axis = 3;
    }

    return {
      total,
      r: mr,
      g: mg,
      b: mb,
      a: ma,
      error: wr + wg + wb + wa,
      axis,
    };
  }

  /**
   * Plan the best cut of one box: where to split it, and what that buys.
   *
   * Two decisions live here, and both were wrong before.
   *
   * **Where to split.** The classic answer is the weighted median, so both
   * halves carry a similar share of the pixels. That is a rule about balance,
   * not about error, and it lands in the wrong place whenever the cloud is
   * lopsided. This scans every split position along the axis and takes the one
   * that minimises the squared error of the two halves — the split the box was
   * being divided *for*. One pass of prefix sums gives every candidate's error
   * without re-measuring anything, so knowing the best one costs no more than
   * guessing.
   *
   * **What it buys.** `gain` is how much total error the split removes, and it
   * is what the caller ranks boxes by. That distinction is the whole fix for
   * the worst failure this quantiser had; see medianCut.
   *
   * @returns {{at, gain, left, right}|null} null when the box cannot be split.
   */
  function planSplit(hist, order, start, end, stats) {
    if (end - start < 2) return null;

    const channels = [hist.r, hist.g, hist.b, hist.a];
    const weights = [W_R, W_G, W_B, W_A];
    const channel = channels[stats.axis];
    // subarray shares the buffer, so this sorts the range in place.
    order.subarray(start, end).sort((x, y) => channel[x] - channel[y]);

    // Totals over the whole box; the right half of any split is the total
    // minus the left, so one walk covers every candidate.
    const total = new Float64Array(9); // w, then sum and sum-of-squares per channel
    for (let i = start; i < end; i++) {
      const e = order[i];
      const w = hist.count[e];
      total[0] += w;
      for (let c = 0; c < 4; c++) {
        const v = channels[c][e];
        total[1 + c * 2] += w * v;
        total[2 + c * 2] += w * v * v;
      }
    }

    /** Weighted squared error of a half, from its sums. Zero when empty. */
    const sse = (w, sums) => {
      if (w <= 0) return 0;
      let acc = 0;
      for (let c = 0; c < 4; c++) {
        const sum = sums[c * 2];
        acc += weights[c] * (sums[c * 2 + 1] - (sum * sum) / w);
      }
      return acc;
    };

    const left = new Float64Array(8);
    const right = new Float64Array(8);
    const bestLeft = new Float64Array(8);
    let leftWeight = 0;
    let bestAt = -1;
    let bestError = Infinity;
    let bestLeftWeight = 0;

    for (let i = start; i < end - 1; i++) {
      const e = order[i];
      const w = hist.count[e];
      leftWeight += w;
      for (let c = 0; c < 4; c++) {
        const v = channels[c][e];
        left[c * 2] += w * v;
        left[c * 2 + 1] += w * v * v;
      }
      for (let c = 0; c < 8; c++) right[c] = total[1 + c] - left[c];

      const error = sse(leftWeight, left) + sse(total[0] - leftWeight, right);
      if (error < bestError) {
        bestError = error;
        bestAt = i + 1;
        bestLeftWeight = leftWeight;
        bestLeft.set(left);
      }
    }

    if (bestAt < 0) return null;

    /** Turn one half's sums into the same shape boxStats returns. */
    const half = (w, sums) => {
      if (w <= 0) return { total: 0, r: 0, g: 0, b: 0, a: 0, error: 0, axis: 0 };
      let error = 0;
      let axis = 0;
      let worst = -1;
      const mean = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) {
        const sum = sums[c * 2];
        mean[c] = sum / w;
        const spread = weights[c] * (sums[c * 2 + 1] - (sum * sum) / w);
        error += spread;
        if (spread > worst) {
          worst = spread;
          axis = c;
        }
      }
      return { total: w, r: mean[0], g: mean[1], b: mean[2], a: mean[3], error, axis };
    };

    for (let c = 0; c < 8; c++) right[c] = total[1 + c] - bestLeft[c];

    return {
      at: bestAt,
      gain: stats.error - bestError,
      left: half(bestLeftWeight, bestLeft),
      right: half(total[0] - bestLeftWeight, right),
    };
  }

  /**
   * Median cut: split the colour cloud until there are `maxColors` boxes.
   *
   * Boxes are ranked by **how much error splitting them would remove**, not by
   * how much error they currently hold. Those sound like the same thing and are
   * not, and the difference decided whether this tool was competitive.
   *
   * Total error is a sum over pixels, so a large flat region dominates it on
   * size alone: a photographed sky that is one colour give or take a single
   * unit, spread over 30,000 pixels, carries more total error than a small
   * region that swings across half the gamut. Ranked by current error, that sky
   * gets split first — and again, and again. Measured on a real 256x256 export:
   * seven of twenty-eight palette entries landed inside a 6-unit-wide cube of
   * ocean blue, the neighbouring pixels then alternated between those seven
   * near-identical entries, and the index stream turned from a flat run into
   * noise. Deflate cannot model noise: that file came out at 12,569 bytes where
   * a 28-colour palette without the duplicates fits in 5,597.
   *
   * Ranking by error *reduction* rules that split out on its own terms — the
   * sky is already nearly its own mean, so cutting it in two removes almost
   * nothing, and the entry goes where it actually buys something. Nothing about
   * the metric or the ladder changed; only which box gets cut next.
   */
  function medianCut(hist, maxColors) {
    const order = new Uint32Array(hist.size);
    for (let i = 0; i < hist.size; i++) order[i] = i;

    const root = { start: 0, end: hist.size, stats: boxStats(hist, order, 0, hist.size) };
    root.plan = planSplit(hist, order, root.start, root.end, root.stats);
    const boxes = [root];

    while (boxes.length < maxColors) {
      let pick = -1;
      let best = 0;
      for (let i = 0; i < boxes.length; i++) {
        const plan = boxes[i].plan;
        if (plan && plan.gain > best) {
          best = plan.gain;
          pick = i;
        }
      }
      // Every remaining box is a single colour, or splitting it would buy
      // nothing measurable. Either way there is no honest cut left to make.
      if (pick < 0) break;

      const box = boxes[pick];
      const left = { start: box.start, end: box.plan.at, stats: box.plan.left };
      const right = { start: box.plan.at, end: box.end, stats: box.plan.right };
      left.plan = planSplit(hist, order, left.start, left.end, left.stats);
      right.plan = planSplit(hist, order, right.start, right.end, right.stats);
      boxes[pick] = left;
      boxes.push(right);
    }

    const palette = new Float64Array(boxes.length * 4);
    for (let i = 0; i < boxes.length; i++) {
      const s = boxes[i].stats;
      palette[i * 4] = s.r;
      palette[i * 4 + 1] = s.g;
      palette[i * 4 + 2] = s.b;
      palette[i * 4 + 3] = s.a;
    }
    return palette;
  }

  /** Index of the palette entry closest to a colour, by the weighted metric. */
  function nearest(palette, size, r, g, b, a) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < size; i++) {
      const o = i * 4;
      const d = distance(r, g, b, a, palette[o], palette[o + 1], palette[o + 2], palette[o + 3]);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
        if (d === 0) break;
      }
    }
    return best;
  }

  /**
   * Voronoi iteration: move each palette entry to the weighted centroid of the
   * colours that actually map to it, and repeat.
   *
   * Median cut hands back box centres. The centre of a box is not the colour
   * that minimises error over the pixels inside it — the pixels are rarely
   * distributed evenly within the box. This is the standard k-means fix and it
   * converges in a couple of passes on image data.
   */
  function refine(palette, hist, passes) {
    const size = palette.length / 4;
    const sums = new Float64Array(size * 4);
    const weights = new Float64Array(size);

    for (let pass = 0; pass < passes; pass++) {
      sums.fill(0);
      weights.fill(0);

      for (let e = 0; e < hist.size; e++) {
        const w = hist.count[e];
        const idx = nearest(palette, size, hist.r[e], hist.g[e], hist.b[e], hist.a[e]);
        const o = idx * 4;
        sums[o] += hist.r[e] * w;
        sums[o + 1] += hist.g[e] * w;
        sums[o + 2] += hist.b[e] * w;
        sums[o + 3] += hist.a[e] * w;
        weights[idx] += w;
      }

      for (let i = 0; i < size; i++) {
        // An entry that won nothing keeps its position rather than collapsing
        // to black, which would corrupt the next assignment pass.
        if (weights[i] === 0) continue;
        const o = i * 4;
        palette[o] = sums[o] / weights[i];
        palette[o + 1] = sums[o + 1] / weights[i];
        palette[o + 2] = sums[o + 2] / weights[i];
        palette[o + 3] = sums[o + 3] / weights[i];
      }
    }
  }

  /**
   * Order the palette so every non-opaque entry comes first, and so that
   * neighbouring entries are similar colours.
   *
   * Two things ride on this order. PNG's tRNS chunk is a *prefix* of the
   * palette: it stores alpha for entries 0 through n and every later entry is
   * implicitly opaque. Sorting by alpha makes that prefix as short as it can
   * be, and on artwork that is mostly solid with a soft edge that is the
   * difference between a 256-byte chunk and a handful of bytes.
   *
   * The tie-break by brightness is there because what deflate compresses is
   * the stream of palette *indices*: if near-identical colours get
   * near-identical indices, a smooth region becomes a slowly-varying byte
   * sequence rather than noise. Measured on real exports it is worth well
   * under a percent either way — median cut already emits boxes in a roughly
   * coherent order, so this mostly swaps one decent order for another. It is
   * kept because it costs nothing and makes the ordering intentional rather
   * than incidental, not because it earned its place on the numbers.
   */
  function sortByAlpha(palette) {
    const size = palette.length / 4;
    const indices = Array.from({ length: size }, (_, i) => i);
    const brightness = (i) =>
      0.299 * palette[i * 4] + 0.587 * palette[i * 4 + 1] + 0.114 * palette[i * 4 + 2];
    indices.sort(
      (x, y) =>
        palette[x * 4 + 3] - palette[y * 4 + 3] || brightness(x) - brightness(y)
    );

    const sorted = new Float64Array(palette.length);
    const remap = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      const from = indices[i];
      remap[from] = i;
      sorted[i * 4] = palette[from * 4];
      sorted[i * 4 + 1] = palette[from * 4 + 1];
      sorted[i * 4 + 2] = palette[from * 4 + 2];
      sorted[i * 4 + 3] = palette[from * 4 + 3];
    }
    return { palette: sorted, remap };
  }

  function clamp255(value) {
    return value < 0 ? 0 : value > 255 ? 255 : value;
  }

  /**
   * Pull palette alphas that are nearly opaque or nearly clear onto the exact
   * endpoint. See ALPHA_SNAP for why those two values are special.
   *
   * The colour components are left alone. They are still premultiplied at this
   * point, and a change of up to four parts in 255 is both invisible and about
   * to be divided back out anyway.
   */
  function snapAlphaEndpoints(palette) {
    for (let i = 3; i < palette.length; i += 4) {
      if (palette[i] >= 255 - ALPHA_SNAP) palette[i] = 255;
      else if (palette[i] <= ALPHA_SNAP) palette[i] = 0;
    }
  }

  /**
   * Assign every pixel a palette index.
   *
   * `palette` is premultiplied, and so is everything this function computes —
   * including the diffused error. Dithering in straight space would push
   * colour error across the edge of the subject, where alpha is falling and
   * the colour underneath it is meaningless, and paint a fringe.
   *
   * Without dithering, each pixel independently takes its nearest entry. That
   * is exact when the palette covers the image, and produces banding when it
   * does not. With dithering, the rounding error is pushed into the pixels not
   * yet visited (Floyd-Steinberg), trading banding for fine noise.
   *
   * Serpentine scanning — alternating row direction — is used because a purely
   * left-to-right diffusion drags error consistently one way and leaves a
   * visible directional grain.
   */
  function map(imageData, palette, dither) {
    const { data, width, height } = imageData;
    const size = palette.length / 4;
    const indices = new Uint8Array(width * height);

    if (!dither) {
      // Repeated colours are the common case in flat artwork, so a memo on the
      // packed colour turns most of this loop into a hash lookup.
      const cache = new Map();
      for (let p = 0, i = 0; p < indices.length; p++, i += 4) {
        const a = data[i + 3];
        const pr = a === 0 ? 0 : premultiply(data[i], a);
        const pg = a === 0 ? 0 : premultiply(data[i + 1], a);
        const pb = a === 0 ? 0 : premultiply(data[i + 2], a);
        const key = ((pr << 24) | (pg << 16) | (pb << 8) | a) >>> 0;
        let idx = cache.get(key);
        if (idx === undefined) {
          idx = nearest(palette, size, pr, pg, pb, a);
          cache.set(key, idx);
        }
        indices[p] = idx;
      }
      return indices;
    }

    // Two rows of accumulated error, in float, recycled each scanline.
    const rowSize = (width + 2) * 4;
    let current = new Float32Array(rowSize);
    let next = new Float32Array(rowSize);

    for (let y = 0; y < height; y++) {
      next.fill(0);
      const leftToRight = (y & 1) === 0;
      const from = leftToRight ? 0 : width - 1;
      const to = leftToRight ? width : -1;
      const step = leftToRight ? 1 : -1;

      for (let x = from; x !== to; x += step) {
        const i = (y * width + x) << 2;
        const e = (x + 1) * 4;

        const alpha = data[i + 3];
        const r = clamp255((alpha === 0 ? 0 : premultiply(data[i], alpha)) + current[e]);
        const g = clamp255((alpha === 0 ? 0 : premultiply(data[i + 1], alpha)) + current[e + 1]);
        const b = clamp255((alpha === 0 ? 0 : premultiply(data[i + 2], alpha)) + current[e + 2]);
        const a = clamp255(alpha + current[e + 3]);

        const idx = nearest(palette, size, r, g, b, a);
        indices[y * width + x] = idx;

        const o = idx * 4;
        const er = r - palette[o];
        const eg = g - palette[o + 1];
        const eb = b - palette[o + 2];
        const ea = a - palette[o + 3];

        // Floyd-Steinberg: 7/16 ahead, then 3/16, 5/16, 1/16 on the next row.
        const ahead = e + step * 4;
        const below = e;
        const beforeBelow = e - step * 4;
        const afterBelow = e + step * 4;

        current[ahead] += (er * 7) / 16;
        current[ahead + 1] += (eg * 7) / 16;
        current[ahead + 2] += (eb * 7) / 16;
        current[ahead + 3] += (ea * 7) / 16;

        next[beforeBelow] += (er * 3) / 16;
        next[beforeBelow + 1] += (eg * 3) / 16;
        next[beforeBelow + 2] += (eb * 3) / 16;
        next[beforeBelow + 3] += (ea * 3) / 16;

        next[below] += (er * 5) / 16;
        next[below + 1] += (eg * 5) / 16;
        next[below + 2] += (eb * 5) / 16;
        next[below + 3] += (ea * 5) / 16;

        next[afterBelow] += er / 16;
        next[afterBelow + 1] += eg / 16;
        next[afterBelow + 2] += eb / 16;
        next[afterBelow + 3] += ea / 16;
      }

      const swap = current;
      current = next;
      next = swap;
    }

    return indices;
  }

  /**
   * Reduce an image to an indexed palette.
   *
   * @param {ImageData} imageData
   * @param {number} maxColors 2-256
   * @param {{dither?: boolean, refinePasses?: number, histogram?: object}} [options]
   *   `dither` defaults to off; see the note on dithering below.
   *   `histogram` accepts a table from a previous call on the same pixels. It
   *   does not depend on palette size, so a search that walks several sizes
   *   over one image should build it once and pass it in.
   *
   * ## Why dithering defaults to off
   *
   * Textbook advice is to dither, and for a fixed palette handed down from
   * outside — the old 216-colour web palette, a console's hardware palette —
   * that advice is right. It does not transfer to a palette fitted to this
   * image. Measured across real exports at every rung of the search,
   * Floyd-Steinberg made the file 15-30% *larger* and scored *lower* on SSIM
   * than not dithering at all. Both directions, every time.
   *
   * The reason is that dithering trades banding for noise, and here neither
   * side of that trade pays. Noise is the one thing deflate cannot model, so
   * the file grows; and the banding it buys off only appears at palette sizes
   * the similarity floor rejects anyway, so the search never visits the
   * region where dithering would have earned its keep.
   *
   * The implementation stays because the trade does pay on smooth gradients
   * pushed to a tiny palette, which is a thing someone may want to do
   * deliberately. It is simply not the default.
   * @returns {{palette: Uint8Array, indices: Uint8Array, colors: number,
   *            exact: boolean, width: number, height: number}}
   *   `palette` is straight-alpha RGBA quads, ordered so all non-opaque
   *   entries come first.
   */
  function reduce(imageData, maxColors, options) {
    const settings = { dither: false, refinePasses: 2, histogram: null, ...options };
    const limit = Math.max(2, Math.min(MAX_COLORS, Math.floor(maxColors)));

    const hist = settings.histogram || histogram(imageData);
    // The palette covers every colour present, so mapping cannot introduce
    // error and dithering has nothing to diffuse.
    const exact = hist.size <= limit;

    const centres = medianCut(hist, limit);
    if (!exact && settings.refinePasses > 0) {
      refine(centres, hist, settings.refinePasses);
    }
    for (let i = 0; i < centres.length; i++) centres[i] = Math.round(centres[i]);
    snapAlphaEndpoints(centres);

    const { palette: ordered } = sortByAlpha(centres);
    // Mapping runs in the premultiplied space the palette was built in.
    const indices = map(imageData, ordered, settings.dither && !exact);

    // PLTE and tRNS store straight alpha, so undo the premultiply last —
    // after every distance has been measured and every index assigned.
    const out = new Uint8Array(ordered.length);
    for (let i = 0; i < ordered.length; i += 4) {
      const alpha = ordered[i + 3];
      out[i] = unpremultiply(ordered[i], alpha);
      out[i + 1] = unpremultiply(ordered[i + 1], alpha);
      out[i + 2] = unpremultiply(ordered[i + 2], alpha);
      out[i + 3] = alpha;
    }

    return {
      palette: out,
      indices,
      colors: out.length / 4,
      exact,
      width: imageData.width,
      height: imageData.height,
    };
  }

  App.quantize = {
    ALPHA_SNAP,
    MAX_COLORS,
    distance,
    histogram,
    map,
    medianCut,
    planSplit,
    nearest,
    premultiply,
    reduce,
    refine,
    snapAlphaEndpoints,
    sortByAlpha,
    unpremultiply,
  };
})((typeof window !== 'undefined' ? (window.App = window.App || {}) : (module.exports = {})));
