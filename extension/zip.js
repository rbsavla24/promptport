/*
 * zip.js  (ISOLATED world)
 *
 * Tiny, dependency-free ZIP writer. Uses the STORE method (no compression),
 * which keeps the code small and needs no external library. Good enough for a
 * handful of small markdown files. Exposes window.RinggZip.make(files) where
 * files = [{ name: "objective.md", content: "..." }] and returns a Blob.
 */
(function () {
  "use strict";

  // CRC32 -------------------------------------------------------------------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function strBytes(str) {
    return new TextEncoder().encode(str);
  }

  function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
  function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }

  function make(files) {
    var chunks = [];        // array of Uint8Array/number[] to concat
    var central = [];
    var offset = 0;

    function push(arr) {
      chunks.push(arr);
      offset += arr.length;
    }

    files.forEach(function (f) {
      var nameBytes = strBytes(f.name);
      var dataBytes = strBytes(f.content == null ? "" : String(f.content));
      var crc = crc32(dataBytes);
      var localOffset = offset;

      // Local file header
      var local = [].concat(
        u32(0x04034b50),   // signature
        u16(20),           // version needed
        u16(0x0800),       // flags (bit 11 = UTF-8 filenames)
        u16(0),            // method = store
        u16(0), u16(0),    // mod time, mod date (0)
        u32(crc),
        u32(dataBytes.length), // compressed size
        u32(dataBytes.length), // uncompressed size
        u16(nameBytes.length),
        u16(0)             // extra len
      );
      push(new Uint8Array(local));
      push(nameBytes);
      push(dataBytes);

      // Central directory record (kept for the end)
      var cd = [].concat(
        u32(0x02014b50),
        u16(20),           // version made by
        u16(20),           // version needed
        u16(0x0800),       // flags (bit 11 = UTF-8 filenames)
        u16(0),            // method
        u16(0), u16(0),    // time, date
        u32(crc),
        u32(dataBytes.length),
        u32(dataBytes.length),
        u16(nameBytes.length),
        u16(0),            // extra len
        u16(0),            // comment len
        u16(0),            // disk number
        u16(0),            // internal attrs
        u32(0),            // external attrs
        u32(localOffset)
      );
      central.push({ head: new Uint8Array(cd), name: nameBytes });
    });

    var cdStart = offset;
    var cdSize = 0;
    central.forEach(function (c) {
      push(c.head);
      push(c.name);
      cdSize += c.head.length + c.name.length;
    });

    // End of central directory
    var end = [].concat(
      u32(0x06054b50),
      u16(0), u16(0),
      u16(files.length),
      u16(files.length),
      u32(cdSize),
      u32(cdStart),
      u16(0)
    );
    push(new Uint8Array(end));

    // Concatenate everything into a single Blob
    var total = 0;
    chunks.forEach(function (c) { total += c.length; });
    var out = new Uint8Array(total);
    var pos = 0;
    chunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
    make.lastBytes = out;
    return new Blob([out], { type: "application/zip" });
  }

  // Same archive as a data: URL. Used for downloads because Chrome ignores the
  // <a download="name"> attribute on blob: URLs minted inside a content script
  // (the file would save as "download"); a data: URL keeps the real filename.
  function toDataUrl(files) {
    window.RinggZip.make(files); // (via the public name so test spies see it)
    var bytes = make.lastBytes, bin = "", CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return "data:application/zip;base64," + btoa(bin);
  }

  window.RinggZip = { make: make, crc32: crc32, toDataUrl: toDataUrl };
})();
