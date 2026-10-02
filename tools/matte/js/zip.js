/**
 * Minimal ZIP writer, store-only (no deflate).
 *
 * Every payload we pack is already a compressed image, so deflate would spend
 * CPU to gain a fraction of a percent. Storing keeps this to ~100 lines with
 * no dependency, which matters because the page must run from file:// with no
 * build step and no CDN.
 */
(function (App) {
  'use strict';

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** MS-DOS date/time pair, the only timestamp format a basic ZIP entry carries. */
  function dosDateTime(date) {
    const time =
      (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day =
      ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  function writeU32(view, offset, value) {
    view.setUint32(offset, value, true);
  }

  function writeU16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  /**
   * Pack entries into a ZIP blob.
   * @param {{name: string, bytes: Uint8Array}[]} entries
   * @returns {Blob}
   */
  function build(entries) {
    const encoder = new TextEncoder();
    const stamp = dosDateTime(new Date());
    const records = entries.map((entry) => {
      const nameBytes = encoder.encode(entry.name);
      return {
        nameBytes,
        bytes: entry.bytes,
        crc: crc32(entry.bytes),
        // Bit 11 marks the filename as UTF-8, so non-ASCII names survive.
        flags: 0x0800,
      };
    });

    const LOCAL_HEADER = 30;
    const CENTRAL_HEADER = 46;
    const EOCD = 22;

    const localSize = records.reduce(
      (sum, r) => sum + LOCAL_HEADER + r.nameBytes.length + r.bytes.length,
      0
    );
    const centralSize = records.reduce(
      (sum, r) => sum + CENTRAL_HEADER + r.nameBytes.length,
      0
    );

    const buffer = new ArrayBuffer(localSize + centralSize + EOCD);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    let offset = 0;
    const offsets = [];

    for (const record of records) {
      offsets.push(offset);
      writeU32(view, offset, 0x04034b50); // local file header signature
      writeU16(view, offset + 4, 20); // version needed
      writeU16(view, offset + 6, record.flags);
      writeU16(view, offset + 8, 0); // method: store
      writeU16(view, offset + 10, stamp.time);
      writeU16(view, offset + 12, stamp.day);
      writeU32(view, offset + 14, record.crc);
      writeU32(view, offset + 18, record.bytes.length); // compressed
      writeU32(view, offset + 22, record.bytes.length); // uncompressed
      writeU16(view, offset + 26, record.nameBytes.length);
      writeU16(view, offset + 28, 0); // extra field length
      offset += LOCAL_HEADER;

      bytes.set(record.nameBytes, offset);
      offset += record.nameBytes.length;
      bytes.set(record.bytes, offset);
      offset += record.bytes.length;
    }

    const centralStart = offset;

    records.forEach((record, index) => {
      writeU32(view, offset, 0x02014b50); // central directory signature
      writeU16(view, offset + 4, 20); // version made by
      writeU16(view, offset + 6, 20); // version needed
      writeU16(view, offset + 8, record.flags);
      writeU16(view, offset + 10, 0); // method: store
      writeU16(view, offset + 12, stamp.time);
      writeU16(view, offset + 14, stamp.day);
      writeU32(view, offset + 16, record.crc);
      writeU32(view, offset + 20, record.bytes.length);
      writeU32(view, offset + 24, record.bytes.length);
      writeU16(view, offset + 28, record.nameBytes.length);
      writeU16(view, offset + 30, 0); // extra
      writeU16(view, offset + 32, 0); // comment
      writeU16(view, offset + 34, 0); // disk number
      writeU16(view, offset + 36, 0); // internal attrs
      writeU32(view, offset + 38, 0); // external attrs
      writeU32(view, offset + 42, offsets[index]);
      offset += CENTRAL_HEADER;

      bytes.set(record.nameBytes, offset);
      offset += record.nameBytes.length;
    });

    writeU32(view, offset, 0x06054b50); // end of central directory
    writeU16(view, offset + 4, 0);
    writeU16(view, offset + 6, 0);
    writeU16(view, offset + 8, records.length);
    writeU16(view, offset + 10, records.length);
    writeU32(view, offset + 12, centralSize);
    writeU32(view, offset + 16, centralStart);
    writeU16(view, offset + 20, 0); // comment length

    return new Blob([buffer], { type: 'application/zip' });
  }

  App.zip = { build, crc32 };
})((window.App = window.App || {}));
