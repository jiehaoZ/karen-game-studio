/**
 * What the keyer is allowed to cut away.
 *
 * The bug this exists to prevent: a panda has black eyes, and on a black plate
 * an eye solves to exactly the same α as the backdrop does. No amount of
 * threshold tuning separates them — per pixel they are identical. The only
 * thing that distinguishes them is where they sit, so these tests are all
 * about topology, not colour.
 */
const test = require('node:test');
const assert = require('node:assert');

const { loadApp } = require('./harness');

const App = loadApp(['key.js', 'ai.js']);
const K = App.key;

const PALETTE = {
  '.': [0, 0, 0],
  '#': [255, 255, 255],
  '+': [128, 128, 128],
};

/** Build ImageData from rows of single-character pixels. */
function grid(rows, palette = PALETTE) {
  const height = rows.length;
  const width = rows[0].length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach((row, y) => {
    Array.from(row).forEach((ch, x) => {
      const [r, g, b] = palette[ch];
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    });
  });
  return new ImageData(data, width, height);
}

const at = (rows, x, y) => y * rows[0].length + x;
const alphaAt = (img, index) => img.data[index * 4 + 3];
const rgbAt = (img, index) => [
  img.data[index * 4],
  img.data[index * 4 + 1],
  img.data[index * 4 + 2],
];

/** A white subject on a black plate, with two black eyes inside it. */
const PANDA = [
  '..........',
  '..........',
  '..######..',
  '..######..',
  '..##..##..',
  '..##..##..',
  '..######..',
  '..######..',
  '..........',
  '..........',
];

const EYE = at(PANDA, 4, 4);
const PLATE = at(PANDA, 0, 0);
const FUR = at(PANDA, 3, 3);

/* ── the default ────────────────────────────────────────────────────── */

test('a black eye inside the subject survives a black plate', () => {
  const out = K.key(grid(PANDA), { mode: 'black', low: 0.04, high: 0.92 }).data;

  assert.strictEqual(alphaAt(out, PLATE), 0, 'the plate must still go');
  assert.strictEqual(alphaAt(out, FUR), 255, 'the subject must still be solid');
  assert.strictEqual(alphaAt(out, EYE), 255, 'the eye is enclosed, so it stays');
});

test('a sealed hole keeps its own colour, not the subject around it', () => {
  const out = K.key(grid(PANDA), { mode: 'black', low: 0.04, high: 0.92 }).data;
  // Unmixing at α = 1 is the identity, so a black eye exports black.
  assert.deepStrictEqual(rgbAt(out, EYE), [0, 0, 0]);
});

test('outside is the default — no caller has to ask for it', () => {
  assert.strictEqual(K.DEFAULTS.scope, 'outside');
  const bare = K.key(grid(PANDA), { mode: 'black', low: 0.04, high: 0.92 }).data;
  const asked = K.key(grid(PANDA), {
    mode: 'black',
    low: 0.04,
    high: 0.92,
    scope: 'outside',
  }).data;
  assert.deepStrictEqual(Array.from(bare.data), Array.from(asked.data));
});

/* ── the other choice ───────────────────────────────────────────────── */

test('scope "all" still cuts the colour wherever it appears', () => {
  const out = K.key(grid(PANDA), { mode: 'black', low: 0.04, high: 0.92, scope: 'all' }).data;

  assert.strictEqual(alphaAt(out, PLATE), 0);
  assert.strictEqual(alphaAt(out, EYE), 0, 'this is the mode that does knock the eye out');
});

test('an unknown scope falls back to outside rather than throwing', () => {
  const out = K.key(grid(PANDA), { mode: 'black', low: 0.04, high: 0.92, scope: 'nonsense' }).data;
  assert.strictEqual(alphaAt(out, EYE), 255);
});

/* ── what "enclosed" means ──────────────────────────────────────────── */

/**
 * The distinction is connectivity, not "is it surrounded by subject on this
 * row". Backdrop that pushes into the subject from the frame edge is still
 * backdrop, however deep it goes.
 */
test('backdrop that reaches the frame edge is cut however far it reaches in', () => {
  const notched = [
    '..........',
    '..........',
    '..###.##..',
    '..###.##..',
    '..###.##..',
    '..######..',
    '..######..',
    '..........',
  ];
  const out = K.key(grid(notched), { mode: 'black', low: 0.04, high: 0.92 }).data;

  assert.strictEqual(alphaAt(out, at(notched, 5, 4)), 0, 'the notch connects to the top edge');
  assert.strictEqual(alphaAt(out, at(notched, 5, 6)), 255, 'the subject below it does not');
});

/**
 * A diagonal outline is one pixel thick in the direction the fill travels, so
 * eight-way connectivity would leak straight through it. Four-way does not,
 * and thin diagonal artwork is exactly where that matters.
 */
test('a diagonal outline holds the fill out', () => {
  const diamond = [
    '.......',
    '...#...',
    '..#.#..',
    '.#...#.',
    '..#.#..',
    '...#...',
    '.......',
  ];
  const out = K.key(grid(diamond), { mode: 'black', low: 0.04, high: 0.92 }).data;
  assert.strictEqual(alphaAt(out, at(diamond, 3, 3)), 255, 'the middle is enclosed');
  assert.strictEqual(alphaAt(out, at(diamond, 0, 0)), 0, 'the outside is not');
});

/**
 * The rim of a hole is a blend of hole and subject, so it lands mid-way and is
 * not itself a hole. Left behind it would export as a faint transparent
 * outline tracing every eye.
 */
test('the anti-aliased rim around a hole is taken with it', () => {
  const rimmed = [
    '.........',
    '.#######.',
    '.#######.',
    '.###+###.',
    '.##+.+##.',
    '.###+###.',
    '.#######.',
    '.#######.',
    '.........',
  ];
  const kept = K.key(grid(rimmed), { mode: 'black', low: 0, high: 1 }).data;
  const cut = K.key(grid(rimmed), { mode: 'black', low: 0, high: 1, scope: 'all' }).data;

  assert.strictEqual(alphaAt(cut, at(rimmed, 4, 3)), 128, 'the rim is half transparent per pixel');
  assert.strictEqual(alphaAt(kept, at(rimmed, 4, 3)), 255, 'and fully opaque once sealed');
  assert.strictEqual(alphaAt(kept, at(rimmed, 4, 4)), 255, 'hole core too');
});

/**
 * The feather must not creep outwards along the subject's own edge — that
 * edge is the whole reason this tool exists.
 */
test('a soft outer edge is untouched by sealing', () => {
  const soft = [
    '.........',
    '..+++++..',
    '..+###+..',
    '..+###+..',
    '..+###+..',
    '..+++++..',
    '.........',
  ];
  const kept = K.key(grid(soft), { mode: 'black', low: 0, high: 1 }).data;
  const cut = K.key(grid(soft), { mode: 'black', low: 0, high: 1, scope: 'all' }).data;

  assert.strictEqual(alphaAt(kept, at(soft, 2, 2)), 128, 'the outer ramp stays a ramp');
  assert.deepStrictEqual(
    Array.from(kept.data),
    Array.from(cut.data),
    'an image with nothing enclosed keys identically either way'
  );
});

/* ── the primitive ──────────────────────────────────────────────────── */

test('sealEnclosed leaves the caller’s array alone', () => {
  const alpha = Float32Array.from([0, 0, 0, 0, 1, 0, 0, 0, 0]);
  const before = Array.from(alpha);
  const out = K.sealEnclosed(alpha, 3, 3);

  assert.deepStrictEqual(Array.from(alpha), before);
  assert.notStrictEqual(out, alpha);
  assert.ok(out instanceof Float32Array, 'and hands back the same kind of array');
});

test('sealEnclosed works in byte units for the model masks', () => {
  // A 5x5 subject with one transparent pixel dead centre.
  const alpha = new Uint8ClampedArray(25).fill(255);
  alpha[12] = 0;
  const out = K.sealEnclosed(alpha, 5, 5, { opaque: 255 });

  assert.ok(out instanceof Uint8ClampedArray);
  assert.strictEqual(out[12], 255);
});

test('sealEnclosed survives degenerate sizes', () => {
  assert.strictEqual(K.sealEnclosed(new Float32Array(0), 0, 0).length, 0);
  assert.strictEqual(K.sealEnclosed(Float32Array.from([0]), 1, 1)[0], 0);
});

/* ── the model path uses the same switch ────────────────────────────── */

test('the AI mask gets its holes sealed too', () => {
  const image = grid([
    '#####',
    '#####',
    '##.##',
    '#####',
    '#####',
  ]);
  // The model is confident about the subject and dips to nothing in the middle
  // — a dark eye socket is exactly what that looks like.
  const mask = new Uint8ClampedArray(25).fill(255);
  mask[12] = 0;
  for (let i = 0; i < 5; i++) mask[i] = 0; // and the top row really is backdrop

  const sealed = App.ai.applyAlpha(image, mask, { low: 0, high: 1 });
  const raw = App.ai.applyAlpha(image, mask, { low: 0, high: 1, scope: 'all' });

  assert.strictEqual(alphaAt(sealed, 12), 255);
  assert.strictEqual(alphaAt(sealed, 2), 0, 'the real backdrop still goes');
  assert.strictEqual(alphaAt(raw, 12), 0);
});
