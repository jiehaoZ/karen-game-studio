/**
 * Canvas painting: the artwork layer and the non-exported overlay above it.
 *
 * Two canvases rather than one, because guides, selection handles and the
 * checkerboard must never end up in an exported file. The overlay carries all
 * of it; the artwork canvas holds only what gets written out.
 */
(function (App) {
  'use strict';

  const CHECKER_SIZE = 8;
  const SELECTION_COLOR = '#6fd8ce';
  const GUIDE_COLOR = '#e8a33d';

  /**
   * Snap guides get their own colour. Cyan already means "your selection" and
   * amber means "the target you are aligning to"; reusing either would make a
   * transient guide look like a permanent part of the scene.
   */
  const SNAP_COLOR = '#f05e8e';

  /** Opacity of the layer being resized, while the drag is in progress. */
  const RESIZE_OPACITY = 0.45;

  /** How faint the out-of-canvas preview is. */
  const OVERFLOW_OPACITY = 0.22;

  /**
   * How stacked layers combine on the comparison canvas.
   *
   * `normal` only works for artwork with transparency. Sources on a solid
   * background — the common case — completely occlude whatever is beneath
   * them, so the onion skin shows nothing and lowering opacity just fogs the
   * whole stack instead of revealing the layer below.
   *
   * Multiply fixes the light-background case: white multiplied by anything is
   * that thing, so the paper drops out and every subject stays visible over
   * the others. Screen is the same trick inverted, for artwork on black. Each
   * needs the canvas primed with its identity colour, or the first layer
   * composites against transparency and the effect collapses.
   */
  const BLEND_MODES = Object.freeze({
    normal: { operation: 'source-over', base: null, label: '正常' },
    multiply: { operation: 'multiply', base: '#ffffff', label: '正片叠底' },
    screen: { operation: 'screen', base: '#000000', label: '滤色' },
  });

  /** Repeating checkerboard used to signal transparency. */
  function checkerPattern(ctx) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = CHECKER_SIZE * 2;
    const tileCtx = tile.getContext('2d');
    tileCtx.fillStyle = '#2b3036';
    tileCtx.fillRect(0, 0, tile.width, tile.height);
    tileCtx.fillStyle = '#23282d';
    tileCtx.fillRect(0, 0, CHECKER_SIZE, CHECKER_SIZE);
    tileCtx.fillRect(CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
    return ctx.createPattern(tile, 'repeat');
  }

  function drawLayer(ctx, layer, canvas, alpha, operation = 'source-over') {
    if (alpha <= 0) return;
    const bounds = App.state.layerBounds(layer, canvas);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = operation;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer.image, bounds.left, bounds.top, bounds.width, bounds.height);
    ctx.restore();
  }

  /**
   * How opaque a layer should be right now.
   *
   * At rest the selection is solid and its neighbours are dimmed, so you can
   * see what you are working on. During a resize drag that inverts: you are
   * sizing this layer *against* the others, so the others become the reference
   * and go solid, while the one under the cursor drops back far enough to see
   * through — without it, the layer you are enlarging progressively hides the
   * very thing you are matching it to.
   *
   * Solo mode opts out: with nothing else on the canvas there is no reference
   * to reveal, and fading the only visible layer just looks broken.
   */
  function layerAlpha(state, isSelected) {
    if (state.soloSelected) return 1;
    if (state.resizing) return isSelected ? RESIZE_OPACITY : 1;
    return isSelected ? 1 : state.onionOpacity;
  }

  /**
   * Paint the comparison canvas.
   *
   * Unselected layers are dimmed to `onionOpacity` so the selected one reads
   * clearly while its neighbours stay visible for comparison — the whole point
   * of stacking them in one canvas.
   */
  function renderArtwork(ctx, state) {
    const { canvas, layers, selectedId, soloSelected } = state;
    const blend = BLEND_MODES[state.blendMode] || BLEND_MODES.normal;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const visible = layers.filter(
      (layer) => layer.visible && !(soloSelected && layer.id !== selectedId)
    );
    if (!visible.length) return;

    if (blend.base) {
      ctx.save();
      ctx.fillStyle = blend.base;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    visible.forEach((layer, index) => {
      const isSelected = layer.id === selectedId;
      // The first layer establishes the plate; blending it against the primer
      // it matches would erase it.
      const operation = index === 0 ? 'source-over' : blend.operation;
      drawLayer(ctx, layer, canvas, layerAlpha(state, isSelected), operation);
    });
  }

  function drawGuide(ctx, state) {
    const { canvas, guide } = state;
    if (!guide.enabled) return;

    const size = (Math.min(canvas.width, canvas.height) * guide.percent) / 100;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    ctx.save();
    ctx.strokeStyle = GUIDE_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    if (guide.shape === 'circle') {
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    } else {
      ctx.rect(cx - size / 2, cy - size / 2, size, size);
    }
    ctx.stroke();

    // Centre cross, drawn short so it aids alignment without obscuring artwork.
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 8);
    ctx.lineTo(cx, cy + 8);
    ctx.moveTo(cx - 8, cy);
    ctx.lineTo(cx + 8, cy);
    ctx.stroke();
    ctx.restore();
  }

  function drawSelection(ctx, state, viewScale, bleed = 0) {
    const layer = App.state.selectedLayer(state);
    if (!layer || !layer.visible) return;

    const b = App.state.layerBounds(layer, state.canvas);
    // Keep strokes one screen pixel wide however far the view is zoomed.
    const hairline = 1 / viewScale;
    const handle = App.state.HANDLE_SIZE / viewScale;
    const inset = App.state.handleInset(viewScale);

    ctx.save();
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = hairline;
    ctx.strokeRect(b.left, b.top, b.width, b.height);

    for (const grip of App.state.handlePositions(layer, state.canvas, inset, bleed)) {
      ctx.fillStyle = SELECTION_COLOR;
      ctx.fillRect(grip.x - handle / 2, grip.y - handle / 2, handle, handle);

      // A parked handle is not where the corner actually is. The ring says
      // "this grip has been pulled inside to stay reachable".
      if (grip.clamped) {
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.lineWidth = hairline;
        ctx.globalAlpha = 0.55;
        ctx.strokeRect(
          grip.x - handle,
          grip.y - handle,
          handle * 2,
          handle * 2
        );
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  /**
   * Alignment guides for whatever the drag is currently snapped to.
   *
   * Drawn edge to edge in a colour used nowhere else, so a layer jumping into
   * place always comes with a visible reason. Without this a snap reads as the
   * tool ignoring the pointer.
   */
  function drawSnapLines(ctx, state, viewScale, bleed = 0) {
    if (!state.snapLines || !state.snapLines.length) return;
    const { canvas } = state;

    ctx.save();
    ctx.strokeStyle = SNAP_COLOR;
    ctx.lineWidth = 1 / viewScale;
    ctx.setLineDash([]);
    ctx.beginPath();
    for (const line of state.snapLines) {
      if (line.axis === 'vertical') {
        ctx.moveTo(line.value, -bleed);
        ctx.lineTo(line.value, canvas.height + bleed);
      } else {
        ctx.moveTo(-bleed, line.value);
        ctx.lineTo(canvas.width + bleed, line.value);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The overlay canvas covers the bleed, so it is translated to put the
   * canvas origin at (0, 0) and every drawing routine below keeps working in
   * plain canvas coordinates.
   */
  function renderOverlay(ctx, state, viewScale, bleed = 0) {
    const { canvas } = state;
    ctx.clearRect(0, 0, canvas.width + bleed * 2, canvas.height + bleed * 2);
    ctx.save();
    ctx.translate(bleed, bleed);
    ctx.lineWidth = 1 / viewScale;
    drawGuide(ctx, state);
    drawSnapLines(ctx, state, viewScale, bleed);
    drawSelection(ctx, state, viewScale, bleed);
    ctx.restore();
  }

  /**
   * Paint what falls outside the canvas, onto the bench around it.
   *
   * Without this a layer being dragged is silently cropped at the canvas edge,
   * so while you are sizing something larger than the frame you cannot see
   * what you are actually holding — the part you are dragging is exactly the
   * part that disappears.
   *
   * Kept faint at all times, because it is not part of the artwork:
   * everything out here is what the export will cut away. It stays on rather
   * than appearing only mid-drag, so the full extent of a layer is legible
   * while you judge it, not just while you happen to be holding it.
   *
   * `bleed` is the margin in canvas pixels; the context is translated so the
   * canvas origin stays at (0, 0) and every caller keeps using canvas
   * coordinates. The middle is left to be covered by the real canvas stacked
   * on top of it, so no clipping is needed.
   */
  function renderOverflow(ctx, state, bleed) {
    const { canvas, layers, selectedId, soloSelected } = state;
    ctx.clearRect(0, 0, canvas.width + bleed * 2, canvas.height + bleed * 2);

    const visible = layers.filter(
      (layer) => layer.visible && !(soloSelected && layer.id !== selectedId)
    );
    if (!visible.length) return;

    ctx.save();
    ctx.translate(bleed, bleed);
    for (const layer of visible) {
      // The fade is folded into each layer's own alpha rather than set once on
      // the context: canvas `globalAlpha` is absolute, not cumulative, so
      // drawLayer's assignment would overwrite a value set out here and the
      // preview would come out fully opaque.
      const emphasis = layer.id === selectedId ? 1 : 0.5;
      // Flat compositing: the blend modes exist to make stacked artwork
      // legible against each other inside the frame, and replaying them on a
      // translucent preview only muddies it.
      drawLayer(ctx, layer, canvas, OVERFLOW_OPACITY * emphasis, 'source-over');
    }
    ctx.restore();
  }

  /**
   * Render one layer alone onto a fresh canvas at full canvas size.
   * This is what export writes out — no dimming, no guides, no selection.
   */
  function renderLayerForExport(layer, canvasSize, background) {
    const out = document.createElement('canvas');
    out.width = canvasSize.width;
    out.height = canvasSize.height;
    const ctx = out.getContext('2d');

    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, out.width, out.height);
    }
    drawLayer(ctx, layer, canvasSize, 1);
    return out;
  }

  App.render = {
    BLEND_MODES,
    CHECKER_SIZE,
    OVERFLOW_OPACITY,
    renderOverflow,
    checkerPattern,
    renderArtwork,
    renderOverlay,
    renderLayerForExport,
  };
})((window.App = window.App || {}));
