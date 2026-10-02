/** Backdrop detection, and the "is this even a flat backdrop" verdict. */
const test = require('node:test');
const assert = require('node:assert');

const { loadApp } = require('./harness');

const App = loadApp(['detect.js']);
const D = App.detect;

/** An image with a flat border and an optional different centre. */
function plate(size, bg, subject = null, inset = 0.3) {
  const data = new Uint8ClampedArray(size * size * 4);
  const lo = Math.round(size * inset);
  const hi = size - lo;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = subject && x >= lo && x < hi && y >= lo && y < hi;
      const c = inside ? subject : bg;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, size, size);
}

/** An image whose border varies — a photograph stands in for this. */
function noisyPlate(size, base, amplitude) {
  const data = new Uint8ClampedArray(size * size * 4);
  let seed = 7;
  for (let i = 0; i < size * size; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = ((seed % 1000) / 1000 - 0.5) * 2 * amplitude;
    data[i * 4] = base[0] + n;
    data[i * 4 + 1] = base[1] + n;
    data[i * 4 + 2] = base[2] + n;
    data[i * 4 + 3] = 255;
  }
  return new ImageData(data, size, size);
}

/* ── mode selection ─────────────────────────────────────────────────── */

test('a black plate is recognised', () => {
  const r = D.detect(plate(40, [0, 0, 0], [255, 200, 100]));
  assert.strictEqual(r.mode, 'black');
  assert.strictEqual(r.reason, 'black-plate');
  assert.ok(r.flat);
});

test('a white plate is recognised', () => {
  const r = D.detect(plate(40, [255, 255, 255], [30, 60, 90]));
  assert.strictEqual(r.mode, 'white');
  assert.strictEqual(r.reason, 'white-plate');
});

test('a green plate falls to colour mode and reports the colour', () => {
  const green = [0, 177, 64];
  const r = D.detect(plate(40, green, [220, 90, 40]));

  assert.strictEqual(r.mode, 'color');
  assert.ok(Math.abs(r.bgColor[0] - green[0]) <= 2);
  assert.ok(Math.abs(r.bgColor[1] - green[1]) <= 2);
  assert.ok(Math.abs(r.bgColor[2] - green[2]) <= 2);
});

test('a near-black plate still counts as black', () => {
  assert.strictEqual(D.detect(plate(40, [9, 7, 11], [255, 255, 255])).mode, 'black');
});

test('a plate too far from black is treated as a colour, not forced', () => {
  assert.strictEqual(D.detect(plate(40, [70, 66, 62], [255, 255, 255])).mode, 'color');
});

/* ── the verdict that matters ───────────────────────────────────────── */

test('a flat backdrop reports high flatness', () => {
  assert.ok(D.detect(plate(40, [0, 0, 0], [255, 255, 255])).flatness > 0.9);
});

/**
 * The routing decision. A varied border means there is no single B to
 * subtract, so unmixing cannot work and the caller should reach for the model
 * instead. Getting this wrong wastes the user's time on sliders that cannot
 * help.
 */
test('a noisy border is reported as not flat', () => {
  const r = D.detect(noisyPlate(40, [120, 110, 100], 60));
  assert.ok(!r.flat, `flatness ${r.flatness}`);
  assert.strictEqual(r.reason, 'not-flat');
});

test('mild compression noise does not disqualify a plate', () => {
  const r = D.detect(noisyPlate(40, [4, 4, 4], 3));
  assert.ok(r.flat, `flatness ${r.flatness} should survive light noise`);
  assert.strictEqual(r.mode, 'black');
});

test('flatness falls monotonically as the border varies more', () => {
  const scores = [2, 10, 30, 70].map(
    (amp) => D.detect(noisyPlate(40, [120, 120, 120], amp)).flatness
  );
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] <= scores[i - 1], `flatness must not rise: ${scores}`);
  }
});

test('a gradient border is not flat', () => {
  const size = 40;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const v = (x / size) * 255;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  assert.ok(!D.detect(new ImageData(data, size, size)).flat);
});

/* ── sampling ───────────────────────────────────────────────────────── */

test('the subject does not drag the detected colour', () => {
  // A large bright subject over most of the frame, black border.
  const r = D.detect(plate(60, [0, 0, 0], [255, 255, 255], 0.12));
  assert.strictEqual(r.mode, 'black');
  assert.ok(Math.max(...r.bgColor) < 20, `got ${r.bgColor}`);
});

test('already-transparent pixels are not counted as backdrop', () => {
  const size = 30;
  const data = new Uint8ClampedArray(size * size * 4);
  // Fully transparent everywhere except a green ring near the edge.
  for (let i = 0; i < size * size; i++) {
    data[i * 4 + 1] = 177;
    data[i * 4 + 3] = 0;
  }
  const r = D.detect(new ImageData(data, size, size));
  assert.strictEqual(r.reason, 'empty');
});

test('the eyedropper reads the pixel under the cursor', () => {
  const img = plate(20, [0, 0, 0], [10, 200, 30]);
  assert.deepStrictEqual(D.sampleAt(img, 10, 10), [10, 200, 30]);
  assert.deepStrictEqual(D.sampleAt(img, 0, 0), [0, 0, 0]);
});

test('the eyedropper clamps to the image rather than reading past it', () => {
  const img = plate(20, [5, 5, 5], null);
  assert.deepStrictEqual(D.sampleAt(img, -50, -50), [5, 5, 5]);
  assert.deepStrictEqual(D.sampleAt(img, 9999, 9999), [5, 5, 5]);
});

test('borderPixels samples the frame, not the middle', () => {
  const img = plate(40, [0, 0, 0], [255, 255, 255], 0.3);
  const samples = D.borderPixels(img);
  assert.ok(samples.length > 0);
  assert.ok(samples.every((p) => p[0] === 0), 'no subject pixels should appear');
});

test('mean averages the samples', () => {
  assert.deepStrictEqual(D.mean([[0, 0, 0], [200, 100, 50]]), [100, 50, 25]);
});
