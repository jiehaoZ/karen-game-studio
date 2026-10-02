/**
 * Application state.
 *
 * Every image carries its own keying settings. Sharing one global set would be
 * simpler, but a batch is rarely uniform — one frame is on a clean plate, the
 * next has a shadow falling across it — and having to re-dial the sliders each
 * time you click a different image would make batches pointless.
 */
(function (App) {
  'use strict';

  /**
   * Longest edge of the preview raster.
   *
   * Keying runs over every pixel on every slider move. At full resolution a
   * large source would stall the drag; the export path uses the original
   * pixels, so nothing is lost but preview fidelity.
   */
  const PREVIEW_LIMIT = 1100;

  const VIEWS = Object.freeze(['result', 'alpha', 'source']);

  const DEFAULT_STATE = Object.freeze({
    items: Object.freeze([]),
    selectedId: null,
    view: 'result',
    /** Backdrop shown behind the cut-out: 'checker' | 'dark' | 'light'. */
    backdrop: 'checker',
    busy: null,
  });

  let nextId = 1;

  function createItem({ name, source, preview, detection }) {
    // Levels read off this image, not the global defaults — see
    // App.key.suggestLevels for why a fixed default cannot be right.
    const suggested = App.key.suggestLevels(preview, {
      mode: detection.mode,
      bgColor: detection.bgColor,
    });

    return Object.freeze({
      id: `img-${nextId++}`,
      name,
      /** Full-resolution pixels, used only on export. */
      source,
      /** Downscaled pixels the interactive preview keys against. */
      preview,
      settings: Object.freeze({
        mode: detection.mode,
        bgColor: detection.bgColor,
        low: suggested.low,
        high: suggested.high,
        despill: App.key.DEFAULTS.despill,
        softness: 0.25,
        scope: App.key.DEFAULTS.scope,
      }),
      detection,
      /** Set when the AI layer has produced a mask for this image. */
      aiAlpha: null,
      useAi: false,
    });
  }

  function findItem(state, id) {
    return state.items.find((item) => item.id === id) || null;
  }

  function selectedItem(state) {
    return findItem(state, state.selectedId);
  }

  /** Returns the same state object when nothing actually changes. */
  function updateItem(state, id, changes) {
    const item = findItem(state, id);
    if (!item) return state;
    if (Object.keys(changes).every((k) => Object.is(item[k], changes[k]))) return state;

    return {
      ...state,
      items: state.items.map((entry) =>
        entry.id === id ? Object.freeze({ ...entry, ...changes }) : entry
      ),
    };
  }

  function updateSettings(state, id, changes) {
    const item = findItem(state, id);
    if (!item) return state;
    if (Object.keys(changes).every((k) => Object.is(item.settings[k], changes[k]))) {
      return state;
    }
    return updateItem(state, id, {
      settings: Object.freeze({ ...item.settings, ...changes }),
    });
  }

  function addItems(state, entries) {
    const items = entries.map(createItem);
    return {
      ...state,
      items: [...state.items, ...items],
      selectedId: state.selectedId || (items.length ? items[0].id : null),
    };
  }

  function removeItem(state, id) {
    const remaining = state.items.filter((item) => item.id !== id);
    return {
      ...state,
      items: remaining,
      selectedId:
        state.selectedId === id ? (remaining.length ? remaining[0].id : null) : state.selectedId,
    };
  }

  /** Copy the selected image's settings onto every other image. */
  function applySettingsToAll(state) {
    const source = selectedItem(state);
    if (!source) return state;
    return {
      ...state,
      items: state.items.map((item) =>
        item.id === source.id ? item : Object.freeze({ ...item, settings: source.settings })
      ),
    };
  }

  /** Scale factor that fits an image within the preview limit, never upscaling. */
  function previewScale(width, height) {
    return Math.min(1, PREVIEW_LIMIT / Math.max(width, height));
  }

  App.state = {
    DEFAULT_STATE,
    PREVIEW_LIMIT,
    VIEWS,
    addItems,
    applySettingsToAll,
    createItem,
    findItem,
    previewScale,
    removeItem,
    selectedItem,
    updateItem,
    updateSettings,
  };
})((window.App = window.App || {}));
