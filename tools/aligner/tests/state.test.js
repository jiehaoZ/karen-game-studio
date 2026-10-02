/** State transitions and layout maths. */
const test = require('node:test');
const assert = require('node:assert');

const { loadApp, fakeImage } = require('./harness');

const App = loadApp(['state.js']);
const S = App.state;

const CANVAS = { width: 512, height: 512 };

function stateWith(images) {
  return S.addLayers(S.DEFAULT_STATE, images.map((img, i) => ({ image: img, name: `img${i}.png` })));
}

test('imported layers are fitted inside the canvas and centred', () => {
  const state = stateWith([fakeImage(1024, 1024), fakeImage(200, 400)]);

  assert.strictEqual(state.layers.length, 2);
  assert.strictEqual(state.layers[0].scale, 0.5);
  assert.strictEqual(state.layers[1].scale, 512 / 400);
  assert.ok(state.layers.every((l) => l.x === 0 && l.y === 0));
});

test('first import becomes the selection, later ones do not steal it', () => {
  const first = stateWith([fakeImage(100, 100)]);
  const selected = first.selectedId;
  const second = S.addLayers(first, [{ image: fakeImage(50, 50), name: 'b.png' }]);
  assert.strictEqual(second.selectedId, selected);
});

test('layerBounds places a scaled layer around the canvas centre', () => {
  const state = stateWith([fakeImage(100, 50)]);
  const scaled = S.setScale(state, state.layers[0].id, 2);
  const b = S.layerBounds(scaled.layers[0], CANVAS);

  assert.deepStrictEqual(
    { width: b.width, height: b.height, left: b.left, top: b.top },
    { width: 200, height: 100, left: 156, top: 206 }
  );
});

test('offsets shift the layer from the centre', () => {
  const state = stateWith([fakeImage(100, 100)]);
  const moved = S.updateLayer(state, state.layers[0].id, { scale: 1, x: 30, y: -20 });
  const b = S.layerBounds(moved.layers[0], CANVAS);

  assert.strictEqual(b.left, 512 / 2 + 30 - 50);
  assert.strictEqual(b.top, 512 / 2 - 20 - 50);
});

test('updates never mutate the previous state', () => {
  const before = stateWith([fakeImage(100, 100)]);
  const id = before.layers[0].id;
  const snapshot = { ...before.layers[0] };

  const after = S.setScale(before, id, 3);

  assert.strictEqual(before.layers[0].scale, snapshot.scale);
  assert.notStrictEqual(after.layers, before.layers);
  assert.notStrictEqual(after.layers[0], before.layers[0]);
  assert.strictEqual(after.layers[0].scale, 3);
});

test('scale is clamped to sane bounds', () => {
  const state = stateWith([fakeImage(100, 100)]);
  const id = state.layers[0].id;

  assert.strictEqual(S.setScale(state, id, 1e6).layers[0].scale, S.MAX_SCALE);
  assert.strictEqual(S.setScale(state, id, -5).layers[0].scale, S.MIN_SCALE);
  assert.strictEqual(S.setScale(state, id, 0).layers[0].scale, S.MIN_SCALE);
});

test('canvas size is clamped and rounded', () => {
  assert.deepStrictEqual(S.setCanvasSize(S.DEFAULT_STATE, 1024.6, 256.2).canvas, {
    width: 1025,
    height: 256,
  });
  assert.strictEqual(S.setCanvasSize(S.DEFAULT_STATE, 99999, 512).canvas.width, S.MAX_CANVAS);
  assert.strictEqual(S.setCanvasSize(S.DEFAULT_STATE, 1, 512).canvas.width, S.MIN_CANVAS);
  assert.strictEqual(S.setCanvasSize(S.DEFAULT_STATE, NaN, 512).canvas.width, S.MIN_CANVAS);
});

test('removing the selected layer promotes another', () => {
  const state = stateWith([fakeImage(10, 10), fakeImage(20, 20)]);
  const after = S.removeLayer(state, state.selectedId);

  assert.strictEqual(after.layers.length, 1);
  assert.strictEqual(after.selectedId, after.layers[0].id);
});

test('removing the last layer clears the selection', () => {
  const state = stateWith([fakeImage(10, 10)]);
  assert.strictEqual(S.removeLayer(state, state.selectedId).selectedId, null);
});

test('removing an unselected layer leaves the selection alone', () => {
  const state = stateWith([fakeImage(10, 10), fakeImage(20, 20)]);
  const other = state.layers[1].id;
  assert.strictEqual(S.removeLayer(state, other).selectedId, state.selectedId);
});

test('nudge accumulates offsets', () => {
  const state = stateWith([fakeImage(10, 10)]);
  const id = state.selectedId;
  const moved = S.nudge(S.nudge(state, id, 5, 0), id, 0, -3);

  assert.deepStrictEqual({ x: moved.layers[0].x, y: moved.layers[0].y }, { x: 5, y: -3 });
});

test('reset restores the imported fit', () => {
  const state = stateWith([fakeImage(1024, 1024)]);
  const id = state.selectedId;
  const messy = S.updateLayer(state, id, { scale: 7, x: 100, y: -80 });
  const reset = S.resetLayer(messy, id);

  assert.deepStrictEqual(
    { scale: reset.layers[0].scale, x: reset.layers[0].x, y: reset.layers[0].y },
    { scale: 0.5, x: 0, y: 0 }
  );
});

test('match copies the selected scale to every other layer but not offsets', () => {
  const state = stateWith([fakeImage(100, 100), fakeImage(400, 400), fakeImage(50, 50)]);
  const id = state.layers[0].id;
  const posed = S.updateLayer(S.setScale(state, id, 1.75), state.layers[1].id, { x: 40 });

  const matched = S.matchScaleToSelected({ ...posed, selectedId: id });

  assert.ok(matched.layers.every((l) => l.scale === 1.75));
  assert.strictEqual(matched.layers[1].x, 40, 'offsets are left alone');
});

test('match is a no-op with nothing selected', () => {
  const state = { ...stateWith([fakeImage(10, 10)]), selectedId: null };
  assert.strictEqual(S.matchScaleToSelected(state), state);
});

test('fitScale is limited by the tighter axis', () => {
  assert.strictEqual(S.fitScale(fakeImage(1000, 100), CANVAS), 512 / 1000);
  assert.strictEqual(S.fitScale(fakeImage(100, 1000), CANVAS), 512 / 1000);
  assert.strictEqual(S.fitScale(fakeImage(100, 100), { width: 512, height: 256 }), 2.56);
});
