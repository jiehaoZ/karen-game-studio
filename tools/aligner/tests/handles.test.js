/** Corner resize handles: hit testing and the anchored scaling they drive. */
const test = require('node:test');
const assert = require('node:assert');

const { loadApp, fakeImage } = require('./harness');

const App = loadApp(['state.js', 'interact.js']);
const S = App.state;
const I = App.interact;

const CANVAS = { width: 400, height: 400 };

/** A 200x200 layer centred in a 400x400 canvas: corners at 100 and 300. */
function centred(overrides = {}) {
  const layer = {
    id: 'l1',
    name: 'a.png',
    image: fakeImage(200, 200),
    scale: 1,
    x: 0,
    y: 0,
    visible: true,
    ...overrides,
  };
  return { ...S.DEFAULT_STATE, canvas: CANVAS, layers: [layer], selectedId: 'l1' };
}

const boundsOf = (state) => S.layerBounds(state.layers[0], state.canvas);

test('each corner is found at its own position', () => {
  const state = centred();
  const found = [
    [{ x: 100, y: 100 }, 'nw'],
    [{ x: 300, y: 100 }, 'ne'],
    [{ x: 100, y: 300 }, 'sw'],
    [{ x: 300, y: 300 }, 'se'],
  ];

  for (const [point, expected] of found) {
    assert.strictEqual(I.handleAt(state, point, 8).id, expected, JSON.stringify(point));
  }
});

test('each grip carries the anchor it pivots around', () => {
  const grips = S.handlePositions(centred().layers[0], CANVAS);
  const byId = Object.fromEntries(grips.map((g) => [g.id, g]));

  assert.deepStrictEqual(byId.se.anchor, { x: 100, y: 100 });
  assert.deepStrictEqual(byId.nw.anchor, { x: 300, y: 300 });
  assert.deepStrictEqual(byId.ne.anchor, { x: 100, y: 300 });
  assert.deepStrictEqual(byId.sw.anchor, { x: 300, y: 100 });
});

test('the centre of the layer is not a handle', () => {
  assert.strictEqual(I.handleAt(centred(), { x: 200, y: 200 }, 8), null);
});

test('tolerance defines the grab radius', () => {
  const state = centred();
  const nearby = { x: 106, y: 106 };

  assert.strictEqual(I.handleAt(state, nearby, 4), null, 'outside a tight radius');
  assert.strictEqual(I.handleAt(state, nearby, 12).id, 'nw', 'inside a generous one');
});

test('handles follow the layer when it moves and scales', () => {
  const state = centred({ scale: 0.5, x: 40, y: -20 });
  const b = boundsOf(state);

  assert.strictEqual(I.handleAt(state, { x: b.left, y: b.top }, 6).id, 'nw');
  assert.strictEqual(
    I.handleAt(state, { x: b.left + b.width, y: b.top + b.height }, 6).id,
    'se'
  );
  assert.strictEqual(I.handleAt(state, { x: 100, y: 100 }, 6), null, 'not where it used to be');
});

test('hidden or unselected layers expose no handles', () => {
  assert.strictEqual(I.handleAt(centred({ visible: false }), { x: 100, y: 100 }, 8), null);

  const unselected = { ...centred(), selectedId: null };
  assert.strictEqual(I.handleAt(unselected, { x: 100, y: 100 }, 8), null);
});

test('each corner names the cursor that matches its diagonal', () => {
  assert.strictEqual(I.CORNER_CURSORS.nw, 'nwse-resize');
  assert.strictEqual(I.CORNER_CURSORS.se, 'nwse-resize');
  assert.strictEqual(I.CORNER_CURSORS.ne, 'nesw-resize');
  assert.strictEqual(I.CORNER_CURSORS.sw, 'nesw-resize');
});

/**
 * The behaviour that makes handle-dragging feel right: the corner you are not
 * holding stays nailed to the table while the one under the cursor follows it.
 */
test('dragging a corner leaves the opposite corner exactly where it was', () => {
  for (const corner of S.CORNER_FRACTIONS) {
    const state = centred();
    const before = boundsOf(state);
    const anchor = S.handlePositions(state.layers[0], CANVAS).find((g) => g.id === corner.id)
      .anchor;

    const scaled = {
      ...state.layers[0],
      ...I.scaleAroundPoint(state.layers[0], CANVAS, 1.75, anchor),
    };
    const after = S.layerBounds(scaled, CANVAS);
    const anchorAfter = S.handlePositions(scaled, CANVAS).find((g) => g.id === corner.id)
      .anchor;

    assert.ok(
      Math.abs(anchorAfter.x - anchor.x) < 1e-9 && Math.abs(anchorAfter.y - anchor.y) < 1e-9,
      `${corner.id}: anchor drifted to ${JSON.stringify(anchorAfter)}`
    );
    assert.strictEqual(after.width, 350, `${corner.id}: did not resize`);
  }
});

test('shrinking against an anchor behaves the same as growing', () => {
  const state = centred();
  const anchor = S.handlePositions(state.layers[0], CANVAS).find((g) => g.id === 'se').anchor;

  const shrunk = {
    ...state.layers[0],
    ...I.scaleAroundPoint(state.layers[0], CANVAS, 0.4, anchor),
  };
  const after = S.layerBounds(shrunk, CANVAS);

  assert.strictEqual(after.left, anchor.x, 'nw corner is the anchor and stays put');
  assert.strictEqual(after.top, anchor.y);
  assert.strictEqual(after.width, 80);
});

test('the drag ratio maps cursor distance onto scale', () => {
  // Dragging to twice the distance from the anchor should double the size.
  const state = centred();
  const b = boundsOf(state);
  const anchor = S.handlePositions(state.layers[0], CANVAS).find((g) => g.id === 'se').anchor;
  const start = { x: b.left + b.width, y: b.top + b.height };

  const startDistance = Math.hypot(start.x - anchor.x, start.y - anchor.y);
  const dragged = { x: anchor.x + (start.x - anchor.x) * 2, y: anchor.y + (start.y - anchor.y) * 2 };
  const ratio = Math.hypot(dragged.x - anchor.x, dragged.y - anchor.y) / startDistance;

  assert.strictEqual(ratio, 2);
  const resized = {
    ...state.layers[0],
    ...I.scaleAroundPoint(state.layers[0], CANVAS, state.layers[0].scale * ratio, anchor),
  };
  assert.strictEqual(S.layerBounds(resized, CANVAS).width, 400);
});

test('the grab radius is a screen-space constant', () => {
  assert.ok(I.HANDLE_HIT_RADIUS >= 8, 'must stay comfortably clickable');
});

/*
 * Oversized layers. A layer bigger than the canvas has its corners off-screen,
 * where nothing can be drawn or clicked — which would remove drag-to-resize
 * exactly when you most need it, on a layer you are trying to shrink.
 */

test('grips park inside the canvas when the layer overflows it', () => {
  // 200x200 image at 4x = 800x800 on a 400x400 canvas: every corner is outside.
  const state = centred({ scale: 4 });
  const inset = 6;
  const grips = S.handlePositions(state.layers[0], CANVAS, inset);

  assert.ok(grips.every((g) => g.clamped), 'all four should be parked');
  for (const grip of grips) {
    assert.ok(
      grip.x >= inset && grip.x <= CANVAS.width - inset,
      `${grip.id} x ${grip.x} escaped the canvas`
    );
    assert.ok(
      grip.y >= inset && grip.y <= CANVAS.height - inset,
      `${grip.id} y ${grip.y} escaped the canvas`
    );
  }
});

test('a parked grip is still grabbable', () => {
  const state = centred({ scale: 4 });
  const inset = 6;
  const se = S.handlePositions(state.layers[0], CANVAS, inset).find((g) => g.id === 'se');

  const found = I.handleAt(state, { x: se.x, y: se.y }, 8, inset);
  assert.ok(found, 'the parked se grip must answer a hit test at its drawn position');
  assert.strictEqual(found.id, 'se');
});

test('parking moves the grip but never the pivot', () => {
  const state = centred({ scale: 4 });
  const b = boundsOf(state);
  const se = S.handlePositions(state.layers[0], CANVAS, 6).find((g) => g.id === 'se');

  assert.notStrictEqual(se.x, se.trueX, 'the grip was pulled in');
  // The pivot stays on the real nw corner, far off-canvas at -200.
  assert.strictEqual(se.anchor.x, b.left);
  assert.strictEqual(se.anchor.y, b.top);
  assert.ok(se.anchor.x < 0, 'and that really is outside the canvas');
});

test('dragging a parked grip still shrinks around the true corner', () => {
  const state = centred({ scale: 4 });
  const se = S.handlePositions(state.layers[0], CANVAS, 6).find((g) => g.id === 'se');

  const shrunk = {
    ...state.layers[0],
    ...I.scaleAroundPoint(state.layers[0], CANVAS, 1, se.anchor),
  };
  const after = S.layerBounds(shrunk, CANVAS);

  assert.strictEqual(after.width, 200, 'scaled down to 1x');
  assert.strictEqual(after.left, se.anchor.x, 'nw corner held');
  assert.strictEqual(after.top, se.anchor.y);
});

test('a layer entirely off-canvas still shows all four grips', () => {
  const state = centred({ scale: 0.5, x: 900, y: 900 });
  const grips = S.handlePositions(state.layers[0], CANVAS, 6);

  assert.strictEqual(grips.length, 4);
  assert.ok(grips.every((g) => g.clamped));
  assert.ok(I.handleAt(state, { x: grips[3].x, y: grips[3].y }, 8, 6));
});

test('a layer comfortably inside the canvas is never clamped', () => {
  const grips = S.handlePositions(centred({ scale: 0.5 }).layers[0], CANVAS, 6);
  assert.ok(grips.every((g) => !g.clamped));
  assert.ok(grips.every((g) => g.x === g.trueX && g.y === g.trueY));
});

test('the inset never exceeds half the canvas', () => {
  // A huge inset on a tiny canvas must not invert the clamp bounds.
  const tiny = { width: 20, height: 20 };
  const grips = S.handlePositions(centred().layers[0], tiny, 500);
  assert.ok(grips.every((g) => g.x >= 0 && g.x <= 20 && g.y >= 0 && g.y <= 20));
});

/*
 * Grips in the bleed. The overlay spans past the frame, so a corner outside
 * the canvas has somewhere to be drawn and somewhere to be clicked; only the
 * far edge of the bleed still clamps.
 */

test('grips follow the true corners out past the canvas', () => {
  const state = centred({ scale: 4 }); // 800x800 on a 400x400 canvas
  const grips = S.handlePositions(state.layers[0], CANVAS, 6, 300);

  assert.ok(grips.every((g) => !g.clamped), 'nothing needed clamping inside a 300px bleed');
  const se = grips.find((g) => g.id === 'se');
  assert.strictEqual(se.x, se.trueX);
  assert.strictEqual(se.y, se.trueY);
  assert.ok(se.x > CANVAS.width, 'and it really is off-canvas');
});

test('a grip beyond the bleed is still parked at its far edge', () => {
  const state = centred({ scale: 20 }); // 4000x4000, way past any bleed
  const grips = S.handlePositions(state.layers[0], CANVAS, 6, 100);

  assert.ok(grips.every((g) => g.clamped));
  for (const grip of grips) {
    assert.ok(grip.x >= -100 && grip.x <= CANVAS.width + 100, `${grip.id} x escaped`);
    assert.ok(grip.y >= -100 && grip.y <= CANVAS.height + 100, `${grip.id} y escaped`);
  }
});

test('an off-canvas grip answers a hit test where it is drawn', () => {
  const state = centred({ scale: 4 });
  const bleed = 300;
  const se = S.handlePositions(state.layers[0], CANVAS, 6, bleed).find((g) => g.id === 'se');

  const found = I.handleAt(state, { x: se.x, y: se.y }, 8, 6, bleed);
  assert.ok(found, 'must be grabbable out in the bleed');
  assert.strictEqual(found.id, 'se');
});

test('with no bleed the old on-canvas clamping still applies', () => {
  const grips = S.handlePositions(centred({ scale: 4 }).layers[0], CANVAS, 6, 0);
  assert.ok(grips.every((g) => g.clamped));
  assert.ok(grips.every((g) => g.x >= 0 && g.x <= CANVAS.width));
});

test('pointer coordinates account for the bleed offset', () => {
  const element = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  // The overlay starts `bleed` above and left of the canvas origin, so the
  // overlay's own top-left corner is canvas (-bleed, -bleed).
  const point = I.toCanvasPoint({ clientX: 0, clientY: 0 }, element, 1, 120);
  assert.deepStrictEqual(point, { x: -120, y: -120 });

  const origin = I.toCanvasPoint({ clientX: 120, clientY: 120 }, element, 1, 120);
  assert.deepStrictEqual(origin, { x: 0, y: 0 }, 'canvas origin sits one bleed in');
});
