/**
 * Pointer and keyboard handling on the stage.
 *
 * The canvas is displayed at whatever size fits the viewport, so every screen
 * coordinate has to be divided back through the view scale before it means
 * anything in canvas pixels. Getting that conversion wrong is the classic
 * source of drift between where you click and what moves.
 */
(function (App) {
  'use strict';

  const WHEEL_SENSITIVITY = 0.0015;
  const NUDGE_STEP = 1;
  const NUDGE_STEP_FAST = 10;

  /**
   * Corner grab radius in *screen* pixels. Kept in screen space so the target
   * stays the same physical size however far the canvas is zoomed out — at 30%
   * view scale a canvas-space radius would shrink to something unhittable.
   */
  const HANDLE_HIT_RADIUS = 11;

  /** Below this the resize ratio is meaningless; fall back to moving instead. */
  const MIN_DRAG_DISTANCE = 2;

  /** Cursor for each corner, keyed by which diagonal it lies on. */
  const CORNER_CURSORS = Object.freeze({
    nw: 'nwse-resize',
    se: 'nwse-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
  });

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /**
   * Which resize grip is under the point, if any.
   *
   * `tolerance` and `inset` arrive already converted into canvas units. Grips
   * are tested at their clamped positions, matching where they were drawn —
   * testing the true corners would leave an oversized layer's handles
   * unclickable off-canvas.
   */
  function handleAt(state, point, tolerance, inset = 0, bleed = 0) {
    const layer = App.state.selectedLayer(state);
    if (!layer || !layer.visible) return null;

    let closest = null;
    for (const grip of App.state.handlePositions(layer, state.canvas, inset, bleed)) {
      const d = distance(point, grip);
      if (d <= tolerance && (!closest || d < closest.distance)) {
        closest = { ...grip, distance: d, cursor: CORNER_CURSORS[grip.id] };
      }
    }
    return closest;
  }

  /**
   * Screen coordinates -> canvas pixel coordinates.
   *
   * `element` is the overlay, which spans the bleed, so its top-left is
   * `bleed` above and left of the canvas origin. Subtracting it keeps every
   * caller working in plain canvas coordinates, including negative ones out
   * in the bleed.
   */
  function toCanvasPoint(event, element, viewScale, bleed = 0) {
    const rect = element.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / viewScale - bleed,
      y: (event.clientY - rect.top) / viewScale - bleed,
    };
  }

  /**
   * Scale around a fixed point so the pixel under the cursor stays put.
   * Scaling around the layer centre instead makes the artwork slide away from
   * the cursor, which feels broken when you are zooming to inspect an edge.
   */
  function scaleAroundPoint(layer, canvas, newScale, anchor) {
    const ratio = newScale / layer.scale;
    const centerX = canvas.width / 2 + layer.x;
    const centerY = canvas.height / 2 + layer.y;
    const vx = (centerX - anchor.x) * ratio;
    const vy = (centerY - anchor.y) * ratio;
    return {
      scale: newScale,
      x: anchor.x + vx - canvas.width / 2,
      y: anchor.y + vy - canvas.height / 2,
    };
  }

  /**
   * Wire up the stage.
   *
   * @param {object} deps
   * @param {HTMLElement} deps.element   the canvas stack
   * @param {() => object} deps.getState
   * @param {(state: object) => void} deps.setState
   * @param {() => number} deps.getViewScale
   * @param {() => void} deps.commit      open an undo restore point
   * @param {(key: string) => void} deps.commitCoalesced
   * @param {(transform: (state: object) => object) => void} deps.edit
   *   apply a change that adds or removes layers, as one undoable step
   */
  function attach({
    element,
    getState,
    setState,
    getViewScale,
    getBleed,
    commit,
    commitCoalesced,
    edit,
  }) {
    let dragging = null;
    const bleedOf = () => (getBleed ? getBleed() : 0);

    /**
     * The canvas only ever adjusts the layer already selected in the panel.
     *
     * Clicking artwork to select would be ambiguous here: layers are stacked
     * deliberately on top of each other, usually overlapping almost exactly,
     * so a click has no defensible answer for which one you meant. It would
     * also make a layer that has been dragged off-canvas unselectable. The
     * list is the one unambiguous place to choose, and dragging anywhere on
     * the canvas then moves that choice — including when it is out of sight.
     */
    function onPointerDown(event) {
      if (event.button !== 0) return;
      const state = getState();
      const layer = App.state.selectedLayer(state);
      if (!layer || !layer.visible) return;

      const viewScale = getViewScale();
      const bleed = bleedOf();
      const point = toCanvasPoint(event, element, viewScale, bleed);
      const grip = handleAt(
        state,
        point,
        HANDLE_HIT_RADIUS / viewScale,
        App.state.handleInset(viewScale),
        bleed
      );

      if (grip) {
        const startDistance = distance(point, grip.anchor);
        if (startDistance < MIN_DRAG_DISTANCE) return;

        commit();
        dragging = {
          mode: 'resize',
          id: layer.id,
          anchor: grip.anchor,
          startDistance,
          // The dragged corner's true position at the gesture's start; the
          // resize snap solves for the scale that lands it on a line.
          corner0: { x: grip.trueX, y: grip.trueY },
          origin: { scale: layer.scale, x: layer.x, y: layer.y, image: layer.image },
        };
        // Fade the layer being sized so the others read as the reference.
        setState({ ...getState(), resizing: true, dragging: true });
        element.style.cursor = grip.cursor;
        element.setPointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }

      commit();
      dragging = {
        mode: 'move',
        id: layer.id,
        startX: point.x,
        startY: point.y,
        originX: layer.x,
        originY: layer.y,
      };
      setState({ ...getState(), dragging: true });
      element.classList.add('dragging');
      element.setPointerCapture(event.pointerId);
      event.preventDefault();
    }

    function onPointerMove(event) {
      const state = getState();
      const viewScale = getViewScale();
      const bleed = bleedOf();
      const point = toCanvasPoint(event, element, viewScale, bleed);

      if (!dragging) {
        const layer = App.state.selectedLayer(state);
        const grip = layer
          ? handleAt(
              state,
              point,
              HANDLE_HIT_RADIUS / viewScale,
              App.state.handleInset(viewScale),
              bleed
            )
          : null;
        element.style.cursor = grip ? grip.cursor : '';
        element.classList.toggle('grabbable', !grip && Boolean(layer && layer.visible));
        return;
      }

      if (dragging.mode === 'resize') {
        const ratio = distance(point, dragging.anchor) / dragging.startDistance;
        const proposed = App.state.clamp(
          dragging.origin.scale * ratio,
          App.state.MIN_SCALE,
          App.state.MAX_SCALE
        );

        const snapping = state.snapEnabled && !event.altKey;
        const snapped = snapping
          ? App.snap.applyResize(
              state,
              dragging.id,
              dragging.anchor,
              dragging.corner0,
              dragging.origin.scale,
              proposed,
              App.snap.SNAP_RADIUS / viewScale
            )
          : { scale: proposed, lines: [] };

        const next = App.state.clamp(snapped.scale, App.state.MIN_SCALE, App.state.MAX_SCALE);

        // Always derived from the gesture's starting state, so a slow drag
        // cannot accumulate rounding drift across dozens of move events.
        setState(
          App.state.updateLayer(
            { ...state, snapLines: snapped.lines },
            dragging.id,
            scaleAroundPoint(dragging.origin, state.canvas, next, dragging.anchor)
          )
        );
        return;
      }

      // Snap the raw pointer offset, never the previously snapped value —
      // see the note at the top of snap.js. Alt is the standard escape hatch.
      const intended = {
        x: dragging.originX + (point.x - dragging.startX),
        y: dragging.originY + (point.y - dragging.startY),
      };
      const layer = App.state.findLayer(state, dragging.id);
      const enabled = state.snapEnabled && !event.altKey;
      const result = enabled
        ? App.snap.apply(state, layer, intended, App.snap.SNAP_RADIUS / viewScale)
        : { ...intended, lines: [] };

      setState(
        App.state.updateLayer({ ...state, snapLines: result.lines }, dragging.id, {
          x: Math.round(result.x),
          y: Math.round(result.y),
        })
      );
    }

    function onPointerUp(event) {
      if (!dragging) return;
      const wasResizing = dragging.mode === 'resize';
      dragging = null;
      element.classList.remove('dragging');
      element.style.cursor = '';
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      const settled = getState();
      setState({ ...settled, resizing: false, dragging: false, snapLines: [] });
    }

    function onWheel(event) {
      const state = getState();
      const layer = App.state.selectedLayer(state);
      if (!layer) return;

      event.preventDefault();
      // A wheel gesture has no end event, so consecutive notches are folded
      // into one restore point by time instead.
      commitCoalesced('wheel');
      const anchor = toCanvasPoint(event, element, getViewScale(), bleedOf());
      // Exponential so each notch is a constant proportion, not a constant step.
      const factor = Math.exp(-event.deltaY * WHEEL_SENSITIVITY);
      const next = App.state.clamp(
        layer.scale * factor,
        App.state.MIN_SCALE,
        App.state.MAX_SCALE
      );
      setState(
        App.state.updateLayer(state, layer.id, scaleAroundPoint(layer, state.canvas, next, anchor))
      );
    }

    function onKeyDown(event) {
      const tag = document.activeElement && document.activeElement.tagName;
      const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      const state = getState();

      // Undo works while a field has focus too — the browser's own text undo
      // only applies to text you are actively editing, and swallowing Cmd+Z
      // because a number input happens to hold focus is a nasty surprise.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        setState(event.shiftKey ? App.state.redo(state) : App.state.undo(state));
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        setState(App.state.redo(state));
        return;
      }

      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      const layer = App.state.selectedLayer(state);
      if (!layer) return;

      // Backspace and Delete both remove the selected layer. Backspace is the
      // one people reach for out of habit, and on a Mac keyboard it is often
      // the only one there is. The removal goes through `edit` rather than
      // `setState` so Cmd+Z brings the layer back — deleting the wrong image
      // is exactly the mistake undo exists for.
      if (event.key === 'Backspace' || event.key === 'Delete') {
        // Backspace is the browser's back gesture in some configurations.
        event.preventDefault();
        edit((current) => App.state.removeLayer(current, layer.id));
        return;
      }

      const step = event.shiftKey ? NUDGE_STEP_FAST : NUDGE_STEP;
      const moves = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };

      if (moves[event.key]) {
        event.preventDefault();
        // Held arrow keys repeat; fold a run of them into one restore point.
        commitCoalesced('nudge');
        setState(App.state.nudge(state, layer.id, moves[event.key][0], moves[event.key][1]));
        return;
      }

      // Bracket keys resize by a fixed proportion — the keyboard equivalent of
      // a wheel notch, anchored on the layer centre.
      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        commitCoalesced('bracket');
        const factor = event.key === ']' ? 1.02 : 1 / 1.02;
        setState(App.state.setScale(state, layer.id, layer.scale * factor));
      }
    }

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerUp);
    element.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
  }

  App.interact = {
    CORNER_CURSORS,
    HANDLE_HIT_RADIUS,
    attach,
    handleAt,
    scaleAroundPoint,
    toCanvasPoint,
  };
})((window.App = window.App || {}));
