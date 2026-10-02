/**
 * Compression search and filename handling.
 *
 * The search is driven against synthetic size/similarity curves rather than a
 * real encoder, so each case pins down one decision rule exactly. Real-encoder
 * behaviour is covered by tests/e2e.mjs.
 */
const test = require('node:test');
const assert = require('node:assert');

const { loadApp } = require('./harness');

const App = loadApp([
  'zip.js',
  'ssim.js',
  'quantize.js',
  'png.js',
  'compress.js',
  'render.js',
  'exporter.js',
]);
// The search lives in compress.js and the naming/packing in exporter.js; both
// surfaces are exercised here because they are two halves of one export.
const E = { ...App.compress, ...App.exporter };

/**
 * Fake canvas whose encoded size and measured similarity are both functions of
 * quality. `App.ssim.compare` is stubbed to read the similarity the harness
 * planted on the decoded stand-in.
 */
function fakeCanvas({ sizeAt, ssimAt = () => 1 }) {
  const calls = [];
  return {
    calls,
    width: 64,
    height: 64,
    getContext: () => ({
      getImageData: () => ({ __reference: true }),
      drawImage() {},
    }),
    toBlob(callback, mime, quality) {
      calls.push(quality);
      callback({ size: Math.max(1, Math.round(sizeAt(quality))), type: mime, __quality: quality });
    },
    __ssimAt: ssimAt,
  };
}

/** Drive the search with the similarity curve the test declared. */
async function search(canvas, mime, options) {
  return E.findQualityKnee(canvas, mime, {
    decode: async (blob) => ({ __quality: blob.__quality }),
    measure: (reference, candidate) => canvas.__ssimAt(candidate.__quality),
    ...options,
  });
}

test('stops one step above the point where damage becomes visible', async () => {
  const canvas = fakeCanvas({
    sizeAt: (q) => 1000 * q,
    // Indistinguishable down to 0.75, visibly damaged below it.
    ssimAt: (q) => (q >= 0.75 ? 0.999 : 0.97),
  });
  const result = await search(canvas, 'image/webp', { minSsim: 0.99 });

  assert.strictEqual(result.quality, 0.75);
  assert.strictEqual(result.stoppedBy, 'quality');
});

test('a stricter similarity floor stops earlier', async () => {
  const curve = { sizeAt: (q) => 1000 * q, ssimAt: (q) => 0.9 + q * 0.1 };
  const strict = await search(fakeCanvas(curve), 'image/webp', { minSsim: 0.995 });
  const loose = await search(fakeCanvas(curve), 'image/webp', { minSsim: 0.98 });

  assert.ok(strict.quality > loose.quality, `${strict.quality} vs ${loose.quality}`);
  assert.ok(strict.blob.size > loose.blob.size);
});

test('descends to the floor when quality never degrades', async () => {
  const canvas = fakeCanvas({ sizeAt: (q) => 1000 * q, ssimAt: () => 1 });
  const result = await search(canvas, 'image/webp', { minSsim: 0.99 });

  assert.strictEqual(result.quality, E.QUALITY_FLOOR);
  assert.strictEqual(result.stoppedBy, 'floor');
});

test('never probes above the ceiling or below the floor', async () => {
  const canvas = fakeCanvas({ sizeAt: (q) => 1000 * q });
  await search(canvas, 'image/jpeg', { minSsim: 0.5 });

  assert.ok(Math.max(...canvas.calls) <= E.QUALITY_CEILING);
  assert.ok(Math.min(...canvas.calls) >= E.QUALITY_FLOOR - 1e-9);
});

test('the ceiling sits below 1.0, where lossy encoders waste bytes', () => {
  assert.ok(E.QUALITY_CEILING < 1);
  assert.strictEqual(E.QUALITY_CEILING, 0.95);
});

test('a flat size curve still stops on the size brake', async () => {
  const canvas = fakeCanvas({ sizeAt: () => 5000, ssimAt: () => 1 });
  const result = await search(canvas, 'image/webp', { minSsim: 0.99, sizeThreshold: 0.01 });

  assert.strictEqual(result.stoppedBy, 'size');
  assert.strictEqual(result.quality, E.QUALITY_CEILING);
});

test('keeps compressing while a step still saves a kilobyte', async () => {
  // Every step sheds 2 KB off a 400 KB file: 0.5% or less, so the relative
  // brake alone would have stopped at the ceiling. 2 KB per file is not a
  // rounding error, so the search keeps going.
  const canvas = fakeCanvas({ sizeAt: (q) => 400000 - (0.95 - q) * 40000, ssimAt: () => 1 });
  const result = await search(canvas, 'image/webp', {
    minSsim: 0.99,
    sizeThreshold: 0.005,
    minAbsoluteSaving: 1024,
  });

  assert.strictEqual(result.stoppedBy, 'floor', 'ran the ladder out instead of braking early');
  assert.strictEqual(result.quality, E.QUALITY_FLOOR);
});

test('stops once a step gains under a kilobyte and under the relative floor', async () => {
  // 300 bytes a step: below 1 KB, and below 0.5% of a 400 KB file.
  const canvas = fakeCanvas({ sizeAt: (q) => 400000 - (0.95 - q) * 6000, ssimAt: () => 1 });
  const result = await search(canvas, 'image/webp', {
    minSsim: 0.99,
    sizeThreshold: 0.005,
    minAbsoluteSaving: 1024,
  });

  assert.strictEqual(result.stoppedBy, 'size');
  assert.strictEqual(result.quality, E.QUALITY_CEILING);
});

test('a small file is not stopped by the kilobyte brake alone', async () => {
  // A 6 KB icon: no single step will ever gain 1 KB, but each one takes 10%
  // off, which is exactly the case the relative test exists to keep alive.
  const canvas = fakeCanvas({ sizeAt: (q) => 6000 * Math.pow(0.9, (0.95 - q) / 0.05) });
  const result = await search(canvas, 'image/webp', {
    minSsim: 0.99,
    sizeThreshold: 0.005,
    minAbsoluteSaving: 1024,
  });

  assert.strictEqual(result.stoppedBy, 'floor');
  assert.ok(result.blob.size < 3000, `kept descending, ended at ${result.blob.size}`);
});

test('the absolute brake defaults to a kilobyte', () => {
  assert.strictEqual(E.MIN_ABSOLUTE_SAVING, 1024);
});

test('the palette search keeps stepping while a rung still saves a kilobyte', async () => {
  const canvas = fakePngCanvas({ losslessSize: 400000, uniques: 5000 });
  // Each rung takes 2 KB off a ~400 KB file — under 0.5%, over 1 KB.
  const sizes = [400000, 398000, 396000, 394000, 392000];
  const result = await searchPalette(canvas, {
    sizeAt: (colors) => sizes[E.PALETTE_LADDER.indexOf(colors)] ?? 392000,
    minSsim: 0.99,
    sizeThreshold: 0.005,
    minAbsoluteSaving: 1024,
  });

  assert.ok(result.trail.length > 2, `probed ${result.trail.length} rungs`);
});

test('damage at the ceiling itself is reported distinctly', async () => {
  const canvas = fakeCanvas({ sizeAt: (q) => 1000 * q, ssimAt: () => 0.5 });
  const result = await search(canvas, 'image/webp', { minSsim: 0.99 });

  assert.strictEqual(result.stoppedBy, 'ceiling');
  assert.strictEqual(result.quality, E.QUALITY_CEILING);
  assert.strictEqual(result.ssim, 0.5, 'reports what was measured, not the 1.0 it started from');
});

/**
 * Fake canvas for the PNG path.
 *
 * `toBlob` here only ever produces the plain truecolour baseline, since the
 * palette search encodes through App.png rather than the canvas. `uniques` is
 * how many distinct colours the stand-in histogram reports, which is what
 * decides where the ladder starts.
 */
function fakePngCanvas({ losslessSize = 100000, uniques = 5000 } = {}) {
  const calls = [];
  return {
    calls,
    uniques,
    width: 64,
    height: 64,
    getContext: () => ({
      getImageData: () => ({ __reference: true, width: 64, height: 64 }),
      drawImage() {},
    }),
    toBlob(callback, mime, quality) {
      calls.push({ mime, quality });
      callback({ size: losslessSize, type: mime });
    },
  };
}

/**
 * Drive the palette search against declared size/similarity curves, so each
 * case pins one decision rule rather than one encoder's behaviour.
 */
async function searchPalette(
  canvas,
  { sizeAt, ssimAt = () => 1, driftAt = () => 0, softShare = 0, ...options } = {}
) {
  return E.findPaletteKnee(canvas, {
    histogram: () => ({ size: canvas.uniques }),
    quantize: (imageData, colors) => ({ colors }),
    encodeIndexed: async (indexed) => ({
      size: Math.max(1, Math.round(sizeAt(indexed.colors))),
    }),
    expand: (indexed) => indexed,
    measure: (reference, candidate) => ssimAt(candidate.colors),
    measureAlphaDrift: (reference, candidate) => driftAt(candidate.colors),
    measureSoftShare: () => softShare,
    ...options,
  });
}

test('PNG searches palette size instead of encoding once', async () => {
  const canvas = fakePngCanvas({ losslessSize: 100000, uniques: 5000 });
  const result = await searchPalette(canvas, {
    sizeAt: (colors) => colors * 100,
    ssimAt: (colors) => (colors >= 64 ? 0.999 : 0.9),
    minSsim: 0.99,
  });

  assert.strictEqual(result.colors, 64, 'stops one rung above visible damage');
  assert.strictEqual(result.stoppedBy, 'quality');
  assert.ok(result.trail.length > 1, 'probed more than once');
  assert.strictEqual(result.quality, null, 'palette size is not a quality value');
});

test('rungs at or above the colours actually present are skipped', async () => {
  const canvas = fakePngCanvas({ losslessSize: 100000, uniques: 18 });
  const probed = [];
  await searchPalette(canvas, {
    sizeAt: (colors) => {
      probed.push(colors);
      return colors * 100;
    },
    minSsim: 0.99,
  });

  // An 18-colour image encodes identically at 256, 128 and 32. Probing those
  // would trip the size brake on a 0% saving and end the search before it
  // reached the rungs that actually shrink the file.
  assert.strictEqual(probed[0], 18, 'starts at the colour count, not 256');
  assert.ok(
    probed.every((colors) => colors <= 18),
    `probed a redundant rung: ${probed.join(',')}`
  );
});

test('a PNG that quantises no smaller than truecolour stays truecolour', async () => {
  const canvas = fakePngCanvas({ losslessSize: 1000, uniques: 5000 });
  const result = await searchPalette(canvas, {
    sizeAt: () => 90000, // every palette is worse than the plain PNG
    minSsim: 0.99,
  });

  assert.strictEqual(result.stoppedBy, 'lossless');
  assert.strictEqual(result.colors, null);
  assert.strictEqual(result.ssim, 1, 'the untouched file is exact by definition');
  assert.strictEqual(result.blob.size, 1000);
});

test('damage at the widest palette falls back to the lossless file', async () => {
  const canvas = fakePngCanvas({ losslessSize: 100000, uniques: 5000 });
  const result = await searchPalette(canvas, {
    sizeAt: (colors) => colors * 100,
    ssimAt: () => 0.5,
    minSsim: 0.99,
  });

  assert.strictEqual(result.stoppedBy, 'lossless');
  assert.strictEqual(result.ssim, 1);
});

test('a soft edge starting to stair-step stops the search, even at high SSIM', async () => {
  const canvas = fakePngCanvas({ losslessSize: 100000, uniques: 5000 });
  const result = await searchPalette(canvas, {
    sizeAt: (colors) => colors * 100,
    // SSIM stays happy the whole way down — which is exactly the real
    // behaviour that made this guard necessary, not a contrived curve.
    ssimAt: () => 0.999,
    driftAt: (colors) => (colors >= 64 ? 5 : 40),
    minSsim: 0.99,
    maxAlphaDrift: 16,
  });

  assert.strictEqual(result.stoppedBy, 'alpha');
  assert.strictEqual(result.colors, 64, 'kept the last palette that held the alpha ramp');
});

test('an image that is mostly soft edge is left as truecolour', async () => {
  const canvas = fakePngCanvas({ losslessSize: 100000, uniques: 5000 });
  const probed = [];
  const result = await searchPalette(canvas, {
    sizeAt: (colors) => {
      probed.push(colors);
      return colors * 10;
    },
    softShare: 0.42, // a radial fade: the ramp is the subject, not an edge
    maxSoftShare: 0.15,
  });

  assert.strictEqual(result.stoppedBy, 'soft');
  assert.strictEqual(result.colors, null);
  assert.deepStrictEqual(probed, [], 'decided before quantising anything');
});

test('an anti-aliased rim is not mistaken for a soft subject', async () => {
  const canvas = fakePngCanvas({ losslessSize: 100000, uniques: 5000 });
  const result = await searchPalette(canvas, {
    sizeAt: (colors) => colors * 10,
    softShare: 0.03, // measured range for a normal sprite is 0.6-3%
    maxSoftShare: 0.15,
  });

  assert.notStrictEqual(result.stoppedBy, 'soft');
  assert.ok(result.colors > 0, 'the palette path ran');
});

test('alpha drift is measured at a percentile, so outliers do not veto a palette', () => {
  const width = 100;
  const height = 10;
  const reference = { data: new Uint8ClampedArray(width * height * 4), width, height };
  const candidate = { data: new Uint8ClampedArray(width * height * 4), width, height };
  for (let i = 3; i < reference.data.length; i += 4) {
    reference.data[i] = 200;
    candidate.data[i] = 200;
  }
  // One pixel in a thousand moves a long way; everything else is untouched.
  candidate.data[3] = 100;

  assert.strictEqual(
    E.alphaDrift(reference, candidate, 0.999),
    0,
    'a single outlier sits inside the tolerated tail'
  );
  assert.strictEqual(
    E.alphaDrift(reference, candidate, 1),
    100,
    'at the maximum, that same pixel is the answer'
  );
});

test('the palette search stops on the size brake when the curve flattens', async () => {
  const canvas = fakePngCanvas({ losslessSize: 100000, uniques: 5000 });
  const result = await searchPalette(canvas, {
    sizeAt: () => 40000, // narrowing the palette buys nothing
    minSsim: 0.99,
    sizeThreshold: 0.01,
  });

  assert.strictEqual(result.stoppedBy, 'size');
  assert.strictEqual(result.colors, 256, 'kept the widest palette, which cost nothing');
});

test('the palette ladder descends and stays inside the byte-index limit', () => {
  assert.ok(E.PALETTE_LADDER.length > 1);
  assert.strictEqual(E.PALETTE_LADDER[0], 256, 'a palette index is one byte');
  for (let i = 1; i < E.PALETTE_LADDER.length; i++) {
    assert.ok(
      E.PALETTE_LADDER[i] < E.PALETTE_LADDER[i - 1],
      'the ladder must descend so the search can stop at the first failure'
    );
  }
  assert.ok(E.PALETTE_LADDER.every((c) => c >= 2 && c <= 256));
});

test('squeeze routes each format to the knob it actually has', async () => {
  const lossy = fakeCanvas({ sizeAt: (q) => 1000 * q });
  await E.squeeze(
    lossy,
    'image/webp',
    {
      decode: async (blob) => ({ __quality: blob.__quality }),
      measure: () => 1,
      minSsim: 0.99,
    },
    null
  );
  assert.ok(lossy.calls.some((q) => typeof q === 'number'), 'WebP got quality probes');

  const png = fakePngCanvas({ uniques: 5000 });
  await E.squeeze(
    png,
    'image/png',
    {
      histogram: () => ({ size: 5000 }),
      quantize: (imageData, colors) => ({ colors }),
      encodeIndexed: async (indexed) => ({ size: indexed.colors * 100 }),
      expand: (indexed) => indexed,
      measure: () => 1,
      measureAlphaDrift: () => 0,
      measureSoftShare: () => 0,
      minSsim: 0.99,
    },
    null
  );
  assert.ok(
    png.calls.every((call) => call.quality === undefined),
    'PNG was never handed a quality argument'
  );
});

test('the trail records size and similarity at every probe', async () => {
  const canvas = fakeCanvas({ sizeAt: (q) => 1000 * q, ssimAt: (q) => (q >= 0.85 ? 1 : 0.9) });
  const result = await search(canvas, 'image/webp', { minSsim: 0.99 });

  assert.ok(result.trail.length >= 2);
  assert.strictEqual(result.trail[0].quality, E.QUALITY_CEILING);
  assert.ok(result.trail.every((s) => typeof s.bytes === 'number' && typeof s.ssim === 'number'));
});

test('quality probes stay on clean 0.05 steps', async () => {
  const canvas = fakeCanvas({ sizeAt: (q) => 1000 * q });
  await search(canvas, 'image/webp', { minSsim: 0.5 });

  for (const q of canvas.calls) {
    assert.strictEqual(Math.round(q * 100) % 5, 0, `${q} is off the step grid`);
  }
});

test('sanitizeName strips extensions and path-hostile characters', () => {
  assert.strictEqual(E.sanitizeName('ball_tiny.png'), 'ball_tiny');
  assert.strictEqual(E.sanitizeName('a/b:c*d?.jpeg'), 'a_b_c_d_');
  assert.strictEqual(E.sanitizeName('球_大.webp'), '球_大');
  assert.strictEqual(E.sanitizeName('no-extension'), 'no-extension');
  assert.strictEqual(E.sanitizeName('.png'), 'layer', 'an empty stem still needs a name');
});

test('uniqueName disambiguates collisions', () => {
  const taken = new Set();
  assert.strictEqual(E.uniqueName('ball', 'webp', taken), 'ball.webp');
  assert.strictEqual(E.uniqueName('ball', 'webp', taken), 'ball-2.webp');
  assert.strictEqual(E.uniqueName('ball', 'webp', taken), 'ball-3.webp');
  assert.strictEqual(E.uniqueName('ball', 'jpg', taken), 'ball.jpg', 'extension is part of it');
});

test('formatBytes switches units at the right thresholds', () => {
  assert.strictEqual(E.formatBytes(512), '512 B');
  assert.strictEqual(E.formatBytes(1024), '1.0 KB');
  assert.strictEqual(E.formatBytes(1536), '1.5 KB');
  assert.strictEqual(E.formatBytes(1024 * 1024), '1.00 MB');
});

test('format table marks alpha support correctly', () => {
  assert.strictEqual(E.FORMATS['image/jpeg'].alpha, false);
  assert.strictEqual(E.FORMATS['image/webp'].alpha, true);
  assert.strictEqual(E.FORMATS['image/png'].lossy, false);
});

test('the smallest-file preset is allowed more alpha drift than the strict ones', () => {
  assert.strictEqual(E.maxAlphaDriftFor(0.995), E.MAX_ALPHA_DRIFT);
  assert.strictEqual(E.maxAlphaDriftFor(0.99), E.MAX_ALPHA_DRIFT);
  assert.strictEqual(E.maxAlphaDriftFor(0.98), E.MAX_ALPHA_DRIFT);
  assert.strictEqual(E.maxAlphaDriftFor(0.95), E.RELAXED_ALPHA_DRIFT);
  assert.ok(E.RELAXED_ALPHA_DRIFT > E.MAX_ALPHA_DRIFT);
});

test('the drift bound follows the similarity floor unless it is given outright', async () => {
  const canvas = fakePngCanvas({ losslessSize: 100000, uniques: 5000 });
  const run = (options) =>
    searchPalette(canvas, {
      sizeAt: (colors) => colors * 100,
      // Drift climbs as the palette narrows, crossing 16 at 64 colours and 32
      // at 24, so each bound stops at a different rung.
      driftAt: (colors) => (colors >= 96 ? 10 : colors >= 32 ? 20 : 40),
      ...options,
    });

  const strict = await run({ minSsim: 0.99 });
  const loose = await run({ minSsim: 0.95 });
  const forced = await run({ minSsim: 0.95, maxAlphaDrift: 16 });

  assert.strictEqual(strict.stoppedBy, 'alpha');
  assert.strictEqual(strict.colors, 96, 'the strict bound stops as soon as drift passes 16');
  assert.strictEqual(loose.colors, 32, 'the smallest-file bound rides drift 20 down further');
  assert.strictEqual(forced.colors, 96, 'an explicit bound overrides the preset');
});
