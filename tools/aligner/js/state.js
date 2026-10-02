/**
 * Application state and the pure functions that derive new states from it.
 *
 * Every update returns a fresh object rather than mutating in place, so the
 * renderer can diff against what it drew last and undo stays a matter of
 * keeping old references around.
 */
(function (App) {
  'use strict';

  const MIN_SCALE = 0.01;
  const MAX_SCALE = 20;
  const MIN_CANVAS = 16;
  const MAX_CANVAS = 8192;

  /** Undo depth. Snapshots hold image references, not pixels, so this is cheap. */
  const HISTORY_LIMIT = 60;

  /**
   * The fields undo actually restores.
   *
   * Everything else — onion opacity, guide, blend mode, export settings — is
   * how you are looking at the work, not the work. Rolling those back on
   * Cmd+Z would be surprising: you nudge a layer, tweak the guide, hit undo
   * expecting the nudge back, and instead lose the guide.
   */
  const DOCUMENT_KEYS = Object.freeze(['canvas', 'layers', 'selectedId']);

  const DEFAULT_STATE = Object.freeze({
    canvas: Object.freeze({ width: 512, height: 512 }),
    layers: Object.freeze([]),
    selectedId: null,
    onionOpacity: 0.55,
    soloSelected: false,
    // True only while a corner-handle drag is in flight. Transient view state,
    // deliberately outside DOCUMENT_KEYS so undo never restores a stuck drag.
    resizing: false,
    // Any pointer drag in flight, move or resize. Drives the out-of-canvas
    // preview; `resizing` is narrower and only drives the fade.
    dragging: false,
    snapEnabled: true,
    // Lines currently being snapped to, drawn as feedback. Transient.
    snapLines: Object.freeze([]),
    // How stacked layers combine. Auto-selected on first import from the
    // artwork's background brightness; see App.render.BLEND_MODES.
    blendMode: 'multiply',
    guide: Object.freeze({ enabled: true, shape: 'box', percent: 70 }),
    showCheckerboard: true,
    exportFormat: 'image/png',
    // Lowest structural similarity to the source that still counts as
    // indistinguishable. This is what actually stops the compression search.
    minSsim: 0.95,
    // Secondary brake for content whose size curve really does flatten: a step
    // has to clear either of these to earn another round of compression.
    exportThreshold: 0.005,
    exportMinSaving: 1024,
    past: Object.freeze([]),
    future: Object.freeze([]),
  });

  let nextId = 1;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Scale that fits an image entirely inside the canvas. */
  function fitScale(image, canvas) {
    return Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  }

  function createLayer(image, name, canvas) {
    return Object.freeze({
      id: `layer-${nextId++}`,
      name,
      image,
      scale: clamp(fitScale(image, canvas), MIN_SCALE, MAX_SCALE),
      // Offset of the image centre from the canvas centre, in canvas pixels.
      x: 0,
      y: 0,
      visible: true,
    });
  }

  /** Rendered size and top-left corner of a layer, in canvas pixels. */
  function layerBounds(layer, canvas) {
    const width = layer.image.naturalWidth * layer.scale;
    const height = layer.image.naturalHeight * layer.scale;
    return {
      width,
      height,
      left: canvas.width / 2 + layer.x - width / 2,
      top: canvas.height / 2 + layer.y - height / 2,
    };
  }

  /**
   * Resize grip size in screen pixels, and how far its centre is kept from the
   * canvas edge. Lives here because the renderer and the hit test must agree
   * exactly — a grip drawn somewhere other than where it is tested is a
   * handle that visibly refuses to be grabbed.
   */
  const HANDLE_SIZE = 7;
  const HANDLE_EDGE_PAD = 2;

  /** Inset in canvas units for a given view scale. */
  function handleInset(viewScale) {
    return (HANDLE_SIZE / 2 + HANDLE_EDGE_PAD) / viewScale;
  }

  /** Corners of a layer, in the order nw, ne, sw, se. */
  const CORNER_FRACTIONS = Object.freeze([
    Object.freeze({ id: 'nw', fx: 0, fy: 0 }),
    Object.freeze({ id: 'ne', fx: 1, fy: 0 }),
    Object.freeze({ id: 'sw', fx: 0, fy: 1 }),
    Object.freeze({ id: 'se', fx: 1, fy: 1 }),
  ]);

  /**
   * Where the resize handles sit.
   *
   * Grips follow the layer's true corners, including out past the frame — the
   * overlay spans the bleed area, so there is somewhere to draw them and
   * somewhere to click them. They are only clamped at the far edge of that
   * bleed, which is the last place still on screen; beyond it a grip would be
   * invisible and drag-to-resize would vanish exactly when it is most wanted,
   * on a layer far too large that you are trying to shrink.
   *
   * When a grip is clamped only the grip moves. The resize still pivots on the
   * true geometric corner, so the maths is unaffected.
   */
  function handlePositions(layer, canvas, inset = 0, bleed = 0) {
    const bounds = layerBounds(layer, canvas);
    const limitX = Math.min(inset, canvas.width / 2 + bleed);
    const limitY = Math.min(inset, canvas.height / 2 + bleed);

    return CORNER_FRACTIONS.map((corner) => {
      const trueX = bounds.left + bounds.width * corner.fx;
      const trueY = bounds.top + bounds.height * corner.fy;
      const x = clamp(trueX, -bleed + limitX, canvas.width + bleed - limitX);
      const y = clamp(trueY, -bleed + limitY, canvas.height + bleed - limitY);
      return {
        ...corner,
        x,
        y,
        trueX,
        trueY,
        clamped: x !== trueX || y !== trueY,
        // The corner this one pivots around when dragged.
        anchor: {
          x: bounds.left + bounds.width * (1 - corner.fx),
          y: bounds.top + bounds.height * (1 - corner.fy),
        },
      };
    });
  }

  function findLayer(state, id) {
    return state.layers.find((layer) => layer.id === id) || null;
  }

  function selectedLayer(state) {
    return findLayer(state, state.selectedId);
  }

  /**
   * Replace one layer, leaving every other reference untouched.
   *
   * A write that changes nothing returns the original state object, not an
   * equal copy. Callers compare documents by reference to decide whether an
   * edit happened at all — mapping out a fresh array for an identical value
   * would make every no-op look like a change and pollute the undo stack.
   */
  function updateLayer(state, id, changes) {
    const layer = findLayer(state, id);
    if (!layer) return state;

    const keys = Object.keys(changes);
    if (keys.every((key) => Object.is(layer[key], changes[key]))) return state;

    return {
      ...state,
      layers: state.layers.map((entry) =>
        entry.id === id ? Object.freeze({ ...entry, ...changes }) : entry
      ),
    };
  }

  function setScale(state, id, scale) {
    return updateLayer(state, id, { scale: clamp(scale, MIN_SCALE, MAX_SCALE) });
  }

  function nudge(state, id, dx, dy) {
    const layer = findLayer(state, id);
    if (!layer) return state;
    return updateLayer(state, id, { x: layer.x + dx, y: layer.y + dy });
  }

  function addLayers(state, images) {
    const layers = images.map((entry) => createLayer(entry.image, entry.name, state.canvas));
    return {
      ...state,
      layers: [...state.layers, ...layers],
      selectedId: state.selectedId || (layers.length ? layers[0].id : null),
    };
  }

  function removeLayer(state, id) {
    const remaining = state.layers.filter((layer) => layer.id !== id);
    const wasSelected = state.selectedId === id;
    return {
      ...state,
      layers: remaining,
      selectedId: wasSelected ? (remaining.length ? remaining[0].id : null) : state.selectedId,
    };
  }

  function setCanvasSize(state, width, height) {
    const next = {
      width: clamp(Math.round(width) || MIN_CANVAS, MIN_CANVAS, MAX_CANVAS),
      height: clamp(Math.round(height) || MIN_CANVAS, MIN_CANVAS, MAX_CANVAS),
    };
    if (next.width === state.canvas.width && next.height === state.canvas.height) {
      return state;
    }
    return { ...state, canvas: Object.freeze(next) };
  }

  /** Reset a layer to centred and fitted, the state it was imported in. */
  function resetLayer(state, id) {
    const layer = findLayer(state, id);
    if (!layer) return state;
    return updateLayer(state, id, {
      x: 0,
      y: 0,
      scale: clamp(fitScale(layer.image, state.canvas), MIN_SCALE, MAX_SCALE),
    });
  }

  /**
   * Copy the selected layer's scale onto every other layer.
   *
   * Only meaningful when the sources share a pixel density — two 512px
   * exports of the same model, say. It is a shortcut, not a substitute for
   * eyeballing each one against the guide.
   */
  function matchScaleToSelected(state) {
    const source = selectedLayer(state);
    if (!source) return state;
    return {
      ...state,
      layers: state.layers.map((layer) =>
        layer.id === source.id ? layer : Object.freeze({ ...layer, scale: source.scale })
      ),
    };
  }

  /* ---------- history ---------- */

  function documentOf(state) {
    const snapshot = {};
    for (const key of DOCUMENT_KEYS) snapshot[key] = state[key];
    return Object.freeze(snapshot);
  }

  /** True when the two snapshots describe the same document. */
  function sameDocument(a, b) {
    return DOCUMENT_KEYS.every((key) => a[key] === b[key]);
  }

  /**
   * Mark a restore point holding the document as it stands *now*.
   *
   * Call this before applying an edit, not after. Committing an identical
   * snapshot is a no-op, so a gesture that ends up changing nothing does not
   * leave a dead entry that swallows the next Cmd+Z.
   */
  function commit(state) {
    const current = documentOf(state);
    const last = state.past[state.past.length - 1];
    if (last && sameDocument(last, current)) return state;

    return {
      ...state,
      past: [...state.past, current].slice(-HISTORY_LIMIT),
      future: [],
    };
  }

  function canUndo(state) {
    return state.past.length > 0;
  }

  function canRedo(state) {
    return state.future.length > 0;
  }

  function undo(state) {
    if (!canUndo(state)) return state;
    const previous = state.past[state.past.length - 1];
    return {
      ...state,
      ...previous,
      past: state.past.slice(0, -1),
      future: [documentOf(state), ...state.future],
    };
  }

  function redo(state) {
    if (!canRedo(state)) return state;
    const next = state.future[0];
    return {
      ...state,
      ...next,
      past: [...state.past, documentOf(state)].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
    };
  }

  App.state = {
    CORNER_FRACTIONS,
    DEFAULT_STATE,
    HANDLE_SIZE,
    handleInset,
    DOCUMENT_KEYS,
    HISTORY_LIMIT,
    handlePositions,
    sameDocument,
    MIN_SCALE,
    MAX_SCALE,
    MIN_CANVAS,
    MAX_CANVAS,
    addLayers,
    canRedo,
    canUndo,
    clamp,
    commit,
    documentOf,
    fitScale,
    findLayer,
    redo,
    undo,
    layerBounds,
    matchScaleToSelected,
    nudge,
    removeLayer,
    resetLayer,
    selectedLayer,
    setCanvasSize,
    setScale,
    updateLayer,
  };
})((window.App = window.App || {}));
