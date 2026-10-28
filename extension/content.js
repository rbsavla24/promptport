/*
 * content.js  (ISOLATED world) — the orchestrator.
 *
 * - Listens for assistant JSON captured by interceptor.js (MAIN world).
 * - Injects a floating "⬇ Export MD" button + a preview panel.
 * - Builds 5 markdown files, zips them (zip.js), and downloads the ZIP.
 * - Responds to the toolbar popup (chrome.runtime messages).
 */
(function () {
  "use strict";

  var NS = "RINGG_MD_EXPORTER";
  var latestAssistant = null; // { url, data } — used mainly for naming
  var captured = [];          // all captured JSON payloads (data objects)
  var _lastBackup = null;     // { when, sections, matched, importedKeys } — pre-import snapshot for Undo

  var opGen = 0;              // bumped each openPanel/refresh; stale chains bail
  var opLock = Promise.resolve(); // serialize collect/copy ops (no concurrent copy listeners)
  function runExclusive(fn) {
    var p = opLock.then(function () { return fn(); });
    opLock = p.catch(function () {});
    return p;
  }

  var lastUrl = location.href;
  // In the SPA, drop captured payloads when the assistant page changes, so one
  // assistant's data can never leak into another's export.
  function resetIfNavigated() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      captured = [];
      latestAssistant = null;
    }
  }

  function addCapture(data) {
    if (!data || typeof data !== "object") return;
    if (captured.indexOf(data) === -1) captured.push(data);
    if (captured.length > 40) captured.shift();
  }

  // ---- talk to the page-world interceptor ---------------------------------
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var msg = ev.data;
    if (!msg || msg.__ns !== NS) return;
    if (msg.type === "assistant-data") {
      latestAssistant = msg.payload;
      addCapture(msg.payload && msg.payload.data);
    } else if (msg.type === "captures") {
      var list = (msg.payload && msg.payload.list) || [];
      list.forEach(function (c) { addCapture(c && c.data); });
    }
  });

  function askInterceptorForLatest() {
    window.postMessage({ __ns: NS, type: "request-latest" }, "*");
  }

  // ---- helpers ------------------------------------------------------------
  function assistantName() {
    var sources = captured.slice();
    if (latestAssistant && latestAssistant.data) sources.unshift(latestAssistant.data);
    for (var s = 0; s < sources.length; s++) {
      var found = null;
      (function walk(o) {
        if (found || !o || typeof o !== "object") return;
        Object.keys(o).forEach(function (k) {
          if (found) return;
          if (/^(assistant_?name|agent_?name|name|title)$/i.test(k) && typeof o[k] === "string" && o[k].trim()) {
            found = o[k].trim();
          } else { walk(o[k]); }
        });
      })(sources[s]);
      if (found) return found;
    }
    // fall back to id from URL
    var m = location.pathname.match(/assistants\/([0-9a-f-]{8,})/i);
    return m ? ("assistant-" + m[1].slice(0, 8)) : "assistant";
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "assistant";
  }

  // Known top-nav / workspace labels that are NEVER an assistant's name — used to
  // reject breadcrumb/nav fragments (Ringg runs the nav items together, e.g.
  // "AssistantsWorkflows", so old "text after Assistants" heuristics grabbed
  // "Workflows"). Keep this list broad.
  var NAV_WORDS = /^(workflows?|monitor|logs?|campaigns?|analytics|evals?|alerts?|inventory|knowledge base|numbers?|integrations?|labs?|stt|settings|report a bug|search|assistants?)$/i;

  // Read the assistant's display name. Strategy order:
  //  1) the header control block that holds the name + "Edit agent name" /
  //     "Copy agent ID" buttons (most reliable across layout changes),
  //  2) the last real segment of the Breadcrumb nav,
  //  3) a guarded "text after Assistants" heuristic,
  //  4) the page <title>.
  function nameFromUI() {
    function clean(s) {
      return String(s || "").replace(/\s+/g, " ").trim();
    }
    var chosen = "";

    // Rezolv Voicebot Panel: the name is the value of the input under the
    // floating "Agent Name" label.
    if (isGorezolv()) {
      try {
        var lab = [].slice.call(document.querySelectorAll("label")).filter(function (l) {
          return clean(l.textContent) === "Agent Name";
        })[0];
        var q = lab && lab.parentElement, inp = null;
        for (var d = 0; d < 5 && q && !inp; d++) { inp = q.querySelector("input"); q = q.parentElement; }
        if (!inp) inp = document.querySelector('input[type="text"]');
        var v = inp ? clean(inp.value) : "";
        if (v) return v;
      } catch (e) {}
      var gm = location.pathname.match(/voice-agents\/([0-9a-f-]{8,})/i);
      return gm ? ("voice-agent-" + gm[1].slice(0, 8)) : "";
    }

    // 1) Name sits beside the Edit-agent-name / Copy-agent-id icon buttons.
    try {
      var editBtn = document.querySelector(
        '[aria-label="Edit agent name"],[aria-label="Edit assistant name"],' +
        '[aria-label^="Edit agent name"],[aria-label^="Edit assistant name"]');
      var host = editBtn && editBtn.parentElement;
      if (host) {
        // First child that is not an icon button / svg and carries text = the name.
        // This anchor is authoritative, so we DON'T apply the nav-word filter here:
        // a bot may legitimately be named "Numbers", "Analytics", etc.
        var kids = Array.prototype.slice.call(host.childNodes);
        for (var i = 0; i < kids.length && !chosen; i++) {
          var n = kids[i];
          if (n.nodeType === 1 && n.tagName !== "BUTTON" && n.tagName !== "SVG" && n.tagName !== "svg") {
            var t = clean(n.textContent);
            if (t) chosen = t;
          } else if (n.nodeType === 3) {
            var tt = clean(n.nodeValue);
            if (tt) chosen = tt;
          }
        }
        // Icon buttons have no text, so the host's own text is usually just the name.
        if (!chosen) {
          var ht = clean(host.textContent);
          if (ht && !/assistants/i.test(ht)) chosen = ht;
        }
      }
    } catch (e) {}

    // 2) Breadcrumb: last meaningful segment (not workspace / nav / "Assistants").
    if (!chosen) {
      try {
        var bc = document.querySelector('nav[aria-label="Breadcrumb"],[aria-label="Breadcrumb"]');
        if (bc) {
          var leaves = Array.prototype.slice.call(bc.querySelectorAll("a,span,div,li,p"))
            .map(function (el) { return clean(el.textContent); })
            .filter(function (s) {
              return s && s.length >= 2 && s.length < 160 &&
                !/assistants/i.test(s) && !/workspace$/i.test(s) && !NAV_WORDS.test(s);
            });
          if (leaves.length) chosen = leaves[leaves.length - 1]; // deepest = the name
        }
      } catch (e) {}
    }

    // 3) Guarded legacy heuristic: smallest element text containing "Assistants",
    //    take what follows — but reject nav words and concatenated fragments.
    if (!chosen) {
      var all = document.querySelectorAll("header, nav, section, ol, ul, li, div, span, p, a, h1, h2");
      var cands = [];
      for (var j = 0; j < all.length; j++) {
        // The sidebar ("Assistants Workflows Settings…") is not a breadcrumb.
        if (all[j].closest && all[j].closest("aside, [role='navigation'], nav:not([aria-label*='readcrumb']), [class*='sidebar' i], [class*='side-nav' i]")) continue;
        var ct = clean(all[j].textContent);
        if (ct.length < 12 || ct.length > 220) continue;
        if (!/assistants/i.test(ct)) continue;
        cands.push(ct);
      }
      cands.sort(function (a, b) { return a.length - b.length; });
      for (var c = 0; c < cands.length; c++) {
        var s = cands[c];
        var idx = s.toLowerCase().indexOf("assistants");
        var rest = s.slice(idx + 10)
          .replace(/^[\s>\/|:·.\-‐-―•‹›→❯]+/, "")
          .replace(/\s*(test agent|test assistant|edit|duplicate|copy|rename)\s*$/i, "")
          .trim();
        if (rest && rest.length > 3 && rest.length < 160 &&
            !/^assistants/i.test(rest) && !/assistants/i.test(rest) && !NAV_WORDS.test(rest)) {
          chosen = rest; break;
        }
      }
    }

    // 4) Page <title>.
    if (!chosen) {
      var dt = (document.title || "").replace(/\s*[|·–—-]\s*ringg.*$/i, "").trim();
      if (dt && dt.length > 3 && !/^ringg/i.test(dt) && !/voice assistants for business/i.test(dt)) chosen = dt;
    }

    try { console.log("[Ringg MD] chosen name:", chosen); } catch (e) {}
    return chosen;
  }

  // Keep the name human-readable; only strip characters filesystems disallow.
  function fileBase(name) {
    return String(name || "")
      .replace(/[\/\\:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "assistant";
  }

  function zipFilename() {
    var name = nameFromUI() || assistantName();
    try { console.log("%c[Ringg MD] zip filename:", "color:#4f46e5", fileBase(name) + ".zip"); } catch (e) {}
    return fileBase(name) + ".zip";
  }

  function buildSections() {
    resetIfNavigated();
    // Prefer the full set of captured API payloads (raw stored values contain
    // the {{tokens}}); DOM is used only as a fallback inside combine().
    var input = captured.length ? captured
              : (latestAssistant && latestAssistant.data ? [latestAssistant.data] : []);
    return window.RinggExtract.combine(input);
  }

  // ---- copy-from-UI (the accurate path for {{tokens}}) --------------------
  function selectContents(el) {
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Do what a user does by hand: select all of a field and copy it. Ringg's
  // editor serializes mention chips to their {{token}} on copy (the rendered
  // DOM only shows the label), so this recovers @{{callee_name}} etc.
  function copyEditor(el) {
    return new Promise(function (resolve) {
      var result = { html: "", text: "" };
      var done = false;

      function onCopy(e) {
        // Read exactly what the editor serialized into the copy event — this is
        // where mention chips become @{{callee_name}}. No clipboard permission
        // needed. We do NOT preventDefault, so behavior matches a real Cmd+C.
        try {
          var h = e.clipboardData.getData("text/html");
          var t = e.clipboardData.getData("text/plain");
          if (h || t) result = { html: h, text: t };
        } catch (err) {}
      }

      function finish() {
        if (done) return;
        done = true;
        try { document.removeEventListener("copy", onCopy, false); } catch (e) {}
        // Leave the editor unselected AND unfocused: select-all was only for the
        // copy; a focused, fully-selected editor would be wiped by the next key.
        try { window.getSelection().removeAllRanges(); } catch (e) {}
        try { if (el.blur) el.blur(); } catch (e) {}
        resolve(result);
      }

      // 1) Preferred: ask the editor to serialize itself into a PRIVATE
      //    DataTransfer via a synthetic copy event. ProseMirror's copy handler
      //    writes its own HTML (mention chips as data-id="{{token}}") into the
      //    event's clipboardData. No OS clipboard, no permission, no user
      //    gesture needed — this is what makes variables survive even when
      //    Ringg renders chips with only a friendly label ("Callee Name").
      var isRich = !(el.tagName === "TEXTAREA" || el.tagName === "INPUT");
      if (isRich) {
        try {
          if (el.focus) el.focus();
          ["Meta", "Control"].forEach(function (mod) {
            try {
              el.dispatchEvent(new KeyboardEvent("keydown", {
                key: "a", code: "KeyA", keyCode: 65, which: 65, bubbles: true, cancelable: true,
                metaKey: mod === "Meta", ctrlKey: mod === "Control"
              }));
            } catch (e) {}
          });
          var dt = new DataTransfer();
          var ev = new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true });
          try { Object.defineProperty(ev, "clipboardData", { value: dt }); } catch (e) {}
          el.dispatchEvent(ev);
          var h0 = dt.getData("text/html"), t0 = dt.getData("text/plain");
          if (h0 || t0) { result = { html: h0, text: t0 }; finish(); return; }
        } catch (e) {}
      }

      // 2) Fallback: a real select-all + copy, read in the copy event.
      try {
        document.addEventListener("copy", onCopy, false); // bubble → runs after the editor's own handler
        el.scrollIntoView({ block: "center" });
        if (el.focus) el.focus();
        selectContents(el);
        document.execCommand("copy");
      } catch (e) {}

      // If the copy event yielded nothing, fall back to reading THIS element's
      // own content directly — never the shared OS clipboard, which could still
      // hold a previous bucket's copied text (that would cross-contaminate).
      setTimeout(function () {
        if (result.html || result.text) { finish(); return; }
        try {
          if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
            result.text = el.value || "";
          } else {
            var inner = el.querySelector &&
              el.querySelector(".ProseMirror, .ql-editor, [contenteditable='true'], .tiptap");
            result.html = ((inner || el).innerHTML) || "";
          }
        } catch (e) {}
        finish();
      }, 50);
    });
  }

  // Build all 5 sections, preferring the copy-from-UI value, falling back to
  // captured API/embedded data, then to plain DOM text.
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function collectSections() {
    // Rezolv Voicebot Panel has just two fields — read them directly. Never run
    // Ringg's expand-collapsed logic here (it clicks toggles near headings).
    if (isGorezolv()) return collectGorezolv();
    // Open any collapsed buckets first, then wait for their editors to render.
    try {
      var opened = window.RinggExtract.expandCollapsed();
      if (opened) {
        await sleep(700);
        window.RinggExtract.expandCollapsed(); // second pass for nested/late toggles
        await sleep(300);
      }
    } catch (e) {}

    var baseline = buildSections();            // API / DOM fallback
    var map;
    try { map = window.RinggExtract.sectionEditors(); } catch (e) { map = []; }

    var prevText = "";
    try { prevText = await navigator.clipboard.readText(); } catch (e) {}

    var results = [];
    for (var i = 0; i < map.length; i++) {
      var m = map[i];
      var base = baseline[i] || { text: "", source: "none" };
      var md = "", source = base.source;
      var el = m.el;
      if (el) {
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
          md = window.RinggExtract.toMarkdown(el.value || "");
          if (md) source = "ui";
        } else {
          var cap = await copyEditor(el);
          try {
            console.log("%c[Ringg MD] " + m.title, "color:#4f46e5;font-weight:bold");
            console.log("  html:", (cap.html || "(none)").slice(0, 400));
            console.log("  text:", (cap.text || "(none)").slice(0, 400));
          } catch (e) {}
          if (cap.html) { md = window.RinggExtract.toMarkdown(cap.html); source = "ui"; }
          else if (cap.text) { md = window.RinggExtract.toMarkdown(cap.text); source = "ui"; }
        }
      }
      if (!md) { md = (base.text || "").trim(); source = md ? base.source : "none"; }
      results.push({ key: m.key, title: m.title, filename: m.filename, text: md, source: source });
    }

    try { if (prevText) await navigator.clipboard.writeText(prevText); } catch (e) {}
    return results.length ? results : baseline;
  }

  function sectionsToFiles(sections) {
    // Name each file "N_Export_Name.md" (e.g. "1_First_Message.md") so the ZIP
    // lists the buckets in prompt order in every file explorer (which sort
    // alphabetically). The importer strips the numeric prefix, so round-trip
    // matching is unaffected.
    var SECS = window.RinggExtract.SECTIONS;
    var order = SECS.map(function (s) { return s.key; });
    return sections.map(function (s, i) {
      var body = s.text && s.text.trim()
        ? s.text.trim()
        : "<!-- No content found for \"" + s.title + "\". Open this section on the page, reload, then export again. -->";
      var known = !!(s.key && order.indexOf(s.key) !== -1);
      var idx = known ? order.indexOf(s.key) : i;
      // Prefer the canonical export name (e.g. "First_Message") — but ONLY for a
      // real bucket key; an unknown key (e.g. Rezolv "main-prompt") must not borrow
      // the name of whichever bucket happens to sit at the same position.
      var def = known ? SECS[idx] : null;
      var base = (def && def.exportName)
        ? def.exportName
        : String(s.filename || s.title || ("section-" + (idx + 1)))
            .replace(/\.md$/i, "").trim().replace(/\s+/g, "_");
      return { name: (idx + 1) + "_" + base + ".md", content: body + "\n" };
    });
  }

  // "2-bucket" export: First Message stays its own file, and the other four
  // buckets are collated — each under a top-level "# Heading" — into a single
  // Main Prompt. This matches the gorezolv panel's shape (First Message + Main
  // Prompt) and reads as a clean system prompt for an LLM: H1 section names sit
  // above each bucket's own ### structure, empty sections are skipped (no dangling
  // heading), and no "---" dividers (which can turn the line above into a heading).
  // Text that actually says something (our exporter writes "<!-- No content… -->"
  // placeholders for empty buckets — those count as empty).
  function meaningful(t) {
    return String(t || "").replace(/<!--[\s\S]*?-->/g, "").trim() !== "";
  }

  function bucketHeading(key) {
    var SECS = window.RinggExtract.SECTIONS;
    for (var i = 0; i < SECS.length; i++) {
      if (SECS[i].key === key) return String(SECS[i].exportName || SECS[i].title || key).replace(/_/g, " ");
    }
    return key;
  }

  // The ONE way a Main Prompt is built from the 4 buckets — used by both the
  // 2-bucket export and the Rezolv import, so they always agree (and so it always
  // splits back cleanly with splitMainPrompt).
  function collateMain(partsByKey) {
    var out = [];
    MAIN_SPLIT_KEYS.forEach(function (key) {
      var t = partsByKey && partsByKey[key];
      if (!meaningful(t)) return;                                  // skip empty → no dangling heading
      out.push("# " + bucketHeading(key) + "\n\n" + String(t).trim()); // H1 above each bucket
    });
    return out.join("\n\n");
  }

  function sectionsToTwoFiles(sections) {
    var byKey = {};
    sections.forEach(function (s) { if (s && s.key) byKey[s.key] = s; });
    function textOf(key) {
      var s = byKey[key];
      return (s && s.text && s.text.trim()) ? s.text.trim() : "";
    }
    var fm = textOf("first-message");
    var fmBody = fm || "<!-- No First Message found. Open the assistant, reload, then export again. -->";
    var mainBody;
    if (byKey["main-prompt"]) {
      // Rezolv panel: the Main Prompt field is exported exactly as it is.
      mainBody = textOf("main-prompt");
    } else {
      // Ringg: collate the four buckets under # headings.
      var parts = {};
      MAIN_SPLIT_KEYS.forEach(function (k) { parts[k] = textOf(k); });
      mainBody = collateMain(parts);
    }
    mainBody = mainBody ||
      "<!-- No Main Prompt content found. Open the assistant, reload, then export again. -->";
    return [
      { name: "1_First_Message.md", content: fmBody + "\n" },
      { name: "2_Main_Prompt.md", content: mainBody + "\n" }
    ];
  }

  // Save a ZIP of {name, content} files under `filename`.
  function saveZip(files, filename) {
    var href;
    try { href = window.RinggZip.toDataUrl(files); }
    catch (e) { href = URL.createObjectURL(window.RinggZip.make(files)); }
    var a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { document.body.removeChild(a); } catch (e) {}
      if (/^blob:/.test(href)) { try { URL.revokeObjectURL(href); } catch (e) {} }
    }, 1500);
  }

  function downloadFiles(files, filename) { saveZip(files, filename); }

  function downloadZip(sections) {
    downloadFiles(sectionsToFiles(sections), zipFilename());
  }

  function downloadZipTwo(sections) {
    downloadFiles(sectionsToTwoFiles(sections),
      fileBase(nameFromUI() || assistantName()) + " (2-bucket).zip");
  }

  // ========================================================================
  //  Rezolv Voicebot Panel (panels.gorezolv.com/voicebot) — export support
  // ========================================================================
  function isGorezolv() {
    return /(^|\.)panels\.gorezolv\.com$/i.test(location.hostname || "");
  }

  // The panel's Prompt tab has two TipTap editors, each right after an <h3>
  // label: "First Message" and "Main Prompt". Fall back to document order.
  function gorezolvEditors() {
    function own(e) {
      var t = "";
      for (var i = 0; i < e.childNodes.length; i++) {
        if (e.childNodes[i].nodeType === 3) t += e.childNodes[i].textContent;
      }
      return t.replace(/\s+/g, " ").trim();
    }
    var eds = [].slice.call(document.querySelectorAll(".ProseMirror"));
    var labels = [].slice.call(document.querySelectorAll("h1,h2,h3,h4,h5,label,span,div,p"));
    function editorAfter(text) {
      var h = labels.filter(function (e) { return own(e) === text; })[0];
      if (!h) return null;
      for (var i = 0; i < eds.length; i++) {
        if (h.compareDocumentPosition(eds[i]) & 4) return eds[i];
      }
      return null;
    }
    var fm = editorAfter("First Message");
    var mp = editorAfter("Main Prompt");
    if (fm && mp && fm === mp) mp = null;
    if (!fm && eds[0] && eds[0] !== mp) fm = eds[0];
    if (!mp && eds[1] && eds[1] !== fm) mp = eds[1];
    return { fm: fm, mp: mp };
  }

  async function collectGorezolv() {
    var m = gorezolvEditors();
    var prevText = "";
    try { prevText = await navigator.clipboard.readText(); } catch (e) {}
    async function read(el) {
      if (!el) return "";
      var cap = await copyEditor(el);
      if (cap.html) return window.RinggExtract.toMarkdown(cap.html);
      if (cap.text) return window.RinggExtract.toMarkdown(cap.text);
      return "";
    }
    var fm = await read(m.fm);
    var mp = await read(m.mp);
    try { if (prevText) await navigator.clipboard.writeText(prevText); } catch (e) {}
    return [
      { key: "first-message", title: "First Message", filename: "First message.md", text: fm, source: fm ? "ui" : "none" },
      { key: "main-prompt", title: "Main Prompt", filename: "Main Prompt.md", text: mp, source: mp ? "ui" : "none" }
    ];
  }

  // Split a Main Prompt organised under level-1 "# Section" headings back into
  // the 4 Ringg buckets. Succeeds ONLY when every # heading names a bucket
  // (Objective, Response Guidelines, Conversation Flow/Script, FAQs), they appear
  // in that order with no repeats, and there's no stray text above the first one.
  // ##/### sub-headings are content; lines inside ``` fences are never headings.
  // A bucket that is simply absent is allowed (our own 2-bucket export skips
  // empty buckets) — it becomes an empty file.
  var MAIN_SPLIT_KEYS = ["objective", "response-guideline", "conversation-script", "faqs"];
  // Names that DELIMIT sections inside a markdown file. Deliberately narrower
  // than the page-detection labels: everyday words ("Goal", "Greeting",
  // "Purpose", "Script", "Guidelines") are common sub-headings inside a bucket
  // and must never split it.
  var CANON_NAMES = {
    "first-message": ["first message", "welcome message", "opening message", "initial message", "first_message"],
    "objective": ["objective", "objectives"],
    "response-guideline": ["response guidelines", "response guideline"],
    "conversation-script": ["conversation script", "conversation flow", "call script"],
    "faqs": ["faqs", "faq", "frequently asked questions"]
  };
  var MAIN_NAMES = ["main prompt", "system prompt"];
  function canonicalSection(str) {
    var n = normName(String(str || "").replace(/^\s*\d+\s*[-_.)\]]*\s*/, ""));
    if (!n) return null;
    var secs = window.RinggExtract.SECTIONS;
    for (var i = 0; i < secs.length; i++) {
      var names = CANON_NAMES[secs[i].key] || [];
      for (var j = 0; j < names.length; j++) if (normName(names[j]) === n) return secs[i];
    }
    return null;
  }
  function isMainHeading(str) {
    var n = normName(str);
    return MAIN_NAMES.some(function (x) { return normName(x) === n; });
  }
  function splitMainPrompt(md) {
    var lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    var heads = [], inFence = false;
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (/^\s{0,3}(```|~~~)/.test(L)) { inFence = !inFence; continue; }
      if (inFence) continue;
      // "# Title" (from an <h1>) or "\# Title" (a literal "#" Turndown escaped)
      var m = L.match(/^\s{0,3}\\?#(?!#)[ \t]+(.+?)[ \t]*#*[ \t]*$/);
      if (!m) continue;
      var title = m[1].replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1").replace(/[*_`]+/g, "").trim();
      var sec = canonicalSection(title);
      // An H1 that isn't a section name (e.g. "# Intro" inside Objective) is
      // ordinary content of the section it sits in — never a split point.
      if (!sec) continue;
      heads.push({ line: i, title: title, key: sec.key });
    }
    if (!heads.length) {
      return { ok: false, reason: "No # headings found in Main Prompt." };
    }
    for (var h = 0; h < heads.length; h++) {
      var k = heads[h].key;
      if (MAIN_SPLIT_KEYS.indexOf(k) === -1) {
        return { ok: false, reason: "\"# " + heads[h].title + "\" isn't one of: Objective, Response Guidelines, Conversation Flow, FAQs." };
      }
      if (h > 0 && MAIN_SPLIT_KEYS.indexOf(k) <= MAIN_SPLIT_KEYS.indexOf(heads[h - 1].key)) {
        return { ok: false, reason: "# headings are out of order or repeated (expected Objective → Response Guidelines → Conversation Flow → FAQs)." };
      }
    }
    var parts = {};
    heads.forEach(function (hd, idx) {
      var end = idx + 1 < heads.length ? heads[idx + 1].line : lines.length;
      parts[hd.key] = lines.slice(hd.line + 1, end).join("\n").trim();
    });
    var pre = lines.slice(0, heads[0].line).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
    if (pre) {
      // Export can't place this text, so 5 Buckets stays off; import keeps it
      // by adding it to the first section (see resolveImportPlan).
      return { ok: false, reason: "There's text above the first # heading in Main Prompt.", pre: pre, parts: parts, firstKey: heads[0].key };
    }
    return { ok: true, parts: parts, found: heads.map(function (x) { return x.key; }) };
  }

  // Turn the two Rezolv fields into the 5 Ringg buckets — or null if Main Prompt
  // isn't organised under the # headings.
  function gorezolvFiveSections(sections) {
    var byKey = {};
    (sections || []).forEach(function (s) { if (s && s.key) byKey[s.key] = s; });
    var sp = splitMainPrompt(byKey["main-prompt"] ? byKey["main-prompt"].text : "");
    if (!sp.ok) return null;
    return window.RinggExtract.SECTIONS.map(function (sec) {
      var text = sec.key === "first-message"
        ? ((byKey["first-message"] || {}).text || "")
        : (sp.parts[sec.key] || "");
      return { key: sec.key, title: sec.title, filename: sec.filename, text: text, source: "ui" };
    });
  }

  // Cheap, side-effect-free check of the LIVE Main Prompt editor (no copying,
  // no clipboard) — used to enable/disable "Download 5 Buckets" before the user
  // clicks. The authoritative check runs again on the collected text at download.
  function liveMainSplit() {
    try {
      var mp = gorezolvEditors().mp;
      if (!mp) return { ok: false, reason: "Main Prompt editor not found on this page.", present: [] };
      var md = window.RinggExtract.toMarkdown(mp.innerHTML || "");
      var r = splitMainPrompt(md);
      r.present = mainHeadingKeys(md);
      return r;
    } catch (e) { return { ok: false, reason: "Couldn't read Main Prompt.", present: [] }; }
  }
  // Which of the 4 standard # headings appear in a Main Prompt (any order).
  function mainHeadingKeys(md) {
    var lines = String(md || "").replace(/\r\n?/g, "\n").split("\n"), out = [], inFence = false;
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (/^\s{0,3}(```|~~~)/.test(L)) { inFence = !inFence; continue; }
      if (inFence) continue;
      var m = L.match(/^\s{0,3}\\?#(?!#)[ \t]+(.+?)[ \t]*#*[ \t]*$/);
      if (!m) continue;
      var sec = canonicalSection(m[1].replace(/[*_`\\]+/g, "").trim());
      if (sec && MAIN_SPLIT_KEYS.indexOf(sec.key) !== -1 && out.indexOf(sec.key) === -1) out.push(sec.key);
    }
    return out;
  }

  function fallbackSections() { return isGorezolv() ? [] : buildSections(); }

  // One place that performs a download in either format, on either site.
  function doDownload(format, sections) {
    var secs = (sections && sections.length) ? sections : fallbackSections();
    if (format === "two") {
      downloadZipTwo(secs);
      toast("2-bucket ZIP downloaded — First Message + Main Prompt");
      _lastDl = "2-bucket ZIP downloaded."; setLinks(true);
      return true;
    }
    if (isGorezolv()) {
      var five = gorezolvFiveSections(secs);
      if (!five) {
        var why = splitMainPrompt(((secs.filter(function (s) { return s.key === "main-prompt"; })[0]) || {}).text || "").reason;
        toast("Can't split into 5 buckets — " + why + " Use Download 2 Buckets.");
        return false;
      }
      secs = five;
    }
    var ready = secs.filter(function (s) { return s.text && s.text.trim(); }).length;
    downloadZip(secs);
    toast("5-bucket ZIP downloaded — " + ready + " of 5 sections had content");
    _lastDl = "5-bucket ZIP downloaded."; setLinks(true);
    return true;
  }

  // ========================================================================
  //  IMPORT: write a zip of 5 .md files back into the buckets
  // ========================================================================
  function normName(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // Match an uploaded file name to one of the 5 sections. Handles a leading
  // order prefix ("1_First_Message", "02-objective", "4_Conversation_Flow"),
  // any folder path, and name variants (Conversation Flow ↔ Conversation Script).
  function fileStem(fileName) {
    return String(fileName || "").split("/").pop()
      .replace(/\.(md|markdown|txt)$/i, "")
      .replace(/\s*(\(\d+\)|[-_ ]copy(\s*\(?\d+\)?)?)\s*$/i, "")
      .trim();
  }
  function matchSection(fileName) {
    var base = fileStem(fileName);
    var stripped = base.replace(/^\s*\d+\s*[-_.)\]]*\s*/, ""); // drop "1_", "02-", "7 ", "3."
    var cands = [normName(base)];
    var ns = normName(stripped);
    if (ns && cands.indexOf(ns) === -1) cands.push(ns);
    var secs = window.RinggExtract.SECTIONS;
    for (var i = 0; i < secs.length; i++) {
      var sec = secs[i];
      var keys = [normName(sec.filename.replace(/\.md$/i, "")), normName(sec.title)];
      for (var j = 0; j < sec.labels.length; j++) keys.push(normName(sec.labels[j]));
      for (var c = 0; c < cands.length; c++) {
        if (cands[c] && keys.indexOf(cands[c]) !== -1) return sec;
      }
    }
    return null;
  }

  // Whitelist sanitizer — strips scripts, event handlers, and dangerous tags so
  // an imported/edited zip can't run JS when its HTML is pasted into the page.
  var SANI_ALLOWED = { P:1,BR:1,STRONG:1,B:1,EM:1,I:1,U:1,S:1,CODE:1,PRE:1,BLOCKQUOTE:1,
    H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,UL:1,OL:1,LI:1,TABLE:1,THEAD:1,TBODY:1,TR:1,TH:1,TD:1,
    SPAN:1,A:1,HR:1,DIV:1,DEL:1,STRIKE:1 };
  var SANI_DANGER = { SCRIPT:1,STYLE:1,IFRAME:1,OBJECT:1,EMBED:1,LINK:1,META:1,BASE:1,
    IMG:1,SVG:1,MATH:1,VIDEO:1,AUDIO:1,SOURCE:1,CANVAS:1,FORM:1,INPUT:1,BUTTON:1,TEXTAREA:1,SELECT:1 };
  var SANI_ATTRS = {
    SPAN: ["data-type","data-id","data-label","data-display-label","data-mention-suggestion-char","class"],
    A: ["href"], TH: ["colspan","rowspan"], TD: ["colspan","rowspan"], CODE: ["class"], PRE: ["class"]
  };
  function sanitizeHtml(html) {
    var doc;
    try { doc = new DOMParser().parseFromString("<div id='__r'>" + String(html || "") + "</div>", "text/html"); }
    catch (e) { return htmlToText(html); }
    var root = doc.getElementById("__r");
    if (!root) return htmlToText(html);
    (function clean(node) {
      var kids = Array.prototype.slice.call(node.childNodes);
      kids.forEach(function (ch) {
        if (ch.nodeType === 8) { ch.parentNode.removeChild(ch); return; }   // comment
        if (ch.nodeType !== 1) return;                                       // text ok
        var tag = ch.tagName;
        if (SANI_DANGER[tag]) { ch.parentNode.removeChild(ch); return; }
        clean(ch); // clean subtree first
        if (!SANI_ALLOWED[tag]) { // unwrap unknown tag, keep its (cleaned) children
          while (ch.firstChild) ch.parentNode.insertBefore(ch.firstChild, ch);
          ch.parentNode.removeChild(ch);
          return;
        }
        var allow = SANI_ATTRS[tag] || [];
        Array.prototype.slice.call(ch.attributes).forEach(function (a) {
          var nm = a.name.toLowerCase();
          if (nm.indexOf("on") === 0 || allow.indexOf(nm) === -1) { ch.removeAttribute(a.name); return; }
          if (nm === "class" && (tag === "CODE" || tag === "PRE") && !/^language-[\w+#.-]+$/.test(a.value || "")) { ch.removeAttribute(a.name); return; }
          if (nm === "href") {
            var v = (a.value || "").trim().toLowerCase().replace(/\s/g, "");
            if (v.indexOf("javascript:") === 0 || v.indexOf("data:") === 0 || v.indexOf("vbscript:") === 0) ch.removeAttribute(a.name);
          }
        });
      });
    })(root);
    return root.innerHTML;
  }

  function mdToHtml(md) {
    var html;
    try {
      if (window.marked && window.marked.parse) {
        html = window.marked.parse(String(md || ""), { gfm: true, breaks: true, renderer: htmlSafeRenderer() }); // breaks:true — a line break typed in a .md file stays a line break (prompt authors expect that; strict markdown would join the lines)
      }
    } catch (e) {}
    if (html == null) {
      html = "<p>" + String(md || "").replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
    }
    return sanitizeHtml(html); // never paste unsanitized HTML into the page
  }

  // A bare variable token in the exported markdown, in any of the 3 Ringg forms:
  //   @{{customer_name}}   custom variable
  //   @((greetings.date))  platform variable
  //   @||send_payment_link|| tool action
  // Ringg's editor turns a pasted <span data-type="mention" data-id="TOKEN"> back
  // into a real variable CHIP (verified live) — but only for text/HTML pastes, and
  // only for variables the assistant actually defines. Bare tokens pasted as plain
  // text stay as literal "@{{…}}" characters, which is the "plain paste" bug.
  var MENTION_TOKEN_RE = /@(?:\{\{[^{}]+\}\}|\(\([^()]+\)\)|\|\|[^|]+\|\|)/g;

  // Walk the text nodes of an HTML string and wrap every bare mention token in a
  // <span data-type="mention" data-id="…"> so the editor re-hydrates the chip.
  // Tokens already inside a mention span are left alone.
  function hydrateMentions(html) {
    var doc;
    try { doc = new DOMParser().parseFromString("<div id='__h'>" + String(html || "") + "</div>", "text/html"); }
    catch (e) { return String(html || ""); }
    var root = doc.getElementById("__h");
    if (!root) return String(html || "");
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(function (tn) {
      var text = tn.nodeValue;
      if (!text || text.indexOf("@") === -1) return;
      MENTION_TOKEN_RE.lastIndex = 0;
      if (!MENTION_TOKEN_RE.test(text)) return;
      // Don't double-wrap tokens already inside a mention chip.
      var p = tn.parentNode;
      if (p && p.closest && p.closest('[data-type="mention"], .mention, .node-mention')) return;
      MENTION_TOKEN_RE.lastIndex = 0;
      var frag = doc.createDocumentFragment(), last = 0, m;
      while ((m = MENTION_TOKEN_RE.exec(text))) {
        if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
        var tok = m[0];                       // "@{{callee_name}}"
        var id = tok.replace(/^@+/, "");      // "{{callee_name}}"
        var span = doc.createElement("span");
        span.setAttribute("data-type", "mention");
        span.setAttribute("data-id", id);
        span.textContent = tok;
        frag.appendChild(span);
        last = m.index + tok.length;
      }
      if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
      tn.parentNode.replaceChild(frag, tn);
    });
    return root.innerHTML;
  }

  // Import target HTML: markdown -> HTML (tables/headings/lists/bold) with bare
  // variable tokens re-wrapped as mention spans, then sanitized. Pasting THIS as
  // text/html makes Ringg render the formatting AND rebuild the variable chips —
  // matching the source, instead of plain-pasting literal markdown.
  // Raw HTML inside the markdown: real tags (formatting, tables we exported as
  // HTML, comments) pass through to the sanitizer; anything else that merely
  // LOOKS like a tag — "<angle>", "<customer name>", "a < b" — is prompt text
  // and must survive as text instead of being swallowed as an unknown element.
  var KNOWN_TAG = /^<\/?(p|br|hr|strong|b|em|i|u|s|del|strike|code|pre|blockquote|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|th|td|colgroup|col|span|a|div|sub|sup|img|script|style|iframe|object|embed|link|meta|base|svg|math|video|audio|source|canvas|form|input|button|textarea|select|option|label|section|article|header|footer|nav|main|figure|figcaption|details|summary|mark|small|big|font|center)\b[^>]*>|^<!--[\s\S]*?-->/i;
  var _safeRenderer = null;
  function htmlSafeRenderer() {
    if (_safeRenderer || !window.marked || !window.marked.Renderer) return _safeRenderer;
    var r = new window.marked.Renderer();
    r.html = function (html) {
      var src = typeof html === "object" && html ? (html.text || html.raw || "") : String(html || "");
      // Keep known tags; escape everything else as literal text.
      var out = "", rest = src;
      while (rest.length) {
        var lt = rest.indexOf("<");
        if (lt === -1) { out += esc(rest); break; }
        out += esc(rest.slice(0, lt));
        rest = rest.slice(lt);
        var m = rest.match(KNOWN_TAG);
        if (m) { out += m[0]; rest = rest.slice(m[0].length); }
        else { out += "&lt;"; rest = rest.slice(1); }
      }
      return out;
    };
    _safeRenderer = r;
    return r;
  }

  // In a markdown TABLE row, the @||tool|| variable's pipes would be read as
  // cell borders. Escape them (\|) on table-looking lines before parsing.
  function protectPipeTokens(md) {
    var inFence = false;
    return String(md || "").split("\n").map(function (line) {
      if (/^\s{0,3}(```|~~~)/.test(line)) { inFence = !inFence; return line; }
      if (inFence || !/^\s*\|/.test(line)) return line;
      return line.replace(/@\|\|([^|\n]+?)\|\|/g, "@\\|\\|$1\\|\\|");
    }).join("\n");
  }

  function mdToHydratedHtml(md) {
    md = protectPipeTokens(md);
    var html;
    try {
      if (window.marked && window.marked.parse) {
        html = window.marked.parse(String(md || ""), { gfm: true, breaks: true, renderer: htmlSafeRenderer() }); // breaks:true — a line break typed in a .md file stays a line break (prompt authors expect that; strict markdown would join the lines)
      }
    } catch (e) {}
    if (html == null) {
      html = "<p>" + String(md || "").replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
    }
    // marked ends every code block with a newline the editor would keep as a
    // real blank line at the bottom of the block — drop it.
    html = String(html).replace(/\n<\/code><\/pre>/g, "</code></pre>");
    html = hydrateMentions(html);
    html = sanitizeHtml(html); // keeps mention spans + formatting, strips anything unsafe
    html = collapseStructuralWhitespace(html);
    if (isGorezolv()) html = breaksToParagraphs(html);
    return html;
  }

  // The Rezolv editor has no hard line break: a pasted <br> collapses into a
  // space and "line one<br>line two" runs together. Split at each <br> into
  // separate paragraphs instead, so every line stays on its own line.
  var BR_BLOCKS = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote";
  function breaksToParagraphs(html) {
    if (!/<br\b/i.test(String(html || ""))) return String(html || "");
    var doc;
    try { doc = new DOMParser().parseFromString("<div id='__b'>" + String(html || "") + "</div>", "text/html"); }
    catch (e) { return String(html || ""); }
    var root = doc.getElementById("__b");
    if (!root) return String(html || "");
    var guard = 0, br;
    while ((br = root.querySelector("br")) && guard++ < 5000) {
      var blk = br.parentNode && br.parentNode.closest ? br.parentNode.closest(BR_BLOCKS) : null;
      if (!blk || !root.contains(blk) || /^H[1-6]$/.test(blk.tagName)) { br.replaceWith(doc.createTextNode(" ")); continue; }
      if (blk.tagName !== "P") {
        // List item / cell / quote holding inline content directly: wrap the
        // inline run around the <br> in a <p> first, then split that.
        var start = br, end = br;
        while (start.previousSibling && !isBlockNode(start.previousSibling)) start = start.previousSibling;
        while (end.nextSibling && !isBlockNode(end.nextSibling)) end = end.nextSibling;
        if (br.parentNode !== blk) { br.replaceWith(doc.createTextNode(" ")); continue; }
        var wrap = doc.createElement("p");
        blk.insertBefore(wrap, start);
        var n = start;
        while (n) { var nx = n === end ? null : n.nextSibling; wrap.appendChild(n); n = nx; }
        blk = wrap;
      }
      var range = doc.createRange();
      range.setStartAfter(br);
      range.setEndAfter(blk.lastChild);
      var rest = range.extractContents();
      br.remove();
      var p2 = doc.createElement("p");
      p2.appendChild(rest);
      blk.parentNode.insertBefore(p2, blk.nextSibling);
      [blk, p2].forEach(function (pp) {
        // trim edge whitespace left by "  \n" indentation; drop a paragraph left empty
        if (pp.firstChild && pp.firstChild.nodeType === 3) pp.firstChild.nodeValue = pp.firstChild.nodeValue.replace(/^\s+/, "");
        if (pp.lastChild && pp.lastChild.nodeType === 3) pp.lastChild.nodeValue = pp.lastChild.nodeValue.replace(/\s+$/, "");
        if (!(pp.textContent || "").trim() && !pp.querySelector("[data-type='mention'],.mention,img")) pp.remove();
      });
    }
    return root.innerHTML;
  }

  // marked pretty-prints with newlines between block tags ("</p>\n<p>",
  // "<ol>\n<li>"). When ProseMirror ingests that HTML, each of those inter-block
  // whitespace text nodes becomes an empty spacer paragraph — blank lines between
  // every block. Strip whitespace-only text nodes that sit *between* block
  // elements, while leaving meaningful spaces inside paragraphs/headings/cells
  // (e.g. the space in "</strong> <span>chip</span>") untouched.
  var WS_BLOCK_PARENTS = { DIV:1, OL:1, UL:1, TABLE:1, THEAD:1, TBODY:1, TFOOT:1,
    TR:1, LI:1, BLOCKQUOTE:1, COLGROUP:1 };
  var BLOCK_TAGS = { P:1, DIV:1, UL:1, OL:1, LI:1, TABLE:1, THEAD:1, TBODY:1, TFOOT:1, TR:1, TD:1, TH:1,
    BLOCKQUOTE:1, PRE:1, HR:1, H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, COLGROUP:1, COL:1 };
  function isBlockNode(n) { return n.nodeType === 1 && !!BLOCK_TAGS[n.tagName]; }
  function collapseStructuralWhitespace(html) {
    var doc;
    try { doc = new DOMParser().parseFromString("<div id='__w'>" + String(html || "") + "</div>", "text/html"); }
    catch (e) { return String(html || ""); }
    var root = doc.getElementById("__w");
    if (!root) return String(html || "");
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (ch) {
        if (ch.nodeType === 1) walk(ch);
      });
      if (node === root || WS_BLOCK_PARENTS[node.tagName]) {
        // Drop whitespace-only text only where it sits next to a BLOCK (or at an
        // edge). Between two inline pieces — "<strong>Pay now</strong> <em>today</em>"
        // inside a list item — the space is real text and must stay.
        Array.prototype.slice.call(node.childNodes).forEach(function (ch) {
          if (ch.nodeType !== 3 || /\S/.test(ch.nodeValue)) return;
          var prev = ch.previousSibling, next = ch.nextSibling;
          if (!prev || !next || isBlockNode(prev) || isBlockNode(next)) node.removeChild(ch);
        });
      }
    })(root);
    return root.innerHTML;
  }

  function htmlToText(html) {
    return String(html || "")
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .trim();
  }

  // Replace a rich editor's content with MARKDOWN, exactly like a human paste.
  // Ringg's editor (TipTap/ProseMirror) renders markdown from the clipboard's
  // text/plain — pipes become real tables, ## become headings, ** become bold,
  // "- " become lists. So we paste the RAW markdown as text/plain (NOT HTML,
  // and NOT flattened text, which is what dropped tables before). We first fire
  // Cmd/Ctrl+A so the editor selects all and the paste REPLACES its content.
  function pasteMarkdownIntoEditor(editorEl, markdown) {
    return new Promise(function (resolve) {
      var before = (editorEl.innerText || editorEl.textContent || "");
      function selectAll() {
        try { editorEl.focus(); } catch (e) {}
        // ProseMirror maps Mod-a to select-all; send both meta (mac) and ctrl.
        ["Meta", "Control"].forEach(function (mod) {
          try {
            editorEl.dispatchEvent(new KeyboardEvent("keydown", {
              key: "a", code: "KeyA", keyCode: 65, which: 65,
              bubbles: true, cancelable: true,
              metaKey: mod === "Meta", ctrlKey: mod === "Control"
            }));
          } catch (e) {}
        });
        // Fallback DOM selection (covers plain contenteditables).
        try {
          var sel = window.getSelection(); var r = document.createRange();
          r.selectNodeContents(editorEl); sel.removeAllRanges(); sel.addRange(r);
        } catch (e) {}
      }
      function pasteText(txt) {
        var dt = new DataTransfer();
        dt.setData("text/plain", txt);
        var ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
        try { Object.defineProperty(ev, "clipboardData", { value: dt }); } catch (e) {}
        editorEl.dispatchEvent(ev);
      }
      selectAll();
      pasteText(markdown);
      setTimeout(function () {
        var now = (editorEl.innerText || editorEl.textContent || "");
        if (now !== before) { resolve(true); return; }
        // Editor ignored the synthetic paste — insert the text directly.
        try { selectAll(); document.execCommand("insertText", false, markdown); } catch (e) {}
        setTimeout(function () {
          resolve((editorEl.innerText || editorEl.textContent || "") !== before);
        }, 90);
      }, 150);
    });
  }

  // A pasted result is "dirty" if the editor ended up with an empty spacer
  // paragraph / heading — the blank-line artifact. Our source HTML never contains
  // empty blocks (collapseStructuralWhitespace guarantees it) and a clean Ringg
  // doc for this content has none either, so ANY such block is a paste glitch.
  function spacerBlocks(editorEl) {
    // Empty paragraphs/headings/list items OUTSIDE table cells. An empty cell
    // legitimately holds an empty paragraph — treating it as a glitch made the
    // importer re-paste into the table and add a column.
    return [].slice.call(editorEl.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li")).filter(function (b) {
      if (b.closest("td,th")) return false;
      if (b.querySelector("img,[data-type='mention'],.mention,.node-mention,hr")) return false;
      return !(b.textContent || "").replace(/\u00a0/g, " ").trim() && !b.querySelector("p,li");
    });
  }
  function hasSpacerArtifacts(editorEl) { return spacerBlocks(editorEl).length > 0; }

  // Replace a rich editor's content with HTML via a synthetic paste, then VERIFY
  // the result and RE-PASTE if it came out with stray blank lines. Pasting into
  // ProseMirror is occasionally glitchy under load (a just-expanded editor, rapid
  // multi-bucket writes), leaving empty spacer paragraphs — intermittently. Since
  // a re-paste does a fresh select-all + replace, retrying until the editor is
  // clean makes the import deterministic: perfect every time, not "sometimes".
  function pasteHtmlIntoEditor(editorEl, html) {
    return new Promise(function (resolve) {
      var expected = htmlToText(html).replace(/\s+/g, " ").trim();
      // Clearing a field: pasting "" (or an empty <p>) is a no-op in TipTap, so
      // clear the way a person would — Mod-A then Backspace — which ProseMirror
      // turns into one clean empty paragraph (verified live on Rezolv).
      var clearing = expected === "";
      function curText() { return (editorEl.innerText || editorEl.textContent || "").replace(/\s+/g, " ").trim(); }
      function selectAllAndPaste() {
        try {
          editorEl.scrollIntoView({ block: "center" });
          editorEl.focus();
          // ProseMirror maps Mod-A to select-all so the paste REPLACES the doc.
          ["Meta", "Control"].forEach(function (mod) {
            try {
              editorEl.dispatchEvent(new KeyboardEvent("keydown", {
                key: "a", code: "KeyA", keyCode: 65, which: 65,
                bubbles: true, cancelable: true,
                metaKey: mod === "Meta", ctrlKey: mod === "Control"
              }));
            } catch (e) {}
          });
          var sel = window.getSelection();
          var range = document.createRange();
          range.selectNodeContents(editorEl);
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (e) {}
        if (clearing) {
          try {
            editorEl.dispatchEvent(new KeyboardEvent("keydown", {
              key: "Backspace", code: "Backspace", keyCode: 8, which: 8, bubbles: true, cancelable: true
            }));
            // A lone heading/list block can survive — turn it back into a paragraph.
            var first = editorEl.firstElementChild;
            if (curText() === "" && first && !/^P$/i.test(first.tagName)) {
              ["Meta", "Control"].forEach(function (mod) {
                editorEl.dispatchEvent(new KeyboardEvent("keydown", {
                  key: "0", code: "Digit0", keyCode: 48, which: 48, altKey: true,
                  metaKey: mod === "Meta", ctrlKey: mod === "Control", bubbles: true, cancelable: true
                }));
              });
            }
            if (curText() !== "" && attempt >= 2) document.execCommand("delete");
          } catch (e) {}
          return;
        }
        // text/html ONLY: adding text/plain makes the markdown paste-handler win
        // and drops headings/bold (verified live). HTML-only renders formatting
        // AND rebuilds variable chips.
        try {
          var dt = new DataTransfer();
          dt.setData("text/html", html);
          var ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
          try { Object.defineProperty(ev, "clipboardData", { value: dt }); } catch (e) {}
          editorEl.dispatchEvent(ev);
        } catch (e) {}
      }
      var MAX = 4, attempt = 0;
      function go() {
        attempt++;
        selectAllAndPaste();
        setTimeout(function () {
          var registered = expected === "" ? curText() === "" : curText().length > 0;
          // An emptied editor legitimately holds one empty paragraph.
          var clean = registered && (expected === "" || !hasSpacerArtifacts(editorEl));
          if (clean) { resolve(true); return; }
          if (attempt >= MAX) {
            // Last resort: if it registered but still shows a stray blank line,
            // scrub the empty blocks directly (best-effort; better than shipping
            // a blank line). Then accept.
            try {
              if (registered && expected !== "" && hasSpacerArtifacts(editorEl)) {
                spacerBlocks(editorEl).forEach(function (b) { try { b.remove(); } catch (e) {} });
                editorEl.dispatchEvent(new Event("input", { bubbles: true }));
              }
            } catch (e) {}
            resolve(registered);
            return;
          }
          go(); // re-paste: fresh select-all replaces the glitched content
        }, 220);
      }
      go();
    });
  }

  // ========================================================================
  //  SMART IMPORT — one pipeline for both sites and both ZIP shapes
  // ========================================================================
  // 1) Read whatever was dropped into a neutral "source": { parts: {key: text},
  //    kind, unmatched, mainWhole } where key is a Ringg bucket key or
  //    "main-prompt" (a 2-bucket Main Prompt file).
  // 2) resolveImportPlan(src, curMap) maps that source onto THIS site's fields:
  //      Ringg  ← 5-bucket: file → bucket
  //      Ringg  ← 2-bucket: First Message → First Message; Main Prompt split by
  //                         its # headings into the 4 buckets
  //      Rezolv ← 5-bucket: First Message → First Message; 4 buckets collated
  //                         under # headings → Main Prompt
  //      Rezolv ← 2-bucket: both files as-is
  var REZOLV_TARGETS = [
    { key: "first-message", title: "First Message", filename: "First message.md" },
    { key: "main-prompt", title: "Main Prompt", filename: "Main Prompt.md" }
  ];
  function siteTargets() {
    return isGorezolv() ? REZOLV_TARGETS : window.RinggExtract.SECTIONS;
  }
  function targetByKey(key) {
    return siteTargets().filter(function (t) { return t.key === key; })[0] || null;
  }
  function siteName() { return isGorezolv() ? "Rezolv" : "Ringg"; }

  function isMainPromptName(fileName) {
    var base = fileStem(fileName);
    var n = normName(base.replace(/^\s*\d+\s*[-_.)\]]*\s*/, ""));
    return n === "mainprompt" || n === "systemprompt";
  }

  function isJunkEntry(name) {
    var n = String(name || "");
    var base = n.split("/").pop();
    return /(^|\/)__MACOSX\//.test(n) || /^\./.test(base) || base === "" || /\/$/.test(n);
  }

  function newSource() { return { parts: {}, kind: "", unmatched: [], mainWhole: false }; }
  function addPart(src, key, text) {
    if (Object.prototype.hasOwnProperty.call(src.parts, key)) return false; // first wins
    src.parts[key] = String(text == null ? "" : text);
    return true;
  }
  function sourceKind(src) {
    var hasMain = Object.prototype.hasOwnProperty.call(src.parts, "main-prompt");
    var nB = MAIN_SPLIT_KEYS.filter(function (k) { return Object.prototype.hasOwnProperty.call(src.parts, k); }).length;
    if (hasMain) return "two";
    if (nB === 4) return "five";
    if (nB > 0) return "partial";
    if (Object.prototype.hasOwnProperty.call(src.parts, "first-message")) return "fm-only";
    return "none";
  }

  // ZIP → source. Main Prompt files are recognised by name; everything else by
  // bucket name (with or without the "N_" order prefix).
  async function readZipSource(arrayBuffer) {
    var entries;
    try { entries = await window.RinggUnzip.read(arrayBuffer); }
    catch (e) {
      if (e instanceof RangeError || /DataView|bounds|offset/i.test(String(e && e.message))) {
        throw new Error("The zip looks damaged (its file list points outside the file). Re-export or re-zip it and try again.");
      }
      throw e;
    }
    var src = newSource();
    (entries.skipped || []).forEach(function (s) { src.unmatched.push(s.name.split("/").pop() + " (" + s.why + ")"); });
    entries.forEach(function (f) {
      if (isJunkEntry(f.name)) return;
      var short = String(f.name).split("/").pop();
      if (!/\.(md|markdown|txt)$/i.test(short)) { src.unmatched.push(short); return; }
      if (isMainPromptName(f.name)) {
        if (!addPart(src, "main-prompt", f.text)) src.unmatched.push(short + " (duplicate of Main Prompt — the first file was used)");
        src.mainWhole = true;
        return;
      }
      var sec = matchSection(f.name);
      if (!sec) { src.unmatched.push(short); return; }
      if (!addPart(src, sec.key, f.text)) src.unmatched.push(short + " (duplicate of " + sec.title + " — the first file was used)");
    });
    src.kind = sourceKind(src);
    return src;
  }

  // Single .md → source (or { ambiguous:true } when we can't tell where it goes).
  function sourceFromMd(text, fileName) {
    var src = newSource();
    // A file named "Main Prompt" is the whole Main Prompt — unless it actually
    // carries a First Message section too (then it's a combined full prompt).
    var hasFmHead = String(text || "").split(/\r?\n/).some(function (L) {
      var sec = sectionHeaderAt(L); return sec && sec.key === "first-message";
    });
    if (isMainPromptName(fileName) && !hasFmHead) {
      addPart(src, "main-prompt", text);
      src.mainWhole = true;
      src.kind = sourceKind(src); src.single = true;
      return src;
    }
    var parsed = parseSingleMd(text, fileName);
    if (parsed.mode === "ambiguous") return { ambiguous: true, text: parsed.text, fileName: fileName };
    parsed.matched.forEach(function (m) {
      addPart(src, m.sec.key, m.file.text);
      if (m.sec.key === "main-prompt") src.mainWhole = true;
    });
    src.notes = (parsed.notes || []).slice();
    src.kind = sourceKind(src); src.single = true;
    return src;
  }

  function cleanText(t) { return meaningful(t) ? String(t).trim() : ""; }

  function mkMatch(key, text, name) {
    var t = targetByKey(key);
    return { sec: t, file: { name: name || (t && t.filename) || key, text: text } };
  }

  var KIND_LABEL = {
    five: "5-bucket ZIP",
    two: "2-bucket ZIP (First Message + Main Prompt)",
    partial: "some buckets",
    "fm-only": "First Message only"
  };

  // Map a source onto the current site's fields.
  // Returns { matched:[{sec,file}], unmatched, missing, notes, detected }.
  function resolveImportPlan(src, curMap) {
    curMap = curMap || {};
    var P = src.parts, has = function (k) { return Object.prototype.hasOwnProperty.call(P, k); };
    var matched = [], notes = (src.notes || []).slice(), unmatched = (src.unmatched || []).slice();
    var kindLabel = KIND_LABEL[src.kind] || "unrecognised content";
    if (src.kind === "partial" || src.kind === "fm-only") {
      kindLabel = ["first-message"].concat(MAIN_SPLIT_KEYS).filter(function (k) { return has(k); })
          .map(function (k) { return k === "first-message" ? "First Message" : bucketHeading(k); }).join(" + ") + " only";
    }
    if (src.kind === "two" && !has("first-message")) kindLabel = "Main Prompt only";
    var detected = src.single ? ".md file — " + kindLabel.replace(/ ZIP\b/, "")
      : ((src.kind === "five" || src.kind === "two") && !/ only$/.test(kindLabel)) ? kindLabel : "ZIP with " + kindLabel;

    if (has("first-message")) matched.push(mkMatch("first-message", cleanText(P["first-message"])));

    if (!isGorezolv()) {
      // ---------------- Ringg (5 buckets) ----------------
      var bucket = {};
      MAIN_SPLIT_KEYS.forEach(function (k) { if (has(k)) bucket[k] = cleanText(P[k]); });
      if (has("main-prompt")) {
        var mp = String(P["main-prompt"] || "");
        var sp = splitMainPrompt(mp);
        var parts = null, how = "";
        if (sp.ok) {
          parts = sp.parts; how = "# headings";
        } else if (sp.pre && sp.parts) {
          // Keep text above the first heading: it goes at the start of that section.
          parts = sp.parts; how = "# headings";
          parts[sp.firstKey] = sp.pre + (parts[sp.firstKey] ? "\n\n" + parts[sp.firstKey] : "");
          notes.push("Main Prompt has text above its first # heading — it was added to the start of " + bucketHeading(sp.firstKey) + ".");
        } else if (!meaningful(mp)) {
          parts = {};                                   // empty Main Prompt = all 4 empty
        } else {
          // Looser fallback: "## Objective", "**FAQs**", "Objective:" style headings.
          var loose = parseSingleMd(mp, "");
          var ok4 = loose.mode !== "ambiguous" && loose.matched.some(function (m) {
            return MAIN_SPLIT_KEYS.indexOf(m.sec.key) !== -1;
          });
          if (ok4) {
            parts = {};
            loose.matched.forEach(function (m) {
              if (m.sec.key === "first-message") {
                if (!has("first-message")) matched.push(mkMatch("first-message", cleanText(m.file.text)));
                return;
              }
              parts[m.sec.key] = m.file.text;
            });
            how = "loose";
            (loose.notes || []).forEach(function (n) { notes.push(n); });
            notes.push("Main Prompt headings weren't the standard “# Section” form — split using the section names it contains.");
          } else {
            notes.push("Main Prompt couldn't be split into the 4 buckets (" + (sp.reason || "no section headings") +
              ") — it was NOT imported. Add “# Objective”, “# Response Guidelines”, “# Conversation Flow”, “# FAQs” headings, or import it on a page with a single Main Prompt field.");
            unmatched.push(src.single ? "Main Prompt section" : "Main Prompt file");
          }
        }
        if (parts) {
          MAIN_SPLIT_KEYS.forEach(function (k) {
            if (Object.prototype.hasOwnProperty.call(bucket, k)) return; // an explicit bucket file wins
            if (Object.prototype.hasOwnProperty.call(parts, k)) bucket[k] = cleanText(parts[k]);
            else if (src.mainWhole) bucket[k] = "";      // Main Prompt is the whole prompt → section absent = empty
          });
          var cleared = MAIN_SPLIT_KEYS.filter(function (k) {
            return bucket[k] === "" && meaningful(curMap[k]);
          }).map(bucketHeading);
          if (how === "# headings") notes.push("Main Prompt split by its # headings into the 4 buckets.");
          if (cleared.length) notes.push("Main Prompt has no section for: " + cleared.join(", ") + " — those buckets will be emptied.");
        }
      }
      MAIN_SPLIT_KEYS.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(bucket, k)) matched.push(mkMatch(k, bucket[k]));
      });
    } else {
      // ---------------- Rezolv (First Message + Main Prompt) ----------------
      var incoming = {};
      MAIN_SPLIT_KEYS.forEach(function (k) { if (has(k)) incoming[k] = cleanText(P[k]); });
      var nIn = Object.keys(incoming).length;
      if (has("main-prompt")) {
        matched.push(mkMatch("main-prompt", cleanText(P["main-prompt"])));
        if (nIn) notes.push("Both a Main Prompt file and separate bucket files were found — the Main Prompt file was used.");
      } else if (nIn === 4) {
        matched.push(mkMatch("main-prompt", collateMain(incoming)));
        notes.push("Objective, Response Guidelines, Conversation Flow and FAQs combined into Main Prompt, each under its own # heading.");
      } else if (nIn > 0) {
        var cur = curMap["main-prompt"] || "";
        var csp = splitMainPrompt(cur);
        var names = Object.keys(incoming).map(bucketHeading).join(", ");
        if (csp.ok) {
          var merged = {};
          MAIN_SPLIT_KEYS.forEach(function (k) { merged[k] = csp.parts[k] || ""; });
          Object.keys(incoming).forEach(function (k) { merged[k] = incoming[k]; });
          matched.push(mkMatch("main-prompt", collateMain(merged)));
          notes.push("Only " + names + " will change inside Main Prompt — its other # sections are kept.");
        } else {
          matched.push(mkMatch("main-prompt", collateMain(incoming)));
          if (meaningful(cur)) {
            notes.push("The current Main Prompt isn't organised under # section headings, so " + names +
              " can't be slotted in — the WHOLE Main Prompt will be replaced. Check the diff.");
          }
        }
      }
    }

    // Any field that would go from having text to empty gets a clear warning.
    var already = notes.join(" ");
    var emptied = matched.filter(function (m) {
      return !meaningful(m.file.text) && meaningful(curMap[m.sec.key]) && already.indexOf(m.sec.title) === -1;
    }).map(function (m) { return m.sec.title; });
    if (emptied.length) notes.push("The file has no content for " + emptied.join(", ") + " — " + (emptied.length === 1 ? "that field" : "those fields") + " will be emptied.");

    var seen = {};
    matched.forEach(function (m) { seen[m.sec.key] = true; });
    var missing = siteTargets().filter(function (t) { return !seen[t.key]; }).map(function (t) { return t.title; });
    return { matched: matched, unmatched: unmatched, missing: missing, notes: notes, detected: detected };
  }

  // Back-compat wrapper (and handy for tests): ZIP → plan for this site.
  async function planImport(arrayBuffer) {
    return resolveImportPlan(await readZipSource(arrayBuffer), null);
  }

  // Read the current fields, build the plan against them, show the review.
  function beginImport(src) {
    ++opGen; // supersede any in-flight panel refresh so it can't render over us
    if (src && src.error) { renderImportPlan({ error: src.error }, null); return; }
    if (src && src.ambiguous) { renderMdTargetPicker(src.text, src.fileName); return; }
    freshPanel("Import");
    var rd = el("div", "rs-note", "Reading the current fields on the page to build the diff…");
    rd.setAttribute("aria-live", "polite");
    panel.appendChild(rd);
    runExclusive(collectSections).then(function (cur) {
      var curMap = {};
      (cur || []).forEach(function (c) { curMap[c.key] = c.text || ""; });
      renderImportPlan(resolveImportPlan(src, curMap), curMap, src);
    }).catch(function () { renderImportPlan(resolveImportPlan(src, {}), {}); });
  }

  // The site's editors keyed by field key.
  function siteEditors() {
    var editors = {};
    if (isGorezolv()) {
      var g = gorezolvEditors();
      if (g.fm) editors["first-message"] = g.fm;
      if (g.mp) editors["main-prompt"] = g.mp;
      return editors;
    }
    try {
      window.RinggExtract.sectionEditors().forEach(function (m) { editors[m.key] = m.el; });
    } catch (e) {}
    return editors;
  }

  // After a paste, compare the text that landed with the text we sent (variable
  // chips excluded — their visible label differs by design). Rich editors apply
  // their own "paste rules" (e.g. *text* → italic), so a literal * _ ~ ` pair can
  // silently turn into formatting. Report it instead of hiding it.
  function visibleText(node) {
    var c = node.cloneNode(true);
    [].slice.call(c.querySelectorAll('[data-type="mention"], .node-mention, .mention')).forEach(function (m) { m.remove(); });
    return (c.textContent || "").replace(/\s+/g, "");
  }
  function pasteDrift(html, el) {
    try {
      var tmp = document.createElement("div");
      tmp.innerHTML = html;
      var want = visibleText(tmp), got = visibleText(el);
      if (want === got) return "";
      var strip = function (x) { return x.replace(/[*_~`]/g, ""); };
      if (strip(want) === strip(got)) return "the editor turned some literal * _ ~ ` characters into formatting — review";
      return "text on the page differs from the file — review";
    } catch (e) { return ""; }
  }

  // Perform the writes. Returns per-section results.
  async function runImport(matched) {
    if (!isGorezolv()) {
      try {
        var opened = window.RinggExtract.expandCollapsed();
        if (opened) { await sleep(700); window.RinggExtract.expandCollapsed(); await sleep(300); }
      } catch (e) {}
    }

    var editors = siteEditors();

    var results = [];
    for (var i = 0; i < matched.length; i++) {
      var sec = matched[i].sec, file = matched[i].file;
      var el = editors[sec.key];
      if (!el) { results.push({ title: sec.title, ok: false, reason: "editor not found" }); continue; }
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        try {
          var proto = Object.getPrototypeOf(el);
          var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(el, file.text);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          results.push({ title: sec.title, ok: true });
        } catch (e) { results.push({ title: sec.title, ok: false, reason: "input write failed" }); }
        continue;
      }
      // Rich editor: paste as text/html so formatting AND variable chips survive
      // (pasting raw markdown as text/plain rendered formatting but left variables
      // as literal "@{{…}}" text — the plain-paste bug).
      var html = mdToHydratedHtml(file.text);
      var ok = await pasteHtmlIntoEditor(el, html);
      var res = { title: sec.title, ok: ok, reason: ok ? "" : "paste not registered" };
      if (ok) {
        var drift = pasteDrift(html, el);
        if (drift) res.warn = drift;
      }
      results.push(res);
      await sleep(150);
    }
    return results;
  }

  // ---- Auto-backup before import (safety net) -----------------------------
  // Snapshot the CURRENT on-screen content of this site's fields (5 Ringg
  // buckets, or Rezolv's First Message + Main Prompt). collectSections reads the
  // live editors, so this captures unsaved edits too.
  async function snapshotBuckets() {
    var sections = await collectSections();
    var byKey = {};
    sections.forEach(function (s) { byKey[s.key] = s; });
    var matched = siteTargets().map(function (t) {
      var s = byKey[t.key] || { text: "" };
      return { sec: t, file: { name: t.filename, text: (s.text || "") } };
    });
    return { when: new Date(), sections: sections, matched: matched, importedKeys: [] };
  }

  function backupWhat() { return isGorezolv() ? "First Message + Main Prompt" : "the 5 buckets"; }

  function backupStamp(d) {
    d = d || new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function downloadBackup() {
    if (!_lastBackup) { toast("No backup available yet."); return; }
    try {
      var files = isGorezolv() ? sectionsToTwoFiles(_lastBackup.sections) : sectionsToFiles(_lastBackup.sections);
      saveZip(files, "backup-" + fileBase(nameFromUI() || assistantName()) + "-" + backupStamp(_lastBackup.when) + ".zip");
      toast("Backup downloaded — " + backupWhat() + " as they were before this import.");
      setLinks(true);
    } catch (e) { toast("Couldn't build the backup zip."); }
  }

  // Restore the buckets the import overwrote to their pre-import content.
  async function undoLastImport(btn) {
    if (!_lastBackup) { toast("No backup to undo."); return; }
    if (btn) { btn.disabled = true; btn.textContent = "Undoing…"; }
    setLinks(false);
    var keys = (_lastBackup.importedKeys && _lastBackup.importedKeys.length)
      ? _lastBackup.importedKeys
      : _lastBackup.matched.map(function (m) { return m.sec.key; });
    var restore = _lastBackup.matched.filter(function (m) { return keys.indexOf(m.sec.key) !== -1; });
    var results = await runImport(restore);
    if (_lastBackup) _lastBackup.undone = true;
    showImportResults(results, { undone: true }, btn && btn._gen);
  }

  function openImportPicker(onPlan) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      document.body.removeChild(input);
      if (!file) return;
      file.arrayBuffer().then(function (ab) {
        return readZipSource(ab);
      }).then(onPlan).catch(function (err) {
        onPlan({ error: (err && err.message) || "Could not read the zip." });
      });
    });
    input.click();
  }

  // ========================================================================
  //  IMPORT: write a SINGLE .md file back into one or all buckets (smart)
  // ========================================================================
  // Match a heading's text (e.g. "Response Guidelines") to a bucket.
  function matchSectionByHeading(str) {
    var n = normName(str);
    if (!n) return null;
    var secs = window.RinggExtract.SECTIONS;
    for (var i = 0; i < secs.length; i++) {
      var sec = secs[i];
      if (normName(sec.title) === n) return sec;
      if (normName(sec.filename.replace(/\.md$/i, "")) === n) return sec;
      for (var j = 0; j < sec.labels.length; j++) {
        if (normName(sec.labels[j]) === n) return sec;
      }
    }
    return null;
  }

  // Recognize a section-delimiter LINE in many shapes and return its bucket:
  //   "# First Message", "## Objective", "**FAQs**",
  //   "Prompt 1 – First Message -", "Section 3: Response Guidelines",
  //   "Objective:", "Conversation Script —", "1. FAQs"
  // It strips leading markdown/quote/bold markers, an optional
  // "Prompt/Section/Part/Bucket N" label, and surrounding dashes/colons/dots,
  // then requires what remains to equal a bucket name EXACTLY — so an ordinary
  // sentence that merely contains the words (e.g. "Handle the First Message
  // response:") is never mistaken for a header.
  function sectionHeaderAt(line) {
    var raw = String(line || "").trim();
    if (!raw || raw.length > 60) return null;          // headers are short lines
    var s = raw
      .replace(/^[#>\s]*/, "")                          // markdown heading / blockquote
      .replace(/[*_`]+/g, "")                           // bold / emphasis / code
      .replace(/^\s*(prompt|section|part|bucket)\b\s*/i, "") // optional label word
      .replace(/^[\s\d]*[-–—:.)]+\s*/, "")              // leading number + separator(s)
      .replace(/\s*[-–—:.]+\s*$/, "")                   // trailing separator(s)
      .trim();
    return s ? canonicalSection(s) : null;
  }

  // Parse a single markdown file into a set of {sec, file} matches.
  //  - If it has ≥2 headings that name buckets  -> multi (split into those buckets)
  //  - If it has exactly 1 such heading         -> single (that bucket)
  //  - If it has none but the FILE NAME matches -> single (that bucket, whole file)
  //  - Otherwise                                -> ambiguous (ask which bucket)
  function parseSingleMd(text, fileName) {
    var lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
    var cands = [], inFence = false;
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (/^\s{0,3}(```|~~~)/.test(L)) { inFence = !inFence; continue; }
      if (inFence) continue;
      var hm = L.match(/^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/);
      var level = hm ? hm[1].length : 0;
      var title = hm ? hm[2].replace(/[*_`]+/g, "").trim() : "";
      var key = null, sec = null;
      if (hm && isMainHeading(title)) key = "main-prompt";
      else {
        sec = hm ? canonicalSection(title) : sectionHeaderAt(L);
        if (sec) key = sec.key;
      }
      if (key) cands.push({ key: key, sec: sec, line: i, level: level });
    }
    // Prefer the outermost markdown heading level when it names ≥2 sections;
    // deeper headings with section names are then content (e.g. "### FAQs"
    // inside Conversation Script). Mixed/loose files fall back to all lines.
    var heads = cands;
    var md = cands.filter(function (c) { return c.level > 0; });
    if (md.length) {
      var minL = Math.min.apply(null, md.map(function (c) { return c.level; }));
      var atMin = md.filter(function (c) { return c.level === minL; });
      var distinct = {}; atMin.forEach(function (c) { distinct[c.key] = 1; });
      if (Object.keys(distinct).length >= 2) heads = atMin;
    }
    // Inside a "# Main Prompt" section the bucket headings belong to it.
    var kept = [], inMain = false;
    heads.forEach(function (c) {
      if (c.key === "main-prompt") { inMain = true; kept.push(c); return; }
      if (inMain && MAIN_SPLIT_KEYS.indexOf(c.key) !== -1) return;
      if (c.key === "first-message") inMain = false;
      kept.push(c);
    });
    heads = kept;

    var whole = String(text || "").trim();
    var byName = matchSection(fileName);
    var distinctAll = {}; heads.forEach(function (c) { distinctAll[c.key] = 1; });
    var nDistinct = Object.keys(distinctAll).length;
    // A file named after one bucket goes WHOLE into that bucket unless it is
    // clearly a combined file (two or more different sections).
    if (byName && (nDistinct === 0 || (nDistinct === 1 && distinctAll[byName.key]))) {
      var body = whole;
      if (heads.length && heads[0].key === byName.key) {
        var pre0 = lines.slice(0, heads[0].line).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
        if (!pre0) body = lines.slice(heads[0].line + 1).join("\n").trim();   // drop its own title line
      }
      return { mode: "single", matched: [{ sec: byName, file: { name: byName.filename, text: body } }], notes: [] };
    }
    if (!heads.length) {
      if (byName) return { mode: "single", matched: [{ sec: byName, file: { name: byName.filename, text: whole } }], notes: [] };
      return { mode: "ambiguous", text: whole };
    }
    var matched = [], byKey = {}, notes = [];
    for (var s = 0; s < heads.length; s++) {
      var cur = heads[s];
      var end = (s + 1 < heads.length) ? heads[s + 1].line : lines.length;
      var bodyS = lines.slice(cur.line + 1, end).join("\n").trim();
      var sec2 = cur.key === "main-prompt" ? { key: "main-prompt", title: "Main Prompt", filename: "Main Prompt.md" } : cur.sec;
      if (byKey[cur.key]) {
        // The same section twice: keep BOTH parts (never drop text silently).
        if (bodyS) byKey[cur.key].file.text = (byKey[cur.key].file.text ? byKey[cur.key].file.text + "\n\n" : "") + bodyS;
        notes.push("“" + sec2.title + "” appears more than once — the parts were joined in order.");
        continue;
      }
      byKey[cur.key] = { sec: sec2, file: { name: sec2.filename, text: bodyS } };
      matched.push(byKey[cur.key]);
    }
    // Text above the first heading is kept: it goes at the start of the first section.
    var pre = lines.slice(0, heads[0].line).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
    if (pre && matched.length) {
      matched[0].file.text = pre + (matched[0].file.text ? "\n\n" + matched[0].file.text : "");
      notes.push("Text above the first section heading was added to the start of " + matched[0].sec.title + ".");
    }
    return { mode: matched.length > 1 ? "multi" : "single", matched: matched, notes: notes };
  }

  // Build a renderImportPlan-shaped plan from a list of matches.
  function planFromMatched(matched) {
    var seen = {};
    matched.forEach(function (m) { seen[m.sec.key] = true; });
    var missing = window.RinggExtract.SECTIONS
      .filter(function (s) { return !seen[s.key]; })
      .map(function (s) { return s.title; });
    return { matched: matched, unmatched: [], missing: missing };
  }

  // Pick a single .md (or .markdown / .txt) file and hand back its text + name.
  function openSingleMdPicker(onText) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt,text/markdown,text/plain";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      document.body.removeChild(input);
      if (!file) return;
      var reader = file.text ? file.text() : new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res(fr.result); };
        fr.onerror = rej;
        fr.readAsText(file);
      });
      Promise.resolve(reader)
        .then(function (txt) { onText(String(txt || ""), file.name); })
        .catch(function () { onText("", file.name); });
    });
    input.click();
  }

  function startImportMd() {
    openSingleMdPicker(function (text, fileName) {
      if (!text || !text.trim()) { ++opGen; renderImportPlan({ error: "That file was empty." }, null); return; }
      beginImport(sourceFromMd(text, fileName));
    });
  }

  // No recognizable headings and the filename didn't match a bucket — let the
  // user say which bucket this file belongs to.
  function renderMdTargetPicker(text, fileName) {
    freshPanel("Import .md — choose field");
    var targets = siteTargets();
    var info = el("div", "rs-lead");
    info.appendChild(el("b", null, "“" + fileName + "”"));
    info.appendChild(document.createTextNode(" has no section headings I recognise. Choose the field to fill:"));
    panel.appendChild(info);

    var group = el("fieldset", "rs-choices");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Field to fill");
    targets.forEach(function (t, i) {
      var lab = el("label", "rs-choice");
      var r = document.createElement("input");
      r.type = "radio"; r.name = "rs-field"; r.value = t.key; if (i === 0) r.checked = true;
      lab.appendChild(r); lab.appendChild(el("span", null, t.title));
      group.appendChild(lab);
    });
    panel.appendChild(group);
    panel.appendChild(el("div", "rs-muted", "You'll see the diff and confirm before anything is overwritten."));

    function picked() { var c = group.querySelector("input:checked"); return c ? c.value : targets[0].key; }
    var row = el("div", "rs-row");
    var go = mkBtn("Continue", primaryBtn(), function () {
      var key = picked();
      var src = newSource();
      addPart(src, key, String(text || "").trim());
      src.kind = sourceKind(src); src.single = true;
      if (key === "main-prompt") src.mainWhole = true;
      beginImport(src);
    });
    var cancel = mkBtn("Cancel", secondaryBtn(), function () { closePanel(); });
    row.appendChild(go); row.appendChild(cancel);
    footer().appendChild(row);
    setTimeout(function () { try { group.querySelector("input:checked").focus(); } catch (e) {} }, 50);
  }

  // ========================================================================
  //  DIFF (line-level) — used to preview an import before overwriting
  // ========================================================================
  function normForDiff(s) {
    s = String(s == null ? "" : s).replace(/\r/g, "");
    // On Rezolv a markdown hard break ("two spaces + newline") becomes a new
    // paragraph (that editor has no line breaks), so compare them as equal.
    s = s.replace(/[ \t]+$/gm, "");
    // Lines only: blank lines (paragraph vs line-break, loose vs tight lists) don't count.
    if (isGorezolv()) s = s.replace(/\n{2,}/g, "\n");
    return s.replace(/\n+$/, "");
  }

  function coarseDiff(a, b) {
    var mapA = {}, mapB = {}, i;
    for (i = 0; i < a.length; i++) mapA[a[i]] = (mapA[a[i]] || 0) + 1;
    for (i = 0; i < b.length; i++) mapB[b[i]] = (mapB[b[i]] || 0) + 1;
    var add = 0, del = 0, k;
    for (k in mapB) if (mapB.hasOwnProperty(k)) { var da = mapB[k] - (mapA[k] || 0); if (da > 0) add += da; }
    for (k in mapA) if (mapA.hasOwnProperty(k)) { var dd = mapA[k] - (mapB[k] || 0); if (dd > 0) del += dd; }
    return { add: add, del: del, ops: null, coarse: true };
  }

  function lineDiff(oldStr, newStr) {
    var o = normForDiff(oldStr), nw = normForDiff(newStr);
    // Hard cap on raw size so a malicious/huge file can't freeze the tab.
    if (o.length > 1500000 || nw.length > 1500000) {
      return { add: 0, del: 0, ops: null, coarse: true, skipped: true };
    }
    // An empty field has no lines (not one empty line) — so "" → "x" is +1 −0.
    var a = o === "" ? [] : o.split("\n");
    var b = nw === "" ? [] : nw.split("\n");
    // Guard on BOTH sum and product (a 1×4,000,000 diff must not hit the DP path).
    if (a.length + b.length > 6000 || a.length * b.length > 1500000) return coarseDiff(a, b);
    var m = a.length, n = b.length, i, j;
    var dp = [];
    for (i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1));
    for (i = m - 1; i >= 0; i--)
      for (j = n - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var ops = []; i = 0; j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { ops.push({ t: " ", v: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "-", v: a[i] }); i++; }
      else { ops.push({ t: "+", v: b[j] }); j++; }
    }
    while (i < m) { ops.push({ t: "-", v: a[i] }); i++; }
    while (j < n) { ops.push({ t: "+", v: b[j] }); j++; }
    var add = 0, del = 0;
    for (i = 0; i < ops.length; i++) { if (ops[i].t === "+") add++; else if (ops[i].t === "-") del++; }
    return { add: add, del: del, ops: ops };
  }

  // ========================================================================
  //  FIND & REPLACE across the 5 buckets
  // ========================================================================
  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  // The searchable editors on this site: Ringg's 5 buckets, or the 2-field
  // page's First Message + Main Prompt.
  function findEditors() {
    if (isGorezolv()) {
      var g = gorezolvEditors(), out = [];
      if (g.fm) out.push({ key: "first-message", title: "First Message", el: g.fm });
      if (g.mp) out.push({ key: "main-prompt", title: "Main Prompt", el: g.mp });
      return out;
    }
    try { return window.RinggExtract.sectionEditors(); } catch (e) { return []; }
  }
  async function openCollapsedForFind() {
    if (isGorezolv()) return;   // both fields are always on screen
    try {
      var opened = window.RinggExtract.expandCollapsed();
      if (opened) { await sleep(700); window.RinggExtract.expandCollapsed(); await sleep(300); }
    } catch (e) {}
  }
  // Whole word must work for any script (Hindi, emoji) and for queries that start
  // or end with punctuation like "[END CALL]" — so use letter/number lookarounds,
  // not \b (which only knows ASCII word characters).
  function findRegex(query, opts) {
    var pat = escapeRegExp(query);
    if (opts.wholeWord) pat = "(?<![\\p{L}\\p{M}\\p{N}_])" + pat + "(?![\\p{L}\\p{M}\\p{N}_])";
    return new RegExp(pat, (opts.matchCase ? "g" : "gi") + "u");
  }

  function ensureHighlightStyle() {
    if (document.getElementById("ringg-find-style")) return;
    var st = document.createElement("style");
    st.id = "ringg-find-style";
    st.textContent = "::highlight(ringg-find){background:#fde047;color:#000;} " +
                     "::highlight(ringg-find-current){background:#fb923c;color:#000;}";
    document.head.appendChild(st);
  }

  // Live "Cmd+F"-style match state shared across the 5 buckets.
  var _findRanges = [];
  var _findIdx = -1;

  function clearHighlights() {
    _findRanges = []; _findIdx = -1;
    try { if (window.CSS && CSS.highlights) { CSS.highlights.delete("ringg-find"); CSS.highlights.delete("ringg-find-current"); } } catch (e) {}
  }

  // Paint all matches yellow except the current one, which is painted orange.
  function paintFindHighlights() {
    try {
      if (!(window.CSS && CSS.highlights && window.Highlight)) return;
      CSS.highlights.delete("ringg-find");
      CSS.highlights.delete("ringg-find-current");
      if (!_findRanges.length) return;
      var all = new Highlight();
      for (var i = 0; i < _findRanges.length; i++) if (i !== _findIdx) all.add(_findRanges[i]);
      CSS.highlights.set("ringg-find", all);
      if (_findIdx >= 0 && _findRanges[_findIdx]) {
        var cur = new Highlight(); cur.add(_findRanges[_findIdx]);
        CSS.highlights.set("ringg-find-current", cur);
      }
    } catch (e) {}
  }

  // Bring the current match into view.
  function scrollFindCurrent() {
    var r = _findRanges[_findIdx];
    if (!r) return;
    try {
      var el = r.startContainer.parentElement || r.startContainer;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest" });
    } catch (e) {}
  }

  // Advance the current match by delta (wraps around). Returns 1-based index.
  function stepFind(delta) {
    if (!_findRanges.length) { _findIdx = -1; return 0; }
    _findIdx = (_findIdx + delta + _findRanges.length) % _findRanges.length;
    paintFindHighlights();
    scrollFindCurrent();
    return _findIdx + 1;
  }

  function editorHost(el) {
    if (!el) return null;
    if (el.querySelector) {
      var inner = el.querySelector(".ProseMirror, .ql-editor, [contenteditable='true'], .tiptap");
      if (inner) return inner;
    }
    return el;
  }

  // Highlight matches on the page (non-destructive, via CSS Highlight API).
  var MENTION_SEL = '[data-type="mention"], .node-mention, .mention';

  // Replace inside an editor's own copied HTML, text node by text node — the
  // same text Find searches — never inside variable chips and never across
  // markdown syntax (so "[END CALL]", "#", "|" or "*" behave like plain text).
  function replaceInHtml(html, query, replacement, opts) {
    var doc = new DOMParser().parseFromString("<div id='__rr'>" + String(html || "") + "</div>", "text/html");
    var root = doc.getElementById("__rr");
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), node, nodes = [];
    while ((node = walker.nextNode())) nodes.push(node);
    var count = 0, repl = String(replacement == null ? "" : replacement);
    nodes.forEach(function (n) {
      if (n.parentElement && n.parentElement.closest(MENTION_SEL)) return;
      var hits = (n.nodeValue.match(findRegex(query, opts)) || []).length;
      if (!hits) return;
      count += hits;
      n.nodeValue = n.nodeValue.replace(findRegex(query, opts), function () { return repl; });
    });
    return { html: root.innerHTML, count: count };
  }

  async function findAll(query, opts) {
    clearHighlights();
    ensureHighlightStyle();
    var res = { total: 0, per: [], supported: !!(window.CSS && CSS.highlights && window.Highlight) };
    if (!query) return res;
    await openCollapsedForFind();
    var map = findEditors();

    var ranges = [];
    for (var s = 0; s < map.length; s++) {
      var host = editorHost(map[s].el);
      if (!host) continue;
      var count = 0;
      var re = findRegex(query, opts);
      var walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        var text = node.nodeValue;
        if (!text) continue;
        // Variable chips are not prompt text (Ringg shows a friendly label like
        // "Callee Name"); never count them, so Find agrees with Replace.
        if (node.parentElement && node.parentElement.closest(MENTION_SEL)) continue;
        re.lastIndex = 0;
        var mm;
        while ((mm = re.exec(text))) {
          if (mm[0].length === 0) { re.lastIndex++; continue; }
          try {
            var r = document.createRange();
            r.setStart(node, mm.index);
            r.setEnd(node, mm.index + mm[0].length);
            ranges.push(r);
            count++;
          } catch (e) {}
        }
      }
      if (count) res.per.push({ title: map[s].title, count: count });
    }

    res.total = ranges.length;
    _findRanges = ranges;
    _findIdx = ranges.length ? 0 : -1;
    if (res.supported && ranges.length) {
      paintFindHighlights();
      scrollFindCurrent();
    }
    return res;
  }

  // Replace across buckets via the trusted copy → markdown → paste round-trip.
  // Pure, testable replace: escapes $ in the replacement, and leaves mention
  // spans untouched by splitting the markdown around them and replacing ONLY the
  // text between spans (no placeholder tokens → nothing the query can collide with).
  function applyReplace(md, query, replacement, opts) {
    var safeRepl = String(replacement == null ? "" : replacement).replace(/\$/g, "$$$$");

    var src = String(md || "");
    var spanRe = /<span\b[^>]*>[\s\S]*?<\/span>|@(?:\{\{[^{}]+\}\}|\(\([^()]+\)\)|\|\|[^|]+\|\|)/gi;
    var segs = [], last = 0, m;
    while ((m = spanRe.exec(src))) {
      var tag = m[0];
      var isMention = tag.charAt(0) === "@" || /data-type="mention"/i.test(tag) || /class="[^"]*mention/i.test(tag) || /data-id=/i.test(tag);
      segs.push({ keep: false, v: src.slice(last, m.index) }); // replaceable text before the span
      segs.push({ keep: isMention, v: tag });                  // mention span kept verbatim
      last = m.index + tag.length;
    }
    segs.push({ keep: false, v: src.slice(last) });

    var count = 0;
    var out = segs.map(function (seg) {
      if (seg.keep) return seg.v;                              // never touch mention spans
      count += (seg.v.match(findRegex(query, opts)) || []).length;
      return seg.v.replace(findRegex(query, opts), safeRepl);
    }).join("");
    return { text: out, count: count };
  }

  async function replaceAllBuckets(query, replacement, opts) {
    await openCollapsedForFind();
    var map = findEditors();

    var prevClip = "";
    try { prevClip = await navigator.clipboard.readText(); } catch (e) {}

    var results = [];
    for (var s = 0; s < map.length; s++) {
      var m = map[s];
      if (!m.el) continue;
      var md;
      if (m.el.tagName === "TEXTAREA" || m.el.tagName === "INPUT") {
        md = m.el.value || "";
        var rep0 = applyReplace(md, query, replacement, opts);
        if (!rep0.count) continue;
        try {
          var proto = Object.getPrototypeOf(m.el);
          var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          setter.call(m.el, rep0.text);
          m.el.dispatchEvent(new Event("input", { bubbles: true }));
          results.push({ title: m.title, n: rep0.count, ok: true });
        } catch (e) { results.push({ title: m.title, n: rep0.count, ok: false }); }
      } else {
        var cap = await copyEditor(m.el);
        var count, outHtml;
        if (cap.html) {
          // Preferred: edit the editor's own HTML (chips keep data-id, structure intact).
          var rh = replaceInHtml(cap.html, query, replacement, opts);
          count = rh.count; outHtml = collapseStructuralWhitespace(sanitizeHtml(rh.html));
        } else {
          md = cap.text || "";
          var rep = applyReplace(md, query, replacement, opts);
          count = rep.count; outHtml = mdToHydratedHtml(rep.text);
        }
        if (!count) continue;
        var ok = await pasteHtmlIntoEditor(m.el, outHtml);
        var rr = { title: m.title, n: count, ok: ok };
        // The page's editor may turn * _ ~ ` in the replacement into formatting — say so.
        if (ok) { var dr = pasteDrift(outHtml, m.el); if (dr) rr.warn = dr; }
        results.push(rr);
      }
      await sleep(150);
    }

    try { if (prevClip) await navigator.clipboard.writeText(prevClip); } catch (e) {}
    return results;
  }

  // ---- v2 UI (Shadow-DOM design system) -----------------------------------
  var RS_CSS = `
:host{
  --ink:#1a1a1a; --graphite:#4d4d4d; --steel:#6e6e6e; --ash:#cfcfcf; --mist:#ececec; --paper:#f7f7f7; --white:#ffffff;
  --rs-font:Verdana,Geneva,"DejaVu Sans",sans-serif;
  --sk:255px 14px 225px 14px/14px 225px 14px 255px;
  --sk2:14px 225px 14px 255px/255px 14px 225px 14px;
  --rs-dur:.2s; --rs-ease:cubic-bezier(.22,.9,.3,1);
  --hatch:repeating-linear-gradient(-45deg,var(--mist) 0 2px,transparent 2px 8px);
}
.rs-launcher,.rs-panel,.rs-toasts{font-family:var(--rs-font);color:var(--ink);font-style:normal;font-variant:normal;font-weight:normal;
  text-transform:none;letter-spacing:normal;word-spacing:normal;text-shadow:none;text-align:left;text-indent:0;white-space:normal;direction:ltr;
  line-height:1.45;font-size:13px;-webkit-text-stroke:0;text-decoration:none}
.rs-tab,.rs-btn,.rs-launcher,.rs-iconbtn,.rs-x{text-align:center}
.rs-panel button,.rs-panel input,.rs-panel select{font-family:var(--rs-font)}
/* ---- launcher ---- */
.rs-launcher{position:fixed;right:22px;bottom:22px;z-index:2147483646;display:inline-flex;align-items:center;gap:10px;
  min-height:52px;box-sizing:border-box;padding:8px 16px;border:2px solid var(--ink);border-radius:var(--sk2);cursor:pointer;
  color:var(--white);background:var(--ink);box-shadow:3px 4px 0 var(--steel);font-size:14px;font-weight:bold;
  transition:transform var(--rs-dur) var(--rs-ease),box-shadow var(--rs-dur) var(--rs-ease)}
.rs-launcher:hover{transform:translate(-1px,-1px);box-shadow:4px 5px 0 var(--steel)}
.rs-launcher:active{transform:translate(1px,1px);box-shadow:2px 2px 0 var(--steel)}
.rs-launcher.rs-tucked{transform:translateX(calc(100% - 12px))}
.rs-launcher.rs-tucked:hover{transform:translateX(calc(100% - 44px))}
.rs-star{width:18px;height:18px;flex:none;display:block}
.rs-badge{background:var(--white);color:var(--ink);border-radius:var(--sk);padding:1px 8px;font-size:12px;line-height:20px}
.rs-badge:empty{display:none}
/* ---- panel shell ---- */
.rs-panel{position:fixed;right:22px;bottom:90px;z-index:2147483647;width:392px;max-width:calc(100vw - 32px);
  max-height:min(780px,calc(100vh - 108px));display:flex;flex-direction:column;box-sizing:border-box;
  background:var(--white);border:2px solid var(--ink);border-radius:22px 9px 20px 11px/11px 20px 9px 22px;box-shadow:5px 6px 0 var(--ink);
  font-size:13px;line-height:1.45;transform-origin:bottom right}
.rs-panel.rs-enter{animation:rs-in .24s var(--rs-ease)}
@keyframes rs-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.rs-top{flex:none}
.rs-phead{display:flex;align-items:center;gap:8px;padding:6px 8px 0 18px;min-height:44px}
.rs-trust{flex:1;min-width:0;display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--steel)}
.rs-trust svg{flex:none}
.rs-trust-t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rs-links{display:flex;gap:6px;align-items:center}
.rs-links[hidden]{display:none}
.rs-links:not([hidden]){animation:rs-pop .35s var(--rs-ease)}
@keyframes rs-pop{from{opacity:0;transform:translateY(-4px) scale(.9)}to{opacity:1;transform:none}}
.rs-linkic{width:30px;height:30px;box-sizing:border-box;display:grid;place-items:center;background:var(--white);
  border:1.5px solid var(--ink);border-radius:var(--sk2);color:var(--ink);text-decoration:none}
.rs-linkic:nth-child(2){border-radius:var(--sk)}
.rs-linkic:hover{background:var(--mist)}
.rs-x{border:none;background:transparent;color:var(--ink);cursor:pointer;width:44px;height:44px;border-radius:10px;display:grid;place-items:center;flex:none}
.rs-x:hover{background:var(--paper)}
.rs-tabs{display:flex;padding:4px 14px 0;border-bottom:2px dashed var(--ash)}
.rs-tab{flex:1;border:none;background:transparent;color:var(--steel);font-weight:bold;font-size:14px;padding:10px 4px 12px;min-height:44px;cursor:pointer;position:relative}
.rs-tab:hover{color:var(--ink)}
.rs-tab.active{color:var(--ink)}
.rs-squig{position:absolute;left:20%;bottom:0;width:60%;height:8px;display:none}
.rs-tab.active .rs-squig{display:block}
.rs-body{flex:1 1 auto;min-height:0;padding:16px 18px;overflow-y:auto;overscroll-behavior:contain}
.rs-body>:first-child{margin-top:0}
.rs-body>:last-child{margin-bottom:0}
.rs-foot{flex:none;padding:14px 18px 14px;border-top:2px dashed var(--ash);background:var(--white);border-radius:0 0 18px 9px}
.rs-foot:empty{display:none}
.rs-foot>:first-child{margin-top:0}
/* ---- text ---- */
.rs-note,.rs-muted{color:var(--graphite);font-size:12.5px;line-height:1.55;margin:10px 0}
.rs-muted{font-size:11.5px;color:var(--steel)}
.rs-lead{font-size:13px;line-height:1.55;margin:0 0 12px}
.rs-done-line b{color:var(--ink)}
.rs-introw{display:flex;gap:12px;align-items:flex-start}
.rs-introw svg{flex:none}
.rs-introw p{margin:0;font-size:13px;line-height:1.55}
/* ---- export rows ---- */
.rs-card{display:flex;align-items:center;gap:10px;padding:7px 12px;border:2px solid var(--ink);border-radius:var(--sk);margin-bottom:8px;background:var(--white)}
.rs-card:nth-child(even){border-radius:var(--sk2)}
.rs-card.rs-empty{border-style:dashed;background:var(--paper)}
.rs-ic{width:24px;height:24px;flex:none;display:grid;place-items:center}
.rs-grow{flex:1;min-width:0}
.rs-cname{font-weight:bold;font-size:13px}
.rs-cmeta{font-size:11.5px;color:var(--steel);text-align:right;flex:none}
.rs-card.rs-empty .rs-cmeta{color:var(--graphite);font-weight:bold;max-width:58%}
.rs-count{font-variant-numeric:tabular-nums}
.rs-sk{position:relative;overflow:hidden;background:var(--mist);border-radius:6px}
.rs-sk::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.7),transparent);animation:rs-sweep 1.15s infinite}
@keyframes rs-sweep{100%{transform:translateX(100%)}}
.rs-sk-line{height:10px}
.rs-card.rs-loading{border-color:var(--ash)}
/* ---- buttons ---- */
.rs-row{display:flex;gap:12px;margin-top:12px}
.rs-btn{border:2px solid var(--ink);border-radius:var(--sk);font-weight:bold;font-size:13px;line-height:1.25;cursor:pointer;
  padding:10px 8px;min-height:48px;flex:1 1 0;min-width:0;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-align:center;
  background:var(--white);color:var(--ink);transition:transform var(--rs-dur),box-shadow var(--rs-dur),background var(--rs-dur)}
.rs-row>.rs-btn:nth-child(even){border-radius:var(--sk2)}
.rs-btn:active{transform:translate(1px,1px)}
.rs-btn svg{flex:none}
.rs-btn-primary,.rs-btn-danger{background:var(--ink);color:var(--white);box-shadow:3px 3px 0 var(--steel)}
.rs-btn-primary:hover,.rs-btn-danger:hover{box-shadow:4px 4px 0 var(--steel)}
.rs-btn-ghost{background:var(--white);color:var(--ink)}
.rs-btn-ghost:hover{background:var(--mist)}
.rs-btn:disabled{background:var(--white) var(--hatch);color:var(--graphite);border-style:dashed;border-color:var(--steel);box-shadow:none;cursor:not-allowed;transform:none}
.rs-row.rs-three{display:grid;grid-template-columns:1fr 1.35fr 1fr;gap:10px}
.rs-btn svg{width:auto}
.rs-ctas{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.rs-cta{flex-direction:column;gap:4px;padding:12px 8px 10px;min-height:126px;background:var(--mist);color:var(--ink);box-shadow:3px 3px 0 var(--ink);font-size:13px}
.rs-cta:nth-child(even){border-radius:var(--sk2)}
.rs-cta:hover{box-shadow:4px 4px 0 var(--ink);transform:translate(-1px,-1px)}
.rs-cta::after{content:attr(data-sub);font-size:11.5px;font-weight:normal;color:var(--graphite)}
.rs-cta[data-sub=""]::after{display:none}
.rs-cta:disabled{background:var(--white) var(--hatch);box-shadow:none}
.rs-cta:disabled svg{opacity:.55}
.rs-foot-meta{display:flex;justify-content:flex-end;margin-top:6px}
.rs-textbtn{border:none;background:none;color:var(--ink);font-weight:bold;font-size:12.5px;text-decoration:underline;text-underline-offset:3px;cursor:pointer;padding:6px 8px;min-height:36px;border-radius:8px;white-space:nowrap}
.rs-textbtn:hover{background:var(--paper)}
.rs-textbtn:disabled{color:var(--steel);cursor:default;background:none}
/* ---- callouts ---- */
.rs-callout{display:flex;gap:10px;align-items:flex-start;border:2px solid var(--ink);border-radius:var(--sk2);padding:9px 12px;font-size:12.5px;line-height:1.5;margin:10px 0;background:var(--paper)}
.rs-callout svg{flex:none;margin-top:1px}
.rs-callout.ok{border-radius:var(--sk)}
.rs-callout.bad{background:var(--white);border-width:2.5px}
.rs-callout b{font-weight:bold}
.rs-callout-h{font-weight:bold;font-size:13.5px;margin-bottom:2px}
.rs-fivehint{margin:0 0 12px}
.rs-fivehint.rs-hint-ok{display:flex;gap:8px;align-items:center;font-size:12px;font-weight:bold}
.rs-heads{display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;margin:6px 0 4px}
.rs-head{display:flex;align-items:center;gap:6px;font-size:11.5px}
.rs-head.on{font-weight:bold}
.rs-head.off{color:var(--graphite)}
.rs-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* ---- import ---- */
.rs-dropzone{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;box-sizing:border-box;border:2.5px dashed var(--ink);border-radius:255px 18px 225px 18px/18px 225px 18px 255px;
  padding:20px 16px 18px;text-align:center;cursor:pointer;background:var(--paper) var(--hatch);transition:background var(--rs-dur)}
.rs-dropzone:hover{background-color:var(--white)}
.rs-dropzone.over{border-style:solid;background:var(--mist)}
.rs-dz-title{font-weight:bold;font-size:14.5px}
.rs-dz-sub{font-size:12.5px;text-decoration:underline;text-underline-offset:3px}
.rs-pills{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:14px 0 4px}
.rs-pill{font-size:11.5px;font-weight:bold;padding:3px 10px;background:var(--mist);border:2px solid var(--ink);border-radius:var(--sk)}
.rs-pill:nth-child(even){border-radius:var(--sk2)}
.rs-detected{display:block;font-size:11.5px;line-height:2.1;margin:-4px 0 10px}
.rs-detected b{font-weight:bold}
.rs-detected .rs-pill{display:inline;font-size:11.5px;padding:2px 9px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.rs-diff{border:2px solid var(--ink);border-radius:var(--sk);padding:8px 12px;margin-bottom:8px;background:var(--white)}
.rs-diff:nth-of-type(even){border-radius:var(--sk2)}
.rs-diff.rs-same{border-style:dashed;border-color:var(--steel);background:var(--paper)}
.rs-diff-h{display:flex;align-items:center;gap:8px}
.rs-diff-dot{font-weight:bold;width:14px;flex:none}
.rs-diff-name{flex:1;font-weight:bold;font-size:13px}
.rs-same .rs-diff-name{color:var(--graphite)}
.rs-diff-n{margin-left:auto;font-size:12px;display:flex;gap:4px;align-items:center;flex:none}
.rs-same .rs-diff-n{color:var(--graphite)}
.rs-plus{font-weight:bold;background:var(--mist);border-radius:6px;padding:1px 6px}
.rs-minus{color:var(--graphite);text-decoration:line-through;padding:1px 4px}
.rs-diff-note{font-size:11.5px;color:var(--graphite);margin:4px 0 0 22px}
.rs-view-changes{border:none;background:none;padding:2px 0 0 22px;font-size:11.5px;font-weight:bold;color:var(--ink);text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.rs-diff-pre{margin:6px 0 2px;background:var(--paper);border:2px solid var(--ink);border-radius:var(--sk2);padding:7px 9px;font-size:11px;line-height:1.7;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.rs-dl-add{background:var(--mist);font-weight:bold;padding:0 3px}
.rs-dl-del{color:var(--graphite);text-decoration:line-through}
.rs-dl-more{color:var(--steel)}
.rs-notes{margin:10px 0 2px;display:flex;flex-direction:column;gap:6px}
.rs-notes .rs-callout{margin:0}
.rs-line{display:flex;align-items:center;gap:10px;padding:8px 2px;border-bottom:2px dotted var(--ash)}
.rs-line:last-of-type{border-bottom:none}
.rs-line-dot{width:20px;height:20px;flex:none;display:grid;place-items:center;font-size:11px;font-weight:bold;border-radius:50%;box-sizing:border-box}
.rs-line-dot.ok{background:var(--ink);color:var(--white)}
.rs-line-dot.bad{border:2px solid var(--ink);background:var(--white)}
.rs-line-dot.warn{border:2px solid var(--ink);background:var(--white)}
.rs-line-dot.skip{border:2px dashed var(--steel);color:var(--graphite)}
.rs-line-dot.bullet{width:10px;height:10px;background:var(--ink)}
.rs-line-dot.bullet.alt{background:var(--white);border:2px solid var(--ink)}
.rs-line-body{flex:1;min-width:0}
.rs-line-label{font-weight:bold;font-size:13px}
.rs-line-meta{color:var(--steel);font-size:11.5px;text-align:right;max-width:58%;line-height:1.4}
.rs-line-sub{font-size:11.5px;color:var(--graphite);line-height:1.45}
.rs-line.skip .rs-line-label{color:var(--graphite)}
.rs-donehead{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.rs-donehead-t{font-size:15px;font-weight:bold;line-height:1.25}
.rs-donehead-s{font-size:11.5px;color:var(--graphite)}
.rs-choices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:4px 0 0;border:none;padding:0}
.rs-choice{display:flex;align-items:center;gap:8px;font-size:12px;padding:7px 10px;min-height:40px;box-sizing:border-box;border:2px solid var(--ink);border-radius:var(--sk);background:var(--white);cursor:pointer}
.rs-choice:nth-child(even){border-radius:var(--sk2)}
.rs-choice input{accent-color:var(--ink);margin:0;width:15px;height:15px;flex:none}
.rs-choice:has(input:checked){background:var(--mist);font-weight:bold}
/* ---- find ---- */
.rs-field{margin:0 0 12px}
.rs-flabel{display:block;font-size:11.5px;font-weight:bold;margin:0 0 5px 4px}
.rs-input{width:100%;box-sizing:border-box;padding:11px 12px;border:2px solid var(--ink);border-radius:var(--sk);background:var(--white);color:var(--ink);font-size:13px;outline:none}
.rs-input::placeholder{color:var(--steel)}
.rs-input:focus{box-shadow:0 0 0 3px var(--ash)}
.rs-input:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.rs-toast.rs-toast-info{box-shadow:3px 3px 0 var(--steel)}
.rs-inline-toast{margin:0 0 10px!important}
.rs-cta-l{display:block}
@media (max-width:440px){.rs-cta-l{min-height:2.6em;display:flex;align-items:center;justify-content:center}
  .rs-phead:has(.rs-links:not([hidden])) .rs-trust-t{display:none}}
.rs-field:nth-of-type(even) .rs-input{border-radius:var(--sk2)}
.rs-findrow{position:relative}
.rs-findrow .rs-input{padding-right:112px}
.rs-findnav{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:2px}
.rs-iconbtn{width:30px;height:30px;border:none;background:transparent;border-radius:8px;cursor:pointer;color:var(--ink);display:grid;place-items:center}
.rs-iconbtn:hover{background:var(--mist)}
.rs-iconbtn:disabled{opacity:.35;cursor:default;background:transparent}
.rs-counter{min-width:40px;text-align:right;padding-right:4px;font-size:11.5px;color:var(--graphite);font-variant-numeric:tabular-nums}
.rs-opts{display:flex;gap:8px;margin:0 0 4px;flex-wrap:wrap}
.rs-check{display:inline-flex;align-items:center;gap:7px;font-size:12px;cursor:pointer;border:2px solid var(--ink);border-radius:var(--sk);padding:5px 12px 5px 9px;user-select:none;background:var(--white)}
.rs-check:nth-child(even){border-radius:var(--sk2)}
.rs-check input{accent-color:var(--ink);width:15px;height:15px;margin:0}
.rs-check:has(input:checked){background:var(--mist)}
.rs-result{font-size:13px}
.rs-result-h{font-weight:bold;margin:14px 0 2px;font-size:13px}
.rs-result-h .rs-hl{background:var(--mist);padding:1px 5px;border-radius:4px}
.rs-result-empty{color:var(--graphite);margin:12px 0 0;font-size:12.5px}
/* ---- toasts ---- */
.rs-toasts{position:fixed;right:22px;bottom:84px;max-width:calc(100vw - 44px);z-index:2147483647;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.rs-toast{display:flex;align-items:center;gap:9px;line-height:1.4;background:var(--white);border:2px solid var(--ink);border-radius:var(--sk2);
  padding:8px 13px;box-shadow:3px 3px 0 var(--ink);font-size:12px;font-weight:bold;color:var(--ink);animation:rs-toast-in .3s var(--rs-ease)}
@keyframes rs-toast-in{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}
.rs-tic{width:20px;height:20px;flex:none;display:block}
.rs-undo{margin-left:4px;cursor:pointer;font-weight:bold;text-decoration:underline}
/* ---- a11y + small windows ---- */
.rs-launcher:focus-visible,.rs-x:focus-visible,.rs-tab:focus-visible,.rs-btn:focus-visible,.rs-textbtn:focus-visible,.rs-iconbtn:focus-visible,
.rs-dropzone:focus-visible,.rs-view-changes:focus-visible,.rs-linkic:focus-visible,.rs-check:focus-within,.rs-choice:focus-within{outline:2px solid var(--ink);outline-offset:2px}
.rs-tab:focus-visible{outline-offset:-2px}
@media (max-height:620px){.rs-trust-t{display:none}.rs-cta{min-height:96px}.rs-cta svg{width:44px;height:34px}}
@media (prefers-reduced-motion:reduce){:host *,:host *::before,:host *::after{animation:none!important;transition:none!important}}
`;

  var UI = { host: null, root: null, launcher: null, card: null, badge: null, links: null };
  // ---- UI 2.0 icons (inline SVG strings; greyscale, hand-drawn feel) ----
  var IC = {
    star: '<svg class="rs-star" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 1l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" fill="#ececec" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    lock: '<svg width="12" height="14" viewBox="0 0 14 16" aria-hidden="true"><path d="M2 7h10l-.5 7.5h-9z" fill="#ececec" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/><path d="M4 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="#1a1a1a" stroke-width="1.5"/></svg>',
    x: '<svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 3c4 4 8 9 12 12M15 3C11 7 7 11 3 15" stroke="#1a1a1a" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>',
    squig: '<svg class="rs-squig" viewBox="0 0 80 8" preserveAspectRatio="none" aria-hidden="true"><path d="M2 5c8-4 14 3 22 0s14-4 22 0 14 3 22 0 8-2 10-1" stroke="#1a1a1a" stroke-width="3" fill="none" stroke-linecap="round"/></svg>',
    tick: '<svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true"><path d="M13 2c7 0 11 5 11 11s-5 11-11 11S2 19 2 13 7 2 14 2" fill="#1a1a1a"/><path d="M7.5 13l4 4 7-8.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bang: '<svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true"><path d="M13 2c7 0 11 5 11 11s-5 11-11 11S2 19 2 13 7 2 14 2" fill="#fff" stroke="#1a1a1a" stroke-width="1.8"/><path d="M13 7.5v7M13 18v.5" stroke="#1a1a1a" stroke-width="2.4" stroke-linecap="round"/></svg>',
    warn: '<svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2l9 17H2z" fill="#fff" stroke="#1a1a1a" stroke-width="1.6" stroke-linejoin="round"/><path d="M11 8v5M11 16v.5" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2c5 0 9 4 9 9s-4 9-9 9-9-4-9-9 4-9 10-9" fill="#fff" stroke="#1a1a1a" stroke-width="1.6"/><path d="M11 10v6M11 6.5v.5" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/></svg>',
    shield: '<svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V5z" fill="#ececec" stroke="#1a1a1a" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    err: '<svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true"><path d="M13 2c7 0 11 5 11 11s-5 11-11 11S2 19 2 13 7 2 14 2" fill="#1a1a1a"/><path d="M9 9l8 8M17 9l-8 8" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
    note: '<svg width="30" height="30" viewBox="0 0 34 34" aria-hidden="true"><path d="M6 8c1-3 20-4 22-1s1 18-2 20-18 2-20-1-1-15 0-18z" fill="#ececec" stroke="#1a1a1a" stroke-width="1.8"/><path d="M11 14h12M11 19h9" stroke="#1a1a1a" stroke-width="1.8" stroke-linecap="round"/></svg>',
    five: '<svg width="58" height="46" viewBox="0 0 58 46" aria-hidden="true"><g fill="#fff" stroke="#1a1a1a" stroke-width="1.8"><rect x="4" y="2" width="26" height="32" rx="2" transform="rotate(-6 17 18)"/><rect x="10" y="4" width="26" height="32" rx="2" transform="rotate(-3 23 20)"/><rect x="16" y="6" width="26" height="32" rx="2"/><rect x="22" y="8" width="26" height="32" rx="2" transform="rotate(3 35 24)"/><rect x="28" y="10" width="26" height="32" rx="2" transform="rotate(5 41 26)"/></g><path d="M33 18h14M33 23h12M33 28h9" stroke="#1a1a1a" stroke-width="1.6" stroke-linecap="round" transform="rotate(5 41 26)"/></svg>',
    two: '<svg width="58" height="46" viewBox="0 0 58 46" aria-hidden="true"><g fill="#fff" stroke="#1a1a1a" stroke-width="1.8"><rect x="12" y="4" width="26" height="32" rx="2" transform="rotate(-5 25 20)"/><rect x="22" y="8" width="26" height="32" rx="2" transform="rotate(4 35 24)"/></g><path d="M27 16h15M27 21h13M27 26h15M27 31h8" stroke="#1a1a1a" stroke-width="1.6" stroke-linecap="round" transform="rotate(4 35 24)"/></svg>',
    tray: '<svg width="96" height="72" viewBox="0 0 96 72" aria-hidden="true"><path d="M30 6c1-2 30-3 32 0s2 34 0 36-30 2-32 0-1-34 0-36z" fill="#fff" stroke="#1a1a1a" stroke-width="2"/><path d="M37 16h18M37 22h14M37 28h17" stroke="#1a1a1a" stroke-width="1.8" stroke-linecap="round"/><path d="M8 40l8 26h64l8-26" fill="#ececec" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/><path d="M8 40h22c1 6 4 9 18 9s17-3 18-9h22" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/><path d="M78 6v20M71 13l7-7 7 7" fill="none" stroke="#1a1a1a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    done: '<svg width="42" height="42" viewBox="0 0 44 44" aria-hidden="true"><path d="M22 6c9 0 16 7 16 16s-7 16-16 16S6 31 6 22 13 6 23 6" fill="#1a1a1a"/><path d="M14 22l6 6 11-12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 1v3M40 8l-2 2M43 22h-3M4 8l2 2M1 22h3" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/></svg>',
    undo: '<svg width="16" height="15" viewBox="0 0 18 16" aria-hidden="true"><path d="M6 2L2 6l4 4M2 6h9a5 5 0 0 1 0 10H8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    dl: '<svg width="14" height="16" viewBox="0 0 16 18" aria-hidden="true"><path d="M8 2v10M4 8l4 4 4-4M2 16h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    up: '<svg width="13" height="9" viewBox="0 0 14 10" aria-hidden="true"><path d="M2 8l5-6 5 6" fill="none" stroke="#1a1a1a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg width="13" height="9" viewBox="0 0 14 10" aria-hidden="true"><path d="M2 2l5 6 5-6" fill="none" stroke="#1a1a1a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    hx: '<svg width="11" height="11" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="#1a1a1a" stroke-width="2.2" stroke-linecap="round"/></svg>',
    hok: '<svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7.5l3.5 3.5L12 3" fill="none" stroke="#1a1a1a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    // Author links — official LinkedIn / GitHub / Figma marks (Simple Icons, CC0), in greyscale.
    li: '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="#1a1a1a" d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>',
    gh: '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="#1a1a1a" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
    fg: '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="#1a1a1a" d="M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z"/></svg>'
  };
  var AUTHOR_LINKS = [
    { href: "https://www.linkedin.com/in/rbsavla/", name: "LinkedIn", ic: "li" },
    { href: "https://github.com/rbsavla24", name: "GitHub", ic: "gh" },
    { href: "https://www.figma.com/proto/rbg9lBuYizIhEdBllsHOvu/Demo-FoS-app", name: "Figma", ic: "fg" }
  ];
  // Author links show after an action that changes or saves something finishes,
  // and hide the moment the next such action starts. Reset only on page reload.
  var _linksOn = false;
  function setLinks(on) {
    _linksOn = !!on;
    if (UI.links) UI.links.hidden = !_linksOn;
  }
  function svgEl(markup) { var t = document.createElement("span"); t.innerHTML = markup; return t.firstChild; }


  var panel = null;        // the scrollable content body of the current panel
  var currentTab = null;

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function reduceMotion() {
    try { return !!(window.matchMedia && matchMedia("(prefers-reduced-motion:reduce)").matches); }
    catch (e) { return false; }
  }

  function ensureHost() {
    if (UI.root) return UI.root;
    var host = document.createElement("div");
    host.id = "ringg-studio-host";
    try { host.style.all = "initial"; } catch (e) {}
    var root = host.attachShadow({ mode: "open" });
    var st = document.createElement("style");
    st.textContent = RS_CSS;
    root.appendChild(st);
    document.body.appendChild(host);
    UI.host = host; UI.root = root;
    return root;
  }

  // Launcher pill (formerly the FAB).
  // The launcher tucks itself into the right wall after a spell of inactivity,
  // leaving a small pulsing sliver. Clicking the sliver slides the full pill out.
  var _tuckTimer = null;
  var TUCK_MS = 7000;
  function tuckLauncher() {
    if (UI.launcher && !UI.card) UI.launcher.classList.add("rs-tucked");
  }
  function untuckLauncher() {
    if (UI.launcher) UI.launcher.classList.remove("rs-tucked");
  }
  function resetTuckTimer() {
    clearTimeout(_tuckTimer);
    _tuckTimer = setTimeout(tuckLauncher, TUCK_MS);
  }

  function ensureUI() {
    var root = ensureHost();
    if (UI.launcher) return;
    var b = el("button", "rs-launcher");
    b.innerHTML = IC.star + '<span class="rs-badge"></span>';
    b.title = "PromptPort";
    b.setAttribute("aria-label", "PromptPort");
    b.setAttribute("aria-expanded", "false");
    UI.badge = b.querySelector(".rs-badge");
    b.addEventListener("click", function (e) {
      // First click on the tucked sliver just slides the full pill out.
      if (b.classList.contains("rs-tucked")) { untuckLauncher(); resetTuckTimer(); return; }
      if (UI.card) closePanel(e.detail === 0);
      else {
        openPanel();
        if (e.detail === 0) setTimeout(function () { var a = UI.root.querySelector(".rs-tab.active"); if (a) a.focus(); }, 0);
      }
      resetTuckTimer();
    });
    // Hovering the sliver peeks it out and keeps it awake.
    b.addEventListener("mouseenter", function () { resetTuckTimer(); });
    root.appendChild(b);
    UI.launcher = b;
    resetTuckTimer(); // start the 7s countdown; it tucks if left idle
  }

  function updateBadge(n, total) {
    if (UI.badge && total != null) { UI.badge.textContent = n + "/" + total; UI.badge.title = n + " of " + total + " sections read"; }
  }

  // Build the panel shell (header row + tabs) and return its scrollable body.
  // Header row: lock + "runs in your browser" · author links (after an action
  // finishes) · close. No product name or logo.
  function shell(active) {
    var root = ensureHost();
    if (UI.card && UI.card.parentNode) UI.card.parentNode.removeChild(UI.card);
    var card = el("div", "rs-panel rs-enter"); UI.card = card;
    card.setAttribute("role", "dialog"); card.setAttribute("aria-label", "PromptPort");
    if (UI.launcher) UI.launcher.setAttribute("aria-expanded", "true");

    var top = el("div", "rs-top");
    var head = el("div", "rs-phead");
    var trust = el("div", "rs-trust");
    trust.innerHTML = IC.lock + '<span class="rs-trust-t">runs in your browser</span>';
    trust.title = "Runs in your browser — nothing is sent anywhere";
    head.appendChild(trust);

    var nav = el("nav", "rs-links"); nav.setAttribute("aria-label", "Author links");
    AUTHOR_LINKS.forEach(function (L) {
      var a = el("a", "rs-linkic"); a.href = L.href; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.title = L.name; a.setAttribute("aria-label", L.name + " (opens in a new tab)");
      a.innerHTML = IC[L.ic];
      nav.appendChild(a);
    });
    nav.hidden = !_linksOn; UI.links = nav;
    head.appendChild(nav);

    var x = el("button", "rs-x"); x.innerHTML = IC.x; x.title = "Close"; x.setAttribute("aria-label", "Close");
    x.addEventListener("click", closePanel); head.appendChild(x);

    var tabs = el("div", "rs-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Sections");
    var TABS = [["export", "Export", openPanel], ["import", "Import", renderImportHome], ["find", "Find", renderFindReplace]];
    function activate(i, kb) {
      UI._kbTab = !!kb;
      TABS[i][2]();
      if (kb) setTimeout(function () { var a = UI.root && UI.root.querySelector(".rs-tab.active"); if (a) a.focus(); }, 0);
      if (kb) setTimeout(function () { UI._kbTab = false; }, 120);
      else UI._kbTab = false;
    }
    TABS.forEach(function (t, i) {
        var on = t[0] === active;
        var b = el("button", "rs-tab" + (on ? " active" : ""), t[1]);
        b.id = "rs-tab-" + t[0];
        b.setAttribute("role", "tab"); b.setAttribute("aria-selected", on ? "true" : "false");
        b.setAttribute("aria-controls", "rs-tabpanel"); b.tabIndex = on ? 0 : -1;
        b.insertAdjacentHTML("beforeend", IC.squig);
        b.addEventListener("click", function (e) { activate(i, e.detail === 0); });
        b.addEventListener("keydown", function (e) {
          var n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
          if (n == null) return;
          e.preventDefault();
          activate((n + TABS.length) % TABS.length, true);
        });
        tabs.appendChild(b);
      });

    top.appendChild(head); top.appendChild(tabs);
    var body = el("div", "rs-body"); panel = body;
    body.id = "rs-tabpanel"; body.setAttribute("role", "tabpanel"); body.setAttribute("aria-labelledby", "rs-tab-" + active);
    var foot = el("div", "rs-foot"); UI.foot = foot;   // sticky actions (hidden when empty)
    // Escape closes the panel and returns focus to the launcher.
    card.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePanel(true); }
    });
    card.appendChild(top); card.appendChild(body); card.appendChild(foot);
    root.appendChild(card);
    currentTab = active;
    return body;
  }

  function clearBody() {
    if (panel) panel.innerHTML = "";
    if (UI.foot) {
      var keep = UI.foot.querySelector(".rs-inline-toast");   // a message still on screen survives a repaint
      UI.foot.innerHTML = "";
      if (keep) UI.foot.appendChild(keep);
    }
    return panel;
  }
  function footer() { return UI.foot || panel; }

  function closePanel(returnFocus) {
    var hadFocus = !!(UI.card && UI.root && UI.root.activeElement && UI.card.contains(UI.root.activeElement));
    if (UI.card && UI.card.parentNode) UI.card.parentNode.removeChild(UI.card);
    UI.card = null; panel = null; currentTab = null; UI.links = null;
    if (UI.launcher) UI.launcher.setAttribute("aria-expanded", "false");
    if ((returnFocus === true || hadFocus) && UI.launcher) { try { UI.launcher.focus(); } catch (e) {} }
    resetTuckTimer(); // panel closed → begin the idle countdown to tuck away
  }

  // Animated count-up for the character totals.
  function countUp(elm) {
    var target = +(elm.getAttribute("data-n") || 0);
    if (reduceMotion()) { elm.textContent = target.toLocaleString(); return; }
    var start = null, dur = 560;
    function step(ts) {
      if (start == null) start = ts;
      var p = Math.min(1, (ts - start) / dur), e = 1 - Math.pow(1 - p, 3);
      elm.textContent = Math.round(target * e).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    // Fallback: rAF is paused in background tabs, so guarantee the final value.
    setTimeout(function () { elm.textContent = target.toLocaleString(); }, dur + 140);
  }

  // Non-blocking toast, optional Undo callback.
  function toastKind(msg) { return /^(Couldn't|Can't|No |Nothing|Already|Clicked Save)| 0 fields /.test(String(msg)) ? "info" : "ok"; }
  function toast(msg, undoFn, kind) {
    kind = kind || toastKind(msg);
    var root = ensureHost();
    var wrap = root.querySelector(".rs-toasts");
    if (!wrap) { wrap = el("div", "rs-toasts"); wrap.setAttribute("role", "status"); wrap.setAttribute("aria-live", "polite"); root.appendChild(wrap); }
    // One message at a time — a new one replaces the last, so they never stack up over the panel.
    wrap.innerHTML = "";
    [].slice.call(root.querySelectorAll(".rs-inline-toast")).forEach(function (x) { x.remove(); });
    var room = placeToasts(wrap);
    if (!room && UI.card && UI.foot) {
      // Narrow window with the panel open: show it inside the panel's footer instead.
      var c = callout(kind === "info" ? "warn" : "ok", null, msg);
      c.classList.add("rs-inline-toast"); c.setAttribute("role", "status");
      UI.foot.insertBefore(c, UI.foot.firstChild);
      setTimeout(function () { try { c.remove(); } catch (e) {} }, 3600);
      return;
    }
    var t = el("div", "rs-toast" + (kind === "info" ? " rs-toast-info" : ""));
    t.innerHTML = (kind === "info" ? IC.bang : IC.tick).replace('width="24" height="24"', 'class="rs-tic"');
    t.appendChild(el("span", null, msg));
    if (undoFn) {
      var u = el("span", "rs-undo", "Undo");
      u.addEventListener("click", function () { try { t.remove(); } catch (e) {} undoFn(); });
      t.appendChild(u);
    }
    wrap.appendChild(t);
    // Safety net: if it would still touch the open panel, show it inside the panel instead.
    try {
      if (UI.card && UI.foot) {
        var a = t.getBoundingClientRect(), b = UI.card.getBoundingClientRect();
        if (!(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)) {
          wrap.innerHTML = "";
          var c2 = callout(kind === "info" ? "warn" : "ok", null, msg);
          c2.classList.add("rs-inline-toast"); c2.setAttribute("role", "status");
          UI.foot.insertBefore(c2, UI.foot.firstChild);
          setTimeout(function () { try { c2.remove(); } catch (e) {} }, 3600);
          return;
        }
      }
    } catch (e) {}
    setTimeout(function () {
      t.style.transition = "opacity .3s,transform .3s";
      t.style.opacity = "0"; t.style.transform = "translateX(20px)";
      setTimeout(function () { try { t.remove(); } catch (e) {} }, 320);
    }, 3600);
  }

  // Toasts sit to the LEFT of the launcher pill, bottom-aligned with it, so they
  // never cover the panel's action buttons. On a very narrow window they fall
  // back to the top-right corner.
  // Returns true when there's room beside the launcher (bottom-aligned with it,
  // below the panel); false means "show it somewhere else".
  function placeToasts(wrap) {
    try {
      var L = UI.launcher && UI.launcher.getBoundingClientRect();
      var W = window.innerWidth, Hh = window.innerHeight;
      if (L && L.width && L.left - 22 >= 300) {
        wrap.style.right = Math.round(W - L.left + 10) + "px";
        wrap.style.bottom = Math.round(Hh - L.bottom) + "px";
        wrap.style.top = "auto";
        wrap.style.maxWidth = Math.min(420, Math.round(L.left - 22)) + "px";
        return true;
      }
      if (!UI.card && L && L.width) {
        // Panel closed on a narrow window: just above the launcher.
        wrap.style.right = "16px"; wrap.style.top = "auto";
        wrap.style.bottom = Math.round(Hh - L.top + 10) + "px";
        wrap.style.maxWidth = "calc(100vw - 32px)";
        return true;
      }
      return false;
    } catch (e) { return true; }
  }

  // Open a file picker that accepts BOTH .zip and .md, routing by extension.
  function openAnyImportPicker() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,.md,.markdown,.txt,application/zip,text/markdown,text/plain";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      try { document.body.removeChild(input); } catch (e) {}
      handleImportFile(f);
    });
    input.click();
  }

  // Import tab home: ONE affordance — a click-or-drop zone for .zip or .md.
  function renderImportHome() {
    ++opGen; // supersede any in-flight Export collect so it can't re-render over this tab
    if (_pendingResults) { var pr = _pendingResults; _pendingResults = null; renderImportResults(pr.results, pr.opts); return; }
    var body = shell("import");
    var dz = el("button", "rs-dropzone");
    dz.type = "button";
    dz.setAttribute("aria-label", "Choose a .zip or .md file to import");
    dz.innerHTML = IC.tray + '<span class="rs-dz-title">Drop a .zip or .md here</span>' +
      '<span class="rs-dz-sub">or click to choose a file</span>';
    dz.addEventListener("click", openAnyImportPicker);
    dz.addEventListener("dragover", function (e) { e.preventDefault(); dz.classList.add("over"); });
    dz.addEventListener("dragleave", function () { dz.classList.remove("over"); });
    dz.addEventListener("drop", function (e) {
      e.preventDefault(); dz.classList.remove("over");
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleImportFile(f);
    });
    body.appendChild(dz);
    var pills = el("div", "rs-pills");
    ["5-bucket ZIP", "2-bucket ZIP", "single .md"].forEach(function (t) { pills.appendChild(el("span", "rs-pill", t)); });
    body.appendChild(pills);
    body.appendChild(callout("info", null,
      (isGorezolv()
        ? "A 5-bucket ZIP is combined into Main Prompt under # headings; a 2-bucket ZIP goes in as is."
        : "A 2-bucket ZIP's Main Prompt is split into the 4 buckets by its # headings; a 5-bucket ZIP goes in file by file.") +
      " You'll see every change and confirm before anything is overwritten."));
    // The last import can still be undone after leaving its results screen.
    if (_lastBackup && !_lastBackup.undone && _lastBackup.importedKeys && _lastBackup.importedKeys.length) {
      appendBackupActions(footer(), "Last import " + friendlyTime(_lastBackup.when).replace(/^at /, "at ") +
        " can still be undone — " + backupWhat() + " as they were just before it.");
    }
  }

  // Greyscale callout: kind = info | warn | ok | bad; head optional.
  function callout(kind, head, text) {
    var c = el("div", "rs-callout" + (kind === "ok" ? " ok" : kind === "bad" ? " bad" : ""));
    c.insertAdjacentHTML("afterbegin", kind === "ok" ? IC.shield : kind === "warn" ? IC.warn : kind === "bad" ? IC.err.replace(/width="24" height="24"/, 'width="20" height="20"') : IC.info);
    var t = el("div");
    if (head) t.appendChild(el("div", "rs-callout-h", head));
    if (text != null) t.appendChild(typeof text === "string" ? document.createTextNode(text) : text);
    c.appendChild(t);
    return c;
  }

  // Route a dropped/picked file by extension, reusing the existing pipelines.
  var MAX_IMPORT_BYTES = 20 * 1024 * 1024;
  function handleImportFile(file) {
    if (!file) return;
    ++opGen;
    setLinks(false);   // a new activity started
    if (file.size > MAX_IMPORT_BYTES) {
      renderImportPlan({ error: "“" + file.name + "” is " + Math.round(file.size / 1048576) + " MB — too large to import (the limit is 20 MB). Prompt files are usually well under 1 MB." }, null);
      return;
    }
    var name = (file.name || "").toLowerCase();
    if (/\.zip$/.test(name)) {
      file.arrayBuffer().then(readZipSource).then(beginImport)
        .catch(function (err) { renderImportPlan({ error: (err && err.message) || "Could not read the zip." }, null); });
    } else {
      var rd = file.text ? file.text() : new Promise(function (res, rej) {
        var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsText(file);
      });
      Promise.resolve(rd).then(function (txt) {
        if (!txt || !txt.trim()) { renderImportPlan({ error: "That file was empty." }, null); return; }
        beginImport(sourceFromMd(txt, file.name));
      }).catch(function () { renderImportPlan({ error: "Couldn't read the file." }, null); });
    }
  }

    // Opening the plugin lands on the Export tab in an IDLE state — it does NOT
    // read/refresh the page. This keeps opening instant and lets you jump to
    // Import or Find without waiting. The 3-pass collect runs only when you click
    // Download ZIP (or the manual ↻).
    function openPanel() {
    untuckLauncher();   // opening the panel always brings the launcher fully out
    clearTimeout(_tuckTimer);   // don't tuck while the panel is open
    ++opGen;            // cancel any in-flight collect from a previous view
    renderPanel(null, { idle: true });
  }

  // The heavy part: collect the 5 buckets from the page in 3 passes (the first
  // pass may land before every bucket has rendered), then either just preview the
  // counts (thenDownloadFormat falsy / manual ↻), or download — "five" = the 5
  // .md files, "two" = First Message + collated Main Prompt.
  var _exportBusy = false;
  var _lastDl = null;         // "5-bucket ZIP downloaded." after a download, until the next activity   // a download is being prepared — ignore repeat clicks
  function refreshExport(thenDownloadFormat) {
    if (thenDownloadFormat && _exportBusy) { toast("Already preparing a download…"); return; }
    untuckLauncher();
    clearTimeout(_tuckTimer);
    askInterceptorForLatest();
    var myGen = ++opGen;
    // Ringg needs 3 passes (buckets render late / start collapsed); the Rezolv
    // panel's two fields are always on screen, so one pass is enough.
    var PASSES = isGorezolv() ? 1 : 3;
    if (thenDownloadFormat) _exportBusy = true;
    _lastDl = null; setLinks(false);   // a new activity started
    // Repaint only while the panel is open: closing it mid-way lets the read
    // (and a requested download) finish quietly instead of reopening the panel.
    function paint(secs, o) { if (UI.card && currentTab === "export") renderPanel(secs, o); }
    paint(null, { downloadEnabled: false, status: "Reading the page… (1 of " + PASSES + ")" });
    // If the user switches tabs mid-way, a preview is abandoned, but a requested
    // DOWNLOAD still completes (just without repainting a view they left).
    function live() { return myGen === opGen; }
    (async function () {
      var sections = null;
      for (var k = 1; k <= PASSES; k++) {
        if (!live() && !thenDownloadFormat) return;
        sections = await runExclusive(collectSections);
        if (!live()) { if (!thenDownloadFormat) return; continue; }
        if (k < PASSES) {
          paint(sections, { downloadEnabled: false, status: "Reading the page… (" + (k + 1) + " of " + PASSES + ")" });
        } else {
          paint(sections, { downloadEnabled: true });
        }
      }
      if (thenDownloadFormat && doDownload(thenDownloadFormat, sections) && live()) {
        paint(sections, { downloadEnabled: true, noAnim: true });
      }
    })().catch(function () {
      if (live()) paint(fallbackSections(), { downloadEnabled: true });
    }).then(function () {
      if (thenDownloadFormat) _exportBusy = false;
    });
  }


  function renderPanel(sections, opts) {
    opts = opts || {};
    var idle = !!opts.idle;
    var loading = !sections && !idle;
    var gz = isGorezolv();
    var baseSecs = gz
      ? [{ title: "First Message" }, { title: "Main Prompt" }]
      : window.RinggExtract.SECTIONS;
    var secList = sections || baseSecs.map(function (s) {
      return { title: s.title, text: "", source: "none" };
    });
    var reuse = UI.card && currentTab === "export";
    var body = reuse ? clearBody() : shell("export");
    currentTab = "export";

    var anyFound = false, ready = 0;
    // Idle (just opened): show NO bucket rows. They appear only after the page
    // is read (a download or Refresh preview).
    if (!idle) secList.forEach(function (s) {
      var ok = !!(s.text && s.text.trim());
      if (ok) { anyFound = true; ready++; }
      var card = el("div", "rs-card");
      if (loading) {
        card.className = "rs-card rs-loading";
        card.innerHTML = '<div class="rs-ic rs-sk" style="border-radius:50%"></div>' +
          '<div class="rs-grow"><div class="rs-sk rs-sk-line" style="width:56%"></div></div>' +
          '<div class="rs-sk rs-sk-line" style="width:64px"></div>';
      } else if (ok) {
        card.innerHTML = '<div class="rs-ic">' + IC.tick + '</div>' +
          '<div class="rs-grow rs-cname">' + esc(s.title) + '</div>' +
          '<div class="rs-cmeta"><span class="rs-count" data-n="' + s.text.trim().length + '">' +
          (opts.noAnim ? s.text.trim().length.toLocaleString() : "0") + '</span> chars</div>';
      } else {
        card.className = "rs-card rs-empty";
        card.innerHTML = '<div class="rs-ic">' + IC.bang + '</div>' +
          '<div class="rs-grow rs-cname">' + esc(s.title) + '</div>' +
          '<div class="rs-cmeta">' +
          (gz ? "empty on the page" : "empty — open this section on the page, then Refresh preview") + '</div>';
      }
      body.appendChild(card);
    });

    if (!loading && !idle) {
      if (!opts.noAnim) {
        var counts = body.querySelectorAll(".rs-count");
        for (var i = 0; i < counts.length; i++) countUp(counts[i]);
      }
      updateBadge(ready, secList.length);
    }

    var idleNote = gz
      ? "Reads First Message + Main Prompt from this page, then downloads them. Nothing on the page is changed."
      : "Reads the 5 sections from this page, then downloads them. Nothing on the page is changed.";
    var doneNote = "Read from the page just now — pick a format below.";
    if (idle && !_lastDl) {
      var intro = el("div", "rs-introw");
      intro.innerHTML = IC.note;
      intro.appendChild(el("p", null, idleNote));
      body.appendChild(intro);
    } else {
      var note = el("div", "rs-note rs-done-line");
      if (opts.status) note.textContent = opts.status;
      else if (loading) note.textContent = gz ? "Copying First Message and Main Prompt from the page…" : "Opening collapsed sections and copying from the page…";
      else if (idle) note.textContent = idleNote;
      else if (!anyFound) note.textContent = "Nothing found yet. Make sure the assistant page is loaded, then Refresh preview.";
      else if (_lastDl) { note.appendChild(el("b", null, _lastDl)); note.appendChild(document.createTextNode(" Read from the page just now — download again in either format.")); }
      else note.textContent = doneNote;
      if (loading || opts.status) note.setAttribute("aria-live", "polite");
      body.appendChild(note);
    }

    var enabled = idle || !!opts.downloadEnabled;

    // "Download 5 Buckets" on a 2-field page is only possible when Main Prompt
    // is organised under the # headings. Check the live editor (no copy).
    var five = { ok: true, reason: "" };
    if (gz && enabled) five = liveMainSplit();
    var FIVE_WHY = "5 Buckets needs Main Prompt organised under # Objective, # Response Guidelines, # Conversation Flow, # FAQs (in that order). ";

    // One of the two download CTAs: equal tiles side by side in the sticky
    // footer. The caption under each label (CSS ::after from data-sub) says what
    // the file holds, so the label (= textContent) stays short and stable.
    function mkDownloadBtn(label, sub, format, canUse, why, art) {
      var b = el("button", "rs-btn rs-cta");
      b.innerHTML = art;
      b.appendChild(el("span", "rs-cta-l", enabled ? label : "Preparing…"));
      b.setAttribute("data-sub", enabled ? sub : "");
      b.disabled = !enabled || !canUse;
      if (enabled && !canUse && why) { b.title = why; b.setAttribute("aria-describedby", "rs-fivehint"); }
      b.addEventListener("click", function () {
        if (b.disabled) return;
        // Always re-read the page right before downloading, so an edit made
        // after an earlier preview/download is never exported stale.
        refreshExport(format);
      });
      return b;
    }

    var foot = footer();
    if (gz && enabled) {
      var hint = buildFiveHint(five);
      UI.fiveHint = hint;
      body.insertBefore(hint, body.firstChild);
    } else {
      UI.fiveHint = null;
    }
    var ctas = el("div", "rs-ctas");
    var fiveBtn = mkDownloadBtn("Download 5 Buckets", gz ? (five.ok ? "split by # headings" : "needs # headings") : "5 .md files", "five", five.ok,
      five.ok ? "" : (FIVE_WHY + (five.reason || "")), IC.five);
    var twoBtn = mkDownloadBtn("Download 2 Buckets", gz ? "as on the page" : "First Message + Main Prompt", "two", true, "", IC.two);
    ctas.appendChild(fiveBtn); ctas.appendChild(twoBtn);
    foot.appendChild(ctas);
    // Remember the idle 5-bucket button so typing in Main Prompt can re-enable it.
    UI.fiveBtn = (gz && enabled) ? fiveBtn : null;

    var meta = el("div", "rs-foot-meta");
    var refresh = el("button", "rs-textbtn", "↻ Refresh preview");
    refresh.title = "Read the page again and show what was found, without downloading";
    refresh.disabled = !enabled;
    refresh.addEventListener("click", function () { refreshExport(null); });
    meta.appendChild(refresh);
    foot.appendChild(meta);
  }

  // The 2-field page's "5 Buckets" status, shown above the download buttons.
  var HEAD_LIST = [["objective", "# Objective"], ["response-guideline", "# Response Guidelines"],
    ["conversation-script", "# Conversation Flow"], ["faqs", "# FAQs"]];
  function fiveHintText(r) {
    return r.ok
      ? "✓ Main Prompt headings recognised — 5 Buckets is available."
      : "5 Buckets is off: " + (r.reason || "Main Prompt isn't organised under the # headings.");
  }
  function buildFiveHint(r) {
    var h = el("div");
    h.id = "rs-fivehint";
    h.setAttribute("data-five-hint", "1");
    fillFiveHint(h, r);
    return h;
  }
  function fillFiveHint(h, r) {
    h.innerHTML = "";
    if (r.ok) {
      h.className = "rs-fivehint rs-hint-ok";
      h.appendChild(document.createTextNode(fiveHintText(r)));
      return;
    }
    h.className = "rs-fivehint rs-callout";
    h.innerHTML = IC.warn;
    var t = el("div");
    t.appendChild(el("div", "rs-callout-h", fiveHintText(r)));
    var grid = el("div", "rs-heads");
    var present = r.present || [];
    HEAD_LIST.forEach(function (x) {
      var on = present.indexOf(x[0]) !== -1;
      var d = el("div", "rs-head " + (on ? "on" : "off"));
      d.innerHTML = on ? IC.hok : IC.hx;
      d.appendChild(document.createTextNode(x[1]));
      d.appendChild(el("span", "rs-sr", on ? " (found)" : " (missing)"));
      grid.appendChild(d);
    });
    t.appendChild(grid);
    t.appendChild(el("div", "rs-muted", "Expected in this order. It switches on by itself as you add them."));
    h.appendChild(t);
  }

  // While the idle Export view is open on the Rezolv panel, re-check Main Prompt
  // as the user edits it, so "Download 5 Buckets" turns on/off live.
  var _fiveRecheckT = null;
  document.addEventListener("input", function () {
    if (!isGorezolv() || !UI.card || currentTab !== "export" || !UI.fiveBtn) return;
    clearTimeout(_fiveRecheckT);
    _fiveRecheckT = setTimeout(function () {
      if (!UI.fiveBtn) return;
      var r = liveMainSplit();
      UI.fiveBtn.disabled = !r.ok;
      UI.fiveBtn.setAttribute("data-sub", r.ok ? "split by # headings" : "needs # headings");
      UI.fiveBtn.title = r.ok ? "" : ("5 Buckets needs Main Prompt organised under # Objective, # Response Guidelines, # Conversation Flow, # FAQs (in that order). " + (r.reason || ""));
      if (UI.fiveHint) fillFiveHint(UI.fiveHint, r);
    }, 250);
  }, true);

  function startImport() {
    openImportPicker(beginImport);
  }

  // ---- import panels ------------------------------------------------------
  function freshPanel(titleText) {
    var a = /find/i.test(titleText) ? "find" : (/import/i.test(titleText) ? "import" : "export");
    return shell(a);
  }

  // A list row. The status is carried by the icon's shape, not colour:
  // ✓ filled · ✕ outlined · ! outlined · — = ? dashed · • bullet.
  function lineRow(dotChar, dotColor, text, meta, sub) {
    var kind = { "✓": "ok", "✕": "bad", "!": "warn", "•": "bullet", "○": "bullet alt" }[dotChar] || "skip";
    var row = el("div", "rs-line" + (kind === "skip" ? " skip" : ""));
    var d = el("span", "rs-line-dot " + kind, kind.indexOf("bullet") === 0 ? "" : dotChar);
    d.setAttribute("aria-hidden", "true");
    row.appendChild(d);
    var body = el("div", "rs-line-body");
    body.appendChild(el("div", "rs-line-label", text));
    if (sub) body.appendChild(el("div", "rs-line-sub", sub));
    row.appendChild(body);
    if (meta) row.appendChild(el("span", "rs-line-meta", meta));
    return row;
  }

  // One field in the import review: counts + an expandable list of changed lines.
  function diffBlock(title, diff, same) {
    var wrap = el("div", "rs-diff" + (same ? " rs-same" : ""));
    var head = el("div", "rs-diff-h");
    head.appendChild(el("span", "rs-diff-dot", same ? "=" : "→"));
    head.appendChild(el("span", "rs-diff-name", title));
    var counts = el("span", "rs-diff-n");
    if (same) counts.textContent = "same as now — skipped";
    else if (!diff) counts.textContent = "will overwrite";
    else if (diff.skipped) counts.textContent = "very large — will overwrite";
    else {
      counts.appendChild(el("span", "rs-plus", "+" + diff.add));
      counts.appendChild(el("span", "rs-minus", "−" + diff.del));
    }
    head.appendChild(counts); wrap.appendChild(head);
    var changed = diff ? (diff.add + diff.del) : 0;
    if (!same && diff && !diff.coarse && changed > 0) {
      var toggle = el("button", "rs-view-changes", "See changes");
      toggle.type = "button"; toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "See changes in " + title);
      var pre = el("div", "rs-diff-pre"); pre.hidden = true;
      var shown = 0, cap = 60;
      for (var i = 0; i < diff.ops.length && shown < cap; i++) {
        var op = diff.ops[i]; if (op.t === " ") continue;
        pre.appendChild(el("div", op.t === "+" ? "rs-dl-add" : "rs-dl-del", (op.t === "+" ? "+ " : "− ") + op.v));
        shown++;
      }
      if (changed > cap) pre.appendChild(el("div", "rs-dl-more", "…and " + (changed - cap) + " more changed lines"));
      toggle.addEventListener("click", function () {
        pre.hidden = !pre.hidden;
        toggle.textContent = pre.hidden ? "See changes" : "Hide changes";
        toggle.setAttribute("aria-label", (pre.hidden ? "See changes in " : "Hide changes in ") + title);
        toggle.setAttribute("aria-expanded", pre.hidden ? "false" : "true");
      });
      wrap.appendChild(toggle); wrap.appendChild(pre);
    } else if (!same && diff && diff.coarse) {
      wrap.appendChild(el("div", "rs-diff-note", "large section — showing counts only"));
    }
    return wrap;
  }

  function renderImportPlan(plan, curMap, src, ropts) {
    freshPanel("Import — review");
    if (ropts && ropts.changed) {
      panel.appendChild(callout("warn", null, "The page changed after you opened this review, so the review was refreshed. Check it, then confirm again."));
    }
    if (plan && plan.error) {
      panel.appendChild(callout("bad", "We couldn't use that file", plan.error));
      addCloseRow();
      return;
    }
    if (plan.detected) {
      var det = el("div", "rs-detected");
      det.appendChild(el("b", null, "Detected:"));
      det.appendChild(document.createTextNode(" "));
      det.appendChild(el("span", "rs-pill", plan.detected));
      det.appendChild(document.createTextNode(" → "));
      det.appendChild(el("span", "rs-pill", isGorezolv() ? "First Message + Main Prompt" : "5 buckets"));
      panel.appendChild(det);
    }
    // A field is "same" when the file's text equals what's on the page now —
    // the same test Confirm uses to skip it.
    function isSame(m) { return !!curMap && normForDiff(curMap[m.sec.key] || "").trim() === normForDiff(m.file.text || "").trim(); }
    var changedN = 0;
    plan.matched.forEach(function (m) {
      var same = isSame(m);
      if (!same) changedN++;
      var diff = curMap ? lineDiff(curMap[m.sec.key] || "", m.file.text || "") : null;
      panel.appendChild(diffBlock(m.sec.title, diff, same));
    });
    plan.missing.forEach(function (t) { panel.appendChild(lineRow("—", null, t, "no file — kept as is")); });
    plan.unmatched.forEach(function (n) { panel.appendChild(lineRow("?", null, n, "unmatched — skipped")); });
    if ((plan.notes || []).length) {
      var notes = el("div", "rs-notes");
      plan.notes.forEach(function (n) {
        var bad = /emptied|NOT imported|isn't organised|couldn't|could not/i.test(n);
        notes.appendChild(callout(bad ? "warn" : "info", null, n));
      });
      panel.appendChild(notes);
    }

    var foot = footer();
    var row = el("div", "rs-row");
    if (!plan.matched.length) {
      foot.appendChild(callout("bad", null, "Nothing in this file matched " +
        (isGorezolv() ? "First Message / Main Prompt" : "the five buckets") + ". Check the file names."));
    } else if (!changedN) {
      foot.appendChild(callout("info", null, "Nothing to change — every field already matches the file."));
    } else {
      var c = callout("warn", null, null);
      var t = c.lastChild;
      t.appendChild(document.createTextNode("Confirm replaces "));
      t.appendChild(el("b", null, changedN === 1 ? "1 field" : changedN + " fields"));
      t.appendChild(document.createTextNode(". Nothing is saved until you press Save on the page."));
      foot.appendChild(c);
    }
    var cancel;
    if (plan.matched.length) {
      var go = el("button", "rs-btn rs-btn-primary", "Confirm import");
      go.disabled = !changedN;
      go.addEventListener("click", async function () {
        if (go.disabled) return;
        go.disabled = true; cancel.disabled = true;
        // Only write fields that actually change — identical ones are left
        // untouched (faster, and nothing to go wrong on a 20k-char bucket).
        var same = [];
        var toWrite = plan.matched.filter(function (m) {
          if (isSame(m)) { same.push({ title: m.sec.title, ok: true, skipped: true }); return false; }
          return true;
        });
        // Auto-backup the current buckets BEFORE overwriting anything.
        go.textContent = "Backing up…";
        var gen0 = opGen;
        try {
          _lastBackup = await snapshotBuckets();
          _lastBackup.importedKeys = toWrite.map(function (m) { return m.sec.key; });
        } catch (e) { _lastBackup = null; }
        // Someone edited a field after this review opened → don't write a stale
        // plan; refresh the review against what's on the page now.
        if (_lastBackup && curMap && src) {
          var now = {};
          (_lastBackup.sections || []).forEach(function (c) { now[c.key] = c.text || ""; });
          var drift = plan.matched.some(function (m) {
            return normForDiff(now[m.sec.key] || "").trim() !== normForDiff(curMap[m.sec.key] || "").trim();
          });
          if (drift) {
            if (gen0 === opGen && UI.card) renderImportPlan(resolveImportPlan(src, now), now, src, { changed: true });
            return;
          }
        }
        go.textContent = "Importing…";
        runImport(toWrite).then(async function (res) {
          var order = plan.matched.map(function (m) { return m.sec.title; });
          var all = res.concat(same).sort(function (x, y) { return order.indexOf(x.title) - order.indexOf(y.title); });
          // Remember what the import left on the page, so Undo can tell whether
          // the user edited those fields afterwards.
          try {
            if (_lastBackup) {
              var aft = await collectSections(); _lastBackup.after = {};
              aft.forEach(function (c) { _lastBackup.after[c.key] = c.text || ""; });
            }
          } catch (e) {}
          showImportResults(all, {}, gen0);
        }).catch(function (err) {
          showImportResults([{ title: "Error", ok: false, reason: (err && err.message) || "failed" }], {}, gen0);
        });
      });
      row.appendChild(go);
    }
    cancel = el("button", "rs-btn rs-btn-ghost", plan.matched.length ? "Cancel" : "Try another file");
    cancel.addEventListener("click", function () { if (plan.matched.length) closePanel(); else renderImportHome(); });
    row.appendChild(cancel);
    foot.appendChild(row);
  }

  // ---- Save to Ringg (clicks Ringg's own top-right Save button) -----------
  function findRinggSaveButton() {
    var btns = [].slice.call(document.querySelectorAll("button, [role='button']"));
    var cands = btns.filter(function (b) {
      var tx = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (!/^save$/i.test(tx)) return false;
      var r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!cands.length) return null;
    // Prefer the top-most, then right-most (Ringg's Save sits top-right).
    cands.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.top - rb.top) || (rb.left - ra.left);
    });
    return cands[0];
  }
  function isBtnDisabled(b) { return !b || b.disabled || b.getAttribute("aria-disabled") === "true"; }
  function saveToRingg() {
    var btn = findRinggSaveButton();
    if (!btn) { toast("Couldn't find the page's Save button — please Save on the page."); return; }
    if (isBtnDisabled(btn)) { toast("Nothing to save — the page shows no unsaved changes."); return; }
    try { btn.scrollIntoView({ block: "center" }); } catch (e) {}
    btn.click();
    toast("Saving…");
    setTimeout(function () {
      var after = findRinggSaveButton();
      toast(isBtnDisabled(after) ? "Saved." : "Clicked Save — please confirm on the page.");
    }, 700);
  }

  function renderImportResults(results, opts) {
    opts = opts || {};
    freshPanel(opts.undone ? "Import — undo complete" : "Import results");
    var okN = results.filter(function (r) { return r.ok && !r.skipped; }).length;
    var badN = results.filter(function (r) { return !r.ok; }).length;
    var head = el("div", "rs-donehead");
    head.innerHTML = badN && !okN ? IC.err.replace(/width="24" height="24"/, 'width="42" height="42"') : IC.done;
    var ht = el("div");
    ht.appendChild(el("div", "rs-donehead-t", opts.undone ? (okN ? "Restored on the page" : "Nothing was restored")
      : (okN ? "Written into the page" : (badN ? "Nothing was written" : "Nothing changed"))));
    ht.appendChild(el("div", "rs-donehead-s", okN ? "Not saved yet — press Save on the page." : "The page was left as it was."));
    head.appendChild(ht);
    panel.appendChild(head);
    results.forEach(function (r) {
      if (r.skipped) panel.appendChild(lineRow("=", null, r.title, "unchanged — left as is"));
      else if (r.ok && r.warn) panel.appendChild(lineRow("!", null, r.title, null, (opts.undone ? "restored" : "written") + " · " + r.warn));
      else if (r.ok) panel.appendChild(lineRow("✓", null, r.title, opts.undone ? "restored" : "written"));
      else panel.appendChild(lineRow("✕", null, r.title, null, r.reason || "failed"));
    });
    panel.appendChild(el("div", "rs-note", opts.undone
      ? "Restored to the content from just before the import. Review it, then press Save on the page to keep it."
      : "Content written. Review it, then press Save on the page to keep it. If a field shows ✕, check it on the page and import again."));
    if (okN) setLinks(true);   // an action finished — show the author links

    // Safety net: a backup of the pre-import fields is held in memory. Only two
    // actions here — Undo and Download backup.
    if (_lastBackup && !opts.undone) {
      appendBackupActions(footer(), "Backup kept — " + backupWhat() +
        " as they were " + friendlyTime(_lastBackup.when) + ", just before this import.");
    }
  }
  function appendBackupActions(foot, text) {
    {
      foot.appendChild(callout("ok", null, text));
      var srow = el("div", "rs-row");
      var undo = el("button", "rs-btn rs-btn-danger");
      undo.innerHTML = IC.undo; undo.appendChild(document.createTextNode("Undo import"));
      undo._gen = opGen;
      undo.addEventListener("click", async function () {
        if (undo.disabled) return;
        if (_lastBackup && _lastBackup.after && !undo._confirmed) {
          undo.disabled = true; var lbl = undo.lastChild; lbl.textContent = "Checking…";
          var edited = [];
          try {
            var curS = await runExclusive(collectSections), curNow = {};
            curS.forEach(function (c) { curNow[c.key] = c.text || ""; });
            edited = (_lastBackup.importedKeys || []).filter(function (k) {
              return normForDiff(curNow[k] || "").trim() !== normForDiff(_lastBackup.after[k] || "").trim();
            }).map(function (k) { var t = targetByKey(k); return t ? t.title : k; });
          } catch (e) {}
          undo.disabled = false;
          if (edited.length) {
            undo._confirmed = true; lbl.textContent = "Undo anyway";
            footer().insertBefore(callout("warn", null, "You changed " + edited.join(", ") + " after the import. Undo will replace those edits with the text from before the import."), footer().firstChild);
            return;
          }
          lbl.textContent = "Undo import";
        }
        setLinks(false); undo._gen = opGen; undoLastImport(undo);
      });
      var dl = el("button", "rs-btn rs-btn-ghost");
      dl.textContent = "Download backup";
      dl.addEventListener("click", downloadBackup);
      srow.appendChild(undo); srow.appendChild(dl);
      foot.appendChild(srow);
    }
  }
  // Show results — or, if the user moved to another tab (or closed the panel)
  // while it ran, leave them be: a toast says it finished and the Import tab
  // shows the results next time it opens.
  var _pendingResults = null;
  function showImportResults(results, opts, gen0) {
    var okN = results.filter(function (r) { return r.ok && !r.skipped; }).length;
    if (UI.card && currentTab === "import" && (gen0 == null || gen0 === opGen)) { renderImportResults(results, opts); return; }
    _pendingResults = { results: results, opts: opts };
    if (okN) setLinks(true);
    toast((opts && opts.undone ? "Undo finished — " : "Import finished — ") + okN + (okN === 1 ? " field " : " fields ") +
      (opts && opts.undone ? "restored" : "written") + ". Open Import to review.");
  }
  function friendlyTime(d) {
    d = d || new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return "at " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function addCloseRow() {
    var row = el("div", "rs-row");
    var again = el("button", "rs-btn rs-btn-ghost", "Try another file");
    again.addEventListener("click", renderImportHome);
    var close = el("button", "rs-btn rs-btn-ghost", "Close");
    close.addEventListener("click", closePanel);
    again.className = "rs-btn rs-btn-primary";
    row.appendChild(again); row.appendChild(close); footer().appendChild(row);
  }

  // ---- find & replace panel ----------------------------------------------
  function mkInput(ph) {
    var e = el("input", "rs-input"); e.type = "text"; e.placeholder = ph; return e;
  }
  function fieldRow(labelText, inputEl) {
    var wrap = el("div", "rs-field");
    wrap.appendChild(el("div", "rs-flabel", labelText));
    wrap.appendChild(inputEl);
    return wrap;
  }
  function mkCheck(labelText) {
    var wrap = el("label", "rs-check");
    var input = document.createElement("input"); input.type = "checkbox";
    wrap.appendChild(input); wrap.appendChild(el("span", null, labelText));
    return { wrap: wrap, input: input };
  }
  function mkBtn(text, styleObj, onClick) {
    var b = document.createElement("button");
    b.textContent = text; style(b, styleObj);
    b.addEventListener("click", onClick);
    return b;
  }

  function renderFindReplace() {
    ++opGen; // supersede any in-flight panel refresh
    freshPanel("Find & replace — 5 buckets");
    function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
    var findIn = mkInput("Find…");
    var repIn = mkInput("Replace with… (leave blank to just find)");
    findIn.setAttribute("aria-label", "Find"); repIn.setAttribute("aria-label", "Replace with");

    // Cmd+F-style: the match counter and ▲ ▼ sit on the Find field's own row.
    var findRow = el("div", "rs-findrow");
    var counter = el("span", "rs-counter", "");
    counter.setAttribute("aria-live", "polite");
    var prevBtn = el("button", "rs-iconbtn", "▲"); prevBtn.title = "Previous match (Shift+Enter)"; prevBtn.setAttribute("aria-label", "Previous match");
    var nextBtn = el("button", "rs-iconbtn", "▼"); nextBtn.title = "Next match (Enter)"; nextBtn.setAttribute("aria-label", "Next match");
    var nav = el("div", "rs-findnav");
    prevBtn.innerHTML = IC.up; nextBtn.innerHTML = IC.down;
    nav.appendChild(counter); nav.appendChild(prevBtn); nav.appendChild(nextBtn);
    findRow.appendChild(findIn); findRow.appendChild(nav);
    panel.appendChild(fieldRow("Find", findRow));
    panel.appendChild(fieldRow("Replace", repIn));

    var optRow = el("div", "rs-opts");
    var mc = mkCheck("Match case");
    var ww = mkCheck("Whole word");
    optRow.appendChild(mc.wrap); optRow.appendChild(ww.wrap);
    panel.appendChild(optRow);

    var result = el("div", "rs-result");
    panel.appendChild(result);

    var hint = el("div", "rs-note", "Searches live as you type — matches highlight yellow, the current one orange. Enter / Shift+Enter jump between them. Replace all rewrites every matching field; export a backup first.");
    panel.appendChild(hint);

    function opts() { return { matchCase: mc.input.checked, wholeWord: ww.input.checked }; }
    function updateCounter() {
      var n = _findRanges.length;
      counter.textContent = findIn.value.trim() ? (n ? (_findIdx + 1) + "/" + n : "0/0") : "";
      prevBtn.disabled = nextBtn.disabled = n < 1;
    }
    prevBtn.addEventListener("click", function () { if (_findRanges.length) { stepFind(-1); updateCounter(); } });
    nextBtn.addEventListener("click", function () { if (_findRanges.length) { stepFind(1); updateCounter(); } });
    updateCounter();

    function setResult(headText, empty) {
      result.innerHTML = "";
      if (headText) result.appendChild(el("div", empty ? "rs-result-empty" : "rs-result-h", headText));
    }

    function renderCounts(res) {
      if (!res || !res.total) { setResult("No matches.", true); return; }
      setResult(plural(res.total, "match", "matches") + " in " + plural(res.per.length, "bucket", "buckets") + ":");
      res.per.forEach(function (p, i) { result.appendChild(lineRow(i % 2 ? "○" : "•", null, p.title, p.count + "×")); });
      if (!res.supported) {
        result.appendChild(callout("warn", null, "Counts are accurate, but this browser can't highlight matches on the page."));
      }
    }

    function doFind() {
      var q = findIn.value;
      if (!q.trim()) {
        if (q.length) { setResult("Type a word or phrase — spaces alone aren't searched.", true); clearHighlights(); updateCounter(); return; } setResult(""); clearHighlights(); updateCounter(); return; }
      runExclusive(function () { return findAll(q, opts()); }).then(function (res) {
        renderCounts(res); updateCounter();
      }).catch(function () { setResult("Search failed.", true); });
    }

    // Live, incremental search as you type (like Cmd+F).
    var findTimer = null;
    findIn.addEventListener("input", function () {
      if (findTimer) clearTimeout(findTimer);
      findTimer = setTimeout(doFind, 180);
    });
    // Enter = next match, Shift+Enter = previous (falls back to a fresh find).
    findIn.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (_findRanges.length) { stepFind(e.shiftKey ? -1 : 1); updateCounter(); }
        else doFind();
      }
    });
    // Keep highlights in sync when the options change.
    mc.input.addEventListener("change", doFind);
    ww.input.addEventListener("change", doFind);

    var row = el("div", "rs-row");
    var findBtn = mkBtn("Find", primaryBtn(), doFind);
    var repBtn = mkBtn("Replace all", secondaryBtn(), function () {
      var q = findIn.value;
      if (!q.trim()) { setResult("Type something to find first.", true); try { findIn.focus(); } catch (e) {} return; }
      if (findTimer) { clearTimeout(findTimer); findTimer = null; }   // a pending live search must not overwrite the replace result
      repBtn.disabled = true; repBtn.textContent = "Replacing…";
      setLinks(false);   // a new activity started
      runExclusive(function () { return replaceAllBuckets(q, repIn.value, opts()); }).then(function (rs) {
        var tot = 0; rs.forEach(function (r) { tot += r.n; });
        setResult(tot ? ("Replaced " + plural(tot, "occurrence", "occurrences") + ":") : "Nothing to replace.", !tot);
        if (tot) rs.forEach(function (r) { result.appendChild(lineRow(!r.ok ? "✕" : (r.warn ? "!" : "✓"), null, r.title, r.n + "×", r.warn || "")); });
        if (tot) {
          setLinks(true);
          result.appendChild(el("div", "rs-muted", "Review the fields, then Save. (Replace edits the stored text; a variable chip keeps its own name.)"));
          var srow = el("div", "rs-row");
          var sbtn = el("button", "rs-btn rs-btn-primary", "Save on page");
          sbtn.addEventListener("click", saveToRingg);
          srow.appendChild(sbtn); result.appendChild(srow);
        }
        repBtn.disabled = false; repBtn.textContent = "Replace all";
        clearHighlights(); updateCounter();
      }).catch(function () { repBtn.disabled = false; repBtn.textContent = "Replace all"; setResult("Replace failed.", true); });
    });
    var clearBtn = mkBtn("Clear", secondaryBtn(), function () {
      clearHighlights(); findIn.value = ""; repIn.value = ""; setResult(""); updateCounter();
      try { findIn.focus(); } catch (e) {}
    });

    row.className = "rs-row rs-three";
    row.appendChild(findBtn); row.appendChild(repBtn); row.appendChild(clearBtn);
    footer().appendChild(row);

    setTimeout(function () { if (!UI._kbTab) { try { findIn.focus(); } catch (e) {} } }, 50);
  }

  function primaryBtn() { return { __cls: "rs-btn rs-btn-primary" }; }
  function secondaryBtn() { return { __cls: "rs-btn rs-btn-ghost" }; }
  function style(el, o) {
    if (!o) return;
    if (o.__cls) el.className = o.__cls;
    Object.keys(o).forEach(function (k) { if (k !== "__cls") el.style[k] = o[k]; });
  }

  // ---- popup / toolbar messaging -----------------------------------------
  chrome.runtime.onMessage.addListener(function (req, sender, sendResponse) {
    if (!req || !req.type) return;
    if (req.type === "ping") {
      sendResponse({ ok: true });
      return true;
    }
    if (req.type === "get-status") {
      // Lightweight, side-effect-free check: which buckets have an editor on the
      // page right now. Does NOT expand or copy (copying needs a real click).
      askInterceptorForLatest();
      var found;
      try {
        if (isGorezolv()) {
          var gm = gorezolvEditors();
          found = [{ title: "First Message", found: !!gm.fm }, { title: "Main Prompt", found: !!gm.mp }];
        } else {
          found = window.RinggExtract.sectionEditors().map(function (m) {
            return { title: m.title, found: !!m.el };
          });
        }
      } catch (e) { found = []; }
      sendResponse({ ok: true, sections: found });
      return true;
    }
    // The real copy needs the page's user activation, which a popup message does
    // NOT carry. So the popup never copies directly — it opens the on-page panel
    // and the user clicks Download there, guaranteeing a genuine copy.
    if (req.type === "download" || req.type === "open-panel") {
      openPanel();
      sendResponse({ ok: true });
      return true;
    }
  });

  // ---- test hook (harmless; used only by the offline stress harness) ------
  try {
    window.__ringgTest = {
      nameFromUI: nameFromUI, fileBase: fileBase, matchSection: matchSection,
      lineDiff: lineDiff, coarseDiff: coarseDiff, escapeRegExp: escapeRegExp,
      mdToHtml: mdToHtml, htmlToText: htmlToText, planImport: planImport,
      parseSingleMd: parseSingleMd, matchSectionByHeading: matchSectionByHeading,
      sectionHeaderAt: sectionHeaderAt,
      collectSections: collectSections, findAll: findAll, replaceAllBuckets: replaceAllBuckets,
      sanitizeHtml: sanitizeHtml, applyReplace: applyReplace,
      findRinggSaveButton: findRinggSaveButton, saveToRingg: saveToRingg,
      sectionsToFiles: sectionsToFiles, sectionsToTwoFiles: sectionsToTwoFiles,
      isGorezolv: isGorezolv, gorezolvEditors: gorezolvEditors, splitMainPrompt: splitMainPrompt,
      gorezolvFiveSections: gorezolvFiveSections, liveMainSplit: liveMainSplit, doDownload: doDownload,
      hydrateMentions: hydrateMentions, mdToHydratedHtml: mdToHydratedHtml,
      snapshotBuckets: snapshotBuckets, runImport: runImport, backupStamp: backupStamp,
      getLastBackup: function () { return _lastBackup; },
      setLastBackup: function (b) { _lastBackup = b; },
      renderImportResults: renderImportResults, getPanel: function () { return panel; },
      tuckLauncher: tuckLauncher, untuckLauncher: untuckLauncher,
      getLauncher: function () { return UI.launcher; }, getCard: function () { return UI.card; },
      pasteHtmlIntoEditor: pasteHtmlIntoEditor, hasSpacerArtifacts: hasSpacerArtifacts,
      readZipSource: readZipSource, sourceFromMd: sourceFromMd, resolveImportPlan: resolveImportPlan,
      isMainPromptName: isMainPromptName, collateMain: collateMain, siteTargets: siteTargets,
      downloadBackup: downloadBackup, beginImport: beginImport, renderImportPlan: renderImportPlan
    };
  } catch (e) {}

  // ---- boot ---------------------------------------------------------------
  askInterceptorForLatest();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureUI);
  } else {
    ensureUI();
  }
})();
