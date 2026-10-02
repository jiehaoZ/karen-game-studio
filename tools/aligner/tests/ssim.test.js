/** Structural similarity metric. */
const test = require('node:test');
const assert = require('node:assert');

const { loadApp } = require('./harness');

const App = loadApp(['ssim.js']);

/** Build an ImageData-alike from a per-pixel colour function. */
function image(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const SIZE = 64;
const gradient = () => image(SIZE, SIZE, (x, y) => [x * 4, y * 4, 128]);

test('identical images score exactly 1', () => {
  assert.strictEqual(App.ssim.compare(gradient(), gradient()), 1);
});

test('a solid image against its inverse scores near zero', () => {
  const black = image(SIZE, SIZE, () => [0, 0, 0]);
  const white = image(SIZE, SIZE, () => [255, 255, 255]);
  assert.ok(App.ssim.compare(black, white) < 0.05);
});

test('similarity falls as noise grows', () => {
  const reference = gradient();
  const scores = [2, 8, 32].map((amplitude) => {
    let seed = 1;
    const noisy = image(SIZE, SIZE, (x, y) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = ((seed % 1000) / 1000 - 0.5) * 2 * amplitude;
      return [x * 4 + n, y * 4 + n, 128 + n];
    });
    return App.ssim.compare(reference, noisy);
  });

  assert.ok(scores[0] > scores[1], `${scores[0]} should beat ${scores[1]}`);
  assert.ok(scores[1] > scores[2], `${scores[1]} should beat ${scores[2]}`);
  assert.ok(scores[0] > 0.9, 'faint noise stays close to the original');
});

test('a barely-shifted image still scores very high', () => {
  const reference = gradient();
  const shifted = image(SIZE, SIZE, (x, y) => [x * 4 + 1, y * 4 + 1, 129]);
  assert.ok(App.ssim.compare(reference, shifted) > 0.99);
});

/**
 * Mean SSIM scales the penalty by how much of the frame is affected: one
 * ruined 8x8 window out of 64 can only move the mean by about 1/64. That is
 * the correct behaviour for this tool, whose job is judging encoder artefacts
 * — those are spread across the whole frame, not concentrated in one block.
 */
test('localised damage is detected, scaled by the area it covers', () => {
  const reference = image(SIZE, SIZE, () => [128, 128, 128]);
  const damageOf = (blockSize) =>
    App.ssim.compare(
      reference,
      image(SIZE, SIZE, (x, y) => (x < blockSize && y < blockSize ? [0, 0, 0] : [128, 128, 128]))
    );

  const small = damageOf(8);
  const large = damageOf(32);

  assert.ok(small < 1, `a damaged block must register at all, got ${small}`);
  assert.ok(large < small, `wider damage must score worse: ${large} vs ${small}`);
  assert.ok(large < 0.9, `a quarter of the frame ruined should be obvious, got ${large}`);
});

test('whole-frame degradation is penalised far more than a single block', () => {
  const reference = image(SIZE, SIZE, (x, y) => [x * 4, y * 4, 128]);
  const oneBlock = image(SIZE, SIZE, (x, y) =>
    x < 8 && y < 8 ? [0, 0, 0] : [x * 4, y * 4, 128]
  );
  // Coarse quantisation everywhere, which is what a lossy encoder actually does.
  const quantised = image(SIZE, SIZE, (x, y) => [
    Math.round((x * 4) / 64) * 64,
    Math.round((y * 4) / 64) * 64,
    128,
  ]);

  assert.ok(App.ssim.compare(reference, quantised) < App.ssim.compare(reference, oneBlock));
});

test('is symmetric', () => {
  const a = gradient();
  const b = image(SIZE, SIZE, (x, y) => [x * 4 + 6, y * 4, 120]);
  assert.strictEqual(App.ssim.compare(a, b), App.ssim.compare(b, a));
});

test('rejects mismatched dimensions', () => {
  assert.throws(
    () => App.ssim.compare(gradient(), image(32, 32, () => [0, 0, 0])),
    /same size/
  );
});

test('handles sizes that are not a multiple of the window', () => {
  const a = image(70, 70, (x, y) => [x, y, 0]);
  const b = image(70, 70, (x, y) => [x, y, 0]);
  assert.strictEqual(App.ssim.compare(a, b), 1);
});
