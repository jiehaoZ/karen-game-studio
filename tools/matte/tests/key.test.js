/**
 * Solid-colour unmixing.
 *
 * Two different guarantees are tested here, and keeping them apart matters:
 *
 *   1. The premultiplied colour α·F round-trips exactly, always. This is the
 *      hard guarantee — it is what the compositing equation actually pins down.
 *   2. The *split* into a separate α and F is exact only when the foreground
 *      peaks near full in some channel. Below that, α is underestimated, and
 *      the tests say so explicitly rather than papering over it.
 */
const test = require('node:test');
const assert = require('node:assert');

const { loadApp } = require('./harness');

const App = loadApp(['key.js']);
const K = App.key;

/** Build ImageData from a flat list of [r,g,b,a] pixels. */
function imageOf(pixels, width = pixels.length, height = 1) {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((p, i) => {
    data[i * 4] = p[0];
    data[i * 4 + 1] = p[1];
    data[i * 4 + 2] = p[2];
    data[i * 4 + 3] = p[3] === undefined ? 255 : p[3];
  });
  return new ImageData(data, width, height);
}

const pixelAt = (img, i) => [
  img.data[i * 4],
  img.data[i * 4 + 1],
  img.data[i * 4 + 2],
  img.data[i * 4 + 3],
];

/** Composite a foreground over a backdrop at a given opacity — the forward model. */
function composite(fg, bg, alpha) {
  return [0, 1, 2].map((i) => Math.round(alpha * fg[i] + (1 - alpha) * bg[i]));
}

/* ── the round trip ─────────────────────────────────────────────────── */

/**
 * The hard guarantee. Whatever α and F the keyer chooses, α·F must equal what
 * went in — that product is the only thing the compositing equation determines,
 * and preserving it is what makes the cut-out recomposite correctly.
 */
test('the premultiplied colour round-trips exactly, whatever the foreground', () => {
  for (const fg of [[220, 90, 40], [255, 255, 255], [90, 40, 20], [12, 200, 7]]) {
    for (const alpha of [0.25, 0.5, 0.75, 1]) {
      const composited = composite(fg, [0, 0, 0], alpha);
      const out = K.key(imageOf([composited]), { mode: 'black', low: 0, high: 1 });
      const [r, g, b, a] = pixelAt(out.data, 0);
      const back = [r, g, b].map((c) => (c * a) / 255);

      for (let i = 0; i < 3; i++) {
        assert.ok(
          Math.abs(back[i] - composited[i]) <= 2,
          `fg=${fg} α=${alpha}: channel ${i} came back ${back[i].toFixed(1)}, ` +
            `expected ${composited[i]}`
        );
      }
    }
  }
});

test('a foreground that peaks at full splits back into exactly its α and colour', () => {
  // The assumption alphaOnBlack makes, satisfied: the red channel is maxed.
  const fg = [255, 90, 40];
  const alpha = 0.5;
  const out = K.key(imageOf([composite(fg, [0, 0, 0], alpha)]), {
    mode: 'black',
    low: 0,
    high: 1,
  });
  const [r, g, b, a] = pixelAt(out.data, 0);

  assert.ok(Math.abs(a / 255 - alpha) < 0.01, `alpha ${a / 255} vs ${alpha}`);
  assert.ok(Math.abs(r - fg[0]) <= 2 && Math.abs(g - fg[1]) <= 2 && Math.abs(b - fg[2]) <= 2,
    `got ${[r, g, b]} want ${fg}`);
});

test('the same holds on a white plate', () => {
  const fg = [0, 90, 220]; // peaks at full darkness in red, the inverted case
  const alpha = 0.5;
  const out = K.key(imageOf([composite(fg, [255, 255, 255], alpha)]), {
    mode: 'white',
    low: 0,
    high: 1,
  });
  const [r, g, b, a] = pixelAt(out.data, 0);

  assert.ok(Math.abs(a / 255 - alpha) < 0.01, `alpha ${a / 255}`);
  assert.ok(Math.abs(r - fg[0]) <= 2 && Math.abs(g - fg[1]) <= 2 && Math.abs(b - fg[2]) <= 2,
    `got ${[r, g, b]} want ${fg}`);
});

/**
 * The documented limitation, asserted rather than hidden: a foreground that
 * never approaches full brightness reads as more transparent than it is,
 * by exactly the ratio of its peak to full.
 */
test('a dim foreground has its alpha underestimated, predictably', () => {
  const fg = [128, 60, 30]; // peaks at half
  const alpha = 0.8;
  const out = K.key(imageOf([composite(fg, [0, 0, 0], alpha)]), {
    mode: 'black',
    low: 0,
    high: 1,
  });
  const measured = pixelAt(out.data, 0)[3] / 255;

  assert.ok(measured < alpha, 'underestimated, as documented');
  // The error is the peak shortfall: 128/255.
  assert.ok(Math.abs(measured - alpha * (128 / 255)) < 0.02,
    `expected ≈${(alpha * (128 / 255)).toFixed(3)}, got ${measured.toFixed(3)}`);
});

test('the high handle is what recovers an underestimated alpha', () => {
  const fg = [128, 60, 30];
  const composited = composite(fg, [0, 0, 0], 1); // fully opaque but dim
  const raw = K.key(imageOf([composited]), { mode: 'black', low: 0, high: 1 });
  const corrected = K.key(imageOf([composited]), { mode: 'black', low: 0, high: 0.5 });

  assert.ok(pixelAt(raw.data, 0)[3] < 255, 'raw solve leaves it semi-transparent');
  assert.strictEqual(pixelAt(corrected.data, 0)[3], 255, 'the handle solidifies it');
});

/* ── why this beats segmentation ────────────────────────────────────── */

test('a partially covered pixel keeps its fractional opacity', () => {
  // A hair strand covering 30% of a pixel. Segmentation must answer in/out;
  // unmixing just reports 0.3.
  const strand = [255, 240, 210];
  const img = imageOf([composite(strand, [0, 0, 0], 0.3)]);

  const [, , , a] = pixelAt(K.key(img, { mode: 'black', low: 0, high: 1 }).data, 0);
  assert.ok(a > 0 && a < 255, `expected a partial alpha, got ${a}`);
  assert.ok(Math.abs(a / 255 - 0.3) < 0.02);
});

test('a soft gradient edge survives as a gradient, not a hard cut', () => {
  const fg = [255, 255, 255];
  const ramp = [0, 0.2, 0.4, 0.6, 0.8, 1].map((a) => composite(fg, [0, 0, 0], a));
  const out = K.key(imageOf(ramp), { mode: 'black', low: 0, high: 1 });

  const alphas = ramp.map((_, i) => pixelAt(out.data, i)[3]);
  for (let i = 1; i < alphas.length; i++) {
    assert.ok(alphas[i] > alphas[i - 1], `alpha must keep rising: ${alphas}`);
  }
  assert.strictEqual(alphas[0], 0);
  assert.strictEqual(alphas[alphas.length - 1], 255);
});

/* ── levels ─────────────────────────────────────────────────────────── */

test('the low handle clears backdrop noise to fully transparent', () => {
  const noise = [6, 5, 7]; // a faint speck on a black plate
  const out = K.key(imageOf([noise]), { mode: 'black', low: 0.04, high: 0.92 });
  assert.strictEqual(pixelAt(out.data, 0)[3], 0);
});

test('the high handle solidifies a nearly-opaque subject', () => {
  const almost = composite([255, 255, 255], [0, 0, 0], 0.95);
  const out = K.key(imageOf([almost]), { mode: 'black', low: 0.04, high: 0.92 });
  assert.strictEqual(pixelAt(out.data, 0)[3], 255);
});

test('levels maps the band linearly and clamps outside it', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  near(K.levels(0.5, 0, 1), 0.5);
  near(K.levels(0.0, 0.2, 0.8), 0);
  near(K.levels(0.2, 0.2, 0.8), 0);
  near(K.levels(0.5, 0.2, 0.8), 0.5);
  near(K.levels(0.8, 0.2, 0.8), 1);
  near(K.levels(1.0, 0.2, 0.8), 1);
});

test('an inverted band degrades to a hard threshold rather than dividing by zero', () => {
  assert.strictEqual(K.levels(0.9, 0.8, 0.8), 1);
  assert.strictEqual(K.levels(0.1, 0.8, 0.8), 0);
  assert.ok(Number.isFinite(K.levels(0.5, 0.9, 0.1)));
});

/* ── fully transparent and fully opaque ─────────────────────────────── */

test('pure backdrop becomes fully transparent with nothing left behind', () => {
  const out = K.key(imageOf([[0, 0, 0], [0, 0, 0]]), { mode: 'black' });
  assert.deepStrictEqual(pixelAt(out.data, 0), [0, 0, 0, 0]);
  assert.deepStrictEqual(pixelAt(out.data, 1), [0, 0, 0, 0]);
});

test('pure white backdrop leaves nothing behind either', () => {
  const out = K.key(imageOf([[255, 255, 255]]), { mode: 'white' });
  assert.strictEqual(pixelAt(out.data, 0)[3], 0);
});

test('an opaque subject comes through untouched', () => {
  const out = K.key(imageOf([[255, 255, 255]]), { mode: 'black' });
  assert.deepStrictEqual(pixelAt(out.data, 0), [255, 255, 255, 255]);
});

/* ── chroma ─────────────────────────────────────────────────────────── */

test('a green plate keys to transparent and the subject survives', () => {
  const green = [0, 177, 64];
  const subject = [220, 90, 40];
  const out = K.key(imageOf([green, subject]), {
    mode: 'color',
    bgColor: green,
    low: 0.05,
    high: 0.6,
  });

  assert.strictEqual(pixelAt(out.data, 0)[3], 0, 'the plate must vanish');
  assert.strictEqual(pixelAt(out.data, 1)[3], 255, 'the subject must stay');
});

test('despill pulls green out of a spill-lit edge', () => {
  const spilled = [120, 200, 110]; // a pale subject catching green bounce
  const clean = K.despillPixel(spilled, [0, 177, 64], 1);

  assert.ok(clean[1] < spilled[1], 'green must come down');
  assert.strictEqual(clean[0], spilled[0], 'red untouched');
  assert.strictEqual(clean[2], spilled[2], 'blue untouched');
  assert.ok(clean[1] <= (spilled[0] + spilled[2]) / 2 + 0.01, 'capped at its neighbours');
});

test('despill leaves a pixel that has no spill alone', () => {
  const neutral = [200, 100, 180];
  assert.deepStrictEqual(K.despillPixel(neutral, [0, 177, 64], 1), neutral);
});

test('despill strength scales the correction', () => {
  const spilled = [100, 220, 100];
  const half = K.despillPixel(spilled, [0, 177, 64], 0.5);
  const full = K.despillPixel(spilled, [0, 177, 64], 1);

  assert.ok(half[1] > full[1], 'half strength corrects less');
  assert.ok(half[1] < spilled[1], 'but still corrects');
  assert.deepStrictEqual(K.despillPixel(spilled, [0, 177, 64], 0), spilled);
});

test('a blue plate spills blue, not green', () => {
  const spilled = [100, 100, 220];
  const clean = K.despillPixel(spilled, [0, 60, 200], 1);
  assert.ok(clean[2] < spilled[2], 'blue must come down');
  assert.strictEqual(clean[1], spilled[1], 'green untouched');
});

test('despill only runs on the colour mode', () => {
  // A green-tinted subject on black must not be desaturated.
  const out = K.key(imageOf([[100, 220, 100]]), { mode: 'black', low: 0, high: 1, despill: 1 });
  const [r, g, b] = pixelAt(out.data, 0);
  assert.ok(g > r && g > b, 'green subject stays green on a black plate');
});

/* ── the unmix step itself ──────────────────────────────────────────── */

test('unmix removes the backdrop contribution from an edge pixel', () => {
  // Half-covered white subject on black reads as mid-grey; unmixed it is white.
  assert.ok(Math.abs(K.unmix(128, 0.5, 0) - 256) < 130);
  // On white the same coverage reads bright; unmixed it must come back down.
  assert.ok(K.unmix(190, 0.5, 255) < 190);
});

test('unmix clamps rather than producing out-of-range colour', () => {
  assert.ok(K.unmix(255, 0.1, 0) <= 255);
  assert.ok(K.unmix(0, 0.1, 255) >= 0);
});

test('unmix of a fully transparent pixel is defined, not a division by zero', () => {
  assert.strictEqual(K.unmix(128, 0, 0), 0);
  assert.ok(Number.isFinite(K.unmix(128, 0, 255)));
});

/* ── alpha readers ──────────────────────────────────────────────────── */

test('alpha on black is the brightest channel', () => {
  assert.strictEqual(K.alphaOnBlack(0, 0, 0), 0);
  assert.strictEqual(K.alphaOnBlack(255, 0, 0), 1);
  assert.strictEqual(K.alphaOnBlack(0, 128, 64), 128 / 255);
});

test('alpha on white is the brightest inverted channel', () => {
  assert.strictEqual(K.alphaOnWhite(255, 255, 255), 0);
  assert.strictEqual(K.alphaOnWhite(0, 255, 255), 1);
});

test('alpha on colour rises with distance from the backdrop', () => {
  const bg = [0, 177, 64];
  assert.strictEqual(K.alphaOnColor(0, 177, 64, bg, 0.25), 0);
  assert.ok(K.alphaOnColor(255, 255, 255, bg, 0.25) > K.alphaOnColor(20, 170, 70, bg, 0.25));
});

/* ── contract ───────────────────────────────────────────────────────── */

test('the source image is never modified', () => {
  const img = imageOf([[120, 130, 140]]);
  const before = Array.from(img.data);
  K.key(img, { mode: 'black' });
  assert.deepStrictEqual(Array.from(img.data), before);
});

test('existing transparency in the source is respected', () => {
  // A pixel already half transparent cannot come out more opaque than it went in.
  const img = imageOf([[255, 255, 255, 128]]);
  const out = K.key(img, { mode: 'black', low: 0, high: 1 });
  assert.ok(pixelAt(out.data, 0)[3] <= 129);
});

test('stats describe the result', () => {
  const img = imageOf([[0, 0, 0], [255, 255, 255], [128, 128, 128]]);
  const { stats } = K.key(img, { mode: 'black', low: 0.04, high: 0.92 });

  assert.strictEqual(stats.total, 3);
  assert.strictEqual(stats.transparent, 1);
  assert.strictEqual(stats.opaque, 1);
  assert.strictEqual(stats.partial, 1);
  assert.ok(Math.abs(stats.keptRatio - 2 / 3) < 1e-9);
});

test('output dimensions match the input', () => {
  const img = imageOf([[10, 10, 10], [20, 20, 20], [30, 30, 30], [40, 40, 40]], 2, 2);
  const out = K.key(img, { mode: 'black' });
  assert.strictEqual(out.data.width, 2);
  assert.strictEqual(out.data.height, 2);
});

test('an unknown mode falls back to black rather than throwing', () => {
  const out = K.key(imageOf([[255, 255, 255]]), { mode: 'nonsense' });
  assert.strictEqual(pixelAt(out.data, 0)[3], 255);
});

/* ── levels chosen from the image ───────────────────────────────────── */

/**
 * Why this exists: α is read off the brightest channel, so a subject that
 * never reaches full brightness keys short of opaque. A fixed default cannot
 * know that; the histogram does.
 */
test('suggested levels make a mid-toned subject fully opaque', () => {
  // An orange disc peaking at 232 — with the stock 0.92 ceiling it would
  // export permanently semi-transparent.
  const subject = [232, 80, 45];
  const pixels = [];
  for (let i = 0; i < 60; i++) pixels.push([0, 0, 0]);
  for (let i = 0; i < 40; i++) pixels.push(subject);

  const img = imageOf(pixels);
  const stock = K.key(img, { mode: 'black' });
  const tuned = K.key(img, { mode: 'black', ...K.suggestLevels(img, { mode: 'black' }) });

  assert.ok(pixelAt(stock.data, 99)[3] < 255, 'the stock ceiling leaves a veil');
  assert.strictEqual(pixelAt(tuned.data, 99)[3], 255, 'the suggestion clears it');
});

test('suggested levels still clear backdrop noise', () => {
  const pixels = [];
  for (let i = 0; i < 60; i++) pixels.push([5, 4, 6]); // noisy black plate
  for (let i = 0; i < 40; i++) pixels.push([200, 200, 200]);

  const img = imageOf(pixels);
  const out = K.key(img, { mode: 'black', ...K.suggestLevels(img, { mode: 'black' }) });
  assert.strictEqual(pixelAt(out.data, 0)[3], 0, 'noise must still go');
  assert.strictEqual(pixelAt(out.data, 99)[3], 255, 'subject must still be solid');
});

test('a suggestion never produces an inverted or degenerate band', () => {
  for (const pixels of [
    [[0, 0, 0]],
    [[255, 255, 255]],
    [[128, 128, 128], [0, 0, 0]],
    [[3, 3, 3], [4, 4, 4]],
  ]) {
    const { low, high } = K.suggestLevels(imageOf(pixels), { mode: 'black' });
    assert.ok(high > low, `high ${high} must exceed low ${low} for ${JSON.stringify(pixels)}`);
    assert.ok(low >= 0 && high <= 1, `out of range: ${low}..${high}`);
  }
});

test('rawAlpha reports the pre-levels distribution', () => {
  const alpha = K.rawAlpha(imageOf([[0, 0, 0], [255, 255, 255], [128, 128, 128]]), {
    mode: 'black',
  });
  assert.strictEqual(alpha.length, 3);
  assert.strictEqual(alpha[0], 0);
  assert.strictEqual(alpha[1], 1);
  assert.ok(Math.abs(alpha[2] - 128 / 255) < 1e-6);
});
