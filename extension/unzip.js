/*
 * unzip.js  (ISOLATED world)
 *
 * Minimal ZIP reader used for the "Import MD" feature. Parses the central
 * directory (robust for zips written by other tools, incl. macOS Finder and
 * Windows Compress-Archive), and extracts each entry — STORE (method 0)
 * directly, DEFLATE (method 8) via the browser's native DecompressionStream.
 * Returns decoded text per entry (UTF-8, or UTF-16 when the entry has a BOM).
 *
 * window.PPUnzip.read(arrayBuffer) -> Promise<[{ name, text }]> (+ .skipped)
 *
 * Safety limits (a zip is untrusted input):
 *   - only .md / .markdown / .txt / .json entries are inflated; other entries
 *     are listed in .skipped ("not a prompt file") without being read;
 *   - at most MAX_ENTRIES central-directory records;
 *   - each entry ≤ MAX_ENTRY bytes inflated, all entries together ≤ MAX_TOTAL;
 *   - two directory records pointing at the same local entry (overlapping-entry
 *     "zip bomb") are rejected — the duplicate is skipped;
 *   - a damaged / encrypted / binary entry is skipped (listed), never fatal on
 *     its own: the good files in the same zip still import.
 * The same ArrayBuffer is parsed once — later calls share the first result.
 */
(function () {
  "use strict";

  var MAX_ENTRY = 20 * 1024 * 1024;
  var MAX_TOTAL = 50 * 1024 * 1024;
  var MAX_ENTRIES = 2000;
  var TEXT_ENTRY = /\.(md|markdown|txt|json)$/i;

  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  // CRC-32 (the zip checksum): an entry whose bytes no longer match the
  // checksum in its directory record was damaged in transit -> skipped.
  var CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (var k = 0; k < 256; k++) {
        var c = k;
        for (var b = 0; b < 8; b++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[k] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

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
      if (max != null && total > max) { try { reader.cancel(); } catch (e) {} throw TooLarge(); }   // stop early: the entry lied about its size
      chunks.push(r.value);
    }
    var out = new Uint8Array(total), o = 0;
    chunks.forEach(function (c) { out.set(c, o); o += c.length; });
    return out;
  }

  // Text that is really a binary file (image, PDF, Office document) read as text.
  function looksBinary(t) {
    t = String(t || "");
    if (t.indexOf("\u0000") !== -1) return true;
    var bad = (t.match(/�/g) || []).length;
    return bad >= 8 || (bad > 0 && bad / t.length > 0.01);
  }

  // Decode an entry: honour a UTF-8 / UTF-16LE / UTF-16BE byte-order mark; a
  // BOM-less file whose odd (or even) bytes are all NUL is UTF-16 too.
  function decodeText(raw) {
    var enc = "utf-8", start = 0;
    if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) start = 3;
    else if (raw.length >= 2 && raw[0] === 0xFF && raw[1] === 0xFE) { enc = "utf-16le"; start = 2; }
    else if (raw.length >= 2 && raw[0] === 0xFE && raw[1] === 0xFF) { enc = "utf-16be"; start = 2; }
    else if (raw.length >= 4 && raw.length % 2 === 0) {
      var n = Math.min(raw.length, 512), zOdd = 0, zEven = 0;
      for (var i = 0; i < n; i++) if (raw[i] === 0) { if (i % 2) zOdd++; else zEven++; }
      if (zOdd >= n / 2 * 0.9 && zEven === 0) enc = "utf-16le";
      else if (zEven >= n / 2 * 0.9 && zOdd === 0) enc = "utf-16be";
    }
    var body = raw.subarray(start), txt;
    try { txt = new TextDecoder(enc).decode(body); }
    catch (e) { txt = new TextDecoder("utf-8").decode(body); }
    // Not valid UTF-8 and no NUL bytes: most likely an ANSI (Windows-1252)
    // text file — decode it as that instead of showing replacement characters.
    if (enc === "utf-8" && txt.indexOf("\uFFFD") !== -1 && body.indexOf(0) === -1) {
      try { new TextDecoder("utf-8", { fatal: true }).decode(body); return txt; } catch (e) {}
      try {
        var ansi = new TextDecoder("windows-1252").decode(body);
        var ctl = (ansi.match(/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g) || []).length;
        if (!(ctl > 0 && ctl / ansi.length > 0.01)) return ansi;
      } catch (e) {}
    }
    return txt;
  }

  // Find the End Of Central Directory record. Scanning backwards, a candidate
  // only counts when it is self-consistent: its comment ends exactly at the end
  // of the file and its directory offset points at a central-directory header
  // (so "PK\x05\x06" bytes inside a zip COMMENT can't hide the real directory).
  function findEocd(dv, n) {
    var sawSig = -1, emptyAt = -1;
    for (var i = n - 22; i >= 0 && i >= n - 22 - 65535; i--) {
      if (u32(dv, i) !== 0x06054b50) continue;
      if (sawSig < 0) sawSig = i;
      var commentLen = u16(dv, i + 20);
      if (i + 22 + commentLen !== n) continue;
      var count = u16(dv, i + 10), cdSize = u32(dv, i + 12), cdOffset = u32(dv, i + 16);
      // A valid EMPTY zip: no records, its (empty) directory right before this
      // record. Remembered, but a real directory further back still wins.
      if (count === 0) { if (cdSize === 0 && cdOffset === i && emptyAt < 0) emptyAt = i; continue; }
      if (cdOffset + 46 > i || cdOffset + cdSize > i) continue;
      if (u32(dv, cdOffset) !== 0x02014b50) continue;
      return i;
    }
    if (emptyAt >= 0) return -3;
    // A record that is there but doesn't add up: say "damaged", not "not a zip".
    if (sawSig >= 0) return -2;
    return -1;
  }

  async function parse(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var dv = new DataView(arrayBuffer);
    var n = bytes.length;

    var eocd = n >= 22 ? findEocd(dv, n) : -1;
    if (eocd === -1) throw new Error("Not a valid .zip file (no end-of-central-directory record).");
    if (eocd === -3) throw new Error("This zip is empty — it holds no files. Choose the zip the exporter produced.");
    if (eocd === -2) throw new Error("The zip looks damaged (its file list points outside the file). Re-export or re-zip it and try again.");

    var count = u16(dv, eocd + 10);
    var cdOffset = u32(dv, eocd + 16);

    var out = [], skipped = [], parsed = 0, total = 0, seenLocal = {};
    var p = cdOffset;
    var nameDec = new TextDecoder("utf-8");

    for (var e = 0; e < count; e++) {
      if (p + 46 > eocd || u32(dv, p) !== 0x02014b50) break; // central dir header
      if (++parsed > MAX_ENTRIES) throw new Error("This zip holds too many files (over " + MAX_ENTRIES + ") — it isn't a PromptPort export.");
      var flag = u16(dv, p + 8);
      var method = u16(dv, p + 10);
      var crcWant = u32(dv, p + 16);
      var compSize = u32(dv, p + 20);
      var rawSize = u32(dv, p + 24);
      var nameLen = u16(dv, p + 28);
      var extraLen = u16(dv, p + 30);
      var commentLen = u16(dv, p + 32);
      var localOff = u32(dv, p + 42);
      if (p + 46 + nameLen > n) break;
      // Windows tools (PowerShell Compress-Archive) write "\" as the folder separator.
      var name = nameDec.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, "/");
      p += 46 + nameLen + extraLen + commentLen;

      var base = name.split("/").pop();
      var isDir = /\/$/.test(name);
      var isJunk = /(^|\/)__MACOSX\//.test(name) || /^\./.test(base);
      if (isDir || isJunk) continue;
      if (!TEXT_ENTRY.test(base)) { skipped.push({ name: name, why: "not a prompt file" }); continue; }
      if (seenLocal[localOff]) { skipped.push({ name: name, why: "duplicate entry" }); continue; }
      seenLocal[localOff] = true;
      if (localOff + 30 > n || u32(dv, localOff) !== 0x04034b50) { skipped.push({ name: name, why: "damaged" }); continue; }
      if (flag & 0x0001) { skipped.push({ name: name, why: "encrypted" }); continue; }
      var lNameLen = u16(dv, localOff + 26);
      var lExtraLen = u16(dv, localOff + 28);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;
      if (dataStart + compSize > n) { skipped.push({ name: name, why: "damaged" }); continue; }
      if (rawSize > MAX_ENTRY || compSize > MAX_ENTRY) { skipped.push({ name: name, why: "too large" }); continue; }
      var comp = bytes.subarray(dataStart, dataStart + compSize);
      var raw;
      if (method === 0) raw = comp;
      else if (method === 8) {
        try { raw = await inflateRaw(comp, Math.min(MAX_ENTRY, MAX_TOTAL - total)); }
        catch (err) {
          if (err && err.message && /decompress the zip/.test(err.message)) throw err;
          if (err && err.tooLarge && MAX_TOTAL - total < MAX_ENTRY) throw new Error("This zip is too large to import (over " + (MAX_TOTAL / 1048576) + " MB once unpacked).");
          skipped.push({ name: name, why: err && err.tooLarge ? "too large" : "damaged" }); continue;
        }
      }
      else { skipped.push({ name: name, why: "unsupported compression" }); continue; }
      if (crc32(raw) !== crcWant) { skipped.push({ name: name, why: "damaged" }); continue; }
      total += raw.length;
      if (total > MAX_TOTAL) throw new Error("This zip is too large to import (over " + (MAX_TOTAL / 1048576) + " MB once unpacked).");
      var text = decodeText(raw);
      if (looksBinary(text)) { skipped.push({ name: name, why: "not a text file" }); continue; }
      out.push({ name: name, text: text });
    }
    if (parsed < count && !out.length && !skipped.length) throw new Error("The zip looks damaged (its file list is broken). Re-export or re-zip it and try again.");
    var real = skipped.filter(function (s) { return s.why !== "not a prompt file"; });
    if (!out.length && real.length) {
      var all = function (w) { return real.every(function (s) { return s.why === w; }); };
      throw new Error(all("unsupported compression")
        ? "This zip uses a compression method the plugin can't read. Re-zip it with standard (Deflate) compression."
        : all("encrypted") ? "This zip is password-protected/encrypted — unzip it first, then import the plain files."
        : all("too large") ? "The files in this zip are too large to import (over 20 MB each)."
        : all("not a text file") ? "The files in this zip aren't text files — choose a PromptPort export or a zip of Markdown (.md) files."
        : "The zip looks damaged — its files couldn't be read. Re-export or re-zip it and try again.");
    }
    out.skipped = skipped;
    return out;
  }

  // One parse per ArrayBuffer: the Magic Port check and the prompt import read
  // the same file — share the result instead of inflating it twice.
  var cache = typeof WeakMap === "function" ? new WeakMap() : null;
  function read(arrayBuffer) {
    if (cache && arrayBuffer && typeof arrayBuffer === "object") {
      var hit = cache.get(arrayBuffer);
      if (hit) return hit;
      var pr = parse(arrayBuffer);
      cache.set(arrayBuffer, pr);
      pr.catch(function () {});
      return pr;
    }
    return parse(arrayBuffer);
  }

  window.PPUnzip = { read: read, looksBinary: looksBinary, decodeText: decodeText };
})();
