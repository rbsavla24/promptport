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

  var NS = "PROMPTPORT_BRIDGE";
  var latestAssistant = null; // { url, data } — used mainly for naming
  var captured = [];          // all captured JSON payloads (data objects)
  var capturedMeta = [];      // same payloads tagged with their source URL (for
                              // URL-based filtering, e.g. assistant-level tools)
  var _lastBackup = null;     // { when, sections, matched, importedKeys } — pre-import snapshot for Undo

  var opGen = 0;              // bumped each openPanel/refresh; stale chains bail
  var opLock = Promise.resolve(); // serialize collect/copy ops (no concurrent copy listeners)
  function runExclusive(fn) {
    var p = opLock.then(function () {
      var keep = focusKeeper();
      return Promise.resolve(fn()).then(function (v) { keep(); return v; }, function (e) { keep(); throw e; });
    });
    opLock = p.catch(function () {});
    return p;
  }

  // ---- busy lock: one page-driving job at a time ----------------------------
  // kind: "migrate" (Magic Port import), "export" (reads / the Magic Port tour),
  // "import", "replace". ppLock(kind) → true when taken (re-entrant for the
  // same kind, so a job's inner steps can take it again), false while another
  // kind holds it. Every ppLock that returned true needs one ppUnlock(kind).
  var _ppBusy = null;   // { kind, n }
  function ppBusy() { return _ppBusy ? _ppBusy.kind : null; }
  function ppLock(kind) {
    kind = String(kind || "busy");
    if (_ppBusy && _ppBusy.kind !== kind) return false;
    if (_ppBusy) _ppBusy.n++; else _ppBusy = { kind: kind, n: 1 };
    ppPaintBusy();
    return true;
  }
  function ppUnlock(kind) {
    if (!_ppBusy || (kind && _ppBusy.kind !== String(kind))) return;
    if (--_ppBusy.n <= 0) _ppBusy = null;
    ppPaintBusy();
  }
  function ppBusyText() {
    var k = ppBusy();
    return k === "migrate" ? "A Magic Port migration is running — wait for it to finish."
      : k === "export" ? "PromptPort is reading this bot — wait for it to finish."
      : k === "import" ? "An import is writing to this page — wait for it to finish."
      : k === "replace" ? "Replace is writing to this page — wait for it to finish."
      : "PromptPort is busy — wait for the current job to finish.";
  }
  // While busy, the controls that would start another job look and act disabled:
  // the export tiles, Refresh preview, the import drop zone, Replace all, Undo import.
  function ppBusyTarget(b) {
    if (!b || !b.matches) return false;
    if (b.matches(".rs-cta,.rs-dropzone")) return true;
    var t = String(b.textContent || "").replace(/\s+/g, " ").trim();
    return /^(Replace all|Undo import|Undo anyway|↻ Refresh preview)$/.test(t);
  }
  function ppPaintBusy() {
    try {
      if (typeof UI === "undefined" || !UI || !UI.root) return;
      var on = !!_ppBusy;
      [].slice.call(UI.root.querySelectorAll("button")).forEach(function (b) {
        var marked = b.hasAttribute("data-pp-busy");
        if (on && !marked && ppBusyTarget(b)) {
          // A focused control is only aria-disabled (the click blocker still
          // stops it): disabling it would drop keyboard focus to the page.
          var focused = UI.root.activeElement === b;
          b.setAttribute("data-pp-busy", b.disabled ? "d" : (focused ? "a" : ""));
          if (focused) b.setAttribute("aria-disabled", "true"); else b.disabled = true;
          b.classList.add("rs-busy-off");
        } else if (!on && marked) {
          // Re-enable only what the lock disabled; a control its own screen
          // disabled stays as that screen left it.
          var how = b.getAttribute("data-pp-busy");
          if (how === "") b.disabled = false;
          else if (how === "a") b.removeAttribute("aria-disabled");
          b.removeAttribute("data-pp-busy");
          b.classList.remove("rs-busy-off");
        }
      });
    } catch (e) {}
  }

  // 2-field dashboard: the bot's gateway API responses, newest per URL, as
  // kept by interceptor.js (it answers "request-latest" with all of them).
  var gwStore = [];           // [{ url, data }] oldest first
  var gwWaiters = [];         // resolvers waiting for the next gateway answer

  // The page key that identifies "this bot". On the 2-field dashboard the
  // ?tab= part changes as tabs are opened (the export tour does that), so only
  // the path counts there; elsewhere the full address, as before.
  function navKey() {
    try { if (isTwoField()) return location.pathname; } catch (e) {}
    return location.href;
  }
  var lastUrl = navKey();
  // In the SPA, drop captured payloads when the assistant page changes, so one
  // assistant's data can never leak into another's export.
  function resetIfNavigated() {
    var k = navKey();
    if (k !== lastUrl) {
      lastUrl = k;
      // Keep only what belongs to the bot now on the page (tagged by interceptor.js).
      capturedMeta = capturedMeta.filter(captureBelongsHere);
      captured = capturedMeta.map(function (m) { return m.data; });
      if (!(latestAssistant && captureBelongsHere(latestAssistant))) latestAssistant = null;
      gwStore = [];
    }
  }

  // interceptor.js tags every capture with the page it was taken on (key: the
  // bot id in the address, else the path) and the bot id its own request
  // address names (urlBot). A capture belongs to this page when that bot is this
  // page's bot — or, with no bot in its address, when it was taken on this page.
  // Untagged data is never used.
  function pageKeyNow() { var b = pageBotId(); return b ? "bot:" + b : "path:" + String(location.pathname || ""); }
  function captureBelongsHere(c) {
    if (!c || typeof c !== "object" || typeof c.key !== "string") return false;
    var bot = pageBotId();
    if (c.urlBot) return !!bot && String(c.urlBot).toLowerCase() === bot;
    return c.key === pageKeyNow();
  }

  function addCapture(c) {
    if (!c || !c.data || typeof c.data !== "object" || !captureBelongsHere(c)) return;
    var id = String(c.url || "") + "\n" + (c.at || "") + "\n" + c.key;
    if (c.at && capturedMeta.some(function (m) { return m.id === id; })) return;   // the same response again
    captured.push(c.data);
    capturedMeta.push({ url: String(c.url || ""), data: c.data, key: c.key, urlBot: c.urlBot || "", at: c.at || 0, id: id });
    if (captured.length > 40) captured.shift();
    if (capturedMeta.length > 40) capturedMeta.shift();
  }

  // ---- talk to the page-world interceptor ---------------------------------
  // Only over the private channel set up by bridge.js (a detached element the
  // page can't reach); window messages are never read, so a page script can't
  // feed data into an export.
  var _bridge = window.__ppBridge || null;
  var _bridgeSeen = {};
  function onBridge(msg) {
    if (!msg || msg.__ns !== NS) return;
    _bridgeSeen[msg.type] = (_bridgeSeen[msg.type] || 0) + 1;
    resetIfNavigated();
    var p = msg.payload || {};
    if (msg.type === "assistant-data") {
      if (!captureBelongsHere(p) || !p.data || typeof p.data !== "object") return;
      latestAssistant = { url: p.url, data: p.data, key: p.key, urlBot: p.urlBot || "" };
      addCapture(p);
    } else if (msg.type === "captures") {
      var list = Array.isArray(p.list) ? p.list : [];
      if (p.gateway) {
        // The interceptor sends the complete keyed set each time: replace.
        var forBot = String(p.botId || "").toLowerCase() === pageBotId();
        gwStore = !forBot ? [] : list.filter(function (c) { return c && c.data && typeof c.data === "object" && captureBelongsHere(c); })
          .map(function (c) { return { url: String(c.url || ""), data: c.data }; });
        var w = gwWaiters; gwWaiters = [];
        w.forEach(function (fn) { try { fn(true); } catch (e) {} });
        return;
      }
      list.forEach(addCapture);
    }
  }
  try { if (_bridge && typeof _bridge.listen === "function") _bridge.listen(onBridge); } catch (e) {}

  function askInterceptorForLatest() {
    try { if (_bridge && typeof _bridge.send === "function") _bridge.send({ __ns: NS, type: "request-latest" }); } catch (e) {}
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
  // reject breadcrumb/nav fragments (Dash5 runs the nav items together, e.g.
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

    // 2-field dashboard: the name is the value of the input under the
    // floating "Agent Name" label.
    if (isTwoField()) {
      // New layout: <label for="workbench-agent-name">Agent name</label><input id=…>.
      try {
        var wn = document.getElementById("workbench-agent-name");
        var wv = wn ? clean(wn.value) : "";
        if (wv) return wv;
      } catch (e) {}
      try {
        var lab = [].slice.call(document.querySelectorAll("label")).filter(function (l) {
          return clean(l.textContent) === "Agent Name";
        })[0];
        var q = lab && lab.parentElement, inp = null;
        for (var d = 0; d < 5 && q && !inp; d++) { inp = q.querySelector("input"); q = q.parentElement; }
        // New UI: the first text input is often a section field (e.g. a
        // variable's "Branch Name"), never the agent name — skip the guess.
        if (!inp && !d2NewUi()) inp = document.querySelector('input[type="text"]');
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
      // Drop the site's own name from the title (taken from this page's domain,
      // e.g. "… | Brand" on brand.example), so it never becomes the bot name.
      var brand = ((location.hostname || "").split(".").slice(-2)[0] || "").replace(/[^a-z0-9]/gi, "");
      var dt = (document.title || "");
      if (brand) dt = dt.replace(new RegExp("\\s*[|·–—-]\\s*" + brand + ".*$", "i"), "");
      dt = dt.trim();
      if (dt && dt.length > 3 && !(brand && new RegExp("^" + brand, "i").test(dt)) && !/voice assistants for business/i.test(dt)) chosen = dt;
    }

    try { console.log("[PromptPort] chosen name:", chosen); } catch (e) {}
    return chosen;
  }

  // Keep the name human-readable; only strip characters filesystems disallow.
  // Also: no control characters, no ".." runs, no leading/trailing dots or
  // spaces (Windows drops a trailing dot → "Bot v2..zip"; a leading dot hides
  // the file), at most 120 characters before the suffix, never empty.
  function fileBase(name) {
    var s = String(name || "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/[\/\\:*?"<>|]/g, " ")
      .replace(/\.{2,}/g, ".")
      .replace(/\s+/g, " ")
      .replace(/^[. ]+|[. ]+$/g, "");
    var cps = Array.from(s);
    if (cps.length > 120) s = cps.slice(0, 120).join("").replace(/[. ]+$/, "");
    return s || "assistant";
  }

  function zipFilename() {
    var name = nameFromUI() || assistantName();
    try { console.log("%c[PromptPort] zip filename:", "color:#4f46e5", fileBase(name) + ".zip"); } catch (e) {}
    return fileBase(name) + ".zip";
  }

  function buildSections() {
    resetIfNavigated();
    // Prefer the full set of captured API payloads (raw stored values contain
    // the {{tokens}}); DOM is used only as a fallback inside combine().
    var input = captured.length ? captured
              : (latestAssistant && latestAssistant.data ? [latestAssistant.data] : []);
    return window.PPExtract.combine(input);
  }

  // ---- copy-from-UI (the accurate path for {{tokens}}) --------------------
  function selectContents(el) {
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Do what a user does by hand: select all of a field and copy it. Dash5's
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
        // The editor keeps its own copy of the selection (and shows its
        // formatting toolbar while text is selected), so first collapse the
        // selection to the start — the editor picks that up on
        // "selectionchange" — then drop it and blur.
        var isRichEl = !(el.tagName === "TEXTAREA" || el.tagName === "INPUT");
        try {
          if (isRichEl && el.isConnected) {
            var r = document.createRange(); r.setStart(el, 0); r.collapse(true);
            var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
            try { document.dispatchEvent(new Event("selectionchange")); } catch (e) {}
          }
        } catch (e) {}
        setTimeout(function () {
          try { window.getSelection().removeAllRanges(); } catch (e) {}
          try { if (el.blur) el.blur(); } catch (e) {}
          resolve(result);
        }, isRichEl ? 60 : 0);
      }

      // 1) Preferred: ask the editor to serialize itself into a PRIVATE
      //    DataTransfer via a synthetic copy event. ProseMirror's copy handler
      //    writes its own HTML (mention chips as data-id="{{token}}") into the
      //    event's clipboardData. No OS clipboard, no permission, no user
      //    gesture needed — this is what makes variables survive even when
      //    Dash5 renders chips with only a friendly label ("Callee Name").
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

  // Captured API data used ONLY when a bucket's editor isn't on the page at
  // all. Never another bot's data: when the page names its bot, keep only the
  // captures that mention that bot id.
  function exportFallbackSections() {
    resetIfNavigated();
    var input = captured.length ? captured
              : (latestAssistant && latestAssistant.data ? [latestAssistant.data] : []);
    var id = "";
    try { id = typeof pageBotId === "function" ? pageBotId() : ""; } catch (e) { id = ""; }
    if (id) {
      input = input.filter(function (c) {
        try { return JSON.stringify(c).toLowerCase().indexOf(id) !== -1; } catch (e) { return false; }
      });
    }
    return window.PPExtract.combine(input);
  }

  // Markdown of the last copied HTML per bucket: refreshExport reads the page
  // more than once, and converting an unchanged (possibly 1 MB) bucket again
  // is the slow part — so an identical copy reuses its markdown.
  var _mdMemo = {};
  function memoMarkdown(key, val, opts) {
    var k = (opts && opts.text ? "t:" : "h:") + key, hit = _mdMemo[k];
    if (hit && hit.src === val) return hit.md;
    var md = window.PPExtract.toMarkdown(val, opts);
    _mdMemo[k] = { src: val, md: md };
    return md;
  }

  async function collectSections() {
    // 2-field dashboard has just two fields — read them directly. Never run
    // Dash5's expand-collapsed logic here (it clicks toggles near headings).
    if (isTwoField()) return collectTwoField();
    // Open any collapsed buckets first, then wait for their editors to render.
    try {
      var opened = window.PPExtract.expandCollapsed();
      if (opened) {
        await sleep(700);
        window.PPExtract.expandCollapsed(); // second pass for nested/late toggles
        await sleep(300);
      }
    } catch (e) {}

    var map;
    try { map = window.PPExtract.sectionEditors(); } catch (e) { map = []; }
    // API / DOM fallback — built only when some bucket has NO editor on the page.
    var baseline = null;
    function fallback() { if (!baseline) baseline = exportFallbackSections(); return baseline; }

    var prevText = "";
    try { prevText = await navigator.clipboard.readText(); } catch (e) {}

    var results = [];
    for (var i = 0; i < map.length; i++) {
      var m = map[i];
      var md = "", source = "none";
      var el = m.el;
      if (el) {
        // The editor is on the page: what it shows is the truth. An EMPTY editor
        // exports as empty (the user cleared it) — never as captured API text,
        // which may be stale or another bot's.
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
          // a field's value is plain text / markdown, never HTML
          md = memoMarkdown(m.key, el.value || "", { text: true });
          if (md) source = "ui";
        } else {
          var cap = await copyEditor(el);
          try {
            console.log("%c[PromptPort] " + m.title, "color:#4f46e5;font-weight:bold");
            console.log("  html:", (cap.html || "(none)").slice(0, 400));
            console.log("  text:", (cap.text || "(none)").slice(0, 400));
          } catch (e) {}
          if (cap.html) { md = memoMarkdown(m.key, cap.html, { html: true }); source = "ui"; }
          else if (cap.text) { md = memoMarkdown(m.key, cap.text, { text: true }); source = "ui"; }
        }
        if (!md) source = "none";
      } else {
        var base = fallback()[i] || { text: "", source: "none" };
        md = (base.text || "").trim(); source = md ? base.source : "none";
      }
      results.push({ key: m.key, title: m.title, filename: m.filename, text: md, source: source });
    }

    try { if (prevText) await navigator.clipboard.writeText(prevText); } catch (e) {}
    return results.length ? results : fallback();
  }

  function sectionsToFiles(sections) {
    // Name each file "N_Export_Name.md" (e.g. "1_First_Message.md") so the ZIP
    // lists the buckets in prompt order in every file explorer (which sort
    // alphabetically). The importer strips the numeric prefix, so round-trip
    // matching is unaffected.
    var SECS = window.PPExtract.SECTIONS;
    var order = SECS.map(function (s) { return s.key; });
    return sections.map(function (s, i) {
      var body = s.text && s.text.trim()
        ? s.text.trim()
        : "<!-- No content found for \"" + s.title + "\". Open this section on the page, reload, then export again. -->";
      var known = !!(s.key && order.indexOf(s.key) !== -1);
      var idx = known ? order.indexOf(s.key) : i;
      // Prefer the canonical export name (e.g. "First_Message") — but ONLY for a
      // real bucket key; an unknown key (e.g. Dash2 "main-prompt") must not borrow
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
  // Main Prompt. This matches the 2-field dashboard's shape (First Message + Main
  // Prompt) and reads as a clean system prompt for an LLM: H1 section names sit
  // above each bucket's own ### structure, empty sections are skipped (no dangling
  // heading), and no "---" dividers (which can turn the line above into a heading).
  // Text that actually says something (our exporter writes "<!-- No content… -->"
  // placeholders for empty buckets — those count as empty).
  function meaningful(t) {
    return String(t || "").replace(/<!--[\s\S]*?-->/g, "").trim() !== "";
  }

  function bucketHeading(key) {
    var SECS = window.PPExtract.SECTIONS;
    for (var i = 0; i < SECS.length; i++) {
      if (SECS[i].key === key) return String(SECS[i].exportName || SECS[i].title || key).replace(/_/g, " ");
    }
    return key;
  }

  // The ONE way a Main Prompt is built from the 4 buckets — used by both the
  // 2-bucket export and the Dash2 import, so they always agree (and so it always
  // splits back cleanly with splitMainPrompt).
  function collateMain(partsByKey) {
    var out = [];
    MAIN_SPLIT_KEYS.forEach(function (key) {
      var t = partsByKey && partsByKey[key];
      if (!meaningful(t)) return;                                  // skip empty → no dangling heading
      out.push("# " + bucketHeading(key) + "\n\n" + innerBucketH1s(String(t).trim())); // H1 above each bucket
    });
    return out.join("\n\n");
  }

  // A bucket's OWN "# Conversation Flow"-style H1 (a heading that names a
  // bucket) would be read back as a split point and move text into another
  // bucket. Write such an H1 in the equivalent setext form ("Title" + "===")
  // — still an H1 when pasted / rendered, but never a split point;
  // splitMainPrompt turns it back into "# Title", so 5 → 2 → 5 is lossless.
  var INNER_H1_GAP = " ";
  function innerBucketH1s(md) {
    var lines = String(md).split("\n"), inFence = fenceTracker();
    for (var i = 0; i < lines.length; i++) {
      if (inFence(lines[i])) continue;
      var m = lines[i].match(ATX_H1_RE);
      if (!m || !canonicalSection(headingTitle(m[1]))) continue;
      var title = m[1];
      // a title that would read as a list item / quote / fence: escape its first
      // marker (one more backslash; restoreInnerH1s removes exactly one)
      if (/^\\*([-*+>#=]|`{3}|~{3})/.test(title)) title = "\\" + title;
      else if (/^\d+\\*[.)]/.test(title)) title = title.replace(/^(\d+)/, "$1\\");
      // a setext heading must not continue the paragraph above it: separate it
      // with a whitespace-only line (INNER_H1_GAP) that restoreInnerH1s drops
      // again — added also when the line above already is one, so a user's own
      // whitespace-only line survives.
      var gap = i > 0 && (/\S/.test(lines[i - 1]) || lines[i - 1] === INNER_H1_GAP);
      lines[i] = (gap ? INNER_H1_GAP + "\n" : "") + title + "\n" + new Array(Math.max(3, Math.min(title.length, 80)) + 1).join("=");
    }
    return lines.join("\n");
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
      // Dash2 panel: the Main Prompt field is exported exactly as it is.
      mainBody = textOf("main-prompt");
    } else {
      // Dash5: collate the four buckets under # headings.
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
    try { href = window.PPZip.toDataUrl(files); }
    catch (e) { href = URL.createObjectURL(window.PPZip.make(files)); }
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

  // ---- Magic Port export: full bot (prompt + all configs) as one ZIP -------
  // Prompt travels as the usual .md files (5 on Dash5, 2 on Dash2); the other
  // five data points go in magicport.json, read from the captured API JSON by
  // the MagicPort engine. REQ-1 (all variables) and REQ-2 (key types) are
  // enforced in that engine.
  function magicPortPromptFiles(sections) {
    return isTwoField() ? sectionsToTwoFiles(sections) : sectionsToFiles(sections);
  }
  function buildMagicPortFiles(sections) {
    if (!window.MagicPort) return null;
    resetIfNavigated();
    var captures = captured.length ? captured
                 : (latestAssistant && latestAssistant.data ? [latestAssistant.data] : []);
    var promptFiles = magicPortPromptFiles(sections);
    var built = window.MagicPort.buildConfig({
      platform: window.MagicPort.hostPlatform(),
      captures: captures,
      captureMeta: capturedMeta,   // url-tagged, for assistant-level tool filtering
      promptFiles: promptFiles,
      botId: pageBotId(),          // only this bot's data (never a previous page's)
      pluginVersion: PP_VERSION
    });
    if (!built || !built.ok) return { ok: false, reason: (built && built.reason) || "no source data" };
    return { ok: true, files: window.MagicPort.buildZipFiles(built.config, promptFiles), config: built.config };
  }
  function downloadMagicPort(sections) {
    var r = buildMagicPortFiles(sections);
    if (!r || !r.ok) { toast(mpFailText((r && r.reason) || "couldn't read this bot")); return false; }
    var fname = mpZipName();
    saveZip(r.files, fname);
    var n = (r.config.data.variables || []).length;
    toast("Magic Port ZIP downloaded — " + n + " variables + configs" +
      (r.config.containsCredentials ? " (contains credentials)" : ""));
    _lastDl = "Magic Port ZIP downloaded."; setLinks(true);
    return true;
  }

  // "Magic Port: <reason> — reload the bot and try again." (a reason that already
  // says what to do stands alone).
  function mpFailText(reason) {
    reason = String(reason || "");
    return "Magic Port: " + reason + (/reload|try again/i.test(reason) ? "" : " — reload the bot and try again.");
  }
  // The Magic Port zip's name: the bot's name (page-controlled) capped so the
  // whole name stays well under file-system limits.
  function mpZipName() {
    var base = fileBase(nameFromUI() || assistantName());
    var bcp = Array.from(base);   // by code point: never split an emoji / surrogate pair
    if (bcp.length > 80) base = bcp.slice(0, 80).join("").replace(/[. ]+$/, "").trim() || "assistant";
    return base + " (Magic Port).zip";
  }

  // ---- Magic Port export from a 2-field bot --------------------------------
  // The 2-field app loads each part of the bot (LLM/STT, voices, webhooks,
  // tools per phase, analysis model) only when its tab is opened, and caches it.
  // So the export first takes a short READ-ONLY tour of those tabs (it only
  // switches tabs — never types, toggles or saves), reads the names shown on
  // screen, then returns to the tab the user was on and builds the file from
  // the app's own captured responses.
  var D2_TOP_TABS = ["Prompt", "LLM and STT", "Custom Variables", "Call Config", "Language and Voice",
    "Event Subscription", "Tools", "Custom Analysis"];
  var D2_GATEWAY_RE = /\/v1\/(voiceagents\/[0-9a-f-]{36}(\?|$)|tools\/[0-9a-f-]{36}|webhooks\/[0-9a-f-]{36}|webhook-events|providers|provider-models|voiceagents\/compatible-voices|voiceagents\/language-catalog)/i;

  function pageBotId() {
    var m = location.pathname.match(/\/voice-agents\/([0-9a-f-]{36})(?:[\/?#]|$)/i) ||
            location.pathname.match(/\/assistants\/([0-9a-f-]{8,})(?:[\/?#]|$)/i);
    return m ? m[1].toLowerCase() : "";
  }
  function d2Norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
  function d2Visible(e) {
    if (!e || !e.isConnected) return false;
    var r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  // New layout (sidebar of section buttons, see MagicPortDom.v2*): true when it is showing.
  function d2NewUi() {
    try { return !!(window.MagicPortDom && window.MagicPortDom.v2IsNewUi && window.MagicPortDom.v2IsNewUi()); } catch (e) { return false; }
  }
  // New layout: the Tools section's phase tab (phase = pre_call|on_call|post_call).
  function d2PhaseTab(phase) { return document.querySelector("[role='tab'][id$='-trigger-" + phase + "']"); }
  // The top-level tab that is showing now ("" if none can be told).
  // New layout: the active section's slug ("prompt", "llm-stt", …).
  function d2CurrentTopTab() {
    if (d2NewUi()) return window.MagicPortDom.v2ActiveSection() || "";
    var tabs = [].slice.call(document.querySelectorAll("[role='tab']"));
    for (var i = 0; i < tabs.length; i++) {
      var t = d2Norm(tabs[i].textContent);
      if (D2_TOP_TABS.indexOf(t) !== -1 &&
          (tabs[i].getAttribute("aria-selected") === "true" || tabs[i].getAttribute("data-state") === "active")) return t;
    }
    return "";
  }
  var D2_LABEL_SLUG = { "prompt": "prompt", "llm and stt": "llm-stt", "custom variables": "custom-variables",
    "call config": "call-config", "language and voice": "language-voice", "event subscription": "event-subscription",
    "tools": "tools", "custom analysis": "custom-analysis" };
  function d2HasTab(label) {
    var want = String(label || "").toLowerCase();
    if (d2NewUi()) {
      // Phase tabs by id suffix ("Post Call" reads "Post CallSoon"); else a sidebar section by slug.
      var ph = { "pre call": "pre_call", "on call": "on_call", "post call": "post_call" }[want];
      if (ph) return !!d2PhaseTab(ph);
      // A section by its old tab label, its new sidebar label, or its slug.
      var slug = D2_LABEL_SLUG[want] || want;
      for (var s in D2_V2_LABEL) if (D2_V2_LABEL[s].toLowerCase() === want) slug = s;
      return !!window.MagicPortDom.v2SectionButton(slug);
    }
    return [].slice.call(document.querySelectorAll("[role='tab']")).some(function (t) {
      return d2Visible(t) && d2Norm(t.textContent).toLowerCase() === want;
    });
  }
  // Provider/Model pairs on the current tab: role=textbox boxes labelled
  // "Provider"/"Model", each holding a read-only input with the shown value.
  // New layout: <label>Provider|Model</label> + button[role=combobox] (labelled
  // through aria-labelledby / label[for]); placeholders ("Select provider",
  // "Pick a provider first") read as "". Scoped to the open section's editor.
  function d2ProviderModelPairs() {
    if (d2NewUi()) {
      var MPD = window.MagicPortDom;
      var scope = document.querySelector('section[aria-label="Models editor"]') ||
                  document.querySelector('section[aria-label="Post-call analysis editor"]') ||
                  document.querySelector("main") || document;
      var out = [], cur2 = null;
      [].slice.call(scope.querySelectorAll("button[role='combobox']")).forEach(function (b) {
        var l = d2Norm(MPD.v2LabelOf(b)).toLowerCase().replace(/\s*(\*|\(required\))\s*$/, "");
        if (l !== "provider" && l !== "model") return;
        var v = d2Norm(MPD.v2ComboValue(b));
        if (/^(select provider|pick a provider first|select a model|select model|select|loading.*)$/i.test(v)) v = "";
        if (l === "provider") { cur2 = { provider: v, model: "" }; out.push(cur2); }
        else if (cur2 && !cur2.model) { cur2.model = v; cur2 = null; }
        else out.push({ provider: "", model: v });
      });
      return out;
    }
    var boxes = [].slice.call(document.querySelectorAll("[role='textbox'][aria-label]")).filter(function (b) {
      var l = d2Norm(b.getAttribute("aria-label")).toLowerCase();
      return (l === "provider" || l === "model") && d2Visible(b);
    });
    var pairs = [], cur = null;
    boxes.forEach(function (b) {
      var l = d2Norm(b.getAttribute("aria-label")).toLowerCase();
      var inp = b.matches("input") ? b : b.querySelector("input");
      var v = d2Norm(inp ? inp.value : b.textContent);
      if (l === "provider") { cur = { provider: v, model: "" }; pairs.push(cur); }
      else if (cur && !cur.model) { cur.model = v; cur = null; }
      else pairs.push({ provider: "", model: v });
    });
    return pairs;
  }
  // The selected voice card on Language and Voice: a role=radio button with
  // aria-checked=true whose text leaves are name · provider · model (· tone).
  // The filter chips (All / provider / gender / speed) are radios too, but
  // have a single text leaf and no avatar.
  // New layout: <button role=radio data-choice-card data-value=<tts_voice_id>
  // aria-checked=true aria-label="Name, Provider, model, Gender">; the text
  // leaves there are name · gender · provider · model · tone, so the aria-label
  // is read instead (from the right: a name may itself contain ", ").
  function d2SelectedVoice() {
    if (d2NewUi()) {
      var vc = document.querySelector("[role='radio'][data-choice-card][aria-checked='true']");
      if (!vc) return null;
      var parts = String(vc.getAttribute("aria-label") || "").split(", ").map(d2Norm);
      if (parts.length >= 4) return { name: parts.slice(0, parts.length - 3).join(", "), provider: parts[parts.length - 3], model: parts[parts.length - 2] };
      if (parts.length === 3) return { name: parts[0], provider: parts[1], model: parts[2] };
      return null;
    }
    var cards = [].slice.call(document.querySelectorAll("[role='radio'][aria-checked='true']")).filter(d2Visible);
    for (var i = 0; i < cards.length; i++) {
      var leaves = [].slice.call(cards[i].querySelectorAll("*")).filter(function (e) {
        return !e.children.length && d2Norm(e.textContent);
      }).map(function (e) { return d2Norm(e.textContent); });
      if (leaves.length >= 3 || (cards[i].querySelector("img") && leaves.length >= 2))
        return { name: leaves[0] || "", provider: leaves[1] || "", model: leaves[2] || "" };
    }
    return null;
  }
  async function d2Poll(fn, ms) {
    var end = Date.now() + (ms || 2000), v = null;
    while (true) {
      try { v = fn(); } catch (e) { v = null; }
      if (v || Date.now() >= end) return v;
      await sleep(150);
    }
  }
  // Ask the interceptor for everything it kept; resolve when it answers.
  function d2AskGateway(ms) {
    return new Promise(function (res) {
      var done = false;
      function fin(v) { if (!done) { done = true; res(v); } }
      gwWaiters.push(fin);
      setTimeout(function () { fin(false); }, ms || 2000);
      askInterceptorForLatest();
    });
  }

  // The tour. onStep(label) reports progress. Returns
  // { ok, uiNames, missed:[labels], returnedTo, sections? }.
  async function d2Tour(onStep, needPrompt) {
    if (d2NewUi()) return d2TourV2(onStep, needPrompt);
    var MPI = window.MagicPortImport;
    if (!MPI || typeof MPI.gotoTab !== "function") return { ok: false, reason: "this page's tabs can't be opened by the plugin" };
    var go = function (label, budget) { return MPI.gotoTab(label, { budgetMs: budget || 5000 }); };
    var start = d2CurrentTopTab();
    var uiNames = { llm: null, stt: null, analysis: null, voice: null };
    var missed = [], sections = null;
    async function visit(label, budget) {
      if (onStep) onStep(label);
      var ok = false;
      try { ok = await go(label, budget); } catch (e) { ok = false; }
      if (!ok) missed.push(label);
      return ok;
    }
    if (await visit("LLM and STT")) {
      var pairs = await d2Poll(function () {
        var p = d2ProviderModelPairs();
        return (p.length >= 2 && p[0].provider && p[1].provider) ? p : null;
      }, 2500) || d2ProviderModelPairs();
      if (pairs[0] && (pairs[0].provider || pairs[0].model)) uiNames.llm = { provider: pairs[0].provider, model: pairs[0].model };
      if (pairs[1] && (pairs[1].provider || pairs[1].model)) uiNames.stt = { provider: pairs[1].provider, model: pairs[1].model };
    }
    if (await visit("Language and Voice")) uiNames.voice = await d2Poll(d2SelectedVoice, 2500);
    await visit("Event Subscription");
    if (await visit("Tools")) {
      await sleep(300);
      var phases = ["Pre Call", "On call", "Post Call"];
      for (var i = 0; i < phases.length; i++) {
        if (!d2HasTab(phases[i])) continue;
        await visit(phases[i], 3000);
        await sleep(250);
      }
    }
    if (await visit("Custom Analysis")) {
      var ap = await d2Poll(function () { var p = d2ProviderModelPairs(); return (p[0] && p[0].provider) ? p : null; }, 1200) || d2ProviderModelPairs();
      uiNames.analysis = (ap[0] && ap[0].provider) ? { provider: ap[0].provider, model: ap[0].model } : null;
    }
    // The prompt fields live on the Prompt tab: read them there if the first
    // read (on another tab) found nothing.
    if (needPrompt && await visit("Prompt")) {
      // The tab is selected before its content mounts: wait for both editors.
      await d2Poll(function () { var g = twoFieldEditors(); return !!(g.fm && g.mp); }, 6000);
      try { sections = await runExclusive(collectSections); } catch (e) { sections = null; }
    }
    var back = start || "Prompt";
    if (onStep) onStep("back to " + back);
    var returned = false;
    try { returned = await go(back, 6000); } catch (e) { returned = false; }
    // Let the last responses land before asking for them.
    await sleep(400);
    return { ok: true, uiNames: uiNames, missed: missed, returnedTo: returned ? back : "", start: start, sections: sections };
  }

  // The same read-only tour on the new layout: sidebar sections (by slug, only
  // the open section is mounted) and the Tools phase tabs (Radix: they switch on
  // pointerdown/mousedown, a bare click does nothing). Pre Call is visited so the
  // app loads ?trigger=PRE_CALL. Never types, toggles or saves.
  var D2_V2_LABEL = { "prompt": "Prompt", "custom-variables": "Variables", "language-voice": "Language & voice",
    "llm-stt": "Models", "custom-analysis": "Post-call analysis", "call-config": "Call settings",
    "tools": "Tools", "event-subscription": "Webhooks" };
  async function d2TourV2(onStep, needPrompt) {
    var MPD = window.MagicPortDom, S = MPD.V2_SECTIONS;
    var startSlug = MPD.v2ActiveSection() || "";
    var uiNames = { llm: null, stt: null, analysis: null, voice: null };
    var missed = [], sections = null;
    function ed(label) {
      // compared by value: "&" in a quoted selector value trips some selector engines
      return function () { return [].some.call(document.querySelectorAll("section[aria-label]"), function (s) { return s.getAttribute("aria-label") === label; }); };
    }
    async function visit(slug, ready, budget) {
      var label = D2_V2_LABEL[slug] || slug;
      if (onStep) onStep(label);
      var ok = false;
      try { ok = await MPD.v2GotoSection(slug, ready, budget || 8000); } catch (e) { ok = false; }
      if (!ok) missed.push(label);
      return ok;
    }
    if (await visit(S.llmStt, ed("Models editor"))) {
      var pairs = await d2Poll(function () {
        var p = d2ProviderModelPairs();
        return (p.length >= 2 && p[0].provider && p[1].provider && p[0].model && p[1].model) ? p : null;
      }, 3000) || d2ProviderModelPairs();
      if (pairs[0] && (pairs[0].provider || pairs[0].model)) uiNames.llm = { provider: pairs[0].provider, model: pairs[0].model };
      if (pairs[1] && (pairs[1].provider || pairs[1].model)) uiNames.stt = { provider: pairs[1].provider, model: pairs[1].model };
    }
    if (await visit(S.languageVoice, ed("Language & voice editor"))) uiNames.voice = await d2Poll(d2SelectedVoice, 3000);
    if (await visit(S.events, ed("Webhooks editor"))) await sleep(300);
    if (await visit(S.tools, ed("Tools editor"))) {
      await d2Poll(function () { return d2PhaseTab("on_call"); }, 2500);
      var phases = [["pre_call", "Pre Call"], ["on_call", "On call"], ["post_call", "Post Call"]];
      for (var i = 0; i < phases.length; i++) {
        var tab = d2PhaseTab(phases[i][0]);
        if (!tab) continue;
        // "Soon" phases (Post Call today) do nothing when pressed: skip them.
        if (tab.querySelector("[title='Soon']") || /soon$/i.test(d2Norm(tab.textContent))) continue;
        if (onStep) onStep("Tools → " + phases[i][1]);
        var on = function () { var t = d2PhaseTab(phases[i][0]); return !!t && (t.getAttribute("aria-selected") === "true" || t.getAttribute("data-state") === "active"); };
        for (var a = 0; a < 3 && !on(); a++) {
          MPD.pressSequence(d2PhaseTab(phases[i][0]) || tab);
          await d2Poll(on, 1200);
        }
        if (!on()) missed.push("Tools → " + phases[i][1]);
        await sleep(350);
      }
    }
    if (await visit(S.analysis, ed("Post-call analysis editor"))) {
      var ap = await d2Poll(function () { var p = d2ProviderModelPairs(); return (p[0] && p[0].provider) ? p : null; }, 1500) || d2ProviderModelPairs();
      uiNames.analysis = (ap[0] && ap[0].provider) ? { provider: ap[0].provider, model: ap[0].model } : null;
    }
    // The prompt editors are mounted only on the Prompt section.
    if (needPrompt && await visit(S.prompt, function () { var g = twoFieldEditors(); return !!(g.fm && g.mp); })) {
      try { sections = await runExclusive(collectSections); } catch (e) { sections = null; }
    }
    var backSlug = startSlug || S.prompt, back = D2_V2_LABEL[backSlug] || backSlug;
    if (onStep) onStep("back to " + back);
    var returned = false;
    try { returned = await MPD.v2GotoSection(backSlug, null, 6000); } catch (e) { returned = false; }
    await sleep(400);
    return { ok: true, uiNames: uiNames, missed: missed, returnedTo: returned ? back : "",
      start: startSlug ? back : "", sections: sections };
  }

  function d2CaptureMeta() {
    var gwUrls = {};
    gwStore.forEach(function (c) { gwUrls[c.url] = 1; });
    // Ring-buffer captures of the same gateway URLs are older copies: the
    // keyed store's newest copy goes last so it wins.
    var rest = capturedMeta.filter(function (m) { return !(m && D2_GATEWAY_RE.test(m.url || "") && gwUrls[m.url]); });
    return rest.concat(gwStore);
  }

  async function downloadMagicPortDash2(sections, onStep) {
    if (!window.MagicPort) { toast("Magic Port: couldn't start — reload the page and try again.", null, "info"); return false; }
    // The tour drives the page's tabs: never while another job (a migration) does.
    if (!ppLock("export")) { toast(ppBusyText(), null, "info"); return false; }
    try { return await downloadMagicPortDash2Locked(sections, onStep); }
    finally { ppUnlock("export"); }
  }
  async function downloadMagicPortDash2Locked(sections, onStep) {
    resetIfNavigated();
    var hasPrompt = (sections || []).some(function (x) { return x && x.text && x.text.trim(); });
    var tour;
    try { tour = await d2Tour(onStep, !hasPrompt); }
    catch (e) { tour = { ok: false, reason: String((e && e.message) || e) }; }
    if (!tour.ok) { toast("Magic Port: couldn't read the bot — " + (tour.reason || "the tour failed") + ".", null, "info"); return false; }
    if (tour.sections && tour.sections.some(function (x) { return x && x.text && x.text.trim(); })) sections = tour.sections;
    else if (!hasPrompt) {
      // Never ship a ZIP whose prompt files are only placeholders.
      toast("Magic Port: couldn't read the prompt — open the Prompt section, wait for it to load, then try again.", null, "info");
      return false;
    }
    if (onStep) onStep("collecting");
    var answered = await d2AskGateway(2500);
    resetIfNavigated();
    var promptFiles = magicPortPromptFiles(sections || []);
    var built;
    try {
      built = window.MagicPort.buildConfig({
        platform: "dash2",
        captures: captured.slice(),
        captureMeta: d2CaptureMeta(),
        promptFiles: promptFiles,
        uiNames: tour.uiNames,
        botId: pageBotId(),
        pluginVersion: PP_VERSION
      });
    } catch (e) { built = { ok: false, reason: "the bot data couldn't be read (" + ((e && e.message) || e) + ")" }; }
    if (!built || !built.ok) {
      toast(mpFailText((built && built.reason) || (answered ? "couldn't read this bot" : "no bot data was captured")), null, "info");
      return false;
    }
    var fname = mpZipName();
    saveZip(window.MagicPort.buildZipFiles(built.config, promptFiles), fname);
    var n = ((built.config.data || {}).variables || []).length;
    var msg = "Magic Port ZIP downloaded — " + n + " variables + configs" +
      (built.config.containsCredentials ? " (contains credentials)" : "");
    if (tour.missed.length) msg += ". Couldn't open: " + tour.missed.join(", ") + " — check those parts after importing";
    if (!tour.returnedTo && tour.start) msg += ". Couldn't return to " + tour.start;
    toast(msg);
    _lastDl = "Magic Port ZIP downloaded."; setLinks(true);
    return true;
  }

  // ========================================================================
  //  the 2-field dashboard — export support
  // ========================================================================
  function isTwoField() {
    // the 2-field dashboard (production and QA/dev addresses are listed in
    // manifest.json; host.js matches them).
    return !!(window.PPHost && window.PPHost.layout() === "dash2");
  }

  // The panel's Prompt tab has two TipTap editors, each right after an <h3>
  // label: "First Message" and "Main Prompt". No fallback to "the first editors
  // on the page": on another tab (e.g. Custom Analysis) that would be the wrong
  // editor, so a missing label means "not found".
  function twoFieldEditors() {
    function own(e) {
      var t = "";
      for (var i = 0; i < e.childNodes.length; i++) {
        if (e.childNodes[i].nodeType === 3) t += e.childNodes[i].textContent;
      }
      return t.replace(/\s+/g, " ").trim();
    }
    // New layout: <section aria-label="Prompt editor"> holds one
    // <section aria-labelledby> per field, its <h3> reading "First message" /
    // "Main prompt" (an edited field adds an sr-only "Edited" child, so only the
    // h3's own text counts). Only that section is searched: Post-call analysis
    // has a TipTap editor of its own. Off the Prompt section: not found.
    var proot = document.querySelector('section[aria-label="Prompt editor"]');
    if (proot || d2NewUi()) {
      if (!proot) return { fm: null, mp: null };
      var pe = [].slice.call(proot.querySelectorAll(".ProseMirror"));
      var heads = [].slice.call(proot.querySelectorAll("h1,h2,h3,h4,h5,label"));
      var byHead = function (text) {
        var h = heads.filter(function (e) { return own(e).toLowerCase() === text; })[0];
        if (!h) return null;
        var box = h.closest("section[aria-labelledby]");
        var inBox = box && box !== proot ? box.querySelector(".ProseMirror") : null;
        if (inBox) return inBox;
        for (var i = 0; i < pe.length; i++) if (h.compareDocumentPosition(pe[i]) & 4) return pe[i];
        return null;
      };
      var nf = byHead("first message"), nm = byHead("main prompt");
      if (nf && nm && nf === nm) nf = null;
      return { fm: nf, mp: nm };
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
    if (fm && mp && fm === mp) fm = null;   // the First Message label has no editor of its own
    return { fm: fm, mp: mp };
  }

  // New layout: true when the prompt editors aren't mounted because another
  // section is open (only the Prompt section mounts them).
  function d2OffPrompt() {
    if (!isTwoField() || !d2NewUi()) return false;
    var MPD = window.MagicPortDom;
    if (!MPD || !MPD.v2ActiveSection || !MPD.V2_SECTIONS) return false;
    if (MPD.v2ActiveSection() === MPD.V2_SECTIONS.prompt) return false;
    var g = twoFieldEditors();
    return !(g.fm || g.mp);
  }
  // New layout: run fn() on the Prompt section, then go back to the section
  // the user was on. Only switches sections (edits made elsewhere stay pending;
  // Save / Discard are never pressed) and holds the busy lock (kind) while
  // away. → { ok, value } or { ok:false, why:"busy"|"noprompt" }.
  async function d2OnPromptSection(fn, kind) {
    var MPD = window.MagicPortDom;
    if (!d2OffPrompt()) return { ok: true, value: await fn() };
    if (!ppLock(kind)) return { ok: false, why: "busy" };
    var start = MPD.v2ActiveSection() || "", ready = function () { var g = twoFieldEditors(); return !!(g.fm && g.mp); };
    var subTabs = d2SelectedSubTabs();   // e.g. Tools → "Pre Call": put back after the round trip
    try {
      var went = false;
      try { went = await MPD.v2GotoSection(MPD.V2_SECTIONS.prompt, ready, 9000); } catch (e) { went = false; }
      if (!went) return { ok: false, why: "noprompt" };
      var v = await fn();
      await sleep(350);   // let the app take in an edit before its editor unmounts
      return { ok: true, value: v };
    } finally {
      if (start && MPD.v2ActiveSection() !== start) {
        try { await MPD.v2GotoSection(start, null, 6000); } catch (e) {}
        try { await d2RestoreSubTabs(subTabs); } catch (e) {}
      }
      ppUnlock(kind);
    }
  }
  // The inner tabs selected in the open section (Tools: Pre Call / On call …).
  // A section switch remounts it on its first tab, so a round trip to Prompt
  // records them first and selects them again on return.
  function d2SubTabKey(t) {
    var id = t.id || "", m = /-trigger-(.+)$/.exec(id);
    return { suffix: m ? m[1] : "", text: (t.textContent || "").replace(/\s+/g, " ").trim() };
  }
  function d2SubTabsNow() {
    var main = document.querySelector("main") || document.body;
    return [].slice.call(main.querySelectorAll('[role="tab"]')).filter(function (t) {
      return !t.closest('nav[aria-label="Agent sections"], [role="dialog"], #promptport-host-v41') && t.offsetParent !== null;
    });
  }
  function d2SelectedSubTabs() {
    try {
      return d2SubTabsNow().filter(function (t) { return t.getAttribute("aria-selected") === "true"; }).map(d2SubTabKey);
    } catch (e) { return []; }
  }
  async function d2RestoreSubTabs(keys) {
    if (!keys || !keys.length) return;
    var MPD = window.MagicPortDom;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], tab = null;
      var find = function () {
        tab = d2SubTabsNow().filter(function (t) {
          var c = d2SubTabKey(t);
          return k.suffix ? c.suffix === k.suffix : (k.text && c.text === k.text);
        })[0] || null;
        return !!tab;
      };
      var t0 = Date.now();
      while (!find() && Date.now() - t0 < 3000) await sleep(150);
      if (!tab || tab.getAttribute("aria-selected") === "true") continue;
      try { if (MPD && MPD.pressSequence) MPD.pressSequence(tab); else tab.click(); } catch (e) {}
      await sleep(250);
    }
  }

  async function collectTwoField() {
    // New layout, another section open: read on the Prompt section, then come back.
    if (d2OffPrompt()) { var rp = await d2OnPromptSection(collectTwoFieldHere, "export"); if (rp.ok) return rp.value; }
    return collectTwoFieldHere();
  }
  async function collectTwoFieldHere() {
    var m = twoFieldEditors();
    var prevText = "";
    try { prevText = await navigator.clipboard.readText(); } catch (e) {}
    async function read(el, key) {
      if (!el) return "";
      var cap = await copyEditor(el);
      if (cap.html) return memoMarkdown(key, cap.html, { html: true });
      if (cap.text) return memoMarkdown(key, cap.text, { text: true });
      return "";
    }
    var fm = await read(m.fm, "first-message");
    var mp = await read(m.mp, "main-prompt");
    try { if (prevText) await navigator.clipboard.writeText(prevText); } catch (e) {}
    return [
      { key: "first-message", title: "First Message", filename: "First message.md", text: fm, source: fm ? "ui" : "none" },
      { key: "main-prompt", title: "Main Prompt", filename: "Main Prompt.md", text: mp, source: mp ? "ui" : "none" }
    ];
  }

  // Split a Main Prompt organised under level-1 "# Section" headings back into
  // the 4 Dash5 buckets. Succeeds ONLY when every # heading names a bucket
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
    var secs = window.PPExtract.SECTIONS;
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
  // "# Title" (an <h1>). An escaped "\\# Title" is a PARAGRAPH that starts
  // with a literal "#", never a heading — so it never splits a Main Prompt.
  var ATX_H1_RE = /^ {0,3}#(?!#)[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
  function headingTitle(raw) {
    return String(raw).replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1").replace(/[*_`]+/g, "").trim();
  }
  // Code-fence state for a line-by-line scan: call it with each line; it
  // returns true for a fence line or a line inside a fence. A fence closes only
  // on the SAME character with at least the opening length (CommonMark), so a
  // "```" line inside a "````" block, or "~~~" inside "```", is content.
  function fenceTracker() {
    var open = null;
    return function (L) {
      var m;
      if (open) {
        m = L.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        if (m && m[1].charAt(0) === open.ch && m[1].length >= open.len) open = null;
        return true;
      }
      m = L.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      // a backtick fence's info string can't contain a backtick ("``` x`" is inline code)
      if (m && !(m[1].charAt(0) === "`" && m[2].indexOf("`") !== -1)) { open = { ch: m[1].charAt(0), len: m[1].length }; return true; }
      return false;
    };
  }
  // A setext H1 ("Title" over "===") that names a bucket, written by
  // innerBucketH1s, back to "# Title" (outside code fences).
  function restoreInnerH1s(text) {
    var lines = String(text).split("\n"), inFence = fenceTracker(), out = [];
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (inFence(L)) { out.push(L); continue; }
      if (i + 1 < lines.length && /^ {0,3}=+[ \t]*$/.test(lines[i + 1]) && /\S/.test(L) &&
          (i === 0 || !/\S/.test(lines[i - 1])) && !/^ {0,3}([-*+>#]|\d+[.)]|`{3}|~{3})/.test(L) &&
          canonicalSection(headingTitle(L))) {
        // drop the separator line innerBucketH1s added, and the one escape it added
        if (i > 0 && lines[i - 1] === INNER_H1_GAP && out.length && out[out.length - 1] === INNER_H1_GAP) out.pop();
        var T = L.trim();
        if (/^\\+([-*+>#=]|`{3}|~{3})/.test(T)) T = T.slice(1);
        else if (/^\d+\\+[.)]/.test(T)) T = T.replace(/^(\d+)\\/, "$1");
        out.push("# " + T); i++; continue;
      }
      out.push(L);
    }
    return out.join("\n");
  }
  function splitMainPrompt(md) {
    var lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
    var heads = [], inFence = fenceTracker();
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (inFence(L)) continue;
      var m = L.match(ATX_H1_RE);
      if (!m) continue;
      var title = headingTitle(m[1]);
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
      parts[hd.key] = restoreInnerH1s(lines.slice(hd.line + 1, end).join("\n").trim());
    });
    var pre = lines.slice(0, heads[0].line).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
    if (pre) {
      // Export can't place this text, so 5 Buckets stays off; import keeps it
      // by adding it to the first section (see resolveImportPlan).
      return { ok: false, reason: "There's text above the first # heading in Main Prompt.", pre: pre, parts: parts, firstKey: heads[0].key };
    }
    return { ok: true, parts: parts, found: heads.map(function (x) { return x.key; }) };
  }

  // Turn the two Dash2 fields into the 5 Dash5 buckets — or null if Main Prompt
  // isn't organised under the # headings.
  function twoFieldFiveSections(sections) {
    var byKey = {};
    (sections || []).forEach(function (s) { if (s && s.key) byKey[s.key] = s; });
    var sp = splitMainPrompt(byKey["main-prompt"] ? byKey["main-prompt"].text : "");
    if (!sp.ok) return null;
    return window.PPExtract.SECTIONS.map(function (sec) {
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
      var mp = twoFieldEditors().mp;
      // New layout, another section open: the download reads the Prompt section and checks then.
      if (!mp && d2OffPrompt()) return { ok: true, deferred: true, reason: "" };
      if (!mp) return { ok: false, reason: "Main Prompt editor not found on this page." };
      return splitMainPrompt(window.PPExtract.toMarkdown(liveEditorHtml(mp), { html: true }));
    } catch (e) { return { ok: false, reason: "Couldn't read Main Prompt." }; }
  }

  // An editor's live HTML without the DOM-only decorations the editor adds
  // (they are not part of the saved text): a plain {{x}} the new layout wraps in
  // span.mention-unknown-text, @-suggestion spans, the separator image and the
  // trailing <br> ProseMirror keeps at the end of a block.
  function liveEditorHtml(ed) {
    var c = ed.cloneNode(true);
    [].slice.call(c.querySelectorAll("img.ProseMirror-separator, br.ProseMirror-trailingBreak")).forEach(function (n) { n.remove(); });
    [].slice.call(c.querySelectorAll("span.mention-unknown-text, span.suggestion")).forEach(function (n) {
      if (n.getAttribute("data-type") === "mention") return;
      while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n);
      n.remove();
    });
    return c.innerHTML || "";
  }

  function fallbackSections() { return isTwoField() ? [] : exportFallbackSections(); }

  // One place that performs a download in either format, on either site.
  function doDownload(format, sections) {
    var secs = (sections && sections.length) ? sections : fallbackSections();
    if (format === "magic") {
      return downloadMagicPort(secs);
    }
    // Nothing read from the page (it hasn't loaded its sections): say so, and
    // don't download a ZIP of empty placeholder files.
    if (!secs.some(function (s) { return s && s.text && String(s.text).trim(); })) {
      toast(isTwoField() && d2NewUi()
        ? "Nothing to export — couldn't read the Prompt section. Open it, wait for it to load, then try again."
        : NOTHING_TO_EXPORT, null, "info");
      return false;
    }
    if (format === "two") {
      downloadZipTwo(secs);
      toast("2-bucket ZIP downloaded — First Message + Main Prompt");
      _lastDl = "2-bucket ZIP downloaded."; setLinks(true);
      return true;
    }
    if (isTwoField()) {
      var five = twoFieldFiveSections(secs);
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
    return String(fileName || "").split(/[\\/]/).pop()
      .replace(/\.(md|markdown|txt)$/i, "")
      .replace(/\s*(\(\d+\)|[-_ ]copy(\s*\(?\d+\)?)?)\s*$/i, "")
      .trim();
  }
  function matchSection(fileName) {
    var base = fileStem(fileName);
    var hit = matchStem(base);
    if (hit) return hit;
    // An exported name with something put in front of it ("x10-1730-2_Objective",
    // "Bot - 4_Conversation_Script"): match the numbered export name at the end.
    for (var i = 1; i < base.length; i++) {
      if (!/[-_ .]/.test(base.charAt(i - 1))) continue;
      var tail = base.slice(i);
      if (!/^\d{1,2}[-_ .]+[^\d\s]/.test(tail)) continue;
      hit = matchStem(tail);
      if (hit) return hit;
    }
    return null;
  }
  function matchStem(base) {
    var stripped = base.replace(/^\s*\d+\s*[-_.)\]]*\s*/, ""); // drop "1_", "02-", "7 ", "3."
    var cands = [normName(base)];
    var ns = normName(stripped);
    if (ns && cands.indexOf(ns) === -1) cands.push(ns);
    var secs = window.PPExtract.SECTIONS;
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
  // Removed WITH their content (code, media, embedded documents). Every other
  // non-allowed element is unwrapped: its (cleaned) text stays.
  var SANI_DANGER = { SCRIPT:1,STYLE:1,IFRAME:1,OBJECT:1,EMBED:1,LINK:1,META:1,BASE:1,
    IMG:1,SVG:1,MATH:1,VIDEO:1,AUDIO:1,SOURCE:1,CANVAS:1,INPUT:1,TEMPLATE:1,NOSCRIPT:1,NOEMBED:1,NOFRAMES:1,FRAME:1,FRAMESET:1 };
  // Links may only point at web / mail / phone addresses.
  var SANI_URL_PROTOCOLS = { "http:":1, "https:":1, "mailto:":1, "tel:":1 };
  var SANI_SPAN_CLASSES = { "mention":1, "node-mention":1 };
  function safeUrl(v) {
    // The URL parser ignores C0/C1 control characters and whitespace, so a
    // prefix check on the raw value can be fooled ("\u0001javascript:") — strip
    // them first, then decide by the PARSED protocol.
    var clean = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "").trim();
    if (!clean) return null;
    var proto;
    try { proto = new URL(clean).protocol; } catch (e) { return null; }   // relative → no scheme → dropped
    return SANI_URL_PROTOCOLS[String(proto).toLowerCase()] ? clean : null;
  }
  // Parse an HTML fragment straight into <body> (no wrapper element, so a stray
  // "</div>" in the content can't close the wrapper and cut off the rest).
  function parseBody(html) {
    return new DOMParser().parseFromString("<!doctype html><body>" + String(html == null ? "" : html), "text/html").body;
  }
  var SANI_ATTRS = {
    SPAN: ["data-type","data-id","data-label","data-display-label","data-mention-suggestion-char","class"],
    A: ["href"], TH: ["colspan","rowspan"], TD: ["colspan","rowspan"], CODE: ["class"], PRE: ["class"],
    OL: ["start"]   // a numbered list that continues after a paragraph ("3. …") keeps its number
  };
  var SANI_HTML_NS = "http://www.w3.org/1999/xhtml";
  function sanitizeHtml(html) {
    var root;
    try { root = parseBody(html); }
    catch (e) { return htmlToText(html); }
    if (!root) return htmlToText(html);
    (function clean(node) {
      var kids = Array.prototype.slice.call(node.childNodes);
      kids.forEach(function (ch) {
        if (ch.nodeType === 8) { ch.parentNode.removeChild(ch); return; }   // comment
        if (ch.nodeType !== 1) return;                                       // text ok
        // SVG / MathML elements report lower-case tag names: compare upper-case,
        // and drop anything outside the HTML namespace WITH its content.
        var tag = String(ch.localName || ch.tagName || "").toUpperCase();
        if (SANI_DANGER[tag] || (ch.namespaceURI && ch.namespaceURI !== SANI_HTML_NS)) { ch.parentNode.removeChild(ch); return; }
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
          if (nm === "start" && !/^\d{1,9}$/.test(String(a.value || "").trim())) { ch.removeAttribute(a.name); return; }
          if (nm === "class" && tag === "SPAN") {
            var cls = String(a.value || "").split(/\s+/).filter(function (c) { return SANI_SPAN_CLASSES[c]; });
            if (cls.length) ch.setAttribute("class", cls.join(" ")); else ch.removeAttribute(a.name);
            return;
          }
          if (nm === "href") {
            var u = safeUrl(a.value);
            if (u == null) ch.removeAttribute(a.name); else if (u !== a.value) ch.setAttribute("href", u);
          }
        });
      });
    })(root);
    return root.innerHTML;
  }

  function mdToHtml(md) {
    return sanitizeHtml(renderMarkdown(md)); // never paste unsanitized HTML into the page
  }

  // A bare variable token in the exported markdown, in any of the 3 Dash5 forms:
  //   @{{customer_name}}   custom variable
  //   @((greetings.date))  platform variable
  //   @||send_payment_link|| tool action
  // Dash5's editor turns a pasted <span data-type="mention" data-id="TOKEN"> back
  // into a real variable CHIP (verified live) — but only for text/HTML pastes, and
  // only for variables the assistant actually defines. Bare tokens pasted as plain
  // text stay as literal "@{{…}}" characters, which is the "plain paste" bug.
  var MENTION_TOKEN_RE = /@(?:\{\{[^{}]+\}\}|\(\([^()]+\)\)|\|\|[^|]+\|\|)/g;

  // Walk the text nodes of an HTML string and wrap every bare mention token in a
  // <span data-type="mention" data-id="…"> so the editor re-hydrates the chip.
  // Tokens already inside a mention span are left alone.
  // opts.varsOnly (the 2-field dashboard): its editor only has VARIABLE chips —
  // a mention span for @((…)) or @||…|| becomes a broken "unknown variable"
  // chip ({{{{((x))}}}}), so only @{{…}} is wrapped and the other two forms stay
  // as plain text exactly as written.
  function isVariableToken(tok) { return /^@+\{\{/.test(tok); }
  function hydrateMentions(html, opts) {
    var varsOnly = !!(opts && opts.varsOnly);
    var doc, root;
    try { root = parseBody(html); doc = root.ownerDocument; }
    catch (e) { return String(html || ""); }
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
      // Text inside code is code: a token there stays literal text, never a chip.
      if (p && p.closest && p.closest("code, pre")) return;
      MENTION_TOKEN_RE.lastIndex = 0;
      var frag = doc.createDocumentFragment(), last = 0, m;
      while ((m = MENTION_TOKEN_RE.exec(text))) {
        var tok = m[0];                       // "@{{callee_name}}"
        if (varsOnly && !isVariableToken(tok)) continue; // stays in the text run as written (emitted with the next slice)
        if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
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
  // text/html makes Dash5 render the formatting AND rebuild the variable chips —
  // matching the source, instead of plain-pasting literal markdown.
  // Raw HTML inside the markdown: only FORMATTING tags (the ones the editors
  // have) are kept as tags, and only when they are well-formed: allowed
  // attributes only, and a paired tag only when its closing tag follows in the
  // same block. Everything else that merely LOOKS like a tag — "<select one
  // option>", "<link>", "</div>", "<a lot>", a lone "<b>" — is prompt text and is
  // kept as literal text (never swallowed as an element, never truncating what
  // follows). HTML comments are dropped (exporter placeholders).
  var KNOWN_TAG = /^<(\/?)(b|i|em|strong|u|s|del|strike|code|pre|br|p|ul|ol|li|h[1-6]|blockquote|table|thead|tbody|tr|th|td|hr|a|span)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/i;
  var KNOWN_COMMENT = /^<!--[\s\S]*?-->/;
  var TAG_ATTRS = { a: ["href"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], code: ["class"], pre: ["class"], ol: ["start"],
    span: ["data-type", "data-id", "data-label", "data-display-label", "data-mention-suggestion-char", "class"] };
  var VOID_TAGS = { br: 1, hr: 1 };
  var INLINE_TAGS = { b: 1, i: 1, em: 1, strong: 1, u: 1, s: 1, del: 1, strike: 1, code: 1, a: 1, span: 1 };
  var TAG_MARK_A = "\uFDD0", TAG_MARK_B = "\uFDD1";
  var _tagStash = [];
  // Is this raw tag one we keep? Returns {name, close} or null.
  function formattingTag(raw) {
    var m = raw.match(KNOWN_TAG);
    if (!m || m[0].length !== raw.length) return null;
    var name = m[2].toLowerCase(), close = !!m[1], attrs = m[3] || "";
    if (close && (attrs.trim() || m[4])) return null;
    var allow = TAG_ATTRS[name] || [], seen = {}, ok = true, ar = /([^\s"'>\/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g, am;
    while ((am = ar.exec(attrs))) {
      var an = am[1].toLowerCase(), av = (am[2] || "").replace(/^["']|["']$/g, "");
      if (allow.indexOf(an) === -1 || seen[an]) { ok = false; break; }
      seen[an] = av;
    }
    if (!ok) return null;
    if (name === "span" && !close && seen["data-type"] !== "mention") return null;
    return { name: name, close: close };
  }
  // Each raw tag is stashed behind a marker while marked renders; the markers
  // are resolved once the whole document is known (so pairing can be checked).
  function stashTag(raw) {
    var t = formattingTag(raw);
    if (!t) return esc(raw);
    _tagStash.push({ raw: raw, name: t.name, close: t.close });
    return TAG_MARK_A + (_tagStash.length - 1) + TAG_MARK_B;
  }
  var BLOCK_EDGE = /<\/?(p|li|h[1-6]|td|th|blockquote|pre|ul|ol|table|tr|div|hr)\b/i;
  function resolveTagMarks(html) {
    var re = new RegExp(TAG_MARK_A + "(\\d+)" + TAG_MARK_B, "g"), m, toks = [];
    while ((m = re.exec(html))) toks.push({ i: +m[1], at: m.index, end: m.index + m[0].length });
    if (!toks.length) return html;
    var keep = {}, stack = [];
    toks.forEach(function (tk) {
      var t = _tagStash[tk.i]; if (!t) return;
      if (VOID_TAGS[t.name]) { keep[tk.i] = true; return; }
      if (!t.close) { stack.push(tk); return; }
      for (var j = stack.length - 1; j >= 0; j--) {
        var o = stack[j], ot = _tagStash[o.i];
        if (ot.name !== t.name) continue;
        // An inline tag must open and close inside the same block.
        if (INLINE_TAGS[t.name] && BLOCK_EDGE.test(html.slice(o.end, tk.at).replace(re, ""))) break;
        keep[o.i] = keep[tk.i] = true;
        stack.splice(j, 1);
        break;
      }
    });
    return html.replace(re, function (all, i) {
      var t = _tagStash[+i];
      return !t ? "" : keep[+i] ? t.raw : esc(t.raw);
    });
  }
  var _safeRenderer = null;
  function htmlSafeRenderer() {
    if (_safeRenderer || !window.marked || !window.marked.Renderer) return _safeRenderer;
    var r = new window.marked.Renderer();
    r.html = function (html, block) {
      var src = typeof html === "object" && html ? (html.text || html.raw || "") : String(html || "");
      if (typeof html === "object" && html) block = !!html.block;
      if (block) {
        // An HTML block whose "tags" are all text (e.g. a line starting with
        // "<select one option>") is ordinary markdown: render it as such, with
        // every "<" taken literally.
        var noComments = src.replace(/<!--[\s\S]*?(-->|$)/g, "");
        var anyTag = false, tr = /<\/?[A-Za-z][^>]*>/g, tm;
        while ((tm = tr.exec(noComments))) { if (formattingTag(tm[0])) { anyTag = true; break; } }
        if (!anyTag) {
          if (!noComments.trim()) return "";
          return renderMarkdownRaw(noComments.replace(/</g, "\\<"));
        }
      }
      var out = "", rest = src;
      while (rest.length) {
        var lt = rest.indexOf("<");
        if (lt === -1) { out += esc(rest); break; }
        out += esc(rest.slice(0, lt));
        rest = rest.slice(lt);
        var c = rest.match(KNOWN_COMMENT);
        if (c) { out += c[0]; rest = rest.slice(c[0].length); continue; }
        var m = rest.match(/^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/);
        if (m) { out += stashTag(m[0]); rest = rest.slice(m[0].length); }
        else { out += "&lt;"; rest = rest.slice(1); }
      }
      return out;
    };
    _safeRenderer = r;
    return r;
  }

  // A private marked instance: GFM + "a typed line break stays a line break",
  // with three literal-text rules so text typed in the page survives an
  // export → import round trip exactly:
  //   - "~x~" (single tildes) is text; only "~~x~~" is strikethrough;
  //   - "&nbsp;", "&amp;" typed as text stay those characters (entities are
  //     not decoded in markdown text);
  //   - "1) Greet" at the start of a line is a sentence, not a numbered list
  //     (the editors' own lists export as "1." — see escapeParenLists).
  var _mdInst = null;
  function markedInstance() {
    if (_mdInst) return _mdInst;
    if (!window.marked) return null;
    if (typeof window.marked.Marked !== "function") return null;
    var inst = new window.marked.Marked({ gfm: true, breaks: true, renderer: htmlSafeRenderer() }); // breaks:true — a line break typed in a .md file stays a line break (prompt authors expect that; strict markdown would join the lines)
    var protoTok = window.marked.Tokenizer && window.marked.Tokenizer.prototype;
    inst.use({ tokenizer: {
      // Long blocks are lexed in line-aligned pieces (see mdInlineChunks): marked
      // re-copies the whole inline text once per backslash escape, so one huge
      // paragraph of "1\) step" / "\*" lines took seconds (quadratic).
      paragraph: function (src) {
        var cap = this.rules.block.paragraph.exec(src);
        if (!cap) return undefined;
        var text = cap[1].charAt(cap[1].length - 1) === "\n" ? cap[1].slice(0, -1) : cap[1];
        return { type: "paragraph", raw: cap[0], text: text, tokens: mdInlineChunks(this.lexer, text) };
      },
      text: function (src) {
        var cap = this.rules.block.text.exec(src);
        if (!cap) return undefined;
        return { type: "text", raw: cap[0], text: cap[0], tokens: mdInlineChunks(this.lexer, cap[0]) };
      },
      // A link is looked for in a bounded window: marked's link pattern scans to
      // the next space at every "[", so 100 KB of "[a](" took seconds. A link
      // whose markdown is longer than the window stays text.
      link: function (src) {
        if (src.length <= MD_LINK_MAX || !protoTok || !protoTok.link) return false;
        return protoTok.link.call(this, src.slice(0, MD_LINK_MAX)) || undefined;
      },
      // Only "~~x~~" is strikethrough (single "~" is text). The struck text may
      // itself start/end with a literal "~" ("~~~approx~~~" = struck "~approx~").
      del: function (src) {
        var m = /^~~(?!\s)([\s\S]*?\S)~~(?!~)/.exec(src);
        if (!m) return undefined;
        return { type: "del", raw: m[0], text: m[1], tokens: this.lexer.inlineTokens(m[1]) };
      },
      inlineText: function (src) {
        var t = this.rules.inline.text.exec(src);
        if (!t) return undefined;
        var raw = t[0];
        return { type: "text", raw: raw, text: this.lexer.state.inRawBlock ? raw : raw.replace(/[&<>"']/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        }) };
      }
    } });
    _mdInst = inst;
    return inst;
  }
  // Inline tokens of a long block, lexed in pieces of whole lines (each piece
  // after the first starts with its line break, which still renders as <br>).
  // A piece only ends where nothing can span the break: an even number of
  // backticks so far, and a line not ending in a hard-break marker ("\\" or two
  // spaces). Short blocks (every normal prompt) are lexed whole, as before.
  var MD_CHUNK = 4096, MD_LINK_MAX = 2048;
  function mdInlineChunks(lexer, text) {
    if (text.length <= MD_CHUNK * 2) return lexer.inline(text);
    var tokens = [], lines = text.split("\n"), buf = "", ticks = 0, first = true;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      buf += (i ? "\n" : "") + ln;
      ticks += (ln.match(/`/g) || []).length;
      if (i < lines.length - 1 && buf.length >= MD_CHUNK && ticks % 2 === 0 && !/(\\| {2,})$/.test(ln) && lines[i + 1].trim()) {
        lexer.inline(buf, tokens);   // queued: marked fills `tokens` piece by piece, in order
        buf = ""; first = false;
      }
    }
    if (buf || first) lexer.inline(buf, tokens);
    return tokens;
  }
  // "1) text" / "- 2) text" at a line start → "1\) text" (literal), outside fences.
  function escapeParenLists(md) {
    var inFence = false;
    return String(md == null ? "" : md).split("\n").map(function (line) {
      if (/^\s{0,3}(```|~~~)/.test(line)) { inFence = !inFence; return line; }
      if (inFence) return line;
      return line.replace(/^(\s*(?:(?:[-*+]|\d{1,9}\.)[ \t]+|>[ \t]?)*)(\d{1,9})\)(?=[ \t]|$)/, "$1$2\\)");
    }).join("\n");
  }
  function renderMarkdownRaw(md) {
    var inst = markedInstance();
    if (inst) return inst.parse(String(md == null ? "" : md));
    if (window.marked && window.marked.parse) return window.marked.parse(String(md == null ? "" : md), { gfm: true, breaks: true, renderer: htmlSafeRenderer() });
    return null;
  }
  function renderMarkdown(md) {
    // Control characters (other than tab / line breaks) never reach an editor.
    md = escapeParenLists(String(md == null ? "" : md).replace(/[\uFDD0\uFDD1\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ""));
    var html = null;
    _tagStash = [];
    try { html = renderMarkdownRaw(md); } catch (e) { html = null; }
    if (html == null) {
      html = "<p>" + esc(md).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
    }
    html = resolveTagMarks(String(html));
    _tagStash = [];
    return html;
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

  // Older exports of a damaged 2-field chip carry extra {{ }} wraps:
  // "@{{{{||send_payment_link||}}}}", "@{{{{((greetings.date))}}}}",
  // "@{{{{callee_name}}}}" (sometimes with "\_" escapes inside). Heal them to
  // "@||send_payment_link||", "@((greetings.date))", "@{{callee_name}}" before
  // importing, so a damaged token never travels on as literal text.
  var DAMAGED_TOKEN_RE = /@((?:\{\{){2,})(\(\([^()\n]+\)\)|\|\|[^|\n]+\|\||[A-Za-z0-9_.\\-]+)((?:\}\}){2,})/g;
  function healDamagedTokens(md) {
    return String(md == null ? "" : md).replace(DAMAGED_TOKEN_RE, function (all, open, inner, close) {
      if (open.length !== close.length) return all;
      inner = inner.replace(/([A-Za-z0-9])\\_(?=[A-Za-z0-9])/g, "$1_");
      return /^(\(\(|\|\|)/.test(inner) ? "@" + inner : "@{{" + inner + "}}";
    });
  }

  // How many @((…)) / @||…|| references a markdown text holds — on the 2-field
  // dashboard these are kept as plain text (see hydrateMentions varsOnly).
  function countNonVariableRefs(md) {
    var re = new RegExp(MENTION_TOKEN_RE.source, "g"), m, n = 0, s = healDamagedTokens(md || "");
    while ((m = re.exec(s))) if (!isVariableToken(m[0])) n++;
    return n;
  }
  function plainRefsNote(n) {
    return n ? n + " reference" + (n === 1 ? "" : "s") + " kept as plain text (@((…)) / @||…||): the 2-field dashboard has chips for variables only." : "";
  }

  function mdToHydratedHtml(md) {
    md = protectPipeTokens(healDamagedTokens(md));
    var html = renderMarkdown(md);
    // marked ends every code block with a newline the editor would keep as a
    // real blank line at the bottom of the block — drop it.
    html = String(html).replace(/\n<\/code><\/pre>/g, "</code></pre>");
    html = hydrateMentions(html, { varsOnly: isTwoField() });
    html = sanitizeHtml(html); // keeps mention spans + formatting, strips anything unsafe
    html = collapseStructuralWhitespace(html);
    if (isTwoField()) html = breaksToParagraphs(html);
    return html;
  }

  // The Dash2 editor has no hard line break: a pasted <br> collapses into a
  // space and "line one<br>line two" runs together. Split at each <br> into
  // separate paragraphs instead, so every line stays on its own line.
  var BR_BLOCKS = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote";
  function breaksToParagraphs(html) {
    // The new layout's editor has no code blocks either: a pasted <pre> becomes
    // ONE paragraph with its lines run together. Give each line its own <p>.
    if (/<pre\b/i.test(String(html || "")) && d2NewUi()) html = preToParagraphs(html);
    if (!/<br\b/i.test(String(html || ""))) return String(html || "");
    var doc, root;
    try { root = parseBody(html); doc = root.ownerDocument; }
    catch (e) { return String(html || ""); }
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

  function preToParagraphs(html) {
    var root;
    try { root = parseBody(html); } catch (e) { return String(html || ""); }
    if (!root) return String(html || "");
    var doc = root.ownerDocument;
    [].slice.call(root.querySelectorAll("pre")).forEach(function (pre) {
      var frag = doc.createDocumentFragment();
      String(pre.textContent || "").replace(/\r\n?/g, "\n").split("\n").forEach(function (line) {
        if (!line.trim()) return;                 // an empty <p> would be a stray blank line
        var p = doc.createElement("p");
        p.textContent = line;
        frag.appendChild(p);
      });
      pre.parentNode.replaceChild(frag, pre);
    });
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
    var root;
    try { root = parseBody(html); }
    catch (e) { return String(html || ""); }
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

  // A pasted result is "dirty" if the editor ended up with an empty spacer
  // paragraph / heading — the blank-line artifact. Our source HTML never contains
  // empty blocks (collapseStructuralWhitespace guarantees it) and a clean Dash5
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
      // turns into one clean empty paragraph (verified live on Dash2).
      var clearing = expected === "";
      function curText() { return (editorEl.innerText || editorEl.textContent || "").replace(/\s+/g, " ").trim(); }
      // What was there before: a paste only "registered" if the text changed, or
      // already reads what we sent (a read-only editor that ignored the paste
      // leaves the old text in place — that's a failure, not a success).
      var before = curText();
      // Variable chips read "{{x}}" on the page but "@{{x}}" / "@((x))" in the
      // sent HTML: compare without the chip punctuation, or an identical
      // re-import (nothing changes) is wrongly reported as "didn't take".
      function squash(t) { return String(t || "").replace(/[\s{}()|@\u200b\ufeff]+/g, ""); }
      var sentText = expected;
      try { sentText = parseBody(html).textContent; } catch (e) {}
      function accepted() {
        var now = curText();
        if (expected === "") return now === "";
        if (!now) return false;
        return now !== before || squash(now) === squash(sentText);
      }
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
          var registered = accepted();
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
  //    kind, unmatched, mainWhole } where key is a Dash5 bucket key or
  //    "main-prompt" (a 2-bucket Main Prompt file).
  // 2) resolveImportPlan(src, curMap) maps that source onto THIS site's fields:
  //      Dash5  ← 5-bucket: file → bucket
  //      Dash5  ← 2-bucket: First Message → First Message; Main Prompt split by
  //                         its # headings into the 4 buckets
  //      Dash2 ← 5-bucket: First Message → First Message; 4 buckets collated
  //                         under # headings → Main Prompt
  //      Dash2 ← 2-bucket: both files as-is
  var DASH2_TARGETS = [
    { key: "first-message", title: "First Message", filename: "First message.md" },
    { key: "main-prompt", title: "Main Prompt", filename: "Main Prompt.md" }
  ];
  function siteTargets() {
    return isTwoField() ? DASH2_TARGETS : window.PPExtract.SECTIONS;
  }
  function targetByKey(key) {
    return siteTargets().filter(function (t) { return t.key === key; })[0] || null;
  }

  function isMainPromptName(fileName) {
    var base = fileStem(fileName);
    var n = normName(base.replace(/^\s*\d+\s*[-_.)\]]*\s*/, ""));
    return n === "mainprompt" || n === "systemprompt";
  }

  function isJunkEntry(name) {
    var n = String(name || "").replace(/\\/g, "/");
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
    try { entries = await window.PPUnzip.read(arrayBuffer); }
    catch (e) {
      if (e instanceof RangeError || /DataView|bounds|offset/i.test(String(e && e.message))) {
        throw new Error("The zip looks damaged (its file list points outside the file). Re-export or re-zip it and try again.");
      }
      throw e;
    }
    var src = newSource();
    (entries.skipped || []).forEach(function (s) {
      var sn = String(s.name).split(/[\\/]/).pop();
      if (isJunkEntry(s.name)) return;
      src.unmatched.push(s.why === "not a prompt file" ? sn : sn + " (" + s.why + ")");
    });
    entries.forEach(function (f) {
      if (isJunkEntry(f.name)) return;
      var short = String(f.name).split(/[\\/]/).pop();
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
    // (only a real "# First Message" heading counts — a "First message:" line
    // inside the prompt is content)
    var inFence = false;   // a "# First Message" inside a code fence is content (as in parseSingleMd)
    var hasFmHead = String(text || "").split(/\r?\n/).some(function (L) {
      if (/^\s{0,3}(```|~~~)/.test(L)) { inFence = !inFence; return false; }
      if (inFence) return false;
      var hm = L.match(/^\s{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/);
      var sec = hm ? canonicalSection(hm[1].replace(/[*_`\\]+/g, "").trim()) : null;
      return sec && sec.key === "first-message";
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

    if (!isTwoField()) {
      // ---------------- Dash5 (5 buckets) ----------------
      var bucket = {};
      MAIN_SPLIT_KEYS.forEach(function (k) { if (has(k)) bucket[k] = cleanText(P[k]); });
      if (has("main-prompt")) {
        var mp = String(P["main-prompt"] || "");
        // A "# Main Prompt" title line on top (sections then under "##") is the
        // file's title, not content: drop it so the sections can be split.
        var mpLines = mp.replace(/\r\n?/g, "\n").split("\n"), mpFirst = 0;
        while (mpFirst < mpLines.length && !mpLines[mpFirst].trim()) mpFirst++;
        var mpTitle = mpFirst < mpLines.length && mpLines[mpFirst].match(/^\s{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/);
        if (mpTitle && isMainHeading(mpTitle[1].replace(/[*_`\\]+/g, "").trim())) mp = mpLines.slice(mpFirst + 1).join("\n");
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
      // ---------------- Dash2 (First Message + Main Prompt) ----------------
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
        if (csp.ok || (csp.pre && csp.parts)) {
          // Organised under # headings (text above the first heading is kept
          // where it is): slot the incoming sections in, keep the rest.
          var merged = {};
          MAIN_SPLIT_KEYS.forEach(function (k) { merged[k] = csp.parts[k] || ""; });
          Object.keys(incoming).forEach(function (k) { merged[k] = incoming[k]; });
          var body = collateMain(merged);
          matched.push(mkMatch("main-prompt", csp.pre ? csp.pre + (body ? "\n\n" + body : "") : body));
          notes.push("Only " + names + " will change inside Main Prompt — its other # sections" +
            (csp.pre ? " and the text above its first # heading are" : " are") + " kept.");
        } else {
          matched.push(mkMatch("main-prompt", collateMain(incoming)));
          if (meaningful(cur)) {
            notes.push("The current Main Prompt couldn't be split into its # sections (" +
              String(csp.reason || "no section headings").replace(/\.$/, "") + "), so " + names +
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
    if (emptied.length) notes.push("The file has no content for " + emptied.join(", ") + " — " + (emptied.length === 1 ? "that field" : "those fields") +
      (isTwoField() && d2NewUi() ? " can't be emptied on this dashboard (it keeps the old text) and will be left as is." : " will be emptied."));

    var seen = {};
    matched.forEach(function (m) { seen[m.sec.key] = true; });
    var missing = siteTargets().filter(function (t) { return !seen[t.key]; }).map(function (t) { return t.title; });
    return { matched: matched, unmatched: unmatched, missing: missing, notes: notes, detected: detected };
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
    return runExclusive(collectSections).then(function (cur) {
      var curMap = {};
      (cur || []).forEach(function (c) { curMap[c.key] = c.text || ""; });
      renderImportPlan(resolveImportPlan(src, curMap), curMap, src);
    }).catch(function () { renderImportPlan(resolveImportPlan(src, {}), {}); });
  }

  // The site's editors keyed by field key.
  function siteEditors() {
    var editors = {};
    if (isTwoField()) {
      var g = twoFieldEditors();
      if (g.fm) editors["first-message"] = g.fm;
      if (g.mp) editors["main-prompt"] = g.mp;
      return editors;
    }
    try {
      window.PPExtract.sectionEditors().forEach(function (m) { editors[m.key] = m.el; });
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
      // Parsed in an inert document (never innerHTML on this page's document).
      var tmp = parseBody(html);
      var want = visibleText(tmp), got = visibleText(el);
      if (want === got) return "";
      var strip = function (x) { return x.replace(/[*_~`]/g, ""); };
      if (strip(want) === strip(got)) return "the editor turned some literal * _ ~ ` characters into formatting — review";
      return "text on the page differs from the file — review";
    } catch (e) { return ""; }
  }

  // New layout limits (verified on QA 2026-11-05), reported — never worked around:
  // an empty prompt field can't be stored, and a table makes Save fail (the
  // editor adds style="min-width…" to tables and that request is rejected).
  var V2_NO_CLEAR = "this dashboard can't empty a prompt field (Save keeps the old text) — left as it was";
  function v2TableSaveWarning(el) {
    try {
      if (!d2NewUi() || !el || !el.querySelector("table")) return "";
      return "it holds a table — on this dashboard Save can fail for tables (\"Couldn't save your changes\"); if it does, turn the table into a list and save again";
    } catch (e) { return ""; }
  }

  // Perform the writes. Returns per-section results.
  async function runImport(matched) {
    if (!isTwoField()) {
      try {
        var opened = window.PPExtract.expandCollapsed();
        if (opened) { await sleep(700); window.PPExtract.expandCollapsed(); await sleep(300); }
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
      // New layout: the server ignores an empty prompt field (Save answers OK
      // and the old text comes back), so an empty file can't clear it. Leave
      // the field as it is and say so instead of reporting a clear that won't stick.
      if (d2NewUi() && isTwoField() && !htmlToText(html).replace(/\s+/g, "")) {
        results.push({ title: sec.title, ok: false, reason: V2_NO_CLEAR });
        continue;
      }
      var ok = await pasteHtmlIntoEditor(el, html);
      var res = { title: sec.title, ok: ok, reason: ok ? "" : "the field didn't accept the text (paste not registered)" };
      if (ok) {
        var drift = pasteDrift(html, el);
        if (drift) res.warn = drift;
        var tw = v2TableSaveWarning(el);
        if (tw) res.warn = (res.warn ? res.warn + "; " : "") + tw;
      }
      results.push(res);
      await sleep(150);
    }
    return results;
  }

  // ---- Auto-backup before import (safety net) -----------------------------
  // Snapshot the CURRENT on-screen content of this site's fields (5 Dash5
  // buckets, or Dash2's First Message + Main Prompt). collectSections reads the
  // live editors, so this captures unsaved edits too.
  async function snapshotBuckets() {
    var sections = await collectSections();
    var byKey = {};
    sections.forEach(function (s) { byKey[s.key] = s; });
    var matched = siteTargets().map(function (t) {
      var s = byKey[t.key] || { text: "" };
      return { sec: t, file: { name: t.filename, text: (s.text || "") } };
    });
    return { when: new Date(), sections: sections, matched: matched, importedKeys: [], botId: pageBotId(), pageKey: pageKeyNow() };
  }
  // A backup belongs to the bot (or, with no bot id in the address, the page) it
  // was taken on: Undo is only offered and only allowed there.
  function backupIsHere(b) {
    if (!b) return false;
    if (b.botId) return String(b.botId).toLowerCase() === pageBotId();
    if (b.pageKey) return b.pageKey === pageKeyNow();
    return true;
  }

  function backupWhat() { return isTwoField() ? "First Message + Main Prompt" : "the 5 buckets"; }

  function backupStamp(d) {
    d = d || new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function downloadBackup() {
    if (!_lastBackup) { toast("No backup available yet."); return; }
    try {
      var files = isTwoField() ? sectionsToTwoFiles(_lastBackup.sections) : sectionsToFiles(_lastBackup.sections);
      saveZip(files, "backup-" + fileBase(nameFromUI() || assistantName()) + "-" + backupStamp(_lastBackup.when) + ".zip");
      toast("Backup downloaded — " + backupWhat() + " as they were before this import.");
      setLinks(true);
    } catch (e) { toast("Couldn't build the backup zip."); }
  }

  // Restore the buckets the import overwrote to their pre-import content.
  async function undoLastImport(btn) {
    if (!_lastBackup) { toast("No backup to undo."); return; }
    // A backup belongs to the bot it was taken on.
    if (!backupIsHere(_lastBackup)) {
      toast("This backup belongs to another bot — open that bot to undo, or download the backup.", null, "info");
      return;
    }
    var keepF = focusKeeper();
    if (btn) { btn.disabled = true; btn.textContent = "Undoing…"; }
    setLinks(false);
    // 2-field dashboard: the prompt editors exist only on the Prompt tab (a
    // migration ends on another tab). Go there first, and write only when both
    // labelled prompt editors are found — never into another tab's editor.
    if (isTwoField()) {
      try {
        var MPI = window.MagicPortImport;
        if (!(twoFieldEditors().fm && twoFieldEditors().mp)) {
          if (d2NewUi()) await window.MagicPortDom.v2GotoSection("prompt", function () { var g = twoFieldEditors(); return !!(g.fm && g.mp); }, 6000);
          else if (MPI && typeof MPI.gotoTab === "function") await MPI.gotoTab("Prompt", { budgetMs: 6000 });
        }
        for (var w = 0; w < 20 && !(twoFieldEditors().fm && twoFieldEditors().mp); w++) await sleep(150);
      } catch (e) {}
      var pe = twoFieldEditors();
      if (!(pe.fm && pe.mp)) {
        if (btn) { btn.disabled = false; btn.textContent = "Undo import"; }
        keepF();
        toast("Couldn't find the First Message and Main Prompt editors — open the Prompt tab and try Undo again.", null, "info");
        return;
      }
    }
    var keys = (_lastBackup.importedKeys && _lastBackup.importedKeys.length)
      ? _lastBackup.importedKeys
      : _lastBackup.matched.map(function (m) { return m.sec.key; });
    var restore = _lastBackup.matched.filter(function (m) { return keys.indexOf(m.sec.key) !== -1; });
    var results = await runImport(restore);
    if (_lastBackup) _lastBackup.undone = true;
    showImportResults(results, { undone: true }, btn && btn._gen); keepF();
  }
  // Undo writes the page: under the busy lock like any other import.
  var undoLastImportUnlocked = undoLastImport;
  undoLastImport = async function (btn) {
    if (!ppLock("import")) { toast(ppBusyText(), null, "info"); return; }
    try { return await undoLastImportUnlocked(btn); } finally { ppUnlock("import"); }
  };

  // One file picker for every import entry point. The <input> is never added
  // to the page (a cancelled picker used to leave one behind each time); the
  // last one is only held here so it stays alive while the dialog is open.
  var _pickerInput = null;
  function pickFile(accept, onFile) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    _pickerInput = input;
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      if (_pickerInput === input) _pickerInput = null;
      onFile(file);
    });
    input.addEventListener("cancel", function () { if (_pickerInput === input) _pickerInput = null; });
    input.click();
  }

  // ========================================================================
  //  IMPORT: write a SINGLE .md file back into one or all buckets (smart)
  // ========================================================================
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
    // "- FAQs" / "* Objective" / "+ FAQs" is a bullet point in a list, not a header.
    if (/^(>\s*)*[-*+][ \t]/.test(raw)) return null;
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
    if (byName) {
      // The file NAME says which bucket this is (e.g. an exported
      // "2_Objective.md"). Its content is that bucket's text: bold labels
      // ("**FAQs:**"), "Objective:" lines, bullets and sub-headings that happen
      // to name another bucket are content. Only real "#" headings naming at
      // least two different buckets at the top heading level make it a
      // combined file that is split.
      var mdB = cands.filter(function (c) { return c.level > 0 && c.key !== "main-prompt"; });
      var topL = mdB.length ? Math.min.apply(null, mdB.map(function (c) { return c.level; })) : 0;
      var top = mdB.filter(function (c) { return c.level === topL; });
      var dk = {}; top.forEach(function (c) { dk[c.key] = 1; });
      if (Object.keys(dk).length < 2) {
        var bodyN = whole;
        if (top.length && top[0].key === byName.key) {
          var preN = lines.slice(0, top[0].line).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
          if (!preN) bodyN = lines.slice(top[0].line + 1).join("\n").trim();   // drop its own title line
        }
        return { mode: "single", matched: [{ sec: byName, file: { name: byName.filename, text: bodyN } }], notes: [] };
      }
      heads = top;
    }
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
    var cancel = mkBtn("Cancel", secondaryBtn(), function () { renderImportHome(); });
    row.appendChild(go); row.appendChild(cancel);
    footer().appendChild(row);
    setTimeout(function () { try { group.querySelector("input:checked").focus(); } catch (e) {} }, 50);
  }

  // ========================================================================
  //  DIFF (line-level) — used to preview an import before overwriting
  // ========================================================================
  function normForDiff(s) {
    s = String(s == null ? "" : s).replace(/\r/g, "");
    // On Dash2 a markdown hard break ("two spaces + newline") becomes a new
    // paragraph (that editor has no line breaks), so compare them as equal.
    s = s.replace(/[ \t]+$/gm, "");
    // Lines only: blank lines (paragraph vs line-break, loose vs tight lists) don't count.
    if (isTwoField()) s = s.replace(/\n{2,}/g, "\n");
    // Older and newer exports escape differently ("snake\_case" vs "snake_case",
    // "<b>" vs "\<b>"); the same text must compare equal either way.
    s = s.replace(/([\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, "$1_").replace(/\\</g, "<");
    return s.replace(/\n+$/, "");
  }

  function coarseDiff(a, b) {
    // A Map: a line that reads "hasOwnProperty", "constructor" or "__proto__"
    // is just a line (a plain object would treat those as its own members).
    var mapA = new Map(), mapB = new Map(), i;
    for (i = 0; i < a.length; i++) mapA.set(a[i], (mapA.get(a[i]) || 0) + 1);
    for (i = 0; i < b.length; i++) mapB.set(b[i], (mapB.get(b[i]) || 0) + 1);
    var add = 0, del = 0;
    mapB.forEach(function (nb, k) { var da = nb - (mapA.get(k) || 0); if (da > 0) add += da; });
    mapA.forEach(function (na, k) { var dd = na - (mapB.get(k) || 0); if (dd > 0) del += dd; });
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

  // The searchable editors on this site: Dash5's 5 buckets, or the 2-field
  // page's First Message + Main Prompt.
  function findEditors() {
    if (isTwoField()) {
      var g = twoFieldEditors(), out = [];
      if (g.fm) out.push({ key: "first-message", title: "First Message", el: g.fm });
      if (g.mp) out.push({ key: "main-prompt", title: "Main Prompt", el: g.mp });
      return out;
    }
    try { return window.PPExtract.sectionEditors(); } catch (e) { return []; }
  }
  async function openCollapsedForFind() {
    if (isTwoField()) return;   // both fields are always on screen
    try {
      var opened = window.PPExtract.expandCollapsed();
      if (opened) { await sleep(700); window.PPExtract.expandCollapsed(); await sleep(300); }
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
    if (document.getElementById("pp-find-style")) return;
    var st = document.createElement("style");
    st.id = "pp-find-style";
    st.textContent = "::highlight(pp-find){background:#fde047;color:#000;} " +
                     "::highlight(pp-find-current){background:#fb923c;color:#000;}";
    document.head.appendChild(st);
  }

  // Live "Cmd+F"-style match state shared across the 5 buckets.
  var _findRanges = [];
  var _findIdx = -1;

  function clearHighlights() {
    _findRanges = []; _findIdx = -1;
    try { if (window.CSS && CSS.highlights) { CSS.highlights.delete("pp-find"); CSS.highlights.delete("pp-find-current"); } } catch (e) {}
  }

  // Paint all matches yellow except the current one, which is painted orange.
  function paintFindHighlights() {
    try {
      if (!(window.CSS && CSS.highlights && window.Highlight)) return;
      CSS.highlights.delete("pp-find");
      CSS.highlights.delete("pp-find-current");
      if (!_findRanges.length) return;
      var all = new Highlight();
      for (var i = 0; i < _findRanges.length; i++) if (i !== _findIdx) all.add(_findRanges[i]);
      CSS.highlights.set("pp-find", all);
      if (_findIdx >= 0 && _findRanges[_findIdx]) {
        var cur = new Highlight(); cur.add(_findRanges[_findIdx]);
        CSS.highlights.set("pp-find-current", cur);
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

  // ---- shared text matcher (Find, Replace, highlights) ----
  // Text is matched per BLOCK (paragraph, list item, cell, heading…) on the
  // concatenated text of its text nodes, so a match / whole-word check sees
  // across formatting ("<b>Pay</b>ment" is one word). Variable chips and
  // line breaks are boundaries (never matched, never part of a word), and
  // plain-text references (@{{x}}, @((x)), @||x||) are masked exactly like
  // applyReplace() treats them — Find and Replace never touch them.
  var PLAIN_TOKEN_RE = /@(?:\{\{[^{}]+\}\}|\(\([^()]+\)\)|\|\|[^|]+\|\|)/g;
  var FIND_INLINE_TAGS = { STRONG: 1, B: 1, EM: 1, I: 1, U: 1, S: 1, DEL: 1, STRIKE: 1, INS: 1, A: 1, SPAN: 1, CODE: 1,
    MARK: 1, SUB: 1, SUP: 1, SMALL: 1, FONT: 1, ABBR: 1, Q: 1, CITE: 1, KBD: 1, VAR: 1, SAMP: 1, TIME: 1, DATA: 1, BDI: 1, BDO: 1, LABEL: 1 };
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, NOSCRIPT: 1 };
  var BOUNDARY = "\uFFFC";
  function textBlocks(root) {
    var groups = [], cur = null;
    function visit(n) {
      if (n.nodeType === 3) {
        if (!n.nodeValue) return;
        if (!cur) { cur = { text: "", parts: [] }; groups.push(cur); }
        cur.parts.push({ node: n, start: cur.text.length });
        cur.text += n.nodeValue;
        return;
      }
      if (n.nodeType !== 1) return;
      if (SKIP_TAGS[n.nodeName]) return;
      if (n.matches && n.matches(MENTION_SEL)) { if (cur) cur.text += BOUNDARY; return; }   // chip: a boundary, never searched
      if (n.nodeName === "BR" || n.nodeName === "IMG" || n.nodeName === "HR") { if (cur) cur.text += BOUNDARY; return; }
      var block = !FIND_INLINE_TAGS[n.nodeName];
      if (block) cur = null;
      for (var c = n.firstChild; c; c = c.nextSibling) visit(c);
      if (block) cur = null;
    }
    for (var c = root.firstChild; c; c = c.nextSibling) visit(c);
    return groups;
  }
  function maskTokens(text) {
    return text.replace(PLAIN_TOKEN_RE, function (t) { return t.replace(/[\s\S]/g, BOUNDARY); });
  }
  // [{start, end}] matches in one block's text.
  function blockMatches(text, query, opts) {
    var re = findRegex(query, opts), masked = maskTokens(text), out = [], mm;
    while ((mm = re.exec(masked))) {
      if (mm[0].length === 0) { re.lastIndex++; continue; }
      out.push({ start: mm.index, end: mm.index + mm[0].length });
    }
    return out;
  }
  // Group offset → { node, offset } (end positions bind to the earlier node).
  function partAt(g, pos, isEnd) {
    for (var i = 0; i < g.parts.length; i++) {
      var p = g.parts[i], len = p.node.nodeValue.length;
      if (pos >= p.start && (isEnd ? pos <= p.start + len : pos < p.start + len)) return { node: p.node, offset: pos - p.start };
    }
    return null;
  }
  // Rewrite matches (last first, so earlier offsets stay valid): the
  // replacement goes into the node where the match starts; the rest of a match
  // that spans formatting is removed from the following nodes.
  function replaceInBlocks(groups, query, repl, opts) {
    var count = 0;
    groups.forEach(function (g) {
      var ms = blockMatches(g.text, query, opts);
      count += ms.length;
      for (var k = ms.length - 1; k >= 0; k--) {
        var s0 = ms[k].start, e0 = ms[k].end, first = true;
        g.parts.forEach(function (p) {
          var v = p.node.nodeValue, ps = p.start, pe = p.start + v.length;
          if (pe <= s0 || ps >= e0) return;
          var a = Math.max(s0, ps) - ps, b = Math.min(e0, pe) - ps;
          if (first && ps <= s0) { p.node.nodeValue = v.slice(0, a) + repl + v.slice(b); first = false; }
          else p.node.nodeValue = v.slice(0, a) + v.slice(b);
        });
      }
    });
    return count;
  }

  // Replace inside an editor's own copied HTML — the same text Find searches —
  // never inside variable chips or plain-text references, and never across
  // markdown syntax (so "[END CALL]", "#", "|" or "*" behave like plain text).
  function replaceInHtml(html, query, replacement, opts) {
    var doc = new DOMParser().parseFromString("<div id='__rr'>" + String(html || "") + "</div>", "text/html");
    var root = doc.getElementById("__rr");
    var count = replaceInBlocks(textBlocks(root), query, String(replacement == null ? "" : replacement), opts);
    return { html: root.innerHTML, count: count };
  }

  // New layout, another section open: live typing never switches sections
  // (res.offPrompt); an explicit Find (opts.navigate) searches on the Prompt
  // section and comes back — the counts stay, the highlights can't.
  async function findAll(query, opts) {
    if (query && d2OffPrompt()) {
      clearHighlights();
      var off = { total: 0, per: [], supported: !!(window.CSS && CSS.highlights && window.Highlight), offPrompt: true };
      if (!(opts && opts.navigate)) return off;
      var r = await d2OnPromptSection(function () { return findAllHere(query, opts); }, "export");
      clearHighlights();   // painted on the Prompt section, which is closed again
      if (!r.ok) { off.notOpened = r.why; return off; }
      r.value.offPrompt = true; r.value.searched = true;
      return r.value;
    }
    return findAllHere(query, opts);
  }
  async function findAllHere(query, opts) {
    clearHighlights();
    ensureHighlightStyle();
    var res = { total: 0, per: [], supported: !!(window.CSS && CSS.highlights && window.Highlight) };
    if (!query) return res;
    await openCollapsedForFind();
    var map = findEditors();

    var ranges = [], fieldOnly = 0;
    for (var s = 0; s < map.length; s++) {
      var host = editorHost(map[s].el);
      if (!host) continue;
      var count = 0;
      if (host.tagName === "TEXTAREA" || host.tagName === "INPUT") {
        // A form field: search its LIVE value (its child text is only the
        // default). The CSS highlight can't paint inside a field, so these
        // matches are counted but not highlighted.
        count = applyReplace(host.value || "", query, "", opts).count;
        fieldOnly += count;
      } else {
        textBlocks(host).forEach(function (g) {
          blockMatches(g.text, query, opts).forEach(function (m) {
            var a = partAt(g, m.start, false), b = partAt(g, m.end, true);
            if (!a || !b) return;
            try {
              var r = document.createRange();
              r.setStart(a.node, a.offset);
              r.setEnd(b.node, b.offset);
              ranges.push(r);
              count++;
            } catch (e) {}
          });
        });
      }
      if (count) res.per.push({ title: map[s].title, count: count });
    }

    res.total = ranges.length + fieldOnly;
    if (fieldOnly) res.unpainted = fieldOnly;
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

  // New layout, another section open: replace on the Prompt section (the edit
  // stays pending in the page-wide save bar), then come back.
  async function replaceAllBuckets(query, replacement, opts) {
    if (d2OffPrompt()) {
      var r = await d2OnPromptSection(function () { return replaceAllHere(query, replacement, opts); }, "replace");
      if (r.ok) return r.value;
      var none = []; none.notOpened = r.why; return none;
    }
    return replaceAllHere(query, replacement, opts);
  }
  async function replaceAllHere(query, replacement, opts) {
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
          results.push({ title: m.title, n: rep0.count, ok: true, undo: { el: m.el, key: m.key, value: md, after: rep0.text } });
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
        // What the field held before, so the panel can undo the replace (the
        // editor's own Ctrl+Z does not reliably revert a scripted paste).
        var beforeHtml = cap.html ? collapseStructuralWhitespace(sanitizeHtml(cap.html)) : mdToHydratedHtml(cap.text || "");
        // New layout: a field emptied by the replace can't be stored — left as is.
        if (d2NewUi() && isTwoField() && !htmlToText(outHtml).replace(/\s+/g, "")) {
          results.push({ title: m.title, n: count, ok: false, warn: V2_NO_CLEAR, undo: null });
          continue;
        }
        var ok = await pasteHtmlIntoEditor(m.el, outHtml);
        var rr = { title: m.title, n: count, ok: ok, undo: ok ? { el: m.el, key: m.key, html: beforeHtml } : null };
        // The page's editor may turn * _ ~ ` in the replacement into formatting — say so.
        if (ok) { var dr = pasteDrift(outHtml, m.el); if (dr) rr.warn = dr; }
        if (ok) { var tw2 = v2TableSaveWarning(m.el); if (tw2) rr.warn = (rr.warn ? rr.warn + "; " : "") + tw2; }
        results.push(rr);
      }
      await sleep(150);
    }

    try { if (prevClip) await navigator.clipboard.writeText(prevClip); } catch (e) {}
    // What each field holds right after the replace — Undo checks it, so text
    // the user typed afterwards is never silently thrown away.
    results.forEach(function (r) { if (r.undo && typeof r.undo.value !== "string") r.undo.after = fieldSignature(r.undo.el); });
    return results;
  }

  // A rich editor's content, for "did the user edit it since?": its text plus
  // the variables its chips hold (selection / highlight state doesn't count).
  function fieldSignature(el) {
    var host = editorHost(el);
    if (!host) return "";
    if (host.tagName === "TEXTAREA" || host.tagName === "INPUT") return host.value || "";
    var ids = [].map.call(host.querySelectorAll(MENTION_SEL), function (c) { return c.getAttribute("data-id") || c.textContent; });
    return (host.textContent || "") + "\u0001" + ids.join("\u0002");
  }

  // Put back what replaceAllBuckets() changed, field by field. A field that
  // changed after the replace is skipped (changed: true) — never overwritten.
  // An editor the page re-mounted (e.g. the user left the section and came
  // back) is found again by its field key; its content check below still applies.
  async function undoReplaceAll(results) {
    if (d2OffPrompt() && results.some(function (r) { return r.undo && r.undo.el && !r.undo.el.isConnected; })) {
      var r = await d2OnPromptSection(function () { return undoReplaceHere(results); }, "replace");
      if (r.ok) return r.value;
    }
    return undoReplaceHere(results);
  }
  async function undoReplaceHere(results) {
    var out = [];
    for (var i = 0; i < results.length; i++) {
      var u = results[i].undo;
      if (u && u.el && !u.el.isConnected && u.key) {
        var re = findEditors().filter(function (x) { return x.key === u.key && x.el; })[0];
        if (re) u.el = re.el;
      }
      if (!u || !u.el || !u.el.isConnected) { if (results[i].ok) out.push({ title: results[i].title, ok: false }); continue; }
      var now = typeof u.value === "string" ? (u.el.value || "") : fieldSignature(u.el);
      if (typeof u.after === "string" && now !== u.after) { out.push({ title: results[i].title, ok: false, changed: true }); continue; }
      var ok = false;
      try {
        if (typeof u.value === "string") {
          var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(u.el), "value").set;
          setter.call(u.el, u.value); u.el.dispatchEvent(new Event("input", { bubbles: true })); ok = true;
        } else ok = await pasteHtmlIntoEditor(u.el, u.html);
      } catch (e) { ok = false; }
      out.push({ title: results[i].title, ok: ok });
      await sleep(120);
    }
    return out;
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
.rs-launcher{position:fixed;right:22px;bottom:22px;z-index:2147483647;display:inline-flex;align-items:center;gap:12px;
  min-height:62px;min-width:94px;justify-content:center;box-sizing:border-box;padding:10px 24px;border:2px solid var(--ink);border-radius:3px;cursor:pointer;
  color:var(--white);background:var(--ink);box-shadow:4px 5px 0 var(--steel);font-size:17px;font-weight:bold;
  transition:transform var(--rs-dur) var(--rs-ease),box-shadow var(--rs-dur) var(--rs-ease)}
.rs-ver{position:absolute;left:5px;top:4px;font-size:9px;line-height:1;font-weight:700;letter-spacing:.02em;opacity:.85;pointer-events:none}
.rs-launcher:hover{transform:translate(-1px,-1px);box-shadow:5px 6px 0 var(--steel)}
.rs-launcher:active{transform:translate(1px,1px);box-shadow:2px 2px 0 var(--steel)}
.rs-launcher.rs-tucked{transform:translateX(calc(100% - 14px))}
.rs-launcher.rs-tucked:hover{transform:translateX(calc(100% - 53px))}
.rs-star{width:22px;height:22px;flex:none;display:block}
.rs-launcher .rs-badge{border-radius:2px;padding:1px 10px;font-size:14px;line-height:24px}
.rs-badge{background:var(--white);color:var(--ink);border-radius:var(--sk);padding:1px 8px;font-size:12px;line-height:20px}
.rs-badge:empty{display:none}
.rs-launcher.rs-tucked .rs-badge{display:none}
.rs-launcher .rs-badge{animation:rs-badge-in .32s cubic-bezier(.34,1.56,.64,1)}
@keyframes rs-badge-in{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:none}}
/* ---- panel shell ---- */
.rs-panel{position:fixed;right:22px;bottom:100px;z-index:2147483647;width:392px;max-width:calc(100% - 32px);
  max-height:min(780px,calc(100vh - 118px));display:flex;flex-direction:column;box-sizing:border-box;
  background:var(--white);border:2px solid var(--ink);border-radius:22px 9px 20px 11px/11px 20px 9px 22px;box-shadow:5px 6px 0 var(--ink);
  font-size:13px;line-height:1.45;transform-origin:bottom right}
/* another PromptPort build in the same corner: launcher above its launcher, panel
   beside its panel (or above both launchers when the window is too narrow) */
:host([data-pp-coexist]) .rs-launcher{bottom:96px}
:host([data-pp-coexist]) .rs-panel{bottom:174px;max-height:min(780px,calc(100vh - 192px))}
.rs-panel.rs-enter{animation:rs-in .24s var(--rs-ease)}
.rs-panel.rs-swap{overflow-x:clip}
@keyframes rs-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
.rs-top{flex:none}
.rs-phead{display:flex;align-items:center;gap:8px;padding:6px 8px 0 18px;min-height:44px}
.rs-trust{flex:1;min-width:0;display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--steel)}
.rs-trust svg{flex:none}
.rs-trust-t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rs-links{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}
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
.rs-body.rs-more{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 26px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 26px),transparent)}
.rs-foot{flex:none;padding:14px 18px 14px;border-top:2px dashed var(--ash);background:var(--white);border-radius:0 0 18px 9px}
.rs-foot:empty{display:none}
.rs-foot>:first-child{margin-top:0}
/* ---- text ---- */
.rs-note,.rs-muted{color:var(--graphite);font-size:12.5px;line-height:1.55;margin:10px 0}
.rs-muted{font-size:11.5px;color:var(--steel)}
.rs-lead{font-size:13px;line-height:1.55;margin:0 0 12px;min-width:0;overflow-wrap:anywhere}
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
.rs-cname{font-weight:bold;font-size:13px;overflow-wrap:anywhere}
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
.rs-btn:disabled,.rs-btn[aria-disabled="true"]{background:var(--white) var(--hatch);color:var(--graphite);border-style:dashed;border-color:var(--steel);box-shadow:none;cursor:not-allowed;transform:none}
.rs-row.rs-three{display:grid;grid-template-columns:1fr 1.35fr 1fr;gap:10px}
.rs-btn svg{width:auto}
.rs-ctas{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.rs-cta.rs-cta-wide{display:flex;width:100%;margin-top:12px;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:center;gap:0 8px;min-height:41px;height:auto;padding:4px 14px}
.rs-cta.rs-cta-wide svg{width:24px;height:19px;flex:none}
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
.rs-callout>div{min-width:0;overflow-wrap:anywhere}
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
.rs-line-label{font-weight:bold;font-size:13px;overflow-wrap:anywhere}
.rs-line-meta{color:var(--steel);font-size:11.5px;text-align:right;max-width:58%;line-height:1.4;overflow-wrap:anywhere}
.rs-line-sub{font-size:11.5px;color:var(--graphite);line-height:1.45;overflow-wrap:anywhere}
.rs-line.skip .rs-line-label{color:var(--graphite)}
.rs-donehead{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.rs-donehead-t{font-size:15px;font-weight:bold;line-height:1.25;overflow-wrap:anywhere}
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
.rs-toasts{position:fixed;right:22px;bottom:94px;max-width:calc(100vw - 44px);z-index:2147483647;display:flex;flex-direction:column;gap:8px;align-items:flex-end}
.rs-toast{display:flex;align-items:center;gap:9px;line-height:1.4;background:var(--white);border:2px solid var(--ink);border-radius:var(--sk2);
  padding:8px 13px;box-shadow:3px 3px 0 var(--ink);font-size:12px;font-weight:bold;color:var(--ink);animation:rs-toast-in .3s var(--rs-ease);box-sizing:border-box;min-height:62px}
@keyframes rs-toast-in{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}
.rs-tic{width:20px;height:20px;flex:none;display:block}
.rs-undo{margin-left:4px;cursor:pointer;font-weight:bold;text-decoration:underline}
/* ---- a11y + small windows ---- */
.rs-launcher:focus-visible,.rs-x:focus-visible,.rs-tab:focus-visible,.rs-btn:focus-visible,.rs-textbtn:focus-visible,.rs-iconbtn:focus-visible,
.rs-dropzone:focus-visible,.rs-view-changes:focus-visible,.rs-linkic:focus-visible,.rs-check:focus-within,.rs-choice:focus-within{outline:2px solid var(--ink);outline-offset:2px}
.rs-tab:focus-visible{outline-offset:2px;border-radius:var(--sk)}
@media (max-height:620px){.rs-trust-t{display:none}.rs-cta{min-height:96px}.rs-cta svg{width:44px;height:34px}}
@media (max-height:560px){.rs-cta:not(.rs-cta-wide){min-height:76px;padding:8px 6px 7px;gap:2px}.rs-cta:not(.rs-cta-wide) svg{width:32px;height:25px}.rs-cta.rs-cta-wide{min-height:37px;margin-top:8px}}
@media (max-height:560px){.rs-panel{overflow-y:auto;overscroll-behavior:contain}.rs-panel>.rs-body{flex:none;overflow:visible}.rs-panel>.rs-foot{position:sticky;bottom:0;z-index:1}.rs-panel.rs-foot-free>.rs-foot{position:static}}
@media (max-height:420px){.rs-panel .rs-foot{padding-top:7px;padding-bottom:7px}.rs-cta:not(.rs-cta-wide){min-height:40px}.rs-cta:not(.rs-cta-wide)::after{display:none}.rs-foot-meta .rs-textbtn{min-height:28px;padding:2px 8px}}
@media (max-height:480px){.rs-phead{min-height:34px;padding-top:2px}.rs-x{width:36px;height:36px}.rs-tab{min-height:34px;padding:6px 4px 8px}.rs-foot{padding:9px 14px 9px}.rs-cta:not(.rs-cta-wide){min-height:48px;padding:6px 6px}.rs-cta:not(.rs-cta-wide) svg{display:none}.rs-cta.rs-cta-wide{min-height:35px;margin-top:6px}.rs-foot-meta{margin-top:2px}}
/* ---- motion system: paper, ink and springs (all off under reduced-motion) ---- */
:host{--rs-spring:cubic-bezier(.34,1.56,.64,1);--rs-out:cubic-bezier(.16,1,.3,1)}
@keyframes rs-in{0%{opacity:0;transform:translate(22px,34px) scale(.8) rotate(3.5deg)}55%{opacity:1;transform:translate(-2px,-4px) scale(1.018) rotate(-.7deg)}78%{transform:translate(1px,1px) scale(.996) rotate(.25deg)}100%{opacity:1;transform:none}}
.rs-panel.rs-enter{animation:rs-in .6s var(--rs-out)}
@keyframes rs-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes rs-fade{from{opacity:.2}to{opacity:1}}
@keyframes rs-slide-r{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:none}}
@keyframes rs-slide-l{from{opacity:0;transform:translateX(-30px)}to{opacity:1;transform:none}}
@keyframes rs-sheet{0%{opacity:0;transform:translateY(-18px) rotate(var(--rs-r,-2.5deg)) scale(.97)}60%{opacity:1;transform:translateY(2px) rotate(calc(var(--rs-r,-2.5deg) * -.3))}100%{opacity:1;transform:none}}
@keyframes rs-draw{to{stroke-dashoffset:0}}
@keyframes rs-popin{0%{transform:scale(.3) rotate(-25deg);opacity:0}55%{transform:scale(1.25) rotate(6deg);opacity:1}80%{transform:scale(.94)}100%{transform:none;opacity:1}}
@keyframes rs-twinkle{0%,100%{transform:none;opacity:1}50%{transform:scale(1.8) rotate(90deg);opacity:.75}}
@keyframes rs-shake{0%,100%{transform:none}15%{transform:translateX(-6px) rotate(-7deg)}30%{transform:translateX(6px) rotate(6deg)}45%{transform:translateX(-4px) rotate(-4deg)}60%{transform:translateX(4px) rotate(3deg)}80%{transform:translateX(-2px)}}
@keyframes rs-bob{0%,100%{transform:none}50%{transform:translateY(-5px)}}
@keyframes rs-dive{0%,100%{transform:none}45%{transform:translateY(9px)}}
@keyframes rs-spin{to{transform:rotate(360deg)}}
@keyframes rs-squig-slide{from{transform:translateX(var(--rs-from,0)) scaleX(1.6)}to{transform:none}}
@keyframes rs-hello{0%,100%{transform:none}20%{transform:rotate(-4deg) scale(1.04)}40%{transform:rotate(3.5deg) scale(1.04)}60%{transform:rotate(-2deg)}80%{transform:rotate(1deg)}}
@keyframes rs-hello-star{from{transform:none}to{transform:rotate(360deg) scale(1)}}
@keyframes rs-timer{to{transform:scaleX(0)}}
@keyframes rs-shine{from{transform:translateX(-120%) skewX(-20deg)}to{transform:translateX(220%) skewX(-20deg)}}
@keyframes rs-march{to{stroke-dashoffset:-24}}
@keyframes rs-catch{0%,100%{transform:none}12%{transform:scale(1.06) rotate(-1deg)}30%{transform:none}}
@keyframes rs-breathe{0%,100%{opacity:.55}50%{opacity:1}}
/* overlay layer for bursts, confetti and flying files */
.rs-fx{position:fixed;inset:0;pointer-events:none;z-index:2147483647}
.rs-fx-ray{position:fixed;width:3px;height:10px;border-radius:2px;background:var(--ink);pointer-events:none;display:block}
.rs-fx-bit{position:fixed;margin:-4px 0 0 -4px;pointer-events:none;display:block}
.rs-fx-rect{width:6px;height:11px;border-radius:1px}
.rs-fx-dot{width:8px;height:8px;border-radius:50%}
.rs-fx-star svg,.rs-fx-squig svg{display:block}
.rs-fx-file{position:fixed;width:30px;height:30px;pointer-events:none;display:block;filter:drop-shadow(2px 3px 0 rgba(0,0,0,.18))}
/* screen changes inside an open panel: slide toward the chosen tab, or cross-fade */
.rs-panel.rs-swap .rs-body,.rs-panel.rs-swap .rs-foot{animation:rs-fade .22s ease-out}
.rs-panel.rs-swap.rs-dir-r .rs-body,.rs-panel.rs-swap.rs-dir-r .rs-foot{animation:rs-slide-r .38s var(--rs-out)}
.rs-panel.rs-swap.rs-dir-l .rs-body,.rs-panel.rs-swap.rs-dir-l .rs-foot{animation:rs-slide-l .38s var(--rs-out)}
/* buttons: lift on hover, squash-and-stamp into the paper on press */
.rs-btn{transition:transform .28s var(--rs-spring),box-shadow .2s var(--rs-out),background .2s,opacity .25s;position:relative;overflow:hidden}
.rs-btn-primary:not(:disabled):not([aria-disabled="true"]):hover,.rs-btn-danger:not(:disabled):hover{transform:translate(-2px,-2px);box-shadow:5px 5px 0 var(--steel)}
.rs-btn-ghost:not(:disabled):hover{transform:translate(-1px,-1px)}
.rs-btn:not(:disabled):not([aria-disabled="true"]):active,.rs-cta:not(:disabled):active{transform:translate(3px,3px) scale(.97,.94);box-shadow:0 0 0 var(--ink);transition-duration:.06s}
/* press feedback that also shows on a quick trackpad tap or a key press (:active alone is too brief):
   the button stamps into the paper (shadow collapses), its icon squashes, an ink ripple spreads from the
   touch point, and on release it springs back past its rest position */
.rs-btn,.rs-cta{position:relative;isolation:isolate}
.rs-btn.rs-pressed,.rs-cta.rs-pressed{transform:translate(3px,3px) scale(.97,.94)!important;box-shadow:0 0 0 var(--ink)!important;transition-duration:.06s!important}
.rs-cta.rs-cta-wide.rs-pressed{transform:translate(3px,3px) scale(.985,.9)!important}
.rs-cta svg{transition:transform .25s var(--rs-spring)}
.rs-cta.rs-pressed svg{transform:scale(.88,.84);transition-duration:.06s}
.rs-panel .rs-btn.rs-popped,.rs-panel .rs-cta.rs-popped{animation:none}
.rs-panel .rs-btn.rs-pop,.rs-panel .rs-cta.rs-pop{animation:rs-press-pop .46s var(--rs-spring)}
.rs-panel .rs-cta.rs-cta-wide.rs-pop{animation:rs-press-pop-wide .46s var(--rs-spring)}
@keyframes rs-press-pop{0%{transform:translate(3px,3px) scale(.97,.94)}55%{transform:translate(-1px,-2px) scale(1.02,1.04)}100%{transform:none}}
@keyframes rs-press-pop-wide{0%{transform:translate(3px,3px) scale(.985,.9)}55%{transform:translate(-1px,-1px) scale(1.01,1.06)}100%{transform:none}}
.rs-rip-wrap{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none;z-index:-1}
.rs-rip{position:absolute;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:currentColor;opacity:.22;transform:scale(0);animation:rs-rip .55s var(--rs-out) forwards}
@keyframes rs-rip{to{transform:scale(var(--rs-rip-s,30));opacity:0}}
/* a tile that is preparing its download: moving hatch, so "working" is visible at a glance */
.rs-panel .rs-cta.rs-preparing{cursor:progress;background-image:repeating-linear-gradient(-45deg,rgba(0,0,0,.07) 0 6px,transparent 6px 12px);background-size:16.97px 16.97px;animation:rs-hatch .9s linear infinite}
@keyframes rs-hatch{to{background-position:16.97px 0}}
.rs-panel .rs-cta.rs-preparing.rs-pop{animation:rs-press-pop .46s var(--rs-spring),rs-hatch .9s linear infinite}
.rs-btn.rs-shine::after{content:"";position:absolute;top:-10%;bottom:-10%;left:0;width:40%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:rs-shine .75s var(--rs-out) forwards;pointer-events:none}
/* download tiles: pages fan out like a hand of cards; Magic Port's cube hops and its arrow orbits */
.rs-cta{transition:transform .3s var(--rs-spring),box-shadow .2s var(--rs-out),background .2s}
.rs-cta:not(:disabled):not([aria-disabled="true"]):hover{transform:translate(-2px,-3px) rotate(-.6deg);box-shadow:5px 6px 0 var(--ink)}
.rs-cta:nth-child(even):not(:disabled):not([aria-disabled="true"]):hover{transform:translate(-2px,-3px) rotate(.6deg)}
.rs-cta.rs-cta-wide:not(:disabled):not([aria-disabled="true"]):hover{transform:translate(-1px,-2px);box-shadow:4px 5px 0 var(--ink)}
.rs-pg,.rs-pt,.rs-cube,.rs-orbit{transform-box:view-box;transition:transform .5s var(--rs-spring)}
.rs-pg,.rs-pt{transform-origin:29px 46px}
.rs-cta:not(:disabled):not([aria-disabled="true"]):hover .rs-pg1{transform:translate(-7px,1px) rotate(-11deg)}
.rs-cta:not(:disabled):not([aria-disabled="true"]):hover .rs-pg2{transform:translate(-3.5px,-1px) rotate(-5.5deg)}
.rs-cta:not(:disabled):not([aria-disabled="true"]):hover .rs-pg3{transform:translateY(-4px)}
.rs-cta:not(:disabled):not([aria-disabled="true"]):hover .rs-pg4{transform:translate(3.5px,-1px) rotate(5.5deg)}
.rs-cta:not(:disabled):not([aria-disabled="true"]):hover .rs-pg5{transform:translate(7px,1px) rotate(11deg)}
.rs-cta:not(:disabled):not([aria-disabled="true"]):hover .rs-pt1{transform:translate(-6px,-1px) rotate(-10deg)}
.rs-cta:not(:disabled):not([aria-disabled="true"]):hover .rs-pt2{transform:translate(6px,-2px) rotate(8deg)}
.rs-cube,.rs-orbit{transform-origin:22px 26px}
.rs-orbit{transition:transform .8s var(--rs-out)}
.rs-cta:not(:disabled):not([aria-disabled="true"]):hover .rs-cube{transform:translateY(-4px) rotate(-10deg) scale(1.06)}
.rs-cta:not(:disabled):not([aria-disabled="true"]):hover .rs-orbit{transform:rotate(360deg)}
.rs-spark{transform-box:fill-box;transform-origin:center}
.rs-cta:not(:disabled):not([aria-disabled="true"]):hover .rs-spark{animation:rs-twinkle .7s var(--rs-out) .15s}
.rs-ctas>.rs-cta{animation:rs-rise .45s var(--rs-spring) backwards}
.rs-ctas>.rs-cta:nth-child(2){animation-delay:.07s}
.rs-cta-wide{animation:rs-rise .45s var(--rs-spring) .14s backwards}
/* tabs: the squiggle slides from the old tab to the new one (or sketches itself on open) */
.rs-tab{transition:color .2s,transform .3s var(--rs-spring)}
.rs-tab:not(.active):hover{transform:translateY(-2px)}
.rs-tab.active.rs-fresh .rs-squig path{stroke-dasharray:100;stroke-dashoffset:100;animation:rs-draw .5s var(--rs-out) .1s forwards}
.rs-tab.active.rs-slide .rs-squig{animation:rs-squig-slide .55s var(--rs-spring)}
/* lists: sheets of paper drop onto the stack; ticks pop and draw; chars roll up */
.rs-card:not(.rs-loading){animation:rs-sheet .5s var(--rs-out) backwards;animation-delay:var(--rs-d,0s);transition:transform .3s var(--rs-spring)}
.rs-card:nth-child(even){--rs-r:2.5deg}
.rs-line{animation:rs-rise .36s var(--rs-out) backwards;animation-delay:var(--rs-d,0s)}
.rs-card:nth-child(2),.rs-line:nth-child(2){--rs-d:.05s}
.rs-card:nth-child(3),.rs-line:nth-child(3){--rs-d:.1s}
.rs-card:nth-child(4),.rs-line:nth-child(4){--rs-d:.15s}
.rs-card:nth-child(5),.rs-line:nth-child(5){--rs-d:.2s}
.rs-card:nth-child(6),.rs-line:nth-child(6){--rs-d:.25s}
.rs-card:nth-child(7),.rs-line:nth-child(7){--rs-d:.3s}
.rs-card:nth-child(n+8),.rs-line:nth-child(n+8){--rs-d:.35s}
.rs-card:not(.rs-loading):hover{transform:translateX(4px) rotate(-.5deg)}
.rs-card:not(.rs-loading) .rs-ic svg,.rs-line-dot{animation:rs-popin .55s var(--rs-out) backwards;animation-delay:calc(var(--rs-d,0s) + .18s)}
.rs-drawp{stroke-dasharray:1;stroke-dashoffset:1;animation:rs-draw .4s var(--rs-out) forwards;animation-delay:calc(var(--rs-d,0s) + .38s)}
.rs-card.rs-loading .rs-ic,.rs-card.rs-loading .rs-sk{animation:rs-breathe 1.1s ease-in-out infinite}
/* results: the big mark pops and draws (confetti follows); a failure mark shakes */
.rs-donehead svg{animation:rs-popin .6s var(--rs-out) backwards}
.rs-donehead .rs-drawp{animation-delay:.35s;animation-duration:.5s}
.rs-donehead svg.rs-shake{animation:rs-popin .45s var(--rs-out) backwards,rs-shake .6s ease-in-out .45s}
/* "Porting Successful": the face draws itself, the smile follows, the eyes pop and blink once */
@keyframes rs-blink{0%,100%{transform:none}50%{transform:scaleY(.1)}}
.rs-smile{animation:rs-popin .6s var(--rs-out) backwards}
.rs-smile circle{stroke-dasharray:1;stroke-dashoffset:1;animation:rs-draw .65s var(--rs-out) .15s forwards}
.rs-smile path{stroke-dasharray:1;stroke-dashoffset:1;animation:rs-draw .45s var(--rs-out) .7s forwards}
.rs-smile line{transform-box:fill-box;transform-origin:center;animation:rs-popin .4s var(--rs-out) .95s backwards,rs-blink .32s ease-in-out 2.1s}
.rs-mp-success .rs-donehead-t{animation:rs-rise .55s var(--rs-spring) .55s backwards;font-size:17px}
.rs-mp-success .rs-donehead-s{animation:rs-rise .5s var(--rs-out) .7s backwards}
/* callouts, checkboxes, consent */
.rs-callout{animation:rs-rise .38s var(--rs-out) .08s backwards}
.rs-mp-consent{transition:border-color .25s,background .25s,transform .3s var(--rs-spring)}
.rs-mp-keys{margin:8px 0}
.rs-mp-keys-d{border:2px solid var(--ink);border-radius:var(--sk2);background:var(--paper);padding:0;font-size:12.5px}
.rs-mp-keys-d>summary{cursor:pointer;padding:8px 12px;font-weight:bold;list-style-position:inside}
.rs-mp-keys-t{border-top:2px dashed var(--ash);max-height:200px;overflow:auto;padding:4px 0}
.rs-mp-key{display:flex;justify-content:space-between;gap:10px;padding:3px 12px;line-height:1.45}
.rs-mp-key-n{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;min-width:0;overflow-wrap:anywhere}
.rs-mp-key-t{flex:none;font-weight:bold;white-space:nowrap}
.rs-mp-key.flag{background:#fff7ed}.rs-mp-key.flag .rs-mp-key-t{color:#b45309}
.rs-mp-consent:has(input:checked){border-color:#16a34a;background:#f0fdf4}
.rs-mp-consent:has(input:disabled),.rs-mp-consent.rs-mp-consent-off{opacity:.55!important;border-style:dashed;animation:none}
.rs-mp-consent:has(input:disabled) .rs-mp-consent-text,.rs-mp-consent-cb:disabled{cursor:not-allowed}
.rs-mp-consent-cb:checked,.rs-check input:checked,.rs-choice input:checked{animation:rs-popin .45s var(--rs-out)}
/* toasts: spring in with a tilt; a bar shows how long they stay */
.rs-toast{position:relative;overflow:hidden;animation:rs-toast-in .55s var(--rs-spring)}
@keyframes rs-toast-in{from{opacity:0;transform:translateX(48px) rotate(5deg) scale(.88)}to{opacity:1;transform:none}}
.rs-toast::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;background:var(--ink);opacity:.22;transform-origin:left;animation:rs-timer 3.6s linear forwards}
.rs-tic{animation:rs-popin .5s var(--rs-out) .12s backwards}
/* small icons */
.rs-launcher.rs-hello{animation:rs-hello .9s var(--rs-out)}
.rs-launcher.rs-hello .rs-star{animation:rs-hello-star .9s var(--rs-out)}
.rs-star{transition:transform .6s var(--rs-spring)}
.rs-launcher:hover .rs-star{transform:rotate(144deg) scale(1.3)}
.rs-x svg{transition:transform .35s var(--rs-spring)}
.rs-x:hover svg{transform:rotate(90deg) scale(1.15)}
.rs-linkic{transition:transform .3s var(--rs-spring),background .2s}
.rs-linkic:hover{transform:translateY(-3px) rotate(-6deg) scale(1.08)}
.rs-links:not([hidden]) .rs-linkic{animation:rs-popin .5s var(--rs-out) backwards}
.rs-links:not([hidden]) .rs-linkic:nth-child(2){animation-delay:.08s}
.rs-links:not([hidden]) .rs-linkic:nth-child(3){animation-delay:.16s}
.rs-undo-ic{transition:transform .6s var(--rs-out)}
.rs-btn:hover .rs-undo-ic{transform:rotate(-360deg)}
.rs-btn:hover .rs-dl-ic{animation:rs-dive .7s var(--rs-out)}
/* import tray: the arrow keeps diving in while hovered; a dragged file drops the page in */
.rs-dropzone{transition:background .2s,transform .3s var(--rs-spring)}
.rs-dropzone:hover{transform:scale(1.015)}
.rs-dropzone.over{transform:scale(1.04) rotate(-.6deg)}
.rs-dz-arrow,.rs-dz-paper{transform-box:view-box;transition:transform .45s var(--rs-spring)}
.rs-dropzone:hover .rs-dz-arrow{animation:rs-dive .9s var(--rs-out) infinite}
.rs-dropzone:hover .rs-dz-paper{transform:translateY(-4px) rotate(-3deg)}
.rs-dropzone.over .rs-dz-paper{transform:translateY(16px) rotate(2deg)}
/* migration: the port scene */
.rs-port{display:block;margin:4px auto 2px;max-width:330px}
.rs-port-path{stroke-dasharray:6 6;animation:rs-march .8s linear infinite}
.rs-port-dst{transform-box:fill-box;transform-origin:center;animation:rs-catch .6s ease-out infinite}
.rs-port-spark{transform-box:fill-box;transform-origin:center;animation:rs-twinkle 1.4s ease-in-out infinite}
.rs-port-spark.s2{animation-delay:.7s}
.rs-working{display:inline-flex;align-items:center;gap:8px}
.rs-working svg{flex:none;animation:rs-spin .9s linear infinite}
@media (forced-colors:active){.rs-star path{fill:currentColor;stroke:currentColor}.rs-launcher .rs-badge{border:1px solid currentColor}
  .rs-line-dot.ok,.rs-line-dot.bullet{forced-color-adjust:none;background:CanvasText;color:Canvas}.rs-line-dot.bullet.alt{background:Canvas;border-color:CanvasText}
  .rs-btn:disabled,.rs-btn[aria-disabled="true"],.rs-cta:disabled{border-style:dashed;border-color:GrayText;color:GrayText}}
@media (prefers-reduced-motion:reduce){:host *,:host *::before,:host *::after{animation:none!important;transition:none!important}.rs-drawp,.rs-squig path,.rs-smile circle,.rs-smile path{stroke-dashoffset:0!important}}
.rs-view-changes{min-height:24px}
`;

  var UI = { host: null, root: null, launcher: null, card: null, badge: null, links: null };
  // ---- UI 2.0 icons (inline SVG strings; greyscale, hand-drawn feel) ----
  var IC = {
    star: '<svg class="rs-star" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 1l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" fill="#ececec" stroke="#ffffff" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    lock: '<svg width="12" height="14" viewBox="0 0 14 16" aria-hidden="true"><path d="M2 7h10l-.5 7.5h-9z" fill="#ececec" stroke="#1a1a1a" stroke-width="1.5" stroke-linejoin="round"/><path d="M4 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="#1a1a1a" stroke-width="1.5"/></svg>',
    x: '<svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 3c4 4 8 9 12 12M15 3C11 7 7 11 3 15" stroke="#1a1a1a" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>',
    squig: '<svg class="rs-squig" viewBox="0 0 80 8" preserveAspectRatio="none" aria-hidden="true"><path pathLength="100" d="M2 5c8-4 14 3 22 0s14-4 22 0 14 3 22 0 8-2 10-1" stroke="#1a1a1a" stroke-width="3" fill="none" stroke-linecap="round"/></svg>',
    tick: '<svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true"><path d="M13 2c7 0 11 5 11 11s-5 11-11 11S2 19 2 13 7 2 14 2" fill="#1a1a1a"/><path class="rs-drawp" pathLength="1" d="M7.5 13l4 4 7-8.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bang: '<svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true"><path d="M13 2c7 0 11 5 11 11s-5 11-11 11S2 19 2 13 7 2 14 2" fill="#fff" stroke="#1a1a1a" stroke-width="1.8"/><path d="M13 7.5v7M13 18v.5" stroke="#1a1a1a" stroke-width="2.4" stroke-linecap="round"/></svg>',
    warn: '<svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2l9 17H2z" fill="#fff" stroke="#1a1a1a" stroke-width="1.6" stroke-linejoin="round"/><path d="M11 8v5M11 16v.5" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2c5 0 9 4 9 9s-4 9-9 9-9-4-9-9 4-9 10-9" fill="#fff" stroke="#1a1a1a" stroke-width="1.6"/><path d="M11 10v6M11 6.5v.5" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/></svg>',
    shield: '<svg width="18" height="18" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 2l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V5z" fill="#ececec" stroke="#1a1a1a" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    err: '<svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true"><path d="M13 2c7 0 11 5 11 11s-5 11-11 11S2 19 2 13 7 2 14 2" fill="#1a1a1a"/><path d="M9 9l8 8M17 9l-8 8" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
    note: '<svg width="30" height="30" viewBox="0 0 34 34" aria-hidden="true"><path d="M6 8c1-3 20-4 22-1s1 18-2 20-18 2-20-1-1-15 0-18z" fill="#ececec" stroke="#1a1a1a" stroke-width="1.8"/><path d="M11 14h12M11 19h9" stroke="#1a1a1a" stroke-width="1.8" stroke-linecap="round"/></svg>',
    five: '<svg width="58" height="46" viewBox="0 0 58 46" aria-hidden="true"><g fill="#fff" stroke="#1a1a1a" stroke-width="1.8"><g class="rs-pg rs-pg1"><rect x="4" y="2" width="26" height="32" rx="2" transform="rotate(-6 17 18)"/></g><g class="rs-pg rs-pg2"><rect x="10" y="4" width="26" height="32" rx="2" transform="rotate(-3 23 20)"/></g><g class="rs-pg rs-pg3"><rect x="16" y="6" width="26" height="32" rx="2"/></g><g class="rs-pg rs-pg4"><rect x="22" y="8" width="26" height="32" rx="2" transform="rotate(3 35 24)"/></g><g class="rs-pg rs-pg5"><rect x="28" y="10" width="26" height="32" rx="2" transform="rotate(5 41 26)"/><path d="M33 18h14M33 23h12M33 28h9" stroke-width="1.6" stroke-linecap="round" transform="rotate(5 41 26)"/></g></g></svg>',
    magic: '<svg width="58" height="46" viewBox="0 0 58 46" aria-hidden="true"><g class="rs-cube" fill="#fff" stroke="#1a1a1a" stroke-width="1.8" stroke-linejoin="round"><path d="M8 18l14-7 14 7v16l-14 7-14-7z"/><path d="M8 18l14 7 14-7M22 25v16"/></g><g class="rs-orbit"><path d="M38 14c6-6 12-4 14 2" fill="none" stroke="#1a1a1a" stroke-width="1.8" stroke-linecap="round"/><path d="M49 11l3 5-6 1" fill="none" stroke="#1a1a1a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></g><path class="rs-spark" d="M44 30l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" fill="#1a1a1a"/></svg>',
    two: '<svg width="58" height="46" viewBox="0 0 58 46" aria-hidden="true"><g fill="#fff" stroke="#1a1a1a" stroke-width="1.8"><g class="rs-pt rs-pt1"><rect x="12" y="4" width="26" height="32" rx="2" transform="rotate(-5 25 20)"/></g><g class="rs-pt rs-pt2"><rect x="22" y="8" width="26" height="32" rx="2" transform="rotate(4 35 24)"/><path fill="none" d="M27 16h15M27 21h13M27 26h15M27 31h8" stroke="#1a1a1a" stroke-width="1.6" stroke-linecap="round" transform="rotate(4 35 24)"/></g></g></svg>',
    tray: '<svg width="96" height="72" viewBox="0 0 96 72" aria-hidden="true"><g class="rs-dz-paper"><path d="M30 6c1-2 30-3 32 0s2 34 0 36-30 2-32 0-1-34 0-36z" fill="#fff" stroke="#1a1a1a" stroke-width="2"/><path d="M37 16h18M37 22h14M37 28h17" stroke="#1a1a1a" stroke-width="1.8" stroke-linecap="round"/></g><path d="M8 40l8 26h64l8-26" fill="#ececec" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/><path d="M8 40h22c1 6 4 9 18 9s17-3 18-9h22" fill="none" stroke="#1a1a1a" stroke-width="2" stroke-linejoin="round"/><g class="rs-dz-arrow"><path d="M78 6v20M71 13l7-7 7 7" fill="none" stroke="#1a1a1a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></g></svg>',
    done: '<svg width="42" height="42" viewBox="0 0 44 44" aria-hidden="true"><path d="M22 6c9 0 16 7 16 16s-7 16-16 16S6 31 6 22 13 6 23 6" fill="#1a1a1a"/><path class="rs-drawp" pathLength="1" d="M14 22l6 6 11-12" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 1v3M40 8l-2 2M43 22h-3M4 8l2 2M1 22h3" stroke="#1a1a1a" stroke-width="2" stroke-linecap="round"/></svg>',
    undo: '<svg class="rs-undo-ic" width="16" height="15" viewBox="0 0 18 16" aria-hidden="true"><path d="M6 2L2 6l4 4M2 6h9a5 5 0 0 1 0 10H8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    dl: '<svg class="rs-dl-ic" width="14" height="16" viewBox="0 0 16 18" aria-hidden="true"><path d="M8 2v10M4 8l4 4 4-4M2 16h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    up: '<svg width="13" height="9" viewBox="0 0 14 10" aria-hidden="true"><path d="M2 8l5-6 5 6" fill="none" stroke="#1a1a1a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg width="13" height="9" viewBox="0 0 14 10" aria-hidden="true"><path d="M2 2l5 6 5-6" fill="none" stroke="#1a1a1a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    spin: '<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a7.5 7.5 0 1 1-7.3 5.8" fill="none" stroke="#1a1a1a" stroke-width="2.4" stroke-linecap="round"/></svg>',
    pause: '<svg class="rs-pause-ic" width="16" height="16" viewBox="0 0 20 20" aria-hidden="true" style="animation:none"><path d="M7 4.5v11M13 4.5v11" fill="none" stroke="#1a1a1a" stroke-width="2.6" stroke-linecap="round"/></svg>',
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

  // ---- FX: bursts, confetti, flying files, wake-ups. Purely decorative: every
  // call is guarded, does nothing under reduced-motion, and can never throw
  // into the feature code that calls it.
  var FX = (function () {
    var lastCta = null;
    function on() { try { return !!(UI.root && !reduceMotion() && document.body.animate); } catch (e) { return false; } }
    function layer() {
      var r = UI.root; if (!r) return null;
      var l = r.querySelector(".rs-fx");
      if (!l) { l = document.createElement("div"); l.className = "rs-fx"; l.setAttribute("aria-hidden", "true"); }
      if (r.lastChild !== l) r.appendChild(l);   // keep it above the panel and toasts
      return l;
    }
    function play(node, kf, opt, after) {
      var a = null, done = false;
      var fin = function () { if (done) return; done = true; try { after && after(); } catch (e) {} };
      try { a = node.animate(kf, opt); } catch (e) {}
      if (!a) { fin(); return a; }
      a.onfinish = fin; a.oncancel = fin;
      // Safety net: a background/throttled tab may never fire onfinish — never leave a decorative node behind.
      if (after && opt && isFinite(opt.iterations === undefined ? 1 : opt.iterations)) setTimeout(fin, (+opt.duration || 0) * (opt.iterations || 1) + (+opt.delay || 0) + 400);
      return a;
    }
    function burst(x, y, color, n) {
      if (!on()) return; var L = layer(); if (!L) return;
      n = n || 9;
      for (var i = 0; i < n; i++) {
        var d = document.createElement("i"); d.className = "rs-fx-ray";
        d.style.left = x + "px"; d.style.top = y + "px"; if (color) d.style.background = color;
        L.appendChild(d);
        var ang = (360 / n) * i + (Math.random() * 18 - 9), r0 = 8, r1 = 20 + Math.random() * 12;
        (function (dd) {
          play(dd, [
            { transform: "translate(-50%,-50%) rotate(" + ang + "deg) translateY(-" + r0 + "px) scaleY(.3)", opacity: 1 },
            { transform: "translate(-50%,-50%) rotate(" + ang + "deg) translateY(-" + r1 + "px) scaleY(1)", opacity: 0 }
          ], { duration: 430 + Math.random() * 140, easing: "cubic-bezier(.16,1,.3,1)" }, function () { dd.remove(); });
        })(d);
      }
    }
    var STAR = '<svg viewBox="0 0 10 10" width="11" height="11"><path d="M5 0l1.2 3.8L10 5 6.2 6.2 5 10 3.8 6.2 0 5l3.8-1.2z" fill="currentColor"/></svg>';
    var SQUIG = '<svg viewBox="0 0 16 6" width="16" height="6"><path d="M1 4c2-3 4 2 7 0s4-3 7 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    function confetti(x, y, n, power) {
      if (!on()) return; var L = layer(); if (!L) return;
      n = n || 30; power = power || 1;
      var shapes = ["rect", "dot", "star", "squig"], cols = ["#1a1a1a", "#4d4d4d", "#8a8a8a", "#cfcfcf", "#22c55e", "#1a1a1a"];
      for (var i = 0; i < n; i++) {
        var sh = shapes[i % 4], c = cols[Math.floor(Math.random() * cols.length)];
        var p = document.createElement("i"); p.className = "rs-fx-bit rs-fx-" + sh;
        if (sh === "star" || sh === "squig") { p.style.color = c; p.innerHTML = sh === "star" ? STAR : SQUIG; } else p.style.background = c;
        p.style.left = x + "px"; p.style.top = y + "px"; L.appendChild(p);
        var ang = (-90 + (Math.random() * 150 - 75)) * Math.PI / 180, v = (150 + Math.random() * 190) * power;
        var vx = Math.cos(ang) * v, vy = Math.sin(ang) * v, g = 620, T = 1.05 + Math.random() * .6, rot = Math.random() * 900 - 450, kf = [];
        for (var k = 0; k <= 8; k++) {
          var t = T * k / 8, px = vx * t * (1 - .25 * k / 8), py = vy * t + .5 * g * t * t;
          kf.push({ transform: "translate(" + px.toFixed(1) + "px," + py.toFixed(1) + "px) rotate(" + (rot * k / 8).toFixed(0) + "deg) scale(" + (k === 0 ? .4 : 1) + ")", opacity: k < 6 ? 1 : (k === 6 ? .85 : (k === 7 ? .5 : 0)) });
        }
        (function (pp) { play(pp, kf, { duration: T * 1000, easing: "linear" }, function () { pp.remove(); }); })(p);
      }
    }
    function noteCta(elm) {
      try { var r = elm.getBoundingClientRect(); lastCta = { x: r.left + r.width / 2, y: r.top + r.height / 2, t: Date.now() }; } catch (e) {}
    }
    function gulp() {
      if (!UI.launcher) return;
      play(UI.launcher, [{ transform: "scale(1)" }, { transform: "scale(1.22,.82)" }, { transform: "scale(.92,1.1)" }, { transform: "scale(1.04,.97)" }, { transform: "scale(1)" }], { duration: 520, easing: "ease-out" });
    }
    function fly() {
      if (!on() || !UI.launcher) return;
      var a = lastCta; lastCta = null;
      if (!a || Date.now() - a.t > 15000) return;
      var L = layer(); if (!L) return;
      var b = UI.launcher.getBoundingClientRect();
      var d = document.createElement("i"); d.className = "rs-fx-file"; d.innerHTML = IC.note;
      d.style.left = (a.x - 15) + "px"; d.style.top = (a.y - 15) + "px"; L.appendChild(d);
      var dx = b.left + b.width / 2 - a.x, dy = b.top + b.height / 2 - a.y;
      play(d, [
        { transform: "translate(0,0) scale(.6) rotate(0deg)", opacity: 0 },
        { transform: "translate(0,-14px) scale(1.15) rotate(-8deg)", opacity: 1, offset: .15 },
        { transform: "translate(" + (dx * .5).toFixed(0) + "px," + (dy * .5 - 110).toFixed(0) + "px) scale(1.25) rotate(-28deg)", opacity: 1, offset: .55 },
        { transform: "translate(" + dx.toFixed(0) + "px," + dy.toFixed(0) + "px) scale(.3) rotate(25deg)", opacity: .9 }
      ], { duration: 820, easing: "cubic-bezier(.45,0,.55,1)" }, function () {
        d.remove(); gulp();
        var r = UI.launcher.getBoundingClientRect(); confetti(r.left + r.width / 2, r.top + 6, 14, .7);
      });
    }
    function wake(btn) {
      if (!on() || !btn) return;
      play(btn, [{ transform: "scale(1)" }, { transform: "scale(1.08) rotate(-1.5deg)" }, { transform: "scale(.97) rotate(.5deg)" }, { transform: "scale(1)" }], { duration: 520, easing: "ease-out" });
      btn.classList.remove("rs-shine"); void btn.offsetWidth; btn.classList.add("rs-shine");
      setTimeout(function () { try { btn.classList.remove("rs-shine"); } catch (e) {} }, 800);
    }
    function celebrate(head, big) {
      if (!on() || !head) return;
      function wave(n, pw) {
        try {
          var sv = head.querySelector("svg"); if (!sv || !sv.isConnected) return;
          var r = sv.getBoundingClientRect(); confetti(r.left + r.width / 2, r.top + r.height / 2, n, pw);
        } catch (e) {}
      }
      setTimeout(function () { wave(big ? 56 : 40, big ? 1.35 : 1.15); }, big ? 900 : 420);
      if (big) setTimeout(function () { wave(26, .9); }, 1250);
    }
    function fold(card) {
      // Detach the closing panel from the live UI (no .rs-panel class, no ids) and fold it into the launcher.
      try {
        if (!on()) { card.remove(); return; }
        var cs = getComputedStyle(card), r = card.getBoundingClientRect();
        card.querySelectorAll("[id]").forEach(function (n) { n.removeAttribute("id"); });
        card.removeAttribute("role"); card.setAttribute("aria-hidden", "true"); card.inert = true;
        card.setAttribute("style", "position:fixed;margin:0;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px;box-sizing:border-box;z-index:2147483646;overflow:hidden;display:flex;flex-direction:column;pointer-events:none;transform-origin:bottom right;" +
          "background:" + cs.backgroundColor + ";border:" + cs.border + ";border-radius:" + cs.borderRadius + ";box-shadow:" + cs.boxShadow + ";font-family:" + cs.fontFamily + ";font-size:" + cs.fontSize + ";line-height:" + cs.lineHeight + ";color:" + cs.color);
        card.className = "rs-leaving";
        play(card, [{ opacity: 1, transform: "none" }, { opacity: .9, transform: "translate(-3px,-6px) scale(1.01) rotate(-.6deg)", offset: .25 }, { opacity: 0, transform: "translate(14px,46px) scale(.72) rotate(3deg)" }],
          { duration: 300, easing: "cubic-bezier(.5,0,.75,0)" }, function () { card.remove(); });
      } catch (e) { try { card.remove(); } catch (e2) {} }
    }
    function hello(b) {
      if (!on() || !b) return;
      setTimeout(function () { try { b.classList.add("rs-hello"); setTimeout(function () { b.classList.remove("rs-hello"); }, 1000); } catch (e) {} }, 700);
    }
    function portScene(srcName, dstName) {
      var anim = on();
      var cube = function (k) {
        var begin = (k * 0.6).toFixed(1) + "s";
        return '<g opacity="' + (anim ? 0 : 1) + '"' + (anim ? '' : ' transform="translate(160 22)"') + '><path d="M-7 -3l7-4 7 4v8l-7 4-7-4z" fill="#fff" stroke="#1a1a1a" stroke-width="1.6" stroke-linejoin="round"/><path d="M-7 -3l7 4 7-4M0 1v8" fill="none" stroke="#1a1a1a" stroke-width="1.3"/>' +
          (anim ? '<animateMotion dur="1.8s" begin="' + begin + '" repeatCount="indefinite" path="M98 62 C140 -8 180 -8 222 62" keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines=".45 0 .55 1"/>' +
            '<animate attributeName="opacity" dur="1.8s" begin="' + begin + '" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;.12;.86;1"/>' : '') + '</g>';
      };
      var card = function (x, label, cls) {
        return '<g' + (cls ? ' class="' + cls + '"' : '') + '><path d="M' + x + ' 46c1-3 72-4 74 0s2 40 0 42-72 2-74 0-1-39 0-42z" fill="' + (cls ? '#fff' : '#f7f7f7') + '" stroke="#1a1a1a" stroke-width="2"/>' +
          '<path d="M' + (x + 12) + ' 62h50M' + (x + 12) + ' 70h38M' + (x + 12) + ' 78h44" stroke="#cfcfcf" stroke-width="3" stroke-linecap="round"/>' +
          '<text x="' + (x + 37) + '" y="104" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11" font-weight="bold" fill="#1a1a1a">' + esc(label) + '</text></g>';
      };
      return '<svg class="rs-port" viewBox="0 0 320 112" aria-hidden="true">' +
        card(22, srcName, "") + card(224, dstName, "rs-port-dst") +
        '<path class="rs-port-path" d="M98 62 C140 -8 180 -8 222 62" fill="none" stroke="#1a1a1a" stroke-width="1.8" stroke-linecap="round"/>' +
        '<path class="rs-port-spark" d="M160 46l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="#1a1a1a"/>' +
        '<path class="rs-port-spark s2" d="M196 14l1.4 3.4 3.4 1.4-3.4 1.4-1.4 3.4-1.4-3.4-3.4-1.4 3.4-1.4z" fill="#22c55e"/>' +
        cube(0) + (anim ? cube(1) + cube(2) : '') + '</svg>';
    }
    return { on: on, burst: burst, confetti: confetti, fly: fly, noteCta: noteCta, wake: wake, celebrate: celebrate, fold: fold, hello: hello, portScene: portScene, gulp: gulp };
  })();


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

  var PP_HOST_ID = "promptport-host-v41";
  var PP_VERSION = (function () { try { return chrome.runtime.getManifest().version || "4.1.0"; } catch (e) { return "4.1.0"; } })();
  // Another PromptPort build in the same browser (4.0's host is a
  // div[id$="-studio-host"] under <body>; older ones used #promptport-host)
  // sits in the same bottom-right corner: mark our host so the CSS moves this
  // launcher above that one and the panel beside (or above) it. Re-checked
  // when <body>'s direct children change (cheap: no subtree).
  function ppOtherHost() {
    try {
      var kids = [].slice.call(document.body ? document.body.children : []).concat([].slice.call(document.documentElement.children));
      return kids.some(function (h) {
        return h !== UI.host && h.tagName === "DIV" && (/-studio-host$/.test(h.id || "") || h.id === "promptport-host");
      });
    } catch (e) { return false; }
  }
  function ppCoexistSync() {
    try { if (UI.host) UI.host.toggleAttribute("data-pp-coexist", ppOtherHost()); } catch (e) {}
  }
  function ppCoexistWatch() {
    ppCoexistSync();
    var watched = null;
    var watchBody = function () {
      if (!document.body || document.body === watched) return;
      watched = document.body;
      try { new MutationObserver(ppCoexistSync).observe(watched, { childList: true }); } catch (e) {}
      ppCoexistSync();
    };
    watchBody();
    try { new MutationObserver(function () { watchBody(); ppCoexistSync(); }).observe(document.documentElement, { childList: true }); } catch (e) {}
  }
  // Press feedback for buttons and CTAs: a quick trackpad tap or a key press is
  // too short for :active to show, so the pressed look is held for at least
  // ~120 ms, then the button springs back (rs-pop). A ripple spreads from the
  // touch point (the centre for keys). Purely visual; clicks are untouched.
  function ppWirePress(root) {
    var SEL = ".rs-btn,.rs-cta";
    var cur = null, downAt = 0;
    function usable(b) { return b && !b.disabled && b.getAttribute("aria-disabled") !== "true"; }
    function ripple(b, x, y) {
      if (reduceMotion()) return;
      try {
        var r = b.getBoundingClientRect();
        var wrap = b.querySelector(":scope > .rs-rip-wrap");
        if (!wrap) { wrap = document.createElement("span"); wrap.className = "rs-rip-wrap"; wrap.setAttribute("aria-hidden", "true"); b.insertBefore(wrap, b.firstChild); }
        var dot = document.createElement("span"); dot.className = "rs-rip";
        // the ripple layer sits inside the border: measure from the padding box
        var px = x == null ? b.clientWidth / 2 : x - r.left - b.clientLeft, py = y == null ? b.clientHeight / 2 : y - r.top - b.clientTop;
        dot.style.left = px + "px"; dot.style.top = py + "px";
        var cw = b.clientWidth, ch = b.clientHeight;
        var far = Math.max(Math.hypot(px, py), Math.hypot(cw - px, py), Math.hypot(px, ch - py), Math.hypot(cw - px, ch - py));
        dot.style.setProperty("--rs-rip-s", String(Math.ceil(far / 5) + 1));
        wrap.appendChild(dot);
        setTimeout(function () { try { dot.remove(); if (!wrap.firstChild) wrap.remove(); } catch (e) {} }, 650);
      } catch (e) {}
    }
    function press(b, x, y) {
      if (!usable(b)) return;
      if (cur && cur !== b) release(true);
      cur = b; downAt = Date.now();
      b._ppPress = (b._ppPress || 0) + 1;   // a newer press on this button voids its pending release / pop timers
      b.classList.remove("rs-pop"); b.classList.add("rs-pressed");
      ripple(b, x, y);
    }
    function release(now) {
      var b = cur; if (!b) return;
      cur = null;
      var id = b._ppPress, wait = now ? 0 : Math.max(0, 120 - (Date.now() - downAt));
      setTimeout(function () {
        if (b._ppPress !== id) return;
        b.classList.remove("rs-pressed");
        if (reduceMotion() || !b.isConnected) return;
        // rs-popped (animation:none) stays, so dropping rs-pop never replays the tile's entrance animation
        void b.offsetWidth; b.classList.add("rs-popped", "rs-pop");
        setTimeout(function () { if (b._ppPress === id) b.classList.remove("rs-pop"); }, 480);
      }, wait);
    }
    root.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      var b = e.target && e.target.closest && e.target.closest(SEL);
      if (b) press(b, e.clientX, e.clientY);
    }, true);
    ["pointerup", "pointercancel"].forEach(function (ty) { root.addEventListener(ty, function () { release(false); }, true); });
    window.addEventListener("pointerup", function () { release(false); }, true);
    root.addEventListener("keydown", function (e) {
      if ((e.key !== "Enter" && e.key !== " ") || e.repeat) return;
      var b = e.target && e.target.closest && e.target.closest(SEL);
      if (b && b === e.target) { press(b, null, null); if (e.key === "Enter") release(false); }
    }, true);
    window.addEventListener("keyup", function (e) { if (e.key === " ") release(false); }, true);
    root.addEventListener("focusout", function (e) { if (cur && e.target === cur) release(false); }, true);
  }
  function ensureHost() {
    // The page took our host out (and keepHost backed off for now): every use
    // of the UI puts it back under <html>.
    if (UI.root) {
      try { if (UI.host && UI.host.parentNode !== document.documentElement && document.documentElement) document.documentElement.appendChild(UI.host); } catch (e) {}
      return UI.root;
    }
    var host = document.createElement("div");
    // A distinct id and a version mark, so this build never shares (or fights
    // over) the host of an older PromptPort installed in the same browser.
    host.id = PP_HOST_ID;
    try { host.setAttribute("data-pp-version", PP_VERSION); } catch (e) {}
    try { host.style.all = "initial"; } catch (e) {}
    var root = host.attachShadow({ mode: "open" });
    var st = document.createElement("style");
    st.textContent = RS_CSS;
    root.appendChild(st);
    // Live under <html>, not <body>: a body with transform/filter/contain would
    // otherwise become the containing block of our position:fixed UI.
    (document.documentElement || document.body).appendChild(host);
    UI.host = host; UI.root = root;
    keepHost(host);
    syncZoom();
    window.addEventListener("resize", syncZoom);
    // A page zoom set on <html> without a resize (style / class change) too.
    try { new MutationObserver(syncZoom).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] }); } catch (e) {}
    ppCoexistWatch();
    ppWirePress(root);
    root.addEventListener("pointerdown", function (e) {
      try {
        var t = e.target && e.target.closest && e.target.closest(".rs-btn,.rs-cta,.rs-tab,.rs-launcher,.rs-check,.rs-linkic,.rs-dropzone,.rs-textbtn,.rs-x,.rs-choice");
        if (!t || t.disabled || t.getAttribute("aria-disabled") === "true") return;
        if (t.classList.contains("rs-cta")) FX.noteCta(t);
        FX.burst(e.clientX, e.clientY, null, t.classList.contains("rs-cta") || t.classList.contains("rs-btn-primary") ? 11 : 8);
      } catch (err) {}
    }, true);
    // Busy lock: controls drawn while a job runs are disabled too, and a click /
    // drop that still reaches one is stopped with a short explanation.
    try {
      new MutationObserver(function () { if (_ppBusy) ppPaintBusy(); }).observe(root, { childList: true, subtree: true });
    } catch (e) {}
    function busyStop(e) {
      if (!_ppBusy) return;
      // A file dragged onto the panel while busy is refused anywhere in it (and
      // never falls through to the browser, which would open it and leave the page).
      if (e.type === "dragover") { e.preventDefault(); e.stopPropagation(); try { e.dataTransfer.dropEffect = "none"; } catch (x) {} return; }
      if (e.type === "drop") { e.preventDefault(); e.stopPropagation(); toast(ppBusyText(), null, "info"); return; }
      var t = e.target && e.target.closest && e.target.closest("[data-pp-busy]");
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      toast(ppBusyText(), null, "info");
    }
    ["click", "drop", "dragover"].forEach(function (ty) { root.addEventListener(ty, busyStop, true); });
    return root;
  }

  // Put the host back under <html> if the page removes or moves it. Bounded, so
  // we never fight another script forever: only a removal that comes right
  // after our own re-append (a script fighting us) counts, and after 50 of those
  // in a row we back off for a while and then try once more. A page that just
  // removes it now and then (e.g. on a route change) never uses the budget up.
  var KEEP_FIGHT_MS = 250, KEEP_MAX = 50, KEEP_BACKOFF_MS = 30000;
  function keepHost(host) {
    try {
      var n = 0, lastPut = 0, backoff = null;
      var put = function () {
        var de = document.documentElement;
        if (!de || host.parentNode === de) return;
        lastPut = Date.now(); de.appendChild(host);
      };
      new MutationObserver(function () {
        var de = document.documentElement;
        if (!de || host.parentNode === de) return;
        if (Date.now() - lastPut > KEEP_FIGHT_MS) n = 0;   // not a fight: a fresh budget
        if (n >= KEEP_MAX) {
          if (!backoff) backoff = setTimeout(function () { backoff = null; n = 0; put(); }, KEEP_BACKOFF_MS);
          return;
        }
        n++; put();
      }).observe(document.documentElement, { childList: true });
    } catch (e) {}
  }
  // Undo a page-level CSS zoom on <html> so the panel keeps its size and stays on-screen.
  function syncZoom() {
    try {
      if (!UI.host) return;
      var z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      var want = z > 0 && Math.abs(z - 1) > 0.001 ? String(1 / z) : "";
      if (UI.host.style.zoom !== want) UI.host.style.zoom = want;
    } catch (e) {}
  }

  // Launcher pill (formerly the FAB).
  // The launcher tucks itself into the right wall after a spell of inactivity,
  // leaving a small pulsing sliver. Clicking the sliver slides the full pill out.
  var _tuckTimer = null;
  var TUCK_MS = 7000;
  function tuckLauncher() {
    if (UI.launcher && !UI.card) UI.launcher.classList.add("rs-tucked");
  }
  // The idle countdown never tucks it away from under keyboard focus or a resting mouse.
  function autoTuck() {
    try { if (UI.launcher && ((UI.root.activeElement === UI.launcher && UI.launcher.matches(":focus-visible")) || UI.launcher.matches(":hover"))) return; } catch (e) {}
    tuckLauncher();
  }
  function untuckLauncher() {
    if (UI.launcher) UI.launcher.classList.remove("rs-tucked");
  }
  function resetTuckTimer() {
    clearTimeout(_tuckTimer);
    _tuckTimer = setTimeout(autoTuck, TUCK_MS);
  }

  function ensureUI() {
    var root = ensureHost();
    // The page took our host out (and keepHost gave up for now): put it back.
    try { if (UI.host && !UI.host.isConnected && document.documentElement) document.documentElement.appendChild(UI.host); } catch (e) {}
    if (UI.launcher) return;
    var b = el("button", "rs-launcher");
    b.innerHTML = IC.star + '<span class="rs-badge"></span><span class="rs-ver" aria-hidden="true">' + esc("v" + PP_VERSION) + '</span>';
    b.title = "PromptPort v" + PP_VERSION;
    b.setAttribute("aria-label", "PromptPort v" + PP_VERSION);
    b.setAttribute("aria-expanded", "false");
    UI.badge = b.querySelector(".rs-badge");
    var lastPtr = "", ptrAt = 0, kbDown = false;
    b.addEventListener("pointerdown", function (e) { lastPtr = e.pointerType || ""; ptrAt = Date.now(); });
    b.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") kbDown = true;
      else if (b.classList.contains("rs-tucked")) { untuckLauncher(); clearTimeout(_tuckTimer); }   // any key while focused brings it out
    });
    b.addEventListener("click", function (e) {
      var ptr = e.pointerType || lastPtr, kb = kbDown; lastPtr = ""; kbDown = false;
      // First mouse click on the tucked sliver just slides the full pill out;
      // a keyboard activation (focus already untucked it) or a tap opens at once.
      if (b.classList.contains("rs-tucked")) {
        var kbAct = kb && e.detail === 0;
        untuckLauncher();
        if (!kbAct && ptr !== "touch") { resetTuckTimer(); return; }
      }
      if (UI.card) closePanel(e.detail === 0);
      else {
        openPanel();
        if (e.detail === 0) setTimeout(function () { var a = UI.card && UI.card.querySelector(".rs-tab.active"); if (a) a.focus(); }, 0);
      }
      resetTuckTimer();
    });
    // Hovering or focusing keeps it out; the idle countdown restarts on leave.
    b.addEventListener("mouseenter", function () { clearTimeout(_tuckTimer); });
    b.addEventListener("mouseleave", function () { resetTuckTimer(); });
    b.addEventListener("focus", function () { if (Date.now() - ptrAt > 500) untuckLauncher(); clearTimeout(_tuckTimer); });   // a press focuses it too: the click decides then
    b.addEventListener("blur", function () { kbDown = false; if (!b.matches(":hover")) resetTuckTimer(); });
    root.appendChild(b);
    UI.launcher = b;
    wireEscape(root);
    // The toast live region exists before its first message, so it is announced.
    if (!root.querySelector(".rs-toasts")) { var tw = el("div", "rs-toasts"); tw.setAttribute("role", "status"); tw.setAttribute("aria-live", "polite"); root.appendChild(tw); }
    FX.hello(b);
    resetTuckTimer(); // start the 7s countdown; it tucks if left idle
    mpInterruptNotice();   // a migration on this bot was cut off by a reload / login redirect
  }

  // Escape closes the panel and returns focus to the launcher — from anywhere in
  // the panel, and also when focus fell to the page's <body> from the panel
  // (e.g. a control vanished). Keys typed in the page's own inputs/editors are
  // never touched.
  function wireEscape(root) {
    var fromPanel = false;
    root.addEventListener("focusin", function () { fromPanel = true; });
    root.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !UI.card || e.defaultPrevented) return;
      e.preventDefault(); e.stopPropagation(); if (!mpAckBlocks()) closePanel(true);
    });
    document.addEventListener("focusin", function (e) { if (e.target !== UI.host && e.isTrusted) fromPanel = false; }, true);
    document.addEventListener("pointerdown", function (e) { if (e.target !== UI.host && e.isTrusted) { fromPanel = false; _pageInputAt = Date.now(); } }, true);
    document.addEventListener("keydown", function (e) { if (e.target !== UI.host && e.isTrusted) _pageInputAt = Date.now(); }, true);
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !UI.card || e.defaultPrevented || !fromPanel) return;
      if (e.target !== document.body && e.target !== document.documentElement) return;
      e.preventDefault(); if (!mpAckBlocks()) closePanel(true);
    });
  }

  function updateBadge(n, total) {
    if (UI.badge && total != null) {
      UI.badge.textContent = n + "/" + total; UI.badge.title = n + " of " + total + " sections read";
      if (UI.launcher) UI.launcher.setAttribute("aria-label", "PromptPort — " + n + " of " + total + " sections read");
    }
  }

  // Build the panel shell (header row + tabs) and return its scrollable body.
  // Header row: lock + "runs in your browser" · author links (after an action
  // finishes) · close. No product name or logo.
  function shell(active) {
    var root = ensureHost();
    syncZoom();
    var wasOpen = !!(UI.card && UI.card.parentNode);
    var tabChanged = !wasOpen || currentTab !== active;
    var TAB_ORDER = ["export", "import", "find"];
    var prevIdx = wasOpen ? TAB_ORDER.indexOf(currentTab) : -1, newIdx = TAB_ORDER.indexOf(active);
    if (currentTab === "find" && active !== "find") clearHighlights();   // leaving Find: take its highlights off the page
    // Remember what had focus so the repaint can put it back (else it drops to <body>).
    var fEl = wasOpen && root.activeElement && UI.card.contains(root.activeElement) ? root.activeElement : null;
    var fWas = fEl ? (fEl === UI._fbEl && UI._fbWant) || { tag: fEl.tagName, name: focusName(fEl), tab: fEl.classList.contains("rs-tab") } : null;
    if (wasOpen) UI.card.parentNode.removeChild(UI.card);
    var card = el("div", "rs-panel " + (wasOpen ? "rs-swap" : "rs-enter") + (wasOpen && tabChanged && prevIdx >= 0 && newIdx >= 0 ? (newIdx > prevIdx ? " rs-dir-r" : " rs-dir-l") : "")); UI.card = card;
    card.setAttribute("role", "dialog"); card.setAttribute("aria-label", "PromptPort v" + PP_VERSION);
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
    x.addEventListener("click", function () { if (!mpAckBlocks()) closePanel(); }); head.appendChild(x);

    var tabs = el("div", "rs-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Sections");
    var TABS = [["export", "Export", openPanel], ["import", "Import", renderImportHome], ["find", "Find", renderFindReplace]];
    function activate(i, kb, clicked) {
      if (TABS[i][0] !== currentTab && mpAckBlocks()) return;
      // Pressing the Find tab while on it keeps the screen (a replace result and its Undo / Save stay).
      if (TABS[i][0] === "find" && currentTab === "find" && UI.card && UI.card.isConnected) {
        if (kb) { var fa = UI.card.querySelector(".rs-tab.active"); if (fa) fa.focus(); }
        return;
      }
      // Clicking the Import tab while already on it starts over at the drop zone
      // (a kept review / Magic Port confirm is shown again when coming back from another tab).
      if (clicked && TABS[i][0] === "import" && currentTab === "import") { _pendingReview = null; _pendingMpConfirm = null; }
      UI._kbTab = !!kb;
      TABS[i][2]();
      if (kb) setTimeout(function () { var a = UI.card && UI.card.querySelector(".rs-tab.active"); if (a) a.focus(); }, 0);
      if (kb) setTimeout(function () { UI._kbTab = false; }, 120);
      else UI._kbTab = false;
    }
    TABS.forEach(function (t, i) {
        var on = t[0] === active;
        var sliding = on && wasOpen && tabChanged && prevIdx >= 0;
        var b = el("button", "rs-tab" + (on ? " active" + (sliding ? " rs-slide" : (tabChanged ? " rs-fresh" : "")) : ""), t[1]);
        if (sliding) b.style.setProperty("--rs-from", (((prevIdx - i) / 0.6) * 100).toFixed(1) + "%");
        b.id = "rs-tab-" + t[0];
        b.setAttribute("role", "tab"); b.setAttribute("aria-selected", on ? "true" : "false");
        b.setAttribute("aria-controls", "rs-tabpanel"); b.tabIndex = on ? 0 : -1;
        b.insertAdjacentHTML("beforeend", IC.squig);
        b.addEventListener("click", function (e) { activate(i, e.detail === 0, true); });
        b.addEventListener("keydown", function (e) {
          var n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
          if (n == null) return;
          e.preventDefault();
          activate((n + TABS.length) % TABS.length, true);
        });
        tabs.appendChild(b);
      });

    top.appendChild(head); top.appendChild(tabs);
    if (ppOrphaned()) {
      // Reloaded / updated extension: this page still runs the old copy.
      var orphan = el("div", "rs-note rs-orphan", PP_ORPHAN_TEXT);
      orphan.setAttribute("role", "alert");
      orphan.setAttribute("style", "margin:6px 12px 0;font-weight:bold;");
      top.appendChild(orphan);
    }
    var body = el("div", "rs-body"); panel = body;
    body.id = "rs-tabpanel"; body.setAttribute("role", "tabpanel"); body.setAttribute("aria-labelledby", "rs-tab-" + active);
    var foot = el("div", "rs-foot"); UI.foot = foot;   // sticky actions (hidden when empty)
    card.appendChild(top); card.appendChild(body); card.appendChild(foot);
    // Short windows scroll the whole panel with the footer pinned: keep focused or
    // scrolled-to items clear of it, and unpin a footer that would fill most of the panel.
    try {
      var footRO = new ResizeObserver(function () {
        var big = foot.offsetHeight > card.clientHeight * 0.7;
        card.classList.toggle("rs-foot-free", big);
        card.style.scrollPaddingBottom = big ? "" : foot.offsetHeight + "px";
      });
      footRO.observe(foot); footRO.observe(card);
    } catch (e) {}
    // Fade the body's bottom edge while more content sits below it, so a cut-off line reads as "scroll".
    function moreHint() { body.classList.toggle("rs-more", body.scrollHeight - body.scrollTop - body.clientHeight > 2); }
    try {
      body.addEventListener("scroll", moreHint, { passive: true }); body.addEventListener("animationend", moreHint);
      new MutationObserver(moreHint).observe(body, { childList: true, subtree: true, characterData: true });
      new ResizeObserver(moreHint).observe(body);
    } catch (e) {}
    root.appendChild(card);
    currentTab = active;
    if (fWas) Promise.resolve().then(function () { restoreFocus(card, fWas); });   // after the caller has filled the body
    return body;
  }
  // Reading the page clicks its own buttons/editors, which pulls focus out of the
  // panel. If focus was in the panel when the read began and the user hasn't
  // touched the page since, put it back afterwards.
  var _pageInputAt = 0;
  function focusKeeper() {
    var a = UI.root && UI.root.activeElement, card = UI.card;
    if (!a || !card || !card.contains(a)) return function () {};
    var was = (a === UI._fbEl && UI._fbWant) || { tag: a.tagName, name: focusName(a), tab: a.classList.contains("rs-tab") }, t0 = Date.now();
    return function () {
      if (_pageInputAt >= t0 || !UI.card || document.activeElement === UI.host) return;
      if (a !== UI._fbEl && a.isConnected && UI.card.contains(a) && !a.disabled) { try { a.focus({ preventScroll: true }); } catch (e) {} }
      else restoreFocus(UI.card, was, true);
    };
  }
  // The "Not imported" report is on screen and not yet acknowledged: ✕, Escape
  // and tab switches point at the acknowledgement instead of leaving it. (The
  // launcher still hides the panel; the report then waits on the Import tab.)
  function mpAckBlocks() {
    var pm = _pendingMp;
    if (!(pm && pm.ack === false && pm.nagEl && UI.card && UI.card.contains(pm.nagEl))) return false;
    try { pm.nagEl.click(); } catch (e) {}
    return true;
  }
  function focusName(e) { return ((e.getAttribute && e.getAttribute("aria-label")) || e.textContent || "").replace(/\s+/g, " ").trim(); }
  // Put focus back inside a freshly painted card: the same control (by tag +
  // name) if it is still there, else the screen's heading, else its first control.
  function restoreFocus(card, was, force) {
    if (UI.card !== card || !card.isConnected) return;
    var a = UI.root.activeElement;
    if (a && card.contains(a) && a !== UI._fbEl) return;   // the screen already placed focus itself
    if (!force && document.activeElement && document.activeElement !== document.body && document.activeElement !== UI.host) return;   // the user moved on to the page
    var sel = "button:not([disabled]),a[href],input:not([disabled]),select,textarea,summary,[tabindex]:not([tabindex='-1'])";
    var vis = function (e) { return e.getClientRects().length && !e.closest("[hidden]"); };
    var all = [].slice.call(card.querySelectorAll(sel)).filter(vis);
    var t = was.tab ? card.querySelector(".rs-tab.active") : null;
    if (!t) t = all.filter(function (e) { return e.tagName === was.tag && focusName(e) === was.name && was.name; })[0];
    if (!t) {
      var body = card.querySelector(".rs-body");
      t = body && body.querySelector(".rs-donehead-t,.rs-callout-h,h1,h2,h3");
      if (t && !vis(t)) t = null;
      if (t && t.tabIndex < 0 && !t.hasAttribute("tabindex")) t.tabIndex = -1;
    }
    var exact = !!t && !was.tab && focusName(t) === was.name;
    if (!t) t = all.filter(function (e) { return !e.closest(".rs-top"); })[0] || card.querySelector(".rs-tab.active");
    try { if (t) t.focus({ preventScroll: true }); } catch (e) {}
    // A stand-in (e.g. the control was disabled mid-read): go back to the real one on the next repaint.
    UI._fbEl = exact || was.tab ? null : t; UI._fbWant = exact || was.tab ? null : was;
  }

  function clearBody() {
    var fEl = UI.card && UI.root.activeElement && UI.card.contains(UI.root.activeElement) && (!UI.root.activeElement.closest(".rs-top") || UI.root.activeElement === UI._fbEl) ? UI.root.activeElement : null;
    if (fEl) { var fWas = (fEl === UI._fbEl && UI._fbWant) || { tag: fEl.tagName, name: focusName(fEl), tab: false }, card = UI.card; Promise.resolve().then(function () { restoreFocus(card, fWas); }); }
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
    clearHighlights();   // Find highlights never outlive the panel
    if (UI.card && _pendingMp && _pendingMp.ack === false && currentTab === "import") toast("The “Not imported” list is kept — open Import to review it.", null, "info");
    if (UI.card && UI.card.parentNode) FX.fold(UI.card);
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
  var _toastSeq = 0;   // bumped per toast, so a delayed follow-up can tell it was superseded
  // Dismiss after ms; an info/error message waits while hovered or focused.
  function toastTimer(node, ms, info, done) {
    var tm = setTimeout(done, ms);
    if (!info) return;
    var stop = function () { clearTimeout(tm); }, go = function () { clearTimeout(tm); tm = setTimeout(done, 2500); };
    node.addEventListener("mouseenter", stop); node.addEventListener("focusin", stop);
    node.addEventListener("mouseleave", go); node.addEventListener("focusout", go);
  }
  function toast(msg, undoFn, kind) {
    _toastSeq++;
    kind = kind || toastKind(msg);
    var life = kind === "info" ? 6000 : 3600;   // warnings/errors stay long enough to read
    try { if (/ZIP downloaded|Backup downloaded/.test(String(msg))) FX.fly(); } catch (e) {}
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
      toastTimer(c, life, kind === "info", function () { try { c.remove(); } catch (e) {} });
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
          toastTimer(c2, life, kind === "info", function () { try { c2.remove(); } catch (e) {} });
          return;
        }
      }
    } catch (e) {}
    toastTimer(t, life, kind === "info", function () {
      t.style.transition = "opacity .3s,transform .3s";
      t.style.opacity = "0"; t.style.transform = "translateX(20px)";
      setTimeout(function () { try { t.remove(); } catch (e) {} }, 320);
    });
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
        // Never wider than the space under the open panel (it shouldn't poke out past its left edge).
        var cap = Math.min(420, Math.round(L.left - 22)), P = UI.card && UI.card.getBoundingClientRect();
        if (P && P.width && L.left - 10 - P.left >= 220) cap = Math.min(cap, Math.round(L.left - 10 - P.left));
        wrap.style.maxWidth = cap + "px";
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
    pickFile(".zip,.md,.markdown,.txt,application/zip,text/markdown,text/plain", handleImportFile);
  }

  // Import tab home: ONE affordance — a click-or-drop zone for .zip or .md.
  function renderImportHome() {
    ++opGen; // supersede any in-flight Export collect so it can't re-render over this tab
    if (_mpRun) { _mpRun.paint(); return; }   // a migration is running: show its progress, not the drop zone
    if (_pendingMp) { var pm = _pendingMp.out; _pendingMp = null; renderMagicPortResults(pm); return; }
    var cut = mpInterruptedHere();
    if (cut) { _mpCut = null; mpRunClear(); renderMagicPortResults(mpInterruptedOut(cut)); return; }
    if (_pendingResults) { var pr = _pendingResults; _pendingResults = null; renderImportResults(pr.results, pr.opts); return; }
    if (_pendingMpConfirm) { renderMagicPortConfirm(_pendingMpConfirm.config, _pendingMpConfirm.buf); return; }
    if (_pendingReview) { var rv = _pendingReview; renderImportPlan(rv.plan, rv.curMap, rv.src, rv.ropts); return; }
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
      var fl = e.dataTransfer && e.dataTransfer.files;
      if (fl && fl.length > 1) {
        ++opGen; setLinks(false);
        renderImportPlan({ error: "Drop one file at a time (a .zip holds a full set)." }, null);
        return;
      }
      handleImportFile(fl && fl[0]);
    });
    body.appendChild(dz);
    var pills = el("div", "rs-pills");
    ["5-bucket ZIP", "2-bucket ZIP", "single .md"].forEach(function (t) { pills.appendChild(el("span", "rs-pill", t)); });
    body.appendChild(pills);
    body.appendChild(callout("info", null,
      (isTwoField()
        ? "A 5-bucket ZIP is combined into Main Prompt under # headings; a 2-bucket ZIP goes in as is."
        : "A 2-bucket ZIP's Main Prompt is split into the 4 buckets by its # headings; a 5-bucket ZIP goes in file by file.") +
      " You'll see every change and confirm before anything is overwritten."));
    // The last import can still be undone after leaving its results screen.
    if (_lastBackup && !_lastBackup.undone && _lastBackup.importedKeys && _lastBackup.importedKeys.length && backupIsHere(_lastBackup)) {
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
  var WRONG_FILE_TYPE = "That isn't a .zip or .md file — choose a PromptPort export or a Markdown file.";
  // What the user sees when reading a file failed. Our own readers throw plain,
  // complete sentences ("The zip looks damaged …") — those are shown; anything
  // else (a script error) stays in the console and gets a friendly line.
  function importErrorText(err) {
    try { console.debug("[PromptPort] import failed:", err); } catch (e) {}
    var m = err && err.message ? String(err.message) : "";
    var own = err && err.constructor === Error && /^(This|The|Not a)\b/.test(m) && /\.$/.test(m) &&
      !/Cannot read|is not a function|is not defined|undefined|\[object /.test(m);
    return own ? m : "Couldn't read that file — choose a PromptPort export (.zip) or a Markdown (.md) file.";
  }
  // Text that is really a binary file (image, PDF, Office document) read as text.
  function looksBinary(txt) {
    var t = String(txt || "");
    if (t.indexOf("\u0000") !== -1) return true;
    var bad = (t.match(/\uFFFD/g) || []).length;
    return bad >= 8 || (bad > 0 && bad / t.length > 0.01);
  }
  // Decode a picked .md file's bytes. UTF-8 (with or without BOM) and UTF-16 as
  // before; a file that is not valid UTF-8 and has no NUL bytes is an "ANSI"
  // (Windows-1252 / Latin-1) text file from an older editor — decoded as such
  // instead of being refused or mangled into U+FFFD.
  function decodeImportBytes(u8) {
    var txt = window.PPUnzip && window.PPUnzip.decodeText ? window.PPUnzip.decodeText(u8) : new TextDecoder("utf-8").decode(u8);
    if (String(txt).indexOf("\uFFFD") === -1) return txt;
    try { new TextDecoder("utf-8", { fatal: true }).decode(u8); return txt; } catch (e) {}   // real U+FFFD in valid UTF-8
    if (u8.indexOf(0) !== -1) return txt;   // NUL bytes: UTF-16 or binary — leave it to looksBinary
    try {
      var ansi = new TextDecoder("windows-1252").decode(u8);
      var ctl = (ansi.match(/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g) || []).length;
      return ctl > 0 && ctl / ansi.length > 0.01 ? txt : ansi;   // many control bytes: binary, not text
    } catch (e) { return txt; }
  }
  var BUSY_MSG = "Wait for the current task to finish.";
  function handleImportFile(file) {
    if (!file) return;
    if (_mpRun) { toast("A Magic Port migration is running — wait for it to finish before importing another file.", null, "info"); return; }
    // Reading the file and the current fields drives the page: one task at a time.
    if (typeof ppLock === "function" && !ppLock("import")) { toast(BUSY_MSG, null, "info"); return; }
    var locked = true, unlock = function () { if (locked && typeof ppUnlock === "function") ppUnlock("import"); locked = false; };
    _pendingReview = null; _pendingMpConfirm = null;
    ++opGen;
    setLinks(false);   // a new activity started
    if (file.size > MAX_IMPORT_BYTES) {
      unlock();
      renderImportPlan({ error: "“" + file.name + "” is " + (Math.ceil(file.size / 1048576 * 10) / 10).toFixed(1) + " MB — too large to import (the limit is 20 MB). Prompt files are usually well under 1 MB." }, null);
      return;
    }
    var name = (file.name || "").toLowerCase();
    if (!/\.(zip|md|markdown|txt)$/.test(name)) {
      unlock();
      renderImportPlan({ error: WRONG_FILE_TYPE }, null);
      return;
    }
    if (/\.zip$/.test(name)) {
      file.arrayBuffer().then(function (buf) {
        // Magic Port zip? (contains magicport.json) -> full-bot migration.
        // (PPUnzip parses the buffer once; readZipSource reuses that result.)
        return peekMagicPort(buf).then(function (mp) {
          if (mp && mp.error) { unlock(); renderImportPlan({ error: mp.error }, null); return; }
          if (mp) { unlock(); renderMagicPortConfirm(mp.config, buf); return; }
          // otherwise the existing prompt-only import
          return readZipSource(buf).then(beginImport).then(unlock, function (e) { unlock(); throw e; });
        });
      }).catch(function (err) { unlock(); renderImportPlan({ error: importErrorText(err) }, null); });
    } else {
      // Read the bytes and decode them ourselves: a UTF-16 ("Unicode" in
      // Notepad) or BOM-prefixed UTF-8 file is text too.
      var rd = file.arrayBuffer ? file.arrayBuffer().then(function (ab) {
        return decodeImportBytes(new Uint8Array(ab));
      }) : (file.text ? file.text() : new Promise(function (res, rej) {
        var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsText(file);
      }));
      Promise.resolve(rd).then(function (txt) {
        txt = String(txt == null ? "" : txt).replace(/^\uFEFF/, "");
        if (!txt || !txt.trim()) { unlock(); renderImportPlan({ error: "That file was empty." }, null); return; }
        if (looksBinary(txt)) { unlock(); renderImportPlan({ error: WRONG_FILE_TYPE }, null); return; }
        return Promise.resolve(beginImport(sourceFromMd(txt, file.name))).then(unlock, unlock);
      }).catch(function () { unlock(); renderImportPlan({ error: "Couldn't read the file." }, null); });
    }
  }

  // ---- Magic Port import (full-bot migration) -----------------------------
  // Peek a zip for magicport.json; return {config, names} or null.
  async function peekMagicPort(arrayBuffer) {
    if (!window.MagicPort) return null;
    var entries;
    try { entries = await window.PPUnzip.read(arrayBuffer); } catch (e) { return null; }
    var names = [].map.call(entries, function (f) { return f.name; });
    if (!window.MagicPort.isMagicPortZip(names)) return null;
    var cfgEntry = [].slice.call(entries).filter(function (f) { return /(^|\/)magicport\.json$/i.test(f.name); })[0];
    if (!cfgEntry) return null;
    var config;
    try { config = JSON.parse(cfgEntry.text); } catch (e) { return { error: MP_DAMAGED }; }
    if (!mpConfigShapeOk(config)) return { error: MP_DAMAGED };
    return { config: config, names: names };
  }
  var MP_DAMAGED = "This Magic Port file is damaged — export it again.";
  // magicport.json must have the shapes the confirm screen and the engine read:
  // objects where objects go, lists where lists go, a text bot name. (A missing
  // or null field is fine — it just means "nothing of that kind".)
  function mpConfigShapeOk(c) {
    var isObj = function (v) { return v != null && typeof v === "object" && !Array.isArray(v); };
    var objOrNone = function (v) { return v == null || isObj(v); };
    // A list's entries must be objects (or text, for the prompt file names) —
    // a null / number / nested-list entry would crash the confirm screen.
    var listOrNone = function (v, str) {
      return v == null || (Array.isArray(v) && v.every(function (x) { return str ? typeof x === "string" : isObj(x); }));
    };
    if (!isObj(c)) return false;
    if (!objOrNone(c.data) || !objOrNone(c.source) || !objOrNone(c.notPortable)) return false;
    var src = c.source || {}, d = c.data || {}, np = c.notPortable || {};
    if (src.botName != null && typeof src.botName !== "string") return false;
    if (!listOrNone(d.variables) || !listOrNone(d.events) || !listOrNone(d.promptFiles, true) || !listOrNone(np.nonApiTools)) return false;
    if (!objOrNone(d.customAnalysis) || !objOrNone(d.tools) || !objOrNone(d.languageVoice) || !objOrNone(d.llmStt) || !objOrNone(d.callConfig)) return false;
    if (d.customAnalysis && !listOrNone(d.customAnalysis.keys)) return false;
    if (d.tools && !["pre_call", "on_call", "post_call"].every(function (p) { return listOrNone(d.tools[p]); })) return false;
    return true;
  }

  // Analysis keys with their source type and the type they will be created as on
  // this dashboard. Types matter (a Number key written as String breaks reporting),
  // so the mapping is shown BEFORE migrating, and any key whose type cannot be
  // matched exactly is called out in a warning that cannot be collapsed away.
  function mpKeyTypeTable(keys, exact) {
    var wrap = el("div", "rs-mp-keys");
    var cap = function (t) { t = String(t == null ? "" : t).trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : "String"; };
    // exact: the keys come from another 2-field bot, already in this
    // dashboard's types — they are created exactly as they are.
    var rows = keys.map(function (k) {
      if (exact) return { name: k.name || k.key, from: cap(k.type), to: cap(k.type), flagged: false, why: "" };
      var m = window.MagicPort.mapKeyTypeDash5ToDash2(k.type); return { name: k.name, from: cap(k.type), to: m.type, flagged: m.flagged, why: m.why }; });
    var flagged = rows.filter(function (r) { return r.flagged; });
    var tally = {}; rows.forEach(function (r) { tally[r.to] = (tally[r.to] || 0) + 1; });
    if (flagged.length) {
      wrap.appendChild(callout("warn", flagged.length + " analysis key type" + (flagged.length > 1 ? "s" : "") + " can't be matched exactly",
        flagged.map(function (r) { return r.name + ": " + r.from + " → String (" + (r.why || "no matching type") + ")"; }).join("; ") + ". Check these after migrating."));
    }
    var det = document.createElement("details"); det.className = "rs-mp-keys-d";
    if (flagged.length || rows.length <= 8) det.open = true;
    var sum = document.createElement("summary");
    sum.textContent = "Analysis keys & types (" + rows.length + ") — " + Object.keys(tally).map(function (t) { return tally[t] + " " + t; }).join(" · ");
    det.appendChild(sum);
    var tb = el("div", "rs-mp-keys-t");
    rows.forEach(function (r) {
      var line = el("div", "rs-mp-key" + (r.flagged ? " flag" : ""));
      line.appendChild(el("span", "rs-mp-key-n", r.name));
      var changed = r.from.toLowerCase() !== r.to.toLowerCase();
      line.appendChild(el("span", "rs-mp-key-t", changed ? (r.from + " → " + r.to) : r.to));
      tb.appendChild(line);
    });
    det.appendChild(tb); wrap.appendChild(det);
    return wrap;
  }

  // A red consent block (checkbox + message). Returns { wrap, checkbox }.
  function mpConsentBlock(innerHtml) {
    var wrap = el("div", "rs-callout rs-mp-consent");
    var cb = document.createElement("input");
    cb.type = "checkbox"; cb.className = "rs-mp-consent-cb";
    cb.checked = false; // never pre-ticked: the user must tick it themselves
    cb.setAttribute("style", "margin:1px 0 0;width:18px;height:18px;flex:0 0 auto;cursor:pointer;accent-color:#22c55e;");
    var txt = el("label", "rs-mp-consent-text");
    txt.setAttribute("style", "cursor:pointer;");
    txt.innerHTML = innerHtml;
    var id = "rs-mp-consent-" + Date.now() + "-" + Math.floor(Math.random() * 1e4);
    cb.id = id; txt.setAttribute("for", id);
    wrap.appendChild(cb); wrap.appendChild(txt);
    return { wrap: wrap, checkbox: cb };
  }

  // Wire a button so it's gated by a consent checkbox: looks disabled until
  // checked; a click while unchecked wiggles the consent block.
  // A tick / click that matters (consent, Migrate, the acknowledgement) must come
  // from the user — the panel's shadow root is open, so a script in the page
  // could otherwise tick and click for them.
  function ppTrusted(e) {
    try { return !!(e && e.isTrusted); } catch (x) { return false; }
  }
  // A page script's checkbox.click() fires a TRUSTED change event, so a tick only
  // counts when the user really pressed / tapped / keyed on the consent block
  // (the box or its label) just before it. Returns e => true for a user's tick.
  var PP_TICK_MS = 1500;
  function ppUserTick(consentEl) {
    if (!consentEl._ppTick) {
      var at = 0;
      var mark = function (e) { if (e.isTrusted) at = Date.now(); };
      ["pointerdown", "mousedown", "touchstart", "keydown"].forEach(function (ty) { consentEl.addEventListener(ty, mark, true); });
      consentEl._ppTick = function (e) { return ppTrusted(e) && at > 0 && Date.now() - at <= PP_TICK_MS; };
    }
    return consentEl._ppTick;
  }
  // proceedFn may return false: the action did not start (the button works again).
  function mpWireConsentGate(consentEl, checkbox, btn, proceedFn) {
    var wasOn = false, ticked = false;   // ticked: the box was ticked by the user
    function sync() {
      var on = checkbox.checked && ticked;
      if (on && !wasOn) {
        try { var cr = checkbox.getBoundingClientRect(); FX.burst(cr.left + cr.width / 2, cr.top + cr.height / 2, "#22c55e", 12); } catch (e) {}
        setTimeout(function () { FX.wake(btn); }, 120);
      }
      wasOn = on;
      btn.setAttribute("aria-disabled", on ? "false" : "true");
    }
    function wiggle(node) {
      try {
        node.animate(
          [{ transform: "translateX(0)" }, { transform: "translateX(-7px)" }, { transform: "translateX(7px)" },
           { transform: "translateX(-5px)" }, { transform: "translateX(5px)" }, { transform: "translateX(0)" }],
          { duration: 420, easing: "ease-in-out" });
        var ob = node.style.borderColor; node.style.borderColor = "#ef4444";
        setTimeout(function () { node.style.borderColor = ob || ""; }, 500);
      } catch (e) {}
      try { node.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
    }
    var userTick = ppUserTick(consentEl);
    checkbox.addEventListener("change", function (e) { ticked = checkbox.checked && userTick(e); sync(); }); sync();
    var fired = false;   // a double/triple click must never start the action twice
    btn.addEventListener("click", function (e) {
      if (!(checkbox.checked && ticked)) { wiggle(consentEl); try { checkbox.focus(); } catch (x) {} return; }
      if (!ppTrusted(e)) return;
      if (fired) return;
      fired = true;
      if (proceedFn() === false) fired = false;
    });
  }

  // The host a Magic Port file was exported from (read from the file).
  function mpSourceHost(src) {
    if (!src) return "";
    if (src.host) return String(src.host);
    try { return src.url ? new URL(src.url).hostname : ""; } catch (e) { return ""; }
  }
  // 2-field dashboard hosts from manifest.json, split into production and test
  // environments (a test host has a "qa" or "dev…" label). Nothing hard-coded.
  // Read once at boot and kept: after the extension is reloaded or updated, this
  // (orphaned) script can no longer read the manifest, and the production /
  // test-environment warnings must not silently disappear.
  var _mpHostsCache = null;
  function mpDash2Hosts() {
    if (_mpHostsCache && (_mpHostsCache.prod.length || _mpHostsCache.test.length)) return _mpHostsCache;
    var hosts = [];
    try {
      var cs = chrome.runtime.getManifest().content_scripts || [];
      ((cs[2] && cs[2].matches) || []).forEach(function (m) {
        var h = (/^[^:]+:\/\/([^/]+)/.exec(m) || [])[1];
        if (h && hosts.indexOf(h) === -1) hosts.push(h.replace(/^\*\./, ""));
      });
    } catch (e) {}
    var isTest = function (h) { return h.split(".").some(function (l) { return /^(qa|dev[a-z0-9-]*|staging|test)$/i.test(l); }); };
    _mpHostsCache = { prod: hosts.filter(function (h) { return !isTest(h); }), test: hosts.filter(isTest) };
    return _mpHostsCache;
  }
  // The extension was reloaded / updated while this page stayed open: this copy
  // of the script is cut off from it ("Extension context invalidated").
  function ppOrphaned() {
    try { return !(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return true; }
  }
  var PP_ORPHAN_TEXT = "PromptPort was updated — reload this page.";
  function mpIsProductionHost(hostname) {
    var H = mpDash2Hosts(), h = String(hostname || "").toLowerCase();
    return H.prod.some(function (p) { p = p.toLowerCase(); return h === p || h.slice(-(p.length + 1)) === "." + p; });
  }
  // Tool / webhook URLs in the file that point at a test environment: "qa." or
  // a dev-environment label taken from the manifest's test hosts.
  // Label-based on the address's host name: a label that is, or starts / ends
  // with, qa / staging / stage / dev / test / uat / sandbox / preview (qa.x,
  // qa-api.x, x-staging.y), plus the dev-environment labels of the manifest's
  // test hosts. A production host that merely contains the letters (api.iqa.ai)
  // is not flagged.
  var MP_TEST_LABEL_RE = /(^|[.-])(qa|staging|stage|dev|test|uat|sandbox|preview)([.-]|$)/i;
  function mpTestEnvUrls(d) {
    var marks = [];
    mpDash2Hosts().test.forEach(function (h) {
      h.split(".").forEach(function (l) { if (/^dev[a-z0-9-]+$/i.test(l) && marks.indexOf(l.toLowerCase()) === -1) marks.push(l.toLowerCase()); });
    });
    function hostOf(u) {
      var m = /^[a-z][a-z0-9+.\-]*:\/\/([^\/?#]+)/i.exec(u) || /^\/*([^\/?#\s]+)/.exec(u);
      return m ? m[1].replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase() : "";
    }
    // Returns one label per item ("tool fetch_due: test-environment address");
    // the address itself is never shown (it would name the dashboard's site).
    var out = [], seen = [];
    function check(u, who) {
      u = String(u || "").trim(); if (!u) return;
      var h = hostOf(u);
      if (h && (MP_TEST_LABEL_RE.test(h) || h.split(".").some(function (l) { return marks.indexOf(l) !== -1; }))) {
        var k = who + "\n" + u; if (seen.indexOf(k) !== -1) return;
        seen.push(k); out.push(who + ": test-environment address");
      }
    }
    ["pre_call", "on_call", "post_call"].forEach(function (p) {
      ((d.tools || {})[p] || []).forEach(function (t) {
        if (!t) return;
        check(t.url || (t.raw && t.raw.config && t.raw.config.url) || (t.raw && t.raw.url), "tool " + (t.name ? String(t.name) : "(unnamed)"));
      });
    });
    (d.events || []).forEach(function (e, i) { if (e) check(e.url, "webhook " + (i + 1) + (e.name ? " (" + e.name + ")" : "")); });
    return out;
  }

  // "1 tool" / "2 tools" — one helper for every count on the Magic Port screens.
  function mpCount(n, one, many) { n = +n || 0; return n + " " + (n === 1 ? one : (many || one + "s")); }
  // Summary + one-click "Migrate" confirmation before writing anything.
  function renderMagicPortConfirm(config, arrayBuffer) {
    ++opGen;
    _pendingMpConfirm = { config: config, buf: arrayBuffer }; _pendingReview = null;   // kept if the panel is closed (never the consent tick)
    freshPanel("Magic Port — import");
    var d = config.data || {};
    var src = config.source || {};
    var dest = window.MagicPort.hostPlatform();
    // Magic Port only writes onto a 2-field dashboard bot: say so up front
    // instead of asking for consent and failing after.
    if (dest !== window.MagicPort.DASH2) {
      panel.appendChild(callout("info", "This page can't receive a Magic Port import",
        "Magic Port imports onto a 2-field dashboard bot. Open the destination bot there and drop this file."));
      addCloseRow();
      return;
    }
    var toolCount = 0; ["pre_call", "on_call", "post_call"].forEach(function (p) { toolCount += ((d.tools || {})[p] || []).length; });
    var ca0 = d.customAnalysis || {}, lv0 = d.languageVoice || {};
    var hasAny = (d.variables || []).length || (ca0.keys || []).length || ca0.prompt || (d.events || []).length || toolCount ||
      (d.promptFiles || []).length || Object.keys(lv0).some(function (k) { return lv0[k] != null && lv0[k] !== ""; }) ||
      (d.llmStt && (d.llmStt.llm || d.llmStt.stt)) || (d.callConfig && Object.keys(d.callConfig).length);
    if (!hasAny) {
      panel.appendChild(callout("info", "Nothing to migrate",
        "This Magic Port file has no prompt, variables, analysis, tools or event subscriptions in it. Export the source bot again with Magic Port."));
      addCloseRow();
      return;
    }
    var srcDash2 = window.MagicPort.normPlatform ? window.MagicPort.normPlatform(src.platform) === window.MagicPort.DASH2 : false;
    var srcHost = mpSourceHost(src);
    var srcLayout = window.MagicPort.layoutLabel ? window.MagicPort.layoutLabel(src.platform) : "";
    // Environments are named, never their web addresses (no site names on the UI).
    var envOf = function (h) { if (!h) return ""; return mpIsProductionHost(h) ? "production" : (/(^|\.)(qa|dev[a-z0-9-]*|staging|test)\./i.test(h + ".") ? "test environment" : ""); };
    panel.appendChild(callout("info", "Migrate a full bot onto this bot",
      "Source: " + [src.botName ? src.botName : "(unnamed)", srcLayout, envOf(srcHost)].filter(Boolean).join(" · ") + "." +
      " Destination: this bot" + (envOf(location.hostname) ? " · " + envOf(location.hostname) : "") + "."));
    // Safety: importing a bot onto itself would only duplicate its own items.
    var confirmBot = pageBotId();   // the bot this screen was drawn for
    var sameBot = !!(src.botId && confirmBot && String(src.botId).toLowerCase() === confirmBot);
    if (sameBot) {
      var sb = callout("bad", "This is the same bot the file came from",
        "Importing it here would add its own variables, tools and events a second time. Open a different (blank) bot to migrate onto.");
      sb.classList.add("rs-mp-samebot");
      panel.appendChild(sb);
    }
    // Environment: a test-environment address carried into production.
    if (mpIsProductionHost(location.hostname)) {
      var testUrls = mpTestEnvUrls(d);
      if (testUrls.length) {
        var tw = callout("warn", testUrls.length + " test-environment address" + (testUrls.length > 1 ? "es" : "") + " going to production",
          "These will be written as-is on this production bot — " + testUrls.join("; ") + ". Change them after migrating if they should point to production.");
        tw.classList.add("rs-mp-envwarn");
        panel.appendChild(tw);
      }
    }
    var ul = el("div", "rs-note");
    function line(txt) { panel.appendChild(lineRow("•", null, txt)); }
    line(mpCount((d.variables || []).length, "custom variable"));
    line(mpCount(((d.customAnalysis && d.customAnalysis.keys) || []).length, "custom-analysis key") + (d.customAnalysis && d.customAnalysis.prompt ? " + analysis prompt" : ""));
    line(mpCount((d.events || []).length, "event subscription"));
    var anKeys = (d.customAnalysis && d.customAnalysis.keys) || [];
    if (anKeys.length && dest === window.MagicPort.DASH2) panel.appendChild(mpKeyTypeTable(anKeys, srcDash2));
    var toolN = 0; ["pre_call", "on_call", "post_call"].forEach(function (p) { toolN += ((d.tools || {})[p] || []).length; });
    line(mpCount(toolN, "tool"));
    // A 5-field source carries its languages only (no voice).
    line("prompt (" + mpCount((d.promptFiles || []).length, "file") + ")" + (srcDash2 ? " + language/voice" : " + languages"));
    // Sections only a 2-field source carries.
    var pm = function (o, f) { return o ? [o.provider, o[f || "model"]].map(function (x) { return String(x || "").trim(); }).filter(Boolean).join(" · ") : ""; };
    if (d.llmStt && (d.llmStt.llm || d.llmStt.stt)) {
      line("LLM and STT — LLM: " + (pm(d.llmStt.llm) || "(not named)") + "; STT: " + (pm(d.llmStt.stt) || "(not named)"));
    }
    var lv = d.languageVoice || {};
    if (lv.voice || lv.speed != null) {
      line("Voice: " + (lv.voice ? ([lv.voice.name, lv.voice.provider, lv.voice.model].filter(Boolean).join(" · ") || "(not named)") : "(unchanged)") +
        (lv.speed != null ? " — speed " + lv.speed : ""));
    }
    if (d.callConfig && typeof d.callConfig === "object") {
      var ccN = Object.keys(d.callConfig).length;
      line("Call Config: " + mpCount(ccN, "setting"));
    }
    if (d.customAnalysis && "model" in d.customAnalysis) {
      line("Analysis model: " + (d.customAnalysis.model ? (pm(d.customAnalysis.model, "name") || pm(d.customAnalysis.model) || "(not named)") : "dashboard default"));
    }
    if (srcDash2) {
      panel.appendChild(callout("info", "Copied exactly",
        "The source is a 2-field bot: analysis keys (with their types), variables (with their types) and the selected events are copied exactly as they are."));
    }
    if (config.containsCredentials) panel.appendChild(callout("warn", "Contains credentials", "Tool cURLs / webhook URLs may include keys or tokens; they'll be written as-is."));
    // Tell the user up-front what the source bot HAS that won't be migrated
    // (non-API tools: widgets/callback/whatsapp; 3rd+ languages). These are out
    // of the Magic Port scope (API cURL tools + primary/secondary language).
    var np = config.notPortable || {};
    var npTools = (np.nonApiTools || []);
    if (npTools.length) {
      panel.appendChild(callout("info", "Won't be migrated (out of scope)",
        "The source bot also has non-API/widget tools that Magic Port doesn't carry over: " +
        npTools.map(function (t) { return (t.name || "tool") + " (" + (t.toolType || "non-API") + ")"; }).join(", ") +
        ". Everything else above migrates normally."));
    }

    // ---- required consent (import OVERWRITES everything on this bot) --------
    var c = mpConsentBlock(
      "<b>This will change this bot.</b> Magic Port writes the imported bot's prompt, " + (srcDash2 ? "language/voice" : "languages") + " and analysis over this bot's, and <b>adds</b> its variables, tools and event subscriptions. Anything already here that the imported bot doesn't have is <b>left in place</b> — nothing is deleted — and the results screen lists what was left. Use a <b>blank bot</b> unless you mean to change this one. I understand and want to continue.");
    panel.appendChild(c.wrap);

    var foot = footer();
    var row = el("div", "rs-row");
    var go = el("button", "rs-btn rs-btn-primary", "Migrate");
    var cancel = el("button", "rs-btn rs-btn-ghost", "Cancel");
    if (sameBot) {
      // Locked outright — the consent tick does not unlock it.
      go.disabled = true;
      go.setAttribute("aria-disabled", "true"); go.style.opacity = "0.45"; go.style.cursor = "not-allowed";
      go.title = "This is the same bot the file came from — open a different bot to migrate onto.";
      c.checkbox.disabled = true;
      c.wrap.classList.add("rs-mp-consent-off");
      var lbl = c.wrap.querySelector(".rs-mp-consent-text"); if (lbl) lbl.style.cursor = "not-allowed";
    } else mpWireConsentGate(c.wrap, c.checkbox, go, function () {
      // Checked again at the click, not only when this screen was drawn: the page
      // may have moved to another bot (or onto the source bot) since.
      var botNow = pageBotId();
      if (botNow !== confirmBot || (src.botId && botNow && String(src.botId).toLowerCase() === botNow)) {
        toast(botNow !== confirmBot ? "You moved to another bot — check the details again before migrating." :
          "This is the same bot the file came from — open a different bot to migrate onto.", null, "info");
        renderMagicPortConfirm(config, arrayBuffer);
        return false;
      }
      if (_mpRun || ppBusy()) { toast(ppBusyText(), null, "info"); return false; }
      go.setAttribute("aria-disabled", "true"); go.style.opacity = "0.45"; go.style.cursor = "not-allowed";
      runMagicPortImport(config, arrayBuffer);
    });
    cancel.addEventListener("click", function () { _pendingMpConfirm = null; renderImportHome(); });
    row.appendChild(go); row.appendChild(cancel);
    foot.appendChild(row);
  }

  // Run the full import via the orchestrator; wire the prompt step to the
  // existing prompt pipeline (resolveImportPlan -> runImport).
  // A prompt file that is empty or only our "nothing found" placeholder comment.
  function mpEmptyPromptFile(text) {
    var t = String(text == null ? "" : text).replace(/<!--[\s\S]*?-->/g, "");
    // A collated Main Prompt made only of bucket headings is empty too.
    t = t.split(/\r?\n/).filter(function (ln) { return !/^\s{0,3}#{1,6}\s*(objective|response guidelines?|conversation (flow|script)|faqs?|main prompt|first message)\s*#*\s*$/i.test(ln); }).join("\n");
    return !t.replace(/\s+/g, "");
  }
  var MP_MOVED = "you moved to another bot";
  // The sections run() goes through for this file, in order (for "not run" rows).
  function mpPlannedSections(config) {
    var md = {};
    try { md = (window.MagicPort.mapForDestination(config, window.MagicPort.hostPlatform()) || {}).data || {}; } catch (e) { md = (config && config.data) || {}; }
    var ls = md.llmStt;
    var hasLlmStt = !!(ls && ((ls.llm && (ls.llm.provider || ls.llm.model)) || (ls.stt && (ls.stt.provider || ls.stt.model))));
    var hasCallConfig = !!(md.callConfig && typeof md.callConfig === "object" && Object.keys(md.callConfig).length);
    var out = ["variables", "tools", "prompt", "languageVoice"];
    if (hasLlmStt) out.push("llmStt");
    if (hasCallConfig) out.push("callConfig");
    return out.concat(["analysis", "events", "final-save"]);
  }
  // ---- a migration's progress survives a reload / a session-expiry redirect ----
  // While a run goes, what it has done so far is kept in this tab's
  // sessionStorage (same tab, same site; nothing secret: section names, counts,
  // item names). A run that ends normally removes it. If the page is reloaded or
  // sent to the login page mid-run, the next page finds it and the Import tab
  // shows "Last migration was interrupted" with what was done.
  var MP_RUN_KEY = "promptport-v41-mp-run";
  var MP_PART = "stopped part-way — check it on the page";
  var MP_RUN_MAX_AGE = 12 * 3600 * 1000;
  function mpRunSave(rec) {
    try { if (rec) window.sessionStorage.setItem(MP_RUN_KEY, JSON.stringify(rec)); } catch (e) {}
  }
  function mpRunClear() {
    try { window.sessionStorage.removeItem(MP_RUN_KEY); } catch (e) {}
  }
  // The stored record, checked field by field (the page can write this storage too).
  function mpRunLoad() {
    var rec = null;
    try { rec = JSON.parse(window.sessionStorage.getItem(MP_RUN_KEY) || "null"); } catch (e) { rec = null; }
    var str = function (v, n) { return typeof v === "string" ? v.slice(0, n || 300) : ""; };
    if (!rec || typeof rec !== "object" || rec.v !== 1 || typeof rec.bot !== "string" || !Array.isArray(rec.planned) || !Array.isArray(rec.results)) return null;
    if (!(+rec.at > 0) || Date.now() - +rec.at > MP_RUN_MAX_AGE) { mpRunClear(); return null; }
    return {
      v: 1, bot: str(rec.bot, 64).toLowerCase(), at: +rec.at, src: str(rec.src, 200), reached: str(rec.reached, 40),
      planned: rec.planned.filter(function (k) { return typeof k === "string"; }).slice(0, 20).map(function (k) { return k.slice(0, 40); }),
      results: rec.results.filter(function (r) { return r && typeof r === "object" && typeof r.section === "string"; }).slice(0, 20).map(mpRunSlim)
    };
  }
  // What the report needs of a section result — short texts and counts only.
  function mpRunSlim(r) {
    var strs = function (a, n) { return Array.isArray(a) ? a.filter(function (x) { return typeof x === "string" || typeof x === "number"; }).slice(0, n).map(function (x) { return String(x).slice(0, 300); }) : []; };
    var o = { section: String(r.section).slice(0, 40), ok: r.ok === true, failedItems: strs(r.failedItems, 60) };
    if (typeof r.reason === "string" && r.reason) o.reason = r.reason.slice(0, 300);
    ["created", "alreadyPresent", "count", "actual"].forEach(function (k) { if (typeof r[k] === "number" && isFinite(r[k])) o[k] = r[k]; });
    ["warnings", "notes", "missing", "leftovers"].forEach(function (k) { var a = strs(r[k], 40); if (a.length) o[k] = a; });
    return o;
  }
  // Record one section's result (a later result for the same section replaces it).
  function mpRunStep(rec, r) {
    if (!rec || !r || typeof r !== "object" || typeof r.section !== "string") return;
    try {
      var slim = mpRunSlim(r), i;
      for (i = 0; i < rec.results.length; i++) if (rec.results[i].section === slim.section) break;
      rec.results[i] = slim;
      mpRunSave(rec);
    } catch (e) {}
  }
  // The section the page shows now, as a run step name ("" if none / not one).
  var MP_TAB_STEP = { "custom variables": "variables", "custom-variables": "variables", "tools": "tools", "prompt": "prompt",
    "language and voice": "languageVoice", "language-voice": "languageVoice", "llm and stt": "llmStt", "llm-stt": "llmStt",
    "call config": "callConfig", "call-config": "callConfig", "custom analysis": "analysis", "custom-analysis": "analysis",
    "event subscription": "events", "event-subscription": "events" };
  function mpStepOnScreen() {
    try { return MP_TAB_STEP[String(d2CurrentTopTab() || "").toLowerCase()] || ""; } catch (e) { return ""; }
  }
  // A run that was cut off, for the page now showing: the same bot, or a page
  // with no bot (the login page after a session expiry). Turned into the
  // report's shape; the stored record is removed once it is shown.
  var _mpCut = null;
  try { _mpCut = mpRunLoad(); } catch (e) { _mpCut = null; }
  function mpInterruptedHere() {
    if (_mpRun || !_mpCut) return null;
    var bot = pageBotId();
    if (bot && bot !== _mpCut.bot) return null;
    return _mpCut;
  }
  function mpInterruptedOut(rec) {
    var auth = false;
    try { auth = !!(window.MagicPortDom && window.MagicPortDom.isAuthRedirect && window.MagicPortDom.isAuthRedirect()); } catch (e) {}
    var results = rec.results.slice(), seen = {};
    results.forEach(function (r) { seen[r.section] = 1; });
    var upTo = rec.planned.indexOf(rec.reached);
    rec.planned.forEach(function (k, i) {
      if (!seen[k] && i <= upTo) results.push({ section: k, ok: false, reason: MP_PART, failedItems: [] });
    });
    return { ok: false, interrupted: true, interruptWhy: auth ? "session expired (logged out)" : "the page was reloaded or left",
      srcName: rec.src, results: results, planned: rec.planned, notes: [], warnings: [],
      backupNote: "Undo isn't available for this migration: its backup was lost when the page was left." };
  }
  function mpInterruptNotice() {
    setTimeout(function () {
      try {
        if (mpInterruptedHere() && !UI.card) toast("The last Magic Port migration was interrupted — open Import to see what was done.", null, "info");
      } catch (e) {}
    }, 1200);
  }
  async function runMagicPortImport(config, arrayBuffer) {
    // One migration at a time: a second one would write over the first.
    if (_mpRun) { toast("A Magic Port migration is already running — wait for it to finish.", null, "info"); return; }
    // …and never while another job (an export tour, an import, Replace) drives the page.
    if (!ppLock("migrate")) { toast(ppBusyText(), null, "info"); return; }
    _pendingMpConfirm = null; _pendingReview = null;
    // The run is tied to the bot it started on: if the page moves to another bot
    // (SPA navigation) every later step and hook stops instead of writing there.
    var run = _mpRun = { paused: false, bot: pageBotId(), moved: false };
    _mpCut = null;   // a new run replaces any older interrupted report
    var rec = run.rec = { v: 1, bot: run.bot, at: Date.now(), src: String((config && config.source && config.source.botName) || "").slice(0, 200),
      planned: [], results: [], reached: "" };
    try { rec.planned = mpPlannedSections(config); } catch (e) {}
    mpRunSave(rec);
    // Moved = the page now shows a different bot (or no bot) — but a bounce to
    // the login page is a session expiry, reported as such, not a move.
    function botMoved() {
      if (!run.moved && pageBotId() !== run.bot) {
        var auth = false;
        try { auth = !!(origAuth ? origAuth.call(MPD) : (MPD && MPD.isAuthRedirect && MPD.isAuthRedirect())); } catch (e) {}
        if (!auth) run.moved = true;
      }
      return run.moved;
    }
    var keepFocus = focusKeeper();   // the run drives the page; focus goes back to the panel after
    var status, runningHtml, out;
    var MPI = window.MagicPortImport, MPD = window.MagicPortDom, origAuth = null;
    // Painted again whenever the Import tab is opened while the run is going.
    run.paint = function () {
    freshPanel("Magic Port — migrating…");
    status = el("div", "rs-note rs-working");
    status.innerHTML = IC.spin + "<span>Writing sections… do not navigate away.</span>";
    status.setAttribute("aria-live", "polite");
    if (runningHtml == null) runningHtml = status.innerHTML;
    if (run.paused) run.onPause(true);
    try {
      var scene = el("div"); scene.innerHTML = FX.portScene("Source bot", "This bot");
      panel.appendChild(scene);
    } catch (e) {}
    panel.appendChild(status);
    };
    try {
    run.paint();

    // Backup of the prompt fields for Undo — read on the Prompt tab (its editors
    // exist only there), never "whatever editors another tab shows". An empty or
    // unreadable backup is not kept: Undo would only empty the fields.
    _lastBackup = null;
    run.backupNote = "";
    try {
      var g00 = isTwoField() ? twoFieldEditors() : null;
      if (g00 && !(g00.fm && g00.mp) && MPI && typeof MPI.gotoTab === "function") {
        await MPI.gotoTab("Prompt", { budgetMs: 6000 });
        for (var w0 = 0; w0 < 20; w0++) { var g0 = twoFieldEditors(); if (g0.fm && g0.mp) break; await sleep(150); }
      }
    } catch (e) {}
    var bk = null;
    try {
      var g1 = isTwoField() ? twoFieldEditors() : null;
      if (!g1 || (g1.fm && g1.mp)) bk = await runExclusive(snapshotBuckets);
    } catch (e) { bk = null; }
    var bkHasText = !!(bk && (bk.sections || []).some(function (x) { return x && x.text && String(x.text).trim(); }));
    if (bkHasText) { bk.botId = run.bot; bk.magicPort = true; _lastBackup = bk; }
    else run.backupNote = bk
      ? "Undo isn't offered for this migration: the prompt fields were empty before it, so there is nothing to put back."
      : "Undo isn't offered for this migration: the prompt fields couldn't be read before it started.";

    // Every page check the run makes for a login bounce also stops it once the
    // page has moved to another bot.
    try {
      if (MPD && typeof MPD.isAuthRedirect === "function") {
        origAuth = MPD.isAuthRedirect;
        // The section showing before the run starts (the backup opened Prompt)
        // says nothing about progress: sampled only once the run has moved on.
        var sampledAt = 0, startStep = mpStepOnScreen(), leftStart = false;
        MPD.isAuthRedirect = function () {
          // Where the run has got to (steps go in order): kept for a cut-off report.
          if (Date.now() - sampledAt > 300 && !run.moved) {
            sampledAt = Date.now();
            var st = mpStepOnScreen();
            if (st && st !== startStep) leftStart = true;
            if (st && leftStart && rec.planned.indexOf(st) > rec.planned.indexOf(rec.reached)) { rec.reached = st; mpRunSave(rec); }
          }
          return botMoved() || origAuth.apply(this, arguments);
        };
      }
    } catch (e) { origAuth = null; }

    // The destination's own config comes from the page's answers the
    // interceptor kept: fetch the current set before the run reads it.
    if (isTwoField()) { try { await d2AskGateway(2500); } catch (e) {} }

    var ctx = {
      // Record a finished step for a cut-off report (may be called again for
      // the same section; the last result wins).
      onStep: function (r) { mpRunStep(rec, r); },
      // Re-read what the page last got from the server, then destAgentConfig().
      refreshDest: async function (ms) {
        try { await d2AskGateway(ms || 2500); } catch (e) {}
        return ctx.destAgentConfig();
      },
      // The destination's own agent_config (from the page's last answer for this
      // bot), so settings with no control on screen are compared against it.
      destAgentConfig: function () {
        try {
          var bot = pageBotId(), best = null;
          gwStore.forEach(function (c) {
            var m = String(c.url || "").match(/\/v1\/voiceagents\/([^\/?#]+)\/?(?:[?#]|$)/i);
            var a = c.data && c.data.data;
            if (m && m[1].toLowerCase() === bot && a && a.agent_config && typeof a.agent_config === "object") best = a.agent_config;
          });
          return best;
        } catch (e) { return null; }
      },
      // For the orchestrator: a non-empty string = stop before the next step.
      guard: function () { return botMoved() ? MP_MOVED : ""; },
      importPrompt: async function () {
        if (botMoved()) return { section: "prompt", ok: false, reason: MP_MOVED, stop: true };
        try {
          // Only ever the Prompt tab's own two editors.
          if (isTwoField()) {
            var pe = twoFieldEditors();
            if (!(pe.fm && pe.mp)) return { section: "prompt", ok: false, reason: "the First Message / Main Prompt editors weren't found on the Prompt tab" };
          }
          var src = await readZipSource(arrayBuffer);
          var cur = await runExclusive(collectSections);
          if (botMoved()) return { section: "prompt", ok: false, reason: MP_MOVED, stop: true };
          var curMap = {}; (cur || []).forEach(function (c) { curMap[c.key] = c.text || ""; });
          var plan = resolveImportPlan(src, curMap);
          // An empty source file (or our "nothing found" placeholder) never
          // clears the destination: it is skipped and reported.
          var skipped = [];
          var matched = (plan.matched || []).filter(function (m) {
            if (m && m.file && !mpEmptyPromptFile(m.file.text)) return true;
            skipped.push(((m && m.sec && m.sec.title) || "Prompt") + " — the source file was empty; left as is");
            return false;
          });
          // First pass writes all buckets; then each bucket that didn't take is
          // retried individually (up to 3 attempts total), and the rest proceed.
          var results = matched.length ? await runImport(matched) : [];
          var byTitle = {}; results.forEach(function (r) { byTitle[r.title] = r; });
          var failed = [];
          for (var i = 0; i < matched.length; i++) {
            var m = matched[i];
            var r0 = byTitle[m.sec.title];
            var ok = !!(r0 && r0.ok);
            for (var a = 1; a <= 2 && !ok; a++) { // 2 more tries → 3 total
              if (botMoved()) break;
              try { var res = await runImport([m]); ok = !!(res[0] && res[0].ok); } catch (e) { ok = false; }
              if (!ok) await sleep(250);
            }
            if (!ok) failed.push(m.sec.title);
          }
          if (botMoved()) return { section: "prompt", ok: false, reason: MP_MOVED, stop: true, failedItems: failed };
          var promptNotes = [];
          if (isTwoField()) {
            var plainRefs = 0;
            matched.forEach(function (pm) { plainRefs += countNonVariableRefs(pm && pm.file && pm.file.text); });
            if (plainRefs) promptNotes.push(plainRefsNote(plainRefs));
            // New layout: a table can make the final Save fail — say why up front.
            var pe2 = twoFieldEditors();
            [[pe2.fm, "First Message"], [pe2.mp, "Main Prompt"]].forEach(function (x) {
              var tw = v2TableSaveWarning(x[0]);
              if (tw) promptNotes.push(x[1] + ": " + tw + ".");
            });
          }
          var pRes = { section: "prompt", ok: failed.length === 0 && skipped.length === 0, failedItems: failed.concat(skipped), notes: promptNotes };
          mpRunStep(rec, pRes);
          return pRes;
        } catch (e) { return { section: "prompt", ok: false, reason: String(e) }; }
      },
      // Write markdown/plain text into a TipTap editor (e.g. the Custom Analysis
      // System Prompt), reusing the proven paste path. Returns true on success.
      pasteTipTap: async function (editorEl, text) {
        if (botMoved()) return false;
        try {
          var t = String(text || "");
          // A 2-field export carries the analysis prompt as the editor's own HTML;
          // converting it as Markdown escaped every "&amp;" a second time (live
          // 2026-11-03). Paste HTML as HTML — through the same sanitizer as
          // every other import (the file is untrusted input).
          var isHtml = /^\s*</.test(t) && /<\/(p|h[1-6]|ul|ol|li|span|div|strong|em)>/i.test(t);
          var html = isHtml ? sanitizeHtml(t) : mdToHydratedHtml(t);
          return await pasteHtmlIntoEditor(editorEl, html);
        } catch (e) { return false; }
      }
    };

    // A hidden tab can't drive the dashboard: the run pauses and says so.
    try {
      window.MagicPortImport.onPause = run.onPause = function (paused) {
        run.paused = !!paused;
        try {
          status.innerHTML = paused
            ? IC.pause + "<span>Paused — bring this tab to the front to continue. The dashboard only responds while its tab is visible.</span>"
            : runningHtml;
        } catch (e) {}
      };
    } catch (e) {}
    // The dashboard's tool form sends an empty body for GET/DELETE tools, which
    // its server refuses; the page-side helper drops it while this run adds tools.
    var toolFix = function (on) { try { if (_bridge && typeof _bridge.send === "function") _bridge.send({ __ns: NS, type: "tool-fix", on: !!on }); } catch (e) {} };
    toolFix(true);
    try { out = await window.MagicPortImport.run(config, window.MagicPort.hostPlatform(), ctx); }
    catch (e) {
      // The raw error goes to the console only; the user sees a plain sentence.
      try { console.debug("[PromptPort] Magic Port run failed:", e); } catch (e2) {}
      out = { ok: false, results: [{ section: "run", ok: false, reason: MP_STOPPED }], notes: [] };
    }
    toolFix(false);
    out = out || { ok: false, results: [], notes: [] };

    // Surface the export-time "not ported" notes (non-API tools, extra languages)
    // on the results report too, so the final summary is complete.
    out.notes = (out.notes || []).concat(config.notes || []);
    // Every section's own notes / warnings (de-duplicated).
    out.warnings = (out.warnings || []).slice();
    (out.results || []).forEach(function (r) {
      if (!r) return;
      (r.notes || []).forEach(function (n) { if (out.notes.indexOf(n) === -1) out.notes.push(n); });
      (r.warnings || []).forEach(function (n) { if (out.warnings.indexOf(n) === -1) out.warnings.push(n); });
    });
    out.notes = out.notes.filter(function (n, i) { return out.notes.indexOf(n) === i; });
    if (run.moved || botMoved()) { out.moved = true; out.ok = false; }
    out.planned = mpPlannedSections(config);
    out.backupNote = run.backupNote;
    } finally {
      try { if (origAuth && MPD) MPD.isAuthRedirect = origAuth; } catch (e) {}
      mpRunClear();   // the run ended here (not cut off): no "interrupted" report
      _mpRun = null;
      ppUnlock("migrate");
    }

    // Finished while the user is elsewhere (another tab, or the panel closed):
    // leave what they are doing alone; the Import tab shows the results.
    if (UI.card && currentTab === "import") { renderMagicPortResults(out); keepFocus(); return; }
    _pendingMp = { out: out };
    toast("Migration finished — open Import to review.", null, "info");
  }

  var MP_STOPPED = "stopped unexpectedly — reload the page and check the bot";
  // A section key the results screen has no label for, as a readable title:
  // "webhooksV2" → "Webhooks V2", "final-save" → "Final Save".
  function mpTitleCase(key) {
    return String(key || "Section").replace(/[-_]+/g, " ").replace(/([a-z])([A-Z0-9])/g, "$1 $2").trim()
      .split(/\s+/).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" ");
  }
  // A reason that is really a script error / stack line is never shown raw.
  // Only real script-error shapes count (an Error name with a colon, the engine's
  // own phrases, stack lines, "[object …]"); an ordinary sentence that happens to
  // contain "undefined" or "error" is shown as written.
  function mpReasonText(reason) {
    var r = String(reason == null ? "" : reason);
    if (/\b(?:Type|Reference|Syntax|Range|URI|Eval|Internal|Aggregate|DOMException|[A-Z][A-Za-z]*)?Error\s*:|\bDOMException\b|^\s*(?:Uncaught\s+)?[A-Z][A-Za-z]*Error\b|Cannot read propert|Cannot set propert|is not a function|is not defined|is not iterable|\bat \S+ \(|\bat \S+:\d+:\d+|\.js:\d+|\[object [A-Z]|^\s*undefined\s*$|^\s*null\s*$/.test(r)) {
      try { console.debug("[PromptPort] Magic Port section error:", r); } catch (e) {}
      return MP_STOPPED;
    }
    return r;
  }
  function renderMagicPortResults(out) {
    freshPanel("Magic Port — results");
    out = out || { ok: false, results: [], notes: [] };
    var results = (out && out.results) || [];
    var okN = results.filter(function (r) { return r && r.ok; }).length;
    var LABEL0 = { run: "Migration", variables: "Custom Variables", tools: "Tools", prompt: "Prompt", languageVoice: "Language & Voice", llmStt: "LLM and STT", callConfig: "Call Config", analysis: "Custom Analysis", events: "Event Subscription", "final-save": "Final Save", commit: "Save" };
    var LABEL = {}; results.forEach(function (r) { if (r && r.section != null && !LABEL0.hasOwnProperty(r.section)) LABEL[r.section] = mpTitleCase(r.section); });
    Object.keys(LABEL0).forEach(function (k) { LABEL[k] = LABEL0[k]; });
    // Undo / backup only when the run got far enough to change something.
    var changedSomething = results.some(function (r) { return r && r.section !== "run"; });
    var moved = !!out.moved || results.some(function (r) { return r && r.reason === MP_MOVED; });
    var authStopped = !moved && results.some(function (r) { return r && r.reason === "auth-redirect"; });
    // A run cut off by a reload / a login redirect (rebuilt from what it stored).
    var cut = !moved && !!out.interrupted;
    var stopWhy = moved ? "you moved to another bot — stopped here" : "session expired (logged out) — stopped here";
    // The last section that finished before a stop.
    var lastDone = "";
    for (var li = 0; li < results.length; li++) {
      var rr = results[li];
      if (!rr || rr.reason === "auth-redirect" || rr.reason === MP_MOVED) break;
      if (rr.ok) lastDone = LABEL[rr.section] || rr.section;
    }

    // Collect everything that failed (whole sections AND individual items that
    // didn't make it after all retries) — one entry per failed item.
    var failures = []; // { title, item, why }
    results.forEach(function (r) {
      if (!r) return;
      var title = LABEL[r.section] || r.section;
      var items = (r.failedItems || []).concat(r.missing || []).map(function (v) { return String(v); });
      if (!r.ok || items.length) {
        var why = (r.reason === "auth-redirect" || r.reason === MP_MOVED) ? stopWhy
                : r.reason === MP_PART ? MP_PART
                : (r.reason && /TODO@LIVE/.test(r.reason)) ? "not available in this build yet"
                : (r.wrong && r.wrong.length) ? ("type check failed: " + r.wrong.map(function (w) { return w.reason === "missing" ? (w.name + " (not found)") : (w.name + " (wanted " + w.want + ", got " + w.got + ")"); }).join(", "))
                : (items.length ? "" : (r.reason ? mpReasonText(r.reason) : "failed"));
        var uniq = items.filter(function (v, idx) { return items.indexOf(v) === idx; });
        if (uniq.length) uniq.forEach(function (it) { failures.push({ title: title, item: it, why: (r.reason === "auth-redirect" || r.reason === MP_MOVED) ? stopWhy : "" }); });
        if (!uniq.length || (why && !(r.reason === "auth-redirect" || r.reason === MP_MOVED) && r.wrong && r.wrong.length)) failures.push({ title: title, item: "", why: why });
      }
    });
    // A stop (session expired / moved to another bot): the sections after it never ran.
    var notRun = [];
    if (moved || authStopped || cut) {
      var ran = {}; results.forEach(function (r) { if (r) ran[r.section] = 1; });
      (out.planned || []).forEach(function (k) { if (!ran[k]) notRun.push(LABEL[k] || mpTitleCase(k)); });
      notRun.forEach(function (t) { failures.push({ title: t, item: "", why: "not run — " + (moved ? "you moved to another bot" : cut ? String(out.interruptWhy || "the page was left") : "session expired") }); });
    }
    if (cut && !failures.length) failures.push({ title: "Migration", item: "", why: "interrupted before it finished — check the bot" });
    // A run that stopped before importing anything (e.g. this dashboard isn't a
    // supported destination) reports no per-section results — that is a failure,
    // never "Porting Successful".
    if (out && out.ok === false && !results.length && !failures.length) failures.push({ title: "Migration", item: "", why: out.reason ? mpReasonText(out.reason) : "the migration did not run" });
    var anyFail = failures.length > 0;

    // Things to look at even when everything went in.
    var uniqStr = function (a) { return (a || []).map(String).filter(function (v, i, all) { return v && all.indexOf(v) === i; }); };
    var warnings = uniqStr((out.warnings || []).concat.apply(out.warnings || [], results.map(function (r) { return (r && r.warnings) || []; })));
    var notes = uniqStr(out.notes);
    var leftovers = [];   // { title, items }
    results.forEach(function (r) {
      var l = r && uniqStr(r.leftovers);
      if (l && l.length) leftovers.push({ title: LABEL[r.section] || r.section, items: l });
    });
    var leftN = leftovers.reduce(function (n, g) { return n + g.items.length; }, 0);
    var checkN = warnings.length + notes.length + leftN;

    function appendChecks() {
      warnings.forEach(function (w) { panel.appendChild(lineRow("!", null, w)); });
      notes.forEach(function (n) { panel.appendChild(lineRow("!", null, n)); });
      if (leftovers.length) {
        var lb = callout("info", "Already on this bot (left in place)", null);
        var ll = el("div"); ll.setAttribute("style", "margin-top:4px;");
        leftovers.forEach(function (g) {
          g.items.forEach(function (it) {
            var d = el("div"); d.setAttribute("style", "font-size:12.5px;line-height:1.5;");
            d.textContent = "• " + g.title + ": " + it;
            ll.appendChild(d);
          });
        });
        lb.querySelector("div:last-child").appendChild(ll);
        panel.appendChild(lb);
      }
    }
    function backupFooter() {
      if (_lastBackup && !_lastBackup.undone) appendBackupActions(footer(), "Backup kept — this bot's prompt fields as they were just before the migration.");
      else if (out.backupNote) panel.appendChild(lineRow("!", null, out.backupNote));
    }

    // Happy path: everything imported, nothing to check → smiley + "Porting Successful".
    if (!anyFail && !checkN) {
      var smiley = '<svg class="rs-smile" width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle pathLength="1" cx="12" cy="12" r="9"></circle>' +
        '<path pathLength="1" d="M8 14.5a5 5 0 0 0 8 0"></path>' +
        '<line x1="9" y1="9.5" x2="9" y2="10"></line>' +
        '<line x1="15" y1="9.5" x2="15" y2="10"></line></svg>';
      var wrap = el("div", "rs-mp-success");
      wrap.setAttribute("style", "display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;padding:22px 8px;");
      var face = el("div"); face.innerHTML = smiley; wrap.appendChild(face);
      FX.celebrate(face, true);
      wrap.appendChild(el("div", "rs-donehead-t", "Porting Successful"));
      wrap.appendChild(el("div", "rs-donehead-s", "The whole bot was imported and saved."));
      panel.appendChild(wrap);
      // Items that were already on this bot were left as they were: say so.
      var already = results.filter(function (r) { return r && +r.alreadyPresent > 0; });
      if (already.length) {
        var ab = callout("info", "Already on this bot (left in place)", null);
        already.forEach(function (r) {
          var d = el("div"); d.setAttribute("style", "font-size:12.5px;line-height:1.5;");
          d.textContent = "• " + (LABEL[r.section] || r.section) + ": " + r.alreadyPresent + " already there";
          ab.querySelector("div:last-child").appendChild(d);
        });
        panel.appendChild(ab);
      }
      backupFooter();
      setLinks(true);
      return;
    }

    var head = el("div", "rs-donehead");
    head.innerHTML = anyFail ? IC.err.replace(/width="24" height="24"/, 'width="42" height="42" class="rs-shake"') : IC.done;
    var ht = el("div");
    var headT = moved ? "You moved to another bot — migration stopped" + (lastDone ? " after " + lastDone : " before it changed anything") + "."
      : cut ? "Last migration was interrupted" + (lastDone ? " after " + lastDone : "") + "."
      : anyFail ? (okN ? "Migrated with failures" : "Migration did not complete")
      : "Migrated — please check " + mpCount(checkN, "item");
    var headS = moved ? "Nothing more was written. Go back to the bot you started on to check it; the rest of the list below was not migrated."
      : cut ? "It stopped because " + String(out.interruptWhy || "the page was left") + ". Here is what was done" + (out.srcName ? " (from " + out.srcName + ")" : "") + "; sections marked not run were not migrated — check the bot and run the migration again if needed."
      : anyFail ? "Some items were NOT imported — review the list below."
      : "Everything was imported. Look over the points below.";
    ht.appendChild(el("div", "rs-donehead-t", headT));
    ht.appendChild(el("div", "rs-donehead-s", headS));
    head.appendChild(ht); panel.appendChild(head);

    // Per-section summary (✓ / ✕) with "N created · M already there".
    var countsOf = function (r) {
      var parts = [];
      if (r.section === "analysis" && r.count != null) parts.push(mpCount(r.count, "key"));
      else if (r.created != null) parts.push(r.created + " created");
      else if (r.section === "variables" && r.actual != null) parts.push(r.actual + " on the bot");   // older result shape: a total, not new ones
      if (r.alreadyPresent != null && +r.alreadyPresent > 0) parts.push(r.alreadyPresent + " already there");
      return parts.join(" · ");
    };
    results.forEach(function (r) {
      if (!r) return;
      var title = LABEL[r.section] || r.section;
      var nFail = (r.failedItems || []).length + (r.missing || []).length;
      if (r.ok && !nFail) {
        panel.appendChild(lineRow((r.warnings || []).length ? "!" : "✓", null, title, countsOf(r) || "done"));
      } else {
        var cm = countsOf(r);
        panel.appendChild(lineRow("✕", null, title, null, (nFail ? (mpCount(nFail, "item") + " failed") : "failed") + (cm ? " · " + cm : "")));
      }
    });
    notRun.forEach(function (t) { panel.appendChild(lineRow("○", null, t, "not run")); });

    // Explicit failed-items block (what did NOT get imported): one line per item.
    if (anyFail) {
      var fb = callout("bad", "Not imported", null);
      var list = el("div"); list.setAttribute("style", "margin-top:4px;");
      failures.forEach(function (f) {
        var line = el("div"); line.setAttribute("style", "font-size:12.5px;line-height:1.5;");
        // A reason that already names Magic Port stands alone (no "Migration — Magic Port …").
        var label = f.item ? (f.title + ": " + f.item + (f.why ? " (" + f.why + ")" : ""))
          : (f.why && /^Magic Port\b/.test(f.why) ? f.why : (f.title + (f.why ? " — " + f.why : "")));
        line.textContent = "• " + label;
        list.appendChild(line);
      });
      fb.querySelector("div:last-child").appendChild(list);
      panel.appendChild(fb);
    }

    appendChecks();
    if (changedSomething) backupFooter();

    // Close behaviour: if anything failed, DON'T let the user close until they
    // acknowledge the failed list (consent-gated Close, same wiggle pattern).
    if (anyFail) {
      var c = mpConsentBlock("I have reviewed the items above that were <b>not imported</b> and understand they were left out. I'll handle them manually if needed.");
      panel.appendChild(c.wrap);
      // Until it is acknowledged, the report survives closing / switching tabs:
      // the Import tab shows it again.
      var pend = _pendingMp = { out: out, ack: false };
      var ackTick = ppUserTick(c.wrap);
      c.checkbox.addEventListener("change", function (e) {
        if (c.checkbox.checked && ackTick(e)) { if (_pendingMp === pend) _pendingMp = null; }
        else _pendingMp = pend;
      });
      var foot = footer();
      var closeRow = el("div", "rs-row");
      var closeBtn = el("button", "rs-btn rs-btn-primary", "Close");
      mpWireConsentGate(c.wrap, c.checkbox, closeBtn, function () { closePanel(); });
      pend.nagEl = closeBtn;   // a locked Close wiggles the acknowledgement and focuses its checkbox
      closeRow.appendChild(closeBtn);
      foot.appendChild(closeRow);
    } else {
      addCloseRow();
    }
    if (okN) setLinks(true);
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
  var NOTHING_TO_EXPORT = "Nothing to export — the bot page hasn't loaded its sections. Reload the page and try again.";
  // Magic Port has nothing to work with: no section text was read AND no bot
  // data was captured (page still loading, or the bot wasn't found).
  function magicNothingToExport(sections, captureCount) {
    if (captureCount == null) captureCount = captured.length + (latestAssistant && latestAssistant.data ? 1 : 0);
    var anyText = (sections || []).some(function (s) { return s && s.text && String(s.text).trim(); });
    return !anyText && !captureCount;
  }
  var _exportBusy = false;
  var _lastDl = null;        // "5-bucket ZIP downloaded." after a download, until the next activity   // a download is being prepared — ignore repeat clicks
  var BUSY_MSG = "Wait for the current task to finish.";
  function sameSections(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if ((a[i] && a[i].text) !== (b[i] && b[i].text)) return false;
    return true;
  }
  // A repeat press (double Enter / double click) right after a download is
  // ignored for a moment, so one gesture never saves two identical ZIPs.
  var _exportDoneAt = 0, _exportDoneFmt = null, EXPORT_COOLDOWN_MS = 800;
  // While a download is prepared, the tiles show "Preparing…" in place (no
  // repaint), so focus stays on the pressed tile instead of jumping to a tab.
  function markExportPreparing() {
    if (!(UI.card && currentTab === "export" && UI.foot)) return false;
    var tiles = [].slice.call(UI.foot.querySelectorAll(".rs-cta"));
    if (!tiles.length) return false;
    tiles.forEach(function (b) {
      b.setAttribute("aria-label", focusName(b));   // keeps its name, so the repaint after puts focus back on it
      b.setAttribute("aria-disabled", "true"); b.setAttribute("data-sub", "");
      b.classList.add("rs-preparing");
      var l = b.querySelector(".rs-cta-l"); if (l) l.textContent = "Preparing…";
    });
    [].forEach.call(UI.foot.querySelectorAll(".rs-foot-meta .rs-textbtn"), function (b) { b.setAttribute("aria-disabled", "true"); });
    return true;
  }
  function refreshExport(thenDownloadFormat) {
    if (thenDownloadFormat && thenDownloadFormat === _exportDoneFmt && Date.now() - _exportDoneAt < EXPORT_COOLDOWN_MS) return;
    if (thenDownloadFormat && _exportBusy) { toast("Already preparing a download…"); return; }
    // Shared busy lock (an import / Magic Port / replace is running → wait).
    // A download takes the lock (and says so when busy). A plain preview read
    // never blocks other controls: it is skipped quietly while a job runs, and
    // otherwise runs without holding the lock (so opening the panel and going
    // straight to Import never finds the drop zone disabled).
    var holdsLock = false;
    if (typeof ppLock === "function") {
      if (thenDownloadFormat) { if (!ppLock("export")) { toast(BUSY_MSG, null, "info"); return; } holdsLock = true; }
      else if (typeof ppBusy === "function" && ppBusy()) return;
    }
    untuckLauncher();
    clearTimeout(_tuckTimer);
    // Drop stale captures BEFORE asking for fresh ones. The page can change its
    // own address after load (?tab=…, ?orchestration=…); the first reset then ran
    // later, inside the read, and wiped the answers just asked for — so the first
    // Magic Port click found "no source bot data" and only the second one worked.
    resetIfNavigated();
    askInterceptorForLatest();
    var myGen = ++opGen;
    // Dash5 needs 3 passes (buckets render late / start collapsed); the Dash2
    // panel's two fields are always on screen, so one pass is enough.
    var PASSES = isTwoField() ? 1 : 3;
    if (thenDownloadFormat) _exportBusy = true;
    _lastDl = null; setLinks(false);   // a new activity started
    // Repaint only while the panel is open: closing it mid-way lets the read
    // (and a requested download) finish quietly instead of reopening the panel.
    function paint(secs, o) { if (UI.card && currentTab === "export") renderPanel(secs, o); }
    var inPlace = (thenDownloadFormat === "five" || thenDownloadFormat === "two") && markExportPreparing();
    if (!inPlace) paint(null, { downloadEnabled: false, status: "Reading the page… (1 of " + PASSES + ")" });
    // If the user switches tabs mid-way, a preview is abandoned, but a requested
    // DOWNLOAD still completes (just without repainting a view they left).
    function live() { return myGen === opGen; }
    (async function () {
      var sections = null;
      try {
        for (var k = 1; k <= PASSES; k++) {
          if (!live() && !thenDownloadFormat) return;
          var prevPass = sections;
          sections = await runExclusive(collectSections);
          // Two passes that read the same thing → the page has settled; a third
          // pass would only copy (and convert) every bucket again.
          if (k > 1 && k < PASSES && sameSections(prevPass, sections)) k = PASSES;
          if (!live()) { if (!thenDownloadFormat) return; continue; }
          if (k < PASSES) {
            if (!inPlace) paint(sections, { downloadEnabled: false, status: "Reading the page… (" + (k + 1) + " of " + PASSES + ")" });
          } else {
            paint(sections, { downloadEnabled: true });
          }
        }
      } catch (readErr) {
        // A failed read pass must not swallow a requested Magic Port download:
        // carry on with what the page / captured data gives.
        if (thenDownloadFormat !== "magic") throw readErr;
        sections = sections || fallbackSections();
        if (live()) paint(sections, { downloadEnabled: true });
      }
      if (thenDownloadFormat === "magic" && !isTwoField()) {
        // Make sure the bot data is in hand before building: ask again and give
        // the answer a moment to arrive (a navigation reset may have cleared it).
        resetIfNavigated();
        askInterceptorForLatest();
        await sleep(250);
        if (magicNothingToExport(sections)) {
          // Repaint first: a toast shown inside the panel footer (narrow window)
          // would be wiped by a repaint that came after it.
          if (live()) paint(sections, { downloadEnabled: true, noAnim: true, status: NOTHING_TO_EXPORT });
          toast(NOTHING_TO_EXPORT, null, "info");
          return false;
        }
      }
      if (thenDownloadFormat === "magic" && isTwoField()) {
        // 2-field bot: a short read-only tab tour first (see d2Tour).
        var mpSecs = sections;
        var okMp = await downloadMagicPortDash2(sections, function (step) {
          if (live()) paint(mpSecs, { downloadEnabled: false, busy: true, noAnim: true,
            status: "Reading the bot… " + (step === "collecting" ? "collecting what the tabs loaded" : "opening " + step) });
        });
        if (live()) paint(sections, { downloadEnabled: true, noAnim: true });
        return okMp;
      }
      if (thenDownloadFormat && doDownload(thenDownloadFormat, sections) && live()) {
        paint(sections, { downloadEnabled: true, noAnim: true });
      }
    })().catch(function () {
      if (live()) paint(fallbackSections(), { downloadEnabled: true });
      if (thenDownloadFormat === "magic") toast("Magic Port: couldn't build the file — reload the page and try again.", null, "info");
    }).then(release, release);
    function release() {
      if (thenDownloadFormat) { _exportBusy = false; _exportDoneAt = Date.now(); _exportDoneFmt = thenDownloadFormat; }
      if (holdsLock && typeof ppUnlock === "function") ppUnlock("export");
    }
  }


  function renderPanel(sections, opts) {
    opts = opts || {};
    var idle = !!opts.idle;
    var loading = !sections && !idle;
    var gz = isTwoField();
    var baseSecs = gz
      ? [{ title: "First Message" }, { title: "Main Prompt" }]
      : window.PPExtract.SECTIONS;
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
      if (opts.status && opts.busy) {
        note.className += " rs-working";
        note.innerHTML = IC.spin;
        note.appendChild(el("span", null, opts.status));
      } else if (opts.status) note.textContent = opts.status;
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
      if (!enabled) b.classList.add("rs-preparing");
      b.setAttribute("data-sub", enabled ? sub : "");
      b.disabled = !enabled || !canUse;
      if (enabled && !canUse && why) { b.title = why; }
      // The tooltip alone can't be reached by keyboard or touch: the same reason
      // is the tile's accessible description (aria-describedby).
      if (format === "five") {
        var whyId = "rs-five-why";
        var sr = el("span", null, enabled && !canUse && why ? why : "");
        sr.id = whyId; sr.hidden = true;   // hidden, but still read as the description
        b._whyEl = sr;
        b.setAttribute("aria-describedby", whyId);
      }
      b.addEventListener("click", function () {
        if (b.disabled) return;
        // Always re-read the page right before downloading, so an edit made
        // after an earlier preview/download is never exported stale.
        refreshExport(format);
      });
      return b;
    }

    var foot = footer();
    // No "5 Buckets is off / headings" callout on the 2-field page (owner's
    // call, 2026-11-03): the 5 Buckets tile itself says "needs # headings" and
    // its tooltip gives the reason.
    var ctas = el("div", "rs-ctas");
    var fiveBtn = mkDownloadBtn("Download 5 Buckets", gz ? (five.ok ? "split by # headings" : "needs # headings") : "5 .md files", "five", five.ok,
      five.ok ? "" : (FIVE_WHY + (five.reason || "")), IC.five);
    var twoBtn = mkDownloadBtn("Download 2 Buckets", gz ? "as on the page" : "First Message + Main Prompt", "two", true, "", IC.two);
    ctas.appendChild(fiveBtn); ctas.appendChild(twoBtn);
    foot.appendChild(ctas);
    if (fiveBtn._whyEl) foot.appendChild(fiveBtn._whyEl);

    // Magic Port: the third export CTA (full-width), downloads the whole bot
    // (prompt + all configurations) as one ZIP for migration to another bot.
    if (window.MagicPort) {
      var mpBtn = el("button", "rs-btn rs-cta rs-cta-magic rs-cta-wide");
      mpBtn.innerHTML = IC.magic;
      mpBtn.appendChild(el("span", "rs-cta-l", enabled ? "Magic Port" : "Preparing…"));
      if (!enabled) mpBtn.classList.add("rs-preparing");
      mpBtn.setAttribute("data-sub", enabled ? "· full bot: prompt + configs" : "");
      mpBtn.disabled = !enabled;
      mpBtn.title = "Download the entire bot (prompt, variables, language/voice, analysis, tools, event subscriptions) as one ZIP to import onto another bot.";
      mpBtn.addEventListener("click", function () { if (!mpBtn.disabled) refreshExport("magic"); });
      foot.appendChild(mpBtn);
    }
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

  // While the idle Export view is open on the Dash2 panel, re-check Main Prompt
  // as the user edits it, so "Download 5 Buckets" turns on/off live.
  var _fiveRecheckT = null;
  document.addEventListener("input", function () {
    if (!isTwoField() || !UI.card || currentTab !== "export" || !UI.fiveBtn) return;
    clearTimeout(_fiveRecheckT);
    _fiveRecheckT = setTimeout(function () {
      if (!UI.fiveBtn) return;
      var r = liveMainSplit();
      UI.fiveBtn.disabled = !r.ok;
      UI.fiveBtn.setAttribute("data-sub", r.ok ? "split by # headings" : "needs # headings");
      UI.fiveBtn.title = r.ok ? "" : ("5 Buckets needs Main Prompt organised under # Objective, # Response Guidelines, # Conversation Flow, # FAQs (in that order). " + (r.reason || ""));
      if (UI.fiveBtn._whyEl) UI.fiveBtn._whyEl.textContent = UI.fiveBtn.title;
    }, 250);
  }, true);

  // ---- import panels ------------------------------------------------------
  function freshPanel(titleText) {
    var a = /find/i.test(titleText) ? "find" : (/import|magic port/i.test(titleText) ? "import" : "export");
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
    // Kept if the panel is closed, so reopening Import shows the same review.
    _pendingReview = plan && !plan.error && plan.matched && plan.matched.length ? { plan: plan, curMap: curMap, src: src, ropts: ropts } : null;
    _pendingMpConfirm = null;
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
      det.appendChild(el("span", "rs-pill", isTwoField() ? "First Message + Main Prompt" : "5 buckets"));
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
        (isTwoField() ? "First Message / Main Prompt" : "the five buckets") + ". Check the file names."));
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
        // One page-driving task at a time (export tour, Magic Port, replace-all).
        if (typeof ppLock === "function" && !ppLock("import")) { toast(BUSY_MSG, null, "info"); return; }
        var locked = true, unlock = function () { if (locked && typeof ppUnlock === "function") ppUnlock("import"); locked = false; };
        var keepF = focusKeeper();   // backup + write drive the page; focus comes back to the results
        go.disabled = true; cancel.disabled = true;
        _pendingReview = null;
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
        // The snapshot is only committed as THE backup once the write starts: a
        // review that turns out stale (below) writes nothing and must not
        // replace the backup of the previous import.
        var backup = null;
        try {
          backup = await snapshotBuckets();
          backup.importedKeys = toWrite.map(function (m) { return m.sec.key; });
        } catch (e) { backup = null; }
        // Someone edited a field after this review opened → don't write a stale
        // plan; refresh the review against what's on the page now.
        if (backup && curMap && src) {
          var now = {};
          (backup.sections || []).forEach(function (c) { now[c.key] = c.text || ""; });
          var drift = plan.matched.some(function (m) {
            return normForDiff(now[m.sec.key] || "").trim() !== normForDiff(curMap[m.sec.key] || "").trim();
          });
          if (drift) {
            unlock();
            if (gen0 === opGen && UI.card) renderImportPlan(resolveImportPlan(src, now), now, src, { changed: true });
            return;
          }
        }
        _lastBackup = backup;
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
          unlock();
          showImportResults(all, {}, gen0); keepF();
        }).catch(function (err) {
          unlock();
          showImportResults([{ title: "Error", ok: false, reason: (err && err.message) || "failed" }], {}, gen0); keepF();
        });
      });
      row.appendChild(go);
    }
    cancel = el("button", "rs-btn rs-btn-ghost", plan.matched.length ? "Cancel" : "Try another file");
    cancel.addEventListener("click", function () { _pendingReview = null; renderImportHome(); });
    row.appendChild(cancel);
    foot.appendChild(row);
  }

  // ---- Save to Dash5 (clicks Dash5's own top-right Save button) -----------
  function findDash5SaveButton() {
    var btns = [].slice.call(document.querySelectorAll("button, [role='button']"));
    var cands = btns.filter(function (b) {
      var tx = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (!/^save$/i.test(tx)) return false;
      var r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!cands.length) return null;
    // Prefer the top-most, then right-most (Dash5's Save sits top-right).
    cands.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.top - rb.top) || (rb.left - ra.left);
    });
    return cands[0];
  }
  function isBtnDisabled(b) { return !b || b.disabled || b.getAttribute("aria-disabled") === "true"; }
  function saveToDash5() {
    // New 2-field layout: the one page-wide Save in the "Unsaved changes" bar.
    if (isTwoField() && d2NewUi()) {
      var MPD = window.MagicPortDom;
      if (!MPD.v2SaveBar()) { toast("Nothing to save — the page shows no unsaved changes."); return; }
      toast("Saving…");
      var seq0 = _toastSeq;
      MPD.v2SaveAll(15000).then(function (r) {
        if (seq0 !== _toastSeq && r.state === "saved") return;
        var g = twoFieldEditors(), tbl = !!((g.fm && g.fm.querySelector("table")) || (g.mp && g.mp.querySelector("table")));
        if (r.state === "saved" || r.state === "none") toast("Saved.");
        else if (r.state === "failed" || r.state === "blocked")
          toast("Save rejected: " + (r.text || "the page refused the save") +
            (tbl ? " — the prompt holds a table, and this dashboard can fail to save tables; turn it into a list and save again." : ""), null, "info");
        else toast("The dashboard didn't confirm the save — check the Prompt by hand.", null, "info");
      }, function () { toast("Clicked Save — please confirm on the page.", null, "info"); });
      return;
    }
    var btn = findDash5SaveButton();
    if (!btn) { toast("Couldn't find the page's Save button — please Save on the page."); return; }
    if (isBtnDisabled(btn)) { toast("Nothing to save — the page shows no unsaved changes."); return; }
    try { btn.scrollIntoView({ block: "center" }); } catch (e) {}
    // Only toasts that appear after this snapshot count (a stale "saved" toast never does).
    var MPD5 = window.MagicPortDom, two = isTwoField();
    var before = MPD5 && MPD5.toastSnapshot ? MPD5.toastSnapshot() : null;
    btn.click();
    toast("Saving…");
    var seq = _toastSeq;
    if (!before || !MPD5.waitToastResult) { toast("Clicked Save — please confirm on the page.", null, "info"); return; }
    (async function () {
      // A Save that is disabled may still be saving: wait for the page's own
      // answer. The 2-field page answers every save with a toast; the 5-field
      // page may not, so there a quiet, finished save that leaves Save
      // disabled (nothing left to save) counts as saved.
      var r = await MPD5.waitToastResult(/saved|updated|success/i, two ? 15000 : 6000, before);
      if (MPD5.waitSaveIdle) await MPD5.waitSaveIdle(15000);
      if (r.state !== "fail") {
        var late = MPD5.freshToastTexts(before).filter(function (t) { return MPD5.TOAST_FAIL.test(t); })[0];
        if (late) r = { state: "fail", text: late };
      }
      if (r.state === "fail") { toast("Save rejected: " + r.text, null, "info"); return; }
      if (seq !== _toastSeq) return;   // a newer message is showing — don't cover it
      if (r.state === "ok" || (!two && isBtnDisabled(findDash5SaveButton()))) toast("Saved.");
      else toast("The dashboard didn't confirm the save — check the page by hand.", null, "info");
    })().catch(function () { toast("Clicked Save — please confirm on the page.", null, "info"); });
  }

  function renderImportResults(results, opts) {
    opts = opts || {};
    freshPanel(opts.undone ? "Import — undo complete" : "Import results");
    var okN = results.filter(function (r) { return r.ok && !r.skipped; }).length;
    var badN = results.filter(function (r) { return !r.ok; }).length;
    var head = el("div", "rs-donehead");
    head.innerHTML = badN && !okN ? IC.err.replace(/width="24" height="24"/, 'width="42" height="42" class="rs-shake"') : IC.done;
    if (!badN && okN && !opts.undone) FX.celebrate(head);
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
    if (!backupIsHere(_lastBackup)) return;   // another bot's backup: no Undo here
    {
      foot.appendChild(callout("ok", null, text));
      var srow = el("div", "rs-row");
      var undo = el("button", "rs-btn rs-btn-danger");
      undo.innerHTML = IC.undo; undo.appendChild(document.createTextNode("Undo import"));
      undo._gen = opGen;
      undo.addEventListener("click", async function () {
        if (undo.disabled) return;
        if (!backupIsHere(_lastBackup)) { toast("This backup belongs to another bot — open that bot to undo, or download the backup.", null, "info"); return; }
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
  // Work kept in memory when the panel is closed (Escape / ✕ / launcher):
  var _pendingReview = null;      // import review screen
  var _pendingMpConfirm = null;   // Magic Port confirm (config + file; consent is never kept)
  var _pendingMp = null;          // Magic Port results not yet seen / "Not imported" not yet acknowledged
  var _mpRun = null;              // a Magic Port migration is running
  // Leaving or reloading the page mid-migration would cut it off half-way: ask first.
  try {
    // The page sending itself to a login page (session expired) is not the
    // user leaving: no prompt over it. Seen through the Navigation API where the
    // browser has it; elsewhere the prompt stays. Progress is stored either way.
    var _mpToAuthAt = 0;
    if (window.navigation && typeof window.navigation.addEventListener === "function") {
      window.navigation.addEventListener("navigate", function (e) {
        try {
          var u = new URL(e.destination.url);
          var path = u.pathname.replace(/\/+$/, "") || "/";
          if (_mpRun && u.origin === location.origin && /^(\/(accounts|account|auth|users?|identity))?\/(login|log-in|signin|sign-in|sso\/login)$/i.test(path)) _mpToAuthAt = Date.now();
        } catch (x) {}
      });
    }
    window.addEventListener("beforeunload", function (e) {
      if (!_mpRun) return;
      try { if (_mpRun.rec) mpRunSave(_mpRun.rec); } catch (x) {}
      if (_mpToAuthAt && Date.now() - _mpToAuthAt < 5000) return;
      e.preventDefault(); e.returnValue = "A Magic Port migration is running.";
      return e.returnValue;
    });
    window.addEventListener("pagehide", function () { try { if (_mpRun && _mpRun.rec) mpRunSave(_mpRun.rec); } catch (x) {} });
  } catch (e) {}
  var _findState = null;          // Find / Replace text and options
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

    var hint = el("div", "rs-note", "Searches live as you type — matches highlight yellow, the current one orange. Enter / Shift+Enter jump between them. Variable chips are skipped — Find and Replace never touch them. Replace all rewrites every matching field; export a backup first.");
    panel.appendChild(hint);

    function opts() { return { matchCase: mc.input.checked, wholeWord: ww.input.checked }; }
    // Typed text survives closing the panel / switching tabs.
    var restored = !!(_findState && _findState.q);   // restored text isn't searched until asked (no stale count)
    if (_findState) { findIn.value = _findState.q || ""; repIn.value = _findState.r || ""; mc.input.checked = !!_findState.mc; ww.input.checked = !!_findState.ww; }
    function keep() { _findState = { q: findIn.value, r: repIn.value, mc: mc.input.checked, ww: ww.input.checked }; }
    [findIn, repIn].forEach(function (i) { i.addEventListener("input", keep); });
    [mc.input, ww.input].forEach(function (i) { i.addEventListener("change", keep); });
    function updateCounter() {
      var n = _findRanges.length;
      counter.textContent = findIn.value.trim() && !restored ? (n ? (_findIdx + 1) + "/" + n : "0/0") : "";
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
      if (res && res.offPrompt && !res.searched) {
        setResult(res.notOpened === "busy" ? ppBusyText()
          : res.notOpened ? "Couldn't open the Prompt section — open it, then search again."
          : "The Prompt section isn't open — press Find to search it (PromptPort opens it, then comes back here).", true);
        return;
      }
      if (!res || !res.total) { setResult("No matches.", true); return; }
      setResult(plural(res.total, "match", "matches") + " in " + (isTwoField() ? plural(res.per.length, "field", "fields") : plural(res.per.length, "bucket", "buckets")) + ":");
      res.per.forEach(function (p, i) { result.appendChild(lineRow(i % 2 ? "○" : "•", null, p.title, p.count + "×")); });
      if (!res.supported) {
        result.appendChild(callout("warn", null, "Counts are accurate, but this browser can't highlight matches on the page."));
      } else if (res.unpainted) {
        result.appendChild(el("div", "rs-muted", plural(res.unpainted, "match is", "matches are") + " inside a plain text box, which can't be highlighted."));
      }
      if (res.searched) result.appendChild(el("div", "rs-muted", "Found on the Prompt section — open it to see the matches highlighted."));
    }

    // explicit = the Find button / Enter (may open the Prompt section on the new layout).
    function doFind(explicit) {
      if (!findIn.isConnected) return;   // this Find screen was left — paint nothing on the page
      restored = false;
      var q = findIn.value;
      if (!q.trim()) {
        if (q.length) { setResult("Type a word or phrase — spaces alone aren't searched.", true); clearHighlights(); updateCounter(); return; } setResult(""); clearHighlights(); updateCounter(); return; }
      var fo = opts(); if (explicit === true) fo.navigate = true;
      runExclusive(function () { return findAll(q, fo); }).then(function (res) {
        if (!findIn.isConnected) { if (currentTab !== "find") clearHighlights(); return; }
        if (findIn.value !== q) return;   // superseded by newer typing; its own search paints

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
        else doFind(true);
      }
    });
    // Keep highlights in sync when the options change.
    mc.input.addEventListener("change", doFind);
    ww.input.addEventListener("change", doFind);

    var row = el("div", "rs-row");
    var findBtn = mkBtn("Find", primaryBtn(), function () { doFind(true); });
    var repBtn = mkBtn("Replace all", secondaryBtn(), function () {
      var q = findIn.value;
      if (!q.trim()) { setResult("Type something to find first.", true); try { findIn.focus(); } catch (e) {} return; }
      if (findTimer) { clearTimeout(findTimer); findTimer = null; }   // a pending live search must not overwrite the replace result
      // Shared busy lock (an import / export / Magic Port is running → wait).
      if (typeof ppLock === "function" && !ppLock("replace")) { toast(BUSY_MSG, null, "info"); return; }
      repBtn.disabled = true; repBtn.textContent = "Replacing…";
      setLinks(false);   // a new activity started
      runExclusive(function () { return replaceAllBuckets(q, repIn.value, opts()); }).then(function (rs) {
        if (typeof ppUnlock === "function") ppUnlock("replace");
        var tot = 0; rs.forEach(function (r) { tot += r.n; });
        setResult(tot ? ("Replaced " + plural(tot, "occurrence", "occurrences") + ":")
          : (rs.notOpened ? "Couldn't open the Prompt section — open it, then replace again." : "Nothing to replace."), !tot);
        if (tot) rs.forEach(function (r) { result.appendChild(lineRow(!r.ok ? "✕" : (r.warn ? "!" : "✓"), null, r.title, r.n + "×", r.warn || "")); });
        if (tot) {
          setLinks(true);
          result.appendChild(el("div", "rs-muted", "Review the fields, then Save — or Undo replace to put them back. (Replace edits the stored text; a variable chip keeps its own name.)"));
          var srow = el("div", "rs-row");
          var sbtn = el("button", "rs-btn rs-btn-primary", "Save on page");
          sbtn.addEventListener("click", saveToDash5);
          var ubtn = el("button", "rs-btn rs-btn-ghost", "Undo replace");
          ubtn.addEventListener("click", function () {
            if (ubtn.disabled) return;
            ubtn.disabled = true; ubtn.textContent = "Undoing…";
            if (typeof ppLock === "function" && !ppLock("replace")) { ubtn.disabled = false; ubtn.textContent = "Undo replace"; toast(BUSY_MSG, null, "info"); return; }
            runExclusive(function () { return undoReplaceAll(rs); }).then(function (us) {
              function names(a) { return a.map(function (u) { return u.title; }).join(", "); }
              var changed = us.filter(function (u) { return u.changed; });
              var bad = us.filter(function (u) { return !u.ok && !u.changed; });
              var done = us.filter(function (u) { return u.ok; });
              var msg = [];
              if (changed.length) msg.push("The field was edited after the replace — undo skipped for: " + names(changed) + " (your edits are kept).");
              if (bad.length) msg.push("Couldn't undo in: " + names(bad) + ".");
              if (!msg.length) msg.push("Replace undone — the fields are back as they were.");
              else if (done.length) msg.unshift("Undone in: " + names(done) + ".");
              setResult(msg.join(" "), !!(changed.length || bad.length));
              clearHighlights(); updateCounter();
            }).catch(function () { setResult("Undo failed.", true); }).then(function () { if (typeof ppUnlock === "function") ppUnlock("replace"); });
          });
          srow.appendChild(sbtn); srow.appendChild(ubtn); result.appendChild(srow);
        }
        repBtn.disabled = false; repBtn.textContent = "Replace all";
        clearHighlights(); updateCounter();
      }).catch(function () { if (typeof ppUnlock === "function") ppUnlock("replace"); repBtn.disabled = false; repBtn.textContent = "Replace all"; setResult("Replace failed.", true); });
    });
    var clearBtn = mkBtn("Clear", secondaryBtn(), function () {
      clearHighlights(); findIn.value = ""; repIn.value = ""; _findState = null; setResult(""); updateCounter();
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
    if (req.type === "get-status") {
      // Lightweight, side-effect-free check: which buckets have an editor on the
      // page right now. Does NOT expand or copy (copying needs a real click).
      askInterceptorForLatest();
      var found;
      try {
        if (isTwoField()) {
          var gm = twoFieldEditors();
          found = [{ title: "First Message", found: !!gm.fm }, { title: "Main Prompt", found: !!gm.mp }];
        } else {
          found = window.PPExtract.sectionEditors().map(function (m) {
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
    if (req.type === "open-panel") {
      openPanel();
      sendResponse({ ok: true });
      return true;
    }
  });

  // ---- test hook (harmless; used only by the offline stress harness) ------
  try {
    window.__ppTest = {
      nameFromUI: nameFromUI, fileBase: fileBase, matchSection: matchSection,
      lineDiff: lineDiff, coarseDiff: coarseDiff, escapeRegExp: escapeRegExp,
      mdToHtml: mdToHtml, htmlToText: htmlToText,
      parseSingleMd: parseSingleMd,
      sectionHeaderAt: sectionHeaderAt,
      collectSections: collectSections, findAll: findAll, replaceAllBuckets: replaceAllBuckets,
      sanitizeHtml: sanitizeHtml, applyReplace: applyReplace,
      findDash5SaveButton: findDash5SaveButton, saveToDash5: saveToDash5,
      sectionsToFiles: sectionsToFiles, sectionsToTwoFiles: sectionsToTwoFiles,
      isTwoField: isTwoField, twoFieldEditors: twoFieldEditors, splitMainPrompt: splitMainPrompt,
      twoFieldFiveSections: twoFieldFiveSections, liveMainSplit: liveMainSplit, doDownload: doDownload,
      hydrateMentions: hydrateMentions, mdToHydratedHtml: mdToHydratedHtml,
      countNonVariableRefs: countNonVariableRefs, plainRefsNote: plainRefsNote, healDamagedTokens: healDamagedTokens,
      magicNothingToExport: magicNothingToExport,
      snapshotBuckets: snapshotBuckets, runImport: runImport, backupStamp: backupStamp,
      getLastBackup: function () { return _lastBackup; },
      setLastBackup: function (b) { _lastBackup = b; },
      renderImportResults: renderImportResults, getPanel: function () { return panel; },
      tuckLauncher: tuckLauncher, untuckLauncher: untuckLauncher,
      getLauncher: function () { return UI.launcher; }, getCard: function () { return UI.card; },
      pasteHtmlIntoEditor: pasteHtmlIntoEditor, hasSpacerArtifacts: hasSpacerArtifacts,
      readZipSource: readZipSource, sourceFromMd: sourceFromMd, resolveImportPlan: resolveImportPlan,
      isMainPromptName: isMainPromptName, collateMain: collateMain, siteTargets: siteTargets,
      downloadBackup: downloadBackup, beginImport: beginImport, renderImportPlan: renderImportPlan,
      ppLock: ppLock, ppUnlock: ppUnlock, ppBusy: ppBusy, mpTestEnvUrls: mpTestEnvUrls, mpReasonText: mpReasonText,
      renderMagicPortResults: renderMagicPortResults, pageBotId: pageBotId,
      bridgeSeen: function () { return JSON.parse(JSON.stringify(_bridgeSeen)); },
      captures: function () { return capturedMeta.map(function (m) { return { url: m.url, key: m.key, urlBot: m.urlBot }; }); },
      // test-only feed through the same checks as the private channel (isolated world only)
      feedBridge: function (msg) { onBridge(msg); }
    };
  } catch (e) {}
  // import-side helpers for the unit tests
  try {
    window.__ppTest.peekMagicPort = peekMagicPort; window.__ppTest.mpConfigShapeOk = mpConfigShapeOk;
    window.__ppTest.handleImportFile = handleImportFile; window.__ppTest.renderMarkdown = renderMarkdown;
  } catch (e) {}

  // export / find-replace internals for the offline tests
  try {
    window.__ppTest.replaceInHtml = replaceInHtml; window.__ppTest.undoReplaceAll = undoReplaceAll;
    window.__ppTest.fieldSignature = fieldSignature; window.__ppTest.exportFallbackSections = exportFallbackSections;
    window.__ppTest.refreshExport = refreshExport;
    // new 2-field layout
    window.__ppTest.d2Tour = d2Tour; window.__ppTest.d2ProviderModelPairs = d2ProviderModelPairs;
    window.__ppTest.d2SelectedVoice = d2SelectedVoice; window.__ppTest.d2CurrentTopTab = d2CurrentTopTab;
    window.__ppTest.d2HasTab = d2HasTab; window.__ppTest.nameFromUI = nameFromUI; window.__ppTest.findEditors = findEditors;
    window.__ppTest.breaksToParagraphs = breaksToParagraphs; window.__ppTest.liveEditorHtml = liveEditorHtml;
    window.__ppTest.downloadMagicPortDash2 = downloadMagicPortDash2; window.__ppTest.collectTwoField = collectTwoField;
    window.__ppTest.saveToDash5 = saveToDash5; window.__ppTest.d2CaptureMeta = d2CaptureMeta;
  } catch (e) {}

  // ---- boot ---------------------------------------------------------------
  try { mpDash2Hosts(); } catch (e) {}   // read the manifest now: an orphaned script can't later
  askInterceptorForLatest();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureUI);
  } else {
    ensureUI();
  }
})();
