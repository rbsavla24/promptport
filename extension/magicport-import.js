/*
 * magicport-import.js  (ISOLATED world)  — PromptPort v4.0
 *
 * The Magic Port IMPORT orchestrator: "upload the zip -> everything is done"
 * (REQ-3). Given a parsed Magic Port config and the destination platform, it
 * writes every data point into the destination bot, driving the UI with the
 * live-proven primitives in MagicPortDom, and asserts each step.
 *
 * Per-field loop (REQ-3):  open -> set -> click the CORRECT section Save ->
 *                          re-read -> assert.
 *
 * Order (Raj): variables -> tools -> prompt -> language/voice ->
 *              [LLM and STT -> call config: 2-field source only] ->
 *              custom analysis -> events.
 *
 * Correctness:
 *   REQ-1  every variable created; count verified.
 *   REQ-2  Integer->Number etc. (via MagicPort.mapForDestination); types verified.
 *
 * Safety:
 *   - Stops immediately on an auth redirect (session drop) and reports where it
 *     reached — never "saves into the void".
 *   - Flags not-portable items (e.g. Dash2 QA has no Pre-Call tools) instead of
 *     failing the whole run.
 *
 * content.js owns: the uploaded zip parse, the pre-import backup/undo, the UI
 * report, and the prompt writer (pasteHtmlIntoEditor + 5<->2 conversion), which
 * this module calls back into via the `ctx` hooks.
 *
 * STATUS: variables / custom-analysis-keys / events are fully implemented and
 * built on live-validated techniques. prompt / language-voice / tools are
 * scaffolded with the known approach and finalized during the live end-to-end
 * pass (marked TODO@LIVE).
 */
(function () {
  "use strict";

  var D = null; // MagicPortDom, resolved at run time
  function dom() { return (D = D || window.MagicPortDom); }
  // A background browser tab does not run the dashboard's menus and tab
  // switches (live 2026-11-03: three migrations started side by side all stuck
  // on "Language and Voice"). Every wait in the run therefore pauses while the
  // tab is hidden and resumes once it is in front again. The panel shows the
  // pause through the onPause hook.
  function tabHidden() {
    try { return document.visibilityState === "hidden"; } catch (e) { return false; }
  }
  var pausedMs = 0;   // total time spent paused; deadlines skip it
  async function untilVisible() {
    if (!tabHidden()) return;
    var p0 = Date.now();
    var hook = window.MagicPortImport && window.MagicPortImport.onPause;
    try { if (hook) hook(true); } catch (e) {}
    while (tabHidden()) {
      await new Promise(function (res) {
        var done = false;
        function fin() { if (done) return; done = true; try { document.removeEventListener("visibilitychange", fin); } catch (e) {} res(); }
        try { document.addEventListener("visibilitychange", fin); } catch (e) {}
        setTimeout(fin, 1000);
      });
    }
    // let the page catch up (deferred renders, animation frames) before acting
    await dom().sleep(600);
    pausedMs += Date.now() - p0;
    try { if (hook) hook(false); } catch (e) {}
  }
  async function sleep(ms) { await untilVisible(); await dom().sleep(ms); await untilVisible(); }

  var DASH2 = "dash2";

  // ---- navigation ---------------------------------------------------------
  // Dash2 left-nav tab labels.
  var DASH2_TABS = {
    prompt: "Prompt",
    variables: "Custom Variables",
    languageVoice: "Language and Voice",
    events: "Event Subscription",
    tools: "Tools",
    analysis: "Custom Analysis",
    llmStt: "LLM and STT",          // 2-field source only
    callConfig: "Call Config"       // 2-field source only
  };

  // Select one of the agent's top-level tabs (Custom Variables, Tools, Custom
  // Analysis, ...). These are Radix tab triggers, so a bare .click() leaves
  // aria-selected="false" and the panel never opens -- the section then writes
  // into whatever tab happened to be showing, or finds no fields at all and
  // reports every item "missing". Verified live 2026-10-31: the Custom Analysis
  // keys all failed this way while the tab stayed on Prompt.
  //
  // The old wait was `... || true`, so it returned success unconditionally and
  // never checked that the tab had actually switched. Confirm via aria-selected.
  async function gotoTab(label, opts) {
    var d = dom();
    // New 2-field UI: sidebar sections (data-outline-item slugs), not tabs.
    if (isV2()) return gotoSectionV2(label, opts);
    var want = d.norm(label).toLowerCase();
    var budget = (opts && opts.budgetMs) || 9000;
    function all() {
      return [].slice.call(document.querySelectorAll("[role='tab'], button, a"))
        .filter(function (b) { return d.visible(b); });
    }
    function trigger() {
      var els = all(), txt = function (b) { return d.norm(b.textContent).toLowerCase(); };
      // exact label first (prefer real tab triggers), then a label with a badge/count after it
      return els.filter(function (b) { return b.getAttribute("role") === "tab" && txt(b) === want; })[0] ||
             els.filter(function (b) { return txt(b) === want; })[0] ||
             els.filter(function (b) { return b.getAttribute("role") === "tab" && txt(b).indexOf(want) === 0; })[0] || null;
    }
    function isDisabled(t) {
      return !!(t.disabled || t.getAttribute("aria-disabled") === "true" || t.hasAttribute("data-disabled"));
    }
    function selected() {
      var t = trigger();
      if (!t) return false;
      if (t.getAttribute("data-state") === "active") return true;
      var a = t.getAttribute("aria-selected");
      // Plain links/buttons carry no aria-selected; fall back to the URL cue --
      // the URL's tab parameter must name THIS tab (any "tab=" is not enough).
      if (a === null) return urlTabIs(t, label);
      return a === "true";
    }
    // A dropdown left open by the previous section (e.g. the language picker)
    // swallows the next click on a tab -- close it first.
    try { if (d.menuIsOpen && d.menuIsOpen()) await d.dismissMenu(); } catch (e) {}
    if (selected()) { await sleep(300); return true; }
    // Right after a section Save the dashboard can be busy re-rendering, with its
    // tabs disabled for a few seconds. Keep trying (click, pointer sequence,
    // focus + Enter) for up to ~9 s instead of giving up after ~1.4 s.
    var deadline = Date.now() + budget, attempt = 0, sawDisabled = false, paused0 = pausedMs;
    while (Date.now() - (pausedMs - paused0) < deadline) {
      var t = trigger();
      if (t && !isDisabled(t)) {
        try { t.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) {}
        var how = attempt % 3;
        if (how === 0) d.clickEl(t);
        else if (how === 1) d.pressSequence(t);
        else {
          try { t.focus(); } catch (e) {}
          try { t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })); } catch (e) {}
        }
        attempt++;
        await sleep(500);
        if (selected()) { await sleep(500); return true; }
      } else {
        if (t) sawDisabled = true;
        try { if (d.menuIsOpen && d.menuIsOpen()) await d.dismissMenu(); } catch (e) {}
        await sleep(400);
      }
    }
    // Say WHY, so a failure on a live dashboard is diagnosable from the report.
    var why = [];
    var t2 = trigger();
    if (!t2) {
      var seen = all().filter(function (b) { return b.getAttribute("role") === "tab"; }).map(function (b) { return d.norm(b.textContent); }).slice(0, 10);
      why.push("tab not found on the page" + (seen.length ? " (tabs seen: " + seen.join(", ") + ")" : ""));
    } else {
      if (isDisabled(t2) || sawDisabled) why.push("the tab stayed disabled");
      why.push("clicked " + attempt + "x, it never became the active tab");
    }
    var cur = currentTopTab(); if (cur) why.push("still on '" + cur + "'");
    var dlg = [].slice.call(document.querySelectorAll("[role='dialog'],[role='alertdialog']")).filter(function (x) { return d.visible(x); })[0];
    if (dlg) why.push("a dialog is open: \u201c" + d.norm(dlg.textContent).slice(0, 80) + "\u201d");
    try { if (d.menuIsOpen && d.menuIsOpen()) why.push("a dropdown is still open"); } catch (e) {}
    gotoTab.lastWhy = why.join("; ");
    return false;
  }
  // ?tab=<slug> in the page URL names the wanted tab: the trigger link's own
  // tab parameter when it has one, else a slug of the label ("Custom Analysis"
  // -> custom-analysis / customanalysis; "Language and Voice" also matches
  // language-voice).
  function tabParam(href) {
    try { return new URL(href, location.href).searchParams.get("tab"); } catch (e) { return null; }
  }
  function urlTabIs(trig, label) {
    var cur = tabParam(location.href);
    if (!cur) return false;
    var squash = function (x) { return String(x || "").toLowerCase().replace(/[^a-z0-9]/g, ""); };
    var want = [];
    var own = trig && trig.getAttribute && trig.getAttribute("href") ? tabParam(trig.getAttribute("href")) : null;
    if (own) want.push(squash(own));
    want.push(squash(label));
    want.push(squash(String(label).replace(/\band\b/ig, "")));
    return want.indexOf(squash(cur)) !== -1;
  }
  // The "Add" control next to an analysis key row. Live labels vary ("Add",
  // "ADD", "+ Add", "Add key") and it may be a <button> or a [role=button];
  // match all of them, case-insensitively.
  function isAddCtl(b) {
    var t = dom().norm(b.textContent || b.getAttribute("aria-label") || "").toLowerCase().replace(/^\+\s*/, "");
    return /^add( new)?( key| variable| output( variable)?| field)?$/.test(t);
  }
  function addCtlsIn(row) {
    return row ? [].slice.call(row.querySelectorAll("button, [role='button']")).filter(isAddCtl) : [];
  }
  // Press an Add control the way a person does and confirm it took. React/Radix
  // buttons can ignore a bare .click(), and the button may stay disabled for a
  // moment after the type is chosen while the form re-validates. Each escalation
  // happens only if the previous attempt did not take, so a key is never added twice.
  async function pressAdd(getBtn, done) {
    var d = dom();
    for (var a = 0; a < 4; a++) {
      var b = getBtn();
      for (var w = 0; w < 12 && b && (b.disabled || b.getAttribute("aria-disabled") === "true"); w++) { await sleep(250); b = getBtn(); }
      if (!b) return done();
      if (a === 0) d.clickEl(b);
      else if (a === 1) d.pressSequence(b);
      else if (a === 2) { try { b.focus(); } catch (e) {} b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })); b.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true })); }
      else { var f = b.closest("form"); if (f) { try { if (f.requestSubmit) f.requestSubmit(); else f.submit(); } catch (e) {} } }
      await sleep(500);
      if (done()) return true;
    }
    return done();
  }

  function tabFail(section, label) {
    if (isV2()) return fail(section, "the '" + v2Label(label) + "' section could not be opened" + (gotoTab.lastWhy ? " — " + gotoTab.lastWhy : ""));
    return fail(section, "the '" + label + "' tab could not be selected" + (gotoTab.lastWhy ? " — " + gotoTab.lastWhy : ""));
  }

  // Which top-level tab is showing right now (one of DASH2_TABS), or "".
  // A section that has nothing to do (e.g. no tools) returns before navigating,
  // so without this the next commit would re-save the PREVIOUS tab.
  function currentTopTab() {
    var d = dom();
    if (isV2()) { var ak = v2KeyOfSlug(d.v2ActiveSection()); return ak ? DASH2_TABS[ak] : ""; }
    var labels = [];
    for (var k in DASH2_TABS) { if (DASH2_TABS.hasOwnProperty(k)) labels.push(DASH2_TABS[k]); }
    var t = [].slice.call(document.querySelectorAll('button[role="tab"]'))
      .filter(function (x) {
        return d.visible(x) && x.getAttribute("aria-selected") === "true" &&
               labels.indexOf(d.norm(x.textContent)) !== -1;
      })[0];
    return t ? d.norm(t.textContent) : "";
  }

  function fail(section, reason) { return { section: section, ok: false, reason: reason, failedItems: [] }; }
  function authStop(section) { return { section: section, ok: false, reason: "auth-redirect", stop: true, failedItems: [] }; }

  // ---- new 2-field UI (2026-11-05): sections + one page-wide Save ------------
  // Detected per call (MagicPortDom.v2IsNewUi: the sidebar of section buttons).
  // On the old layout every v2 branch is skipped and the old code runs as is.
  function isV2() { var d = dom(); return !!(d && d.v2IsNewUi && d.v2IsNewUi()); }
  // Sidebar labels of the new UI, by DASH2_TABS key (used in messages).
  var DASH2_V2_LABELS = {
    prompt: "Prompt", variables: "Variables", languageVoice: "Language & voice", events: "Webhooks",
    tools: "Tools", analysis: "Post-call analysis", llmStt: "Models", callConfig: "Call settings"
  };
  // DASH2_TABS key for an old tab label, a new sidebar label, a slug or a key.
  function v2KeyOf(label) {
    var w = dom().norm(label).toLowerCase(), S = dom().V2_SECTIONS || {};
    for (var k in DASH2_TABS) {
      if (!DASH2_TABS.hasOwnProperty(k)) continue;
      if (k.toLowerCase() === w || DASH2_TABS[k].toLowerCase() === w || (DASH2_V2_LABELS[k] || "").toLowerCase() === w || S[k] === w) return k;
    }
    return "";
  }
  function v2KeyOfSlug(slug) {
    var S = dom().V2_SECTIONS || {};
    for (var k in S) { if (S.hasOwnProperty(k) && S[k] === slug) return k; }
    return "";
  }
  function v2Label(label) { var k = v2KeyOf(label); return (k && DASH2_V2_LABELS[k]) || label; }
  // Only the active section is mounted: "open" = its own controls are on the page.
  var V2_READY = {
    prompt: function () { return document.querySelectorAll('section[aria-label="Prompt editor"] .ProseMirror').length >= 2; },
    variables: function () { return !!document.querySelector('input[placeholder="e.g. Branch Name"]'); },
    analysis: function () { return !!document.querySelector('section[aria-label="Post-call analysis editor"]'); }
  };
  async function gotoSectionV2(label, opts) {
    var d = dom(); opts = opts || {};
    var k = v2KeyOf(label), slug = k ? (d.V2_SECTIONS || {})[k] : "";
    if (!slug) { gotoTab.lastWhy = "no section called '" + label + "' on this dashboard"; return false; }
    await untilVisible();
    var ok = await d.v2GotoSection(slug, opts.ready || V2_READY[k] || null, opts.budgetMs || 9000);
    if (!ok && tabHidden()) {           // the tab went to the background mid-wait: once more when it's back
      await untilVisible();
      ok = await d.v2GotoSection(slug, opts.ready || V2_READY[k] || null, opts.budgetMs || 9000);
    }
    gotoTab.lastWhy = ok ? "" : (d.v2GotoSection.lastWhy || "");
    if (ok) await sleep(250);
    return ok;
  }
  // Every page-wide Save this run pressed: { label, state, text }. run() reads
  // it after each step, so a rejected save fails THAT step (whoever pressed it).
  var v2SaveLog = [];
  function v2Reject(text) { return "Save rejected: " + (text || "the dashboard refused the save"); }
  function v2Unconfirmed(label) { return "The dashboard didn't confirm the save — check " + v2Label(label) + " by hand"; }
  // Only texts that are about a SAVE failing count (an unrelated error toast,
  // e.g. "Couldn't load usage stats", never fails a save).
  var V2_SAVE_FAIL_RE = /couldn['’]?t save|can['’]?t save|could not save|cannot save|not saved|failed to save|save failed|fix \d+ fields? in/i;
  var V2_SAVE_OK_RE = /changes saved|\bsaved\b/i;
  // The dashboard refuses every Save while the main prompt is empty.
  var V2_EMPTY_PROMPT_RE = /prompt[^.]{0,40}(can['’]?t|cannot|must not|may not|can not) be empty|empty (main )?prompt|fix \d+ fields? in prompt/i;
  function v2InFlight() { var d = dom(); try { return !!(d.saveInFlight && d.saveInFlight()); } catch (e) { return false; } }
  async function v2WaitIdle(ms) {
    var d = dom();
    if (!v2InFlight()) return true;
    if (d.waitSaveIdle) { await untilVisible(); return await d.waitSaveIdle(ms || 45000); }
    for (var i = 0; i < Math.ceil((ms || 45000) / 250) && v2InFlight(); i++) await sleep(250);
    return !v2InFlight();
  }
  function v2BarText() {
    var b = dom().v2SaveBar();
    return b ? dom().norm(b.textContent).replace(/\s*Review\s*Discard\s*Save\s*$/, "") : "";
  }
  // One press of the page-wide Save, never while a Save is still running
  // (C2/C3): an in-flight Save is waited for, then judged by the bar and by
  // the toasts that appeared since the press.
  async function v2SaveOnce() {
    var d = dom();
    await v2WaitIdle(45000);
    var snap = null; try { snap = d.toastSnapshot ? d.toastSnapshot() : null; } catch (e) {}
    var res = await d.v2SaveAll(15000);
    if (res.state === "none" || res.state === "saved") return res;
    if (v2InFlight()) await v2WaitIdle(45000); else await sleep(300);
    var bar = d.v2SaveBar(), fresh = [];
    try { fresh = snap && d.freshToastTexts ? d.freshToastTexts(snap) : []; } catch (e) {}
    var bad = fresh.filter(function (t) { return V2_SAVE_FAIL_RE.test(t); })[0] ||
      (res.state === "failed" && V2_SAVE_FAIL_RE.test(res.text || "") ? res.text : "");
    var good = fresh.filter(function (t) { return V2_SAVE_OK_RE.test(t) && !V2_SAVE_FAIL_RE.test(t); })[0];
    if (!bar) {
      // the bar closed: what was pending is what the server holds now
      if (good) return { state: "saved", text: good };
      if (bad) return { state: "failed", text: bad };
      return { state: "unconfirmed", text: "the bar closed but no confirmation appeared" };
    }
    var fix = d.norm(bar.textContent).match(/Fix \d+ fields? in [^.]+/i);
    if (fix) return { state: "blocked", text: fix[0] };
    if (bad) return { state: "failed", text: bad };
    if (v2InFlight()) return { state: "unconfirmed", text: "the Save is still running" };
    return { state: "unconfirmed", text: "the Save didn't finish" };
  }
  // Press the page-wide Save and log the outcome (one log entry per call). A
  // Save that was refused or didn't finish is tried once more — never while
  // one is still running, and not when the field errors or an empty prompt
  // make a second press pointless.
  async function saveV2(label, warnings) {
    var d = dom();
    await untilVisible();
    var res = await v2SaveOnce(), first = null;
    if ((res.state === "failed" || res.state === "unconfirmed") && d.v2SaveBar() && !v2InFlight() &&
        !V2_EMPTY_PROMPT_RE.test(res.text || "") && !d.isAuthRedirect()) {
      first = res;
      await sleep(800);
      res = await v2SaveOnce();
      if (res.state === "none") res = { state: "unconfirmed", text: "the bar closed but no confirmation appeared" };
    }
    var e = { label: v2Label(label), state: res.state, text: res.text || "", retried: !!first, firstText: first ? first.text : "" };
    v2SaveLog.push(e);
    if (res.state === "unconfirmed" && !d.v2SaveBar() && warnings) pushOnce(warnings, v2Unconfirmed(label));
    if (first && res.state === "saved" && warnings && first.state === "failed")
      pushOnce(warnings, "The first Save of " + v2Label(label) + " was refused (" + first.text + "); pressing Save again stored it.");
    return e;
  }
  // Press the save bar's Discard (and its confirmation, if the dashboard asks)
  // — only ever for changes this run made. True once the bar is gone.
  async function v2Discard() {
    var d = dom();
    await v2WaitIdle(30000);
    for (var a = 0; a < 3 && d.v2SaveBar(); a++) {
      var bar = d.v2SaveBar();
      var btn = [].slice.call(bar.querySelectorAll("button")).filter(function (b) { return d.norm(b.textContent) === "Discard"; })[0];
      if (!btn) return false;
      if (a === 0) d.clickEl(btn); else d.pressSequence(btn);
      await sleep(500);
      // a "Discard changes?" confirmation: press its own Discard button
      var dlg = [].slice.call(document.querySelectorAll("[role='alertdialog'],[role='dialog']")).filter(function (x) {
        return d.visible(x) && [].slice.call(x.querySelectorAll("button")).some(function (b) { return /^discard\b/i.test(d.norm(b.textContent)); });
      })[0];
      if (dlg) {
        var ok = [].slice.call(dlg.querySelectorAll("button")).filter(function (b) { return /^discard\b/i.test(d.norm(b.textContent)); }).pop();
        d.clickEl(ok); await sleep(500);
      }
      await d.waitFor(function () { return !d.v2SaveBar(); }, 3000, 200);
    }
    return !d.v2SaveBar();
  }
  // Read a section back after its Save (C4): no Save may still be running, the
  // step's OWN section must be the open one (the user may have clicked another),
  // and a late list gets ~10 s to show what is missing. Returns the last read
  // and whether the section could be read at all.
  async function v2ReadBack(label, readyFn, readFn, missingFn, ms) {
    var d = dom(), slug = (d.V2_SECTIONS || {})[v2KeyOf(label)] || "";
    await v2WaitIdle(30000);
    await sleep(600);
    var paused0 = pausedMs, t0 = Date.now(), got = null, open = false;
    while (true) {
      open = !!(readyFn ? safeCall(readyFn) : true) && (!slug || d.v2ActiveSection() === slug);
      if (!open) open = await gotoSectionV2(label, { budgetMs: 6000 });
      got = readFn();
      if (open && !missingFn(got).length) break;
      if (Date.now() - t0 - (pausedMs - paused0) >= (ms || 10000)) break;
      await sleep(500);
    }
    return { got: got, open: open };
  }
  function safeCall(fn) { try { return fn(); } catch (e) { return null; } }
  // Wait for the section to re-render from the server's copy after a Save.
  async function v2Settle(readyFn) {
    await sleep(600);
    for (var i = 0; i < 20; i++) { var ok = false; try { ok = !readyFn || readyFn(); } catch (e) {} if (ok) break; await sleep(200); }
  }

  // ---- save confirmation (contract 2) ----------------------------------------
  // Press the section's Save (optionally falling back to the global one) and
  // wait for a SUCCESS toast. Never presses anything on the login bounce.
  // Returns "auth" (stop the section), true (confirmed), false (not confirmed:
  // a warning was added; or REJECTED: see saveRejected()), or null (no Save on
  // this tab and none needed, or the Save was greyed out: nothing to save).
  var SAVE_OK_RE = /saved|updated|success/i;
  function unconfirmedMsg(label) {
    return "The dashboard didn't confirm the save \u2014 check " + label + " by hand";
  }
  function pushOnce(arr, v) { if (arr.indexOf(v) === -1) arr.push(v); }
  // Old UI: what the last saveAndConfirm() press got back ({ state, text }).
  var lastOldSave = null;
  // The failed item for a Save the dashboard refused (old UI), or "".
  function saveRejected(label) {
    return lastOldSave && lastOldSave.state === "fail"
      ? label + " \u2014 Save rejected: " + (lastOldSave.text || "the dashboard refused the save") : "";
  }
  function saveBtnOff(b) { return !!(b && (b.disabled || b.getAttribute("aria-disabled") === "true")); }
  // Old UI: press a Save and read the dashboard's answer.
  // { state: "ok"|"fail"|"none"|"disabled"|"missing", text }. Only toasts that
  // appear after the press count (a toast left from an earlier save never
  // confirms this one); a fresh failure toast wins. A Save still running (its
  // button greyed out after the press, "Saving\u2026") is waited out, and the next
  // write / read-back only starts once no save is in flight.
  async function oldPressSave(find, press, re, ms) {
    var d = dom();
    try { await d.waitSaveIdle(20000); } catch (e) {}
    var b = find();
    if (!b) return { state: "missing", text: "" };
    // Greyed out = nothing changed (disabled until dirty). Give a form that is
    // still validating a moment first.
    for (var w = 0; w < 8 && saveBtnOff(b); w++) { await sleep(250); b = find() || b; }
    if (saveBtnOff(b)) return { state: "disabled", text: "" };
    var before = d.toastSnapshot();
    press(b);
    var res = await d.waitToastResult(re, ms, before);
    var deadline = Date.now() + 15000;
    while (res.state === "none" && Date.now() < deadline) {
      var nb = find();
      if (!(d.saveInFlight() || (nb && saveBtnOff(nb)))) break;
      res = await d.waitToastResult(re, 1000, before);
    }
    try { await d.waitSaveIdle(20000); } catch (e) {}
    return res;
  }
  // Old UI: the overall Save (grouped with "Back"), pressed by run() after a
  // section, with the same rules as a section Save: "disabled" = nothing left
  // to commit; "fail" = refused (text = the toast); "none" = no answer;
  // "missing" = no overall Save on this tab. Returns once no save is in flight,
  // so the next section never writes into a form that is about to re-render.
  async function oldGlobalSavePress() {
    var d = dom();
    if (!d.findGlobalSave()) return { state: "missing", text: "" };
    return oldPressSave(function () { return d.findGlobalSave(); }, function (b) { d.pressSequence(b); }, SAVE_OK_RE, 3500);
  }
  async function saveAndConfirm(label, warnings, opts) {
    var d = dom(); opts = opts || {};
    lastOldSave = null;
    if (d.isAuthRedirect()) return "auth";
    // New UI: the one page-wide Save. saved -> true; nothing pending -> null;
    // rejected/blocked -> false (logged: run() fails the section with the
    // toast's text); unconfirmed -> false + a warning (the section's read-back decides).
    if (isV2()) {
      var sv = await saveV2(label, warnings);
      if (d.isAuthRedirect()) return "auth";
      return sv.state === "saved" ? true : (sv.state === "none" ? null : false);
    }
    var comp = opts.companion || null;
    var res = { state: "missing", text: "" };
    if (d.findSectionSave(comp))
      res = await oldPressSave(function () { return d.findSectionSave(comp); }, function (b) { d.clickEl(b); }, opts.re || SAVE_OK_RE, opts.ms || 3000);
    else if (opts.globalFallback && d.findGlobalSave())
      res = await oldPressSave(function () { return d.findGlobalSave(); }, function (b) { d.pressSequence(b); }, opts.re || SAVE_OK_RE, opts.ms || 3000);
    lastOldSave = res;
    if (d.isAuthRedirect()) return "auth";
    if (res.state === "missing") {
      if (opts.noSaveOk) return null;
      pushOnce(warnings, unconfirmedMsg(label) + " (its Save button was not found)");
      return false;
    }
    if (res.state === "disabled") {
      // Greyed out: nothing to save -- unless this section did change something
      // (then the dashboard may be refusing the form): say so.
      if (!opts.changed) return null;
      pushOnce(warnings, unconfirmedMsg(label) + " (its Save button stayed greyed out)");
      return false;
    }
    if (res.state === "fail") return false;        // the caller reports saveRejected(label)
    if (res.state !== "ok") pushOnce(warnings, unconfirmedMsg(label));
    return res.state === "ok";
  }
  function withWarnings(res, warnings) {
    if (res && warnings && warnings.length) res.warnings = (res.warnings || []).concat(warnings.filter(function (w) { return (res.warnings || []).indexOf(w) === -1; }));
    return res;
  }

  // Fail-safe retry: try an item up to `max` times (default 3). After each
  // attempt, verifyFn() decides success. On an auth redirect we abort (no point
  // retrying a logged-out page). Returns { ok, attempts, auth }.
  async function withRetry(attemptFn, verifyFn, max) {
    max = max || 3;
    for (var a = 1; a <= max; a++) {
      if (dom().isAuthRedirect()) return { ok: false, attempts: a - 1, auth: true };
      try { await attemptFn(a); } catch (e) {}
      await sleep(220);
      var ok = false;
      try { ok = await verifyFn(); } catch (e) { ok = false; }
      if (ok) return { ok: true, attempts: a };
      await sleep(200); // brief backoff before the next attempt
    }
    return { ok: false, attempts: max };
  }

  // ========================================================================
  //  DASH2 destination sections
  // ========================================================================

  // ---- 2. Custom Variables (REQ-1) ---------------------------------------
  async function dash2Variables(vars) {
    var d = dom();
    if (d.isAuthRedirect()) return authStop("variables");
    if (isV2()) return dash2VariablesV2(vars);
    if (!(await gotoTab(DASH2_TABS.variables)))
      return tabFail("variables", DASH2_TABS.variables);
    if (d.isAuthRedirect()) return authStop("variables");

    function nameInput() {
      return [].slice.call(document.querySelectorAll("input"))
        .filter(function (i) { return d.visible(i) && /write new variable/i.test(i.placeholder || ""); })[0];
    }
    function typeTrigger() {
      return [].slice.call(document.querySelectorAll("input"))
        .filter(function (i) { return d.visible(i) && ["String", "Date"].indexOf(i.value || "") !== -1; })[0];
    }
    function addBtn() {
      var inp = nameInput(); if (!inp) return null;
      var row = inp; for (var k = 0; k < 6 && row; k++) { row = row.parentElement; if (row && [].slice.call(row.querySelectorAll("button")).some(function (b) { return d.norm(b.textContent) === "Add"; })) break; }
      return row ? [].slice.call(row.querySelectorAll("button")).filter(function (b) { return d.norm(b.textContent) === "Add"; })[0] : null;
    }

    var failedItems = [], warnings = [], alreadyPresent = 0, anyAdded = false;
    function present(name) { return readDash2VariableNames().indexOf(name) !== -1; }
    var before = readDash2VariableNames();
    var handled = {};
    for (var i = 0; i < vars.length; i++) {
      if (d.isAuthRedirect()) return authStop("variables");
      var v = vars[i];
      if (handled[v.name]) continue;          // the same name twice in the source: one variable
      handled[v.name] = true;
      // d.norm() collapses whitespace but does NOT lowercase (magicport.js's
      // norm does -- the two are easy to confuse). Comparing it to "date" was
      // always false for a source type of "Date", so the Date branch never ran
      // and every Date variable silently landed as String.
      var wantType = String(v.type || "").trim().toLowerCase() === "date" ? "Date" : "String";
      // Already on the destination (a re-run, or a variable the bot had): never
      // Add it again -- this dashboard accepts a repeated name and makes a
      // duplicate. Its type is checked with everyone else's below.
      if (present(v.name)) { alreadyPresent++; continue; }
      // Once an Add has gone through (the form took the name), later attempts
      // only wait for its chip: pressing Add again makes a duplicate.
      var submitted = false;
      var r = await withRetry(async function () {
        // The chip can render late: a name that showed up since the last
        // attempt is done, not re-added.
        if (present(v.name)) return;
        if (submitted) { await d.waitFor(function () { return present(v.name); }, 6000, 200); return; }
        var inp = nameInput(); if (!inp) return;
        d.setReactInput(inp, v.name);
        // Type: ALWAYS set it and read it back. The control is a read-only
        // companion <input> beside a div[role=button] trigger; pressing the
        // input opens String / Date. The old code only drove the dropdown for
        // Date and ignored the result, so a Date that failed to take silently
        // became String -- and nothing downstream checked types at all.
        for (var ta = 0; ta < 3; ta++) {
          var tt = typeTrigger();
          if (!tt) break;
          if (d.norm(tt.value) === wantType) break;
          await d.setSingleDropdown(tt, wantType, function () {
            var x = typeTrigger(); return x ? x.value : null;
          });
          await sleep(200);
        }
        var tnow = typeTrigger();
        if (tnow && d.norm(tnow.value) !== wantType) return;   // let the retry handle it
        if (present(v.name)) return;            // last look right before the Add
        var ab = addBtn(); if (!ab) return;
        ab.click();
        anyAdded = true;
        // The Add went through when the form let go of the name (input
        // cleared); a press that did not register may be retried.
        await sleep(150);
        var inAfter = nameInput();
        if (!inAfter || d.norm(inAfter.value) !== d.norm(v.name)) submitted = true;
        // Wait for the chip before the attempt ends: a chip that lags the Add
        // made the retry add the same variable again (a duplicate).
        await d.waitFor(function () { return present(v.name); }, 4000, 200);
      }, function () {
        if (!present(v.name)) return false;
        var got = readDash2VariableTypes()[v.name];
        // an unreadable chip type must not fail a variable that is really there
        return !got || d.norm(got) === wantType;
      }, 3);
      if (r.auth) return authStop("variables");
      if (!r.ok) failedItems.push(v.name);
      await sleep(120);
    }
    // Never press Save on the login bounce.
    if (d.isAuthRedirect()) return authStop("variables");
    // Save (variables section save; companion heuristic: not the global "Back" group)
    var chipsBeforeSave = readDash2VariableNames().length;
    if ((await saveAndConfirm(DASH2_TABS.variables, warnings, { changed: anyAdded })) === "auth") return authStop("variables");
    var rejected = saveRejected(DASH2_TABS.variables);
    if (rejected) failedItems.push(rejected);

    // verify (REQ-1): re-read variable chips. After a save the page re-renders
    // from the server and the list can come back late, so keep re-reading for
    // ~12 s before calling a variable missing.
    await sleep(400);
    var actual = readDash2VariableNames();
    var vr = window.MagicPort.verifyVariables(vars, actual);
    for (var vt = 0; vt < 24 && !vr.ok; vt++) {
      await sleep(500);
      actual = readDash2VariableNames();
      vr = window.MagicPort.verifyVariables(vars, actual);
    }
    // A chip that lags its Add (a second one = a duplicate) gets one more look.
    if (vr.ok && anyAdded) { await sleep(800); actual = readDash2VariableNames(); vr = window.MagicPort.verifyVariables(vars, actual); }
    // The list itself never came back (no chips at all, though there were
    // some before the save): that is "couldn't confirm", not "not there".
    if (!vr.ok && !actual.length && chipsBeforeSave && !rejected) {
      pushOnce(warnings, "Couldn't confirm " + DASH2_TABS.variables + ": the list did not show after the save — check it by hand");
      vr = { ok: true, expectedCount: vr.expectedCount, actualCount: vr.actualCount, missing: [] };
      actual = [];
    }

    // This import ADDS and UPDATES; it never deletes. Variables already on the
    // destination that the source doesn't have are left untouched -- but they
    // are reported, so the difference is visible instead of silent. (The consent
    // copy used to claim the import "overwrites" the destination; it does not.)
    // verify TYPES too (the chips carry them). Names alone were never enough:
    // a Date that silently landed as String passed every check before this.
    var typesByName = readDash2VariableTypes();
    var seenType = {};
    vars.forEach(function (v) {
      if (seenType[v.name]) return; seenType[v.name] = true;
      var want = String(v.type || "").trim().toLowerCase() === "date" ? "Date" : "String";
      var got = typesByName[v.name];
      if (got && d.norm(got) !== want) {
        // one complete line per item (contract 4): replace a bare name entry
        var idx = failedItems.indexOf(v.name);
        var line = v.name + " (type: want " + want + ", got " + got + ")";
        if (idx !== -1) failedItems[idx] = line; else failedItems.push(line);
      }
      // A name on the page more than once is a duplicate, never "done".
      var n = actual.filter(function (x) { return x === v.name; }).length;
      if (n > 1) failedItems.push("duplicate variable x" + n + ": " + v.name);
    });

    var sourceNames = vars.map(function (v) { return d.norm(v.name); });
    var extras = actual.filter(function (n, ix) { return sourceNames.indexOf(d.norm(n)) === -1 && actual.indexOf(n) === ix; });
    var created = rejected ? 0 : Object.keys(handled).filter(function (n) {
      return before.indexOf(n) === -1 && actual.indexOf(n) !== -1 && failedItems.indexOf(n) === -1;
    }).length;

    return withWarnings({ section: "variables", ok: vr.ok && !failedItems.length,
      expected: vr.expectedCount, actual: vr.actualCount, missing: vr.missing,
      created: created, alreadyPresent: alreadyPresent,
      extras: extras, leftovers: extras.map(function (n) { return "Variable: " + n; }),
      notes: extras.length
        ? [extras.length + " variable(s) already on the destination were left in place (not in the source): " + extras.join(", ")]
        : [],
      failedItems: failedItems }, warnings);
  }

  function readDash2VariableNames() {
    // chips render as "Pretty Name [Type]" but store snake_case; the Remove
    // button's aria-label carries the real name: "Remove <name>".
    return [].slice.call(document.querySelectorAll("button[aria-label^='Remove ']"))
      .map(function (b) { return (b.getAttribute("aria-label") || "").replace(/^Remove\s+/, "").trim(); })
      .filter(Boolean);
  }

  // name -> type, read off the chips. The chip text carries the type in square
  // brackets; the name comes from the Remove button's aria-label, since the
  // visible label is prettified. A chip whose type we cannot read is reported
  // as "" rather than guessed, so an unreadable chip never masquerades as a
  // correct one. Variables are String or Date only on Dash2.
  function readDash2VariableTypes() {
    var out = {};
    [].slice.call(document.querySelectorAll("button[aria-label^='Remove ']")).forEach(function (b) {
      var name = (b.getAttribute("aria-label") || "").replace(/^Remove\s+/, "").trim();
      if (!name) return;
      var chip = b, txt = "";
      for (var k = 0; k < 4 && chip; k++) {
        chip = chip.parentElement;
        if (chip && /\[(String|Date)\]/i.test(chip.textContent || "")) { txt = chip.textContent; break; }
      }
      var m = txt.match(/\[(String|Date)\]/i);
      out[name] = m ? (m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()) : "";
    });
    return out;
  }

  // ---- Variables on the new UI ------------------------------------------------
  // Form: input "e.g. Branch Name" + Type combobox (String / Date, keeps the
  // LAST value after Add) + Add. The app stores names in snake_case (helper
  // "Saved as <key>, shown as …"), refuses a duplicate ("… already exists"), and
  // keeps every Add local until the page-wide Save. Rows: <code>{{key}}</code>,
  // type in span[title], Remove button labelled with the HUMANISED name.
  function v2VarKeyLocal(name) {
    return String(name == null ? "" : name).trim().toLowerCase().replace(/[\s.\-]+/g, "_").replace(/_+/g, "_");
  }
  function v2DescribedText(el) {
    if (!el) return "";
    return (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean).map(function (id) {
      var x = document.getElementById(id); return x ? x.textContent : "";
    }).join(" ").replace(/\s+/g, " ").trim();
  }
  function readV2Variables() {
    var out = [];
    [].slice.call(document.querySelectorAll("table")).forEach(function (t) {
      var heads = [].slice.call(t.querySelectorAll("thead th")).map(function (h) { return dom().norm(h.textContent).toLowerCase(); });
      if (heads.length && heads.indexOf("key") === -1) return;     // not the variables table
      [].slice.call(t.querySelectorAll("tbody tr")).forEach(function (tr) {
        var code = tr.querySelector("td:nth-child(2) code") || tr.querySelector("code");
        var m = code ? dom().norm(code.textContent).match(/^\{\{\s*(.+?)\s*\}\}$/) : null;
        if (!m) return;
        var ty = tr.querySelector("td:nth-child(3) span[title]") || tr.querySelector("span[title]");
        var rm = tr.querySelector("button[aria-label^='Remove ']");
        out.push({ name: m[1], type: ty ? dom().norm(ty.getAttribute("title")) : "",
          label: tr.cells && tr.cells[0] ? dom().norm(tr.cells[0].textContent) : "", removeBtn: rm || null });
      });
    });
    return out;
  }
  function v2VarForm() {
    var d = dom();
    var inp = document.querySelector('input[placeholder="e.g. Branch Name"]');
    if (!inp) {
      var lab = [].slice.call(document.querySelectorAll("label[for]")).filter(function (l) { return d.norm(l.textContent).toLowerCase() === "variable name"; })[0];
      inp = lab ? document.getElementById(lab.getAttribute("for")) : null;
    }
    if (!inp) return null;
    var row = inp;
    for (var k = 0; k < 6 && row; k++) {
      row = row.parentElement;
      if (row && row.querySelector('button[role="combobox"]') && addCtlsIn(row).length) break;
    }
    if (!row) return null;
    var help = v2DescribedText(inp);
    var savedAs = help.match(/Saved as\s+([^\s,“"]+)/i);
    return { input: inp, row: row, type: d.v2Combo(row, "Type") || row.querySelector('button[role="combobox"]'),
      add: addCtlsIn(row)[0] || null, help: help,
      savedAs: savedAs ? savedAs[1].replace(/[.,;]+$/, "") : "",
      exists: /already exists/i.test(help) || inp.getAttribute("aria-invalid") === "true" };
  }
  async function dash2VariablesV2(vars) {
    var d = dom();
    var LABEL = DASH2_TABS.variables;
    if (!(await gotoTab(LABEL))) return tabFail("variables", LABEL);
    if (d.isAuthRedirect()) return authStop("variables");
    var failedItems = [], warnings = [], notes = [], renamed = [], added = [];
    var alreadyPresent = 0;
    function names() { return readV2Variables().map(function (x) { return x.name; }); }
    function rowOf(key) { return readV2Variables().filter(function (x) { return x.name === key; })[0] || null; }
    var before = names();
    var keyOf = {}, wantByKey = {}, srcByKey = {};
    for (var i = 0; i < vars.length; i++) {
      if (d.isAuthRedirect()) return authStop("variables");
      var v = vars[i];
      if (keyOf.hasOwnProperty(v.name)) continue;            // same name twice in the source
      var wantType = String(v.type || "").trim().toLowerCase() === "date" ? "Date" : "String";
      var f = v2VarForm();
      if (!f) { failedItems.push(v.name + " (the Variables form was not found)"); keyOf[v.name] = v2VarKeyLocal(v.name); continue; }
      // The key the app will store: its own helper text, else the same rule locally.
      d.setReactInput(f.input, v.name);
      var key = "";
      // the helper text can render late: give it ~2.5 s before guessing locally
      for (var w = 0; w < 20 && !key; w++) { await sleep(120); var f1 = v2VarForm(); key = f1 && f1.savedAs; }
      key = key || v2VarKeyLocal(v.name);
      keyOf[v.name] = key;
      if (key !== v.name) renamed.push({ from: v.name, to: key });
      if (srcByKey[key]) {
        // two source names land on the same key: one variable
        notes.push("Variables '" + srcByKey[key] + "' and '" + v.name + "' are both stored as '" + key + "' on this dashboard — one variable.");
        if (wantByKey[key] !== wantType) failedItems.push(v.name + " (type " + wantType + " clashes with '" + srcByKey[key] + "' (" + wantByKey[key] + "), both stored as " + key + ")");
        var fx = v2VarForm(); if (fx) d.setReactInput(fx.input, "");
        continue;
      }
      srcByKey[key] = v.name; wantByKey[key] = wantType;
      if (names().indexOf(key) !== -1) {                     // already there: never re-add
        alreadyPresent++;
        var fz = v2VarForm(); if (fz) d.setReactInput(fz.input, "");
        continue;
      }
      var why = "";
      for (var a = 0; a < 3; a++) {
        if (d.isAuthRedirect()) return authStop("variables");
        var fa = v2VarForm(); if (!fa) { why = "the form was not found"; break; }
        if (fa.input.value !== v.name) { d.setReactInput(fa.input, v.name); await sleep(150); }
        // Type is sticky (keeps the previous Add's value): set it EVERY time.
        var tr = await d.v2PickCombo(function () { var x = v2VarForm(); return x && x.type; }, wantType);
        if (!tr.ok) { why = "Type " + wantType + " could not be chosen (" + (tr.why || "") + (tr.offered && tr.offered.length ? "; offered: " + tr.offered.join(", ") : "") + ")"; continue; }
        var namesPre = names();
        await pressAdd(function () { var x = v2VarForm(); return x && x.add; }, function () {
          var x = v2VarForm(); return !!rowOf(key) || !!(x && x.exists) || !!(x && !x.input.value);
        });
        await d.waitFor(function () { return !!rowOf(key); }, 2000, 150);
        if (!rowOf(key)) {
          // The app stored it under another key than guessed (its helper text was
          // late): exactly one new row after this Add is this variable.
          var novel = names().filter(function (n) { return namesPre.indexOf(n) === -1; });
          if (novel.length === 1 && !srcByKey[novel[0]]) {
            delete srcByKey[key]; delete wantByKey[key];
            renamed = renamed.filter(function (r) { return r.from !== v.name; });
            key = novel[0]; keyOf[v.name] = key; srcByKey[key] = v.name; wantByKey[key] = wantType;
            if (key !== v.name) renamed.push({ from: v.name, to: key });
          }
        }
        var row = rowOf(key);
        if (row && row.type === wantType) { added.push(key); why = ""; break; }
        if (row) {
          // landed with the wrong type: take it out (one remove, re-queried) and add again
          why = "added as " + (row.type || "?") + " instead of " + wantType;
          if (row.removeBtn) { d.clickEl(row.removeBtn); await d.waitFor(function () { return !rowOf(key); }, 2000, 150); }
          if (rowOf(key)) break;
          continue;
        }
        var fb = v2VarForm();
        if (fb && fb.exists) { why = "the dashboard refused it: " + (fb.help || "already exists"); d.setReactInput(fb.input, ""); break; }
        why = "Add did not take";
      }
      if (why) failedItems.push(v.name + (key !== v.name ? " (stored as " + key + ")" : "") + " — " + why);
      await sleep(120);
    }
    if (d.isAuthRedirect()) return authStop("variables");
    var sv = await saveV2(LABEL, warnings);
    if (d.isAuthRedirect()) return authStop("variables");
    var notSaved = sv.state === "failed" || sv.state === "blocked" || (sv.state === "unconfirmed" && !!d.v2SaveBar());
    if (renamed.length) notes.push("Variable names are stored in snake_case on this dashboard: " +
      renamed.map(function (r) { return r.from + " → " + r.to; }).join(", ") + ". Prompt mentions of the old names need the new ones.");
    if (notSaved) {
      // Nothing of this section reached the server: no "created", every add listed.
      var lines = added.map(function (k) { return k + " (added on the page, but NOT saved)"; });
      var head = (sv.state === "unconfirmed") ? "The Save didn't finish — the variables are still unsaved on the page" : v2Reject(sv.text);
      return withWarnings({ section: "variables", ok: false, reason: head, saved: sv.state,
        expected: Object.keys(srcByKey).length, actual: before.length, missing: [], created: 0,
        alreadyPresent: alreadyPresent, renamed: renamed, extras: [], leftovers: [], notes: notes,
        failedItems: [head].concat(lines, failedItems) }, warnings);
    }
    // Read back what the page shows after the Save (re-rendered from the server).
    var want = Object.keys(srcByKey);
    function missingNow(list) { var ns = list.map(function (x) { return x.name; }); return want.filter(function (k) { return ns.indexOf(k) === -1; }); }
    var rb = await v2ReadBack(LABEL, V2_READY.variables, readV2Variables, missingNow, 10000);
    var after = rb.got || [];
    // The list can't be seen (section not open, or no rows rendered at all):
    // "couldn't confirm", never "not there".
    var blind = !rb.open || (!after.length && want.length > 0);
    var actual = after.map(function (x) { return x.name; });
    var typeOf = {}; after.forEach(function (x) { typeOf[x.name] = x.type; });
    var missing = [];
    want.forEach(function (k) {
      var src = srcByKey[k], label = src + (k !== src ? " (stored as " + k + ")" : "");
      var already = failedItems.some(function (l) { return l.indexOf(src + " ") === 0 || l === src; });
      if (actual.indexOf(k) === -1 && blind) {
        // a confirmed Save: a warning; no confirmation at all: a failure
        if (!already && sv.state === "saved") pushOnce(warnings, "Variables: couldn't confirm " + label + " after the save (the list didn't show in time) — check it by hand");
        else if (!already) { missing.push(src); failedItems.push(label + " — couldn't confirm it after the save (the list didn't show) — check it by hand"); }
        return;
      }
      if (actual.indexOf(k) === -1) { missing.push(src); if (!already) failedItems.push(label + " — not on the dashboard after the save"); return; }
      if (typeOf[k] && typeOf[k] !== wantByKey[k] && !already)
        failedItems.push(label + " (type: want " + wantByKey[k] + ", got " + typeOf[k] + (before.indexOf(k) !== -1 ? " — already on the destination, left as is" : "") + ")");
      var n = actual.filter(function (x) { return x === k; }).length;
      if (n > 1) failedItems.push("duplicate variable x" + n + ": " + k);
    });
    var extras = actual.filter(function (n, ix) { return want.indexOf(n) === -1 && actual.indexOf(n) === ix; });
    var created = added.filter(function (k) { return actual.indexOf(k) !== -1 && typeOf[k] === wantByKey[k] && before.indexOf(k) === -1; }).length;
    if (extras.length) notes.push(extras.length + " variable(s) already on the destination were left in place (not in the source): " + extras.join(", "));
    return withWarnings({ section: "variables", ok: !failedItems.length, saved: sv.state,
      expected: want.length, actual: actual.length, missing: missing,
      created: created, alreadyPresent: alreadyPresent, renamed: renamed,
      extras: extras, leftovers: extras.map(function (n) { return "Variable: " + n; }),
      notes: notes, failedItems: failedItems }, warnings);
  }

  // ---- 4. Custom Analysis: prompt + keys (REQ-2) -------------------------
  async function dash2Analysis(analysis, ctx) {
    var d = dom();
    if (d.isAuthRedirect()) return authStop("analysis");
    if (isV2()) return dash2AnalysisV2(analysis, ctx);
    if (!(await gotoTab(DASH2_TABS.analysis)))
      return tabFail("analysis", DASH2_TABS.analysis);
    if (d.isAuthRedirect()) return authStop("analysis");
    ctx = ctx || {};
    var warnings = [];
    var promptWhy = "";

    // Analysis System Prompt body: write analysis.prompt into the single TipTap
    // editor on this tab (reuses the content.js prompt-paste path via ctx).
    // A missing writer hook is NOT "nothing to do". Previously promptOk stayed
    // true whenever ctx.pasteTipTap was absent, so the section reported success
    // for a System Prompt it had never written -- the analysis prompt went
    // missing with no entry in the report. Only an EMPTY source prompt is a
    // legitimate no-op; anything else that stops us writing is a failure.
    var promptOk = true, promptWant = null, aNotes = [];
    function anEditor() {
      return [].slice.call(document.querySelectorAll(".ProseMirror, .tiptap, [contenteditable='true']"))
        .filter(function (e) { return d.visible(e); })[0] || null;
    }
    // An empty / whitespace-only / empty-editor ("<p></p>") source prompt is
    // nothing to write: pasting it would CLEAR the destination's prompt.
    var promptSrcText = String(analysis.prompt || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;|&#xa0;|\u00a0/gi, " ").trim();
    if (analysis.prompt && !promptSrcText) aNotes.push("Analysis System Prompt: the source prompt is empty — the destination's prompt was left as is.");
    if (analysis.prompt && promptSrcText) {
      if (typeof ctx.pasteTipTap !== "function") {
        promptOk = false;
        promptWhy = "no prompt writer hook";
      } else {
        var ed = [].slice.call(document.querySelectorAll(".ProseMirror, .tiptap, [contenteditable='true']"))
          .filter(function (e) { return d.visible(e); })[0];
        if (ed) {
          promptOk = false;
          for (var pa = 1; pa <= 3 && !promptOk; pa++) {
            try { promptOk = await ctx.pasteTipTap(ed, analysis.prompt); } catch (e) { promptOk = false; }
            if (!promptOk) await sleep(250);
          }
          if (!promptOk) promptWhy = "paste failed";
          else promptWant = edLetters(anEditor() || ed);
        } else { promptOk = false; promptWhy = "editor not found"; }
      }
    }

    function keyNameInput() {
      return [].slice.call(document.querySelectorAll("input"))
        .filter(function (i) { return d.visible(i) && /write new variable/i.test(i.placeholder || ""); })[0];
    }
    // The row that holds the "add a key" controls (name + Type + Required + Add).
    function keyRow() {
      var inp = keyNameInput(); if (!inp) return null;
      var row = inp;
      for (var k = 0; k < 6 && row; k++) {
        row = row.parentElement;
        if (row && addCtlsIn(row).length) break;
      }
      return row;
    }
    // The Type control is a Radix combobox rendered as DIV[role=button] carrying
    // aria-expanded -- NOT an <input> holding its value, and not a <button>.
    // It starts EMPTY: the word "Type" on screen is a floating LABEL, not a
    // selection. The old finder looked for an input whose value was already one
    // of the type names, found nothing, and the "it's already String" branch
    // then set nothing -- so Add refused and no key was ever created.
    // Raj spotted this live on 2026-10-31: "Type was never selected".
    function keyTypeTrigger() {
      var row = keyRow(); if (!row) return null;
      return [].slice.call(row.querySelectorAll('[role="button"][aria-expanded]'))
        .filter(function (e) { return d.visible(e); })[0] || null;
    }
    function keyTypeValue() {
      var t = keyTypeTrigger();
      if (!t) return "";
      // LIVE DOM (2026-11-02): the chosen type lives in a read-only <input> inside
      // the trigger; the trigger's text is only the floating label "Type". Reading
      // textContent therefore always said "nothing chosen", so the type was picked
      // on screen but the code kept re-picking it and never pressed Add.
      var inp = t.querySelector("input");
      var v = inp ? d.norm(inp.value) : "";
      if (v) return v;
      v = d.norm(t.textContent).replace(/^Type\s*/, "");
      return v === "Type" ? "" : v;      // "Type" alone is the empty-state label
    }
    // Choose the type explicitly. Never assume a default.
    async function setKeyType(want) {
      want = want || "String";
      for (var a = 0; a < 3; a++) {
        if (d.norm(keyTypeValue()) === d.norm(want)) return true;
        var trig = keyTypeTrigger(); if (!trig) return false;
        d.pressSequence(trig);
        await sleep(450);
        var opt = [].slice.call(document.querySelectorAll('[role="option"],[role="menuitem"]'))
          .filter(function (o) { return d.visible(o) && d.norm(o.textContent) === d.norm(want); })[0];
        if (opt) { d.pressSequence(opt); await sleep(450); }
        else { await d.dismissMenu(keyRow()); }
      }
      return d.norm(keyTypeValue()) === d.norm(want);
    }
    // Dash2's list lags its own backend, so a freshly added key can be absent
    // from the rendered list for a moment. The form says "Key already added"
    // when the name exists server-side -- treat that as present, or the retry
    // loop re-adds the same key and the section reports it "missing".
    function keyAlreadyFlagged() {
      var row = keyRow();
      return !!row && /key already added/i.test(d.norm(row.textContent));
    }
    function requiredSwitch() {
      var inp = keyNameInput(); if (!inp) return null;
      var row = inp; for (var k = 0; k < 6 && row; k++) { row = row.parentElement; if (row && row.querySelector("[role='switch']")) break; }
      return row ? row.querySelector("[role='switch']") : null;
    }
    function addBtn() {
      var inp = keyNameInput(); if (!inp) return null;
      var row = inp; for (var k = 0; k < 6 && row; k++) { row = row.parentElement; if (row && addCtlsIn(row).length) break; }
      return addCtlsIn(row)[0] || null;
    }

    // 2-field source only: the analysis LLM ("Choose LLM Model" on this tab).
    // null/absent = the dashboard default -> leave the controls alone.
    var modelFailed = [];
    var wantModel = analysis.model && (analysis.model.provider || analysis.model.name)
      ? { provider: analysis.model.provider, model: analysis.model.name || analysis.model.model } : null;
    function analysisModelBox() { return modelPairBox(LLM_HEAD, [], 0); }
    if (wantModel) await setModelPair("Analysis LLM", analysisModelBox, wantModel, modelFailed);

    var keys = analysis.keys || [];
    var failedKeys = [], alreadyPresent = 0, createdNames = [];
    // Keys on the destination before this run (read from the key list only).
    var keysBefore = readDash2AnalysisKeyTypes(keys.map(function (x) { return x.name; }));
    var listBefore = listDash2AnalysisKeyNames();
    var doneKey = {};
    for (var i = 0; i < keys.length; i++) {
      if (d.isAuthRedirect()) return authStop("analysis");
      var k = keys[i];
      if (doneKey[k.name]) continue;          // the same key twice in the source
      doneKey[k.name] = true;
      // Already there: never re-add (the form refuses it anyway). Its type and
      // Required are read back below and reported -- never changed.
      if (keysBefore[k.name]) { alreadyPresent++; continue; }
      var r = await withRetry(async function () {
        var inp = keyNameInput(); if (!inp) return;
        d.setReactInput(inp, k.name);
        await sleep(200);
        // type (REQ-2): ALWAYS choose it. The control has no default selection,
        // and Add stays inert until a type is picked.
        var typeOk = await setKeyType(k.type || "String");
        if (!typeOk) return;
        // required toggle: match k.required (default switch is ON)
        var sw = requiredSwitch();
        if (sw) {
          var isOn = sw.getAttribute("aria-checked") === "true";
          var want = k.required !== false;
          if (isOn !== want) {
            d.pressSequence(sw);
            await sleep(150);
            var sw2 = requiredSwitch();
            if (sw2 && (sw2.getAttribute("aria-checked") === "true") !== want) d.clickEl(sw2);
          }
        }
        var nBefore = Object.keys(readDash2AnalysisKeyTypes([k.name])).length;
        await pressAdd(addBtn, function () {
          // it took when the key shows in the list, the form says it exists, or the name box cleared
          var inp2 = keyNameInput();
          return Object.keys(readDash2AnalysisKeyTypes([k.name])).length > nBefore || keyAlreadyFlagged() || !!(inp2 && !inp2.value);
        });
      }, function () {
        // verify the key now exists with the correct type (REQ-2). The rendered
        // list can lag the backend, so an "already added" notice counts too.
        var byName = readDash2AnalysisKeyTypes([k.name]);
        if (byName[k.name] && dom().norm(byName[k.name]) === dom().norm(k.type)) return true;
        return keyAlreadyFlagged();
      }, 3);
      if (r.auth) return authStop("analysis");
      if (!r.ok) failedKeys.push(k.name); else createdNames.push(k.name);
      await sleep(120);
    }
    // Save (section save sits with "Test Analysis"); never on the login bounce
    var keysBeforeSave = listDash2AnalysisKeyNames().length;
    if ((await saveAndConfirm(DASH2_TABS.analysis, warnings, { companion: "Test Analysis", re: /custom analysis saved|saved|updated/i, ms: 3500,
      changed: !!(createdNames.length || promptWant !== null) })) === "auth")
      return authStop("analysis");
    var aRejected = saveRejected(DASH2_TABS.analysis);

    // verify (REQ-2): re-read each key's type. After a save the page re-renders
    // from the server and the list can come back late, so a read right after
    // saving can still show nothing and report every key "missing". Re-read
    // for ~12 s until the list agrees.
    await sleep(400);
    var keyNames = keys.map(function (x) { return x.name; });
    var actualByName = readDash2AnalysisKeyTypes(keyNames);
    var kr = window.MagicPort.verifyKeyTypes(keys, actualByName);
    for (var vtry = 0; vtry < 24 && !kr.ok && !aRejected; vtry++) {
      await sleep(500);
      actualByName = readDash2AnalysisKeyTypes(keyNames);
      kr = window.MagicPort.verifyKeyTypes(keys, actualByName);
    }
    // The key list itself never came back (there were keys before the save,
    // none now): "couldn't confirm", not "not there".
    if (!kr.ok && !aRejected && keysBeforeSave && !listDash2AnalysisKeyNames().length) {
      pushOnce(warnings, "Couldn't confirm the " + DASH2_TABS.analysis + " keys: the list did not show after the save — check them by hand");
      kr = { ok: true, wrong: [] };
    }
    var failedAll = failedKeys.slice();
    if (aRejected) {
      failedAll.unshift(aRejected);
      createdNames = [];
    }
    // Required / Optional, read back for new AND existing keys. An existing
    // key is reported, never changed.
    var reqByName = readDash2AnalysisKeyRequired(keyNames);
    var seenReq = {};
    keys.forEach(function (x) {
      if (seenReq[x.name]) return; seenReq[x.name] = true;
      if (failedAll.indexOf(x.name) !== -1) return;
      var got = reqByName[x.name];
      if (got === undefined || got === null) return;          // not readable: nothing to compare
      var want = x.required !== false;
      if (got !== want) {
        failedAll.push(x.name + " (Required: want " + (want ? "Required" : "Optional") + ", got " + (got ? "Required" : "Optional") +
          (keysBefore[x.name] ? " — already on the destination, left as is" : "") + ")");
      }
    });
    if (!promptOk) failedAll.push("System Prompt (analysis)" + (promptWhy ? " — " + promptWhy : ""));
    // The System Prompt, read back once the save is done (the page re-renders
    // from the server's copy; a slow save used to wipe the pasted text unseen).
    if (promptWant !== null && !aRejected) {
      var gotP = null;
      for (var pt = 0; pt < 20; pt++) {
        var edNow = anEditor();
        gotP = edNow ? edLetters(edNow) : null;
        if (gotP === promptWant) break;
        await sleep(500);
      }
      if (gotP === null) pushOnce(warnings, "Couldn't confirm the " + DASH2_TABS.analysis + " System Prompt: its editor did not show after the save — check it by hand");
      else if (gotP !== promptWant) failedAll.push("System Prompt (analysis) — reads differently after the save" + (gotP ? "" : " (empty)"));
    }
    if (wantModel) {
      if (!modelFailed.length) verifyModelPair("Analysis LLM", analysisModelBox(), wantModel, modelFailed);
      failedAll = failedAll.concat(modelFailed);
    }
    var srcNames = keys.map(function (x) { return x.name; });
    var leftovers = listBefore.filter(function (n) { return srcNames.indexOf(n) === -1; }).map(function (n) { return "Analysis key: " + n; });
    return withWarnings({ section: "analysis", ok: kr.ok && !failedAll.length, wrong: kr.wrong, count: keys.length,
      created: createdNames.length, alreadyPresent: alreadyPresent, leftovers: leftovers, notes: aNotes, failedItems: failedAll }, warnings);
  }

  // name -> type from the rendered "name [Type] Required" rows. innerText is the
  // reliable source (name/type live in separate spans), so parse from it.
  // The analysis tab also holds the System Prompt editor, whose text can say
  // "disposition [String]" -- that is not a key. Read the key LIST only: skip
  // editors (.ProseMirror / .tiptap / contenteditable) and the add-a-key row.
  function analysisExcluded() {
    var d = dom();
    var ex = [].slice.call(document.querySelectorAll(".ProseMirror, .tiptap, [contenteditable='true'], [contenteditable='']"));
    [].slice.call(document.querySelectorAll("input")).forEach(function (i) {
      if (!/write new variable/i.test(i.placeholder || "")) return;
      var row = i;
      for (var k = 0; k < 6 && row; k++) { row = row.parentElement; if (row && addCtlsIn(row).length) break; }
      if (row && row !== document.body && !row.querySelector(".ProseMirror, .tiptap, [contenteditable='true']") &&
          !/\[(String\[\]|String|Number|Boolean)\]/.test(row.textContent || "")) ex.push(row);
    });
    return ex.filter(function (e) { return d.visible(e) || e.isConnected; });
  }
  function textOutside(root, ex) {
    if (!ex.some(function (e) { return root.contains(e); })) return root.innerText || root.textContent || "";
    var out = [];
    [].slice.call(root.childNodes).forEach(function (n) {
      if (n.nodeType === 3) { out.push(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      if (ex.some(function (e) { return e === n || e.contains(n); })) return;
      out.push(textOutside(n, ex));
    });
    return out.join("\n");
  }
  function readDash2AnalysisKeyTypes(names) {
    var main = document.querySelector("main") || document.body;
    var ex = analysisExcluded();
    var txt = textOutside(main, ex);
    var TY = "(String\\[\\]|String|Number|Boolean)";
    var out = {};
    // Generic pass (live-verified 2026-10-31): lower-case snake_case names.
    var re = /([a-z][a-z0-9_]{1,60})\s*\[(String\[\]|String|Number|Boolean)\]/g, m;
    while ((m = re.exec(txt))) { if (!out[m[1]]) out[m[1]] = m[2]; }
    // Exact pass for every key we are looking for, so names with capitals,
    // digits first, dots or dashes are read too -- and a name is never confused
    // with the tail of a longer one ("Q1_score" vs "score").
    (names || []).forEach(function (n) {
      var esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var hit = txt.match(new RegExp("(?:^|[^A-Za-z0-9_.\\-])" + esc + "\\s*\\[" + TY + "\\]")) ||
                // rows that show the type without brackets ("name\nString\nRequired")
                txt.match(new RegExp("(?:^|\\n)\\s*" + esc + "\\s*\\n\\s*[\\[(]?" + TY + "[\\])]?\\s*(?:\\n|$|Required|Optional)"));
      if (!hit) {
        // Fallback: an element whose own text starts with exactly this name.
        var rx = new RegExp("^" + esc + "\\s*(?:\\[" + TY + "\\]|\\(" + TY + "\\)|" + TY + "(?=\\s|Required|Optional|Remove|Delete|$))");
        var els = main.querySelectorAll("*");
        for (var i = 0; i < els.length && !hit; i++) {
          if (ex.some(function (e) { return e === els[i] || e.contains(els[i]); })) continue;
          var t = (els[i].textContent || "").replace(/\s+/g, " ").trim();
          if (t.indexOf(n) === 0) hit = t.match(rx);
        }
      }
      if (hit) out[n] = hit[1] || hit[2] || hit[3];
      else delete out[n];          // never trust a partial-name match for a key we asked about
    });
    return out;
  }
  // Every key name the key LIST shows (rows "name [Type] ..."), read per row
  // element so neighbouring rows' text never runs together.
  function listDash2AnalysisKeyNames() {
    var main = document.querySelector("main") || document.body;
    var ex = analysisExcluded(), out = [];
    var rx = /^([A-Za-z_][A-Za-z0-9_.\-]{0,80})\s*\[(String\[\]|String|Number|Boolean)\]/;
    [].slice.call(main.querySelectorAll("*")).forEach(function (el) {
      if (ex.some(function (e) { return e === el || e.contains(el); })) return;
      var m = (el.textContent || "").replace(/\s+/g, " ").trim().match(rx);
      if (!m) return;
      // the row itself, not a container of rows
      if ([].slice.call(el.children).some(function (c) { return rx.test((c.textContent || "").replace(/\s+/g, " ").trim()); })) return;
      if (out.indexOf(m[1]) === -1) out.push(m[1]);
    });
    return out;
  }
  // name -> true (Required) / false (Optional) from the key list, for the
  // names asked; a key whose row shows neither word is left out.
  function readDash2AnalysisKeyRequired(names) {
    var main = document.querySelector("main") || document.body;
    var ex = analysisExcluded();
    var txt = textOutside(main, ex);
    var TY = "[\\[(]?(?:String\\[\\]|String|Number|Boolean)[\\])]?";
    var out = {};
    (names || []).forEach(function (n) {
      var esc = String(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var m = txt.match(new RegExp("(?:^|[^A-Za-z0-9_.\\-])" + esc + "\\s*" + TY + "\\s*(Required|Optional)"));
      if (!m) {
        // a row element whose own text starts with exactly this key
        var rx = new RegExp("^" + esc + "\\s*" + TY + "\\s*(Required|Optional)");
        var els = main.querySelectorAll("*");
        for (var i = 0; i < els.length && !m; i++) {
          if (ex.some(function (e) { return e === els[i] || e.contains(els[i]); })) continue;
          var t = (els[i].textContent || "").replace(/\s+/g, " ").trim();
          if (t.indexOf(n) === 0) m = t.match(rx);
        }
      }
      if (m) out[n] = m[1] === "Required";
    });
    return out;
  }

  // ---- Post-call analysis on the new UI ---------------------------------------
  // section[aria-label="Post-call analysis editor"]: model (Provider/Model
  // comboboxes), the System Prompt editor, the key form (name lower-cased by the
  // app as you type; Type String/Number/Boolean/String[] and the Required switch
  // both KEEP their last value after Add) and ul[aria-label="Analysis keys"]
  // with a "Make optional: <key>" / "Make required: <key>" toggle per key.
  function v2AnalysisRoot() { return document.querySelector('section[aria-label="Post-call analysis editor"]'); }
  function v2Text(el) { return el ? String(el.textContent || "").replace(/\s+/g, "") : ""; }
  function readV2AnalysisKeys() {
    var out = {}, d = dom();
    var ul = (v2AnalysisRoot() || document).querySelector('ul[aria-label="Analysis keys"]');
    if (!ul) return out;
    [].slice.call(ul.children).forEach(function (li) {
      var rm = li.querySelector('button[aria-label^="Remove "]');
      var first = [].slice.call(li.children).filter(function (c) { return c.tagName === "SPAN" && !c.hasAttribute("title"); })[0];
      var name = first ? d.norm(first.textContent) : (rm ? d.norm(rm.getAttribute("aria-label").replace(/^Remove\s+/, "")) : "");
      if (!name) return;
      var ty = li.querySelector("span[title]");
      var tg = li.querySelector('button[aria-label^="Make "]');
      var req = null;
      if (tg) req = /^Make optional:/i.test(tg.getAttribute("aria-label") || "");
      else if (/\bRequired\b/.test(li.textContent || "")) req = true;
      else if (/\bOptional\b/.test(li.textContent || "")) req = false;
      out[name] = { type: ty ? d.norm(ty.getAttribute("title")) : "", required: req, toggle: tg || null, removeBtn: rm || null };
    });
    return out;
  }
  function v2KeyForm() {
    var d = dom(), root = v2AnalysisRoot() || document;
    var inp = root.querySelector('input[placeholder="e.g. dispute_reason"]');
    if (!inp) {
      var lab = [].slice.call(root.querySelectorAll("label[for]")).filter(function (l) { return d.norm(l.textContent).toLowerCase() === "key name"; })[0];
      inp = lab ? document.getElementById(lab.getAttribute("for")) : null;
    }
    if (!inp) return null;
    var row = inp;
    for (var k = 0; k < 6 && row; k++) {
      row = row.parentElement;
      if (row && row.querySelector('button[role="combobox"]') && addCtlsIn(row).length) break;
    }
    if (!row) return null;
    var help = v2DescribedText(inp) + " " + d.norm(row.textContent);
    return { input: inp, row: row, type: d.v2Combo(row, "Type") || row.querySelector('button[role="combobox"]'),
      req: d.v2Switch(row, "Required") || row.querySelector('[role="switch"]'), add: addCtlsIn(row)[0] || null,
      flagged: /key already added|already exists/i.test(help) };
  }
  // ---- provider + model pairs (Models section, Post-call analysis model) ----
  // Read a dropdown's options without choosing: { texts[], selected: index of
  // the current option or -1 }. A list that loads late is read again.
  async function v2ListOptions(getBtn) {
    var d = dom(), texts = [], selected = -1;
    for (var a = 0; a < 4; a++) {
      var b = getBtn();
      if (b && (b.disabled || b.getAttribute("aria-disabled") === "true" || b.getAttribute("aria-busy") === "true")) { await sleep(800); continue; }
      texts = []; selected = -1;
      var r = await d.v2PickCombo(getBtn, function (t, li) {
        if (li && li.getAttribute("aria-selected") === "true") selected = texts.length;
        texts.push(t); return false;
      }, { force: true });
      if (!texts.length && r.offered) texts = r.offered.slice();
      if (texts.length) break;
      await sleep(1000);
    }
    return { texts: texts, selected: selected };
  }
  // After a provider pick: wait until the Model box shows the new provider's
  // list (its value changes or clears, it is enabled and not busy).
  async function v2WaitModelList(gm, before) {
    var d = dom();
    for (var i = 0; i < 8; i++) { if (!d.v2ComboValue(gm()) || d.v2ComboValue(gm()) !== before) break; await sleep(200); }
    for (var j = 0; j < 75; j++) {
      var m = gm();
      if (m && !m.disabled && m.getAttribute("aria-disabled") !== "true" && m.getAttribute("aria-busy") !== "true") break;
      await sleep(200);
    }
    await sleep(600);   // provider-models?provider_id= fetch
  }
  // Set provider + model. Several providers can share a name: the one whose
  // list offers the model is used. When none does, the original provider and
  // model are put back; returns { abandon: true } when even that fails (the
  // caller must then not save — a provider with an empty model would be stored).
  async function v2SetModelPair(gp, gm, want, failed, notes, who) {
    var d = dom();
    var P = d.norm(want.provider || ""), M = d.norm(want.model || "");
    var curP = d.v2ComboValue(gp()), curM = d.v2ComboValue(gm());
    if ((!P || lc(curP) === lc(P)) && (!M || lc(curM) === lc(M))) return {};   // already so
    if (!P) {
      var ml0 = await v2ListOptions(gm);
      if (!ml0.texts.some(function (t) { return lc(t) === lc(M); })) {
        failed.push(who + " model → " + M + " (not offered for " + (curP || "this provider") + (ml0.texts.length ? "; it offers: " + dedupe(ml0.texts).slice(0, 12).join(", ") : "") + ")");
        return {};
      }
      var rm = await d.v2PickCombo(gm, M, { force: true });
      if (!rm.ok) failed.push(who + " model → " + M + " (not set; shows '" + (d.v2ComboValue(gm()) || "empty") + "')");
      return {};
    }
    var pl = await v2ListOptions(gp);
    var same = [];
    pl.texts.forEach(function (t, i) { if (lc(t) === lc(P)) same.push(i); });
    if (!same.length) {
      failed.push(who + " provider → " + P + " (not offered" + (pl.texts.length ? "; it offers: " + dedupe(pl.texts).join(", ") : "") + ")");
      return {};
    }
    var origK = same.indexOf(pl.selected);          // the current provider among the same-named ones, or -1
    if (origK === -1 && pl.selected === -1 && same.length === 1 && lc(curP) === lc(P)) origK = 0;
    var origM = curM, curK = origK;
    var nameMatch = function (t) { return lc(t) === lc(P); };
    async function pickProv(k) {
      if (k === curK) return true;
      var before = d.v2ComboValue(gm());
      var r = await d.v2PickCombo(gp, nameMatch, { force: true, index: k });
      if (!r.ok) return false;
      curK = k; await v2WaitModelList(gm, before);
      return true;
    }
    // Put the provider (by its position in the list, or its name) and model back.
    async function restore() {
      if (curK === origK && (!origM || lc(d.v2ComboValue(gm())) === lc(origM))) return true;
      var before = d.v2ComboValue(gm());
      var r = pl.selected !== -1
        ? await d.v2PickCombo(gp, function (t, li) {
            var lb = li && li.closest ? li.closest('[role="listbox"]') : null;
            return !!lb && [].indexOf.call(lb.querySelectorAll('[role="option"]'), li) === pl.selected;
          }, { force: true })
        : (curP ? await d.v2PickCombo(gp, curP, { force: true }) : { ok: false });
      if (!r.ok || lc(d.v2ComboValue(gp())) !== lc(curP)) return false;
      curK = origK;
      await v2WaitModelList(gm, before);
      if (origM && lc(d.v2ComboValue(gm())) !== lc(origM)) await d.v2PickCombo(gm, origM, { force: true });
      return !origM || lc(d.v2ComboValue(gm())) === lc(origM);
    }
    var order = [];
    if (origK !== -1) order.push(origK);
    same.forEach(function (_, k) { if (k !== origK) order.push(k); });
    if (!M) {
      if (!(await pickProv(order[0]))) failed.push(who + " provider → " + P + " (did not take)");
      else if (same.length > 1) notes.push(who + ": " + same.length + " providers are named '" + P + "' on this dashboard — the source names no model, so " + (origK !== -1 ? "the current one was kept" : "the first was picked") + "; check it by hand.");
      return {};
    }
    var chosen = -1, offeredBy = [];
    for (var oi = 0; oi < order.length && chosen === -1; oi++) {
      var k = order[oi];
      if (!(await pickProv(k))) continue;
      var ml = await v2ListOptions(gm);
      offeredBy.push(ml.texts);
      if (ml.texts.some(function (t) { return lc(t) === lc(M); })) chosen = k;
    }
    if (chosen === -1) {
      var off = dedupe([].concat.apply([], offeredBy));
      failed.push(who + " model → " + M + " (not offered by " + (same.length > 1 ? "any of the " + same.length + " providers named " : "") + P +
        (off.length ? "; it offers: " + off.slice(0, 12).join(", ") : "") + ")");
      // put the destination back as it was (a cleared model would be saved)
      if (!(await restore())) {
        failed.push(who + ": the previous provider/model could not be put back — not saved; check it by hand");
        return { abandon: true };
      }
      return {};
    }
    var r2 = await d.v2PickCombo(gm, M, { force: true });
    if (!r2.ok) {
      failed.push(who + " model → " + M + " (not set; shows '" + (d.v2ComboValue(gm()) || "empty") + "')");
      if (!(await restore())) { failed.push(who + ": the previous provider/model could not be put back — not saved; check it by hand"); return { abandon: true }; }
      return {};
    }
    if (same.length > 1)
      notes.push(who + ": " + same.length + " providers are named '" + P + "' on this dashboard — used the " + (chosen === origK ? "current one" : "one listed #" + (same[chosen] + 1)) + ", whose models include '" + M + "'.");
    return {};
  }
  async function v2SetAnalysisModel(provBtn, modelBtn, want, failed, notes) {
    return v2SetModelPair(provBtn, modelBtn, want, failed, notes || [], "Analysis LLM");
  }
  async function dash2AnalysisV2(analysis, ctx) {
    var d = dom(), LABEL = DASH2_TABS.analysis;
    ctx = ctx || {}; analysis = analysis || { prompt: "", keys: [] };
    if (!(await gotoTab(LABEL))) return tabFail("analysis", LABEL);
    if (d.isAuthRedirect()) return authStop("analysis");
    var failed = [], warnings = [], notes = [], renamed = [];
    function promptEd() { var r = v2AnalysisRoot(); return r ? r.querySelector(".ProseMirror, .tiptap, [contenteditable='true']") : null; }
    function provBtn() { return d.v2Combo(v2AnalysisRoot(), "Provider"); }
    function modelBtn() { return d.v2Combo(v2AnalysisRoot(), "Model"); }

    // 1. System Prompt (an empty source never clears it: the server ignores "")
    var promptWant = null, promptWhy = "";
    if (analysis.prompt) {
      if (typeof ctx.pasteTipTap !== "function") promptWhy = "no prompt writer hook";
      else if (!promptEd()) promptWhy = "editor not found";
      else {
        var pOk = false;
        for (var pa = 1; pa <= 3 && !pOk; pa++) {
          try { pOk = await ctx.pasteTipTap(promptEd(), analysis.prompt); } catch (e) { pOk = false; }
          if (!pOk) await sleep(250);
        }
        if (pOk) promptWant = v2Text(promptEd()); else promptWhy = "paste failed";
      }
    }
    if (promptWhy) failed.push("System Prompt (analysis) — " + promptWhy);

    // 2. Model (2-field source only). null = the dashboard default, which this
    // dashboard can't go back to once a model is set: say so, change nothing.
    var modelFailed = [];
    var wantModel = analysis.model && (analysis.model.provider || analysis.model.name || analysis.model.model)
      ? { provider: analysis.model.provider, model: analysis.model.name || analysis.model.model } : null;
    var modelPair = {};
    if (wantModel) modelPair = await v2SetAnalysisModel(provBtn, modelBtn, wantModel, modelFailed, notes);
    else if (analysis.model === null) {
      var curM = d.v2ComboValue(modelBtn());
      if (curM) notes.push("Post-call analysis model: the source uses the dashboard default, but this bot already has " +
        (d.v2ComboValue(provBtn()) ? d.v2ComboValue(provBtn()) + " / " : "") + curM + " — the model can't be reset to the default on this dashboard; left as is.");
    }

    // 3. Keys
    var keys = analysis.keys || [];
    var before = readV2AnalysisKeys();
    var srcBy = {}, wantBy = {}, added = [], toggled = [], alreadyPresent = 0;
    for (var i = 0; i < keys.length; i++) {
      if (d.isAuthRedirect()) return authStop("analysis");
      var k = keys[i];
      var wantType = k.type || "String", wantReq = k.required !== false;
      var f = v2KeyForm();
      if (!f) { failed.push(k.name + " (the key form was not found)"); continue; }
      d.setReactInput(f.input, k.name);
      await sleep(150);
      var f0 = v2KeyForm();
      var key = (f0 && f0.input.value) || String(k.name).toLowerCase();   // the app lower-cases as you type
      if (srcBy[key]) {
        notes.push("Analysis keys '" + srcBy[key] + "' and '" + k.name + "' are the same key ('" + key + "') on this dashboard — one key.");
        if (wantBy[key].type !== wantType || wantBy[key].required !== wantReq)
          failed.push(k.name + " (clashes with '" + srcBy[key] + "': both are '" + key + "' here, with a different type or Required)");
        if (f0) d.setReactInput(f0.input, "");
        continue;
      }
      if (key !== k.name) renamed.push({ from: k.name, to: key });
      srcBy[key] = k.name; wantBy[key] = { type: wantType, required: wantReq };
      var cur = readV2AnalysisKeys()[key];
      if (cur) {
        // Already there: never re-added. Required can be toggled in place now;
        // the type can't (that would need a remove + re-add) -- reported below.
        alreadyPresent++;
        if (f0) d.setReactInput(f0.input, "");
        if (cur.required !== null && cur.required !== wantReq && cur.toggle) {
          d.clickEl(cur.toggle);
          await d.waitFor(function () { var c = readV2AnalysisKeys()[key]; return !!c && c.required === wantReq; }, 2000, 150);
          var c2 = readV2AnalysisKeys()[key];
          if (c2 && c2.required === wantReq) toggled.push(key);
          else failed.push(key + " (Required: could not switch to " + (wantReq ? "Required" : "Optional") + " — already on the destination)");
        }
        continue;
      }
      var why = "";
      for (var a = 0; a < 3; a++) {
        if (d.isAuthRedirect()) return authStop("analysis");
        var fa = v2KeyForm(); if (!fa) { why = "the key form was not found"; break; }
        if (fa.input.value !== key) { d.setReactInput(fa.input, k.name); await sleep(150); }
        // Type and Required keep the previous Add's values: set BOTH every time.
        var tr = await d.v2PickCombo(function () { var x = v2KeyForm(); return x && x.type; }, wantType);
        if (!tr.ok) { why = "Type " + wantType + " could not be chosen (" + (tr.why || "") + (tr.offered && tr.offered.length ? "; offered: " + tr.offered.join(", ") : "") + ")"; continue; }
        var fr = v2KeyForm();
        if (!fr || !fr.req) { why = "the Required switch was not found"; continue; }
        await d.v2SetSwitch(fr.req, wantReq);
        var fr2 = v2KeyForm();
        if (!fr2 || !fr2.req || (fr2.req.getAttribute("aria-checked") === "true") !== wantReq) { why = "the Required switch did not take"; continue; }
        await pressAdd(function () { var x = v2KeyForm(); return x && x.add; }, function () {
          var x = v2KeyForm(); return !!readV2AnalysisKeys()[key] || !!(x && x.flagged) || !!(x && !x.input.value);
        });
        await d.waitFor(function () { return !!readV2AnalysisKeys()[key]; }, 2000, 150);
        var row = readV2AnalysisKeys()[key];
        if (row && row.type === wantType) {
          if (row.required !== null && row.required !== wantReq && row.toggle) {
            d.clickEl(row.toggle);
            await d.waitFor(function () { var c = readV2AnalysisKeys()[key]; return !!c && c.required === wantReq; }, 2000, 150);
          }
          added.push(key); why = ""; break;
        }
        if (row) {
          why = "added as " + (row.type || "?") + " instead of " + wantType;
          if (row.removeBtn) { d.clickEl(row.removeBtn); await d.waitFor(function () { return !readV2AnalysisKeys()[key]; }, 2000, 150); }
          if (readV2AnalysisKeys()[key]) break;
          continue;
        }
        var fb = v2KeyForm();
        if (fb && fb.flagged) { why = "the dashboard refused it (Key already added)"; d.setReactInput(fb.input, ""); break; }
        why = "Add did not take";
      }
      if (why) failed.push(k.name + (key !== k.name ? " (as " + key + ")" : "") + " — " + why);
      await sleep(120);
    }

    if (d.isAuthRedirect()) return authStop("analysis");
    // The model couldn't be put back: saving would store a provider without
    // its model. Throw away this section's changes instead (all this run's).
    var sv = (modelPair && modelPair.abandon && (await v2Discard()))
      ? { state: "discarded", text: "Not saved: the analysis model couldn't be put back, so this section's changes were discarded" }
      : await saveV2(LABEL, warnings);
    if (d.isAuthRedirect()) return authStop("analysis");
    if (renamed.length) notes.push("Analysis key names are lower case on this dashboard: " +
      renamed.map(function (r) { return r.from + " → " + r.to; }).join(", ") + ".");
    var notSaved = sv.state === "failed" || sv.state === "blocked" || sv.state === "discarded" || (sv.state === "unconfirmed" && !!d.v2SaveBar());
    if (notSaved) {
      var head = (sv.state === "unconfirmed") ? "The Save didn't finish — the Post-call analysis changes are still unsaved on the page" : sv.state === "discarded" ? sv.text : v2Reject(sv.text);
      var lines = added.map(function (x) { return x + " (added on the page, but NOT saved)"; })
        .concat(toggled.map(function (x) { return x + " (Required changed on the page, but NOT saved)"; }));
      if (promptWant !== null) lines.push("System Prompt (analysis) (written on the page, but NOT saved)");
      if (wantModel && !modelFailed.length) lines.push("Analysis LLM " + [wantModel.provider, wantModel.model].filter(hasVal).join(" / ") + " (chosen on the page, but NOT saved)");
      return withWarnings({ section: "analysis", ok: false, reason: head, saved: sv.state, wrong: [], count: keys.length,
        created: 0, alreadyPresent: alreadyPresent, requiredChanged: [], renamed: renamed, leftovers: [], notes: notes,
        failedItems: [head].concat(lines, failed, modelFailed) }, warnings);
    }

    // Read back after the Save: the section re-renders from the server's copy.
    var want = Object.keys(srcBy);
    var rbA = await v2ReadBack(LABEL, function () { return !!v2AnalysisRoot(); }, readV2AnalysisKeys,
      function (m) { return want.filter(function (x) { return !m[x]; }); }, 10000);
    var after = rbA.got || {};
    var blindA = !rbA.open || (!Object.keys(after).length && want.length > 0);
    var wrong = [];
    want.forEach(function (x) {
      var src = srcBy[x], lab = src + (x !== src ? " (as " + x + ")" : ""), got = after[x];
      if (failed.some(function (l) { return l.indexOf(src + " ") === 0; })) return;
      var wasThere = !!before[x];
      if (!got && blindA) {
        if (sv.state === "saved") pushOnce(warnings, "Post-call analysis: couldn't confirm " + lab + " after the save (the list didn't show in time) — check it by hand");
        else { wrong.push({ name: src, reason: "unconfirmed" }); failed.push(lab + " — couldn't confirm it after the save (the list didn't show) — check it by hand"); }
        return;
      }
      if (!got) { wrong.push({ name: src, reason: "missing" }); failed.push(lab + " — not on the dashboard after the save"); return; }
      if (got.type !== wantBy[x].type) {
        wrong.push({ name: src, want: wantBy[x].type, got: got.type });
        failed.push(lab + " (type: want " + wantBy[x].type + ", got " + (got.type || "?") + (wasThere ? " — already on the destination; a key's type can't be changed in place" : "") + ")");
      }
      if (got.required !== null && got.required !== wantBy[x].required)
        failed.push(lab + " (Required: want " + (wantBy[x].required ? "Required" : "Optional") + ", got " + (got.required ? "Required" : "Optional") + ")");
    });
    if (promptWant !== null && v2Text(promptEd()) !== promptWant) failed.push("System Prompt (analysis) — reads differently after the save");
    if (wantModel && !modelFailed.length) {
      var gp = d.v2ComboValue(provBtn()), gm = d.v2ComboValue(modelBtn());
      if (hasVal(wantModel.provider) && lc(gp) !== lc(wantModel.provider)) modelFailed.push("Analysis LLM provider: want " + wantModel.provider + ", reads '" + (gp || "empty") + "' after save");
      if (hasVal(wantModel.model) && lc(gm) !== lc(wantModel.model)) modelFailed.push("Analysis LLM model: want " + wantModel.model + ", reads '" + (gm || "empty") + "' after save");
    }
    failed = failed.concat(modelFailed);
    var created = added.filter(function (x) { return after[x] && after[x].type === wantBy[x].type && !before[x]; }).length;
    var reqChanged = toggled.filter(function (x) { return after[x] && after[x].required === wantBy[x].required; });
    if (reqChanged.length) notes.push("Required/Optional changed on key(s) already on the destination: " + reqChanged.join(", ") + ".");
    var leftovers = Object.keys(after).filter(function (x) { return want.indexOf(x) === -1; }).map(function (x) { return "Analysis key: " + x; });
    return withWarnings({ section: "analysis", ok: !failed.length, saved: sv.state, wrong: wrong, count: keys.length,
      created: created, alreadyPresent: alreadyPresent, requiredChanged: reqChanged, renamed: renamed,
      leftovers: leftovers, notes: notes, failedItems: failed }, warnings);
  }

  // ---- 6. Event Subscription ---------------------------------------------
  // exact: true for a 2-field source -- each webhook gets EXACTLY its own events
  // (not "always all 3"). An existing row with a different set is reported,
  // never edited or deleted.
  async function dash2Events(events, exact) {
    var d = dom();
    if (d.isAuthRedirect()) return authStop("events");
    events = events || [];
    // A source with no webhooks is a no-op: don't navigate (and don't fail on a
    // tab we never needed), and don't report other people's rows as "created".
    if (!events.length) {
      return { section: "events", ok: true, created: 0, expected: 0, alreadyPresent: 0, failedItems: [] };
    }
    // New 2-field UI (sidebar "Webhooks", ?section=event-subscription): rows are
    // ul[aria-label="Subscriptions"] > li with the URL in span[title^=http]; the
    // Create dialog has input[type=url] + three Radix checkboxes (verified live 2026-11-05).
    var NEW = !!(d.v2IsNewUi && d.v2IsNewUi());
    function hooksSec() { return document.querySelector('section[aria-label="Webhooks editor"]'); }
    if (NEW) {
      if (!(await d.v2GotoSection(d.V2_SECTIONS.events, function () { return !!hooksSec(); })))
        return fail("events", "the 'Webhooks' section could not be opened" + (d.v2GotoSection.lastWhy ? " — " + d.v2GotoSection.lastWhy : ""));
      // the list GET lands after the section mounts: rows, or the empty state.
      // Until it has, nothing is created (a slow list would read "not there"
      // and make a duplicate).
      var hooksLoaded = function () {
        var sec = hooksSec();
        return !!document.querySelector('ul[aria-label="Subscriptions"] > li') || d.buttonsByText("Create subscription").length > 1 ||
          (!!sec && /no subscriptions|no webhooks/i.test(sec.textContent || ""));
      };
      await d.waitFor(hooksLoaded, 15000, 250);
      if (!hooksLoaded()) {
        await untilVisible();
        await d.waitFor(hooksLoaded, 5000, 250);
      }
      if (!hooksLoaded())
        return { section: "events", ok: false, reason: "the webhook list didn't load — nothing was created, to avoid a duplicate",
          created: 0, alreadyPresent: 0, expected: events.length, leftovers: [],
          failedItems: events.map(function (e) { return e.url + " (not created — the webhook list didn't load; check Webhooks by hand)"; }) };
    } else if (!(await gotoTab(DASH2_TABS.events)))
      return tabFail("events", DASH2_TABS.events);
    if (d.isAuthRedirect()) return authStop("events");
    var DASH2_EVENT_ORDER = ["Transcript ready", "Recording ready", "Analysis completed"];
    function v2Rows() {
      return [].slice.call(document.querySelectorAll('ul[aria-label="Subscriptions"] > li')).map(function (li) {
        var u = li.querySelector('span[title^="http"]');
        return {
          url: u ? d.norm(u.getAttribute("title")) : "",
          events: [].slice.call(li.querySelectorAll("span[title]")).map(function (s) { return d.norm(s.getAttribute("title")); })
            .filter(function (t) { return !/^https?:/i.test(t); })
        };
      });
    }
    function v2HookDialog() {
      return [].slice.call(document.querySelectorAll("[role='dialog']"))
        .filter(function (x) { return d.visible(x) && !!x.querySelector("input[type='url']"); })[0] || null;
    }
    function v2SonnerToasts() { return [].slice.call(document.querySelectorAll("[data-sonner-toast]")); }
    async function v2CancelHookDialog() {
      var dlg = v2HookDialog(); if (!dlg) return true;
      var c = [].slice.call(dlg.querySelectorAll("button")).filter(function (b) { return d.norm(b.textContent) === "Cancel"; })[0]
        || dlg.querySelector("button[aria-label='Close']");
      if (c) d.clickEl(c);
      await d.waitFor(function () { return !v2HookDialog(); }, 2000, 150);
      if (v2HookDialog() && c) { d.pressSequence(c); await d.waitFor(function () { return !v2HookDialog(); }, 1500, 150); }
      return !v2HookDialog();
    }
    function v2EventBox(dlg, label) {
      var l = [].slice.call(dlg.querySelectorAll("label[for]")).filter(function (x) { return d.norm(x.textContent) === label; })[0];
      return l ? document.getElementById(l.getAttribute("for")) : null;
    }
    function v2Checked(cb) { return !!cb && (cb.getAttribute("aria-checked") === "true" || cb.getAttribute("data-state") === "checked"); }

    // Each existing subscription exposes its URL in the delete button's
    // aria-label ("Delete subscription <url>"), so we can identify rows by URL
    // instead of just counting them. Verified live 2026-10-31.
    function subButtons() {
      return [].slice.call(document.querySelectorAll("button[aria-label^='Delete subscription']"));
    }
    function urlOf(btn) {
      return d.norm(btn.getAttribute("aria-label")).replace(/^Delete subscription\s*/i, "");
    }
    function subUrls() { return NEW ? v2Rows().map(function (r) { return r.url; }) : subButtons().map(urlOf); }
    function countFor(url) {
      var want = d.norm(url);
      return subUrls().filter(function (u) { return u === want; }).length;
    }
    function rowFor(url) {
      var want = d.norm(url);
      var btn = subButtons().filter(function (b) { return urlOf(b) === want; })[0];
      if (!btn) return null;
      var row = btn;
      for (var k = 0; k < 6 && row; k++) {
        row = row.parentElement;
        if (row && /https?:\/\//.test(row.innerText || "")) return row;
      }
      return null;
    }
    // Which events a subscription row actually lists.
    function eventsFor(url) {
      if (NEW) {
        var r2 = v2Rows().filter(function (x) { return x.url === d.norm(url); })[0];
        return r2 ? DASH2_EVENT_ORDER.filter(function (e) { return r2.events.indexOf(e) !== -1; }) : [];
      }
      var row = rowFor(url); if (!row) return [];
      var t = d.norm(row.innerText);
      return DASH2_EVENT_ORDER.filter(function (e) { return t.indexOf(e) !== -1; });
    }

    var failedHooks = [], createdCount = 0, alreadyPresent = 0, pendingHooks = [], notes = [];
    var SUB_NOT_LISTED = "submitted, not listed — check by hand (not re-sent, to avoid a duplicate)";
    var urlsBefore = subUrls();
    // rows per URL before the run: a duplicate the destination already had is
    // reported as such, never as one this run made
    function countBefore(url) { var w0 = d.norm(url); return urlsBefore.filter(function (u) { return u === w0; }).length; }
    for (var i = 0; i < events.length; i++) {
      if (d.isAuthRedirect()) return authStop("events");
      var w = events[i];
      var want = (w.events && w.events.length) ? w.events : DASH2_EVENT_ORDER.slice();
      if (exact) {
        want = DASH2_EVENT_ORDER.filter(function (e) { return (w.events || []).indexOf(e) !== -1; });
        var unknown = (w.events || []).filter(function (e) { return DASH2_EVENT_ORDER.indexOf(e) === -1; });
        if (unknown.length) { failedHooks.push(w.url + " (unknown event(s): " + unknown.join(", ") + " — not created)"); continue; }
        if (!want.length) { failedHooks.push(w.url + " (no events in the source — not created)"); continue; }
      }
      function eventsMatch() {
        var got = eventsFor(w.url);
        // non-exact (5-field source): the row must carry every wanted event
        // (a superset is fine) -- comparing COUNTS let a different event pass.
        return exact ? (got.length === want.length && want.every(function (e) { return got.indexOf(e) !== -1; }))
                     : want.every(function (e) { return got.indexOf(e) !== -1; });
      }

      // Idempotent: if this URL is already subscribed with the right events,
      // leave it alone. Previously every retry created another copy.
      if (countFor(w.url) > 0 && eventsMatch()) { alreadyPresent++; continue; }
      if (countFor(w.url) > 0) {
        failedHooks.push(w.url + " (already subscribed with " + (eventsFor(w.url).join(", ") || "no events") +
          " — expected " + (exact ? "exactly " : "") + want.join(", ") + "; left as is)");
        continue;
      }

      var submitted = false;   // a Create was already sent for THIS url in this run
      var refusedWhy = "";     // new UI: the dashboard refused THIS url (not retried)
      var r = await withRetry(async function () {
        // A sent Create whose row hasn't rendered yet must be WAITED for, never
        // re-sent: re-sending made the first webhook twice in the live run of
        // 2026-11-03 (rows 9 s apart).
        // Once a Create was sent it is NEVER sent again, whatever the list shows.
        if (submitted) { await d.waitFor(function () { return countFor(w.url) >= 1; }, 10000, 250); return; }
        if (refusedWhy) return;
        // Never create a second row for a URL that now exists — this is what
        // turned 1 webhook into 3 identical ones in the live run. Re-read once
        // after a short settle: on a retry the row may have been created by the
        // previous attempt and simply not rendered yet.
        if (countFor(w.url) > 0) return;
        await sleep(400);
        if (countFor(w.url) > 0) return;
        if (NEW) {
          // New UI: "Create subscription" -> dialog (Webhook URL + 3 event checkboxes) -> Create.
          if (!(await v2CancelHookDialog())) return;
          var openBtn = d.buttonsByText("Create subscription")[0];
          if (!openBtn) return;
          d.clickEl(openBtn);
          await d.waitFor(function () { return !!v2HookDialog(); }, 3000, 150);
          var hd = v2HookDialog();
          if (!hd) { d.pressSequence(openBtn); await d.waitFor(function () { return !!v2HookDialog(); }, 2000, 150); hd = v2HookDialog(); }
          if (!hd) return;
          var uIn = hd.querySelector("input[type='url']");
          d.setReactInput(uIn, w.url);
          await sleep(150);
          if (d.norm(uIn.value) !== d.norm(w.url)) { d.setReactInput(uIn, w.url); await sleep(200); }
          for (var ei = 0; ei < DASH2_EVENT_ORDER.length; ei++) {
            var evLabel = DASH2_EVENT_ORDER[ei], wantOn = want.indexOf(evLabel) !== -1;
            for (var ea = 0; ea < 3; ea++) {
              var cb = v2EventBox(hd, evLabel);
              if (!cb || v2Checked(cb) === wantOn) break;
              if (ea === 0) d.clickEl(cb); else d.pressSequence(cb);
              await sleep(200);
            }
          }
          var boxesOk = DASH2_EVENT_ORDER.every(function (e) { var c = v2EventBox(hd, e); return !!c && v2Checked(c) === (want.indexOf(e) !== -1); });
          if (!boxesOk || d.norm(uIn.value) !== d.norm(w.url)) {
            // Don't create a half-configured hook: back out and let the retry run.
            await v2CancelHookDialog();
            return;
          }
          var createBtn = [].slice.call(hd.querySelectorAll("button[type='submit']")).filter(function (b) { return d.norm(b.textContent) === "Create"; })[0]
            || [].slice.call(hd.querySelectorAll("button")).filter(function (b) { return d.norm(b.textContent) === "Create"; })[0];
          if (!createBtn) { await v2CancelHookDialog(); return; }
          var toastsBefore = v2SonnerToasts(), seenToasts = [], okToast = false, closed = false, firstOther = 0;
          d.clickEl(createBtn);
          submitted = true;
          for (var tw = 0; tw < 50; tw++) {
            await sleep(200);
            v2SonnerToasts().forEach(function (t) {
              if (toastsBefore.indexOf(t) !== -1) return;
              var tx = d.norm(t.textContent); if (tx && seenToasts.indexOf(tx) === -1) seenToasts.push(tx);
            });
            okToast = seenToasts.some(function (t) { return /subscription created/i.test(t); });
            closed = !v2HookDialog();
            if (okToast || closed) break;
            if (seenToasts.length && !firstOther) firstOther = tw;
            if (firstOther && tw - firstOther >= 5) break;   // an error toast and the dialog stays open
          }
          if (!okToast && !closed) {
            // Refused: the dialog is still open. Say why (a server toast, or the
            // dialog's own validation line) and never re-send it.
            var inline = [].slice.call(hd.querySelectorAll("p,span,div")).filter(function (e) {
              return !e.children.length && d.visible(e) && /select at least one event|valid http|required|invalid/i.test(e.textContent || "");
            }).map(function (e) { return d.norm(e.textContent); });
            var whyNow = seenToasts.concat(inline).filter(function (v, ix, a) { return a.indexOf(v) === ix; }).slice(0, 2).join("; ");
            submitted = false;
            refusedWhy = whyNow || "no confirmation and the Create dialog stayed open";
            await v2CancelHookDialog();
            return;
          }
          // The list refreshes at once on the new UI; wait for the row.
          await d.waitFor(function () { return countFor(w.url) >= 1; }, 6000, 250);
          await sleep(300);
          return;
        }
        if ([].slice.call(document.querySelectorAll("button")).some(function (b) { return d.visible(b) && d.norm(b.textContent) === "Cancel"; })) {
          d.clickButtonByText("Cancel"); await sleep(300);
        }
        if (!d.clickButtonByText("Create Subscription")) return;
        await sleep(800);
        // Scope to the dialog. Hunting the whole document for "the first empty
        // visible text input" is fine with one subscription on screen and a
        // coin-flip with ten: any filter/search box rendered above the dialog
        // would swallow the URL. Same for the events combobox.
        var dlg = document.querySelector("[role='dialog']") || document;
        var urlInp = [].slice.call(dlg.querySelectorAll("input"))
          .filter(function (x) { return d.visible(x) && x.type === "text" && !(x.value || "").trim(); })[0];
        if (!urlInp) return;
        d.setReactInput(urlInp, w.url);
        var combo = [].slice.call(dlg.querySelectorAll("[role='combobox']")).filter(function (c) { return d.visible(c); })[0];
        var picked = await d.selectMenuByClick(combo, want.slice());
        if (picked.selected.length !== want.length) {
          // Don't create a half-configured hook: back out and let the retry run.
          d.clickButtonByText("Cancel");
          await sleep(300);
          return;
        }
        var subSnap = d.toastSnapshot();
        submitted = !!d.clickButtonByText("Create");
        var subRes = submitted ? await d.waitToastResult(/subscription created|created|saved/i, 3500, subSnap) : { state: "none", text: "" };
        if (subRes.state === "fail") {
          // Refused (an error toast; the dialog usually stays open): say why,
          // close the dialog, and never re-send it.
          submitted = false;
          refusedWhy = subRes.text;
          var dlgLeft = document.querySelector("[role='dialog']");
          if (dlgLeft && d.visible(dlgLeft) && [].slice.call(dlgLeft.querySelectorAll("button")).some(function (b) { return d.norm(b.textContent) === "Cancel"; })) {
            d.clickButtonByText("Cancel"); await sleep(300);
          }
          return;
        }
        // WAIT for the row to actually appear before letting the attempt end.
        // The list lags its own backend, and it lags MORE as rows accumulate.
        // Without this the verify below read a stale list, reported "not
        // created", and the retry made a SECOND row for a URL that was already
        // subscribed. Reproduced live 2026-10-31: hooks a/b/c landed, the 4th
        // came out as "duplicate subscription x2".
        await d.waitFor(function () { return countFor(w.url) >= 1; }, 6000, 250);
        await sleep(300);
      }, function () {
        // Verify BOTH that the row exists and that it carries every event.
        // countFor must be exactly 1: more than one means we duplicated.
        return countFor(w.url) === 1 && eventsMatch();
      }, 3);

      if (r.auth) return authStop("events");
      if (r.ok) createdCount++;
      if (!r.ok && submitted && !countFor(w.url)) {
        // sent, but the list has not shown it: decided after a longer settle below
        pendingHooks.push({ w: w, match: eventsMatch, want: want });
      } else if (!r.ok) {
        var nRows = countFor(w.url), got = eventsFor(w.url);
        if (!nRows && refusedWhy) failedHooks.push(w.url + " (the dashboard refused it: " + refusedWhy + ")");
        else if (!nRows) failedHooks.push(w.url + " (not created)");
        else if (nRows === 1) failedHooks.push(w.url + " (events: " + (got.join(", ") || "none") + " — expected " + want.join(", ") + ")");
        // more than one row is reported once by the duplicate check below
      }
      await sleep(400);
    }

    // A sent-but-unlisted hook gets one longer wait before it is called out.
    if (pendingHooks.length) {
      await d.waitFor(function () { return pendingHooks.every(function (p) { return countFor(p.w.url) > 0; }); }, 15000, 500);
      pendingHooks.forEach(function (p) {
        var n = countFor(p.w.url);
        if (n === 1 && p.match()) createdCount++;
        else if (!n) failedHooks.push(p.w.url + " (" + SUB_NOT_LISTED + ")");
        else if (n === 1) failedHooks.push(p.w.url + " (events: " + (eventsFor(p.w.url).join(", ") || "none") + " — expected " + p.want.join(", ") + ")");
      });
    }
    // Duplicate check after a longer settle: the list lags its backend, and a
    // late second row must still be caught before the result is reported.
    await sleep(3000);
    var problems = failedHooks.slice();
    var seenUrl = {};
    events.forEach(function (e) {
      if (seenUrl[e.url]) return; seenUrl[e.url] = true;
      var n = countFor(e.url), n0 = countBefore(e.url);
      if (n > 1 && n > n0) problems.push("duplicate subscription x" + n + ": " + e.url);
      else if (n > 1) notes.push("Webhook " + e.url + " was already on the destination " + n + " times before the import — left as is (check by hand).");
    });
    var srcUrls = events.map(function (e) { return d.norm(e.url); });
    var leftovers = urlsBefore.filter(function (u, ix) { return srcUrls.indexOf(u) === -1 && urlsBefore.indexOf(u) === ix; }).map(function (u) { return "Webhook: " + u; });
    return {
      section: "events",
      ok: problems.length === 0,
      leftovers: leftovers,
      // what THIS run created — not every row on the page, which previously
      // counted subscriptions that were already on the destination.
      created: createdCount,
      alreadyPresent: alreadyPresent,
      expected: events.length,
      onPage: subUrls().length,
      notes: notes,
      failedItems: problems
    };
  }

  // ---- scaffolded sections (finalized during live pass) -------------------
  async function dash2Prompt(mapped, ctx) {
    var d = dom();
    if (d.isAuthRedirect()) return authStop("prompt");
    if (isV2()) return dash2PromptV2(mapped, ctx);
    // MUST be on the Prompt tab before writing (its editors live there), and the
    // section MUST be saved before the orchestrator navigates to the next tab,
    // or an SPA tab-switch can discard the unsaved editor content.
    if (!(await gotoTab(DASH2_TABS.prompt)))
      return tabFail("prompt", DASH2_TABS.prompt);
    if (d.isAuthRedirect()) return authStop("prompt");
    if (ctx && typeof ctx.importPrompt === "function") {
      var warnings = [];
      var r = await ctx.importPrompt(mapped);
      if (d.isAuthRedirect()) return authStop("prompt");
      if (r && r.stop) return r;     // the writer saw the page move: write and save nothing more
      r = r || { section: "prompt", ok: false, reason: "prompt writer returned nothing", failedItems: [] };
      if (!Array.isArray(r.failedItems)) r.failedItems = [];
      // opening_line_interruptible: the "Interruptible" checkbox under First
      // Message, written on this tab before its Save (contract 6).
      var cc = (mapped && mapped.data && mapped.data.callConfig) || null;
      var intr = await setInterruptible(cc);
      if (intr.failed) { r.failedItems.push(intr.failed); r.ok = false; }
      if (intr.note) r.notes = (r.notes || []).concat([intr.note]);
      if (d.isAuthRedirect()) return authStop("prompt");
      // save Prompt before leaving the tab; what the editors hold now is read
      // back once the save is done (the page re-renders from the server's copy)
      var edsBefore = promptEditorTexts();
      if ((await saveAndConfirm(DASH2_TABS.prompt, warnings)) === "auth") return authStop("prompt");
      var pRejected = saveRejected(DASH2_TABS.prompt);
      if (pRejected) { r.failedItems.unshift(pRejected); r.ok = false; if (!r.reason) r.reason = pRejected; return withWarnings(r, warnings); }
      if (edsBefore.length && r.ok !== false) {
        var edsAfter = [];
        for (var pt = 0; pt < 20; pt++) {
          edsAfter = promptEditorTexts();
          if (edsAfter.join("\u0001") === edsBefore.join("\u0001")) break;
          await sleep(500);
        }
        if (edsAfter.length !== edsBefore.length) pushOnce(warnings, "Couldn't confirm the " + DASH2_TABS.prompt + ": its editors did not show after the save — check it by hand");
        else {
          var PNAMES = ["First Message", "Main Prompt"];
          edsBefore.forEach(function (t, ix) {
            if (edsAfter[ix] !== t) { r.failedItems.push((edsBefore.length === 2 ? PNAMES[ix] : "Prompt editor " + (ix + 1)) + " — reads differently after the save" + (edsAfter[ix] ? "" : " (empty)")); r.ok = false; }
          });
        }
      }
      if (intr.want !== undefined && !intr.failed) {
        await sleep(300);
        var after = interruptibleBox();
        if (after && after.checked !== intr.want) { r.failedItems.push("First Message → Interruptible " + (intr.want ? "on" : "off") + " (reads " + (after.checked ? "on" : "off") + " after save)"); r.ok = false; }
      }
      return withWarnings(r, warnings);
    }
    return { section: "prompt", ok: false, reason: "prompt writer hook not provided (TODO@LIVE)", failedItems: [] };
  }
  // Old UI: the text (whitespace removed) of each visible prompt editor, in order.
  function promptEditorTexts() {
    var d = dom();
    return [].slice.call(document.querySelectorAll(".ProseMirror, .tiptap, [contenteditable='true']"))
      .filter(function (e, i, all) { return d.visible(e) && !all.some(function (o) { return o !== e && o.contains(e); }); })
      .map(edLetters);
  }
  // Letters and digits only: a re-render may change spacing, bullets or chip
  // punctuation without changing what was saved.
  function edLetters(el) { return el ? String(el.textContent || "").replace(/[^\p{L}\p{N}]+/gu, "") : ""; }
  // The "Interruptible" checkbox that belongs to the First Message block on the
  // Prompt tab: a label reading "Interruptible" wrapping (or naming via for=) a
  // checkbox / switch, nearest after the "First Message" heading.
  function interruptibleBox() {
    var d = dom();
    var labs = [].slice.call(document.querySelectorAll("label,span,div,p")).filter(function (e) {
      if (!d.visible(e)) return false;
      var own = [].slice.call(e.childNodes).filter(function (n) { return n.nodeType === 3; }).map(function (n) { return n.nodeValue; }).join(" ");
      return /^interruptible\??$/i.test(d.norm(own)) || (e.children.length === 0 && /^interruptible\??$/i.test(d.norm(e.textContent)));
    });
    for (var i = 0; i < labs.length; i++) {
      var l = labs[i], box = null;
      if (l.tagName === "LABEL" && l.getAttribute("for")) box = document.getElementById(l.getAttribute("for"));
      if (!box) box = l.querySelector("input[type='checkbox'],[role='switch'],[role='checkbox']");
      for (var n = l, k = 0; !box && k < 3 && n.parentElement; k++) {
        n = n.parentElement;
        var cands = [].slice.call(n.querySelectorAll("input[type='checkbox'],[role='switch'],[role='checkbox']")).filter(function (x) { return d.visible(x); });
        if (cands.length === 1) box = cands[0]; else if (cands.length > 1) break;
      }
      if (box) return { el: box, get checked() { return box.tagName === "INPUT" ? !!box.checked : box.getAttribute("aria-checked") === "true"; } };
    }
    return null;
  }
  async function setInterruptible(cc) {
    var d = dom();
    if (!cc || typeof cc.opening_line_interruptible !== "boolean") return {};
    var want = cc.opening_line_interruptible;
    var b = interruptibleBox();
    if (!b) {
      return { note: want ? "Call Config: opening_line_interruptible = true — no 'Interruptible' control under First Message on this dashboard; not migrated." : "" };
    }
    for (var a = 0; a < 3 && b && b.checked !== want; a++) {
      if (a === 0) d.clickEl(b.el); else d.pressSequence(b.el);
      await sleep(250);
      b = interruptibleBox();
    }
    if (!b || b.checked !== want) return { want: want, failed: "First Message → Interruptible " + (want ? "on" : "off") + " (did not take)" };
    return { want: want };
  }

  // ---- Prompt on the new UI ---------------------------------------------------
  // section[aria-label="Prompt editor"]: "First message" (with the Interruptible
  // switch in its header) and "Main prompt". The editors are written by the
  // content.js hook; this commits them with the page-wide Save and reads back.
  function v2PromptRoot() { return document.querySelector('section[aria-label="Prompt editor"]'); }
  function v2PromptEditors() {
    var root = v2PromptRoot(), out = { fm: null, mp: null };
    if (!root) return out;
    [].slice.call(root.querySelectorAll("section[aria-labelledby]")).forEach(function (s) {
      var h = document.getElementById(s.getAttribute("aria-labelledby")) || s.querySelector("h3");
      var own = h ? [].slice.call(h.childNodes).filter(function (n) { return n.nodeType === 3; }).map(function (n) { return n.nodeValue; }).join("").trim().toLowerCase() : "";
      var ed = s.querySelector(".ProseMirror");
      if (own === "first message" && !out.fm) out.fm = ed;
      else if (own === "main prompt" && !out.mp) out.mp = ed;
    });
    return out;
  }
  function v2InterruptibleSwitch() { var r = v2PromptRoot(); return r ? dom().v2Switch(r, "Interruptible") : null; }
  async function dash2PromptV2(mapped, ctx) {
    var d = dom(), LABEL = DASH2_TABS.prompt;
    if (!(await gotoTab(LABEL))) return tabFail("prompt", LABEL);
    if (d.isAuthRedirect()) return authStop("prompt");
    if (!ctx || typeof ctx.importPrompt !== "function")
      return { section: "prompt", ok: false, reason: "prompt writer hook not provided", failedItems: [] };
    var warnings = [];
    var r = await ctx.importPrompt(mapped);
    if (d.isAuthRedirect()) return authStop("prompt");
    r = r || { section: "prompt", ok: false, reason: "prompt writer returned nothing", failedItems: [] };
    if (r.stop) return r;
    if (!Array.isArray(r.failedItems)) r.failedItems = [];
    // Interruptible (agent_config.opening_line_interruptible): saved with the Prompt.
    var cc = (mapped && mapped.data && mapped.data.callConfig) || null;
    var wantIntr = (cc && typeof cc.opening_line_interruptible === "boolean") ? cc.opening_line_interruptible : undefined;
    if (wantIntr !== undefined) {
      var sw = v2InterruptibleSwitch();
      if (!sw) {
        if (wantIntr) r.notes = (r.notes || []).concat(["Call Config: opening_line_interruptible = true — no 'Interruptible' switch under First message on this dashboard; not migrated."]);
        wantIntr = undefined;
      } else {
        await d.v2SetSwitch(sw, wantIntr);
        var sw2 = v2InterruptibleSwitch();
        if (!sw2 || (sw2.getAttribute("aria-checked") === "true") !== wantIntr) {
          r.failedItems.push("First message → Interruptible " + (wantIntr ? "on" : "off") + " (did not take)"); r.ok = false; wantIntr = undefined;
        }
      }
    }
    if (d.isAuthRedirect()) return authStop("prompt");
    // What the editors hold now = what the Save must store.
    var eds = v2PromptEditors();
    var pre = { fm: eds.fm ? v2Text(eds.fm) : null, mp: eds.mp ? v2Text(eds.mp) : null };
    var hasTable = !!(eds.mp && eds.mp.querySelector("table")) || !!(eds.fm && eds.fm.querySelector("table"));
    var sv = await saveV2(LABEL, warnings);
    if (d.isAuthRedirect()) return authStop("prompt");
    if (sv.state === "failed" || sv.state === "blocked" || (sv.state === "unconfirmed" && d.v2SaveBar())) {
      var line = sv.state === "unconfirmed" ? "The Save didn't finish — the prompt changes are still unsaved on the page" : v2Reject(sv.text);
      if (hasTable && sv.state === "failed") line += " (the prompt contains a table; this dashboard is known to reject saves with tables — turn the table into a list and save by hand)";
      r.ok = false; r.reason = line; r.saved = sv.state;
      r.failedItems = [line].concat(r.failedItems);
      return withWarnings(r, warnings);
    }
    r.saved = sv.state;
    // Read back after the Save: the editors re-render from the server's copy
    // (reopened first if the user clicked another section meanwhile).
    await v2WaitIdle(30000);
    if (d.v2ActiveSection() !== (d.V2_SECTIONS || {}).prompt || !safeCall(V2_READY.prompt)) await gotoSectionV2(LABEL, { budgetMs: 6000 });
    await v2Settle(V2_READY.prompt);
    var post = v2PromptEditors();
    if (pre.fm !== null && post.fm && v2Text(post.fm) !== pre.fm) { r.failedItems.push("First message — reads differently after the save"); r.ok = false; }
    if (pre.mp !== null && post.mp && v2Text(post.mp) !== pre.mp) { r.failedItems.push("Main prompt — reads differently after the save"); r.ok = false; }
    if (wantIntr !== undefined) {
      var s3 = v2InterruptibleSwitch();
      var on = s3 ? s3.getAttribute("aria-checked") === "true" : null;
      if (on !== wantIntr) { r.failedItems.push("First message → Interruptible " + (wantIntr ? "on" : "off") + " (reads " + (on === null ? "nothing" : on ? "on" : "off") + " after save)"); r.ok = false; }
    }
    return withWarnings(r, warnings);
  }
  async function dash2LanguageVoice(lv) {
    var d = dom();
    if (d.isAuthRedirect()) return authStop("languageVoice");
    if (v2Ui()) return dash2LanguageVoiceV2(lv);   // new 2-field UI (sidebar sections)
    if (!(await gotoTab(DASH2_TABS.languageVoice)))
      return tabFail("languageVoice", DASH2_TABS.languageVoice);
    if (d.isAuthRedirect()) return authStop("languageVoice");
    lv = lv || {};
    var failed = [], warnings = [];

    // The language picker for a label is the input inside that label's OWN
    // field container: label[for] / aria-labelledby first, else the nearest
    // ancestor that holds an input -- and the climb STOPS there. When that
    // container's input is not rendered yet (or it holds several), the answer
    // is "not found", never the next field's input higher up (the Secondary
    // value was once written into the Primary field that way).
    function langInput(labelText) {
      var labels = [].slice.call(document.querySelectorAll("label,span,div,p,h1,h2,h3,h4,h5,h6"))
        .filter(function (e) { return e.children.length === 0 && d.norm(e.textContent) === labelText && d.visible(e); });
      for (var li = 0; li < labels.length; li++) {
        var lab = labels[li];
        var forId = lab.tagName === "LABEL" && lab.getAttribute("for");
        if (forId) {
          var byFor = document.getElementById(forId);
          if (byFor && byFor.tagName === "INPUT") { if (d.visible(byFor)) return byFor; continue; }
        }
        if (lab.id) {
          var byAria = [].slice.call(document.querySelectorAll("[aria-labelledby]")).filter(function (x) {
            return (" " + x.getAttribute("aria-labelledby") + " ").indexOf(" " + lab.id + " ") !== -1;
          })[0];
          if (byAria) {
            var ai = byAria.tagName === "INPUT" ? byAria : byAria.querySelector("input");
            if (ai) { if (d.visible(ai)) return ai; continue; }
          }
        }
        var node = lab;
        for (var k = 0; k < 6 && node; k++) {
          node = node.parentElement;
          if (!node || node === document.body) break;
          var ins = [].slice.call(node.querySelectorAll("input"));
          if (!ins.length) continue;
          var vis = ins.filter(function (x) { return d.visible(x); });
          if (ins.length === 1) { if (vis.length) return vis[0]; break; }
          if (vis.length === 1 && ins.every(function (x) { return x === vis[0] || x.type === "hidden"; })) return vis[0];
          break;                      // several inputs: a shared grid, not this field's box
        }
      }
      return null;
    }

    async function setLang(labelText, value) {
      if (!value) return true;
      // Dash2 shows plain names ("English"); Dash5 may carry a region ("English (IN)").
      var tries = [value, value.replace(/\s*\([^)]*\)\s*/g, "").trim()];
      for (var a = 1; a <= 3; a++) {
        if (d.isAuthRedirect()) return false;
        for (var ti = 0; ti < tries.length; ti++) {
          var val = tries[ti]; if (!val) continue;
          var trig = langInput(labelText); if (!trig) continue;
          var inputsBefore = [].slice.call(document.querySelectorAll("input"));
          d.openDropdown(trig);
          await sleep(350);
          // filterable list: type into the filter box the opened menu itself
          // created -- never a search box that was already on the page (the
          // voice search once received the language name).
          var filt = [].slice.call(document.querySelectorAll("input")).filter(function (i) {
            return inputsBefore.indexOf(i) === -1 && d.visible(i) && /filter|search/i.test(i.placeholder || "");
          })[0];
          if (filt) { d.setReactInput(filt, val); await sleep(300); }
          d.selectSingleOption(val);
          await sleep(250);
          var cur = langInput(labelText);
          if (cur && d.norm(cur.value) === d.norm(val)) return true;
          // A miss leaves the menu open, and the next press of the same trigger
          // would only toggle it shut: close it first.
          try { if (d.menuIsOpen()) await d.dismissMenu(null, trig); } catch (e) {}
        }
        await sleep(200);
      }
      failed.push(labelText + (value ? " → " + value : ""));
      return false;
    }

    // The two pickers can't hold the same language. Writing Hindi/English over
    // a bot that shows English/Hindi briefly made both "Hindi": the primary
    // field kept a red error, the section Save didn't commit, and every later
    // tab switch was refused (live 2026-11-03). So: write the field whose
    // target doesn't collide first; for a straight swap, park the primary on a
    // third language, then write secondary, then primary.
    var wantP = lv.primaryLanguage || "", wantS = lv.secondaryLanguage || "";
    function curLang(label) { var i = langInput(label); return i ? d.norm(i.value) : ""; }
    function sameLang(a, b) {
      a = d.norm(a).replace(/\s*\([^)]*\)\s*/g, "").toLowerCase();
      b = d.norm(b).replace(/\s*\([^)]*\)\s*/g, "").toLowerCase();
      return !!a && a === b;
    }
    async function parkOnThird(label, avoid) {
      var trig = langInput(label); if (!trig) return false;
      d.openDropdown(trig); await sleep(350);
      var opts = d.popoverItems()
        .map(function (o) { return d.norm(o.textContent); })
        .filter(function (t) { return t && !avoid.some(function (x) { return sameLang(x, t); }); });
      if (!opts.length) { try { await d.dismissMenu(); } catch (e) {} return false; }
      d.selectSingleOption(opts[0]); await sleep(300);
      return !avoid.some(function (x) { return sameLang(x, curLang(label)); });
    }
    var curP = curLang("Primary Language"), curS = curLang("Secondary Language");
    if (wantP && wantS && sameLang(wantP, curS) && sameLang(wantS, curP)) {
      await parkOnThird("Primary Language", [wantP, wantS, curP, curS]);
      await setLang("Secondary Language", wantS);
      await setLang("Primary Language", wantP);
    } else if (wantP && sameLang(wantP, curS)) {
      await setLang("Secondary Language", wantS);
      await setLang("Primary Language", wantP);
    } else {
      await setLang("Primary Language", wantP);
      await setLang("Secondary Language", wantS);
    }
    // Both read back, and neither field may be left showing an error.
    function langErr(label) {
      var inp = langInput(label); if (!inp) return false;
      if (inp.getAttribute("aria-invalid") === "true") return true;
      var box = inp.parentElement;
      for (var k = 0; k < 3 && box; k++) {
        if (box.querySelector('[aria-invalid="true"], [role="alert"]')) return true;
        box = box.parentElement;
      }
      return false;
    }
    function checkLangs(when) {
      [["Primary Language", wantP], ["Secondary Language", wantS]].forEach(function (pr) {
        if (!pr[1]) return;
        var got = curLang(pr[0]);
        var tag = pr[0] + " → " + pr[1];
        if (failed.some(function (f) { return f.indexOf(tag) === 0; })) return;
        if (!sameLang(got, pr[1])) failed.push(tag + " (reads " + (got || "empty") + " " + when + ")");
        else if (langErr(pr[0])) failed.push(tag + " (the field shows an error " + when + ")");
      });
    }
    checkLangs("after selection");

    // 2-field source only: the voice card and the speed. The voice list depends
    // on the languages, so this runs after them. Absent -> skipped.
    var notes = [];
    if (lv.voice && lv.voice.name) {
      if (d.menuIsOpen()) await d.dismissMenu();
      await sleep(400);
      await selectVoice(lv.voice, failed, notes);
    }
    var wantSpeed = hasVal(lv.speed) ? Number(lv.speed) : null;
    if (wantSpeed !== null && isFinite(wantSpeed)) await selectSpeed(wantSpeed, failed);

    // Save on this tab before leaving (tab-switch discards unsaved changes);
    // never on the login bounce.
    var lvSaved = await saveAndConfirm(DASH2_TABS.languageVoice, warnings, { globalFallback: true });
    if (lvSaved === "auth") return authStop("languageVoice");
    var lvRejected = saveRejected(DASH2_TABS.languageVoice);
    if (lvRejected) { failed.unshift(lvRejected); return withWarnings({ section: "languageVoice", ok: false, reason: lvRejected, failedItems: failed, notes: notes }, warnings); }
    await sleep(300);
    checkLangs("after save");
    if (lvSaved === false && failed.length) failed.push("Language and Voice: the dashboard did not confirm the save");
    // read back what this section wrote
    if (lv.voice && lv.voice.name && !failed.some(function (f) { return f.indexOf("Voice →") === 0; })) {
      var vc = voiceCards(lv.voice);
      if (vc.length === 1 && selState(vc[0]) === false) failed.push("Voice → " + lv.voice.name + " (not selected after save)");
      else if (!vc.length) failed.push("Voice → " + lv.voice.name + " (not on the screen after save)");
    }
    if (wantSpeed !== null && isFinite(wantSpeed) && !failed.some(function (f) { return f.indexOf("Voice speed") === 0; })) {
      var cs = currentSpeed();
      if (!numEq(cs, wantSpeed)) failed.push("Voice speed → " + wantSpeed + " (reads " + (cs === null ? "none" : cs) + " after save)");
    }
    return withWarnings({ section: "languageVoice", ok: failed.length === 0, failedItems: failed, notes: notes }, warnings);
  }
  var PHASES = ["pre_call", "on_call", "post_call"];
  var PHASE_TAB = { pre_call: "Pre Call", on_call: "On call", post_call: "Post Call" };
  async function dash2Tools(tools, ctx) {
    var d = dom(); ctx = ctx || {};
    if (d.isAuthRedirect()) return authStop("tools");
    tools = tools || {};
    // Tools under a phase key this writer does not know are reported, never
    // dropped silently.
    var unknownPhase = [];
    Object.keys(tools).forEach(function (k) {
      if (PHASES.indexOf(k) !== -1 || !Array.isArray(tools[k])) return;
      tools[k].forEach(function (t) {
        var nm = (t && (t.name || t.tool_name)) || "(unnamed)";
        unknownPhase.push(k + ": " + nm + " (unknown tool phase '" + k + "' — not created)");
      });
    });
    if (!PHASES.some(function (p) { return (tools[p] || []).length; }))
      return { section: "tools", ok: !unknownPhase.length, created: 0, alreadyPresent: 0, failedItems: unknownPhase };
    // New 2-field UI (sidebar "Tools", section[aria-label="Tools editor"]); see
    // newui/tools-webhooks.md (verified live 2026-11-05). Old layout: unchanged path.
    var NEW = !!(d.v2IsNewUi && d.v2IsNewUi());
    if (NEW) {
      if (!(await d.v2GotoSection(d.V2_SECTIONS.tools, function () { return !!toolsSec(); })))
        return fail("tools", "the 'Tools' section could not be opened" + (d.v2GotoSection.lastWhy ? " — " + d.v2GotoSection.lastWhy : ""));
    } else if (!(await gotoTab(DASH2_TABS.tools)))
      return tabFail("tools", DASH2_TABS.tools);
    if (d.isAuthRedirect()) return authStop("tools");
    var failed = unknownPhase.slice(), created = 0, alreadyPresent = 0, warnings = [], leftovers = [];

    // True when the SELECTED phase cannot take API tools. Verified live
    // 2026-10-31 on Dash2 QA: Pre Call and Post Call both render "Coming
    // soon." and carry no "+ API" control; only On call accepts tools.
    // Scoped to the phase's own panel: reading the whole <main> meant any
    // "Coming soon." anywhere on the page would declare EVERY phase dead.
    // Falls back to <main> only if the panel cannot be resolved.
    // Name a tool for the report. The raw Dash5 object carries tool_name;
    // only extractToolParts produces .name, so reading t.name gave every
    // skipped tool the label "tool" -- three unmigratable pre-call tools all
    // reported as "Pre Call: tool".
    function toolLabel(t) {
      if (!t) return "(unnamed)";
      try {
        var p = window.MagicPort.extractToolParts(t);
        if (p && p.name) return p.name;
      } catch (e) {}
      return t.name || t.tool_name || "(unnamed)";
    }

    // ---- new UI helpers ------------------------------------------------------
    // Phase tabs are Radix triggers with ids "radix-…-trigger-pre_call|on_call|
    // post_call" (the Post Call text reads "Post CallSoon"): select by id suffix
    // with a pointer sequence (.click() does not switch them).
    function toolsSec() { return document.querySelector('section[aria-label="Tools editor"]'); }
    function v2PhaseTab(phase) { return (toolsSec() || document).querySelector('[role="tab"][id$="-trigger-' + phase + '"]'); }
    function v2TabActive(t) { return !!t && (t.getAttribute("aria-selected") === "true" || t.getAttribute("data-state") === "active"); }
    async function selectPhase(phase) {
      if (!NEW) return await openSubTab(PHASE_TAB[phase]);
      for (var a = 0; a < 4; a++) {
        var t = v2PhaseTab(phase);
        if (!t) { await sleep(300); continue; }
        if (v2TabActive(t)) break;
        d.pressSequence(t);
        await sleep(400);
      }
      var t2 = v2PhaseTab(phase);
      if (!v2TabActive(t2)) return null;
      var id = t2.getAttribute("aria-controls");
      return (id && document.getElementById(id)) || null;
    }
    // The list of the selected phase has loaded (rows or its empty state).
    function v2ListShown() {
      var p = phasePanel();
      return !!p.querySelector("ul li") || /no (pre|on|post)[- ]call tools yet|no tools yet|coming soon/i.test(p.textContent || "");
    }
    async function v2ListLoaded() {
      if (await d.waitFor(v2ListShown, 15000, 250)) return true;
      await untilVisible();
      return !!(await d.waitFor(v2ListShown, 5000, 250));
    }
    // The header add control: "API" (On call, opens the drawer) or "Tool" (Pre
    // Call, a Radix menu: "HTTP request" / "Function"). None on Post Call.
    function v2AddBtn() {
      var s = toolsSec(); if (!s) return null;
      return [].slice.call(s.querySelectorAll("header button")).filter(function (b) {
        return d.visible(b) && /^(API|Tool)$/.test(d.norm(b.textContent));
      })[0] || null;
    }
    function v2Drawer() {
      return [].slice.call(document.querySelectorAll("[role='dialog']")).filter(function (x) {
        return d.visible(x) && /Add to Assistance/.test(x.textContent || "");
      })[0] || null;
    }
    // <label for=X>text</label> -> #X, inside the drawer (a trailing "*" ignored).
    function v2LabelFor(text) {
      var dlg = v2Drawer(); if (!dlg) return null;
      var l = [].slice.call(dlg.querySelectorAll("label[for]")).filter(function (x) {
        return d.norm(x.textContent).replace(/\s*\*$/, "") === text;
      })[0];
      return l ? document.getElementById(l.getAttribute("for")) : null;
    }
    // The app snake-cases the Name live ("PP Probe Pre" -> pp_probe_pre) and
    // stores that: compare/dedupe on the same form.
    function v2Snake(s) { return d.norm(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
    async function v2OpenDrawer() {
      var b = v2AddBtn(); if (!b) return false;
      if (d.norm(b.textContent) === "Tool") {
        var item = null;
        var httpItem = function () {
          return [].slice.call(document.querySelectorAll("[role='menu'] [role='menuitem']"))
            .filter(function (x) { return d.visible(x) && /^HTTP request\b/.test(d.norm(x.textContent)); })[0] || null;
        };
        for (var a = 0; a < 2 && !item; a++) {
          d.pressSequence(b);
          await d.waitFor(function () { item = httpItem(); return !!item; }, 1500, 150);
        }
        if (!item) return false;
        d.clickEl(item);
      } else d.clickEl(b);
      await d.waitFor(function () { return !!v2Drawer() && !!v2LabelFor("Name"); }, 4000, 200);
      return !!v2Drawer();
    }
    // Method: <label for=Y>Method</label> -> button#Y[role=combobox]; options in
    // ul#Y-listbox > li[role=option] ("Post", "Get", ...). Read the button text.
    async function v2SetMethod(wantLabel) {
      var lbOf = function (b) { return document.getElementById(b.getAttribute("aria-controls") || (b.id + "-listbox")) || document.getElementById(b.id + "-listbox"); };
      for (var a = 0; a < 3; a++) {
        var b = methodTrigger(); if (!b) return false;
        if (d.norm(b.textContent).toLowerCase() === wantLabel.toLowerCase()) return true;
        if (b.getAttribute("aria-expanded") !== "true") { if (a % 2 === 0) d.clickEl(b); else d.pressSequence(b); }
        var opt = null;
        await d.waitFor(function () {
          var lb = lbOf(b);
          opt = lb ? [].slice.call(lb.querySelectorAll("[role='option']")).filter(function (o) { return d.norm(o.textContent).toLowerCase() === wantLabel.toLowerCase(); })[0] : null;
          return !!opt;
        }, 2000, 150);
        if (opt) { d.clickEl(opt); await sleep(250); }
        var b2 = methodTrigger();
        if (b2 && b2.getAttribute("aria-expanded") === "true") { d.clickEl(b2); await sleep(150); }
      }
      var b3 = methodTrigger();
      return !!b3 && d.norm(b3.textContent).toLowerCase() === wantLabel.toLowerCase();
    }
    // Leave the section and come back (Webhooks -> Tools -> phase): the only
    // thing that refreshes the tools list after a create (live 2026-11-05).
    async function v2RefreshList() {
      await d.v2GotoSection(d.V2_SECTIONS.events, function () { return !!document.querySelector('section[aria-label="Webhooks editor"]'); }, 5000);
      if (!(await d.v2GotoSection(d.V2_SECTIONS.tools, function () { return !!toolsSec(); }, 8000))) { stuckWhy = NAV_MSG; return false; }
      if (curPhase && !(await selectPhase(curPhase))) { stuckWhy = NAV_MSG; return false; }
      await v2ListLoaded();
      return true;
    }
    function v2SonnerToasts() { return [].slice.call(document.querySelectorAll("[data-sonner-toast]")); }
    // A list row's own label family: "<Verb> API <name>" (On call) or
    // "<Verb> tool <name>" (Pre Call, new UI).
    function rowLabelIs(a, verb, name) { return a === verb + " API " + name || a === verb + " tool " + name; }

    function phaseUnavailable() {
      if (NEW) {
        // Post Call: "Coming soon" in its panel and no add control. Never scan
        // the drawer (it holds "Test API Coming soon").
        if (/coming soon/i.test(phasePanel().textContent || "")) return true;
        return !v2AddBtn();
      }
      var panel = phasePanel();
      var scope = panel || document.querySelector("main") || document.body;
      if (/coming soon/i.test(scope.innerText || "")) return true;
      // Belt and braces: a usable phase always offers the "+ API" control.
      var hasAdd = [].slice.call(document.querySelectorAll("button,[role='button']"))
        .some(function (b) { return d.visible(b) && /^\+?\s*API$/i.test(d.norm(b.textContent)); });
      return !hasAdd;
    }
    // The selected phase's tabpanel (Pre Call / On call / Post Call), resolved
    // through the tab's aria-controls so we never scan the wrong phase.
    function phasePanel() {
      if (NEW) {
        var at = PHASES.map(v2PhaseTab).filter(v2TabActive)[0];
        var aid = at && at.getAttribute("aria-controls");
        return (aid && document.getElementById(aid)) || toolsSec() || document.body;
      }
      var labels = [PHASE_TAB.pre_call, PHASE_TAB.on_call, PHASE_TAB.post_call];
      var t = [].slice.call(document.querySelectorAll('button[role="tab"]'))
        .filter(function (x) {
          return d.visible(x) && labels.indexOf(d.norm(x.textContent)) !== -1
            && x.getAttribute("aria-selected") === "true";
        })[0];
      var id = t && t.getAttribute("aria-controls");
      return (id && document.getElementById(id)) || document.querySelector("main") || document.body;
    }
    // A created tool renders its NAME only inside aria-labels
    // ("Edit API <name>" / "Delete API <name>") — never as visible text.
    // The old text scan therefore ALWAYS failed, so withRetry re-ran addTool and
    // created DUPLICATES while still reporting the tool as failed.
    // Verified live on Dash2 QA 2026-10-31.
    function toolExists(name) {
      return toolCount(name) > 0;
    }
    // How many list rows carry this name: the larger of the "Edit API <name>"
    // and "Delete API <name>" counts (each row has one of each). 2+ = duplicate.
    function toolCount(name) {
      if (!name) return 0;
      var want = d.norm(name), ed = 0, del = 0;
      [].slice.call(phasePanel().querySelectorAll("[aria-label]")).forEach(function (el) {
        var a = d.norm(el.getAttribute("aria-label"));
        if (rowLabelIs(a, "Edit", want)) ed++;
        else if (rowLabelIs(a, "Delete", want)) del++;
      });
      return Math.max(ed, del);
    }
    // form field finders (CONFIRM@TEST: anchored on stable cues, with SPECIFIC
    // label-based fallbacks so a minor UI change doesn't strand the finder).
    // labeledInput: the visible input inside the field container whose own label
    // text equals labelText (exact, case-insensitive). Specific on purpose — a
    // loose "first input" fallback could mis-fill the wrong field.
    function labeledInput(labelText) {
      var want = d.norm(labelText).toLowerCase();
      var labels = [].slice.call(document.querySelectorAll("label,span,div,p"))
        .filter(function (e) { return e.children.length === 0 && d.visible(e) && d.norm(e.textContent).toLowerCase() === want; });
      for (var li = 0; li < labels.length; li++) {
        var node = labels[li];
        for (var k = 0; k < 5 && node; k++) { node = node.parentElement; if (node) { var inp = node.querySelector("input"); if (inp && d.visible(inp)) return inp; } }
      }
      return null;
    }
    function formNameInput() {
      if (NEW) { var n2 = v2LabelFor("Name"); if (n2) return n2; }
      // the Name field sits above the "Saved in snake_case" helper text
      var help = [].slice.call(document.querySelectorAll("*")).filter(function (e) { return e.children.length === 0 && d.visible(e) && /saved in snake_case/i.test(e.textContent || ""); })[0];
      if (help) {
        var node = help;
        for (var k = 0; k < 4 && node; k++) { node = node.parentElement; if (node) { var inp = node.querySelector("input"); if (inp && d.visible(inp)) return inp; } }
      }
      return labeledInput("Name") || labeledInput("Tool Name");
    }
    function urlInput() {
      if (NEW) return v2LabelFor("API URL");
      return [].slice.call(document.querySelectorAll("input")).filter(function (i) { return d.visible(i) && /api_url/i.test(i.placeholder || ""); })[0]
        || [].slice.call(document.querySelectorAll("input")).filter(function (i) { return d.visible(i) && (i.type === "url"); })[0]
        || labeledInput("URL") || labeledInput("API URL") || labeledInput("API Url");
    }
    function methodTrigger() {
      if (NEW) return v2LabelFor("Method");
      return [].slice.call(document.querySelectorAll("input")).filter(function (i) { return d.visible(i) && /^(get|post|put|patch|delete)$/i.test((i.value || "").trim()); })[0]
        || labeledInput("Method") || labeledInput("HTTP Method");
    }

    // ------- line-item rows (VERIFIED live on Dash2 QA, 2026-10-31) ----------
    // Each sub-tab (Headers / Query / Path / Body) uses the SAME pattern: an
    // "Add Row" control (a div[role=button]) opens a small menu with three row
    // types — "Static Row", "Variable Row", "JQ Row" (there is NO "Dynamic Row").
    //   Static Row   : Key input + Value input (placeholder "Type value").
    //   Variable Row : Key input + a "Search variable..." dropdown that lists the
    //                  bot's variables as "custom_args.<name>" (the SAME shape the
    //                  engine captured on Dash5) — pick the matching option.
    //   JQ Row       : Key input + Value input (the jq expression).
    // The row lives inside the active sub-tab's role=tabpanel, which does NOT
    // contain the Name / Method / api_url header inputs, so scoping finders to
    // that panel is safe.
    // LIVE 2026-11-03: Body's Add Row menu also offers "JSON Row" (Headers has only
    // the first three). Its row: div[role=textbox][aria-label="Key"] with an
    // <input>, then div[role=textbox][aria-label="{} JSON"] holding a plain
    // <textarea>, a type switcher and a "Remove body row N" button.
    var ROW_TYPE = { static: "Static Row", variable: "Variable Row", jq: "JQ Row", json: "JSON Row" };
    // New UI: the Add Row menu labels differ per sub-tab (live 2026-11-05).
    var V2_ROW_LABELS = {
      Headers: { static: "Static Row", variable: "Variable Row", jq: "JQ Row" },
      Query: { static: "Static Query", variable: "Variable Query", jq: "JQ Query" },
      Path: { variable: "Variable Path", jq: "JQ Path" },
      Body: { static: "Static Row", variable: "Variable Row", jq: "JQ Row", json: "JSON Row" }
    };
    // New UI variable row: the value is button[role=combobox] ("Pick a variable");
    // .click() opens a popup with a Search input[aria-controls=<id>-listbox] and
    // li[role=option] "custom_args.<name>". Closed by clicking the combobox
    // again -- NEVER Escape (it discards the whole tool form, verified live).
    async function v2PickVariable(combo, item) {
      var name = item.variable || item.value;
      var wanted = [];
      var src = item.source || "custom_args";
      if (src === "custom_args") wanted.push("custom_args." + name);
      else { wanted.push(src + "." + name); wanted.push("custom_args." + name); }
      if (item.value && wanted.indexOf(item.value) === -1) wanted.push(item.value);
      var lbId = combo.getAttribute("aria-controls") || (combo.id + "-listbox");
      var lbOf = function () { return document.getElementById(lbId) || document.getElementById(combo.id + "-listbox"); };
      var opts = function () { var lb = lbOf(); return lb ? [].slice.call(lb.querySelectorAll("[role='option']")) : []; };
      var isOpen = function () { return combo.getAttribute("aria-expanded") === "true" || opts().some(function (o) { return d.visible(o); }); };
      var took = function () { return wanted.indexOf(d.norm(combo.textContent)) !== -1; };
      var closeIt = async function () { if (isOpen()) { d.clickEl(combo); await sleep(200); } };
      for (var a = 0; a < 3; a++) {
        if (took()) { await closeIt(); return true; }
        if (!isOpen()) { if (a % 2 === 0) d.clickEl(combo); else d.pressSequence(combo); }
        await d.waitFor(isOpen, 2000, 150);
        var search = document.querySelector("input[aria-controls='" + lbId.replace(/'/g, "\\'") + "']");
        if (search && d.norm(search.value) !== d.norm(name)) d.setReactInput(search, name);
        var opt = null;
        await d.waitFor(function () {
          opt = opts().filter(function (o) { return wanted.indexOf(d.norm(o.textContent)) !== -1; })
            .sort(function (x, y) { return wanted.indexOf(d.norm(x.textContent)) - wanted.indexOf(d.norm(y.textContent)); })[0] || null;
          return !!opt;
        }, a === 0 ? 2500 : 4000, 200);
        if (opt) {
          d.clickEl(opt);
          await d.waitFor(took, 1500, 150);
        }
        await closeIt();
        if (took()) return true;
      }
      await closeIt();
      return took();
    }
    var JSON_ONLY_IN = "Body";
    var pendingVariableItems = [];

    // A visible leaf element (or role=option/menuitem) whose text equals `text`.
    // Only inside the open popup (MagicPortDom.findOption), or -- for a menu
    // whose items carry no role -- a leaf with that text that APPEARED when the
    // menu opened (`pre`: the matching leaves before). A leaf that was already
    // on the page is never "the option".
    function leavesWithText(text) {
      var want = d.norm(text);
      return [].slice.call(document.querySelectorAll("div,span,li,button,p"))
        .filter(function (e) { return e.children.length === 0 && d.visible(e) && d.norm(e.textContent) === want; });
    }
    function optionByText(text, pre) {
      var o = d.findOption(text);
      if (o || !pre) return o;
      return leavesWithText(text).filter(function (e) { return pre.indexOf(e) === -1; })[0] || null;
    }
    // Activate a menu option with ONE dispatch. The previous version called
    // clickEl() and then pressSequence() as a "fallback"; components that handle
    // the click fired TWICE, so "Variable Row" inserted TWO rows — the key landed
    // in the first and the picked variable in the second, and the tool could not
    // be added. pressSequence already ends with a click event, so it covers both
    // plain and Radix-style menus on its own. Verified live 2026-10-31.
    function clickOption(text, pre) {
      var o = optionByText(text, pre); if (!o) return false;
      d.pressSequence(o);
      return true;
    }
    // Open the newest row's "Search variable..." picker and choose the variable.
    // rowEl: THIS row (the picker is looked up inside it); subPanel: the whole
    // sub-tab panel, used to keep the filter box / option lookup away from the
    // OTHER rows' pickers.
    //
    // LIVE 2026-11-03 "Body: test_key_2 → custom_args.bank_name (... not in the
    // picker)": the filter box was taken as the FIRST input on the whole page
    // whose placeholder matched /search|filter/, which on the 2nd variable row is
    // the 1st row's own picker input -- the name was typed there and the open
    // list was never filtered, so a long list never showed the option. The pick
    // was also a single 450 ms shot with no read-back. Now: the filter box is
    // never an input of another row, the option is WAITED for after typing,
    // matched exactly (never another row's display text), the row is read back,
    // and the whole open/type/pick is retried.
    async function selectSearchVariable(panel, item, subPanel) {
      var name = item.variable || item.value;
      // Dash2 lists custom variables as "custom_args.<name>". call_data /
      // platform_analysis / client_analysis / tool_output are Dash5-only sources
      // with no custom-variable equivalent — try the literal, else give up (flag).
      var wanted = [];
      var src = item.source || "custom_args";
      if (src === "custom_args") wanted.push("custom_args." + name);
      else { wanted.push(src + "." + name); wanted.push("custom_args." + name); }
      if (item.value && wanted.indexOf(item.value) === -1) wanted.push(item.value);
      function comboOf() {
        return [].slice.call(panel.querySelectorAll("*"))
          .filter(function (e) { return d.visible(e) && /search variable/i.test(e.textContent || "") && d.norm(e.textContent).length < 40; }).pop() || null;
      }
      // Is el inside ANOTHER row of this sub-panel (not ours)?
      function inOtherRow(el) {
        return !!(subPanel && subPanel !== panel && subPanel.contains(el) && !panel.contains(el));
      }
      function filterBox() {
        var c = [].slice.call(document.querySelectorAll("input")).filter(function (i) {
          return d.visible(i) && !inOtherRow(i) && /search variable|value to filter|filter|search/i.test(i.placeholder || "");
        });
        // the picker's own filter box first, then whatever has focus, then the rest
        return c.filter(function (i) { return /value to filter/i.test(i.placeholder || ""); })[0]
          || c.filter(function (i) { return i === document.activeElement; })[0]
          || c.filter(function (i) { return panel.contains(i); })[0]
          // last resort: only a filter box the opened picker itself created
          || c.filter(function (i) { return inputsBefore.indexOf(i) === -1 && !(subPanel && subPanel.contains(i)); })[0] || null;
      }
      function pickOption(text) {
        var want = d.norm(text);
        var roled = [].slice.call(document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"]'))
          .filter(function (o) { return d.visible(o) && !inOtherRow(o) && d.norm(o.textContent) === want; });
        if (roled.length) return roled[0];
        var cmb = comboOf();
        return [].slice.call(document.querySelectorAll("div,span,li,button,p"))
          .filter(function (e) {
            return e.children.length === 0 && d.visible(e) && d.norm(e.textContent) === want &&
              !inOtherRow(e) && !(cmb && cmb.contains(e));
          })[0] || null;
      }
      // Read back: the row now shows the variable, or at least no longer shows
      // the empty "Search variable..." placeholder.
      function rowTook() {
        var t = d.norm(panel.textContent);
        var vals = [].slice.call(panel.querySelectorAll("input")).slice(1).map(function (i) { return d.norm(i.value); });
        if (wanted.some(function (w) { return t.indexOf(w) !== -1 || vals.indexOf(w) !== -1; })) return true;
        return !comboOf();
      }
      var inputsBefore = [];
      for (var attempt = 0; attempt < 3; attempt++) {
        var combo = comboOf();
        if (!combo) return attempt > 0 && rowTook();
        if (attempt > 0) { if (d.menuIsOpen()) await d.dismissMenu(); await sleep(400); }
        inputsBefore = [].slice.call(document.querySelectorAll("input"));
        d.openDropdown(combo);
        // wait for the list (or its filter box) to render
        await d.waitFor(function () { return d.menuIsOpen() || !!filterBox() || wanted.some(function (w) { return !!pickOption(w); }); }, 2000, 150);
        var filt = filterBox();
        if (filt) d.setReactInput(filt, name);
        var opt = null;
        await d.waitFor(function () {
          for (var w = 0; w < wanted.length && !opt; w++) opt = pickOption(wanted[w]);
          return !!opt;
        }, attempt === 0 ? 2500 : 4000, 200);
        for (var w2 = 0; w2 < wanted.length && !opt; w2++) opt = pickOption(wanted[w2]);
        if (opt) {
          d.pressSequence(opt);
          await sleep(300);
          await d.waitFor(rowTook, 1500, 150);
          if (rowTook()) return true;
        }
      }
      // Escape would tear down the whole "+ API" editor and lose the tool in
      // progress (verified live 2026-10-31) -- dismiss the picker safely.
      await d.dismissMenu(); await sleep(150);
      return false;
    }
    // Open a modal sub-tab (Headers / Path / Query / Body) and return ITS panel.
    // VERIFIED live 2026-10-31: these are button[role=tab] carrying aria-controls
    // -> the panel id. Resolving the panel this way is the ONLY reliable scope:
    // with the modal open the document holds NINE tabpanels (3 outer phase
    // panels + 6 modal sub-panels), so the previous "last visible tabpanel"
    // picked the wrong one and rows were written into another section.
    // New UI: the drawer's sub-tab texts carry a row count ("Headers1"); select
    // them by id suffix (the Settings key is "setting").
    var V2_SUB_KEY = { Headers: "headers", Path: "path", Query: "query", Body: "body", Response: "response", Settings: "setting" };
    async function openSubTab(label) {
      var tab = NEW
        ? (V2_SUB_KEY[label] && v2Drawer() ? v2Drawer().querySelector('[role="tab"][id$="-trigger-' + V2_SUB_KEY[label] + '"]') : null)
        : [].slice.call(document.querySelectorAll('button[role="tab"]'))
          .filter(function (t) { return d.visible(t) && d.norm(t.textContent) === label; })[0];
      if (!tab) return null;
      // Radix tab triggers do NOT switch on a synthetic .click(): they listen for
      // the pointerdown/mouseup sequence. Verified live 2026-10-31 — clickEl()
      // left aria-selected="false", so Path/Query/Body never opened and every row
      // fell back into the default Headers panel. Escalate to pressSequence and
      // confirm via aria-selected before trusting the panel.
      for (var a = 0; a < 3 && tab.getAttribute("aria-selected") !== "true"; a++) {
        if (a === 0 && !NEW) d.clickEl(tab); else d.pressSequence(tab);
        await sleep(400);
      }
      if (tab.getAttribute("aria-selected") !== "true") return null;
      var id = tab.getAttribute("aria-controls");
      var panel = id ? document.getElementById(id) : null;
      if (panel && !d.visible(panel)) await sleep(300);
      return panel || null;
    }

    async function addRowKV(sectionLabel, pairs) {
      if (!pairs || !pairs.length) return;
      var subPanel = await openSubTab(sectionLabel);
      if (!subPanel) {
        pairs.forEach(function (it) {
          failed.push(sectionLabel + ": " + it.key + " (sub-tab '" + sectionLabel + "' not reachable)");
        });
        return;
      }
      for (var i = 0; i < pairs.length; i++) {
        var item = pairs[i];
        var typeLabel = NEW ? ((V2_ROW_LABELS[sectionLabel] || {})[item.kind] || (item.kind === "json" ? ROW_TYPE.json : null)) : ROW_TYPE[item.kind];
        if (NEW && !typeLabel && sectionLabel === "Path" && item.kind === "static") {
          failed.push("Path: " + item.key + " (static path rows aren't offered on this dashboard — put the segment into the URL by hand)");
          continue;
        }
        if (!typeLabel) {
          // "dynamic" (or any other kind) has no Dash2 row type — flag, don't guess.
          failed.push(sectionLabel + ": " + item.key + " (" + (item.kind || "unknown") + " — no matching row type on this dashboard)");
          continue;
        }
        if (item.kind === "json" && sectionLabel !== JSON_ONLY_IN) {
          failed.push(sectionLabel + ": " + item.key + " (JSON rows exist only in Body — add it by hand)");
          continue;
        }
        var beforeInputs = [].slice.call(subPanel.querySelectorAll("input")).filter(function (x) { return d.visible(x); });
        var beforeAreas = [].slice.call(subPanel.querySelectorAll("textarea"));
        var beforeCombos = [].slice.call(subPanel.querySelectorAll("button[role='combobox']"));
        var addRowBtn = [].slice.call(subPanel.querySelectorAll("[role='button'],button"))
          .filter(function (b) { return d.visible(b) && /^add row$/i.test(d.norm(b.textContent)); })[0];
        if (!addRowBtn) { failed.push(sectionLabel + ": " + item.key + " (Add Row not found)"); continue; }
        if (NEW) {
          // Radix menu: opened by a pointer sequence; its items take a plain .click().
          var v2Item = function () {
            return [].slice.call(document.querySelectorAll("[role='menu'] [role='menuitem']"))
              .filter(function (o) { return d.visible(o) && d.norm(o.textContent) === typeLabel; })[0] || null;
          };
          var mi = null;
          d.pressSequence(addRowBtn);
          await d.waitFor(function () { mi = v2Item(); return !!mi || !!document.querySelector("[role='menu']"); }, 1500, 150);
          mi = v2Item();
          if (!mi) {
            failed.push(sectionLabel + ": " + item.key + " (row type '" + typeLabel + "' not offered)");
            if (document.querySelector("[role='menu']")) { d.pressSequence(addRowBtn); await sleep(200); }   // toggle it shut (no Escape)
            continue;
          }
          d.clickEl(mi);
        } else {
        var preOpts = leavesWithText(typeLabel);
        d.clickEl(addRowBtn);
        await sleep(350);
        }
        if (!NEW && !clickOption(typeLabel, preOpts)) {
          failed.push(sectionLabel + ": " + item.key + " (row type '" + typeLabel + "' not offered)");
          await d.dismissMenu(); await sleep(150); continue;
        }
        await sleep(450);
        var panel = subPanel;
        // Identify the row we just added by DIFFING the panel's inputs, never by
        // counting from the end. Positional indexing broke on Body, which owns a
        // pre-existing "Content type" input, and a Variable Row contributes TWO
        // inputs (Key + the picker's own input) — so "last input" was the picker
        // and the Key was left empty. Verified live 2026-10-31.
        // The row can render late: WAIT for its inputs. Falling back to "all
        // inputs" wrote into an earlier row / Body's Content type box.
        var newInputs = function () {
          return [].slice.call(panel.querySelectorAll("input")).filter(function (x) { return d.visible(x) && beforeInputs.indexOf(x) === -1; });
        };
        var needN = (item.kind === "static" || item.kind === "jq") ? 2 : 1;
        await d.waitFor(function () { return newInputs().length >= needN; }, 3000, 150);
        var rowInputs = newInputs();
        if (!rowInputs.length) {
          failed.push(sectionLabel + ": " + item.key + " (the new " + typeLabel + " did not appear — row not written)");
          if (d.menuIsOpen()) await d.dismissMenu();
          continue;
        }
        if (item.kind === "json") {
          await writeJsonRow(sectionLabel, panel, item, rowInputs[0], beforeAreas);
        } else if (item.kind === "variable") {
          // variable row: [Key, picker-input] in DOM order — take the FIRST.
          var vKey = rowInputs[0];
          if (vKey) d.setReactInput(vKey, item.key);
          await sleep(100);
          if (vKey && d.norm(vKey.value) !== d.norm(item.key)) { d.setReactInput(vKey, item.key); await sleep(150); }
          if (!vKey || d.norm(vKey.value) !== d.norm(item.key))
            failed.push(sectionLabel + ": " + item.key + " (key did not take — reads '" + (vKey ? vKey.value : "") + "')");
          if (NEW) {
            // the row's value is the NEW combobox in this sub-panel (never another row's)
            var vCombo = null;
            await d.waitFor(function () {
              vCombo = [].slice.call(panel.querySelectorAll("button[role='combobox']")).filter(function (c) { return beforeCombos.indexOf(c) === -1 && d.visible(c); })[0] || null;
              return !!vCombo;
            }, 2000, 150);
            if (!vCombo || !(await v2PickVariable(vCombo, item)))
              pendingVariableItems.push(sectionLabel + ": " + item.key + " → " + (item.source || "custom_args") + "." + (item.variable || item.value) + " (set this variable by hand — not in the picker)");
            await sleep(150);
            continue;
          }
          // Scope the picker to THIS row. selectSearchVariable() takes the last
          // "Search variable..." on the panel, so with any other row present it
          // bound the variable to the wrong row.
          var rowEl = vKey;
          for (var rk = 0; rk < 6 && rowEl; rk++) {
            rowEl = rowEl.parentElement;
            if (rowEl && /search variable/i.test(rowEl.textContent || "")) break;
          }
          var okVar = await selectSearchVariable(rowEl || panel, item, panel);
          if (!okVar) {
            pendingVariableItems.push(sectionLabel + ": " + item.key + " → " + (item.source || "custom_args") + "." + (item.variable || item.value) + " (set this variable by hand — not in the picker)");
          }
        } else {
          // static / jq row: the two inputs this row just added, in DOM order.
          var sKey = rowInputs[0];
          var sVal = rowInputs[1];
          if (sKey) d.setReactInput(sKey, item.key);
          // static literal as-is; a jq expression adapted to this dashboard's JQ input
          var val = item.kind === "jq" ? window.MagicPort.jqForDash2(item.value).value : item.value;
          val = val == null ? "" : String(val);
          if (!sVal) {
            failed.push(sectionLabel + ": " + item.key + " (the " + typeLabel + "'s value box was not found — value not written)");
          } else {
            d.setReactInput(sVal, val);
            // read back key AND value; one more write if either did not stick
            await sleep(150);
            if (d.norm(sKey.value) !== d.norm(item.key) || sVal.value !== val) {
              if (d.norm(sKey.value) !== d.norm(item.key)) d.setReactInput(sKey, item.key);
              if (sVal.value !== val) d.setReactInput(sVal, val);
              await sleep(200);
            }
            if (d.norm(sKey.value) !== d.norm(item.key))
              failed.push(sectionLabel + ": " + item.key + " (key did not take — reads '" + sKey.value + "')");
            else if (sVal.value !== val)
              failed.push(sectionLabel + ": " + item.key + " (value did not take — reads '" + d.norm(sVal.value).slice(0, 80) + "')");
          }
        }
        await sleep(150);
      }
    }

    // ---- JSON Row (Body only) --------------------------------------------------
    // Pretty-printed when the source is valid JSON (the box is a plain textarea),
    // raw otherwise; read back and compared as parsed JSON (or as text when the
    // source does not parse). A mismatch is a failed item.
    function jsonCanon(v) {
      if (Array.isArray(v)) return "[" + v.map(jsonCanon).join(",") + "]";
      if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + jsonCanon(v[k]); }).join(",") + "}";
      return JSON.stringify(v);
    }
    function jsonParse(t) { try { return { ok: true, v: JSON.parse(String(t)) }; } catch (e) { return { ok: false }; } }
    function jsonSame(want, got) {
      var a = jsonParse(want), b = jsonParse(got);
      if (a.ok) return b.ok && jsonCanon(a.v) === jsonCanon(b.v);
      return d.norm(want) === d.norm(got);
    }
    function setTextarea(ta, v) {
      try {
        var desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
        if (desc && desc.set) desc.set.call(ta, v); else ta.value = v;
      } catch (e) { ta.value = v; }
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function jsonBoxOf(el) { return el && el.closest ? el.closest("[aria-label='{} JSON']") : null; }
    async function writeJsonRow(sectionLabel, panel, item, keyInput, beforeAreas) {
      var label = sectionLabel + ": " + item.key;
      var areas = [].slice.call(panel.querySelectorAll("textarea")).filter(function (t) { return beforeAreas.indexOf(t) === -1; });
      // prefer the textarea inside THIS row's "{} JSON" box
      var ta = null, row = keyInput;
      for (var k = 0; k < 6 && row && !ta; k++) {
        row = row.parentElement;
        if (row) ta = [].slice.call(row.querySelectorAll("[aria-label='{} JSON'] textarea")).filter(function (t) { return areas.indexOf(t) !== -1; })[0] || null;
      }
      if (!ta) ta = areas.filter(function (t) { return jsonBoxOf(t); })[0] || areas[0] || null;
      if (!keyInput || !ta) { failed.push(label + " (JSON Row fields not found)"); return; }
      d.setReactInput(keyInput, item.key);
      var raw = item.value == null ? "" : String(item.value);
      var p = jsonParse(raw);
      var text = p.ok ? JSON.stringify(p.v, null, 2) : raw;
      setTextarea(ta, text);
      await sleep(150);
      if (d.norm(keyInput.value) !== d.norm(item.key)) { failed.push(label + " (JSON Row key did not take — reads '" + keyInput.value + "')"); return; }
      if (!jsonSame(raw, ta.value)) {
        setTextarea(ta, text); await sleep(200);
        if (!jsonSame(raw, ta.value))
          failed.push(label + " (JSON value did not take — reads '" + d.norm(ta.value).slice(0, 80) + "')");
      }
    }

    // Close a left-over "+ API" modal (e.g. after a failed attempt) before retrying.
    // LIVE 2026-11-02: the drawer's "Cancel" does NOT close it when pressed from
    // script (neither click nor pointer sequence); its header "Close" (aria-label)
    // does. Try Close first, then Cancel, and confirm the drawer is gone.
    function apiDrawerOpen() {
      return [].slice.call(document.querySelectorAll("button,[role='button']"))
        .some(function (b) { return d.visible(b) && d.norm(b.textContent) === "Add to Assistance"; });
    }
    function closeOpenApiModal() {
      if (!apiDrawerOpen()) return true;
      var x = [].slice.call(document.querySelectorAll("button[aria-label='Close'],button[aria-label='close']")).filter(function (b) { return d.visible(b); })[0];
      if (x) { d.clickEl(x); if (!apiDrawerOpen()) return true; d.pressSequence(x); if (!apiDrawerOpen()) return true; }
      var c = [].slice.call(document.querySelectorAll("button,[role='button']"))
        .filter(function (b) { return d.visible(b) && d.norm(b.textContent) === "Cancel"; })[0];
      if (c) d.pressSequence(c);
      return !apiDrawerOpen();
    }
    // Close the drawer and give it ~1.5 s to go away (it animates out). Returns
    // false when it is STILL open: the caller must then never open another
    // drawer (a second "+ API" on top of a stuck form can mix two tools' rows).
    //
    // LIVE 2026-11-03: after a SUCCESSFUL "Add to Assistance" (POST 201) the
    // drawer stays open and its header Close does nothing; it goes away when
    // another top-level tab is selected. So when Close/Cancel do not take, leave
    // for "Custom Variables" and come back to Tools + the same phase. Leaving can
    // raise a "You have unsaved changes" dialog: after a successful add we press
    // its Save; for a failed attempt we look for a discard-type button, and when
    // there is none we cancel the dialog and stop (stuck drawer).
    var drawerStuck = false;
    var STUCK_MSG = "the tool form could not be closed — reload the page and re-run";
    var NAV_MSG = "the Tools tab could not be re-opened after closing the tool form — reload the page and re-run";
    var stuckWhy = STUCK_MSG;
    var curPhase = null;
    var DISCARD_RE = /^(discard( changes)?|leave( anyway| page| without saving)?|don'?t save|do not save|continue without saving)$/i;
    var CANCEL_RE = /^(cancel|stay( on (this )?page)?|keep editing|go back)$/i;
    function unsavedDialog() {
      return [].slice.call(document.querySelectorAll("[role='dialog'],[role='alertdialog']"))
        .filter(function (x) {
          if (!d.visible(x) || !/unsaved changes/i.test(x.textContent || "")) return false;
          return ![].slice.call(x.querySelectorAll("button,[role='button']")).some(function (b) { return d.norm(b.textContent) === "Add to Assistance"; });
        })
        .sort(function (a, b) { return (a.textContent || "").length - (b.textContent || "").length; })[0] || null;
    }
    function dialogButton(dlg, re) {
      return [].slice.call(dlg.querySelectorAll("button,[role='button']"))
        .filter(function (b) { return d.visible(b) && re.test(d.norm(b.textContent || b.getAttribute("aria-label") || "")); })[0] || null;
    }
    // Answer an "unsaved changes" dialog. Returns true when it was answered with
    // Save (success) / a discard button (failure); false when it had to be cancelled.
    async function answerUnsaved(dlg, success) {
      var btn = success ? dialogButton(dlg, /^save( changes)?$/i) : dialogButton(dlg, DISCARD_RE);
      if (!btn) {
        var c = dialogButton(dlg, CANCEL_RE) ||
          [].slice.call(dlg.querySelectorAll("button[aria-label='Close'],button[aria-label='close']")).filter(function (b) { return d.visible(b); })[0];
        if (c) d.pressSequence(c);
        await d.waitFor(function () { return !unsavedDialog(); }, 2000, 200);
        toolNotes.push("Closing the tool form raised an unsaved-changes dialog with no " + (success ? "Save" : "discard") + " button — it was cancelled.");
        return false;
      }
      d.pressSequence(btn);
      await d.waitFor(function () { return !unsavedDialog(); }, 4000, 200);
      return !unsavedDialog();
    }
    async function closeByTabSwitch(success) {
      // New UI: no unsaved-changes dialog; leave via the sidebar and come back.
      if (NEW) { if (!(await v2RefreshList())) return false; await sleep(200); return !apiDrawerOpen(); }
      var away = DASH2_TABS.variables;
      var left = await gotoTab(away, { budgetMs: 2000 });
      var dlg = unsavedDialog();
      if (dlg) {
        if (!(await answerUnsaved(dlg, success))) return false;
        if (currentTopTab() !== away) left = await gotoTab(away);
      }
      if (!left && currentTopTab() !== away) return false;
      await sleep(300);
      if (!(await gotoTab(DASH2_TABS.tools))) { stuckWhy = NAV_MSG; return false; }
      var dlg2 = unsavedDialog();
      if (dlg2 && !(await answerUnsaved(dlg2, success))) return false;
      if (curPhase && !(await selectPhase(curPhase))) { stuckWhy = NAV_MSG; return false; }
      await sleep(200);
      return !apiDrawerOpen();
    }
    // mode: "success" (the tool was created) or "discard" (a failed / leftover form).
    async function closeDrawerSafely(mode) {
      if (!apiDrawerOpen()) return true;
      closeOpenApiModal();
      for (var w = 0; w < 6; w++) {
        if (!apiDrawerOpen()) return true;
        await sleep(250);
        if (w === 2 && apiDrawerOpen()) closeOpenApiModal();   // one more try midway
      }
      if (!apiDrawerOpen()) return true;
      if (await closeByTabSwitch(mode === "success")) return true;
      drawerStuck = true;
      return false;
    }

    // ------- tool Settings sub-tab (timeout / enabled) -------------------------
    // A tool can carry a timeout (2-field source: raw.timeout_ms, from
    // config.timeout in ms; a 5-field tool may carry its own timeout field)
    // and an enabled flag. LIVE 2026-11-03: the timeout is on the drawer's
    // "Settings" sub-tab as "Timeout (seconds)" (the API stores ms: 10000 -> 10);
    // enabled is the tools list's "Enable API <name>" switch. A missing control
    // is a NOTE, never a failure; a control that is found but does not take IS.
    var toolNotes = [];
    function toolSettingsWanted(tool) {
      var raw = (tool && tool.raw) || tool || {};
      var cfg = (raw && raw.config && typeof raw.config === "object") ? raw.config : {};
      var ms = null;
      function num(v) { var n = Number(v); return (v !== null && v !== undefined && v !== "" && isFinite(n) && n > 0) ? n : null; }
      var msKeys = ["timeout_ms", "timeoutMs", "timeout_in_ms"];
      var secKeys = ["timeout_sec", "timeout_seconds", "timeoutSeconds", "timeout_in_seconds"];
      [raw, cfg].forEach(function (o) {
        if (ms !== null) return;
        msKeys.forEach(function (k) { if (ms === null && num(o[k]) !== null) ms = num(o[k]); });
        secKeys.forEach(function (k) { if (ms === null && num(o[k]) !== null) ms = num(o[k]) * 1000; });
        // a bare "timeout": the 2-field API stores ms (10000); a small number is seconds
        if (ms === null && num(o.timeout) !== null) ms = num(o.timeout) >= 100 ? num(o.timeout) : num(o.timeout) * 1000;
      });
      var en = typeof raw.is_enabled === "boolean" ? raw.is_enabled
             : typeof raw.enabled === "boolean" ? raw.enabled
             : (tool && typeof tool.enabled === "boolean") ? tool.enabled : null;
      return { timeoutMs: ms, enabled: en };
    }
    // The block under a label inside the Settings panel: climb from the label to
    // the first ancestor that holds a control of the wanted kind.
    function settingsBlock(panel, labelRe, has) {
      var labels = [].slice.call(panel.querySelectorAll("label,span,div,p,h3,h4,h5,h6"))
        .filter(function (e) {
          if (!d.visible(e)) return false;
          var t = d.norm(e.textContent);
          if (!t || t.length > 60 || !labelRe.test(t)) return false;
          return ![].slice.call(e.children).some(function (c) { return labelRe.test(d.norm(c.textContent)); });
        });
      for (var i = 0; i < labels.length; i++) {
        var node = labels[i];
        for (var k = 0; k < 5 && node && node !== panel.parentElement; k++) {
          if (has(node)) return { box: node, label: d.norm(labels[i].textContent) };
          node = node.parentElement;
        }
      }
      return null;
    }
    // LIVE 2026-11-03: div[role=textbox][aria-label="Timeout (seconds)"] holding an
    // <input type=number min=1>. Anchor on that aria-label first; the label-text
    // fallback is anchored at the start so "On timeout or connection failure"
    // (a dropdown on the same tab) is never taken for it.
    function timeoutBlock(panel) {
      if (NEW) {
        // input[type=number][aria-labelledby=L], #L = "Timeout (seconds)" (live 2026-11-05)
        var tIn = [].slice.call(panel.querySelectorAll("input[type='number'][aria-labelledby]")).filter(function (i) {
          var l = document.getElementById(i.getAttribute("aria-labelledby").split(/\s+/)[0]);
          return d.visible(i) && !!l && /^time\s*-?\s*out\b/i.test(d.norm(l.textContent));
        })[0];
        if (tIn && tIn.parentElement && valueInputIn(tIn.parentElement) === tIn)
          return { box: tIn.parentElement, label: d.norm(document.getElementById(tIn.getAttribute("aria-labelledby").split(/\s+/)[0]).textContent) };
      }
      var byAria = [].slice.call(panel.querySelectorAll("[aria-label]")).filter(function (e) {
        return d.visible(e) && /^time\s*-?\s*out\b/i.test(d.norm(e.getAttribute("aria-label"))) && !!valueInputIn(e);
      })[0];
      if (byAria) return { box: byAria, label: d.norm(byAria.getAttribute("aria-label")) };
      return settingsBlock(panel, /^(request\s+)?time\s*-?\s*out\b/i, function (n) { return !!(valueInputIn(n) || dropdownIn(n) || sliderIn(n)); });
    }
    // Unit the timeout box shows: "ms" or "s". From its label/unit text first,
    // else from the value it shows now (>= 100 can only be ms).
    function timeoutUnit(blk) {
      var t = (d.norm(blk.label) + " " + d.norm(blk.box.textContent)).toLowerCase();
      if (/\bms\b|milli/.test(t)) return "ms";
      if (/\bsec|\bseconds?\b|\(s\)|\bs\b/.test(t)) return "s";
      var cur = Number(readNumberIn(blk.box));
      if (isFinite(cur) && cur >= 100) return "ms";
      if (isFinite(cur) && cur > 0) return "s";
      return "ms";
    }
    // Only the timeout lives on the Settings tab (LIVE 2026-11-03: Retry count,
    // Block call on status codes and On failure are not part of the stored tool
    // config, and there is no enabled switch there -- see applyListEnabled).
    async function applyToolSettings(name, want) {
      if (want.timeoutMs === null) return;
      var panel = await openSubTab("Settings");
      if (!panel) {
        toolNotes.push("Tool '" + name + "': Settings tab not found — timeout not set; check it by hand.");
        return;
      }
      await sleep(200);
      var blk = timeoutBlock(panel);
      if (!blk) { toolNotes.push("Tool '" + name + "': no timeout control on this dashboard — timeout " + want.timeoutMs + " ms not migrated."); return; }
      var unit = timeoutUnit(blk);
      var shown = want.timeoutMs;
      if (unit !== "ms") {
        // the box takes whole seconds (min 1): 10000 ms -> 10
        shown = Math.max(1, Math.round(want.timeoutMs / 1000));
        if (shown * 1000 !== want.timeoutMs)
          toolNotes.push("Tool '" + name + "': timeout " + want.timeoutMs + " ms rounded to " + shown + " s (the box takes whole seconds).");
      }
      var getBox = function () { var b = timeoutBlock(panel); return b ? b.box : null; };
      var okT = await setNumberIn(getBox, shown);
      var back = readNumberIn(getBox());
      if (!okT || !numEq(back, shown))
        failed.push("Tool '" + name + "': timeout → " + shown + " " + unit + " (did not take; reads '" + (back === null ? "empty" : back) + "')");
    }
    // Enabled is the tools LIST's switch (role=switch, aria-label "Enable API
    // <name>"), LIVE 2026-11-03. New tools default on, so only a source tool that
    // was disabled needs anything: turn it off once the tool exists, read back.
    function listSwitch(name) {
      var want = "enable api " + d.norm(name).toLowerCase(), want2 = "enable tool " + d.norm(name).toLowerCase();
      var find = function (scope) {
        return [].slice.call(scope.querySelectorAll("[role='switch'][aria-label],input[type='checkbox'][aria-label]"))
          .filter(function (e) { var a = d.norm(e.getAttribute("aria-label")).toLowerCase(); return d.visible(e) && (a === want || a === want2); })[0] || null;
      };
      return find(phasePanel()) || find(document);
    }
    async function applyListEnabled(name, want) {
      if (want.enabled !== false) return;
      var getSw = function () { return listSwitch(name); };
      if (!getSw()) {
        await d.waitFor(function () { return !!getSw(); }, 3000, 250);
        if (!getSw()) { toolNotes.push("Tool '" + name + "': was disabled on the source, but its 'Enable API " + name + "' switch was not found — it is created enabled; turn it off by hand."); return; }
      }
      var okE = await setSwitch(getSw, false);
      if (okE) await d.waitFor(function () { return switchOn(getSw()) === false; }, 2000, 250);
      if (switchOn(getSw()) !== false)
        failed.push("Tool '" + name + "': enabled → off (the 'Enable API " + name + "' switch did not take; turn it off by hand)");
    }

    var lastToolError = "";
    // Per tool (reset in the loop below): an "Add to Assistance" was pressed for
    // THIS tool and the dashboard showed no sign of refusing it. Such a tool is
    // never submitted again: its row is WAITED for instead (same rule as the
    // `submitted` flag in dash2Events). LIVE 2026-11-03: pp_probe_json was
    // created TWICE -- the list had not shown the first row within 6 s, the
    // drawer stays open after a successful add, so the attempt read as a refusal
    // and withRetry ran addTool again, which created the same tool a second time.
    var toolSubmitted = false;
    var toolRefused = false;   // new UI, per tool: the server refused it (not re-sent)
    var toolAlready = false;   // new UI, per tool: its snake_cased name was already listed
    var toolEverSent = false;  // new UI, per tool: this run pressed "Add to Assistance" for it
    var SUBMITTED_MSG = "submitted, but it did not appear in the tools list — check the Tools tab by hand (not re-submitted, to avoid a duplicate)";
    // Error-looking text in the drawer; compared before/after the submit so a
    // static label (e.g. "Required") is never read as a refusal.
    function drawerErrorTexts() {
      var out = [];
      [].slice.call(document.querySelectorAll("p,span,div,li")).forEach(function (e) {
        if (e.children.length || !d.visible(e)) return;
        var t = d.norm(e.textContent);
        if (t.length > 3 && t.length < 160 && /(required|invalid|error|failed|must|not allowed|already exists|unable|^select (a|an|the) |please (select|choose|enter))/i.test(t) && out.indexOf(t) === -1) out.push(t);
      });
      return out;
    }
    async function addTool(parts, tool) {
      if (NEW && toolRefused) return;   // the server refused this exact tool: retrying sends the same refusal
      lastToolError = "";
      if (drawerStuck) return;   // never open a drawer over a stuck one
      if (toolSubmitted) {
        // A sent add whose row has not rendered yet must be WAITED for, never re-sent.
        // New UI: the list only refreshes when the section is re-entered.
        if (NEW && !apiDrawerOpen() && !toolExists(parts.name) && !(await v2RefreshList())) { drawerStuck = true; lastToolError = stuckWhy; return; }
        await d.waitFor(function () { return toolExists(parts.name); }, 10000, 250);
        if (toolExists(parts.name)) {
          if (apiDrawerOpen() && !(await closeDrawerSafely("success"))) lastToolError = stuckWhy;
          return;
        }
        lastToolError = SUBMITTED_MSG;
        if (apiDrawerOpen() && !(await closeDrawerSafely("discard"))) lastToolError += "; " + stuckWhy;
        return;
      }
      // On a retry the tool may have been created by the previous attempt and
      // simply not rendered yet -- re-read once after a settle before adding.
      if (toolExists(parts.name)) return;
      await sleep(400);
      if (toolExists(parts.name)) return;
      if (!(await closeDrawerSafely("discard"))) { lastToolError = stuckWhy; return; }
      await sleep(150);
      // The control's textContent is "API" (the + is an SVG icon); matching the
      // literal "+ API" silently failed. Accept either. Verified live 2026-10-31.
      if (NEW) {
        if (!(await v2OpenDrawer())) {
          lastToolError = "the tool form did not open";
          if (apiDrawerOpen() && !(await closeDrawerSafely("discard"))) lastToolError = stuckWhy;
          return;
        }
      } else {
      var addApi = [].slice.call(document.querySelectorAll("button,[role='button']"))
        .filter(function (b) { return d.visible(b) && /^\+?\s*API$/i.test(d.norm(b.textContent)); })[0];
      if (!addApi) return;
      d.clickEl(addApi);
      await sleep(900);
      }
      var nm = formNameInput(); if (nm) d.setReactInput(nm, parts.name);
      if (NEW) {
        // the app snake-cases the name live: what it shows is what it stores
        await sleep(150);
        if (!nm || !d.norm(nm.value)) {
          lastToolError = "the tool name could not be typed";
          if (!(await closeDrawerSafely("discard"))) lastToolError = stuckWhy;
          return;
        }
        if (d.norm(nm.value) !== parts.name) {
          toolNotes.push("Tool '" + parts.name + "' is saved as '" + d.norm(nm.value) + "' (the dashboard stores names in snake_case).");
          parts.name = d.norm(nm.value);
          if (toolExists(parts.name)) { toolAlready = true; if (!(await closeDrawerSafely("discard"))) lastToolError = stuckWhy; return; }
        }
      }
      var uu = urlInput(); if (uu) d.setReactInput(uu, parts.url);
      // Method. The control is a READ-ONLY <input> (so it cannot be typed into)
      // sitting inside a div[role=button][aria-expanded]; pressing it opens
      // Post / Get / Put / Patch / Delete in Title case. Verified live
      // 2026-10-31.
      //
      // ALWAYS set it, and verify. The old code only drove the dropdown when the
      // method differed from POST, trusting the form to default to Post -- the
      // same unchecked assumption that made every Custom Analysis key fail. A
      // wrong verb here is worse than a missing row: the tool still looks
      // complete but calls the endpoint the wrong way.
      var wantMethod = d.norm(parts.method || "POST").toUpperCase();
      var wantLabel = wantMethod.charAt(0) + wantMethod.slice(1).toLowerCase();   // GET -> "Get"
      var methodOk = false;
      if (NEW) methodOk = await v2SetMethod(wantLabel);
      for (var ma = 0; ma < 3 && !methodOk && !NEW; ma++) {
        var mt = methodTrigger();
        if (!mt) break;
        if (d.norm(mt.value).toUpperCase() === wantMethod) { methodOk = true; break; }
        await d.setSingleDropdown(mt, wantLabel, function () {
          var t = methodTrigger(); return t ? t.value : null;
        });
        await sleep(250);
        var after = methodTrigger();
        methodOk = !!after && d.norm(after.value).toUpperCase() === wantMethod;
      }
      if (!methodOk) {
        // addTool runs under withRetry, so record the reason rather than pushing
        // (pushing here would log the same failure up to three times).
        lastToolError = "method could not be set to " + wantMethod;
        if (!(await closeDrawerSafely("discard"))) lastToolError = stuckWhy;
        await sleep(200);
        return;
      }
      lastToolError = "";
      // All four parameter sections use the same row model; Body additionally
      // offers "JSON Row" (LIVE 2026-11-03).
      await addRowKV("Headers", parts.headers);
      await addRowKV("Query", parts.query);
      await addRowKV("Path", parts.path);
      var urlExpect = parts.url;
      if (NEW && (parts.path || []).length) {
        // New UI: each Path row appends {{name}} to the API URL.
        var uNow = urlInput();
        if (uNow && d.norm(uNow.value) !== d.norm(parts.url)) {
          urlExpect = d.norm(uNow.value);
          toolNotes.push("Tool '" + parts.name + "': its Path rows add {{name}} placeholders to the URL on this dashboard — the URL now reads '" + urlExpect + "'; check it by hand.");
        }
      }
      await addRowKV("Body", parts.body);
      await applyToolSettings(parts.name || "(unnamed)", toolSettingsWanted(tool));
      // Last look right before the create: a lagging row from an earlier
      // attempt (or another writer) may have appeared while the form was filled.
      if (toolExists(parts.name)) {
        if (!(await closeDrawerSafely("discard"))) lastToolError = stuckWhy;
        return;
      }
      if (NEW) {
        // Saves instantly. OK = toast "API added" and the drawer closes itself;
        // refused = a short server toast (~3 s) with the drawer still open.
        // The list does NOT refresh after a create: re-enter the section to read it.
        var dlgN = v2Drawer();
        var subBtn = dlgN && ([].slice.call(dlgN.querySelectorAll("button[type='submit']")).filter(function (b) { return d.norm(b.textContent) === "Add to Assistance"; })[0]
          || [].slice.call(dlgN.querySelectorAll("button")).filter(function (b) { return d.norm(b.textContent) === "Add to Assistance"; })[0]);
        if (!subBtn) {
          lastToolError = "the 'Add to Assistance' button was not found";
          if (!(await closeDrawerSafely("discard"))) lastToolError = stuckWhy;
          return;
        }
        var tBefore = v2SonnerToasts(), seen = [], okT = false, closedN = false, otherAt = 0;
        d.clickEl(subBtn);
        toolSubmitted = true; toolEverSent = true;
        for (var tw = 0; tw < 50; tw++) {
          await sleep(200);
          v2SonnerToasts().forEach(function (t) {
            if (tBefore.indexOf(t) !== -1) return;
            var tx = d.norm(t.textContent); if (tx && seen.indexOf(tx) === -1) seen.push(tx);
          });
          okT = seen.some(function (t) { return /\bAPI added\b/i.test(t); });
          closedN = !apiDrawerOpen();
          if (okT || closedN) break;
          if (seen.length && !otherAt) otherAt = tw;
          if (otherAt && tw - otherAt >= 5) break;   // a refusal toast and the drawer stays open
        }
        if (!okT && !closedN) {
          var nmN = formNameInput(), uuN = urlInput();
          var holds = !!nmN && d.norm(nmN.value) === d.norm(parts.name) && (!uuN || d.norm(uuN.value) === d.norm(urlExpect));
          if (seen.length && holds) {
            // Refused by the server: say why, and never send the same tool again.
            toolSubmitted = false; toolRefused = true;
            lastToolError = "the dashboard refused the tool: " + seen.slice(0, 2).join("; ");
            if (!(await closeDrawerSafely("discard"))) lastToolError += "; " + stuckWhy;
            return;
          }
          // No confirmation and the form is still open: close it and look at
          // the refreshed list; never re-submit (toolSubmitted stays true).
          if (!(await closeDrawerSafely("discard"))) { lastToolError = stuckWhy; return; }
        }
        if (!(await v2RefreshList())) { drawerStuck = true; lastToolError = stuckWhy; return; }
        await d.waitFor(function () { return toolExists(parts.name); }, 4000, 250);
        lastToolError = toolExists(parts.name) ? "" : SUBMITTED_MSG;
        return;
      }
      var errBefore = drawerErrorTexts();
      toolSubmitted = !!d.clickButtonByText("Add to Assistance");
      // WAIT for the tool row to appear before the attempt ends. The tools list
      // lags its own backend exactly as the subscription list does, and lags
      // more as rows accumulate -- so a blind sleep let the verify read a stale
      // panel, report "not created", and the retry added the SAME tool again.
      // Same defect class as the webhook duplicated on the 4th hook.
      await d.waitFor(function () { return toolExists(parts.name); }, 6000, 250);
      await sleep(300);
      if (toolExists(parts.name)) {
        // Created. LIVE 2026-11-03: the drawer stays open after a successful add;
        // close it now (tab round-trip if needed) so the next tool starts clean.
        if (apiDrawerOpen() && !(await closeDrawerSafely("success"))) lastToolError = stuckWhy;
        return;
      }
      if (apiDrawerOpen()) {
        // Refused only on EVIDENCE: a field marked invalid, or an error line
        // that was not there before the submit. The drawer also stays open
        // after a SUCCESSFUL add (live 2026-11-03), so "still open" alone is
        // not a refusal -- treating it as one is how a slow list produced a
        // duplicate tool.
        var why = [];
        [].slice.call(document.querySelectorAll("[aria-invalid='true']")).forEach(function (f) {
          if (d.visible(f)) why.push((f.getAttribute("aria-label") || "a field") + " marked invalid");
        });
        var invalidN = why.length;
        var errNew = drawerErrorTexts().filter(function (t) { return errBefore.indexOf(t) === -1; });
        errNew.forEach(function (t) { if (why.indexOf(t) === -1) why.push(t); });
        // A form that RESET after a successful add can show a validation line
        // ("Name is required") on its now-empty fields. That is not a refusal:
        // only a form that still holds what we submitted can have refused it.
        var nmNow = formNameInput(), uuNow = urlInput();
        var holdsSubmitted = !!nmNow && d.norm(nmNow.value) === d.norm(parts.name) &&
          (!uuNow || d.norm(uuNow.value) === d.norm(parts.url));
        if ((invalidN || errNew.length) && holdsSubmitted) {
          // The dashboard refused the tool: say WHY, close the drawer so the
          // retry starts clean, and allow that retry to submit again.
          toolSubmitted = false;
          lastToolError = "the dashboard did not accept the tool" + (why.length ? ": " + why.slice(0, 3).join("; ") : "");
          if (!(await closeDrawerSafely("discard"))) lastToolError += "; " + stuckWhy;
          await sleep(300);
          return;
        }
      }
      // No refusal seen, no row yet: the next attempt waits for it (toolSubmitted).
      lastToolError = toolSubmitted ? SUBMITTED_MSG : "the 'Add to Assistance' button was not found";
    }

    // The row that lists an existing tool (the smallest block around its
    // "Edit API <name>" control), as spaced text without the name itself.
    // Returns { text, leaves }: text = the row's spaced text with nothing cut
    // out (URLs are read from it); leaves = the row's own text pieces other than
    // the tool's name. The row is bounded: its li / row element, else at most a
    // few wrappers up, never the phase panel or anything above it (with one tool
    // listed, an unbounded climb took in the phase tabs: "Post Call" read as POST).
    function toolRowText(name) {
      var want = d.norm(name);
      var panel = phasePanel();
      var btn = [].slice.call(panel.querySelectorAll("[aria-label]")).filter(function (e) { return rowLabelIs(d.norm(e.getAttribute("aria-label")), "Edit", want); })[0];
      if (!btn) return { text: "", leaves: [] };
      var row = btn.closest("li,[role='row'],tr");
      if (!row || row === panel || row.contains(panel) || !panel.contains(row)) {
        row = btn;
        for (var k = 0; k < 5 && row.parentElement; k++) {
          var p = row.parentElement;
          if (p === panel || p.contains(panel) || p === document.body) break;
          if (p.querySelector("[role='tab'],[role='tablist']")) break;
          if (p.querySelectorAll("[aria-label^='Edit API '],[aria-label^='Edit tool ']").length > 1) break;
          row = p;
        }
      }
      var leaves = [], w = document.createTreeWalker(row, 4 /* SHOW_TEXT */, null, false), n;
      while ((n = w.nextNode())) {
        var s = d.norm(n.nodeValue);
        if (s && s !== want) leaves.push(s);
      }
      return { text: spacedText(row), leaves: leaves };
    }
    function normUrl(u) { return d.norm(u).replace(/\/+$/, "").toLowerCase(); }
    // Compare an already-listed tool with the source: URL / method when the
    // list shows them. Returns { same: true|false|null, why }.
    function compareExisting(parts) {
      var rt = toolRowText(parts.name), t = rt.text;
      var URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/ig;
      var urls = t.match(URL_RE) || [];
      // Method: a text piece that IS a method; else a standalone upper-case
      // token outside every URL ("/v1/delete-account" is not DELETE).
      var meth = null;
      rt.leaves.forEach(function (s) { var m = !meth && s.match(/^(GET|POST|PUT|PATCH|DELETE)$/i); if (m) meth = m[1]; });
      if (!meth) {
        var rest = " " + rt.leaves.join(" ").replace(URL_RE, " ") + " ";
        meth = (rest.match(/\s(GET|POST|PUT|PATCH|DELETE)(?=\s)/) || [])[1] || null;
      }
      var diffs = [], readable = false;
      if (urls.length) {
        readable = true;
        if (!urls.some(function (u) { return normUrl(u) === normUrl(parts.url); })) diffs.push("URL: has " + urls[0] + ", source " + parts.url);
      }
      if (meth) {
        readable = true;
        if (meth.toUpperCase() !== d.norm(parts.method || "POST").toUpperCase()) diffs.push("method: has " + meth.toUpperCase() + ", source " + d.norm(parts.method || "POST").toUpperCase());
      }
      return { same: readable ? !diffs.length : null, why: diffs.join("; ") };
    }
    // New UI: the list row shows the method and only scheme+host, so read the
    // full URL and method from the tool's Edit form (closed with Cancel, nothing
    // saved); fall back to the row (method + origin) when the form won't open.
    function originOf(u) { try { return new URL(d.norm(u)).origin.toLowerCase(); } catch (e) { return normUrl(u); } }
    async function v2CompareExisting(parts) {
      var wantM = d.norm(parts.method || "POST").toUpperCase(), diffs = [];
      var want = d.norm(parts.name);
      var edit = [].slice.call(phasePanel().querySelectorAll("button[aria-label]")).filter(function (e) { return rowLabelIs(d.norm(e.getAttribute("aria-label")), "Edit", want); })[0];
      if (edit && !apiDrawerOpen()) {
        d.clickEl(edit);
        await d.waitFor(function () { return !!v2Drawer() && !!urlInput() && !!methodTrigger(); }, 4000, 200);
        var u = urlInput(), m = methodTrigger();
        var gotU = u ? d.norm(u.value) : null, gotM = m ? d.norm(m.textContent).toUpperCase() : null;
        if (apiDrawerOpen() && !(await closeDrawerSafely("discard"))) return { same: null, why: stuckWhy };
        if (gotU !== null && gotM) {
          if (normUrl(gotU) !== normUrl(parts.url)) diffs.push("URL: has " + gotU + ", source " + parts.url);
          if (gotM !== wantM) diffs.push("method: has " + gotM + ", source " + wantM);
          return { same: !diffs.length, why: diffs.join("; ") };
        }
      }
      var li = edit && edit.closest("li");
      var mEl = li && li.querySelector("[data-tone]"), uEl = li && li.querySelector("span[title^='http']");
      var readable = false;
      if (uEl) { readable = true; if (originOf(uEl.getAttribute("title")) !== originOf(parts.url)) diffs.push("URL: has " + uEl.getAttribute("title") + ", source " + parts.url); }
      if (mEl && /^(GET|POST|PUT|PATCH|DELETE)$/i.test(d.norm(mEl.textContent))) {
        readable = true;
        if (d.norm(mEl.textContent).toUpperCase() !== wantM) diffs.push("method: has " + d.norm(mEl.textContent).toUpperCase() + ", source " + wantM);
      }
      if (readable && !diffs.length)
        toolNotes.push("Tool '" + parts.name + "' was already on the destination; only its method and host could be compared — check its full URL by hand.");
      return { same: readable ? !diffs.length : null, why: diffs.join("; ") };
    }
    function listedNames() {
      var out = [];
      [].slice.call(phasePanel().querySelectorAll("[aria-label^='Edit API '],[aria-label^='Edit tool ']")).forEach(function (e) {
        var n = d.norm(e.getAttribute("aria-label")).replace(/^Edit (API|tool)\s+/, "");
        if (n && out.indexOf(n) === -1) out.push(n);
      });
      return out;
    }

    for (var pi = 0; pi < PHASES.length; pi++) {
      var phase = PHASES[pi];
      var list = tools[phase] || []; if (!list.length) continue;
      curPhase = phase;
      if (d.isAuthRedirect()) return authStop("tools");
      // The phase tabs are Radix tab triggers too: clickButtonByText() uses
      // .click(), which does NOT switch them. The loop then stayed on whatever
      // phase was already selected and wrote that phase's tools into it —
      // observed live: "greetings" (pre_call) was added under On call.
      // Select by role=tab + verify aria-selected, exactly like the sub-tabs.
      var phasePanelEl = await selectPhase(phase);
      if (!phasePanelEl) {
        list.forEach(function (t) {
          failed.push(PHASE_TAB[phase] + ": " + toolLabel(t) + " (phase tab not selectable)");
        });
        continue;
      }
      await sleep(400);
      // the phase's list loads lazily the first time it is shown; until it has,
      // nothing is created (an unseen existing tool would be duplicated)
      if (NEW && !(await v2ListLoaded())) {
        list.forEach(function (t) { failed.push(PHASE_TAB[phase] + ": " + toolLabel(t) + " (not created — the tools list didn't load; check Tools by hand)"); });
        continue;
      }
      if (phaseUnavailable()) {
        list.forEach(function (t) { failed.push(PHASE_TAB[phase] + ": " + toolLabel(t) + " (phase not supported on destination)"); });
        continue;
      }
      // What this phase listed before the run: those are never "created" here.
      var listedBefore = listedNames();
      var srcNames = list.map(function (t) { var pp = window.MagicPort.extractToolParts(t); return pp && (NEW ? v2Snake(pp.name) : pp.name); });
      listedBefore.forEach(function (n) { if (srcNames.indexOf(n) === -1) leftovers.push("Tool (" + PHASE_TAB[phase] + "): " + n); });
      var phaseCreated = [], pendingTools = [], handledNames = [];
      for (var ti = 0; ti < list.length; ti++) {
        if (drawerStuck) {
          // A stuck tool form: opening another drawer on top of it could mix
          // two tools' rows. Skip everything left and say why.
          failed.push(PHASE_TAB[phase] + ": " + toolLabel(list[ti]) + " (skipped — " + stuckWhy + ")");
          continue;
        }
        var parts = window.MagicPort.extractToolParts(list[ti]);
        var toolSrc = list[ti];
        // A URL with no scheme is refused by the dashboard ("api_url marked
        // invalid"): add https:// (mapForDestination already does this for a
        // full run; this covers a direct call) and say so.
        if (window.MagicPort.dash2ToolUrl) {
          var fxu = window.MagicPort.dash2ToolUrl(parts.url);
          if (fxu.added) {
            toolNotes.push(window.MagicPort.dash2ToolUrlNote(parts.name, String(parts.url).trim(), fxu.url));
            parts.url = fxu.url;
          }
        }
        if (NEW) {
          // The dashboard stores the name snake_cased: dedupe/compare on that.
          var snk = v2Snake(parts.name);
          if (snk && snk !== parts.name) {
            toolNotes.push("Tool '" + parts.name + "' is saved as '" + snk + "' (the dashboard stores names in snake_case).");
            parts.name = snk;
          }
          // A GET/DELETE tool with a body is refused by the server
          // ("config.body is not allowed for GET/DELETE"): create it without one.
          if (/^(GET|DELETE)$/.test(d.norm(parts.method || "POST").toUpperCase()) && (parts.body || []).length) {
            parts.body.forEach(function (it) {
              failed.push(PHASE_TAB[phase] + ": " + parts.name + " — Body: " + it.key + " (a " + d.norm(parts.method).toUpperCase() + " tool can't carry a body on this dashboard — not written)");
            });
            parts.body = [];
          }
          // The drawer adds "Content-Type: application/json" itself (Body "Content
          // type") and never lists it as a Headers row: don't add a second one.
          parts.headers = (parts.headers || []).filter(function (it) {
            var auto = it.kind === "static" && /^content-type$/i.test(d.norm(it.key)) && /^application\/json$/i.test(d.norm(it.value));
            if (auto) toolNotes.push("Tool '" + parts.name + "': its Content-Type: application/json header is set by the dashboard itself (Body → Content type) — not added as a Headers row.");
            return !auto;
          });
        }
        // The same name twice in the source: only the first can exist here.
        if (handledNames.indexOf(parts.name) !== -1) {
          toolNotes.push("The source has more than one " + PHASE_TAB[phase] + " tool named '" + parts.name + "' — only the first was migrated.");
          failed.push(PHASE_TAB[phase] + ": " + parts.name + " (a second source tool with the same name" + (parts.url ? ", " + parts.url : "") + " — not created)");
          continue;
        }
        handledNames.push(parts.name);
        // Already on the destination before this run: compare, never overwrite.
        if (listedBefore.indexOf(d.norm(parts.name)) !== -1) {
          var cmp = NEW ? await v2CompareExisting(parts) : compareExisting(parts);
          if (cmp.same === false) {
            failed.push(PHASE_TAB[phase] + ": " + parts.name + " (already exists with a different setup — not changed; " + cmp.why + ")");
          } else {
            alreadyPresent++;
            if (cmp.same === null)
              toolNotes.push("Tool '" + parts.name + "' was already on the destination and was left as is — its URL/method are not shown in the list, so check it matches the source by hand.");
          }
          continue;
        }
        toolSubmitted = false;   // per tool
        toolRefused = false; toolAlready = false; toolEverSent = false;
        var r = await withRetry(function () { return addTool(parts, toolSrc); }, function () { return drawerStuck || toolAlready || toolRefused || toolExists(parts.name); }, 3);
        if (r.auth) return authStop("tools");
        if (NEW && r.ok && !toolEverSent && !drawerStuck && !toolRefused && toolExists(parts.name)) {
          // Listed without this run sending it (the list showed it late): an
          // existing tool — compare it, never count it as created.
          var cmpL = await v2CompareExisting(parts);
          if (cmpL.same === false) failed.push(PHASE_TAB[phase] + ": " + parts.name + " (already exists with a different setup — not changed; " + cmpL.why + ")");
          else {
            alreadyPresent++;
            if (cmpL.same === null) toolNotes.push("Tool '" + parts.name + "' was already on the destination and was left as is — its URL/method are not shown in the list, so check it matches the source by hand.");
          }
          await sleep(200);
          continue;
        }
        if (toolAlready) { alreadyPresent++; toolNotes.push("Tool '" + parts.name + "' was already on the destination and was left as is — check it matches the source by hand."); await sleep(200); continue; }
        if (toolRefused) { failed.push(PHASE_TAB[phase] + ": " + parts.name + " (" + lastToolError + ")"); await sleep(200); continue; }
        if (r.ok && (!drawerStuck || toolExists(parts.name))) {
          created++; phaseCreated.push(parts.name);
          await applyListEnabled(parts.name || "(unnamed)", toolSettingsWanted(toolSrc));
        }
        else if (toolSubmitted && !drawerStuck && lastToolError === SUBMITTED_MSG) {
          // sent, not listed yet: decided after a longer settle below (never re-sent)
          pendingTools.push({ name: parts.name, src: toolSrc });
        }
        else failed.push(PHASE_TAB[phase] + ": " + (parts.name || "(unnamed)") +
                         (drawerStuck ? " (" + stuckWhy + ")" : lastToolError ? " (" + lastToolError + ")" : ""));
        await sleep(200);
      }
      if (pendingTools.length) {
        if (NEW) {
          // the list only refreshes on re-entering the section: once now, once more later
          if (await v2RefreshList()) await d.waitFor(function () { return pendingTools.every(function (p) { return toolExists(p.name); }); }, 6000, 500);
          if (!pendingTools.every(function (p) { return toolExists(p.name); })) await v2RefreshList();
        }
        await d.waitFor(function () { return pendingTools.every(function (p) { return toolExists(p.name); }); }, 15000, 500);
        for (var pt = 0; pt < pendingTools.length; pt++) {
          var pTool = pendingTools[pt];
          if (toolExists(pTool.name)) {
            created++; phaseCreated.push(pTool.name);
            await applyListEnabled(pTool.name, toolSettingsWanted(pTool.src));
          } else failed.push(PHASE_TAB[phase] + ": " + pTool.name + " (" + SUBMITTED_MSG + ")");
        }
      }
      // A tool on the page more than once is a FAILURE, never "done" (live
      // 2026-11-03: two identical pp_probe_json rows were reported as done).
      // Re-read after a longer settle so a late second row is still caught.
      if (phaseCreated.length) {
        if (NEW) { await sleep(1500); await v2RefreshList(); } else
        await sleep(2500);
        phaseCreated.forEach(function (nm, i) {
          if (phaseCreated.indexOf(nm) !== i) return;
          var n = toolCount(nm);
          if (n > 1) { failed.push("duplicate tool x" + n + ": " + nm); created--; }
        });
      }
    }
    if (d.isAuthRedirect()) return authStop("tools");
    // Tools commit per add; a Save is pressed only where the tab shows one.
    // (New UI: Tools save instantly per action -- there is no Save to press.)
    if (!NEW && (await saveAndConfirm(DASH2_TABS.tools, warnings, { globalFallback: true, noSaveOk: true })) === "auth") return authStop("tools");
    if (!NEW && saveRejected(DASH2_TABS.tools)) failed.unshift(saveRejected(DASH2_TABS.tools));
    // Variables are now bound via the Search-variable picker; only items the picker
    // didn't offer remain in pendingVariableItems (each already carries its reason).
    // Dedupe: a retried tool add can re-push the same row-level note.
    var allItems = failed.concat(pendingVariableItems).filter(function (v, i, a) { return a.indexOf(v) === i; });
    var out = { section: "tools", ok: allItems.length === 0, created: created, alreadyPresent: alreadyPresent, failedItems: allItems,
                leftovers: leftovers,
                notes: toolNotes.filter(function (v, i, a) { return a.indexOf(v) === i; }) };
    if (drawerStuck) { out.drawerStuck = true; out.reason = stuckWhy; }
    return withWarnings(out, warnings);
  }

  // ========================================================================
  //  2-field SOURCE sections (LLM and STT, Call Config, voice/speed, analysis
  //  model). Only reached when the zip came from a 2-field dashboard; a 5-field
  //  zip carries none of this data and these writers are never called.
  //  Every writer: set -> read back -> report mismatches; never deletes.
  // ========================================================================

  function lc(s) { return dom().norm(s).toLowerCase(); }
  function numEq(a, b) {
    var x = Number(a), y = Number(b);
    return isFinite(x) && isFinite(y) && Math.abs(x - y) < 1e-6;
  }
  function hasVal(v) { return v !== undefined && v !== null && v !== ""; }

  // The smallest visible element(s) whose whole text equals `text` (case-
  // insensitive) -- a label can wrap an info icon, so "no element children" is
  // too strict; "no child carries the same text" is the real test.
  function labelEls(text, scope) {
    var d = dom(), want = lc(text);
    return [].slice.call((scope || document.querySelector("main") || document.body).querySelectorAll("label,span,div,p,h1,h2,h3,h4,h5,h6,legend"))
      .filter(function (e) {
        if (!d.visible(e) || lc(e.textContent) !== want) return false;
        return ![].slice.call(e.children).some(function (c) { return lc(c.textContent) === want; });
      });
  }

  // The block that belongs to a label: the largest ancestor (<= 8 levels) that
  // does not also contain another section's label. Controls are then looked up
  // inside it, so a "Seconds" input is always the one under ITS heading.
  function sectionBox(labelEl, otherLabelEls) {
    var best = labelEl, node = labelEl;
    for (var k = 0; k < 8; k++) {
      var p = node.parentElement;
      if (!p || p === document.body || p.tagName === "MAIN") break;
      if ((otherLabelEls || []).some(function (o) { return o !== labelEl && !labelEl.contains(o) && p.contains(o); })) break;
      best = p; node = p;
    }
    return best;
  }

  // ---- generic control readers/writers ------------------------------------
  // Dropdown: div[role=button][aria-haspopup] holding a readonly <input> with the
  // value; its text is only the floating label (LIVE 2026-11-02, Type control).
  function dropdownValue(trig) {
    if (!trig) return "";
    var inp = trig.querySelector("input");
    if (inp) return dom().norm(inp.value);
    return "";
  }
  function dropdownIn(box, ariaLabel) {
    if (!box) return null;
    var d = dom();
    if (ariaLabel) {
      // LIVE 2026-11-03: a labelled lookup must never fall back to "some other
      // dropdown" -- that made the Model readback return the Provider's value.
      return [].slice.call(box.querySelectorAll("[role='textbox'][aria-label]"))
        .filter(function (t) { return lc(t.getAttribute("aria-label")) === lc(ariaLabel); })
        .map(function (t) { return t.closest("[role='button'][aria-haspopup]") || t; })
        .filter(function (t) { return d.visible(t); })[0] || null;
    }
    return [].slice.call(box.querySelectorAll("[role='button'][aria-haspopup]")).filter(function (e) { return d.visible(e); })[0] || null;
  }
  // Pick `want` in a single-select dropdown and read it back. `getTrig` is
  // re-resolved every attempt (the control can re-render after a choice).
  // Options match case-insensitively ("office" -> "Office"). Never presses Escape.
  async function pickDropdown(getTrig, want, scope, force) {
    var d = dom();
    var raw = (Array.isArray(want) ? want : [want]).map(function (w) { return d.norm(w); });
    var wants = raw.map(function (w) { return w.toLowerCase(); });
    function done() { return wants.indexOf(lc(dropdownValue(getTrig()))) !== -1; }
    function inputsNow() { return [].slice.call(document.querySelectorAll("input")).filter(function (i) { return d.visible(i); }); }
    pickDropdown.lastOffered = null;
    // force: success ONLY when an option was actually pressed and read back --
    // "the box already shows that name" is exactly the stale id force is for.
    var pressed = false;
    for (var a = 0; a < 3; a++) {
      // force: pick the option even when the box already SHOWS that name. The
      // model list depends on the bot's languages, and the same model name can
      // stand for a different model there (live 2026-11-03: the destination kept
      // its default model id although the name on screen matched).
      if (done() && (!force || pressed)) return true;
      var trig = getTrig(); if (!trig) return false;
      var before = inputsNow();
      d.pressSequence(trig);
      await sleep(450);
      // Only a filter box the dropdown itself just opened -- never a search box
      // that was already on the page.
      var filt = inputsNow().filter(function (i) { return before.indexOf(i) === -1 && /filter|search/i.test(i.placeholder || ""); })[0];
      if (filt && raw.length) { d.setReactInput(filt, raw[0]); await sleep(300); }
      // the open popup's items only (never a permanent sidebar menuitem)
      var opts = d.popoverItems();
      var opt = null;
      pickDropdown.lastOffered = opts.map(function (o) { return d.norm(o.textContent); }).filter(Boolean).slice(0, 8);
      for (var wi = 0; wi < wants.length && !opt; wi++) {
        opt = opts.filter(function (o) { return lc(o.textContent) === wants[wi]; })[0] || null;
      }
      if (opt) {
        d.pressSequence(opt);
        await sleep(400);
        // some menus select on a bare click only; one fallback, only if it did not take
        if (!done() && d.visible(opt) && opt.isConnected) { d.clickEl(opt); await sleep(300); }
        if (done()) pressed = true;
      }
      if (d.menuIsOpen()) await d.dismissMenu(scope, trig);
      if (!opt) { await sleep(200); if (a >= 1) break; }   // option not offered: don't spin
    }
    return done() && (!force || pressed);
  }

  function switchIn(box) {
    if (!box) return null;
    var d = dom();
    return [].slice.call(box.querySelectorAll("[role='switch'],input[type='checkbox']")).filter(function (e) { return d.visible(e); })[0] || null;
  }
  function switchOn(sw) {
    if (!sw) return null;
    if (sw.tagName === "INPUT") return !!sw.checked;
    var a = sw.getAttribute("aria-checked");
    if (a !== null) return a === "true";
    return sw.getAttribute("data-state") === "checked";
  }
  async function setSwitch(getSw, want) {
    var d = dom();
    for (var a = 0; a < 3; a++) {
      var sw = getSw(); if (!sw) return false;
      if (switchOn(sw) === want) return true;
      if (a === 0) d.pressSequence(sw); else d.clickEl(sw);
      await sleep(300);
    }
    var s2 = getSw();
    return !!s2 && switchOn(s2) === want;
  }

  // A plain editable value box inside `box` (number/text input or textarea),
  // never a dropdown's readonly companion input.
  function valueInputIn(box, textarea) {
    if (!box) return null;
    var d = dom();
    return [].slice.call(box.querySelectorAll(textarea ? "textarea,input" : "input"))
      .filter(function (i) {
        if (!d.visible(i) || i.readOnly || i.disabled) return false;
        if (/^(checkbox|radio|hidden|button|submit)$/i.test(i.type || "")) return false;
        if (i.closest("[role='button'][aria-haspopup]")) return false;
        return true;
      })
      .sort(function (a, b) { return textarea ? ((b.tagName === "TEXTAREA") - (a.tagName === "TEXTAREA")) : 0; })[0] || null;
  }
  function sliderIn(box) {
    if (!box) return null;
    var d = dom();
    return [].slice.call(box.querySelectorAll("[role='slider']")).filter(function (e) { return d.visible(e); })[0] || null;
  }
  // Read a numeric control: input, dropdown or slider (in that order).
  function readNumberIn(box) {
    var inp = valueInputIn(box); if (inp) return inp.value;
    var dd = dropdownIn(box); if (dd) return dropdownValue(dd).replace(/%$/, "");
    var sl = sliderIn(box); if (sl) return sl.getAttribute("aria-valuenow");
    return null;
  }
  async function setNumberIn(getBox, want) {
    var d = dom();
    var box = getBox(); if (!box) return false;
    if (numEq(readNumberIn(box), want)) return true;
    var inp = valueInputIn(box);
    if (inp) {
      for (var a = 0; a < 3; a++) {
        d.setReactInput(inp, String(want));
        try { inp.dispatchEvent(new Event("blur", { bubbles: true })); } catch (e) {}
        await sleep(200);
        var b2 = getBox(); inp = valueInputIn(b2) || inp;
        if (numEq(inp.value, want)) return true;
      }
      return false;
    }
    var dd = dropdownIn(box);
    if (dd) return pickDropdown(function () { return dropdownIn(getBox()); }, [String(want), want + "%"], box);
    var sl = sliderIn(box);
    if (sl) {
      // Keyboard-driven, one step at a time, read back after every step.
      try { sl.focus(); } catch (e) {}
      for (var s = 0; s < 120; s++) {
        var cur = Number(sl.getAttribute("aria-valuenow"));
        if (numEq(cur, want)) return true;
        var key = cur < want ? "ArrowRight" : "ArrowLeft";
        d.keyPress(sl, key, key === "ArrowRight" ? 39 : 37);
        await sleep(30);
        if (numEq(Number(sl.getAttribute("aria-valuenow")), cur)) break;   // not moving
      }
      return numEq(sl.getAttribute("aria-valuenow"), want);
    }
    return false;
  }

  // ---- Provider + Model pairs ("Choose LLM Model", "Choose Speech to text Model")
  // Each control is div[role=button][aria-haspopup] containing role=textbox
  // aria-label "Provider" / "Model" with a readonly <input> holding the value.
  // The model list depends on the provider, so provider is set FIRST.
  function modelPairBox(heading, otherHeadings, index) {
    var d = dom();
    var h = labelEls(heading)[0];
    if (h) {
      var others = [];
      (otherHeadings || []).forEach(function (o) { others = others.concat(labelEls(o)); });
      // climb until the block holds a Provider control, without crossing another heading
      var node = h;
      for (var k = 0; k < 8 && node; k++) {
        node = node.parentElement;
        if (!node || node === document.body) break;
        if (others.some(function (o) { return node.contains(o); })) break;
        if (dropdownIn(node, "Provider") && dropdownIn(node, "Model")) return node;
      }
    }
    // Fallback: the Nth Provider control in page order (1st = LLM, 2nd = STT).
    var provs = [].slice.call(document.querySelectorAll("[role='textbox'][aria-label]"))
      .filter(function (t) { return d.visible(t) && lc(t.getAttribute("aria-label")) === "provider"; });
    var p = provs[index || 0]; if (!p) return null;
    var box = p;
    for (var j = 0; j < 6 && box; j++) {
      box = box.parentElement;
      if (box && dropdownIn(box, "Model")) return box;
    }
    return null;
  }
  async function setModelPair(label, getBox, want, failed, forceModel) {
    // want: { provider, model }
    if (!want) return;
    if (!getBox()) { failed.push(label + ": the Provider/Model controls were not found"); return; }
    if (hasVal(want.provider)) {
      var pOk = await pickDropdown(function () { return dropdownIn(getBox(), "Provider"); }, want.provider, getBox());
      if (!pOk) {
        failed.push(label + " provider → " + want.provider + " (not set; shows '" + (dropdownValue(dropdownIn(getBox(), "Provider")) || "empty") + "')");
        return;   // the model list belongs to the provider: don't pick from the wrong list
      }
      await sleep(400);
    }
    if (hasVal(want.model)) {
      var mOk = await pickDropdown(function () { return dropdownIn(getBox(), "Model"); }, want.model, getBox(), !!forceModel);
      if (!mOk) {
        // Say when the dashboard simply doesn't offer that model here (live
        // 2026-11-03: Sarvam offered only "saaras:v4-client" on a new bot, while
        // the source bot still held "saaras:v4").
        var offered = pickDropdown.lastOffered || [];
        var notOffered = offered.length && !offered.some(function (o) { return lc(o) === lc(want.model); });
        failed.push(label + " model → " + want.model + (notOffered
          ? " (not offered by the dashboard for " + (want.provider || "this provider") + " — it offers: " + offered.join(", ") + "; left as '" + (dropdownValue(dropdownIn(getBox(), "Model")) || "empty") + "')"
          : " (not set; shows '" + (dropdownValue(dropdownIn(getBox(), "Model")) || "empty") + "')"));
      }
    }
  }
  function verifyModelPair(label, box, want, failed) {
    if (!want || !box) return;
    var gp = dropdownValue(dropdownIn(box, "Provider")), gm = dropdownValue(dropdownIn(box, "Model"));
    if (hasVal(want.provider) && lc(gp) !== lc(want.provider)) failed.push(label + " provider: want " + want.provider + ", reads '" + (gp || "empty") + "' after save");
    if (hasVal(want.model) && lc(gm) !== lc(want.model)) failed.push(label + " model: want " + want.model + ", reads '" + (gm || "empty") + "' after save");
  }
  function dedupe(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  // ---- LLM and STT (NEW) ----------------------------------------------------
  var LLM_HEAD = "Choose LLM Model", STT_HEAD = "Choose Speech to text Model";
  async function dash2LlmStt(ls, langsOk) {
    var d = dom();
    if (d.isAuthRedirect()) return authStop("llmStt");
    ls = ls || {};
    if (v2Ui()) return dash2LlmSttV2(ls);   // new 2-field UI: lists don't depend on the languages
    if (!(await gotoTab(DASH2_TABS.llmStt))) return tabFail("llmStt", DASH2_TABS.llmStt);
    if (d.isAuthRedirect()) return authStop("llmStt");
    var warnings = [];
    // The model lists follow the bot's primary/secondary language (Language and
    // Voice runs, and is saved, before this step). Give the lists a moment to
    // load for those languages, then pick each model explicitly (force) so the
    // model compatible with them is stored, not a same-named default.
    await sleep(1200);
    var failed = [];
    if (langsOk === false) failed.push("languages were not set first, so the LLM/STT lists may be for other languages — check the models by hand");
    function llmBox() { return modelPairBox(LLM_HEAD, [STT_HEAD], 0); }
    function sttBox() { return modelPairBox(STT_HEAD, [LLM_HEAD], 1); }
    var llm = ls.llm ? { provider: ls.llm.provider, model: ls.llm.model } : null;
    var stt = ls.stt ? { provider: ls.stt.provider, model: ls.stt.model } : null;
    if (llm) await setModelPair("LLM", llmBox, llm, failed, true);
    if (d.isAuthRedirect()) return authStop("llmStt");
    if (stt) await setModelPair("STT", sttBox, stt, failed, true);
    if (d.isAuthRedirect()) return authStop("llmStt");
    if ((await saveAndConfirm(DASH2_TABS.llmStt, warnings, { globalFallback: true })) === "auth") return authStop("llmStt");
    var llRejected = saveRejected(DASH2_TABS.llmStt);
    if (llRejected) return withWarnings({ section: "llmStt", ok: false, reason: llRejected, failedItems: [llRejected].concat(failed) }, warnings);
    await sleep(400);
    // Read back after the save; a pair already reported as not settable is not
    // reported twice.
    var after = [];
    if (!failed.some(function (f) { return f.indexOf("LLM") === 0; })) verifyModelPair("LLM", llmBox(), llm, after);
    if (!failed.some(function (f) { return f.indexOf("STT") === 0; })) verifyModelPair("STT", sttBox(), stt, after);
    failed = dedupe(failed.concat(after));
    return withWarnings({ section: "llmStt", ok: failed.length === 0, failedItems: failed }, warnings);
  }

  // ---- Call Config (NEW) ----------------------------------------------------
  // agent_config key -> control, located by the visible SECTION label (the
  // inputs themselves are all labelled just "Seconds"/"Words").
  var CC = {
    ambient: "Ambient Noise", noise: "Noise Cancellation", keyboard: "Keyboard Noise",
    voicemail: "Hungup on Voicemail Detection", minWords: "Interruption Min Words",
    minDur: "Interruption Min Duration (Seconds)", falseInt: "False Interruption Timeout (Seconds)",
    epMin: "Endpointing Min Delay (Seconds)", epMax: "Endpointing Max Delay (Seconds)",
    maxCall: "Maximum Call Duration", inactivity: "Hang Up on Inactivity Duration",
    wrapup: "Graceful Wrapup"
  };
  var CC_NUMERIC = [
    ["interruption_min_words", "minWords"], ["interruption_min_duration_sec", "minDur"],
    ["false_interruption_timeout_sec", "falseInt"], ["endpointing_min_delay_sec", "epMin"],
    ["endpointing_max_delay_sec", "epMax"], ["max_call_length_sec", "maxCall"],
    ["user_silence_timeout_sec", "inactivity"]
  ];
  // Keys handled elsewhere or by a control above.
  var CC_HANDLED = ["background_audio", "noise_cancellation_enabled", "voicemail_detection", "voicemail_detection_time_ms",
    "graceful_wrapup_enabled", "graceful_wrapup_message", "speech_rate", "enable_first_name_extractor",
    // written on the Prompt tab ("Interruptible" under First Message)
    "opening_line_interruptible"].concat(CC_NUMERIC.map(function (x) { return x[0]; }));
  // Keys with NO control on this dashboard's Call Config tab. Reported only when
  // they hold a non-default value; never written anywhere else.
  var CC_NO_UI = {
    // default true. LIVE 2026-11-03: a "First Name Extractor" switch exists under
    // "Other Settings" -- written through that switch (FIRST_NAME below); this
    // rule is only the fallback note when a dashboard does not show the switch.
    enable_first_name_extractor: function (v) { return v === false; },
    leave_voicemail: function (v) { return v === true; },
    voicemail_text: function (v) { return hasVal(v) && String(v).trim() !== ""; }
  };
  var FIRST_NAME = "First Name Extractor";
  // The switch that belongs to the "First Name Extractor" label: the NEAREST
  // ancestor of the label holding a switch. "Other Settings" can hold several
  // switches, so the section-box climb used for the cards is too wide here.
  function firstNameSwitch() {
    var ls = labelEls(FIRST_NAME);
    for (var i = 0; i < ls.length; i++) {
      var node = ls[i];
      for (var k = 0; k < 5 && node; k++) {
        node = node.parentElement;
        if (!node || node === document.body || node.tagName === "MAIN") break;
        var sws = [].slice.call(node.querySelectorAll("[role='switch'],input[type='checkbox']")).filter(function (e) { return dom().visible(e); });
        if (sws.length === 1) return sws[0];
        if (sws.length > 1) break;   // climbed into a group: ambiguous, don't guess
      }
    }
    return null;
  }
  // 0..1 volume -> the 0..100 level the screen shows (0.8 -> 80).
  function toLevel(v) { var n = Number(v); return (isFinite(n) && n <= 1) ? Math.round(n * 100) : n; }
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }

  async function dash2CallConfig(cfg, ctx) {
    var d = dom();
    if (d.isAuthRedirect()) return authStop("callConfig");
    cfg = cfg || {};
    if (v2Ui()) return dash2CallConfigV2(cfg, ctx);   // new 2-field UI: setting rows with their own switches
    if (!(await gotoTab(DASH2_TABS.callConfig))) return tabFail("callConfig", DASH2_TABS.callConfig);
    if (d.isAuthRedirect()) return authStop("callConfig");
    var failed = [], notes = [], changed = [], warnings = [];
    var allLabels = Object.keys(CC).map(function (k) { return CC[k]; });

    function box(key) {
      var l = labelEls(CC[key])[0]; if (!l) return null;
      var others = [];
      allLabels.forEach(function (t) { if (t !== CC[key]) others = others.concat(labelEls(t)); });
      return sectionBox(l, others);
    }
    // A sub-field inside a section ("Frequency", "Detection Time (ms)", ...):
    // climb from the sub-label, inside the section, to the first block holding a control.
    function subBox(key, subLabel) {
      var b = box(key); if (!b) return null;
      var l = labelEls(subLabel, b)[0]; if (!l) return null;
      var node = l;
      for (var k = 0; k < 6 && node && node !== b; k++) {
        node = node.parentElement;
        if (node && (valueInputIn(node) || dropdownIn(node) || sliderIn(node))) return node;
      }
      return null;
    }
    // Plan of { what, apply(), check() } -- only for keys present in the source.
    var plan = [];
    function sw(key, want, what) {
      plan.push({ what: what + " → " + (want ? "on" : "off"),
        same: function () { return switchOn(switchIn(box(key))) === want; },
        found: function () { return !!switchIn(box(key)); },
        apply: function () { return setSwitch(function () { return switchIn(box(key)); }, want); } });
    }
    function num(getB, want, what) {
      plan.push({ what: what + " → " + want,
        same: function () { return numEq(readNumberIn(getB()), want); },
        found: function () { var b = getB(); return !!b && readNumberIn(b) !== null; },
        apply: function () { return setNumberIn(getB, want); } });
    }

    var ba = cfg.background_audio;
    if (ba && typeof ba === "object") {
      if (hasVal(ba.ambient) && ba.enabled === false) {
        // background audio is OFF on the source: its ambient type is not in use
        // there, so the destination's choice is left as is.
        notes.push("Call Config: background audio is off on the source — Ambient Noise type '" + ba.ambient + "' was not applied (left as is).");
      } else if (hasVal(ba.ambient)) {
        var wantAmb = cap(ba.ambient);
        plan.push({ what: "Ambient Noise type → " + wantAmb,
          same: function () { return lc(dropdownValue(dropdownIn(box("ambient")))) === lc(wantAmb); },
          found: function () { return !!dropdownIn(box("ambient")); },
          apply: function () { return pickDropdown(function () { return dropdownIn(box("ambient")); }, wantAmb, box("ambient")); } });
      }
      if (hasVal(ba.ambient_volume)) num(function () { return subBox("ambient", "Frequency"); }, toLevel(ba.ambient_volume), "Ambient Noise frequency");
      if (hasVal(ba.thinking) || typeof ba.enabled === "boolean") {
        var kbOn = ba.enabled !== false && hasVal(ba.thinking) && !/^(none|off|disabled)$/i.test(String(ba.thinking));
        if (hasVal(ba.thinking) && kbOn && lc(ba.thinking) !== "keyboard") {
          notes.push("Call Config: thinking sound '" + ba.thinking + "' has no control here (only Keyboard Noise) — Keyboard Noise left as is.");
        } else {
          sw("keyboard", kbOn, "Keyboard Noise");
          if (kbOn && hasVal(ba.thinking_volume)) num(function () { return subBox("keyboard", "Select Frequency Level"); }, toLevel(ba.thinking_volume), "Keyboard Noise level");
        }
      }
    }
    if (typeof cfg.noise_cancellation_enabled === "boolean") sw("noise", cfg.noise_cancellation_enabled, "Noise Cancellation");
    if (typeof cfg.voicemail_detection === "boolean") {
      sw("voicemail", cfg.voicemail_detection, "Hungup on Voicemail Detection");
      if (cfg.voicemail_detection && hasVal(cfg.voicemail_detection_time_ms))
        num(function () { return subBox("voicemail", "Detection Time (ms)"); }, Number(cfg.voicemail_detection_time_ms), "Voicemail detection time (ms)");
    }
    CC_NUMERIC.forEach(function (pair) {
      if (!hasVal(cfg[pair[0]])) return;
      var k = pair[1];
      num(function () { return box(k); }, Number(cfg[pair[0]]), CC[k]);
    });
    if (typeof cfg.graceful_wrapup_enabled === "boolean") {
      sw("wrapup", cfg.graceful_wrapup_enabled, "Graceful Wrapup");
      if (cfg.graceful_wrapup_enabled && hasVal(cfg.graceful_wrapup_message)) {
        var wantMsg = String(cfg.graceful_wrapup_message);
        var msgIn = function () { return valueInputIn(box("wrapup"), true); };
        plan.push({ what: "Graceful Wrapup message",
          same: function () { var i = msgIn(); return !!i && i.value === wantMsg; },
          found: function () { return !!msgIn(); },
          apply: async function () {
            for (var a = 0; a < 3; a++) { var i = msgIn(); if (!i) return false; d.setReactInput(i, wantMsg); await sleep(200); if (msgIn() && msgIn().value === wantMsg) return true; }
            return false;
          } });
      }
    }
    if (typeof cfg.enable_first_name_extractor === "boolean") {
      var wantFn = cfg.enable_first_name_extractor;
      plan.push({ what: FIRST_NAME + " → " + (wantFn ? "on" : "off"),
        same: function () { return switchOn(firstNameSwitch()) === wantFn; },
        found: function () { return !!firstNameSwitch(); },
        // no switch on this screen: same as before it was mapped -- a note when
        // the source differs from the default, never a failure
        missingNote: function () {
          return CC_NO_UI.enable_first_name_extractor(wantFn)
            ? "Call Config: enable_first_name_extractor = " + JSON.stringify(wantFn) + " has no control on this dashboard — not migrated." : "";
        },
        apply: function () { return setSwitch(firstNameSwitch, wantFn); } });
    }
    // The destination's own agent config, when the panel can supply it
    // (ctx.destAgentConfig: object or function -> object). Keys without a
    // control are compared against it; without it they are noted when non-default.
    var destCfg = null;
    try {
      destCfg = ctx && ctx.destAgentConfig;
      if (typeof destCfg === "function") destCfg = await destCfg();
    } catch (e) { destCfg = null; }
    if (!destCfg || typeof destCfg !== "object") destCfg = null;
    // Keys with no control: note non-default values, never guess a home for them.
    Object.keys(cfg).forEach(function (k) {
      if (CC_HANDLED.indexOf(k) !== -1) return;
      var v = cfg[k];
      if (CC_NO_UI[k]) {
        if (destCfg && Object.prototype.hasOwnProperty.call(destCfg, k)) {
          var dv = destCfg[k];
          var same = JSON.stringify(dv === undefined ? null : dv) === JSON.stringify(v === undefined ? null : v) ||
            (!hasVal(dv) && !hasVal(v)) || ((dv === false || !hasVal(dv)) && (v === false || !hasVal(v)));
          if (!same) notes.push("Call Config: " + k + " is " + JSON.stringify(v) + " on the source but " + JSON.stringify(dv) + " here — there is no control for it on this dashboard; not migrated.");
          return;
        }
        if (CC_NO_UI[k](v)) notes.push("Call Config: " + k + " = " + JSON.stringify(v) + " has no control on this dashboard — not migrated.");
        return;
      }
      if (v !== null && v !== undefined && v !== "" && v !== false && !(typeof v === "object" && !Object.keys(v).length))
        notes.push("Call Config: " + k + " = " + JSON.stringify(v) + " has no known control on this dashboard — not migrated.");
    });

    for (var i = 0; i < plan.length; i++) {
      if (d.isAuthRedirect()) return authStop("callConfig");
      var step = plan[i];
      if (!step.found()) {
        if (step.missingNote) { var mn = step.missingNote(); if (mn) notes.push(mn); step.skipped = true; continue; }
        // a dependent field hidden behind its switch is only a failure when the
        // switch it depends on was supposed to reveal it
        failed.push(step.what + " (control not found)");
        continue;
      }
      if (step.same()) continue;          // only change what differs
      var okSet = false;
      try { okSet = await step.apply(); } catch (e) { okSet = false; }
      if (okSet) changed.push(step.what);
      else failed.push(step.what + " (did not take)");
      await sleep(150);
    }
    if (d.isAuthRedirect()) return authStop("callConfig");
    if ((await saveAndConfirm(DASH2_TABS.callConfig, warnings, { globalFallback: true, changed: changed.length > 0 })) === "auth") return authStop("callConfig");
    var ccRejected = saveRejected(DASH2_TABS.callConfig);
    if (ccRejected) return withWarnings({ section: "callConfig", ok: false, reason: ccRejected, changed: [], failedItems: [ccRejected].concat(failed), notes: notes }, warnings);
    await sleep(400);
    // Read back every planned control after the save.
    plan.forEach(function (step) {
      if (step.skipped) return;
      if (failed.some(function (f) { return f.indexOf(step.what) === 0; })) return;
      if (!step.found() || !step.same()) failed.push(step.what + " (reads differently after save)");
    });
    return withWarnings({ section: "callConfig", ok: failed.length === 0, changed: changed, failedItems: failed, notes: notes }, warnings);
  }

  // ---- Language and Voice: voice card + speed -------------------------------
  function selState(el) {
    // true / false when the card exposes a selection cue, null when it shows none
    if (!el) return null;
    var nodes = [el].concat([].slice.call(el.querySelectorAll("*")));
    var seen = false;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var a = n.getAttribute("aria-checked") || n.getAttribute("aria-selected") || n.getAttribute("aria-pressed");
      if (a === "true") return true;
      if (a === "false") seen = true;
      var ds = n.getAttribute("data-state");
      if (ds && /^(checked|active|on|selected)$/.test(ds)) return true;
      if (ds && /^(unchecked|inactive|off)$/.test(ds)) seen = true;
      if (n.tagName === "INPUT" && /radio|checkbox/i.test(n.type || "")) { if (n.checked) return true; seen = true; }
    }
    if (/\bselected\b/i.test(el.textContent || "")) return true;
    return seen ? false : null;
  }
  // Text of an element with its text nodes joined by spaces: textContent glues
  // adjacent spans together ("Anika"+"ElevenLabs" -> "AnikaElevenLabs"), which
  // defeats a whole-word name match.
  function spacedText(el) {
    var out = [], w = document.createTreeWalker(el, 4 /* SHOW_TEXT */, null, false), n;
    while ((n = w.nextNode())) out.push(n.nodeValue);
    return dom().norm(out.join(" "));
  }
  var CARD_SEL = "[role='radio'],[role='option'],[aria-checked],[aria-selected],[aria-pressed],label,button,[role='button']";
  // The voice card(s) for v: a card whose NAME is exactly v.name (a leaf whose
  // whole text is the name -- "Anika Sharma" is not "Anika"), from the wanted
  // provider, and -- when the source names a model -- carrying that model.
  // A name+provider match without the model returns [] with .modelMissing set.
  function voiceCards(v) {
    var d = dom();
    var scope = document.querySelector("main") || document.body;
    var want = lc(v.name), prov = lc(v.provider || ""), model = lc(v.model || "");
    var nameEls = [].slice.call(scope.querySelectorAll("*")).filter(function (e) {
      if (!d.visible(e) || e.closest("[role='option'],[role='menuitem'],[role='button'][aria-haspopup]")) return false;
      if (lc(e.textContent) !== want) return false;
      return ![].slice.call(e.children).some(function (c) { return lc(c.textContent) === want; });
    });
    var cards = [];
    nameEls.forEach(function (e) {
      var c = e.closest(CARD_SEL);
      if (!c) {
        // no selectable ancestor: the smallest block around the name that also
        // names the provider (or the name's parent)
        c = e.parentElement;
        for (var k = 0; k < 4 && c && prov && spacedText(c).toLowerCase().indexOf(prov) === -1; k++) c = c.parentElement;
        c = c || e;
      }
      if (cards.indexOf(c) === -1) cards.push(c);
    });
    if (prov) cards = cards.filter(function (c) { return spacedText(c).toLowerCase().indexOf(prov) !== -1; });
    var out = cards;
    if (model) {
      out = cards.filter(function (c) { return spacedText(c).toLowerCase().indexOf(model) !== -1; });
      if (!out.length && cards.length) out.modelMissing = true;
    }
    // prefer real, selectable cards over a summary line that repeats the name
    var real = out.filter(function (c) { return c.matches(CARD_SEL); });
    if (real.length) return real;
    return out;
  }
  async function selectVoice(v, failed, notes) {
    var d = dom();
    var label = "Voice → " + v.name + (v.provider ? " · " + v.provider : "") + (v.model ? " · " + v.model : "");
    var cards = voiceCards(v);
    if (!cards.length) {
      // a search box narrows a long list; never type into anything else
      var search = [].slice.call(document.querySelectorAll("input")).filter(function (i) { return d.visible(i) && /search/i.test(i.placeholder || ""); })[0];
      if (search) { d.setReactInput(search, v.name); await sleep(500); cards = voiceCards(v); }
    }
    if (!cards.length) {
      failed.push(label + (cards.modelMissing
        ? " (not offered — no " + (v.provider ? v.provider + " " : "") + "'" + v.name + "' card with model " + v.model + ")"
        : " (not offered for these languages)"));
      return;
    }
    if (cards.length > 1) { failed.push(label + " (" + cards.length + " matching voice cards — not chosen)"); return; }
    var card = cards[0];
    if (selState(card) === true) return;
    for (var a = 0; a < 3; a++) {
      if (a === 0) d.pressSequence(card); else d.clickEl(card);
      await sleep(400);
      card = voiceCards(v)[0] || card;
      if (selState(card) === true) return;
    }
    if (selState(card) === null) notes.push(label + ": chosen, but this screen exposes no selection state to read back — please confirm by eye.");
    else failed.push(label + " (did not take)");
  }
  // Speed options are radios labelled with a number ("0.7" ... "1.0" ... "1.3").
  // Voice cards can be radios too, so only numeric-labelled radios count.
  var SPEED_RE = /^\d+(\.\d+)?\s*x?$/i;
  function radioText(r) {
    var t = dom().norm(r.textContent) || r.getAttribute("aria-label") || r.getAttribute("value") || r.value || "";
    if (!SPEED_RE.test(dom().norm(t)) && r.id) { var lb = document.querySelector("label[for='" + r.id + "']"); if (lb) t = lb.textContent; }
    return dom().norm(t);
  }
  function numericRadios(scope) {
    var d = dom();
    return [].slice.call(scope.querySelectorAll("[role='radio'],input[type='radio']"))
      .filter(function (r) { return (d.visible(r) || r.tagName === "INPUT") && SPEED_RE.test(radioText(r)); });
  }
  function speedRadios() {
    var d = dom();
    var l = labelEls("Voice speed")[0];
    if (l) {
      var node = l;
      for (var k = 0; k < 6 && node; k++) {
        node = node.parentElement;
        if (!node) break;
        var rs = numericRadios(node);
        if (rs.length) return rs;
      }
    }
    var g = [].slice.call(document.querySelectorAll("[role='radiogroup']"))
      .filter(function (x) { return d.visible(x) && /speed/i.test(x.getAttribute("aria-label") || ""); })[0];
    return g ? numericRadios(g) : [];
  }
  function radioOn(r) { return r.getAttribute("aria-checked") === "true" || r.checked === true || r.getAttribute("data-state") === "checked"; }
  async function selectSpeed(speed, failed) {
    var d = dom();
    var label = "Voice speed → " + speed;
    function target() { return speedRadios().filter(function (r) { var m = radioText(r).match(/\d+(\.\d+)?/); return m && numEq(m[0], speed); })[0]; }
    if (!speedRadios().length) { failed.push(label + " (speed options not found)"); return; }
    if (!target()) { failed.push(label + " (not an offered speed)"); return; }
    for (var a = 0; a < 3; a++) {
      var r = target(); if (!r) break;
      if (radioOn(r)) return;
      if (a === 0) d.pressSequence(r); else d.clickEl(r);
      await sleep(300);
    }
    if (!(target() && radioOn(target()))) failed.push(label + " (did not take)");
  }
  function currentSpeed() {
    var on = speedRadios().filter(radioOn)[0]; if (!on) return null;
    var m = radioText(on).match(/\d+(\.\d+)?/); return m ? Number(m[0]) : null;
  }

  // ========================================================================
  //  New 2-field UI (2026-11-05): Language & voice, Models, Call settings.
  //  Sidebar sections, combobox dropdowns, one page-wide Save (v2SaveAll).
  //  The old-UI code above runs unchanged when v2Ui() is false.
  // ========================================================================
  function v2Ui() { var d = dom(); try { return !!(d.v2IsNewUi && d.v2IsNewUi()); } catch (e) { return false; } }
  function v2SectionFail(section, title) {
    var w = dom().v2GotoSection.lastWhy;
    return fail(section, "the '" + title + "' section could not be opened" + (w ? " — " + w : ""));
  }
  // Press the page-wide Save and map the outcome (contract): saved/none -> ok;
  // failed/blocked -> a failed item "Save rejected: ..."; unconfirmed -> a
  // warning (the section stays ok only if its read-back matches).
  async function v2Commit(title, failed, warnings) {
    var d = dom();
    if (d.isAuthRedirect()) return "auth";
    // saveV2: logged for run(), retried once, never pressed while a Save runs.
    var s = await saveV2(title, warnings);
    if (d.isAuthRedirect()) return "auth";
    if (s.state === "failed" || s.state === "blocked") failed.push(v2Reject(s.text || s.state));
    else if (s.state === "unconfirmed" && d.v2SaveBar()) failed.push("The Save didn't finish — the " + title + " changes are still unsaved on the page");
    if (s.state === "saved" || s.state === "unconfirmed") {
      await v2WaitIdle(30000);
      // read back on the section's own page (the user may have clicked another)
      var slug = (d.V2_SECTIONS || {})[v2KeyOf(title)];
      if (slug && d.v2ActiveSection() !== slug) await gotoSectionV2(title, { budgetMs: 6000 });
    }
    if (s.state === "saved") await sleep(800);   // the section re-renders from the re-fetched agent
    return s.state;
  }
  // section[aria-label=...] by exact attribute value (no selector escaping of "&").
  function v2Editor(label) {
    return [].slice.call(document.querySelectorAll("section[aria-label]")).filter(function (s) { return s.getAttribute("aria-label") === label; })[0] || null;
  }
  function v2NumText(t) { var m = String(t || "").match(/^\s*(\d+(?:\.\d+)?)\s*x?\s*$/i); return m ? Number(m[1]) : null; }

  // ---- Language & voice ----------------------------------------------------
  // Cartesia voices offer named speeds (stored lower-case in
  // agent_config.speech_rate); Soniox voices offer 0.7 ... 1.3. A source value
  // of the other kind is mapped to the closest offered option (reported).
  var V2_NAMED_SPEED = { slowest: 0.7, slow: 0.85, normal: 1, fast: 1.15, fastest: 1.3 };
  async function dash2LanguageVoiceV2(lv) {
    var d = dom();
    lv = lv || {};
    var failed = [], warnings = [], notes = [];
    function ed() { return v2Editor("Language & voice editor"); }
    function langBtn(label) { var e = ed(); return e ? d.v2Combo(e, label) : null; }
    if (!(await d.v2GotoSection(d.V2_SECTIONS.languageVoice, function () { return !!langBtn("Primary language"); })))
      return v2SectionFail("languageVoice", "Language & voice");
    if (d.isAuthRedirect()) return authStop("languageVoice");

    function plain(s) { return d.norm(s).replace(/\s*\([^)]*\)\s*/g, " ").trim(); }
    function curLang(label) { return d.v2ComboValue(langBtn(label)); }
    function sameLang(a, b) { a = plain(a).toLowerCase(); return !!a && a === plain(b).toLowerCase(); }
    var changedLang = false;
    // The language lists load after the section opens: the box reads "Loading
    // languages…" (and may be disabled) until then. Wait for it, never pick or
    // judge while it is loading.
    function langLoading(label) {
      var b = langBtn(label);
      if (!b) return true;
      return /\bloading\b/i.test(d.norm(b.textContent)) || b.disabled || b.getAttribute("aria-disabled") === "true" ||
        b.getAttribute("aria-busy") === "true" || b.hasAttribute("data-loading");
    }
    async function waitLangReady(label, ms) {
      return d.waitFor(function () { return !langLoading(label); }, ms || 20000, 200);
    }
    async function setLang(label, value) {
      if (!value) return true;
      if (!(await waitLangReady(label))) {
        failed.push(label + " → " + value + " (the language list didn't finish loading)");
        return false;
      }
      if (sameLang(curLang(label), value)) return true;
      var tries = dedupe([d.norm(value), plain(value)].filter(Boolean)), r = null;
      for (var i = 0; i < tries.length; i++) {
        var want = tries[i];
        r = await d.v2PickCombo(function () { return langBtn(label); }, function (t) { return sameLang(t, want); });
        if (r.ok && sameLang(curLang(label), value)) { changedLang = true; return true; }
      }
      failed.push(label + " → " + value + (r && r.why === "not offered"
        ? " (not offered" + (r.offered.length ? "; it offers: " + r.offered.slice(0, 14).join(", ") : "") + ")"
        : " (reads '" + (curLang(label) || "empty") + "')"));
      return false;
    }
    var wantP = lv.primaryLanguage || "", wantS = lv.secondaryLanguage || "";
    // The same language twice is accepted on this UI, so no "park on a third
    // language" swap is needed: primary, then secondary.
    await setLang("Primary language", wantP);
    if (d.isAuthRedirect()) return authStop("languageVoice");
    await setLang("Secondary language", wantS);
    if (d.isAuthRedirect()) return authStop("languageVoice");
    function checkLangs(when) {
      [["Primary language", wantP], ["Secondary language", wantS]].forEach(function (pr) {
        if (!pr[1]) return;
        var tag = pr[0] + " → " + pr[1];
        if (failed.some(function (f) { return f.indexOf(tag) === 0; })) return;
        var got = curLang(pr[0]);
        if (/\bloading\b/i.test(got || "")) { warnings.push("Couldn't confirm " + tag + " " + when + " — the list was still loading; check it by hand."); return; }
        if (!sameLang(got, pr[1])) failed.push(tag + " (reads " + (got || "empty") + " " + when + ")");
      });
    }

    // ---- voice cards: [data-choice-card] data-value = tts_voice_id,
    // aria-label "Name, Provider, model, Gender" (a name may hold commas)
    function cards() {
      var e = ed(); if (!e) return [];
      var g = e.querySelector('[role="radiogroup"][aria-label="Voice"]') || e;
      return [].slice.call(g.querySelectorAll("[data-choice-card]"));
    }
    function parts(c) {
      var p = (c.getAttribute("aria-label") || "").split(", ");
      if (p.length < 4) return { name: d.norm(c.getAttribute("aria-label") || ""), provider: "", model: "", gender: "" };
      return { name: p.slice(0, p.length - 3).join(", "), provider: p[p.length - 3], model: p[p.length - 2], gender: p[p.length - 1] };
    }
    function checked(c) { return !!c && (c.getAttribute("aria-checked") === "true" || c.getAttribute("data-state") === "checked"); }
    async function resetFilters() {
      var e = ed(); if (!e) return;
      var pf = e.querySelector('[aria-label="Filter by provider"]');
      // "All<span>336</span>" reads "All336": the leading word, or else the first button
      var pbs = pf ? [].slice.call(pf.querySelectorAll("button")) : [];
      var all = pbs.filter(function (b) { return /^all\s*\d*$/i.test(d.norm(b.textContent)); })[0] || pbs[0];
      if (all && all.getAttribute("aria-pressed") !== "true") { d.clickEl(all); await sleep(300); }
      var gf = e.querySelector('[aria-label="Filter by gender"]');
      var ga = gf && [].slice.call(gf.querySelectorAll('[role="radio"],button')).filter(function (b) { return /^all\s*\d*$/i.test(d.norm(b.textContent)); })[0];
      if (ga && ga.getAttribute("aria-checked") !== "true" && ga.getAttribute("aria-pressed") !== "true") { d.clickEl(ga); await sleep(300); }
    }
    // A language change re-fetches the voices for the new pair: wait until the
    // card list is there and stable.
    // A slow catalog gets ~10 s; an explicit empty state ends the wait early.
    function emptyState() { var e = ed(); return !!e && /no voices|no matching voices|nothing (found|matches)/i.test(e.textContent || ""); }
    async function waitCards(ms) {
      var end = Date.now() + ms, last = -1, stable = 0;
      while (Date.now() < end) {
        var n = cards().length;
        if (n > 0 && n === last) { if (++stable >= 2) return n; } else stable = 0;
        if (!n && emptyState()) return 0;
        last = n; await sleep(300);
      }
      return cards().length;
    }
    function match(v) {
      var all = cards();
      if (hasVal(v.id)) {
        var byId = all.filter(function (c) { return c.getAttribute("data-value") === String(v.id); });
        if (byId.length === 1) return { cards: byId, how: "id" };
      }
      var want = lc(v.name || ""), prov = lc(v.provider || ""), model = lc(v.model || "");
      var byName = all.filter(function (c) { return lc(parts(c).name) === want; });
      var byProv = prov ? byName.filter(function (c) { return lc(parts(c).provider) === prov; }) : byName;
      var out = model ? byProv.filter(function (c) { return lc(parts(c).model) === model; }) : byProv;
      return { cards: out, how: "name", byName: byName, byProv: byProv };
    }
    var v = lv.voice && (lv.voice.name || lv.voice.id) ? lv.voice : null;
    var pickedId = null, voiceLabel = "";
    if (v) {
      voiceLabel = "Voice → " + (v.name || v.id) + (v.provider ? " · " + v.provider : "") + (v.model ? " · " + v.model : "");
      if (changedLang) await sleep(800);
      await resetFilters();
      await waitCards(changedLang ? 12000 : 10000);
      var m = match(v);
      if (!m.cards.length && !cards().length && !emptyState()) {
        failed.push(voiceLabel + " (the voice list didn't load — not chosen; pick it by hand)");
      } else if (!m.cards.length) {
        var why = " (not offered for these languages)";
        if (m.byProv && m.byProv.length && v.model)
          why = " (not offered — no " + (v.provider ? v.provider + " " : "") + "'" + v.name + "' voice with model " + v.model +
            "; offered models: " + dedupe(m.byProv.map(function (c) { return parts(c).model; })).join(", ") + ")";
        else if (m.byName && m.byName.length && v.provider)
          why = " (not offered from " + v.provider + "; '" + v.name + "' is offered from " + dedupe(m.byName.map(function (c) { return parts(c).provider; })).join(", ") + ")";
        failed.push(voiceLabel + why);
      } else if (m.cards.length > 1) {
        failed.push(voiceLabel + " (" + m.cards.length + " voices on this dashboard share this name, provider and model — not chosen; pick it by hand)");
      } else {
        var card = m.cards[0], cid = card.getAttribute("data-value");
        var cardNow = function () { return cards().filter(function (c) { return c.getAttribute("data-value") === cid; })[0] || null; };
        for (var a = 0; a < 3 && !checked(cardNow()); a++) {
          var c0 = cardNow(); if (!c0) break;
          if (a === 0) d.clickEl(c0); else d.pressSequence(c0);
          await sleep(400);
        }
        if (checked(cardNow())) pickedId = cid;
        else failed.push(voiceLabel + " (did not take)");
      }
    }
    if (d.isAuthRedirect()) return authStop("languageVoice");

    // ---- speed: radios in the group labelled "Voice speed"; only there once
    // a voice is checked, and a voice pick resets it, so it goes AFTER the voice.
    function speedRadios() {
      var e = ed(); if (!e) return [];
      var lab = [].slice.call(e.querySelectorAll("[id]")).filter(function (x) { return lc(x.textContent) === "voice speed"; })[0];
      var g = null;
      if (lab) g = [].slice.call(e.querySelectorAll('[role="radiogroup"][aria-labelledby]')).filter(function (x) {
        return (" " + x.getAttribute("aria-labelledby") + " ").indexOf(" " + lab.id + " ") !== -1;
      })[0] || null;
      if (!g) g = [].slice.call(e.querySelectorAll('[role="radiogroup"]')).filter(function (x) { return /speed/i.test(x.getAttribute("aria-label") || ""); })[0] || null;
      return g ? [].slice.call(g.querySelectorAll('[role="radio"]')) : [];
    }
    function curSpeed() { var on = speedRadios().filter(checked)[0]; return on ? d.norm(on.textContent) : null; }
    var rawSpeed = hasVal(lv.speed) ? lv.speed : null;
    var speedTarget = null;   // the radio text that was picked
    if (rawSpeed !== null && !failed.some(function (f) { return f.indexOf("Voice →") === 0; })) {
      var spLabel = "Voice speed → " + rawSpeed;
      var radios = speedRadios();
      for (var sw = 0; sw < 10 && !radios.length; sw++) { await sleep(200); radios = speedRadios(); }
      if (!radios.length) failed.push(spLabel + " (speed options not found" + (cards().some(checked) ? ")" : " — no voice is picked)"));
      else {
        var texts = radios.map(function (r) { return d.norm(r.textContent); });
        var wantNum = typeof rawSpeed === "number" ? rawSpeed : v2NumText(rawSpeed);
        var wantName = wantNum === null ? lc(rawSpeed) : "";
        var hit = texts.filter(function (t) { return wantNum !== null ? numEq(v2NumText(t), wantNum) : lc(t) === wantName; })[0] || null;
        if (!hit) {
          // the other kind: map by value to the closest option, ties toward 1x
          var target = wantNum !== null ? wantNum : V2_NAMED_SPEED[wantName];
          var cand = texts.map(function (t) {
            var n = v2NumText(t); if (n === null && V2_NAMED_SPEED.hasOwnProperty(lc(t))) n = V2_NAMED_SPEED[lc(t)];
            return { t: t, n: n };
          }).filter(function (x) { return x.n !== null; });
          var crossKind = target !== undefined && cand.length && (wantNum !== null ? cand.every(function (x) { return v2NumText(x.t) === null; }) : cand.every(function (x) { return v2NumText(x.t) !== null; }));
          if (crossKind) {
            cand.sort(function (x, y) {
              var dx = Math.round(Math.abs(x.n - target) * 1000), dy = Math.round(Math.abs(y.n - target) * 1000);
              return dx - dy || Math.abs(x.n - 1) - Math.abs(y.n - 1);
            });
            if (Math.round(Math.abs(cand[0].n - target) * 1000) <= 150) {
              hit = cand[0].t;
              notes.push("Voice speed: the source's '" + rawSpeed + "' isn't an option for this voice (it offers " + texts.join(", ") +
                ") — set to '" + hit + "', the closest.");
            }
          }
          if (!hit) failed.push(spLabel + " (can't be represented for this voice — it offers " + texts.join(", ") + ")");
        }
        if (hit) {
          var radioFor = function () { return speedRadios().filter(function (r) { return d.norm(r.textContent) === hit; })[0] || null; };
          for (var sa = 0; sa < 3 && !checked(radioFor()); sa++) {
            var r0 = radioFor(); if (!r0) break;
            if (sa === 0) d.clickEl(r0); else d.pressSequence(r0);
            await sleep(300);
          }
          if (checked(radioFor())) speedTarget = hit;
          else failed.push(spLabel + " (did not take)");
        }
      }
    }
    checkLangs("after selection");
    if (d.isAuthRedirect()) return authStop("languageVoice");
    var st = await v2Commit("Language & voice", failed, warnings);
    if (st === "auth") return authStop("languageVoice");
    if (st === "saved" || st === "unconfirmed") await waitCards(3000);
    // read back (the re-fetched section shows "Loading languages…" for a moment)
    if (wantP) await waitLangReady("Primary language");
    if (wantS) await waitLangReady("Secondary language");
    checkLangs("after save");
    if (pickedId !== null) {
      var on = cards().filter(checked)[0];
      if (!on) failed.push(voiceLabel + " (no voice is selected after save)");
      else if (on.getAttribute("data-value") !== pickedId) failed.push(voiceLabel + " (reads " + parts(on).name + " · " + parts(on).provider + " · " + parts(on).model + " after save)");
    }
    if (speedTarget !== null) {
      var cs = curSpeed();
      if (cs !== speedTarget) failed.push("Voice speed → " + rawSpeed + " (reads " + (cs || "none") + " after save)");
    }
    return withWarnings({ section: "languageVoice", ok: failed.length === 0, failedItems: dedupe(failed), notes: notes }, warnings);
  }

  // ---- Models (LLM / STT) --------------------------------------------------
  // section[aria-label="LLM"|"STT"] with "Provider" + "Model" comboboxes.
  // Changing the provider clears the model. Several providers can share one
  // display name (QA: three "Simplismart Gemma 31B V3", two "Sarvam") and the
  // options carry no id, so each same-named provider is tried in turn (the
  // current one first) and the first whose model list offers the wanted model
  // is used.
  async function dash2LlmSttV2(ls) {
    var d = dom();
    var failed = [], warnings = [], notes = [];
    function ed() { return v2Editor("Models editor") || document; }
    function box(w) { return ed().querySelector('section[aria-label="' + w + '"]'); }
    function combo(w, label, i) {
      var b = box(w); if (!b) return null;
      return d.v2Combo(b, label) || b.querySelectorAll('button[role="combobox"]')[i] || null;
    }
    function provBtn(w) { return combo(w, "Provider", 0); }
    function modelBtn(w) { return combo(w, "Model", 1); }
    if (!(await d.v2GotoSection(d.V2_SECTIONS.llmStt, function () { return !!provBtn("LLM"); })))
      return v2SectionFail("llmStt", "Models");
    if (d.isAuthRedirect()) return authStop("llmStt");

    // Provider + model, duplicate provider names and late lists handled by
    // v2SetModelPair (shared with the Post-call analysis model).
    var abandon = false;
    async function setPair(w, want) {
      if (!want || (!hasVal(want.provider) && !hasVal(want.model))) return;
      if (!box(w) || !provBtn(w) || !modelBtn(w)) { failed.push(w + ": the Provider/Model controls were not found"); return; }
      var res = await v2SetModelPair(function () { return provBtn(w); }, function () { return modelBtn(w); }, want, failed, notes, w);
      if (res && res.abandon) abandon = true;
    }
    var llm = ls.llm ? { provider: ls.llm.provider, model: ls.llm.model } : null;
    var stt = ls.stt ? { provider: ls.stt.provider, model: ls.stt.model } : null;
    if (llm) await setPair("LLM", llm);
    if (d.isAuthRedirect()) return authStop("llmStt");
    if (stt) await setPair("STT", stt);
    if (d.isAuthRedirect()) return authStop("llmStt");
    if (abandon) {
      // A provider would be stored without its model: save nothing here.
      var gone = await v2Discard();
      failed.push(gone ? "Models: nothing was saved — this section's changes were discarded" : "Models: the changes could not be discarded — press Discard on the page before saving");
      return withWarnings({ section: "llmStt", ok: false, failedItems: dedupe(failed), notes: notes }, warnings);
    }
    var st = await v2Commit("Models", failed, warnings);
    if (st === "auth") return authStop("llmStt");
    // read back what the page now shows (it re-renders from the saved agent)
    [["LLM", llm], ["STT", stt]].forEach(function (pr) {
      var w = pr[0], want = pr[1];
      if (!want || failed.some(function (f) { return f.indexOf(w + " ") === 0 || f.indexOf(w + ":") === 0; })) return;
      var gp2 = d.v2ComboValue(provBtn(w)), gm2 = d.v2ComboValue(modelBtn(w));
      if (hasVal(want.provider) && lc(gp2) !== lc(want.provider)) failed.push(w + " provider: want " + want.provider + ", reads '" + (gp2 || "empty") + "' after save");
      if (hasVal(want.model) && lc(gm2) !== lc(want.model)) failed.push(w + " model: want " + want.model + ", reads '" + (gm2 || "empty") + "' after save");
    });
    return withWarnings({ section: "llmStt", ok: failed.length === 0, failedItems: dedupe(failed), notes: notes }, warnings);
  }

  // ---- Call settings ---------------------------------------------------------
  // div[data-slot="setting-row"] per setting: span[id$="-label"] title (an edit
  // appends a "Changed" tag INSIDE it: match the title's first child), the
  // row's own switch (Interruption Min Words / Min Duration / Maximum Call
  // Duration now have one: key absent -> off), an inline input, and nested
  // controls (div[data-slot="setting-row-nested"]) rendered only while on.
  var CC_V2_TITLE = { voicemail: ["Hang up on Voicemail Detection", "Hungup on Voicemail Detection"] };
  var CC_V2_SWITCHED = { interruption_min_words: 1, interruption_min_duration_sec: 1, max_call_length_sec: 1 };
  async function dash2CallConfigV2(cfg, ctx) {
    var d = dom();
    var failed = [], notes = [], changed = [], warnings = [];
    function ed() { return v2Editor("Call settings editor"); }
    var NEST = '[data-slot="setting-row-nested"]';
    function rowTitle(r) {
      var l = [].slice.call(r.querySelectorAll('[id$="-label"]')).filter(function (x) { return !x.closest(NEST) || !r.contains(x.closest(NEST)); })[0];
      if (!l) return "";
      return d.norm(l.firstChild ? l.firstChild.textContent : l.textContent);
    }
    function row(key) {
      var e = ed(); if (!e) return null;
      var titles = (CC_V2_TITLE[key] || [key === "firstName" ? FIRST_NAME : CC[key]]).map(lc);
      return [].slice.call(e.querySelectorAll('[data-slot="setting-row"]')).filter(function (r) { return titles.indexOf(lc(rowTitle(r))) !== -1; })[0] || null;
    }
    function own(r, sel) {   // controls of the row itself, not of its nested block
      if (!r) return [];
      return [].slice.call(r.querySelectorAll(sel)).filter(function (x) { var n = x.closest(NEST); return !n || !r.contains(n); });
    }
    function nested(r) { return r ? r.querySelector(NEST) : null; }
    function rowSwitch(key) { return own(row(key), '[role="switch"]')[0] || null; }
    function rowInput(key) { return own(row(key), 'input:not([type="range"]):not([type="hidden"])')[0] || null; }
    function rangeIn(key) { var n = nested(row(key)); return n ? n.querySelector('input[type="range"]') : null; }
    if (!(await d.v2GotoSection(d.V2_SECTIONS.callConfig, function () { return !!ed() && !!ed().querySelector('[data-slot="setting-row"]'); })))
      return v2SectionFail("callConfig", "Call settings");
    if (d.isAuthRedirect()) return authStop("callConfig");

    async function until(fn, ms) { for (var i = 0; i < Math.ceil((ms || 1600) / 200); i++) { try { if (fn()) return true; } catch (e) {} await sleep(200); } try { return !!fn(); } catch (e) { return false; } }
    async function writeValue(getInp, want, isText) {
      if (!(await until(function () { var i = getInp(); return i && !i.disabled; }))) return false;
      for (var a = 0; a < 3; a++) {
        var i = getInp(); if (!i) return false;
        d.setReactInput(i, String(want));
        try { i.dispatchEvent(new Event("blur", { bubbles: true })); } catch (e) {}
        await sleep(200);
        var i2 = getInp() || i;
        if (isText ? i2.value === String(want) : numEq(i2.value, want)) return true;
      }
      return false;
    }
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    function ceText(ce) {
      if (!ce) return "";
      var ps = [].slice.call(ce.children).filter(function (c) { return /^P$/i.test(c.tagName); });
      return d.norm(ps.length ? ps.map(function (p) { return p.textContent; }).join("\n") : (ce.innerText || ce.textContent || ""));
    }
    // TipTap editor: this script can't reach the page's editor object, so the
    // text goes in as a paste of one <p> per line (falls back to insertText).
    async function writeRich(getCe, text) {
      var html = String(text).split(/\r?\n/).map(function (l) { return "<p>" + esc(l) + "</p>"; }).join("");
      var want = d.norm(text);
      for (var a = 0; a < 3; a++) {
        var ce = getCe(); if (!ce) return false;
        try {
          ce.focus();
          var sel = window.getSelection(), rg = document.createRange();
          rg.selectNodeContents(ce); sel.removeAllRanges(); sel.addRange(rg);
        } catch (e) {}
        if (a < 2) {
          try {
            var dt = new DataTransfer(); dt.setData("text/html", html);
            ce.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
          } catch (e) {}
        } else {
          try { document.execCommand("insertText", false, String(text)); } catch (e) {}
        }
        await sleep(300);
        if (ceText(getCe()) === want) return true;
      }
      return false;
    }

    var plan = [];
    // step: { what, found(), same(), apply(), dep: wait for the control (revealed by an earlier switch) }
    function swStep(key, want, what, getSw) {
      getSw = getSw || function () { return rowSwitch(key); };
      plan.push({ what: what + " → " + (want ? "on" : "off"),
        found: function () { return !!getSw(); },
        same: function () { return switchOn(getSw()) === want; },
        apply: function () { return setSwitch(getSw, want); } });
    }
    function numStep(getInp, want, what) {
      plan.push({ what: what + " → " + want, dep: true,
        found: function () { return !!getInp(); },
        same: function () { var i = getInp(); return !!i && numEq(i.value, want); },
        apply: function () { return writeValue(getInp, want); } });
    }

    var ba = cfg.background_audio;
    if (ba && typeof ba === "object") {
      var ambOn = typeof ba.enabled === "boolean" ? ba.enabled : null;
      if (ambOn !== null) swStep("ambient", ambOn, "Ambient Noise");
      if (ambOn !== false) {
        if (hasVal(ba.ambient)) {
          var wantAmb = cap(ba.ambient);
          var ambType = function () { var n = nested(row("ambient")); return n ? d.v2Combo(n, "Type") || n.querySelector('button[role="combobox"]') : null; };
          plan.push({ what: "Ambient Noise type → " + wantAmb, dep: true,
            found: function () { return !!ambType(); },
            same: function () { return lc(d.v2ComboValue(ambType())) === lc(wantAmb); },
            apply: async function () { return (await d.v2PickCombo(ambType, wantAmb)).ok; } });
        }
        if (hasVal(ba.ambient_volume)) numStep(function () { return rangeIn("ambient"); }, toLevel(ba.ambient_volume), "Ambient Noise volume");
      }
      // Keyboard Noise on <=> thinking = "keyboard" (the only thinking sound here)
      if (hasVal(ba.thinking) && !/^(none|off|disabled|keyboard)$/i.test(String(ba.thinking))) {
        notes.push("Call settings: thinking sound '" + ba.thinking + "' has no control here (only Keyboard Noise) — Keyboard Noise left as is.");
      } else {
        var kbOn = hasVal(ba.thinking) && lc(ba.thinking) === "keyboard";
        swStep("keyboard", kbOn, "Keyboard Noise");
        if (kbOn && hasVal(ba.thinking_volume)) numStep(function () { return rangeIn("keyboard"); }, toLevel(ba.thinking_volume), "Keyboard Noise volume");
      }
    }
    if (typeof cfg.noise_cancellation_enabled === "boolean") swStep("noise", cfg.noise_cancellation_enabled, "Noise Cancellation");
    if (typeof cfg.voicemail_detection === "boolean") {
      var vmOn = cfg.voicemail_detection;
      swStep("voicemail", vmOn, "Hang up on Voicemail Detection");
      if (vmOn && hasVal(cfg.voicemail_detection_time_ms))
        numStep(function () { return own(row("voicemail"), 'input[aria-label="Detection time"]')[0] || rowInput("voicemail"); },
          Math.round(Number(cfg.voicemail_detection_time_ms)), "Voicemail detection time (ms)");
      var leaveSw = function () {
        var n = nested(row("voicemail")); if (!n) return null;
        return d.v2Switch(n, "Leave voicemail") || n.querySelector('[role="switch"]');
      };
      var vmText = hasVal(cfg.voicemail_text) ? String(cfg.voicemail_text) : "";
      if (vmOn && typeof cfg.leave_voicemail === "boolean") {
        if (cfg.leave_voicemail && !vmText.trim())
          failed.push("Leave voicemail → on (the source has no voicemail message, which this dashboard requires — left as is)");
        else {
          plan.push({ what: "Leave voicemail → " + (cfg.leave_voicemail ? "on" : "off"), dep: true,
            found: function () { return !!leaveSw(); },
            same: function () { return switchOn(leaveSw()) === cfg.leave_voicemail; },
            apply: function () { return setSwitch(leaveSw, cfg.leave_voicemail); } });
          if (cfg.leave_voicemail) {
            var vmEd = function () {
              var n = nested(row("voicemail")); if (!n) return null;
              return n.querySelector('.ProseMirror[contenteditable="true"], [contenteditable="true"]');
            };
            plan.push({ what: "Voicemail message", dep: true,
              found: function () { return !!vmEd(); },
              same: function () { return ceText(vmEd()) === d.norm(vmText); },
              apply: function () { return writeRich(vmEd, vmText); } });
          }
        }
      } else if (!vmOn && (cfg.leave_voicemail === true || vmText.trim())) {
        notes.push("Call settings: the voicemail message / Leave voicemail are not applied — voicemail detection is off on the source.");
      }
    }
    var fullCfg = ["false_interruption_timeout_sec", "endpointing_min_delay_sec", "endpointing_max_delay_sec", "user_silence_timeout_sec"]
      .some(function (x) { return Object.prototype.hasOwnProperty.call(cfg, x); });
    CC_NUMERIC.forEach(function (pair) {
      var key = pair[0], k = pair[1];
      var present = hasVal(cfg[key]);
      if (CC_V2_SWITCHED[key]) {
        // the key present -> switch on + value; null, or absent from a full
        // agent_config -> switch off (the app deletes the key). A partial config
        // that doesn't mention the key leaves the row as it is.
        if (!present && !(cfg[key] === null || fullCfg)) return;
        swStep(k, present, CC[k]);
        if (present) numStep(function () { return rowInput(k); }, Number(cfg[key]), CC[k]);
        return;
      }
      if (present) numStep(function () { return rowInput(k); }, Number(cfg[key]), CC[k]);
    });
    if (typeof cfg.graceful_wrapup_enabled === "boolean") {
      var wuOn = cfg.graceful_wrapup_enabled, wuMsg = hasVal(cfg.graceful_wrapup_message) ? String(cfg.graceful_wrapup_message) : "";
      if (wuOn && !wuMsg.trim()) failed.push("Graceful Wrapup → on (the source has no wrapup message, which this dashboard requires — left as is)");
      else {
        swStep("wrapup", wuOn, "Graceful Wrapup");
        if (wuOn) {
          var wuIn = function () { var n = nested(row("wrapup")); return n ? (n.querySelector("textarea") || n.querySelector('input:not([type="range"])')) : null; };
          plan.push({ what: "Graceful Wrapup message", dep: true,
            found: function () { return !!wuIn(); },
            same: function () { var i = wuIn(); return !!i && i.value === wuMsg; },
            apply: function () { return writeValue(wuIn, wuMsg, true); } });
        }
      }
    }
    if (typeof cfg.enable_first_name_extractor === "boolean") {
      var wantFn = cfg.enable_first_name_extractor;
      plan.push({ what: FIRST_NAME + " → " + (wantFn ? "on" : "off"),
        found: function () { return !!rowSwitch("firstName"); },
        same: function () { return switchOn(rowSwitch("firstName")) === wantFn; },
        missingNote: function () {
          return CC_NO_UI.enable_first_name_extractor(wantFn)
            ? "Call settings: enable_first_name_extractor = " + JSON.stringify(wantFn) + " has no control on this dashboard — not migrated." : "";
        },
        apply: function () { return setSwitch(function () { return rowSwitch("firstName"); }, wantFn); } });
    }
    // Keys with no control: note non-default values, never guess a home for them.
    var handled = CC_HANDLED.concat(["leave_voicemail", "voicemail_text"]);
    Object.keys(cfg).forEach(function (k) {
      if (handled.indexOf(k) !== -1) return;
      var v = cfg[k];
      if (v !== null && v !== undefined && v !== "" && v !== false && !(typeof v === "object" && !Object.keys(v).length))
        notes.push("Call settings: " + k + " = " + JSON.stringify(v) + " has no known control on this dashboard — not migrated.");
    });

    for (var i = 0; i < plan.length; i++) {
      if (d.isAuthRedirect()) return authStop("callConfig");
      var step = plan[i];
      if (!step.found() && step.dep) await until(step.found, 1600);   // revealed by the switch just set
      if (!step.found()) {
        if (step.missingNote) { var mn = step.missingNote(); if (mn) notes.push(mn); step.skipped = true; continue; }
        failed.push(step.what + " (control not found)");
        step.skipped = true;
        continue;
      }
      if (step.same()) continue;          // only change what differs
      var okSet = false;
      try { okSet = await step.apply(); } catch (e) { okSet = false; }
      if (okSet) changed.push(step.what);
      else failed.push(step.what + " (did not take)");
      await sleep(150);
    }
    if (d.isAuthRedirect()) return authStop("callConfig");
    var st = await v2Commit("Call settings", failed, warnings);
    if (st === "auth") return authStop("callConfig");
    // Read back every planned control after the save.
    plan.forEach(function (step) {
      if (step.skipped) return;
      if (failed.some(function (f) { return f.indexOf(step.what) === 0; })) return;
      if (!step.found() || !step.same()) failed.push(step.what + " (reads differently after save)");
    });
    return withWarnings({ section: "callConfig", ok: failed.length === 0, changed: changed, failedItems: failed, notes: notes }, warnings);
  }

  // ========================================================================
  //  top-level run
  // ========================================================================
  // config: parsed magicport.json ; dest: platform of THIS page ; ctx: hooks
  async function run(config, dest, ctx) {
    ctx = ctx || {};
    // Progress for the caller (kept so an interrupted run can still be reported).
    function emitStep(x) { try { if (x && typeof ctx.onStep === "function") ctx.onStep(x); } catch (e) {} }
    dest = dest || window.MagicPort.hostPlatform();
    var mapped = window.MagicPort.mapForDestination(config, dest);
    var results = [], notes = (mapped.notes || []).slice();

    if (dest !== DASH2) {
      return { ok: false, reason: "Magic Port imports into the 2-field dashboard; importing into a 5-field dashboard is not supported yet.", results: results };
    }

    // order: variables -> tools -> prompt -> language/voice -> LLM and STT ->
    // call config -> analysis -> events. LLM/STT and Call Config exist only in
    // a zip from a 2-field source; without their data they are not run at all
    // (no result row), so a 5-field zip behaves exactly as before.
    var md = mapped.data || {};
    var ls = md.llmStt;
    var hasLlmStt = !!(ls && ((ls.llm && (ls.llm.provider || ls.llm.model)) || (ls.stt && (ls.stt.provider || ls.stt.model))));
    var hasCallConfig = !!(md.callConfig && typeof md.callConfig === "object" && Object.keys(md.callConfig).length);
    // Each step carries its section name, so a step that throws is reported
    // under that name (not "step2").
    function named(name, fn) { fn.sectionName = name; return fn; }
    var steps = [
      named("variables", function () { return dash2Variables(md.variables || []); }),
      named("tools", function () { return dash2Tools(md.tools, ctx); }),
      named("prompt", function () { return dash2Prompt(mapped, ctx); }),
      named("languageVoice", function () { return dash2LanguageVoice(md.languageVoice); })
    ];
    if (hasLlmStt) steps.push(named("llmStt", function () {
      var lvR = results.filter(function (x) { return x && x.section === "languageVoice"; })[0];
      return dash2LlmStt(md.llmStt, lvR ? lvR.ok !== false : undefined);
    }));
    if (hasCallConfig) steps.push(named("callConfig", function () { return dash2CallConfig(md.callConfig, ctx); }));
    steps.push(named("analysis", function () { return dash2Analysis(md.analysis || { prompt: "", keys: [] }, ctx); }));
    steps.push(named("events", function () { return dash2Events(md.events, md.eventsExact === true); }));
    // Every result: { section, ok, failedItems[] } (a hook or a thrown step may
    // return less).
    function normalize(r, name) {
      if (!r || typeof r !== "object") r = { section: name, ok: false, reason: "the step returned nothing" };
      if (typeof r.section !== "string") r.section = name;
      if (typeof r.ok !== "boolean") r.ok = !!r.ok;
      if (!Array.isArray(r.failedItems)) r.failedItems = [];
      return r;
    }
    function tabLabelOf(section) { return DASH2_TABS[section] || section; }
    // Raj: commit section-by-section. Each section function already inserts its
    // data and clicks its OWN section Save; after each one returns we ALSO click
    // the GLOBAL (overall) Save so the whole agent is committed after every
    // section — belt-and-braces against any unsaved-state loss, rather than a
    // single global commit at the very end.
    var stopped = false, globalCommits = 0, commitFailures = [], lastCommittedTab = "", commitRejected = [];
    // New UI: one page-wide Save. Every Save pressed during a step is in
    // v2SaveLog; a rejected one FAILS that step, and changes a step left pending
    // are saved right after it (and attributed to it). When that fails too, the
    // step's changes are discarded (C5) so the next step's Save doesn't carry
    // them. The final-save row reports the last Save and anything left over.
    var v2 = isV2(), v2RunWarnings = [], v2Swapped = false;
    v2SaveLog = [];
    // C5 pre-check: never write over (or commit) the user's own unsaved edits.
    if (v2) {
      if (v2InFlight()) await v2WaitIdle(30000);
      if (dom().v2SaveBar()) {
        var preTxt = v2BarText();
        var preFix = preTxt.match(/Fix \d+ fields? in [^.]+|can['’]?t save[^.]*/i);
        var preWhy = preFix
          ? "Nothing was imported: the page has a field that needs fixing first (" + preFix[0] + "). Fix it or press Discard on the page, then start the migration again."
          : "Nothing was imported: the page has unsaved changes (" + (preTxt || "Unsaved changes") + "). Save or discard them on the page first, then start the migration again.";
        return { ok: false, reason: preWhy, results: [{ section: "run", ok: false, reason: preWhy, failedItems: [] }], notes: notes, warnings: [], leftovers: [] };
      }
    }
    var promptIdx = -1;
    steps.forEach(function (s, ix) { if (s.sectionName === "prompt") promptIdx = ix; });
    var held = [];          // steps whose changes wait for the prompt (empty main prompt)
    // Apply the Saves logged since index `from` to the step result r.
    function v2ApplySaves(r, from) {
      v2SaveLog.slice(from).forEach(function (e) {
        if (e.state !== "failed" && e.state !== "blocked") return;
        var line = v2Reject(e.text);
        if (!r.failedItems.some(function (x) { return String(x).indexOf(line) === 0; })) r.failedItems.unshift(line);
        r.ok = false;
        if (!r.reason) r.reason = line;
      });
    }
    function v2Refused(e) { return !!e && (e.state === "failed" || e.state === "blocked"); }
    // Save what a step left pending on the page; if that fails (after its own
    // retry), discard it. Returns true when a later Save stored changes the
    // step had reported as NOT saved (the step is then read back again).
    async function v2CommitAfter(r, from, idx) {
      var d = dom();
      if (!d.v2SaveBar()) return false;
      var stepLog = v2SaveLog.slice(from), last = stepLog[stepLog.length - 1];
      // Empty main prompt: nothing can be saved before the prompt step runs.
      // Keep this step's changes on the page; the prompt's Save carries them.
      if (idx !== undefined && promptIdx > idx) {
        if (v2Refused(last) && V2_EMPTY_PROMPT_RE.test(last.text || "")) {
          if (held.indexOf(idx) === -1) held.push(idx);
          r.held = true;
          return false;
        }
        if (held.length) return false;   // what is pending is the held steps' (saved with the prompt)
      }
      var reread = false;
      if (!v2Refused(last)) {
        var at = v2SaveLog.length, ws = [];
        var e = await saveV2(tabLabelOf(r.section), ws);
        if (e.state === "saved" || (e.state === "unconfirmed" && !d.v2SaveBar())) {
          r.notes = (r.notes || []).concat(["Changes this section left unsaved on the page were saved after it."]);
          withWarnings(r, ws);
          reread = r.failedItems.some(function (x) { return /NOT saved|still unsaved on the page/.test(String(x)); });
        }
        v2ApplySaves(r, at);
      }
      if (d.v2SaveBar() && !d.isAuthRedirect()) {
        // C5: the Save and its retry both failed — throw away what this step
        // changed, so the steps after it save only their own changes.
        var gone = await v2Discard();
        var line = gone
          ? "Not saved — the dashboard refused these " + v2Label(tabLabelOf(r.section)) + " changes, so they were discarded"
          : "Not saved — the " + v2Label(tabLabelOf(r.section)) + " changes are still on the page and could not be discarded; press Discard before saving anything else";
        r.ok = false;
        if (r.failedItems.indexOf(line) === -1) r.failedItems.push(line);
        if (!r.reason) r.reason = line;
        if (typeof r.created === "number") r.created = 0;
        r.discarded = gone;
        if (!gone) v2RunWarnings.push(line);
      }
      return reread;
    }
    // Run a step again to read it back after a later Save stored its changes.
    async function v2Reread(j, prev, note) {
      var again, from2 = v2SaveLog.length;
      try { again = await steps[j](); } catch (e) { return prev; }
      again = normalize(again, prev.section);
      if (typeof again.created === "number" && typeof prev.alreadyPresent === "number" && typeof again.alreadyPresent === "number") {
        var moved = again.alreadyPresent - prev.alreadyPresent;
        if (moved > 0) { again.created += moved; again.alreadyPresent -= moved; }
      }
      again.notes = (again.notes || []).concat([note]);
      v2ApplySaves(again, from2);
      return again;
    }
    // The page moved to another bot (or the run must stop for another reason).
    function guardStop(name) {
      var g = "";
      try { g = (ctx && typeof ctx.guard === "function") ? (ctx.guard() || "") : ""; } catch (e) { g = ""; }
      if (!g) return false;
      results.push({ section: name, ok: false, reason: String(g), stop: true, failedItems: [] });
      return true;
    }
    // Old UI: the overall Save after a section (C4: a fresh failure toast fails
    // the section; no toast is a warning, never "Saved").
    async function oldGlobalSave(r, tabName) {
      // Waits until the save has finished (oldGlobalSavePress), so the next
      // section never writes into a form that is about to re-render.
      var gr = await oldGlobalSavePress();
      if (gr.state === "missing") return false;
      if (gr.state === "disabled") return true;          // nothing left to commit
      if (gr.state === "ok") { globalCommits++; return true; }
      if (gr.state === "fail") {
        var line = tabName + " — Save rejected: " + (gr.text || "the dashboard refused the save");
        // Tools and webhooks are stored as they are added: a refused overall
        // Save there is about other pending changes, not this section's.
        if (r.section === "tools" || r.section === "events") { commitRejected.push(line); return true; }
        r.ok = false;
        if (r.failedItems.indexOf(line) === -1) r.failedItems.push(line);
        if (!r.reason) r.reason = line;
      } else withWarnings(r, ["The dashboard didn't confirm the save — check " + tabName + " by hand"]);
      return true;
    }
    for (var i = 0; i < steps.length; i++) {
      var r;
      await untilVisible();
      if (guardStop(steps[i].sectionName || ("step" + i))) { stopped = true; break; }
      // the layout can change mid-run (old <-> new): follow it per step
      var v2Now = isV2();
      if (v2Now !== v2) { v2Swapped = true; v2 = v2Now; }
      var logFrom = v2SaveLog.length;
      try { r = await steps[i](); } catch (e) { r = { section: steps[i].sectionName || ("step" + i), ok: false, reason: String(e), failedItems: [] }; }
      r = normalize(r, steps[i].sectionName || ("step" + i));
      results.push(r);
      if (v2) v2ApplySaves(r, logFrom);
      if (r && r.stop) { stopped = true; break; } // auth redirect — stop, report where we got to
      // the section save may have bounced us to login — don't commit into the void
      if (dom().isAuthRedirect()) { results.push(authStop("commit")); stopped = true; break; }
      if (isV2() !== v2) { v2Swapped = true; v2 = isV2(); }
      if (v2) {
        if (await v2CommitAfter(r, logFrom, i)) results[results.length - 1] = r = await v2Reread(i, r, "Read back again after a later Save stored its changes.");
        if (dom().isAuthRedirect()) { results.push(authStop("commit")); stopped = true; break; }
        if (i === promptIdx && held.length) {
          // The prompt's Save carried the held steps' changes: read them back,
          // or say they were not saved.
          var promptOk = !r.discarded && !dom().v2SaveBar() && v2SaveLog.slice(logFrom).some(function (e) {
            return e.state === "saved" || (e.state === "unconfirmed" && /closed/.test(e.text || ""));
          });
          var heldNow = held.splice(0);
          for (var h = 0; h < heldNow.length; h++) {
            var hj = heldNow[h], hr = results[hj];
            if (!hr) continue;
            if (promptOk) {
              var hr2 = await v2Reread(hj, hr, "Saved together with the prompt — this dashboard can't save anything while the main prompt is empty.");
              results[hj] = hr2;
              if (dom().v2SaveBar()) await v2CommitAfter(hr2, v2SaveLog.length);
            } else {
              var hl = "Not saved — this dashboard can't save anything while the main prompt is empty, and the prompt couldn't be saved";
              hr.ok = false;
              if (hr.failedItems.indexOf(hl) === -1) hr.failedItems.push(hl);
              if (!hr.reason) hr.reason = hl;
            }
            emitStep(results[hj]);
          }
        }
        emitStep(r);
        continue;
      }
      // Click the overall/global Save now (after this section's own save).
      // NOT every tab has one: Tools and Event Subscription commit each item as
      // it is added ("Add to Assistance" / "Create Subscription") and carry zero
      // Save buttons — verified live 2026-10-31. An absent Save there means
      // "nothing left to commit", not a failure, and reporting it as one made
      // every run end with a false "global Save not found".
      var tabNow = currentTopTab();
      var sameTabAgain = tabNow && tabNow === lastCommittedTab;
      if (dom().findGlobalSave() && !sameTabAgain) {
        // Mark the tab as attempted either way: a failed commit is reported,
        // not silently retried by whichever section happens to land here next.
        lastCommittedTab = tabNow;
        if (dom().isAuthRedirect()) { results.push(authStop("commit")); stopped = true; break; }
        if (!(await oldGlobalSave(r, tabNow || tabLabelOf(r.section))))
          commitFailures.push((r && r.section) || ("step" + i));
      }
      emitStep(r);
      // a global Save must not navigate us off the editor; if it bounced to login, stop
      if (dom().isAuthRedirect()) { results.push(authStop("commit")); stopped = true; break; }
    }
    if (v2Swapped) v2RunWarnings.push("The dashboard switched between its old and new layout during the import — check every section by hand.");

    // Second chance for sections that never got going because their tab could not
    // be opened (e.g. the dashboard was still busy after the previous save). Run
    // each once more now that the page has settled; commit if that tab has a Save.
    if (!stopped) {
      for (var j = 0; j < steps.length && j < results.length; j++) {
        var prev = results[j];
        if (!prev || prev.ok || !/tab could not be selected|section could not be opened/.test(prev.reason || "")) continue;
        if (guardStop(prev.section)) { stopped = true; break; }
        await sleep(1500);
        var again, logFrom2 = v2SaveLog.length;
        v2 = isV2();
        try { again = await steps[j](); } catch (e) { again = { section: prev.section, ok: false, reason: String(e), failedItems: [] }; }
        again = normalize(again, prev.section);
        again.retried = true; results[j] = again;
        if (v2) v2ApplySaves(again, logFrom2);
        if (again.stop) { stopped = true; break; }
        if (dom().isAuthRedirect()) { results.push(authStop("commit")); stopped = true; break; }
        if (v2) { await v2CommitAfter(again, logFrom2); emitStep(again); continue; }
        if (again.ok && dom().findGlobalSave()) await oldGlobalSave(again, currentTopTab() || tabLabelOf(again.section));
        emitStep(again);
      }
    }
    if (!stopped && guardStop("final-save")) stopped = true;

    // Report the commit cadence. ok means every tab that HAD an overall Save
    // was committed — not that all six tabs had one.
    v2 = isV2();
    if (!stopped && v2) {
      // Anything still pending gets one last Save; the row reports that Save
      // and anything left over (each step already reports its own Saves).
      var finFrom = v2SaveLog.length;
      if (dom().v2SaveBar() && !dom().isAuthRedirect()) await saveV2("the agent", v2RunWarnings);
      var rej = v2SaveLog.filter(function (e) { return e.state === "failed" || e.state === "blocked"; });
      var unc = v2SaveLog.filter(function (e) { return e.state === "unconfirmed"; });
      var fin = [];
      v2SaveLog.slice(finFrom).forEach(function (e) { if (v2Refused(e)) fin.push(e.label + ": " + v2Reject(e.text)); });
      var barLeft = dom().v2SaveBar();
      if (barLeft) fin.push("Unsaved changes are still on the page: " + v2BarText());
      results.push({ section: "final-save", ok: !fin.length,
        commits: v2SaveLog.filter(function (e) { return e.state === "saved"; }).length,
        rejected: rej.length, unconfirmed: unc.length, failedItems: fin,
        warnings: unc.filter(function (e) { return !e.text || /closed/.test(e.text); }).map(function (e) { return v2Unconfirmed(e.label); }),
        reason: fin.length ? fin[0] : "" });
    } else if (!stopped) {
      results.push({ section: "final-save", ok: !commitFailures.length && !commitRejected.length, commits: globalCommits,
        failedItems: commitFailures.concat(commitRejected),
        reason: commitFailures.length
          ? "overall Save did not commit after: " + commitFailures.join(", ") : (commitRejected[0] || "") });
    }
    if (results.length && results[results.length - 1].section === "final-save") emitStep(results[results.length - 1]);
    // A failed step always says why (C7: plain words).
    results.forEach(function (r) {
      if (!r || r.ok || r.failedItems.length || r.reason) return;
      if (Array.isArray(r.missing) && r.missing.length) r.reason = "not on the dashboard after the save: " + r.missing.join(", ");
      else if (r.warnings && r.warnings.length) r.reason = r.warnings[0];
      else r.reason = "this section didn't finish — check it by hand";
    });

    // Every section's notes, warnings (contract 2) and leftovers (contract 3)
    // are surfaced at the run level, de-duplicated.
    var warnings = [], leftovers = [];
    v2RunWarnings.forEach(function (n) { if (warnings.indexOf(n) === -1) warnings.push(n); });
    results.forEach(function (r) {
      if (!r) return;
      (r.notes || []).forEach(function (n) { if (n && notes.indexOf(n) === -1) notes.push(n); });
      (r.warnings || []).forEach(function (n) { if (n && warnings.indexOf(n) === -1) warnings.push(n); });
      (r.leftovers || []).forEach(function (n) { if (n && leftovers.indexOf(n) === -1) leftovers.push(n); });
    });

    return { ok: results.every(function (r) { return r.ok; }), results: results, notes: notes, warnings: warnings, leftovers: leftovers };
  }

  window.MagicPortImport = {
    run: run,
    _sections: {
      variables: dash2Variables, analysis: dash2Analysis, events: dash2Events,
      prompt: dash2Prompt, languageVoice: dash2LanguageVoice, tools: dash2Tools,
      llmStt: dash2LlmStt, callConfig: dash2CallConfig
    },
    _read: { variableNames: readDash2VariableNames, variableTypes: readDash2VariableTypes, analysisKeyTypes: readDash2AnalysisKeyTypes,
      v2Variables: readV2Variables, v2AnalysisKeys: readV2AnalysisKeys, v2PromptEditors: v2PromptEditors },
    gotoTab: gotoTab,
    onPause: null,           // set by the panel: fn(true|false) while the tab is hidden
    _untilVisible: untilVisible
  };
})();
