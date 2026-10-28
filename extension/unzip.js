/*
 * unzip.js  (ISOLATED world)
 *
 * Minimal ZIP reader used for the "Import MD" feature. Parses the central
 * directory (robust for zips written by other tools, incl. macOS Finder), and
 * extracts each entry — STORE (method 0) directly, DEFLATE (method 8) via the
 * browser's native DecompressionStream. Returns UTF-8 text per entry.
 *
 * window.RinggUnzip.read(arrayBuffer) -> Promise<[{ name, text }]>
 */
(function () {
  "use strict";

  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  function TooLarge() { var e = new Error("too large"); e.tooLarge = true; return e; }
  async function inflateRaw(bytes, max) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This browser can't decompress the zip. Re-zip without compression, or use the zip the exporter produced.");
    }
    var ds = new DecompressionStream("deflate-raw");
    var reader = new Blob([bytes]).stream().pipeThrough(ds).getReader();
    var chunks = [], total = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      total += r.value.length;
      if (max && total > max) { try { reader.cancel(); } catch (e) {} throw TooLarge(); }   // stop early: the entry lied about its size
      chunks.push(r.value);
    }
    var out = new Uint8Array(total), o = 0;
    chunks.forEach(function (c) { out.set(c, o); o += c.length; });
    return out;
  }

  async function read(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var dv = new DataView(arrayBuffer);
    var n = bytes.length;

    // Find End Of Central Directory (signature 0x06054b50), scanning backwards.
    var eocd = -1;
    for (var i = n - 22; i >= 0 && i >= n - 22 - 65536; i--) {
      if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a valid .zip file (no end-of-central-directory record).");

    var count = u16(dv, eocd + 10);
    var cdOffset = u32(dv, eocd + 16);

    var out = [], skipped = [], parsed = 0;
    var MAX_ENTRY = 20 * 1024 * 1024;
    var p = cdOffset;
    var dec = new TextDecoder("utf-8");

    for (var e = 0; e < count; e++) {
      if (u32(dv, p) !== 0x02014b50) break; // central dir header
      parsed++;
      var flag = u16(dv, p + 8);
      var method = u16(dv, p + 10);
      var compSize = u32(dv, p + 20);
      var rawSize = u32(dv, p + 24);
      var nameLen = u16(dv, p + 28);
      var extraLen = u16(dv, p + 30);
      var commentLen = u16(dv, p + 32);
      var localOff = u32(dv, p + 42);
      var name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));

      // Jump to the local header to find where the data actually starts.
      if (u32(dv, localOff) === 0x04034b50) {
        var lNameLen = u16(dv, localOff + 26);
        var lExtraLen = u16(dv, localOff + 28);
        var dataStart = localOff + 30 + lNameLen + lExtraLen;
        var comp = bytes.subarray(dataStart, dataStart + compSize);

        var isDir = /\/$/.test(name);
        var isJunk = name.indexOf("__MACOSX/") === 0 || /(^|\/)\.DS_Store$/.test(name);
        if (!isDir && !isJunk) {
          if (flag & 0x0001) throw new Error("This zip is password-protected/encrypted — unzip it first, then import the plain files.");
          if (dataStart + compSize > bytes.length) throw new Error("The zip looks truncated or corrupt (\"" + name + "\" data is incomplete).");
          if (rawSize > MAX_ENTRY || compSize > MAX_ENTRY) { skipped.push({ name: name, why: "too large" }); p += 46 + nameLen + extraLen + commentLen; continue; }
          var raw;
          if (method === 0) raw = comp;
          else if (method === 8) {
            try { raw = await inflateRaw(comp, MAX_ENTRY); }
            catch (e) { if (e && e.message && /decompress the zip/.test(e.message)) throw e; skipped.push({ name: name, why: e && e.tooLarge ? "too large" : "damaged" }); p += 46 + nameLen + extraLen + commentLen; continue; }
          }
          else { skipped.push({ name: name, why: "unsupported compression" }); p += 46 + nameLen + extraLen + commentLen; continue; }
          out.push({ name: name, text: dec.decode(raw) });
        }
      }
      else if (!/\/$/.test(name)) skipped.push({ name: name, why: "damaged" });
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (parsed < count && !out.length) throw new Error("The zip looks damaged (its file list is broken). Re-export or re-zip it and try again.");
    if (!out.length && skipped.length) {
      throw new Error(skipped.every(function (s) { return s.why === "unsupported compression"; })
        ? "This zip uses a compression method the plugin can't read. Re-zip it with standard (Deflate) compression."
        : (skipped.every(function (s) { return s.why === "too large"; })
          ? "The files in this zip are too large to import (over 20 MB each)."
          : "The zip looks damaged — its files couldn't be read. Re-export or re-zip it and try again."));
    }
    out.skipped = skipped;
    return out;
  }

  window.RinggUnzip = { read: read };
})();
