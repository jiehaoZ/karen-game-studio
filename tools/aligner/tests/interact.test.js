/** Coordinate conversion, hit testing and anchored zoom. */
const test = require('node:test');
const assert = require('node:assert');

const { loadApp, fakeImage } = require('./harness');

const App = loadApp(['state.js', 'interact.js']);
const S = App.state;
const I = App.interact;

const CANVAS = { width: 512, height: 512 };

function layer(imageW, imageH, overrides = {}) {
  return { id: 'l1', name: 'a.png', image: fakeImage(imageW, imageH), scale: 1, x: 0, y: 0, visible: true, ...overrides };
}

function stateWith(layers, overrides = {}) {
  return { ...S.DEFAULT_STATE, canvas: CANVAS, layers, selectedId: layers[0] ? layers[0].id : null, ...overrides };
}

test('screen coordinates divide back through the view scale', () => {
  const element = { getBoundingClientRect: () => ({ left: 100, top: 50 }) };
  // Canvas shown at half size: 60px across the screen is 120 canvas pixels.
  const point = I.toCanvasPoint({ clientX: 160, clientY: 90 }, element, 0.5);

  assert.deepStrictEqual(point, { x: 120, y: 80 });
});

/*
 * Selection-by-click is deliberately absent: layers here are stacked almost
 * exactly on top of each other, so a click has no defensible answer for which
 * one was meant, and a layer dragged off-canvas would become unreachable.
 * Choosing happens in the layer list; see handles.test.js for what the canvas
 * does instead.
 */

test('anchored zoom keeps the point under the cursor fixed', () => {
  const target = layer(200, 200);
  const anchor = { x: 300, y: 220 };

  const next = I.scaleAroundPoint(target, CANVAS, 2, anchor);
  const scaled = { ...target, ...next };

  // The anchor's position within the image should be unchanged by the zoom.
  const before = S.layerBounds(target, CANVAS);
  const after = S.layerBounds(scaled, CANVAS);
  const fractionBefore = {
    x: (anchor.x - before.left) / before.width,
    y: (anchor.y - before.top) / before.height,
  };
  const fractionAfter = {
    x: (anchor.x - after.left) / after.width,
    y: (anchor.y - after.top) / after.height,
  };

  assert.ok(Math.abs(fractionBefore.x - fractionAfter.x) < 1e-9);
  assert.ok(Math.abs(fractionBefore.y - fractionAfter.y) < 1e-9);
});

test('zooming on the exact centre introduces no drift', () => {
  const target = layer(200, 200);
  const next = I.scaleAroundPoint(target, CANVAS, 3, { x: 256, y: 256 });

  assert.strictEqual(next.x, 0);
  assert.strictEqual(next.y, 0);
  assert.strictEqual(next.scale, 3);
});

test('anchored zoom out is the inverse of zoom in', () => {
  const target = layer(200, 200, { x: 25, y: -10 });
  const anchor = { x: 180, y: 300 };

  const zoomedIn = { ...target, ...I.scaleAroundPoint(target, CANVAS, 2.5, anchor) };
  const backOut = I.scaleAroundPoint(zoomedIn, CANVAS, target.scale, anchor);

  assert.ok(Math.abs(backOut.x - target.x) < 1e-9);
  assert.ok(Math.abs(backOut.y - target.y) < 1e-9);
});
