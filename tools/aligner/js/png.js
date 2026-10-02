/**
 * Indexed (colour type 3) PNG encoder.
 *
 * The browser will happily encode a PNG for you, but only ever a 32-bit
 * truecolour one. There is no canvas API for "write this as a palette image",
 * and a palette image is the entire reason a keyed-out sprite compresses to a
 * quarter of its size. So the container gets written here.
 *
 * The file this produces is an ordinary PNG — palette images are in the base
 * spec, not an extension, and have been read by everything since 1996. The
 * pieces:
 *
 *   IHDR  colour type 3, bit depth 1/2/4/8 depending on palette size
 *   PLTE  RGB triples
 *   tRNS  alpha bytes, a *prefix* of the palette — entries past the end of
 *         this chunk are opaque, which is why the palette arrives sorted with
 *         the transparent entries first
 *   IDAT  zlib-deflated scanlines, each prefixed with a filter-type byte
 *   IEND
 *
 * Every scanline uses filter 0 (None). For truecolour that would be leaving
 * compression on the table, but on indexed data the filters are actively
 * harmful: they subtract neighbouring bytes, and the difference between two
 * palette *indices* is a meaningless number. Optimisers reach the same
 * conclusion — paletted images come out unfiltered.
 *
 * Deflate comes from CompressionStream, which is native and produces the zlib
 * wrapper PNG expects. No dependency, no bundled implementation.
 */
(function (App) {
  'use strict';

  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * Smallest bit depth that can address the palette.
   *
   * Only 1, 2, 4 and 8 are legal for indexed PNG. A 16-colour sprite stored at
   * 4 bits per pixel is half the raw size before deflate even runs, and deflate
   * does not fully recover that difference on its own.
   */
  function bitDepthFor(colors) {
    if (colors <= 2) return 1;
    if (colors <= 4) return 2;
    if (colors <= 16) return 4;
    return 8;
  }

  /**
   * Pack one row of palette indices into `depth`-bit fields, high bits first.
   *
   * Rows always start on a byte boundary — PNG pads the end of each scanline
   * rather than letting rows share a byte.
   */
  function packRow(indices, offset, width, depth, out, outOffset) {
    if (depth === 8) {
      for (let x = 0; x < width; x++) out[outOffset + x] = indices[offset + x];
      return;
    }
    const perByte = 8 / depth;
    const mask = (1 << depth) - 1;
    for (let x = 0; x < width; x++) {
      const byte = outOffset + Math.floor(x / perByte);
      const shift = 8 - depth * ((x % perByte) + 1);
      out[byte] |= (indices[offset + x] & mask) << shift;
    }
  }

  /** Raw scanlines, each prefixed with its filter-type byte. */
  function buildRaw(indices, width, height, depth) {
    const rowBytes = Math.ceil((width * depth) / 8);
    const raw = new Uint8Array((rowBytes + 1) * height);
    for (let y = 0; y < height; y++) {
      const at = y * (rowBytes + 1);
      raw[at] = 0; // filter: None
      packRow(indices, y * width, width, depth, raw, at + 1);
    }
    return raw;
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function chunk(type, body) {
    const out = new Uint8Array(body.length + 12);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
    return out;
  }

  /**
   * Split the palette into the PLTE and tRNS chunk bodies.
   *
   * tRNS is truncated after the last entry that is not fully opaque. The
   * palette is expected to be sorted alpha-ascending (see quantize.sortByAlpha)
   * so that cut lands as early as possible; on a fully opaque image the chunk
   * disappears entirely.
   */
  function splitPalette(palette) {
    const colors = palette.length / 4;
    const plte = new Uint8Array(colors * 3);
    let lastTransparent = -1;
    for (let i = 0; i < colors; i++) {
      plte[i * 3] = palette[i * 4];
      plte[i * 3 + 1] = palette[i * 4 + 1];
      plte[i * 3 + 2] = palette[i * 4 + 2];
      if (palette[i * 4 + 3] !== 255) lastTransparent = i;
    }
    if (lastTransparent < 0) return { plte, trns: null };

    const trns = new Uint8Array(lastTransparent + 1);
    for (let i = 0; i <= lastTransparent; i++) trns[i] = palette[i * 4 + 3];
    return { plte, trns };
  }

  /**
   * Encode indexed pixels as a PNG.
   *
   * @param {{palette: Uint8Array, indices: Uint8Array, width, height}} image
   *   `palette` is RGBA quads; `indices` is one byte per pixel, row-major.
   * @returns {Promise<Blob>}
   */
  async function encodeIndexed(image) {
    const { palette, indices, width, height } = image;
    const colors = palette.length / 4;
    if (colors < 1 || colors > 256) {
      throw new Error(`palette must hold 1-256 colours, got ${colors}`);
    }
    if (indices.length !== width * height) {
      throw new Error('index count does not match the image dimensions');
    }

    const depth = bitDepthFor(colors);

    const ihdr = new Uint8Array(13);
    const header = new DataView(ihdr.buffer);
    header.setUint32(0, width);
    header.setUint32(4, height);
    ihdr[8] = depth;
    ihdr[9] = 3; // colour type: indexed
    ihdr[10] = 0; // deflate
    ihdr[11] = 0; // adaptive filtering
    ihdr[12] = 0; // no interlace

    const { plte, trns } = splitPalette(palette);
    const idat = await deflate(buildRaw(indices, width, height, depth));

    const parts = [
      new Uint8Array(SIGNATURE),
      chunk('IHDR', ihdr),
      chunk('PLTE', plte),
      ...(trns ? [chunk('tRNS', trns)] : []),
      chunk('IDAT', idat),
      chunk('IEND', new Uint8Array(0)),
    ];

    return new Blob(parts, { type: 'image/png' });
  }

  App.png = {
    bitDepthFor,
    buildRaw,
    chunk,
    crc32,
    encodeIndexed,
    packRow,
    splitPalette,
  };
})((typeof window !== 'undefined' ? (window.App = window.App || {}) : (module.exports = {})));
