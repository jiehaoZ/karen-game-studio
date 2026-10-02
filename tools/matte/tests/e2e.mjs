/**
 * End-to-end run in real Chrome.
 *
 * The unit tests prove the arithmetic. This proves the page assembles, that a
 * real PNG encoder preserves what the keyer produced, and — the point of the
 * whole tool — that a soft edge survives the round trip to disk as a gradient
 * rather than a hard cut.
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
  if (!condition) failures++;
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? `  ${detail}` : ''}`);
}

/**
 * Fixtures are drawn in the browser rather than committed.
 *
 * Each one states a property the tool must handle: a hard-edged disc on each
 * plate type, a soft radial fade whose whole point is that it must NOT become
 * binary, and a noisy field that must be refused as a flat backdrop.
 */
async function writeFixtures(page, dir) {
  const encoded = await page.evaluate(() => {
    const make = (bg, draw) => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const x = c.getContext('2d');
      x.fillStyle = bg;
      x.fillRect(0, 0, 256, 256);
      draw(x);
      return c.toDataURL('image/png').split(',')[1];
    };
    const disc = (x) => {
      x.fillStyle = '#e8502d';
      x.beginPath();
      x.arc(128, 128, 80, 0, Math.PI * 2);
      x.fill();
    };
    const soft = (x) => {
      const g = x.createRadialGradient(128, 128, 20, 128, 128, 100);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, 256, 256);
    };
    /**
     * The panda case: a subject with a hole in it the same colour as the
     * plate. Per pixel the eye and the backdrop are indistinguishable.
     */
    const eyed = (x) => {
      x.fillStyle = '#f2f2f2';
      x.beginPath();
      x.arc(128, 128, 80, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = '#000000';
      x.beginPath();
      x.arc(112, 112, 18, 0, Math.PI * 2);
      x.fill();
    };
    const noise = (x) => {
      for (let i = 0; i < 24000; i++) {
        x.fillStyle = `hsl(${Math.random() * 360},60%,${30 + Math.random() * 40}%)`;
        x.fillRect(Math.random() * 256, Math.random() * 256, 3, 3);
      }
    };
    return [
      ['on_black.png', make('#000000', disc)],
      ['on_white.png', make('#ffffff', disc)],
      ['on_green.png', make('#00b140', disc)],
      ['soft_on_black.png', make('#000000', soft)],
      ['eye_on_black.png', make('#000000', eyed)],
      ['photo_like.png', make('#777777', noise)],
    ];
  });

  return encoded.map(([name, data]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  });
}

/**
 * Read a PNG back through the browser and describe its alpha channel.
 *
 * `probes` are [x, y] points whose alpha is reported individually — the
 * aggregate counts cannot say whether one particular region survived.
 */
async function describeAlpha(page, filePath, probes = []) {
  const base64 = fs.readFileSync(filePath).toString('base64');
  return page.evaluate(async ({ b64, probes }) => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = `data:image/png;base64,${b64}`;
    });
    const c = document.createElement('canvas');
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);

    let transparent = 0;
    let opaque = 0;
    let partial = 0;
    const distinct = new Set();
    for (let i = 3; i < data.length; i += 4) {
      const a = data[i];
      distinct.add(a);
      if (a === 0) transparent++;
      else if (a === 255) opaque++;
      else partial++;
    }
    return {
      width: c.width,
      height: c.height,
      transparent,
      opaque,
      partial,
      distinctAlphas: distinct.size,
      // A corner should be backdrop on every fixture here.
      cornerAlpha: data[3],
      probeAlphas: probes.map(([x, y]) => data[(y * c.width + x) * 4 + 3]),
    };
  }, { b64: base64, probes });
}

async function run() {
  const browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(PAGE_URL);
  await page.waitForFunction(() => window.App && window.App.main);
  check('page loads without script errors', errors.length === 0, errors.join(' | '));
  check('export is disabled with nothing loaded', await page.isDisabled('#exportBtn'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matte-e2e-'));
  const fixtures = await writeFixtures(page, dir);

  await page.setInputFiles('#fileInput', fixtures);
  await page.waitForFunction((n) => window.App.main.getState().items.length === n, fixtures.length);

  // --- detection routes each plate correctly -------------------------------
  const detected = await page.evaluate(() =>
    window.App.main.getState().items.map((i) => ({
      name: i.name,
      mode: i.detection.mode,
      flat: i.detection.flat,
    }))
  );
  const byName = Object.fromEntries(detected.map((d) => [d.name, d]));

  check('a black plate is detected', byName['on_black.png'].mode === 'black');
  check('a white plate is detected', byName['on_white.png'].mode === 'white');
  check('a green plate falls to colour mode', byName['on_green.png'].mode === 'color');
  check('a flat plate is reported flat', byName['on_black.png'].flat);
  check('a noisy field is refused as a flat backdrop',
    !byName['photo_like.png'].flat,
    'this is what routes an image to the model instead');

  // --- clipboard -----------------------------------------------------------
  const beforePaste = await page.evaluate(() => window.App.main.getState().items.length);
  const claimed = await pasteImage(page);
  await page.waitForFunction(
    (n) => window.App.main.getState().items.length === n,
    beforePaste + 1
  );
  check('an image can be pasted in', claimed, `${beforePaste} -> ${beforePaste + 1} images`);

  const pasted = await page.evaluate(() => {
    const items = window.App.main.getState().items;
    const last = items[items.length - 1];
    return { name: last.name, mode: last.detection.mode };
  });
  check('a pasted image gets a distinct name', pasted.name.startsWith('paste-'), pasted.name);
  check('a pasted image is analysed like any other', pasted.mode === 'black', pasted.mode);

  await page.focus('#low');
  const textClaimed = await pasteImage(page, { withText: true });
  check('text paste in a field is left alone', !textClaimed);
  await page.evaluate(() => document.activeElement.blur());

  // --- backspace removes the selected image --------------------------------
  // This doubles as the cleanup for the pasted fixture, so the rest of the run
  // sees the original set.
  {
    const before = await page.evaluate(() => {
      const s = window.App.main.getState();
      const pasted = s.items[s.items.length - 1];
      window.App.main.setState({ ...s, selectedId: pasted.id });
      return { count: s.items.length, doomed: pasted.id };
    });

    // Backspace inside a field must edit the field, not delete artwork.
    await page.focus('#low');
    await page.keyboard.press('Backspace');
    check('backspace in a field leaves the image list alone',
      (await page.evaluate(() => window.App.main.getState().items.length)) === before.count);

    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Backspace');

    const after = await page.evaluate(() => window.App.main.getState());
    check('backspace removes the selected image',
      after.items.length === before.count - 1 && !after.items.some((i) => i.id === before.doomed),
      `${before.count} -> ${after.items.length}`);
    check('the selection moves to an image that still exists',
      after.items.some((i) => i.id === after.selectedId), String(after.selectedId));
  }

  // --- the verdict is surfaced, not just computed --------------------------
  await page.evaluate(() => {
    const s = window.App.main.getState();
    const noisy = s.items.find((i) => i.name === 'photo_like.png');
    window.App.main.setState({ ...s, selectedId: noisy.id });
  });
  const verdictText = await page.textContent('#verdict');
  check('the non-flat verdict tells the user to use AI',
    verdictText.includes('AI'), verdictText.trim().slice(0, 40));

  // --- views ---------------------------------------------------------------
  await page.evaluate(() => {
    const s = window.App.main.getState();
    const black = s.items.find((i) => i.name === 'on_black.png');
    window.App.main.setState({ ...s, selectedId: black.id, view: 'alpha' });
  });
  const alphaViewGrey = await page.evaluate(() => {
    const c = document.getElementById('previewCanvas');
    const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    // The alpha view is greyscale: r === g === b for every pixel.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2]) return false;
    }
    return true;
  });
  check('the alpha view renders as greyscale', alphaViewGrey);

  await page.click('.view-switch button[data-view="result"]');

  // --- backdrop switching --------------------------------------------------
  await page.click('.backdrop-switch button[data-backdrop="light"]');
  check('the preview backdrop switches',
    (await page.getAttribute('#plate', 'data-backdrop')) === 'light');
  await page.click('.backdrop-switch button[data-backdrop="checker"]');

  // --- settings are per image ---------------------------------------------
  // Each image derives its own levels from its own histogram, so this compares
  // against the value that image actually started with rather than a constant.
  const isolated = await page.evaluate(() => {
    const before = window.App.main.getState();
    const black = before.items.find((i) => i.name === 'on_black.png');
    const white = before.items.find((i) => i.name === 'on_white.png');
    const originals = { black: black.settings.low, white: white.settings.low };

    window.App.main.setState(window.App.state.updateSettings(before, black.id, { low: 0.3 }));

    const after = window.App.main.getState();
    const result = {
      originals,
      changed: after.items.find((i) => i.name === 'on_black.png').settings.low,
      untouched: after.items.find((i) => i.name === 'on_white.png').settings.low,
      // `high` is driven by the subject's peak, which differs between the two
      // plates even for the same subject — the clearer evidence that levels
      // are computed per image rather than defaulted.
      highs: {
        black: black.settings.high,
        white: white.settings.high,
      },
    };

    // Put it back so export runs on the auto-chosen levels.
    window.App.main.setState(
      window.App.state.updateSettings(window.App.main.getState(), black.id, {
        low: originals.black,
      })
    );
    return result;
  });

  check("one image's settings do not leak onto another",
    Math.abs(isolated.changed - 0.3) < 1e-9 &&
      Math.abs(isolated.untouched - isolated.originals.white) < 1e-9,
    JSON.stringify(isolated));

  check('each image derives its levels from its own histogram',
    Math.abs(isolated.highs.black - isolated.highs.white) > 0.02,
    `high: black ${isolated.highs.black.toFixed(3)}, white ${isolated.highs.white.toFixed(3)} ` +
      '— same subject, different plate, different ceiling');

  // --- what counts as background -------------------------------------------
  /**
   * The eye in this fixture is the same black as the plate, so nothing about
   * the pixel itself says to keep it. Only its position inside the subject
   * does — which is the whole point of the scope switch.
   */
  await page.evaluate(() => {
    const s = window.App.main.getState();
    const eyed = s.items.find((i) => i.name === 'eye_on_black.png');
    window.App.main.setState({ ...s, selectedId: eyed.id });
  });

  const previewAlphaAt = (fx, fy) =>
    page.evaluate(
      ({ fx, fy }) => {
        const c = document.getElementById('previewCanvas');
        const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
        const x = Math.round(fx * c.width);
        const y = Math.round(fy * c.height);
        return data[(y * c.width + x) * 4 + 3];
      },
      { fx, fy }
    );

  const eyeCentre = [112 / 256, 112 / 256];
  check('a hole inside the subject survives by default',
    (await previewAlphaAt(...eyeCentre)) === 255,
    'the black eye is not the black plate');

  await page.click('.scope-switch button[data-scope="all"]');
  check('whole-image scope does cut the same colour out of the middle',
    (await previewAlphaAt(...eyeCentre)) === 0,
    'still available for textures and real see-through holes');

  check('the scope is per image like every other setting',
    await page.evaluate(() => {
      const items = window.App.main.getState().items;
      const eyed = items.find((i) => i.name === 'eye_on_black.png');
      return (
        eyed.settings.scope === 'all' &&
        items.filter((i) => i !== eyed).every((i) => i.settings.scope === 'outside')
      );
    }));

  await page.click('.scope-switch button[data-scope="outside"]');
  check('and switching back restores it', (await previewAlphaAt(...eyeCentre)) === 255);

  // --- export --------------------------------------------------------------
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.click('#exportBtn');
  const download = await downloadPromise;

  const outDir = path.join(dir, 'out');
  const zipPath = path.join(dir, download.suggestedFilename());
  await download.saveAs(zipPath);
  execFileSync('ditto', ['-x', '-k', zipPath, outDir]);
  const produced = fs.readdirSync(outDir).sort();

  check('every image is exported', produced.length === fixtures.length, produced.join(', '));
  check('all exports are PNG', produced.every((f) => f.endsWith('.png')));

  // --- the properties that matter ------------------------------------------
  const black = await describeAlpha(page, path.join(outDir, 'on_black.png'));
  check('the exported PNG carries real transparency',
    black.transparent > 0 && black.opaque > 0,
    `${black.transparent} clear / ${black.opaque} solid`);
  check('the backdrop corner is fully transparent', black.cornerAlpha === 0);
  check('the export is full resolution', black.width === 256 && black.height === 256);

  const white = await describeAlpha(page, path.join(outDir, 'on_white.png'));
  check('a white plate exports transparent too', white.transparent > 0 && white.cornerAlpha === 0);

  /**
   * The headline claim. A radial fade has no "edge" to find — a segmentation
   * model must invent one. Unmixing should return a continuous ramp, so the
   * exported file must contain many distinct alpha values, not two.
   */
  const soft = await describeAlpha(page, path.join(outDir, 'soft_on_black.png'));
  check('a soft edge survives as a gradient, not a binary cut',
    soft.partial > soft.opaque && soft.distinctAlphas > 50,
    `${soft.partial} partial px across ${soft.distinctAlphas} distinct alpha values`);

  // The eye must still be there after a full-resolution key and a real PNG
  // encode, not just in the preview.
  const eyed = await describeAlpha(page, path.join(outDir, 'eye_on_black.png'), [
    [112, 112], // dead centre of the eye
    [112, 96], // its rim
  ]);
  check('a hole inside the subject exports opaque',
    eyed.probeAlphas[0] === 255 && eyed.probeAlphas[1] === 255,
    `eye ${eyed.probeAlphas[0]}, rim ${eyed.probeAlphas[1]}`);
  check('the plate around that subject still goes',
    eyed.cornerAlpha === 0 && eyed.transparent > 0);

  check('no script errors across the whole run', errors.length === 0, errors.join(' | '));

  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
