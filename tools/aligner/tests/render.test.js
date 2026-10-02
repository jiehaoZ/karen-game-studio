/**
 * Compositing rules for the comparison canvas.
 *
 * These assert the draw calls rather than pixels: what matters is that each
 * layer is drawn with the right operation, at the right rect, and that the
 * primer coat lands underneath.
 */
const test = require('node:test');
const assert = require('node:assert');

const { loadEnv, fakeImage } = require('./harness');

const { App, document: doc } = loadEnv(['state.js', 'render.js']);
const S = App.state;

const CANVAS = { width: 400, height: 400 };

/** A 2d context that records the calls the renderer makes. */
function recordingContext() {
  const calls = [];
  const stack = [];
  const ctx = {
    calls,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    imageSmoothingEnabled: false,
    imageSmoothingQuality: 'low',
    save() {
      stack.push({
        alpha: this.globalAlpha,
        operation: this.globalCompositeOperation,
      });
    },
    restore() {
      const prev = stack.pop();
      if (prev) {
        this.globalAlpha = prev.alpha;
        this.globalCompositeOperation = prev.operation;
      }
    },
    clearRect: (x, y, w, h) => calls.push({ type: 'clear', x, y, w, h }),
    translate(dx, dy) {
      calls.push({ type: 'translate', dx, dy });
    },
    fillRect(x, y, w, h) {
      calls.push({ type: 'fill', color: this.fillStyle, x, y, w, h });
    },
    drawImage(image, x, y, w, h) {
      calls.push({
        type: 'draw',
        src: image.src,
        alpha: this.globalAlpha,
        operation: this.globalCompositeOperation,
        rect: [x, y, w, h],
      });
    },
    beginPath() {},
    stroke() {},
    strokeRect() {},
    arc() {},
    rect() {},
    moveTo() {},
    lineTo() {},
    setLineDash() {},
  };
  return ctx;
}

function stateWith(count, overrides = {}) {
  const images = Array.from({ length: count }, (_, i) => ({
    image: fakeImage(100, 100, `img${i}`),
    name: `img${i}.png`,
  }));
  const base = S.addLayers({ ...S.DEFAULT_STATE, canvas: CANVAS }, images);
  return { ...base, ...overrides };
}

const draws = (ctx) => ctx.calls.filter((c) => c.type === 'draw');
const fills = (ctx) => ctx.calls.filter((c) => c.type === 'fill');

test('multiply primes the canvas white before compositing', () => {
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, stateWith(2, { blendMode: 'multiply' }));

  const primer = fills(ctx)[0];
  assert.strictEqual(primer.color, '#ffffff');
  assert.deepStrictEqual([primer.x, primer.y, primer.w, primer.h], [0, 0, 400, 400]);
  assert.ok(ctx.calls.indexOf(primer) < ctx.calls.indexOf(draws(ctx)[0]), 'primer goes first');
});

test('screen primes the canvas black', () => {
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, stateWith(2, { blendMode: 'screen' }));
  assert.strictEqual(fills(ctx)[0].color, '#000000');
});

test('normal lays down no primer', () => {
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, stateWith(2, { blendMode: 'normal' }));
  assert.strictEqual(fills(ctx).length, 0);
});

test('the first layer draws normally, later ones blend', () => {
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, stateWith(3, { blendMode: 'multiply' }));

  const drawn = draws(ctx);
  assert.strictEqual(drawn.length, 3);
  assert.strictEqual(drawn[0].operation, 'source-over', 'first layer establishes the plate');
  assert.strictEqual(drawn[1].operation, 'multiply');
  assert.strictEqual(drawn[2].operation, 'multiply');
});

test('the selected layer is drawn opaque, the rest dimmed', () => {
  const state = stateWith(3, { blendMode: 'multiply', onionOpacity: 0.4 });
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, { ...state, selectedId: state.layers[1].id });

  const drawn = draws(ctx);
  assert.strictEqual(drawn[0].alpha, 0.4);
  assert.strictEqual(drawn[1].alpha, 1, 'selection is fully opaque');
  assert.strictEqual(drawn[2].alpha, 0.4);
});

test('hidden layers are skipped entirely', () => {
  const state = stateWith(3);
  const hidden = S.updateLayer(state, state.layers[1].id, { visible: false });
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, hidden);

  const drawn = draws(ctx);
  assert.strictEqual(drawn.length, 2);
  assert.ok(!drawn.some((d) => d.src === 'img1'));
});

test('solo draws only the selection, and draws it normally', () => {
  const state = stateWith(3, { blendMode: 'multiply', soloSelected: true });
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, { ...state, selectedId: state.layers[2].id });

  const drawn = draws(ctx);
  assert.strictEqual(drawn.length, 1);
  assert.strictEqual(drawn[0].src, 'img2');
  assert.strictEqual(drawn[0].operation, 'source-over');
});

test('an empty stack paints no primer', () => {
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, { ...S.DEFAULT_STATE, canvas: CANVAS, blendMode: 'multiply' });

  assert.strictEqual(fills(ctx).length, 0);
  assert.strictEqual(draws(ctx).length, 0);
});

test('all layers hidden paints no primer either', () => {
  let state = stateWith(2, { blendMode: 'multiply' });
  for (const layer of state.layers) {
    state = S.updateLayer(state, layer.id, { visible: false });
  }
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, state);

  assert.strictEqual(fills(ctx).length, 0);
});

test('an unknown blend mode falls back to normal rather than throwing', () => {
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, stateWith(2, { blendMode: 'nonsense' }));

  assert.strictEqual(fills(ctx).length, 0);
  assert.ok(draws(ctx).every((d) => d.operation === 'source-over'));
});

test('layers are drawn at their scaled, centred rect', () => {
  const state = stateWith(1);
  const scaled = S.setScale(state, state.layers[0].id, 2);
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, scaled);

  // 100x100 at 2x = 200x200, centred in 400x400.
  assert.deepStrictEqual(draws(ctx)[0].rect, [100, 100, 200, 200]);
});

test('export renders one layer alone with no blending or dimming', () => {
  const state = stateWith(3, { blendMode: 'multiply', onionOpacity: 0.2 });
  const target = state.layers[1];

  const captured = [];
  const original = doc.createElement;
  doc.createElement = (tag) => {
    const element = original(tag);
    if (tag === 'canvas') {
      const ctx = recordingContext();
      element.getContext = () => ctx;
      captured.push({ element, ctx });
    }
    return element;
  };

  try {
    App.render.renderLayerForExport(target, CANVAS, null);
  } finally {
    doc.createElement = original;
  }

  const { element, ctx } = captured[0];
  assert.strictEqual(element.width, 400);
  assert.strictEqual(element.height, 400);

  const drawn = draws(ctx);
  assert.strictEqual(drawn.length, 1, 'only the requested layer');
  assert.strictEqual(drawn[0].alpha, 1);
  assert.strictEqual(drawn[0].operation, 'source-over');
  assert.strictEqual(fills(ctx).length, 0, 'no primer without a background');
});

test('export fills the background when one is requested', () => {
  const state = stateWith(1);
  const captured = [];
  const original = doc.createElement;
  doc.createElement = (tag) => {
    const element = original(tag);
    if (tag === 'canvas') {
      const ctx = recordingContext();
      element.getContext = () => ctx;
      captured.push(ctx);
    }
    return element;
  };

  try {
    App.render.renderLayerForExport(state.layers[0], CANVAS, '#ffffff');
  } finally {
    doc.createElement = original;
  }

  assert.strictEqual(fills(captured[0])[0].color, '#ffffff');
});

/*
 * Resize feedback. While a corner drag is in flight the usual emphasis
 * inverts: the layer being sized fades so the ones it is being matched
 * against stay solid and readable underneath it.
 */

test('a resize drag fades the selection and solidifies the rest', () => {
  const state = stateWith(3, { onionOpacity: 0.3, resizing: true });
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, { ...state, selectedId: state.layers[1].id });

  const drawn = draws(ctx);
  assert.strictEqual(drawn[0].alpha, 1, 'reference layers go fully opaque');
  assert.strictEqual(drawn[2].alpha, 1);
  assert.ok(drawn[1].alpha < 1, 'the layer being resized fades');
  assert.ok(drawn[1].alpha > 0.2, 'but stays visible enough to judge its size');
});

test('the emphasis is exactly inverted versus at rest', () => {
  const base = stateWith(2, { onionOpacity: 0.3 });
  const state = { ...base, selectedId: base.layers[0].id };

  const rest = recordingContext();
  App.render.renderArtwork(rest, state);
  const dragging = recordingContext();
  App.render.renderArtwork(dragging, { ...state, resizing: true });

  const atRest = draws(rest);
  const mid = draws(dragging);

  assert.ok(atRest[0].alpha > atRest[1].alpha, 'at rest: selection is the solid one');
  assert.ok(mid[0].alpha < mid[1].alpha, 'dragging: selection is the faded one');
});

test('the flag off leaves the resting emphasis untouched', () => {
  const state = stateWith(2, { onionOpacity: 0.3, resizing: false });
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, { ...state, selectedId: state.layers[0].id });

  const drawn = draws(ctx);
  assert.strictEqual(drawn[0].alpha, 1);
  assert.strictEqual(drawn[1].alpha, 0.3);
});

test('solo mode keeps the layer solid even mid-resize', () => {
  const state = stateWith(3, { soloSelected: true, resizing: true });
  const ctx = recordingContext();
  App.render.renderArtwork(ctx, { ...state, selectedId: state.layers[1].id });

  const drawn = draws(ctx);
  assert.strictEqual(drawn.length, 1, 'solo still draws one layer');
  assert.strictEqual(drawn[0].alpha, 1, 'nothing to reveal, so no fade');
});

test('export ignores the resize flag entirely', () => {
  const state = stateWith(2, { resizing: true });
  const captured = [];
  const original = doc.createElement;
  doc.createElement = (tag) => {
    const element = original(tag);
    if (tag === 'canvas') {
      const ctx = recordingContext();
      element.getContext = () => ctx;
      captured.push(ctx);
    }
    return element;
  };

  try {
    App.render.renderLayerForExport(state.layers[0], CANVAS, null);
  } finally {
    doc.createElement = original;
  }

  assert.strictEqual(draws(captured[0])[0].alpha, 1);
});

/*
 * Out-of-canvas preview. Everything past the frame is cropped by the artwork
 * canvas, so while dragging a layer larger than the canvas the part under your
 * cursor is exactly the part you cannot see. This paints it onto the bench.
 */

test('the preview stays on when no drag is in flight', () => {
  // Deliberately always-on: the full extent of a layer matters while you are
  // judging it, not only while you happen to be holding it.
  const ctx = recordingContext();
  App.render.renderOverflow(ctx, stateWith(2, { dragging: false }), 100);
  assert.strictEqual(draws(ctx).length, 2);
});

test('a drag paints every visible layer into the bleed area', () => {
  const ctx = recordingContext();
  App.render.renderOverflow(ctx, stateWith(3, { dragging: true }), 100);

  assert.strictEqual(draws(ctx).length, 3);
  const shift = ctx.calls.find((c) => c.type === 'translate');
  assert.deepStrictEqual(
    { dx: shift.dx, dy: shift.dy },
    { dx: 100, dy: 100 },
    'shifted by the bleed so callers keep using canvas coordinates'
  );
});

test('the preview is faint and never fully opaque', () => {
  const ctx = recordingContext();
  const state = stateWith(2, { dragging: true });
  App.render.renderOverflow(ctx, { ...state, selectedId: state.layers[0].id }, 100);

  assert.ok(App.render.OVERFLOW_OPACITY < 0.5, 'must stay clearly secondary');
  // globalAlpha is set once for the pass; drawLayer multiplies its own on top.
  assert.ok(draws(ctx).every((d) => d.alpha <= 1));
});

test('the preview clears its whole surface including the bleed', () => {
  const ctx = recordingContext();
  App.render.renderOverflow(ctx, { ...stateWith(1), layers: [] }, 100);

  const cleared = ctx.calls.find((c) => c.type === 'clear');
  assert.ok(cleared, 'cleared even when idle');
  // 400 canvas + 100 bleed on each side.
  assert.deepStrictEqual({ w: cleared.w, h: cleared.h }, { w: 600, h: 600 });
});

test('the preview skips hidden layers', () => {
  let state = stateWith(3, { dragging: true });
  state = S.updateLayer(state, state.layers[1].id, { visible: false });
  const ctx = recordingContext();
  App.render.renderOverflow(ctx, state, 100);

  assert.strictEqual(draws(ctx).length, 2);
});

test('solo mode limits the preview to the selection', () => {
  const state = stateWith(3, { dragging: true, soloSelected: true });
  const ctx = recordingContext();
  App.render.renderOverflow(ctx, { ...state, selectedId: state.layers[0].id }, 100);

  assert.strictEqual(draws(ctx).length, 1);
});

test('the preview composites flat, ignoring the blend mode', () => {
  const ctx = recordingContext();
  App.render.renderOverflow(ctx, stateWith(3, { dragging: true, blendMode: 'multiply' }), 100);

  assert.ok(
    draws(ctx).every((d) => d.operation === 'source-over'),
    'replaying multiply on a translucent preview only muddies it'
  );
  assert.strictEqual(fills(ctx).length, 0, 'and no primer coat out here');
});

test('the preview fade survives drawLayer setting its own alpha', () => {
  // Canvas globalAlpha is absolute, not cumulative: a value set once on the
  // context is overwritten by drawLayer's own assignment. The fade therefore
  // has to be folded into each layer's alpha, or the preview renders solid.
  const ctx = recordingContext();
  const state = stateWith(2, { dragging: true });
  App.render.renderOverflow(ctx, { ...state, selectedId: state.layers[0].id }, 100);

  for (const call of draws(ctx)) {
    assert.ok(
      call.alpha <= App.render.OVERFLOW_OPACITY + 1e-9,
      `drew at alpha ${call.alpha}, above the ${App.render.OVERFLOW_OPACITY} preview ceiling`
    );
  }
});

test('the selected layer leads the preview but is still faded', () => {
  const ctx = recordingContext();
  const state = stateWith(2, { dragging: true });
  App.render.renderOverflow(ctx, { ...state, selectedId: state.layers[0].id }, 100);

  const drawn = draws(ctx);
  assert.ok(drawn[0].alpha > drawn[1].alpha, 'the selection reads stronger');
  assert.ok(drawn[0].alpha < 1, 'but never solid');
});
