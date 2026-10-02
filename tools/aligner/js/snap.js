/**
 * Alignment snapping — the "click into place" feel when a layer nears a
 * meaningful position.
 *
 * Written rather than imported. Every library that offers this (moveable,
 * interactjs, konva, fabric) ships an entire drag/transform framework around
 * it, 1.4–22 MB unpacked, and this app already has its own interaction layer
 * wired into undo, handle clamping and blended rendering. The algorithm below
 * is the whole feature: candidate lines, nearest within a threshold, done.
 *
 * The parts worth getting right are not the arithmetic but the feel, and those
 * rules are settled across every tool that does this:
 *
 *   1. The threshold is in SCREEN pixels, not canvas pixels. A canvas-space
 *      threshold changes how sticky everything feels as the view zooms.
 *   2. Snap the *intended* position, never the already-snapped one. Feeding
 *      the snapped result back in makes a layer weld itself to a line: each
 *      frame re-snaps from inside the threshold and the pointer can never
 *      escape. Working from the raw pointer offset means sliding past the
 *      threshold releases it, with no separate escape distance to tune.
 *   3. Show what you snapped to, or an unexplained jump reads as a bug.
 *   4. Let a modifier turn it off for the one time it is in the way.
 */
(function (App) {
  'use strict';

  /** Grab distance in screen pixels. */
  const SNAP_RADIUS = 6;

  /** Which parts of the moving layer can land on a line. */
  const EDGE_FRACTIONS = Object.freeze([
    { at: 0, kind: 'start' },
    { at: 0.5, kind: 'center' },
    { at: 1, kind: 'end' },
  ]);

  /**
   * Lines a layer can snap to, in canvas coordinates.
   *
   * Ordered by how much each one means: the canvas centre and the guide box
   * are what this tool exists to align against, so they come first and win
   * ties against an incidental edge of some other layer.
   */
  function snapLines(state, movingId) {
    const { canvas, guide } = state;
    const vertical = [];
    const horizontal = [];

    // Canvas centre — the "居中" case.
    vertical.push({ value: canvas.width / 2, kind: 'canvas-center' });
    horizontal.push({ value: canvas.height / 2, kind: 'canvas-center' });

    // The guide box: aligning a subject to it is the core workflow.
    if (guide.enabled) {
      const size = (Math.min(canvas.width, canvas.height) * guide.percent) / 100;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      vertical.push(
        { value: cx - size / 2, kind: 'guide' },
        { value: cx + size / 2, kind: 'guide' }
      );
      horizontal.push(
        { value: cy - size / 2, kind: 'guide' },
        { value: cy + size / 2, kind: 'guide' }
      );
    }

    // Canvas edges.
    vertical.push({ value: 0, kind: 'canvas-edge' }, { value: canvas.width, kind: 'canvas-edge' });
    horizontal.push({ value: 0, kind: 'canvas-edge' }, { value: canvas.height, kind: 'canvas-edge' });

    // Every other visible layer's edges and centre.
    for (const layer of state.layers) {
      if (layer.id === movingId || !layer.visible) continue;
      const b = App.state.layerBounds(layer, canvas);
      vertical.push(
        { value: b.left, kind: 'layer' },
        { value: b.left + b.width / 2, kind: 'layer' },
        { value: b.left + b.width, kind: 'layer' }
      );
      horizontal.push(
        { value: b.top, kind: 'layer' },
        { value: b.top + b.height / 2, kind: 'layer' },
        { value: b.top + b.height, kind: 'layer' }
      );
    }

    return { vertical, horizontal };
  }

  /**
   * Best correction along one axis.
   *
   * @param {number} start   leading edge of the moving layer
   * @param {number} size    its extent on this axis
   * @param {{value:number, kind:string}[]} lines
   * @param {number} radius  in canvas units
   * @returns {{delta:number, line:object}|null}
   */
  function bestSnap(start, size, lines, radius) {
    let best = null;

    for (const fraction of EDGE_FRACTIONS) {
      const edge = start + size * fraction.at;
      for (const line of lines) {
        const distance = Math.abs(line.value - edge);
        if (distance > radius) continue;
        // Strictly less-than keeps the first match on a tie, and the list is
        // ordered by significance, so the canvas centre beats a stray edge.
        if (!best || distance < best.distance) {
          best = { distance, delta: line.value - edge, line, edge: fraction.kind };
        }
      }
    }

    return best;
  }

  /**
   * Snap an intended position.
   *
   * @param {object} state
   * @param {object} layer      the layer being moved
   * @param {{x:number,y:number}} intended  offsets from canvas centre
   * @param {number} radius     snap distance in canvas units
   * @returns {{x:number, y:number, lines:object[]}}
   */
  function apply(state, layer, intended, radius) {
    if (radius <= 0) return { x: intended.x, y: intended.y, lines: [] };

    const { canvas } = state;
    const width = layer.image.naturalWidth * layer.scale;
    const height = layer.image.naturalHeight * layer.scale;

    // Where the layer would land if nothing snapped.
    const left = canvas.width / 2 + intended.x - width / 2;
    const top = canvas.height / 2 + intended.y - height / 2;

    const lines = snapLines(state, layer.id);
    const x = bestSnap(left, width, lines.vertical, radius);
    const y = bestSnap(top, height, lines.horizontal, radius);

    const hits = [];
    if (x) hits.push({ axis: 'vertical', value: x.line.value, kind: x.line.kind });
    if (y) hits.push({ axis: 'horizontal', value: y.line.value, kind: y.line.kind });

    return {
      x: intended.x + (x ? x.delta : 0),
      y: intended.y + (y ? y.delta : 0),
      lines: hits,
    };
  }

  /**
   * Snap a resize by solving for the scale that lands the dragged corner on a
   * line.
   *
   * Moving has two independent axes, so it can snap x and y at once. A resize
   * has one degree of freedom — the scale — and both corner coordinates are
   * functions of it, so at most one line can be satisfied. The corner travels
   * along the ray from the anchor:
   *
   *     corner(k) = anchor + (corner0 - anchor) * k,  k = scale / originScale
   *
   * so the k that puts one coordinate on a line is a division, and the nearest
   * such line within the radius wins.
   *
   * @param {object} state
   * @param {string} layerId
   * @param {{x:number,y:number}} anchor    the fixed opposite corner
   * @param {{x:number,y:number}} corner0   dragged corner at originScale
   * @param {number} originScale
   * @param {number} proposedScale
   * @param {number} radius                 in canvas units
   * @returns {{scale:number, lines:object[]}}
   */
  function applyResize(state, layerId, anchor, corner0, originScale, proposedScale, radius) {
    if (radius <= 0 || !originScale) return { scale: proposedScale, lines: [] };

    const k0 = proposedScale / originScale;
    const current = {
      x: anchor.x + (corner0.x - anchor.x) * k0,
      y: anchor.y + (corner0.y - anchor.y) * k0,
    };

    const lines = snapLines(state, layerId);
    let best = null;

    function consider(line, axis) {
      const span = axis === 'vertical' ? corner0.x - anchor.x : corner0.y - anchor.y;
      // A corner sitting on the anchor's own axis cannot be steered by scaling.
      if (Math.abs(span) < 1e-6) return;

      const from = axis === 'vertical' ? current.x : current.y;
      const distance = Math.abs(line.value - from);
      if (distance > radius) return;

      const base = axis === 'vertical' ? anchor.x : anchor.y;
      const k = (line.value - base) / span;
      // k <= 0 would mirror the layer through its anchor.
      if (!(k > 0)) return;

      if (!best || distance < best.distance) {
        best = { distance, scale: k * originScale, line, axis };
      }
    }

    for (const line of lines.vertical) consider(line, 'vertical');
    for (const line of lines.horizontal) consider(line, 'horizontal');

    if (!best) return { scale: proposedScale, lines: [] };
    return {
      scale: best.scale,
      lines: [{ axis: best.axis, value: best.line.value, kind: best.line.kind }],
    };
  }

  App.snap = { EDGE_FRACTIONS, SNAP_RADIUS, apply, applyResize, bestSnap, snapLines };
})((window.App = window.App || {}));
