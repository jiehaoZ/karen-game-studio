/**
 * Colour quantisation.
 *
 * The properties worth pinning here are the ones that were wrong at some
 * point and produced plausible-looking output anyway: a palette that is exact
 * must actually be exact, refinement must not make the result worse, and
 * invisible pixels must not be allowed to buy palette entries.
 */
const test = require('node:test');
const assert = require('node:assert');

const { loadApp } = require('./harness');

const App = loadApp(['quantize.js']);
const Q = App.quantize;

/** Build an ImageData-shaped object from a list of RGBA quads. */
function image(width, height, pixelAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { data, width, height };
}

/** The pixels a decoder will produce from a quantiser result. */
function expand(result) {
  return image(result.width, result.height, (x, y) => {
    const o = result.indices[y * result.width + x] * 4;
    return [
      result.palette[o],
      result.palette[o + 1],
      result.palette[o + 2],
      result.palette[o + 3],
    ];
  });
}

/** Total weighted squared error between an image and its quantised form. */
function totalError(source, result) {
  const got = expand(result);
  let sum = 0;
  for (let i = 0; i < source.data.length; i += 4) {
    const sa = source.data[i + 3];
    const ga = got.data[i + 3];
    sum += Q.distance(
      Q.premultiply(source.data[i], sa),
      Q.premultiply(source.data[i + 1], sa),
      Q.premultiply(source.data[i + 2], sa),
      sa,
      Q.premultiply(got.data[i], ga),
      Q.premultiply(got.data[i + 1], ga),
      Q.premultiply(got.data[i + 2], ga),
      ga
    );
  }
  return sum;
}

const GRADIENT = image(48, 48, (x, y) => [x * 5, y * 5, (x + y) * 2, 255]);

test('a palette wide enough to hold every colour reproduces the image exactly', () => {
  // Six distinct colours, asked for 256.
  const source = image(12, 4, (x) => {
    const palette = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 255, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 0],
    ];
    return palette[x % 6];
  });

  const result = Q.reduce(source, 256);
  assert.strictEqual(result.exact, true);
  assert.strictEqual(result.colors, 6, 'no entries wasted on colours that are not there');
  assert.deepStrictEqual(Array.from(expand(result).data), Array.from(source.data));
});

test('the palette never exceeds the requested size', () => {
  for (const limit of [2, 3, 7, 16, 64, 256]) {
    const result = Q.reduce(GRADIENT, limit);
    assert.ok(result.colors <= limit, `asked for ${limit}, got ${result.colors}`);
    assert.ok(result.indices.every((i) => i < result.colors), 'every index is in range');
  }
});

test('transparent pixels collapse to a single entry whatever their RGB', () => {
  // Four different RGB values, all invisible, plus one opaque colour.
  const source = image(8, 1, (x) =>
    x < 4 ? [x * 60, 255 - x * 30, x * 11, 0] : [10, 20, 30, 255]
  );

  const result = Q.reduce(source, 256);
  assert.strictEqual(
    result.colors,
    2,
    'invisible pixels differing only in RGB are the same colour'
  );
});

test('refinement reduces total error rather than increasing it', () => {
  // This is a regression test with a specific history. The distance metric
  // used to scale colour error by min(alpha), which made it depend on both
  // operands and stopped it being a metric at all. The arithmetic centroid was
  // then no longer the error-minimising point, so k-means walked away from the
  // optimum: on a real export, two refinement passes took a 32-colour render
  // from SSIM 0.961 down to 0.838. Working in premultiplied space fixes it,
  // and this asserts the property that failure violated.
  const source = image(64, 64, (x, y) => [
    (x * 4) % 256,
    (y * 4) % 256,
    ((x + y) * 3) % 256,
    x < 8 ? x * 30 : 255,
  ]);

  for (const limit of [8, 16, 32]) {
    const coarse = Q.reduce(source, limit, { refinePasses: 0 });
    const refined = Q.reduce(source, limit, { refinePasses: 2 });
    assert.ok(
      totalError(source, refined) <= totalError(source, coarse),
      `refinement made ${limit} colours worse`
    );
  }
});

test('distance is a metric: symmetric, and zero only for identical colours', () => {
  assert.strictEqual(Q.distance(10, 20, 30, 40, 10, 20, 30, 40), 0);
  assert.strictEqual(
    Q.distance(10, 20, 30, 40, 50, 60, 70, 80),
    Q.distance(50, 60, 70, 80, 10, 20, 30, 40)
  );
  assert.ok(Q.distance(0, 0, 0, 255, 0, 0, 0, 0) > 0, 'alpha alone is a real difference');
});

test('premultiply and unpremultiply round trip at full opacity', () => {
  for (const value of [0, 1, 127, 128, 254, 255]) {
    assert.strictEqual(Q.premultiply(value, 255), value);
    assert.strictEqual(Q.unpremultiply(value, 255), value);
  }
  assert.strictEqual(Q.premultiply(255, 0), 0);
  assert.strictEqual(Q.unpremultiply(0, 0), 0, 'a fully transparent entry has no colour');
  assert.strictEqual(Q.unpremultiply(200, 10), 255, 'clamped rather than wrapped');
});

test('the palette is ordered with every non-opaque entry first', () => {
  const source = image(16, 16, (x, y) => [x * 15, y * 15, 128, (x * 16) % 256]);
  const { palette, colors } = Q.reduce(source, 32);

  let seenOpaque = false;
  for (let i = 0; i < colors; i++) {
    const alpha = palette[i * 4 + 3];
    if (alpha === 255) seenOpaque = true;
    else {
      assert.ok(!seenOpaque, 'a transparent entry appeared after an opaque one');
    }
  }
});

test('dithering is off unless asked for, and changes the result when asked for', () => {
  const flat = Q.reduce(GRADIENT, 4);
  const dithered = Q.reduce(GRADIENT, 4, { dither: true });

  assert.notDeepStrictEqual(
    Array.from(dithered.indices),
    Array.from(flat.indices),
    'the dithered mapping should differ'
  );
  assert.deepStrictEqual(
    Array.from(Q.reduce(GRADIENT, 4, { dither: false }).indices),
    Array.from(flat.indices),
    'the default is no dithering'
  );
});

test('dithering is skipped when the palette is already exact', () => {
  const source = image(8, 8, (x) => [x % 2 ? 255 : 0, 0, 0, 255]);
  const dithered = Q.reduce(source, 256, { dither: true });

  // There is no error to diffuse, so asking for dithering must not invent any.
  assert.strictEqual(dithered.exact, true);
  assert.deepStrictEqual(Array.from(expand(dithered).data), Array.from(source.data));
});

test('a precomputed histogram gives the same answer as building one', () => {
  const histogram = Q.histogram(GRADIENT);
  for (const limit of [4, 16, 64]) {
    assert.deepStrictEqual(
      Array.from(Q.reduce(GRADIENT, limit, { histogram }).palette),
      Array.from(Q.reduce(GRADIENT, limit).palette),
      `reusing the histogram changed the ${limit}-colour palette`
    );
  }
});

test('a single-colour image needs a single-colour palette', () => {
  const source = image(10, 10, () => [7, 8, 9, 255]);
  const result = Q.reduce(source, 256);

  assert.strictEqual(result.colors, 1);
  assert.ok(result.indices.every((i) => i === 0));
  assert.deepStrictEqual(Array.from(result.palette), [7, 8, 9, 255]);
});

test('narrowing the palette never improves fidelity', () => {
  // Monotonicity is what lets the search stop at the first rung that fails
  // instead of having to probe the whole ladder.
  let previous = 0;
  for (const limit of [64, 32, 16, 8, 4, 2]) {
    const error = totalError(GRADIENT, Q.reduce(GRADIENT, limit));
    assert.ok(error >= previous, `${limit} colours fit better than the wider palette`);
    previous = error;
  }
});

test('a huge nearly-flat region does not eat the palette', () => {
  // The failure this pins down: ranked by *current* error, a 90%-of-the-frame
  // region that varies by one unit outweighs a small region that swings across
  // the gamut, purely on pixel count. It then gets split again and again, the
  // mapping alternates between near-identical entries, and the index stream
  // turns from a flat run into noise deflate cannot pack.
  const ocean = [100, 200, 250, 255];
  const source = image(64, 64, (x, y) => {
    if (y >= 8) return [ocean[0] + ((x + y) % 2), ocean[1], ocean[2] - (x % 2), 255];
    // A strip of genuinely different colours, one eighth of the frame.
    return [(x * 4) % 256, 255 - ((x * 4) % 256), (y * 30) % 256, 255];
  });

  const result = Q.reduce(source, 8);
  const nearOcean = [];
  for (let i = 0; i < result.colors; i++) {
    const o = i * 4;
    const near =
      Math.abs(result.palette[o] - ocean[0]) <= 4 &&
      Math.abs(result.palette[o + 1] - ocean[1]) <= 4 &&
      Math.abs(result.palette[o + 2] - ocean[2]) <= 4;
    if (near) nearOcean.push(i);
  }

  assert.ok(
    nearOcean.length <= 2,
    `${nearOcean.length} of ${result.colors} entries landed inside the flat region`
  );
});

test('a split is ranked by the error it removes, not the error it holds', () => {
  // Two clusters: a heavy one that is already its own mean, and a light one
  // that is spread out. Splitting the heavy one buys nothing.
  const hist = {
    r: Uint8Array.from([10, 10, 10, 200]),
    g: Uint8Array.from([10, 10, 10, 200]),
    b: Uint8Array.from([10, 11, 10, 200]),
    a: Uint8Array.from([255, 255, 255, 255]),
    count: Float64Array.from([5000, 5000, 5000, 20]),
    size: 4,
  };
  const order = Uint32Array.from([0, 1, 2, 3]);
  const stats = { error: 1e9, axis: 0, total: 15020 };
  const plan = Q.planSplit(hist, order, 0, 4, stats);

  // The only cut worth making separates the outlier, wherever it sorted to.
  assert.ok(plan.at === 3 || plan.at === 1, `split at ${plan.at}`);
  assert.ok(plan.left.total === 20 || plan.right.total === 20, 'the outlier ends up alone');
});

test('splitting stops when no cut removes any error', () => {
  // Four pixels, three colours, room for sixteen entries: the fourth split has
  // nothing left to separate and must not invent an entry.
  const flat = image(2, 2, (x, y) => (x + y === 0 ? [9, 9, 9, 255] : [200, 30, 30, 255]));
  const result = Q.reduce(flat, 16);

  assert.strictEqual(result.colors, 2);
  assert.ok(result.exact);
});
