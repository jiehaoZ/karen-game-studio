/**
 * End-to-end run in real Chrome.
 *
 * The unit tests cover the maths and the archive format, but nothing there
 * proves the page assembles, the canvas paints, or that a real encoder plus a
 * real download produces a ZIP with the right images in it. This drives the
 * actual UI and unpacks what falls out.
 *
 *   node tests/e2e.mjs
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE_URL = `file://${path.join(HERE, '..', 'index.html')}`;

/**
 * Fixtures are generated, not committed.
 *
 * Checked-in PNGs would be binary files nobody can review, kept in sync by
 * hand, and easy to break silently — and the properties this suite depends on
 * are specific: a white background so blend-mode auto-detection has something
 * to detect, and a spread of subject sizes wide enough that scaling them to
 * match is a real test. Generating them states those requirements in code.
 */
const FIXTURE_SPECS = [
  { name: 'ball_tiny.png', shape: 'circle', extent: 70 },
  { name: 'ball_mid.png', shape: 'circle', extent: 230 },
  { name: 'ball_huge.png', shape: 'circle', extent: 480 },
  { name: 'ball_corner.png', shape: 'circle', extent: 120, offset: 30 },
  { name: 'sword.png', shape: 'bar', extent: 260 },
];

const FIXTURE_SIZE = 512;

/** Paint the fixtures in the browser and write them out as real PNG files. */
async function writeFixtures(page, dir) {
  const encoded = await page.evaluate(
    ({ specs, size }) =>
      specs.map((spec) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);

        const centre = size / 2;
        const at = spec.offset ? spec.offset + spec.extent / 2 : centre;

        if (spec.shape === 'circle') {
          ctx.fillStyle = '#c81e1e';
          ctx.beginPath();
          ctx.arc(at, at, spec.extent / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // A tall, narrow subject: the case where "same size" depends on
          // which measure of size you mean.
          const w = spec.extent * 0.16;
          ctx.fillStyle = '#5a5a6e';
          ctx.fillRect(centre - w / 2, centre - spec.extent / 2, w, spec.extent);
          ctx.fillStyle = '#78461e';
          ctx.fillRect(centre - w * 1.8, centre + spec.extent / 2 - w, w * 3.6, w);
        }
        return { name: spec.name, data: canvas.toDataURL('image/png').split(',')[1] };
      }),
    { specs: FIXTURE_SPECS, size: FIXTURE_SIZE }
  );

  return encoded.map(({ name, data }) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  });
}

/**
 * Dispatch a real paste event carrying an image.
 *
 * Playwright cannot write to the OS clipboard from a file:// page, so the
 * event is constructed directly — which still exercises the handler, the
 * DataTransfer unpacking and the naming, i.e. everything this app owns.
 */
async function pasteImage(page, { count = 1, withText = false } = {}) {
  return page.evaluate(
    async ({ count, withText }) => {
      const dt = new DataTransfer();
      for (let i = 0; i < count; i++) {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const x = c.getContext('2d');
        x.fillStyle = '#000';
        x.fillRect(0, 0, 64, 64);
        x.fillStyle = ['#e85', '#5e8', '#58e'][i % 3];
        x.beginPath();
        x.arc(32, 32, 20, 0, Math.PI * 2);
        x.fill();
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        // Clipboard images arrive with this generic name; the app must rename.
        dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
      }
      if (withText) dt.setData('text/plain', '12345');

      const event = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { count, withText }
  );
}

let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? '  ok  ' : ' FAIL ';
  if (!condition) failures++;
  console.log(`${mark} ${label}${detail ? `  ${detail}` : ''}`);
}

async function run() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });

  await page.goto(PAGE_URL);
  await page.waitForFunction(() => window.App && window.App.main);

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aligner-fixtures-'));
  const sources = await writeFixtures(page, fixtureDir);

  check('page loads without script errors', pageErrors.length === 0, pageErrors.join(' | '));
  check('export is disabled with no layers', await page.isDisabled('#exportBtn'));

  // --- import -------------------------------------------------------------
  await page.setInputFiles('#fileInput', sources);
  await page.waitForFunction(
    (expected) => window.App.main.getState().layers.length === expected,
    sources.length
  );

  const afterImport = await page.evaluate(() => {
    const state = window.App.main.getState();
    return {
      layers: state.layers.length,
      selected: state.selectedId,
      scales: state.layers.map((l) => Number(l.scale.toFixed(4))),
      allCentred: state.layers.every((l) => l.x === 0 && l.y === 0),
    };
  });

  check('every file became a layer', afterImport.layers === sources.length, `${afterImport.layers}`);
  check('first layer is selected', Boolean(afterImport.selected));
  check('imported layers are centred', afterImport.allCentred);
  check('layer list renders one row per layer',
    (await page.locator('.layer').count()) === sources.length);
  check('export is enabled once layers exist', await page.isEnabled('#exportBtn'));

  // --- clipboard -----------------------------------------------------------
  const beforePaste = await page.evaluate(() => window.App.main.getState().layers.length);
  const claimed = await pasteImage(page);
  await page.waitForFunction(
    (n) => window.App.main.getState().layers.length === n,
    beforePaste + 1
  );
  check('an image can be pasted in', true, `${beforePaste} -> ${beforePaste + 1} layers`);
  check('the paste event is claimed', claimed);

  const pastedName = await page.evaluate(() => {
    const layers = window.App.main.getState().layers;
    return layers[layers.length - 1].name;
  });
  check('a pasted image gets a distinct name, not "image.png"',
    pastedName !== 'image.png' && pastedName.startsWith('paste-'), pastedName);

  // Two at once must not collide on export.
  await pasteImage(page, { count: 2 });
  await page.waitForFunction(
    (n) => window.App.main.getState().layers.length === n,
    beforePaste + 3
  );
  const names = await page.evaluate(() =>
    window.App.main.getState().layers.slice(-2).map((l) => l.name)
  );
  check('pasting several at once yields unique names', names[0] !== names[1], names.join(', '));

  // Text paste inside a field must still reach the field.
  await page.focus('#canvasW');
  const textClaimed = await pasteImage(page, { withText: true });
  check('text paste in a field is left alone', !textClaimed);
  await page.evaluate(() => document.activeElement.blur());

  await page.evaluate(() => {
    const s = window.App.main.getState();
    window.App.main.setState({ ...s, layers: s.layers.slice(0, 5) });
  });

  // --- canvas resize ------------------------------------------------------
  await page.fill('#canvasW', '640');
  await page.dispatchEvent('#canvasW', 'change');
  const canvasSize = await page.evaluate(() => window.App.main.getState().canvas);
  check('square lock keeps the canvas square', canvasSize.width === 640 && canvasSize.height === 640,
    `${canvasSize.width}x${canvasSize.height}`);
  check('artwork canvas matches the state size',
    await page.evaluate(() => document.getElementById('artworkCanvas').width === 640));

  // --- manual scaling, the core interaction -------------------------------
  await page.fill('#scaleInput', '150');
  await page.dispatchEvent('#scaleInput', 'change');
  const scaled = await page.evaluate(() => {
    const s = window.App.main.getState();
    return s.layers.find((l) => l.id === s.selectedId).scale;
  });
  check('typing a scale applies it', Math.abs(scaled - 1.5) < 1e-9, `${scaled}`);

  // Match-to-all is the shortcut that makes n images share one scale.
  await page.click('#matchBtn');
  const matched = await page.evaluate(() =>
    window.App.main.getState().layers.map((l) => Number(l.scale.toFixed(6)))
  );
  check('match applies one scale to every layer', new Set(matched).size === 1, matched.join(', '));

  // Put them back to something sane before exporting.
  await page.evaluate(() => {
    const App = window.App;
    let state = App.main.getState();
    for (const layer of state.layers) {
      state = App.state.setScale(state, layer.id, App.state.fitScale(layer.image, state.canvas) * 0.7);
    }
    App.main.setState(state);
  });

  // --- undo / redo --------------------------------------------------------
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const scaleOf = (id) =>
    page.evaluate(
      (layerId) => window.App.main.getState().layers.find((l) => l.id === layerId).scale,
      id
    );

  const target = await page.evaluate(() => window.App.main.getState().selectedId);
  const beforeUndo = await scaleOf(target);

  await page.fill('#scaleInput', '88');
  await page.dispatchEvent('#scaleInput', 'change');
  check('edit applied before undo', Math.abs((await scaleOf(target)) - 0.88) < 1e-9);
  check('undo button becomes available', await page.isEnabled('#undoBtn'));

  await page.keyboard.press(`${modifier}+z`);
  check('cmd+z restores the previous scale',
    Math.abs((await scaleOf(target)) - beforeUndo) < 1e-9,
    `${await scaleOf(target)} vs ${beforeUndo}`);

  await page.keyboard.press(`${modifier}+Shift+z`);
  check('shift+cmd+z redoes it', Math.abs((await scaleOf(target)) - 0.88) < 1e-9);

  await page.click('#undoBtn');
  check('the undo button does the same as the shortcut',
    Math.abs((await scaleOf(target)) - beforeUndo) < 1e-9);
  await page.click('#redoBtn');

  // View settings must survive an undo — they are not document edits.
  await page.fill('#guidePercent', '55');
  await page.dispatchEvent('#guidePercent', 'input');
  await page.selectOption('#blendSelect', 'screen');
  await page.keyboard.press(`${modifier}+z`);
  const viewAfterUndo = await page.evaluate(() => {
    const s = window.App.main.getState();
    return { guide: s.guide.percent, blend: s.blendMode };
  });
  check('undo leaves view settings alone',
    viewAfterUndo.guide === 55 && viewAfterUndo.blend === 'screen',
    JSON.stringify(viewAfterUndo));
  await page.selectOption('#blendSelect', 'multiply');

  // --- backspace deletes the selected layer, undoably ---------------------
  {
    const before = await page.evaluate(() => window.App.main.getState().layers.length);
    const doomed = await page.evaluate(() => window.App.main.getState().selectedId);

    // Focus must be off the form controls, or the key belongs to the input.
    // Blurring rather than clicking the stage: a click there starts a drag.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Backspace');

    const after = await page.evaluate(() => window.App.main.getState());
    check('backspace removes the selected layer',
      after.layers.length === before - 1 && !after.layers.some((l) => l.id === doomed),
      `${before} -> ${after.layers.length}`);
    check('removing a layer moves the selection somewhere valid',
      after.selectedId !== doomed &&
        (after.layers.length === 0 || after.layers.some((l) => l.id === after.selectedId)),
      String(after.selectedId));

    await page.keyboard.press(`${modifier}+z`);
    const restored = await page.evaluate(() => window.App.main.getState().layers);
    check('cmd+z brings the deleted layer back',
      restored.length === before && restored.some((l) => l.id === doomed),
      `${restored.length} layers`);

    // Backspace inside a field must edit the field, not delete artwork.
    await page.focus('#scaleInput');
    await page.keyboard.press('Backspace');
    const survived = await page.evaluate(() => window.App.main.getState().layers.length);
    check('backspace in a text field does not delete the layer', survived === before,
      `${survived} vs ${before}`);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
  }

  // --- selection is list-only ---------------------------------------------
  const selectedBefore = await page.evaluate(() => window.App.main.getState().selectedId);
  const box = await page.locator('#canvasStack').boundingBox();
  // Click well away from the selection's own area, over other stacked layers.
  await page.mouse.click(box.x + box.width * 0.12, box.y + box.height * 0.12);
  check('clicking the canvas never changes the selection',
    (await page.evaluate(() => window.App.main.getState().selectedId)) === selectedBefore);

  const secondRow = page.locator('.layer').nth(1);
  await secondRow.click();
  const afterListClick = await page.evaluate(() => window.App.main.getState().selectedId);
  check('the layer list does change the selection', afterListClick !== selectedBefore,
    `${selectedBefore} -> ${afterListClick}`);
  await page.locator('.layer').first().click();

  // --- corner handle resizing ---------------------------------------------
  await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    A.main.setState(A.state.updateLayer(s, s.selectedId, { scale: 0.5, x: 0, y: 0 }));
  });

  const geometry = await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    const layer = s.layers.find((l) => l.id === s.selectedId);
    const b = A.state.layerBounds(layer, s.canvas);
    const rect = document.getElementById('canvasStack').getBoundingClientRect();
    const view = rect.width / s.canvas.width;
    return {
      scale: layer.scale,
      view,
      // se corner and the nw corner it pivots around, in screen coordinates.
      se: { x: rect.left + (b.left + b.width) * view, y: rect.top + (b.top + b.height) * view },
      nw: { x: rect.left + b.left * view, y: rect.top + b.top * view },
      // ...and the anchor's canvas coordinates, which must not move.
      anchorCanvas: { x: b.left, y: b.top },
    };
  });

  check('nothing is flagged as resizing before the drag',
    (await page.evaluate(() => window.App.main.getState().resizing)) === false);

  await page.mouse.move(geometry.se.x, geometry.se.y);
  await page.mouse.down();
  // Drag outward along the diagonal: 1.5x the distance from the anchor.
  await page.mouse.move(
    geometry.nw.x + (geometry.se.x - geometry.nw.x) * 1.5,
    geometry.nw.y + (geometry.se.y - geometry.nw.y) * 1.5,
    { steps: 8 }
  );

  // Mid-drag: the layer being sized must be see-through, the others solid.
  const midDrag = await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    const alphas = [];
    // Re-run the paint against a recording context to read the alphas used.
    const real = document.getElementById('artworkCanvas').getContext('2d');
    const spy = new Proxy(real, {
      get(target, prop) {
        if (prop === 'drawImage') {
          return (...args) => {
            alphas.push({ src: args[0].src, alpha: target.globalAlpha });
            return target.drawImage(...args);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    });
    A.render.renderArtwork(spy, s);
    const selected = s.layers.find((l) => l.id === s.selectedId);
    return {
      resizing: s.resizing,
      selectedAlpha: alphas.find((a) => a.src === selected.image.src).alpha,
      othersAllSolid: alphas
        .filter((a) => a.src !== selected.image.src)
        .every((a) => a.alpha === 1),
      otherCount: alphas.filter((a) => a.src !== selected.image.src).length,
    };
  });

  check('the layer being resized fades mid-drag',
    midDrag.resizing && midDrag.selectedAlpha < 1 && midDrag.selectedAlpha > 0.2,
    `alpha ${midDrag.selectedAlpha}`);
  check('the other layers stay fully opaque as the reference',
    midDrag.othersAllSolid && midDrag.otherCount > 0,
    `${midDrag.otherCount} reference layers`);

  await page.mouse.up();

  check('the fade clears once the drag ends',
    (await page.evaluate(() => window.App.main.getState().resizing)) === false);

  const afterDrag = await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    const layer = s.layers.find((l) => l.id === s.selectedId);
    const b = A.state.layerBounds(layer, s.canvas);
    return { scale: layer.scale, left: b.left, top: b.top };
  });

  check('dragging the se handle scales the layer up',
    Math.abs(afterDrag.scale / geometry.scale - 1.5) < 0.05,
    `${geometry.scale} -> ${afterDrag.scale}`);
  check('the opposite corner stays anchored during a handle drag',
    Math.abs(afterDrag.left - geometry.anchorCanvas.x) < 2 &&
      Math.abs(afterDrag.top - geometry.anchorCanvas.y) < 2,
    `nw ${geometry.anchorCanvas.x.toFixed(1)},${geometry.anchorCanvas.y.toFixed(1)} ` +
      `-> ${afterDrag.left.toFixed(1)},${afterDrag.top.toFixed(1)}`);

  const resizeTarget = await page.evaluate(() => window.App.main.getState().selectedId);
  await page.keyboard.press(`${modifier}+z`);
  check('a handle drag is one undo step, not many',
    Math.abs((await scaleOf(resizeTarget)) - geometry.scale) < 1e-6,
    `${await scaleOf(resizeTarget)} vs ${geometry.scale}`);

  // --- resize snapping ------------------------------------------------------
  await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    A.main.setState(
      A.state.updateLayer({ ...s, snapEnabled: true }, s.selectedId, {
        scale: 0.5,
        x: 0,
        y: 0,
      })
    );
  });

  const resizeGeom = await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    const layer = s.layers.find((l) => l.id === s.selectedId);
    const rect = document.getElementById('canvasStack').getBoundingClientRect();
    const view = rect.width / s.canvas.width;
    const bleed = Math.round(Math.min(s.canvas.width, s.canvas.height) * 0.3);
    const grip = A.state
      .handlePositions(layer, s.canvas, A.state.handleInset(view), bleed)
      .find((g) => g.id === 'se');
    // The guide box edge this resize should land on.
    const guideEdge =
      s.canvas.width / 2 + (Math.min(s.canvas.width, s.canvas.height) * s.guide.percent) / 100 / 2;
    return {
      screen: { x: rect.left + grip.x * view, y: rect.top + grip.y * view },
      anchor: grip.anchor,
      view,
      guideEdge,
      rect: { left: rect.left, top: rect.top },
    };
  });

  // Drag the corner to just short of the guide edge; the snap should complete it.
  const shortOf = 4;
  await page.mouse.move(resizeGeom.screen.x, resizeGeom.screen.y);
  await page.mouse.down();
  await page.mouse.move(
    resizeGeom.rect.left + (resizeGeom.guideEdge - shortOf) * resizeGeom.view,
    resizeGeom.rect.top + (resizeGeom.guideEdge - shortOf) * resizeGeom.view,
    { steps: 10 }
  );

  const resizeSnap = await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    const layer = s.layers.find((l) => l.id === s.selectedId);
    const b = A.state.layerBounds(layer, s.canvas);
    return { right: b.left + b.width, lines: s.snapLines.length, dragging: s.dragging };
  });

  check('a corner drag snaps onto the guide edge',
    Math.abs(resizeSnap.right - resizeGeom.guideEdge) < 0.5,
    `corner at ${resizeSnap.right.toFixed(1)}, guide at ${resizeGeom.guideEdge}`);
  check('the resize snap draws its guide', resizeSnap.lines === 1, `${resizeSnap.lines}`);
  check('a corner drag flags the drag state', resizeSnap.dragging);

  await page.mouse.up();

  // --- out-of-canvas preview -----------------------------------------------
  const bleedPainted = await page.evaluate(async () => {
    const A = window.App;
    const s = A.main.getState();
    // Blow the layer well past the frame. No drag flag: the preview is always on.
    const oversized = A.state.updateLayer({ ...s, dragging: false }, s.selectedId, {
      scale: 3,
      x: 0,
      y: 0,
    });
    const el = document.getElementById('overflowCanvas');
    const ctx = el.getContext('2d', { willReadFrequently: true });
    const bleed = Math.round(Math.min(s.canvas.width, s.canvas.height) * 0.3);
    A.render.renderOverflow(ctx, oversized, bleed);

    // Sample a band that lies outside the canvas but inside the bleed.
    const { data } = ctx.getImageData(4, Math.round(el.height / 2), 20, 1);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;

    // And confirm it is genuinely faint, not a solid block.
    const alphas = [];
    for (let i = 3; i < data.length; i += 4) alphas.push(data[i]);
    return { painted, maxAlpha: Math.max(...alphas), size: { w: el.width, h: el.height } };
  });

  check('the preview is painted with no drag in flight',
    bleedPainted.painted > 0, 'always-on, not gated on dragging');
  check('the bleed area really is larger than the canvas',
    bleedPainted.size.w > 640, `${bleedPainted.size.w}px wide vs a 640px canvas`);
  check('content past the canvas edge is painted', bleedPainted.painted > 0,
    `${bleedPainted.painted} lit samples`);
  check('and it is painted faintly, not solid',
    bleedPainted.maxAlpha > 0 && bleedPainted.maxAlpha < 200,
    `peak alpha ${bleedPainted.maxAlpha}`);

  await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    A.main.setState(A.state.updateLayer({ ...s, dragging: false }, s.selectedId, { scale: 0.5 }));
  });

  // --- oversized layer: grips must stay reachable --------------------------
  await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    // 4x the canvas: every true corner is off-screen.
    A.main.setState(A.state.updateLayer(s, s.selectedId, { scale: 4, x: 0, y: 0 }));
  });

  const parked = await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    const layer = s.layers.find((l) => l.id === s.selectedId);
    const rect = document.getElementById('canvasStack').getBoundingClientRect();
    const view = rect.width / s.canvas.width;
    // Grips now roam the bleed, so the bleed has to be passed in or the
    // computed positions are the old clamped-to-canvas ones.
    const bleed = Math.round(Math.min(s.canvas.width, s.canvas.height) * 0.3);
    const grips = A.state.handlePositions(layer, s.canvas, A.state.handleInset(view), bleed);
    const se = grips.find((g) => g.id === 'se');
    return {
      allClamped: grips.every((g) => g.clamped),
      onCanvas: grips.every(
        (g) =>
          g.x >= -bleed &&
          g.x <= s.canvas.width + bleed &&
          g.y >= -bleed &&
          g.y <= s.canvas.height + bleed
      ),
      scale: layer.scale,
      screen: { x: rect.left + se.x * view, y: rect.top + se.y * view },
      anchorScreen: { x: rect.left + se.anchor.x * view, y: rect.top + se.anchor.y * view },
    };
  });

  check('a layer far past the bleed parks all four grips at its far edge',
    parked.allClamped && parked.onCanvas);

  // Drag the parked grip inward; it must actually shrink the layer.
  await page.mouse.move(parked.screen.x, parked.screen.y);
  await page.mouse.down();
  await page.mouse.move(
    parked.anchorScreen.x + (parked.screen.x - parked.anchorScreen.x) * 0.5,
    parked.anchorScreen.y + (parked.screen.y - parked.anchorScreen.y) * 0.5,
    { steps: 8 }
  );
  await page.mouse.up();

  const shrunk = await scaleOf(resizeTarget);
  check('a parked grip can still be dragged to shrink the layer',
    shrunk < parked.scale * 0.75, `${parked.scale} -> ${shrunk}`);

  // --- snapping ------------------------------------------------------------
  await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    A.main.setState(
      A.state.updateLayer({ ...s, snapEnabled: true }, s.selectedId, {
        scale: 0.4,
        x: 0,
        y: 0,
      })
    );
  });

  const offsetOf = () =>
    page.evaluate(() => {
      const s = window.App.main.getState();
      const l = s.layers.find((x) => x.id === s.selectedId);
      return { x: l.x, y: l.y };
    });

  const stack = await page.locator('#canvasStack').boundingBox();
  const centre = { x: stack.x + stack.width / 2, y: stack.y + stack.height / 2 };

  /** Drag from the layer's current centre by a screen-space delta. */
  async function dragBy(dx, dy, options = {}) {
    const from = await page.evaluate(() => {
      const A = window.App;
      const s = A.main.getState();
      const l = s.layers.find((x) => x.id === s.selectedId);
      const rect = document.getElementById('canvasStack').getBoundingClientRect();
      const view = rect.width / s.canvas.width;
      return {
        x: rect.left + (s.canvas.width / 2 + l.x) * view,
        y: rect.top + (s.canvas.height / 2 + l.y) * view,
      };
    });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    if (options.modifier) await page.keyboard.down(options.modifier);
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 6 });
    const during = await offsetOf();
    const lines = await page.evaluate(() => window.App.main.getState().snapLines.length);
    await page.mouse.up();
    if (options.modifier) await page.keyboard.up(options.modifier);
    return { during, lines };
  }

  // A few screen pixels off centre should be pulled back to exactly 0,0.
  const nudged = await dragBy(3, 3);
  check('a small drag near centre snaps back to dead centre',
    nudged.during.x === 0 && nudged.during.y === 0,
    JSON.stringify(nudged.during));
  check('the snap draws alignment guides', nudged.lines > 0, `${nudged.lines} lines`);

  await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    A.main.setState(A.state.updateLayer(s, s.selectedId, { x: 0, y: 0 }));
  });

  // Far enough out and it must move freely again.
  const far = await dragBy(60, 60);
  check('dragging well past the radius moves freely',
    far.during.x > 20 && far.during.y > 20,
    JSON.stringify(far.during));

  await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    A.main.setState(A.state.updateLayer(s, s.selectedId, { x: 0, y: 0 }));
  });

  const held = await dragBy(3, 3, { modifier: 'Alt' });
  check('holding Alt suppresses the snap',
    held.during.x !== 0 || held.during.y !== 0,
    JSON.stringify(held.during));

  check('guides clear once the drag ends',
    (await page.evaluate(() => window.App.main.getState().snapLines.length)) === 0);

  // Turning it off in the panel must have the same effect.
  await page.evaluate(() => {
    const A = window.App;
    const s = A.main.getState();
    A.main.setState(A.state.updateLayer(s, s.selectedId, { x: 0, y: 0 }));
  });
  await page.uncheck('#snapToggle');
  const disabled = await dragBy(3, 3);
  check('the toggle disables snapping',
    disabled.during.x !== 0 || disabled.during.y !== 0,
    JSON.stringify(disabled.during));
  await page.check('#snapToggle');

  // --- blending, the thing that makes stacking legible ---------------------
  const autoBlend = await page.evaluate(() => window.App.main.getState().blendMode);
  check('white-background sources auto-select multiply', autoBlend === 'multiply', autoBlend);

  /** Count distinct colours on the canvas — a proxy for "can you see through". */
  const distinctColours = () =>
    page.evaluate(() => {
      const canvas = document.getElementById('artworkCanvas');
      const { data } = canvas
        .getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height);
      const seen = new Set();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 8) continue;
        // Quantise so anti-aliasing does not count as its own colour.
        seen.add(
          `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`
        );
      }
      return seen.size;
    });

  await page.selectOption('#blendSelect', 'multiply');
  const multiplyColours = await distinctColours();
  await page.selectOption('#blendSelect', 'normal');
  const normalColours = await distinctColours();
  await page.selectOption('#blendSelect', 'multiply');

  check('multiply reveals more of the stack than normal',
    multiplyColours > normalColours,
    `multiply ${multiplyColours} vs normal ${normalColours} distinct colours`);

  // --- guide --------------------------------------------------------------
  await page.fill('#guidePercent', '80');
  await page.dispatchEvent('#guidePercent', 'input');
  check('guide percentage updates',
    await page.evaluate(() => window.App.main.getState().guide.percent === 80));

  const overlayPainted = await page.evaluate(() => {
    const canvas = document.getElementById('overlayCanvas');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
  check('overlay actually draws the guide', overlayPainted);

  const artworkPainted = await page.evaluate(() => {
    const canvas = document.getElementById('artworkCanvas');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  });
  check('artwork canvas paints the layers', artworkPainted);

  // --- export -------------------------------------------------------------
  for (const format of ['image/webp', 'image/jpeg', 'image/png']) {
    await page.selectOption('#formatSelect', format);

    const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
    await page.click('#exportBtn');
    const download = await downloadPromise;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aligner-e2e-'));
    const zipPath = path.join(dir, download.suggestedFilename());
    await download.saveAs(zipPath);

    const extracted = path.join(dir, 'out');
    execFileSync('ditto', ['-x', '-k', zipPath, extracted]);
    const files = fs.readdirSync(extracted);

    const label = format.split('/')[1];
    check(`[${label}] zip contains one file per layer`, files.length === sources.length,
      files.join(', '));

    const expectedExtension = { webp: 'webp', jpeg: 'jpg', png: 'png' }[label];
    check(`[${label}] files carry the right extension`,
      files.every((f) => f.endsWith(`.${expectedExtension}`)));

    // Verify the bytes really are that format and really are canvas-sized.
    const identify = files.map((f) => {
      const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format',
        path.join(extracted, f)], { encoding: 'utf8' });
      return {
        name: f,
        width: Number(out.match(/pixelWidth: (\d+)/)?.[1]),
        height: Number(out.match(/pixelHeight: (\d+)/)?.[1]),
        format: out.match(/format: (\w+)/)?.[1],
        bytes: fs.statSync(path.join(extracted, f)).size,
      };
    });

    check(`[${label}] every export is the full canvas size`,
      identify.every((i) => i.width === 640 && i.height === 640),
      identify.map((i) => `${i.width}x${i.height}`).join(' '));

    const log = await page.textContent('#exportLog');
    check(`[${label}] export log reports every file`, (log.match(/−/g) || []).length >= sources.length);

    if (format !== 'image/png') {
      const quality = await page.evaluate(() => document.getElementById('exportLog').textContent);
      check(`[${label}] log shows the chosen quality`, /q\d+/.test(quality),
        quality.slice(0, 60).replace(/\s+/g, ' '));
    } else {
      // PNG's knob is palette size, so the log reports colours instead. This is
      // the assertion that the palette path actually ran: before it existed,
      // every PNG row said "无损".
      const log = await page.textContent('#exportLog');
      check('[png] log shows the chosen palette size', /\d+ 色/.test(log),
        log.slice(0, 60).replace(/\s+/g, ' '));

      // The files must be genuinely indexed, not truecolour that happens to be
      // small. `file` reads the IHDR colour type, which is the only real proof.
      const described = files.map((f) =>
        execFileSync('file', ['-b', path.join(extracted, f)], { encoding: 'utf8' }).trim()
      );
      check('[png] exports are indexed PNGs, not 32-bit truecolour',
        described.every((d) => /colormap/.test(d)),
        described[0]);

      // The encoder is hand-written, so the pixels it claims to store are
      // checked against what Chrome's own PNG decoder reads back out. `sips`
      // and Pillow agree with it too, but a third independent decoder — the one
      // that will actually open these files — is the one that matters.
      const roundTrip = await page.evaluate(async () => {
        const source = document.createElement('canvas');
        source.width = 64;
        source.height = 64;
        const ctx = source.getContext('2d', { willReadFrequently: true });
        // Soft-edged disc on transparency: an alpha ramp is where a premultiply
        // mistake shows up, and a flat fill would hide one.
        const gradient = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
        gradient.addColorStop(0, 'rgba(220,40,40,1)');
        gradient.addColorStop(1, 'rgba(40,40,200,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 64, 64);

        const reference = ctx.getImageData(0, 0, 64, 64);
        const indexed = App.quantize.reduce(reference, 64);
        const blob = await App.png.encodeIndexed(indexed);
        const expected = App.compress.expandIndexed(indexed);

        const bitmap = await createImageBitmap(blob);
        const scratch = document.createElement('canvas');
        scratch.width = 64;
        scratch.height = 64;
        const sctx = scratch.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(bitmap, 0, 0);
        const decoded = sctx.getImageData(0, 0, 64, 64);

        let worstAlpha = 0;
        let worstOpaque = 0;
        let worstBlended = 0;
        for (let i = 0; i < decoded.data.length; i += 4) {
          const alpha = expected.data[i + 3];
          worstAlpha = Math.max(worstAlpha, Math.abs(alpha - decoded.data[i + 3]));
          // A transparent pixel's RGB is not preserved by anything, and
          // comparing it would fail for no reason.
          if (alpha === 0) continue;
          for (let c = 0; c < 3; c++) {
            const delta = Math.abs(expected.data[i + c] - decoded.data[i + c]);
            if (alpha === 255) worstOpaque = Math.max(worstOpaque, delta);
            else worstBlended = Math.max(worstBlended, delta);
          }
        }
        return { worstAlpha, worstOpaque, worstBlended, colors: indexed.colors };
      });

      // Alpha and fully opaque colour must survive exactly. Partially
      // transparent colour is allowed one unit of drift, and that budget is
      // not the encoder's: canvas stores pixels premultiplied, so reading a
      // semi-transparent pixel back through getImageData divides by an alpha
      // it had already multiplied by, and 8-bit rounding does the rest. Any
      // PNG at all, including one written by the browser, loses the same unit.
      check("[png] Chrome decodes the encoder's output to the intended pixels",
        roundTrip.worstAlpha === 0 && roundTrip.worstOpaque === 0 && roundTrip.worstBlended <= 1,
        `alpha ±${roundTrip.worstAlpha}, opaque ±${roundTrip.worstOpaque}, ` +
          `blended ±${roundTrip.worstBlended} across ${roundTrip.colors} colours`);

      const total = identify.reduce((sum, i) => sum + i.bytes, 0);
      check('[png] the palette export is a fraction of the naive one',
        total < 40 * 1024, `${(total / 1024).toFixed(1)}KB for ${identify.length} files`);
    }

    console.log(`       ${label}: ${identify.map((i) => `${i.name} ${(i.bytes / 1024).toFixed(1)}KB`).join(', ')}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  check('no script errors across the whole run', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  fs.rmSync(fixtureDir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
