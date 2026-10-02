/**
 * Loads the browser modules into Node.
 *
 * The app ships as plain <script> tags so it runs from file:// with no build
 * step. That rules out import/export, so each file is evaluated as a function
 * body with the browser globals it touches passed in as arguments.
 *
 * Deliberately not `vm.createContext`: a vm context is a separate realm, so
 * objects built inside it carry a different Object.prototype and every
 * `deepStrictEqual` against a plain literal fails on the prototype check alone.
 * Evaluating in this realm keeps assertions meaningful.
 */
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIR = path.join(__dirname, '..', 'js');

/** Enough of `document` for the modules that reach for a scratch canvas. */
function fakeDocument() {
  return {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          clearRect() {},
          save() {},
          restore() {},
          fillRect() {},
          drawImage() {},
          createPattern: () => null,
          beginPath() {},
          stroke() {},
          strokeRect() {},
          arc() {},
          rect() {},
          moveTo() {},
          lineTo() {},
          setLineDash() {},
        }),
        toBlob(callback) {
          callback(new Blob([new Uint8Array(1)]));
        },
      };
    },
  };
}

/**
 * Load modules and hand back both the app and the `document` they were given,
 * so a test can swap `createElement` to capture scratch canvases.
 */
function loadEnv(files) {
  const windowStub = {};
  const documentStub = fakeDocument();

  for (const file of files) {
    const code = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8');
    // eslint-disable-next-line no-new-func
    const module = new Function('window', 'document', 'URL', `${code}\n//# sourceURL=${file}`);
    module(windowStub, documentStub, globalThis.URL);
  }

  return { App: windowStub.App, document: documentStub };
}

function loadApp(files) {
  return loadEnv(files).App;
}

/** A stand-in for HTMLImageElement, which only needs its natural dimensions. */
function fakeImage(width, height, src = 'data:,') {
  return { naturalWidth: width, naturalHeight: height, src };
}

module.exports = { loadApp, loadEnv, fakeImage };
