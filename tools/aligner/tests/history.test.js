/** Undo/redo semantics. */
const test = require('node:test');
const assert = require('node:assert');

const { loadApp, fakeImage } = require('./harness');

const App = loadApp(['state.js']);
const S = App.state;

function seeded(count = 2) {
  return S.addLayers(
    S.DEFAULT_STATE,
    Array.from({ length: count }, (_, i) => ({
      image: fakeImage(100, 100, `img${i}`),
      name: `img${i}.png`,
    }))
  );
}

test('a fresh state has nothing to undo or redo', () => {
  assert.strictEqual(S.canUndo(S.DEFAULT_STATE), false);
  assert.strictEqual(S.canRedo(S.DEFAULT_STATE), false);
  assert.strictEqual(S.undo(S.DEFAULT_STATE), S.DEFAULT_STATE);
  assert.strictEqual(S.redo(S.DEFAULT_STATE), S.DEFAULT_STATE);
});

test('undo restores the document as it was before the edit', () => {
  const base = seeded();
  const id = base.selectedId;
  const edited = S.setScale(S.commit(base), id, 3);

  assert.strictEqual(edited.layers[0].scale, 3);
  const undone = S.undo(edited);
  assert.strictEqual(undone.layers[0].scale, base.layers[0].scale);
  assert.strictEqual(undone.layers, base.layers, 'restores the original reference');
});

test('redo reapplies what undo took away', () => {
  const base = seeded();
  const id = base.selectedId;
  const edited = S.setScale(S.commit(base), id, 3);
  const roundTripped = S.redo(S.undo(edited));

  assert.strictEqual(roundTripped.layers[0].scale, 3);
  assert.strictEqual(S.canRedo(roundTripped), false);
});

test('undo steps back through a sequence one edit at a time', () => {
  let s = seeded();
  const id = s.selectedId;
  // Imported layers arrive fitted to the canvas, not at 1.0.
  const imported = s.layers[0].scale;
  for (const value of [2, 3, 4]) s = S.setScale(S.commit(s), id, value);

  assert.strictEqual(s.layers[0].scale, 4);
  s = S.undo(s);
  assert.strictEqual(s.layers[0].scale, 3);
  s = S.undo(s);
  assert.strictEqual(s.layers[0].scale, 2);
  s = S.undo(s);
  assert.strictEqual(s.layers[0].scale, imported);
  assert.strictEqual(S.canUndo(s), false);
});

test('a new edit after undo discards the redo branch', () => {
  const base = seeded();
  const id = base.selectedId;
  const edited = S.setScale(S.commit(base), id, 3);
  const undone = S.undo(edited);
  assert.strictEqual(S.canRedo(undone), true);

  const diverged = S.setScale(S.commit(undone), id, 9);
  assert.strictEqual(S.canRedo(diverged), false);
  assert.strictEqual(diverged.layers[0].scale, 9);
});

test('view settings are not restored by undo', () => {
  const base = seeded();
  const imported = base.layers[0].scale;
  const edited = S.setScale(S.commit(base), base.selectedId, 3);

  // Changing how you are looking at it, without committing.
  const looked = {
    ...edited,
    onionOpacity: 0.9,
    blendMode: 'screen',
    guide: { ...edited.guide, percent: 42 },
    exportFormat: 'image/png',
  };

  const undone = S.undo(looked);
  assert.strictEqual(undone.layers[0].scale, imported, 'the edit is rolled back');
  assert.strictEqual(undone.onionOpacity, 0.9, 'the view is left alone');
  assert.strictEqual(undone.blendMode, 'screen');
  assert.strictEqual(undone.guide.percent, 42);
  assert.strictEqual(undone.exportFormat, 'image/png');
});

test('committing an unchanged document does not stack up dead entries', () => {
  const base = seeded();
  const once = S.commit(base);
  const twice = S.commit(once);
  const thrice = S.commit(twice);

  assert.strictEqual(once.past.length, 1);
  assert.strictEqual(thrice.past.length, 1, 'identical snapshots collapse');
  assert.strictEqual(twice, once, 'and the state object is returned untouched');
});

test('a dead commit cannot swallow the next undo', () => {
  const base = seeded();
  const id = base.selectedId;
  // A gesture that starts and ends without moving anything.
  const noop = S.commit(S.commit(base));
  const edited = S.setScale(S.commit(noop), id, 5);

  assert.strictEqual(S.undo(edited).layers[0].scale, base.layers[0].scale);
});

test('undo covers layer removal, including the selection', () => {
  const base = seeded(3);
  const victim = base.layers[1].id;
  const removed = S.removeLayer(S.commit(base), victim);
  assert.strictEqual(removed.layers.length, 2);

  const restored = S.undo(removed);
  assert.strictEqual(restored.layers.length, 3);
  assert.ok(restored.layers.some((l) => l.id === victim));
  assert.strictEqual(restored.selectedId, base.selectedId);
});

test('undo covers imports', () => {
  const base = seeded(1);
  const grown = S.addLayers(S.commit(base), [
    { image: fakeImage(50, 50, 'new'), name: 'new.png' },
  ]);

  assert.strictEqual(grown.layers.length, 2);
  assert.strictEqual(S.undo(grown).layers.length, 1);
});

test('undo covers canvas resizing', () => {
  const base = seeded();
  const resized = S.setCanvasSize(S.commit(base), 1024, 1024);

  assert.strictEqual(resized.canvas.width, 1024);
  assert.strictEqual(S.undo(resized).canvas.width, 512);
});

test('history is capped and drops the oldest entries first', () => {
  let s = seeded();
  const id = s.selectedId;
  for (let i = 1; i <= S.HISTORY_LIMIT + 25; i++) {
    s = S.setScale(S.commit(s), id, 1 + i / 100);
  }

  assert.strictEqual(s.past.length, S.HISTORY_LIMIT);
  // The oldest reachable state is a scale, not the pristine 1.0 it started at.
  let rewound = s;
  while (S.canUndo(rewound)) rewound = S.undo(rewound);
  assert.ok(rewound.layers[0].scale > 1, 'the original was pushed off the end');
});

test('undoing never mutates the state it was handed', () => {
  const base = seeded();
  const edited = S.setScale(S.commit(base), base.selectedId, 3);
  const pastBefore = edited.past;

  S.undo(edited);

  assert.strictEqual(edited.past, pastBefore);
  assert.strictEqual(edited.layers[0].scale, 3);
});

test('documentOf captures exactly the restorable fields', () => {
  const snapshot = S.documentOf(seeded());
  assert.deepStrictEqual(Object.keys(snapshot).sort(), [...S.DOCUMENT_KEYS].sort());
});

/**
 * Reference-stable no-ops. `edit()` decides whether an action was real by
 * comparing document references, so a write that changes nothing must hand
 * back the same object rather than an equal copy.
 */
test('setting a layer field to its current value returns the same state', () => {
  const base = seeded();
  const id = base.selectedId;
  const current = base.layers[0];

  assert.strictEqual(S.updateLayer(base, id, { scale: current.scale }), base);
  assert.strictEqual(S.updateLayer(base, id, { x: current.x, y: current.y }), base);
  assert.strictEqual(S.updateLayer(base, id, { visible: true }), base);
  assert.strictEqual(S.setScale(base, id, current.scale), base);
});

test('a real change still produces a new state', () => {
  const base = seeded();
  const changed = S.updateLayer(base, base.selectedId, { x: 12 });
  assert.notStrictEqual(changed, base);
  assert.strictEqual(changed.layers[0].x, 12);
});

test('resizing the canvas to its current size is a no-op', () => {
  const base = seeded();
  assert.strictEqual(S.setCanvasSize(base, base.canvas.width, base.canvas.height), base);
  assert.notStrictEqual(S.setCanvasSize(base, 1024, 1024), base);
});

test('updating a layer that is not there changes nothing', () => {
  const base = seeded();
  assert.strictEqual(S.updateLayer(base, 'no-such-layer', { x: 5 }), base);
});

test('sameDocument ignores view state', () => {
  const base = seeded();
  assert.ok(S.sameDocument(base, { ...base, onionOpacity: 0.1, blendMode: 'screen' }));
  assert.ok(!S.sameDocument(base, S.updateLayer(base, base.selectedId, { x: 3 })));
});
