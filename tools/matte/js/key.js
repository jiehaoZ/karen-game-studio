/**
 * Solid-colour unmixing — recovering transparency from a known background.
 *
 * The compositing equation behind every image with a flat backdrop is exact:
 *
 *     C = α·F + (1−α)·B
 *
 * where C is what you see, F is the true foreground colour, B is the backdrop
 * and α is opacity. With B unknown this is underdetermined — three equations,
 * four unknowns — which is precisely why neural matting models exist.
 *
 * Knowing B does not by itself make the system determined — on a black plate
 * it reduces to C = α·F, which is still three equations in four unknowns. What
 * *is* pinned down exactly is the product α·F, the premultiplied colour. Every
 * split of that product into an α and an F recomposites onto black identically.
 *
 * To hand back a separate α, this code assumes the foreground has at least one
 * channel near full — true of most artwork and lit subjects, and the same
 * assumption every luma keyer makes. Where it does not hold (a dark subject on
 * black), α comes out low, and the `high` handle exists to pull it back.
 *
 * That caveat granted, this still beats running a segmentation model here. A
 * segmentation model decides which pixels *belong* to the subject, so it can
 * decide wrong about hair, fur and motion blur. Unmixing never asks that
 * question — a strand covering 30% of a pixel comes out partially transparent
 * because the arithmetic has nowhere else to put it.
 */
(function (App) {
  'use strict';

  /**
   * How α is read off a pixel. All three then share the same unmix step.
   *
   * Black and white are not merely special cases of `color` — on those plates
   * one channel of the equation vanishes, which removes the guesswork entirely
   * and is why they key so much more cleanly than an arbitrary colour.
   */
  const MODES = Object.freeze({
    black: { id: 'black', label: '黑底', bg: [0, 0, 0], despill: false },
    white: { id: 'white', label: '白底', bg: [255, 255, 255], despill: false },
    color: { id: 'color', label: '取色', bg: null, despill: true },
  });

  /**
   * How much of the image the keyer is allowed to cut away.
   *
   * Unmixing works per pixel, and a pixel has no idea where it sits: a panda's
   * black eye on a black plate solves to α = 0 exactly like the plate does, so
   * a purely per-pixel keyer deletes the eye. Nothing in the colour can tell
   * them apart — the difference is topological. The backdrop is the region that
   * reaches the frame edge; the eye is enclosed by the subject.
   *
   * `outside` therefore keeps whatever the subject surrounds, which is what
   * people mean by "remove the background". `all` is the unrestricted
   * per-pixel behaviour, still the right answer when the colour genuinely
   * should go everywhere — knocking a colour out of a texture, or a subject
   * with real see-through holes.
   */
  const SCOPES = Object.freeze({
    outside: { id: 'outside', label: '主体外' },
    all: { id: 'all', label: '全图' },
  });

  const DEFAULTS = Object.freeze({
    mode: 'black',
    bgColor: [0, 177, 64],
    /** Alpha below this is forced to fully transparent — kills backdrop noise. */
    low: 0.04,
    /** Alpha above this is forced to fully opaque — solidifies the subject. */
    high: 0.92,
    /** Green/blue spill removal on the recovered foreground, 0-1. */
    despill: 0.8,
    /** 'outside' cuts only backdrop that reaches the frame edge, 'all' cuts anywhere. */
    scope: 'outside',
  });

  /** Alpha below this counts as backdrop when deciding what is enclosed. */
  const SEAL_THRESHOLD = 0.5;

  /**
   * How far a seal spreads into the ramp around a hole, in pixels.
   *
   * The rim of the eye is a blend of eye and fur, so it solves to a middling
   * α — above the threshold, hence not part of the hole, but still short of
   * opaque. Left alone it exports as a faint transparent outline tracing every
   * sealed region. Two pixels covers the anti-aliasing on a normal edge without
   * reaching far enough to touch the subject's own outline.
   */
  const SEAL_FEATHER = 2;

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /**
   * Remap α through a black/white point.
   *
   * The raw solve is correct but unforgiving: sensor noise or JPEG ringing in
   * the backdrop lands at α = 0.01 rather than 0, and a subject that is merely
   * very dark against black never quite reaches 1. These two handles are what
   * turn a mathematically right answer into a usable cut-out.
   */
  function levels(alpha, low, high) {
    if (high <= low) return alpha >= high ? 1 : 0;
    return clamp01((alpha - low) / (high - low));
  }

  /**
   * α for a black plate.
   *
   * C = α·F leaves α and F entangled, so this reads α off the brightest
   * channel — exact when the foreground peaks at full in some channel, and an
   * underestimate in proportion to how far below full it actually peaks.
   */
  function alphaOnBlack(r, g, b) {
    return Math.max(r, g, b) / 255;
  }

  /** α for a white plate — the same read, and the same caveat, inverted. */
  function alphaOnWhite(r, g, b) {
    return Math.max(255 - r, 255 - g, 255 - b) / 255;
  }

  /**
   * α for an arbitrary backdrop.
   *
   * Here the equation really is underdetermined, so distance from the backdrop
   * colour stands in for opacity, ramped between two thresholds. Green is
   * weighted down because a green screen saturates that channel far beyond
   * anything in the subject; treating all three equally would read a green-lit
   * edge as foreground.
   */
  function alphaOnColor(r, g, b, bg, softness) {
    const dr = r - bg[0];
    const dg = g - bg[1];
    const db = b - bg[2];
    const distance = Math.sqrt(dr * dr + dg * dg + db * db) / 441.673;
    return softness <= 0 ? (distance > 0 ? 1 : 0) : clamp01(distance / softness);
  }

  /**
   * Recover F from C, α and B — the rearrangement of the compositing equation.
   *
   * This is the step that keeps edges honest. Skipping it leaves every
   * semi-transparent pixel still carrying its share of backdrop colour, which
   * is exactly the dark or green fringe that makes a cut-out look pasted on.
   */
  function unmix(channel, alpha, bg) {
    if (alpha <= 0) return 0;
    const value = (channel - (1 - alpha) * bg) / alpha;
    return value < 0 ? 0 : value > 255 ? 255 : value;
  }

  /**
   * Pull green/blue spill out of the recovered foreground.
   *
   * Light bounces off a green screen onto the subject, so the unmix returns a
   * genuinely green-tinted foreground — correct as arithmetic, wrong as a
   * result. Clamping the offending channel toward its neighbours is the
   * standard remedy and costs nothing on footage that has no spill.
   */
  function despillPixel(rgb, bg, strength) {
    if (strength <= 0) return rgb;
    const [r, g, b] = rgb;
    // Whichever of green or blue dominates the backdrop is the one that spills.
    if (bg[1] >= bg[2]) {
      const limit = (r + b) / 2;
      if (g > limit) return [r, g + (limit - g) * strength, b];
    } else {
      const limit = (r + g) / 2;
      if (b > limit) return [r, g, b + (limit - b) * strength];
    }
    return rgb;
  }

  /**
   * Give back the α of everything the subject encloses.
   *
   * The backdrop is defined by connectivity, not colour: it is what a flood
   * fill from the frame edge can walk through without crossing the subject.
   * Anything transparent that the fill never reaches is a hole in the middle of
   * the subject — an eye, a black pupil, a dark button — and is restored to
   * opaque, keeping its own colour untouched because unmixing at α = 1 is the
   * identity.
   *
   * Connectivity is four-way deliberately. Eight-way would let the fill slip
   * through a subject outline that is only one pixel thick where it runs
   * diagonally, which is precisely where thin anti-aliased artwork lives.
   *
   * Nothing is mutated: the caller's array comes back untouched.
   *
   * @param {Float32Array|Uint8ClampedArray} alpha  one value per pixel
   * @returns {Float32Array|Uint8ClampedArray} a new array of the same type
   */
  function sealEnclosed(alpha, width, height, options = {}) {
    const {
      opaque = 1,
      threshold = SEAL_THRESHOLD * opaque,
      feather = SEAL_FEATHER,
    } = options;

    const count = width * height;
    const out = alpha.slice();
    if (count < 1 || out.length < count) return out;

    // 1. Everything the backdrop reaches from the frame edge.
    const outside = new Uint8Array(count);
    const queue = new Int32Array(count);
    let top = 0;

    const reach = (p) => {
      if (!outside[p] && out[p] < threshold) {
        outside[p] = 1;
        queue[top++] = p;
      }
    };

    for (let x = 0; x < width; x++) {
      reach(x);
      reach(count - width + x);
    }
    for (let y = 0; y < height; y++) {
      reach(y * width);
      reach(y * width + width - 1);
    }

    while (top > 0) {
      const p = queue[--top];
      const x = p % width;
      if (x > 0) reach(p - 1);
      if (x < width - 1) reach(p + 1);
      if (p >= width) reach(p - width);
      if (p < count - width) reach(p + width);
    }

    // 2. Transparent pixels it never reached are enclosed — seal them.
    const sealed = new Uint8Array(count);
    let holes = 0;
    for (let p = 0; p < count; p++) {
      if (!outside[p] && out[p] < threshold) {
        sealed[p] = 1;
        out[p] = opaque;
        holes++;
      }
    }
    if (!holes) return out;

    // 3. Take the ramp around each hole with it, a pixel at a time. Growing
    //    from a snapshot rather than in place keeps a pass from running away
    //    across a soft gradient in one sweep.
    for (let pass = 0; pass < feather; pass++) {
      const grown = [];
      for (let p = 0; p < count; p++) {
        if (sealed[p] || outside[p] || out[p] >= opaque) continue;
        const x = p % width;
        const touching =
          (x > 0 && sealed[p - 1]) ||
          (x < width - 1 && sealed[p + 1]) ||
          (p >= width && sealed[p - width]) ||
          (p < count - width && sealed[p + width]);
        if (touching) grown.push(p);
      }
      if (!grown.length) break;
      for (const p of grown) {
        sealed[p] = 1;
        out[p] = opaque;
      }
    }

    return out;
  }

  /**
   * The raw α for every pixel, before the levels are applied.
   *
   * Separated out because choosing sensible levels requires seeing the
   * distribution first — the handles are meant to be set from the image, not
   * guessed at.
   */
  function rawAlpha(source, options = {}) {
    const settings = { ...DEFAULTS, ...options };
    const mode = MODES[settings.mode] || MODES.black;
    const bg = mode.bg || settings.bgColor;
    const softness = clamp01(settings.softness === undefined ? 0.25 : settings.softness);

    const src = source.data;
    const out = new Float32Array(src.length / 4);
    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];
      out[p] =
        mode.id === 'black'
          ? alphaOnBlack(r, g, b)
          : mode.id === 'white'
            ? alphaOnWhite(r, g, b)
            : alphaOnColor(r, g, b, bg, softness);
    }
    return out;
  }

  /**
   * Choose levels from the image itself.
   *
   * The default handles cannot be right for every source, and the reason is
   * structural: α is read off the brightest channel, so a subject that never
   * reaches full brightness lands short of opaque no matter how clean the
   * plate is. A mid-toned subject keys to 0.9 and exports with a permanent
   * veil of transparency — correct arithmetic, useless result.
   *
   * So `high` is set to what the subject actually peaks at, and `low` to just
   * above the loudest thing in the backdrop. Both are read off the histogram
   * rather than assumed.
   */
  function suggestLevels(source, options = {}) {
    const alpha = rawAlpha(source, options);
    if (!alpha.length) return { low: DEFAULTS.low, high: DEFAULTS.high };

    const sorted = Float32Array.from(alpha).sort();
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

    // The subject's own peak, ignoring the top fraction so a stray hot pixel
    // does not set the ceiling for the whole image.
    const peak = at(0.999);

    // The backdrop is whatever sits at the bottom of the distribution. Its
    // upper reach is noise, and `low` needs to clear it with a little margin.
    const floorNoise = at(0.35);

    const high = Math.max(0.35, Math.min(1, peak * 0.98));
    const low = Math.min(high - 0.05, Math.max(0.01, floorNoise + 0.02));

    return { low, high };
  }

  /**
   * Key one image.
   *
   * @param {ImageData} source
   * @param {object} options  see DEFAULTS
   * @returns {{data: ImageData, stats: object}} new ImageData, source untouched
   */
  function key(source, options = {}) {
    const settings = { ...DEFAULTS, ...options };
    const mode = MODES[settings.mode] || MODES.black;
    const bg = mode.bg || settings.bgColor;

    const src = source.data;
    const out = new Uint8ClampedArray(src.length);
    const { low, high } = settings;
    const softness = clamp01(settings.softness === undefined ? 0.25 : settings.softness);
    const despillStrength = mode.despill ? clamp01(settings.despill) : 0;
    const count = src.length / 4;

    // Pass one: what the plate alone says about every pixel.
    let alphas = new Float32Array(count);
    for (let i = 0, p = 0; p < count; i += 4, p++) {
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];

      const raw =
        mode.id === 'black'
          ? alphaOnBlack(r, g, b)
          : mode.id === 'white'
            ? alphaOnWhite(r, g, b)
            : alphaOnColor(r, g, b, bg, softness);

      alphas[p] = levels(raw, low, high);
    }

    // Pass two: hand back whatever the subject encloses. Done before the
    // source's own alpha is folded in, so an image that arrived with real
    // transparency in the middle does not get it sealed shut.
    if ((SCOPES[settings.scope] || SCOPES.outside).id === 'outside') {
      alphas = sealEnclosed(alphas, source.width, source.height);
    }

    let transparent = 0;
    let opaque = 0;
    let partial = 0;

    // Pass three: recover the foreground and write the result.
    for (let i = 0, p = 0; p < count; i += 4, p++) {
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];

      let alpha = alphas[p];

      // Anything the source already marked transparent stays transparent.
      const sourceAlpha = src[i + 3] / 255;
      if (sourceAlpha < 1) alpha *= sourceAlpha;

      if (alpha <= 0) {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
        transparent++;
        continue;
      }

      let rgb = [unmix(r, alpha, bg[0]), unmix(g, alpha, bg[1]), unmix(b, alpha, bg[2])];
      if (despillStrength > 0) rgb = despillPixel(rgb, bg, despillStrength);

      out[i] = rgb[0];
      out[i + 1] = rgb[1];
      out[i + 2] = rgb[2];
      out[i + 3] = Math.round(alpha * 255);

      if (alpha >= 1) opaque++;
      else partial++;
    }

    const total = src.length / 4;
    return {
      data: new ImageData(out, source.width, source.height),
      stats: {
        total,
        transparent,
        opaque,
        partial,
        keptRatio: (opaque + partial) / total,
      },
    };
  }

  App.key = {
    DEFAULTS,
    MODES,
    SCOPES,
    SEAL_THRESHOLD,
    sealEnclosed,
    rawAlpha,
    suggestLevels,
    alphaOnBlack,
    alphaOnColor,
    alphaOnWhite,
    despillPixel,
    key,
    levels,
    unmix,
  };
})((window.App = window.App || {}));
