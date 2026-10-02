/** Alignment snapping. */
const test = require('node:test');
const assert = require('node:assert');

const { loadApp, fakeImage } = require('./harness');

const App = loadApp(['state.js', 'snap.js']);
const S = App.state;
const N = App.snap;

const CANVAS = { width: 400, height: 400 };
const RADIUS = 6;

/** A 100x100 layer; centred means x=0, y=0. */
function scene(overrides = {}, extraLayers = []) {
  const layer = {
    id: 'l1',
    name: 'a.png',
    image: fakeImage(100, 100),
    scale: 1,
    x: 0,
    y: 0,
    visible: true,
    ...overrides,
  };
  return {
    state: {
      ...S.DEFAULT_STATE,
      canvas: CANVAS,
      layers: [layer, ...extraLayers],
      selectedId: 'l1',
      guide: { enabled: false, shape: 'box', percent: 70 },
    },
    layer,
  };
}

const snap = (ctx, intended, radius = RADIUS) =>
  N.apply(ctx.state, ctx.layer, intended, radius);

test('a near-centre position snaps exactly to centre', () => {
  const ctx = scene();
  const result = snap(ctx, { x: 3, y: -2 });

  assert.strictEqual(result.x, 0);
  assert.strictEqual(result.y, 0);
});

test('the snap is reported so it can be drawn', () => {
  const result = snap(scene(), { x: 3, y: -2 });

  assert.strictEqual(result.lines.length, 2);
  assert.ok(result.lines.some((l) => l.axis === 'vertical' && l.value === 200));
  assert.ok(result.lines.some((l) => l.axis === 'horizontal' && l.value === 200));
  assert.ok(result.lines.every((l) => l.kind === 'canvas-center'));
});

test('beyond the radius nothing is touched', () => {
  const result = snap(scene(), { x: 40, y: 40 });

  assert.strictEqual(result.x, 40);
  assert.strictEqual(result.y, 40);
  assert.strictEqual(result.lines.length, 0);
});

test('each axis snaps independently', () => {
  const result = snap(scene(), { x: 2, y: 60 });

  assert.strictEqual(result.x, 0, 'x was near centre');
  assert.strictEqual(result.y, 60, 'y was not');
  assert.strictEqual(result.lines.length, 1);
  assert.strictEqual(result.lines[0].axis, 'vertical');
});

/**
 * The property that keeps a snap from becoming a trap: because the intended
 * position is always the raw pointer offset, walking past the radius releases
 * the layer. Feeding the snapped result back in would re-snap forever.
 */
test('dragging past the radius releases cleanly', () => {
  const ctx = scene();
  const path = [0, 2, 4, 6, 8, 20].map((x) => snap(ctx, { x, y: 200 }).x);

  assert.deepStrictEqual(path.slice(0, 4), [0, 0, 0, 0], 'held while inside');
  assert.strictEqual(path[4], 8, 'released once outside');
  assert.strictEqual(path[5], 20);
});

test('snapping is idempotent at rest', () => {
  const ctx = scene();
  const once = snap(ctx, { x: 3, y: 3 });
  const twice = snap(ctx, { x: once.x, y: once.y });

  assert.strictEqual(twice.x, once.x);
  assert.strictEqual(twice.y, once.y);
});

test('a zero radius disables snapping entirely', () => {
  const result = snap(scene(), { x: 1, y: 1 }, 0);

  assert.strictEqual(result.x, 1);
  assert.strictEqual(result.y, 1);
  assert.strictEqual(result.lines.length, 0);
});

test('the leading and trailing edges snap, not just the centre', () => {
  // 100px layer, canvas 400 wide. Left edge lands on 0 when x = -150.
  const ctx = scene();
  const result = snap(ctx, { x: -148, y: 300 });

  assert.strictEqual(result.x, -150, 'left edge pulled onto the canvas edge');
  assert.ok(result.lines.some((l) => l.kind === 'canvas-edge'));
});

/*
 * Guide coordinates chosen so no other candidate is within reach: at 30% the
 * box spans 140..260, and a 100px layer sitting on its left edge puts the
 * layer's own centre and right edge at 190 and 240 — both clear of the canvas
 * centre at 200 by more than the radius.
 */
test('the guide box is a snap target when shown', () => {
  const ctx = scene();
  ctx.state = { ...ctx.state, guide: { enabled: true, shape: 'box', percent: 30 } };
  const result = snap(ctx, { x: -7, y: 300 });

  assert.strictEqual(result.x, -10, 'left edge pulled onto the guide edge at 140');
  assert.ok(result.lines.some((l) => l.kind === 'guide'));
});

test('the guide box is ignored when hidden', () => {
  const ctx = scene();
  const result = snap(ctx, { x: -7, y: 300 });
  assert.strictEqual(result.x, -7);
  assert.strictEqual(result.lines.length, 0);
});

test('a trailing edge can align to the canvas centre', () => {
  // 100px layer: its right edge reaches 200 when x = -50.
  const result = snap(scene(), { x: -47, y: 300 });
  assert.strictEqual(result.x, -50);
  assert.ok(result.lines.some((l) => l.kind === 'canvas-center'));
});

test('other layers offer their edges and centre', () => {
  const other = {
    id: 'l2',
    name: 'b.png',
    image: fakeImage(60, 60),
    scale: 1,
    x: 80,
    y: 0,
    visible: true,
  };
  const ctx = scene({}, [other]);
  // l2 is centred at canvas x = 200 + 80 = 280. Our centre reaches it at x=80.
  const result = snap(ctx, { x: 78, y: 300 });

  assert.strictEqual(result.x, 80);
  assert.ok(result.lines.some((l) => l.kind === 'layer'));
});

test('hidden layers are not snap targets', () => {
  const hidden = {
    id: 'l2',
    name: 'b.png',
    image: fakeImage(60, 60),
    scale: 1,
    x: 80,
    y: 0,
    visible: false,
  };
  const ctx = scene({}, [hidden]);
  assert.strictEqual(snap(ctx, { x: 78, y: 300 }).x, 78);
});

test('a layer never snaps to itself', () => {
  const ctx = scene();
  const lines = N.snapLines(ctx.state, 'l1');
  // Own centre is canvas centre, which is a legitimate target from the canvas
  // itself — but no line should be contributed by the moving layer.
  assert.ok(lines.vertical.every((l) => l.kind !== 'layer'));
  assert.ok(lines.horizontal.every((l) => l.kind !== 'layer'));
});

test('the nearest candidate wins', () => {
  const ctx = scene();
  ctx.state = { ...ctx.state, guide: { enabled: true, shape: 'box', percent: 99 } };
  // Canvas centre (200) is far; nothing else is within reach of x = 0.
  const result = snap(ctx, { x: 1, y: 300 });
  assert.strictEqual(result.x, 0, 'centre is the closest');
});

test('significant targets win ties against incidental ones', () => {
  // Put another layer's centre exactly on the canvas centre, then approach it.
  const twin = {
    id: 'l2',
    name: 'b.png',
    image: fakeImage(40, 40),
    scale: 1,
    x: 0,
    y: 0,
    visible: true,
  };
  const ctx = scene({}, [twin]);
  const result = snap(ctx, { x: 2, y: 2 });

  assert.strictEqual(result.x, 0);
  assert.ok(
    result.lines.every((l) => l.kind === 'canvas-center'),
    'the canvas centre is named, not the coincident layer edge'
  );
});

test('scaled layers snap on their rendered size', () => {
  const ctx = scene({ scale: 2 }); // 200x200 rendered
  // Left edge is at 200 + x - 100. It reaches canvas 0 at x = -100.
  const result = snap(ctx, { x: -97, y: 300 });
  assert.strictEqual(result.x, -100);
});

test('the radius scales with the view, as callers pass it in', () => {
  const ctx = scene();
  assert.strictEqual(snap(ctx, { x: 9, y: 300 }, 6).x, 9, 'outside a 6px reach');
  assert.strictEqual(snap(ctx, { x: 9, y: 300 }, 20).x, 0, 'inside a 20px reach');
});

test('bestSnap returns null when nothing is close', () => {
  assert.strictEqual(N.bestSnap(0, 10, [{ value: 500, kind: 'x' }], 6), null);
});

/*
 * Resize snapping. A resize has one degree of freedom, so unlike a move it can
 * satisfy at most one line: the scale that puts the dragged corner on it.
 */

test('a resize snaps the dragged corner onto a line', () => {
  const ctx = scene();
  // Layer spans 150..250 at scale 1. Drag the se corner (250,250) outward,
  // anchored on nw (150,150). The canvas edge at 400 is the target.
  const anchor = { x: 150, y: 150 };
  const corner0 = { x: 250, y: 250 };
  // A scale of 2.45 puts the corner at 150 + 100*2.45 = 395, five short of 400.
  const result = N.applyResize(ctx.state, 'l1', anchor, corner0, 1, 2.45, RADIUS);

  assert.strictEqual(result.scale, 2.5, 'solved for the scale that lands on 400');
  assert.strictEqual(result.lines.length, 1, 'one axis only — scale is one number');
  assert.strictEqual(result.lines[0].kind, 'canvas-edge');
});

test('a resize outside the radius is left alone', () => {
  const ctx = scene();
  const result = N.applyResize(
    ctx.state,
    'l1',
    { x: 150, y: 150 },
    { x: 250, y: 250 },
    1,
    1.7,
    RADIUS
  );
  assert.strictEqual(result.scale, 1.7);
  assert.strictEqual(result.lines.length, 0);
});

test('a resize can snap the corner to the guide box', () => {
  const ctx = scene();
  ctx.state = { ...ctx.state, guide: { enabled: true, shape: 'box', percent: 50 } };
  // Guide spans 100..300. Anchored at nw (150,150), the corner reaches 300
  // at scale 1.5.
  const result = N.applyResize(
    ctx.state,
    'l1',
    { x: 150, y: 150 },
    { x: 250, y: 250 },
    1,
    1.47,
    RADIUS
  );

  assert.ok(Math.abs(result.scale - 1.5) < 1e-9, `got ${result.scale}`);
  assert.strictEqual(result.lines[0].kind, 'guide');
});

test('a resize never mirrors the layer through its anchor', () => {
  const ctx = scene();
  // A line behind the anchor would need a negative scale factor.
  const result = N.applyResize(
    ctx.state,
    'l1',
    { x: 250, y: 250 },
    { x: 260, y: 260 },
    1,
    0.02,
    200 // absurdly generous radius, to force candidates into range
  );
  assert.ok(result.scale > 0, `scale must stay positive, got ${result.scale}`);
});

test('a corner on the anchor axis cannot be steered and is skipped', () => {
  const ctx = scene();
  // corner0.x === anchor.x: no scale changes its x, so only y can snap.
  const result = N.applyResize(
    ctx.state,
    'l1',
    { x: 200, y: 150 },
    { x: 200, y: 250 },
    1,
    1.97,
    RADIUS
  );

  assert.ok(result.lines.every((l) => l.axis === 'horizontal'));
});

test('a zero radius disables resize snapping', () => {
  const ctx = scene();
  const result = N.applyResize(ctx.state, 'l1', { x: 150, y: 150 }, { x: 250, y: 250 }, 1, 2.45, 0);
  assert.strictEqual(result.scale, 2.45);
});

test('resize snapping picks the nearest of several candidates', () => {
  const ctx = scene();
  ctx.state = { ...ctx.state, guide: { enabled: true, shape: 'box', percent: 50 } };
  // Guide edge 300 (scale 1.5) and canvas centre 200 (scale 0.5) both exist;
  // starting near 1.5 must choose the guide.
  const result = N.applyResize(
    ctx.state,
    'l1',
    { x: 150, y: 150 },
    { x: 250, y: 250 },
    1,
    1.52,
    RADIUS
  );
  assert.ok(Math.abs(result.scale - 1.5) < 1e-9);
});
