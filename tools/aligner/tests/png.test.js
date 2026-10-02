/**
 * The indexed PNG encoder.
 *
 * These tests read the bytes back rather than trusting a decoder to be
 * forgiving. A PNG that a browser happens to open is not the same thing as a
 * PNG that is correct — chunk CRCs, the tRNS prefix rule and the scanline bit
 * packing all have exactly one right answer, and a wrong one can still render
 * on the machine it was written on.
 *
 * The end-to-end check that real decoders agree lives in tests/e2e.mjs, which
 * unpacks an exported ZIP and hands the files to `sips`.
 */
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const { loadApp } = require('./harness');

const App = loadApp(['png.js']);
const P = App.png;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Walk the chunk list, verifying every CRC on the way through. */
function parse(bytes) {
  const buffer = Buffer.from(bytes);
  assert.ok(buffer.subarray(0, 8).equals(SIGNATURE), 'PNG signature');

  const chunks = [];
  let at = 8;
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.subarray(at + 4, at + 8).toString('latin1');
    const data = buffer.subarray(at + 8, at + 8 + length);
    const stated = buffer.readUInt32BE(at + 8 + length);
    const actual = zlib.crc32
      ? zlib.crc32(buffer.subarray(at + 4, at + 8 + length))
      : P.crc32(buffer.subarray(at + 4, at + 8 + length));
    assert.strictEqual(actual >>> 0, stated, `${type} chunk CRC`);
    chunks.push({ type, data });
    at += 12 + length;
  }
  return chunks;
}

/** Inflate IDAT and unpack the scanlines back into one index per pixel. */
function decodeIndices(chunks, width, height, depth) {
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);
  const rowBytes = Math.ceil((width * depth) / 8);
  assert.strictEqual(raw.length, (rowBytes + 1) * height, 'raw scanline length');

  const out = [];
  const perByte = 8 / depth;
  const mask = (1 << depth) - 1;
  for (let y = 0; y < height; y++) {
    const start = y * (rowBytes + 1);
    assert.strictEqual(raw[start], 0, `row ${y} must use filter None`);
    for (let x = 0; x < width; x++) {
      if (depth === 8) {
        out.push(raw[start + 1 + x]);
      } else {
        const byte = raw[start + 1 + Math.floor(x / perByte)];
        const shift = 8 - depth * ((x % perByte) + 1);
        out.push((byte >> shift) & mask);
      }
    }
  }
  return out;
}

function solidPalette(n) {
  const palette = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    palette[i * 4] = i * 3;
    palette[i * 4 + 1] = 255 - i;
    palette[i * 4 + 2] = (i * 7) & 255;
    palette[i * 4 + 3] = 255;
  }
  return palette;
}

test('crc32 matches the known value for an empty IEND', () => {
  // The CRC of the four type bytes with no data; every PNG in existence ends
  // with this exact number, which makes it a good fixed point to test against.
  const iend = new Uint8Array([0x49, 0x45, 0x4e, 0x44]);
  assert.strictEqual(P.crc32(iend), 0xae426082);
});

test('bit depth is the smallest one that can address the palette', () => {
  assert.strictEqual(P.bitDepthFor(1), 1);
  assert.strictEqual(P.bitDepthFor(2), 1);
  assert.strictEqual(P.bitDepthFor(3), 2);
  assert.strictEqual(P.bitDepthFor(4), 2);
  assert.strictEqual(P.bitDepthFor(5), 4);
  assert.strictEqual(P.bitDepthFor(16), 4);
  assert.strictEqual(P.bitDepthFor(17), 8);
  assert.strictEqual(P.bitDepthFor(256), 8);
});

test('packRow writes high bits first and pads to a byte boundary', () => {
  // Three 2-bit values in one byte, the fourth field left as padding.
  const out = new Uint8Array(2);
  P.packRow(new Uint8Array([1, 2, 3]), 0, 3, 2, out, 0);
  assert.strictEqual(out[0], 0b01101100);
  assert.strictEqual(out[1], 0, 'padding is not written into the next byte');
});

test('tRNS is a prefix and disappears when nothing is transparent', () => {
  const opaque = P.splitPalette(solidPalette(4));
  assert.strictEqual(opaque.trns, null, 'a fully opaque palette needs no tRNS');
  assert.strictEqual(opaque.plte.length, 12);

  // Alpha-sorted: two transparent entries, then two opaque ones.
  const mixed = new Uint8Array([1, 1, 1, 0, 2, 2, 2, 128, 3, 3, 3, 255, 4, 4, 4, 255]);
  const { trns } = P.splitPalette(mixed);
  assert.deepStrictEqual(
    Array.from(trns),
    [0, 128],
    'tRNS stops after the last non-opaque entry; the rest are implicitly opaque'
  );
});

test('chunks appear in the order the spec requires', async () => {
  const palette = new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]);
  const blob = await P.encodeIndexed({
    palette,
    indices: new Uint8Array([0, 1, 1, 0]),
    width: 2,
    height: 2,
  });
  const chunks = parse(new Uint8Array(await blob.arrayBuffer()));

  assert.deepStrictEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']
  );
});

test('IHDR declares an indexed, non-interlaced image', async () => {
  const blob = await P.encodeIndexed({
    palette: solidPalette(5),
    indices: new Uint8Array(6 * 3).fill(4),
    width: 6,
    height: 3,
  });
  const [ihdr] = parse(new Uint8Array(await blob.arrayBuffer()));
  const view = Buffer.from(ihdr.data);

  assert.strictEqual(view.readUInt32BE(0), 6, 'width');
  assert.strictEqual(view.readUInt32BE(4), 3, 'height');
  assert.strictEqual(view[8], 4, 'bit depth for a 5-colour palette');
  assert.strictEqual(view[9], 3, 'colour type: indexed');
  assert.strictEqual(view[10], 0, 'compression: deflate');
  assert.strictEqual(view[11], 0, 'filter method');
  assert.strictEqual(view[12], 0, 'not interlaced');
});

test('indices survive the round trip at every bit depth', async () => {
  // Widths deliberately not multiples of the fields-per-byte, so the padding
  // path is exercised rather than the aligned happy case.
  for (const [colors, width, height] of [
    [2, 7, 3],
    [4, 13, 2],
    [16, 5, 4],
    [256, 11, 3],
  ]) {
    const depth = P.bitDepthFor(colors);
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i++) indices[i] = (i * 5 + 1) % colors;

    const blob = await P.encodeIndexed({
      palette: solidPalette(colors),
      indices,
      width,
      height,
    });
    const chunks = parse(new Uint8Array(await blob.arrayBuffer()));

    assert.deepStrictEqual(
      decodeIndices(chunks, width, height, depth),
      Array.from(indices),
      `${colors} colours at ${width}x${height} (${depth}-bit)`
    );
  }
});

test('IDAT carries a zlib wrapper, not a raw deflate stream', async () => {
  const blob = await P.encodeIndexed({
    palette: solidPalette(4),
    indices: new Uint8Array([0, 1, 2, 3]),
    width: 4,
    height: 1,
  });
  const chunks = parse(new Uint8Array(await blob.arrayBuffer()));
  const idat = chunks.find((c) => c.type === 'IDAT').data;

  // PNG mandates zlib-wrapped deflate. A raw stream would decode in some
  // viewers and fail in others, which is the worst kind of bug to ship.
  assert.doesNotThrow(() => zlib.inflateSync(Buffer.from(idat)));
  assert.strictEqual(idat[0] & 0x0f, 8, 'zlib compression method');
});

test('a palette outside 1-256 entries is refused', async () => {
  await assert.rejects(
    P.encodeIndexed({
      palette: new Uint8Array(257 * 4),
      indices: new Uint8Array(1),
      width: 1,
      height: 1,
    }),
    /1-256/
  );
});

test('an index count that disagrees with the dimensions is refused', async () => {
  await assert.rejects(
    P.encodeIndexed({
      palette: solidPalette(4),
      indices: new Uint8Array(5),
      width: 3,
      height: 3,
    }),
    /dimensions/
  );
});
