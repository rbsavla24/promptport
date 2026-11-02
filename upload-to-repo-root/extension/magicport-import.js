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
  function sleep(ms) { return dom().sleep(ms); }

  var DASH2 = "dash2", DASH5 = "dash5";

  // ---- navigation ---------------------------------------------------------
  // Dash2 left-nav tab labels.
  var DASH2_TABS = {
    prompt: "Prompt",
    variables: "Custom Variables",
    languageVoice: "Language and Voice",
    events: "Event Subscription",
    tools: "Tools",
    analysis: "Custom Analysis"
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
      // Plain links/buttons carry no aria-selected; fall back to the URL cue.
      if (a === null) return location.href.indexOf("tab=") !== -1;
      return a === "true";
    }
    // A dropdown left open by the previous section (e.g. the language picker)
    // swallows the next click on a tab -- close it first.
    try { if (d.menuIsOpen && d.menuIsOpen()) await d.dismissMenu(); } catch (e) {}
    if (selected()) { await sleep(300); return true; }
    // Right after a section Save the dashboard can be busy re-rendering, with its
    // tabs disabled for a few seconds. Keep trying (click, pointer sequence,
    // focus + Enter) for up to ~9 s instead of giving up after ~1.4 s.
    var deadline = Date.now() + budget, attempt = 0, sawDisabled = false;
    while (Date.now() < deadline) {
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
    return fail(section, "the '" + label + "' tab could not be selected" + (gotoTab.lastWhy ? " — " + gotoTab.lastWhy : ""));
  }

  // Which top-level tab is showing right now (one of DASH2_TABS), or "".
  // A section that has nothing to do (e.g. no tools) returns before navigating,
  // so without this the next commit would re-save the PREVIOUS tab.
  function currentTopTab() {
    var d = dom();
    var labels = [];
    for (var k in DASH2_TABS) { if (DASH2_TABS.hasOwnProperty(k)) labels.push(DASH2_TABS[k]); }
    var t = [].slice.call(document.querySelectorAll('button[role="tab"]'))
      .filter(function (x) {
        return d.visible(x) && x.getAttribute("aria-selected") === "true" &&
               labels.indexOf(d.norm(x.textContent)) !== -1;
      })[0];
    return t ? d.norm(t.textContent) : "";
  }

  function fail(section, reason) { return { section: section, ok: false, reason: reason }; }
  function authStop(section) { return { section: section, ok: false, reason: "auth-redirect", stop: true }; }

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
    if (!(await gotoTab(DASH2_TABS.variables)))
      return tabFail("variables", DASH2_TABS.variables);

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

    var failedItems = [];
    for (var i = 0; i < vars.length; i++) {
      if (d.isAuthRedirect()) return authStop("variables");
      var v = vars[i];
      // d.norm() collapses whitespace but does NOT lowercase (magicport.js's
      // norm does -- the two are easy to confuse). Comparing it to "date" was
      // always false for a source type of "Date", so the Date branch never ran
      // and every Date variable silently landed as String.
      var wantType = String(v.type || "").trim().toLowerCase() === "date" ? "Date" : "String";
      var r = await withRetry(async function () {
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
        var ab = addBtn(); if (ab) ab.click();
      }, function () {
        if (readDash2VariableNames().indexOf(v.name) === -1) return false;
        var got = readDash2VariableTypes()[v.name];
        // an unreadable chip type must not fail a variable that is really there
        return !got || d.norm(got) === wantType;
      }, 3);
      if (r.auth) return authStop("variables");
      if (!r.ok) failedItems.push(v.name);
      await sleep(120);
    }
    // Save (variables section save; companion heuristic: not the global "Back" group)
    d.clickSectionSave(/* companion */ null);
    await d.waitForToast(/saved|updated|success/i, 3000);

    // verify (REQ-1): re-read variable chips. The list can lag its backend, so
    // re-read a few times before calling a variable missing.
    await sleep(400);
    var actual = readDash2VariableNames();
    var vr = window.MagicPort.verifyVariables(vars, actual);
    for (var vt = 0; vt < 5 && !vr.ok; vt++) {
      await sleep(500);
      actual = readDash2VariableNames();
      vr = window.MagicPort.verifyVariables(vars, actual);
    }

    // This import ADDS and UPDATES; it never deletes. Variables already on the
    // destination that the source doesn't have are left untouched -- but they
    // are reported, so the difference is visible instead of silent. (The consent
    // copy used to claim the import "overwrites" the destination; it does not.)
    // verify TYPES too (the chips carry them). Names alone were never enough:
    // a Date that silently landed as String passed every check before this.
    var typesByName = readDash2VariableTypes();
    var wrongTypes = [];
    vars.forEach(function (v) {
      var want = String(v.type || "").trim().toLowerCase() === "date" ? "Date" : "String";
      var got = typesByName[v.name];
      if (got && d.norm(got) !== want) wrongTypes.push(v.name + " (want " + want + ", got " + got + ")");
    });

    var sourceNames = vars.map(function (v) { return d.norm(v.name); });
    var extras = actual.filter(function (n) { return sourceNames.indexOf(d.norm(n)) === -1; });

    if (wrongTypes.length) failedItems = failedItems.concat(wrongTypes.map(function (x) { return "type: " + x; }));

    return { section: "variables", ok: vr.ok && !failedItems.length,
      expected: vr.expectedCount, actual: vr.actualCount, missing: vr.missing,
      extras: extras,
      notes: extras.length
        ? [extras.length + " variable(s) already on the destination were left in place (not in the source): " + extras.join(", ")]
        : [],
      failedItems: failedItems };
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

  // ---- 4. Custom Analysis: prompt + keys (REQ-2) -------------------------
  async function dash2Analysis(analysis, ctx) {
    var d = dom();
    if (d.isAuthRedirect()) return authStop("analysis");
    if (!(await gotoTab(DASH2_TABS.analysis)))
      return tabFail("analysis", DASH2_TABS.analysis);
    ctx = ctx || {};
    var promptWhy = "";

    // Analysis System Prompt body: write analysis.prompt into the single TipTap
    // editor on this tab (reuses the content.js prompt-paste path via ctx).
    // A missing writer hook is NOT "nothing to do". Previously promptOk stayed
    // true whenever ctx.pasteTipTap was absent, so the section reported success
    // for a System Prompt it had never written -- the analysis prompt went
    // missing with no entry in the report. Only an EMPTY source prompt is a
    // legitimate no-op; anything else that stops us writing is a failure.
    var promptOk = true;
    if (analysis.prompt) {
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

    var keys = analysis.keys || [];
    var failedKeys = [];
    for (var i = 0; i < keys.length; i++) {
      if (d.isAuthRedirect()) return authStop("analysis");
      var k = keys[i];
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
          if (isOn !== want) d.pressSequence(sw);
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
      if (!r.ok) failedKeys.push(k.name);
      await sleep(120);
    }
    // Save (section save sits with "Test Analysis")
    d.clickSectionSave("Test Analysis");
    await d.waitForToast(/custom analysis saved|saved|updated/i, 3500);

    // verify (REQ-2): re-read each key's type. Dash2 renders this list behind
    // its own backend, so a single read right after saving can still show the
    // pre-save state and report every key "missing". Re-read until the list
    // agrees or we run out of patience.
    await sleep(400);
    var keyNames = keys.map(function (x) { return x.name; });
    var actualByName = readDash2AnalysisKeyTypes(keyNames);
    var kr = window.MagicPort.verifyKeyTypes(keys, actualByName);
    for (var vtry = 0; vtry < 5 && !kr.ok; vtry++) {
      await sleep(500);
      actualByName = readDash2AnalysisKeyTypes(keyNames);
      kr = window.MagicPort.verifyKeyTypes(keys, actualByName);
    }
    var failedAll = failedKeys.slice();
    if (!promptOk) failedAll.push("System Prompt (analysis)" + (promptWhy ? " — " + promptWhy : ""));
    return { section: "analysis", ok: kr.ok && !failedAll.length, wrong: kr.wrong, count: keys.length, failedItems: failedAll };
  }

  // name -> type from the rendered "name [Type] Required" rows. innerText is the
  // reliable source (name/type live in separate spans), so parse from it.
  function readDash2AnalysisKeyTypes(names) {
    var main = document.querySelector("main") || document.body;
    var txt = main.innerText || "";
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
          var t = (els[i].textContent || "").replace(/\s+/g, " ").trim();
          if (t.indexOf(n) === 0) hit = t.match(rx);
        }
      }
      if (hit) out[n] = hit[1] || hit[2] || hit[3];
      else delete out[n];          // never trust a partial-name match for a key we asked about
    });
    return out;
  }

  // ---- 6. Event Subscription ---------------------------------------------
  async function dash2Events(events) {
    var d = dom();
    if (d.isAuthRedirect()) return authStop("events");
    events = events || [];
    // A source with no webhooks is a no-op: don't navigate (and don't fail on a
    // tab we never needed), and don't report other people's rows as "created".
    if (!events.length) {
      return { section: "events", ok: true, created: 0, expected: 0, alreadyPresent: 0, failedItems: [] };
    }
    if (!(await gotoTab(DASH2_TABS.events)))
      return tabFail("events", DASH2_TABS.events);
    var DASH2_EVENT_ORDER = ["Transcript ready", "Recording ready", "Analysis completed"];

    // Each existing subscription exposes its URL in the delete button's
    // aria-label ("Delete subscription <url>"), so we can identify rows by URL
    // instead of just counting them. Verified live 2026-10-31.
    function subButtons() {
      return [].slice.call(document.querySelectorAll("button[aria-label^='Delete subscription']"));
    }
    function urlOf(btn) {
      return d.norm(btn.getAttribute("aria-label")).replace(/^Delete subscription\s*/i, "");
    }
    function subUrls() { return subButtons().map(urlOf); }
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
      var row = rowFor(url); if (!row) return [];
      var t = d.norm(row.innerText);
      return DASH2_EVENT_ORDER.filter(function (e) { return t.indexOf(e) !== -1; });
    }

    var failedHooks = [], createdCount = 0, alreadyPresent = 0;
    for (var i = 0; i < events.length; i++) {
      if (d.isAuthRedirect()) return authStop("events");
      var w = events[i];
      var want = (w.events && w.events.length) ? w.events : DASH2_EVENT_ORDER.slice();

      // Idempotent: if this URL is already subscribed with the right events,
      // leave it alone. Previously every retry created another copy.
      if (countFor(w.url) > 0 && eventsFor(w.url).length >= want.length) { alreadyPresent++; continue; }

      var r = await withRetry(async function () {
        // Never create a second row for a URL that now exists — this is what
        // turned 1 webhook into 3 identical ones in the live run. Re-read once
        // after a short settle: on a retry the row may have been created by the
        // previous attempt and simply not rendered yet.
        if (countFor(w.url) > 0) return;
        await sleep(400);
        if (countFor(w.url) > 0) return;
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
        var picked = await d.selectMenuByClick(combo, want);
        if (picked.selected.length !== want.length) {
          // Don't create a half-configured hook: back out and let the retry run.
          d.clickButtonByText("Cancel");
          await sleep(300);
          return;
        }
        d.clickButtonByText("Create");
        await d.waitForToast(/subscription created|created|saved/i, 3500);
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
        return countFor(w.url) === 1 && eventsFor(w.url).length >= want.length;
      }, 3);

      if (r.auth) return authStop("events");
      if (r.ok) createdCount++;
      if (!r.ok) {
        var got = eventsFor(w.url);
        failedHooks.push(w.url + (countFor(w.url) ? " (events: " + (got.join(", ") || "none") + " — expected " + want.join(", ") + ")" : " (not created)"));
      }
      await sleep(400);
    }

    await sleep(300);
    var problems = failedHooks.slice();
    events.forEach(function (e) {
      var n = countFor(e.url);
      if (n > 1) problems.push("duplicate subscription x" + n + ": " + e.url);
    });
    return {
      section: "events",
      ok: problems.length === 0,
      // what THIS run created — not every row on the page, which previously
      // counted subscriptions that were already on the destination.
      created: createdCount,
      alreadyPresent: alreadyPresent,
      expected: events.length,
      onPage: subUrls().length,
      failedItems: problems
    };
  }

  // ---- scaffolded sections (finalized during live pass) -------------------
  async function dash2Prompt(mapped, ctx) {
    var d = dom();
    if (d.isAuthRedirect()) return authStop("prompt");
    // MUST be on the Prompt tab before writing (its editors live there), and the
    // section MUST be saved before the orchestrator navigates to the next tab,
    // or an SPA tab-switch can discard the unsaved editor content.
    if (!(await gotoTab(DASH2_TABS.prompt)))
      return tabFail("prompt", DASH2_TABS.prompt);
    if (ctx && typeof ctx.importPrompt === "function") {
      var r = await ctx.importPrompt(mapped);
      if (d.isAuthRedirect()) return authStop("prompt");
      d.clickSectionSave(null);                 // save Prompt before leaving the tab
      await d.waitForToast(/saved|updated|success/i, 3000);
      return r || { section: "prompt", ok: false, reason: "prompt writer returned nothing" };
    }
    return { section: "prompt", ok: false, reason: "prompt writer hook not provided (TODO@LIVE)" };
  }
  async function dash2LanguageVoice(lv) {
    var d = dom();
    if (d.isAuthRedirect()) return authStop("languageVoice");
    if (!(await gotoTab(DASH2_TABS.languageVoice)))
      return tabFail("languageVoice", DASH2_TABS.languageVoice);
    lv = lv || {};
    var failed = [];

    // The language picker for a label is the input inside that label's own field
    // container — climb from the label to the nearest ancestor holding an input.
    // (Document-order "first following input" is unreliable here.)
    function langInput(labelText) {
      var labels = [].slice.call(document.querySelectorAll("label,span,div,p,h1,h2,h3,h4,h5,h6"))
        .filter(function (e) { return e.children.length === 0 && d.norm(e.textContent) === labelText && d.visible(e); });
      for (var li = 0; li < labels.length; li++) {
        var node = labels[li];
        for (var k = 0; k < 6 && node; k++) {
          node = node.parentElement;
          if (node) { var inp = node.querySelector("input"); if (inp && d.visible(inp)) return inp; }
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
          d.openDropdown(trig);
          await sleep(350);
          // filterable list: type into a filter box if present to reveal the option
          var filt = [].slice.call(document.querySelectorAll("input")).filter(function (i) { return d.visible(i) && /filter|search/i.test(i.placeholder || ""); })[0];
          if (filt) { d.setReactInput(filt, val); await sleep(300); }
          d.selectSingleOption(val);
          await sleep(250);
          var cur = langInput(labelText);
          if (cur && d.norm(cur.value) === d.norm(val)) return true;
        }
        await sleep(200);
      }
      failed.push(labelText + (value ? " → " + value : ""));
      return false;
    }

    await setLang("Primary Language", lv.primaryLanguage);
    await setLang("Secondary Language", lv.secondaryLanguage);

    // Save on this tab before leaving (tab-switch discards unsaved changes).
    if (!d.clickSectionSave(null)) d.clickGlobalSave();
    await d.waitForToast(/saved|updated|success/i, 3000);
    return { section: "languageVoice", ok: failed.length === 0, failedItems: failed };
  }
  var PHASES = ["pre_call", "on_call", "post_call"];
  var PHASE_TAB = { pre_call: "Pre Call", on_call: "On call", post_call: "Post Call" };
  async function dash2Tools(tools, ctx) {
    var d = dom(); ctx = ctx || {};
    if (d.isAuthRedirect()) return authStop("tools");
    tools = tools || {};
    if (!PHASES.some(function (p) { return (tools[p] || []).length; })) return { section: "tools", ok: true, created: 0 };
    if (!(await gotoTab(DASH2_TABS.tools)))
      return tabFail("tools", DASH2_TABS.tools);
    var failed = [], created = 0;

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

    function phaseUnavailable() {
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
      if (!name) return false;
      var want = d.norm(name);
      return [].slice.call(phasePanel().querySelectorAll("[aria-label]")).some(function (el) {
        var a = d.norm(el.getAttribute("aria-label"));
        return a === "Edit API " + want || a === "Delete API " + want;
      });
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
      // the Name field sits above the "Saved in snake_case" helper text
      var help = [].slice.call(document.querySelectorAll("*")).filter(function (e) { return e.children.length === 0 && d.visible(e) && /saved in snake_case/i.test(e.textContent || ""); })[0];
      if (help) {
        var node = help;
        for (var k = 0; k < 4 && node; k++) { node = node.parentElement; if (node) { var inp = node.querySelector("input"); if (inp && d.visible(inp)) return inp; } }
      }
      return labeledInput("Name") || labeledInput("Tool Name");
    }
    function urlInput() {
      return [].slice.call(document.querySelectorAll("input")).filter(function (i) { return d.visible(i) && /api_url/i.test(i.placeholder || ""); })[0]
        || [].slice.call(document.querySelectorAll("input")).filter(function (i) { return d.visible(i) && (i.type === "url"); })[0]
        || labeledInput("URL") || labeledInput("API URL") || labeledInput("API Url");
    }
    function methodTrigger() {
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
    var ROW_TYPE = { static: "Static Row", variable: "Variable Row", jq: "JQ Row" };
    var pendingVariableItems = [];

    function activePanel() {
      var ps = [].slice.call(document.querySelectorAll('[role="tabpanel"]')).filter(function (p) { return d.visible(p); });
      return ps[ps.length - 1] || document.querySelector("main") || document.body;
    }
    // A visible leaf element (or role=option/menuitem) whose text equals `text`.
    function optionByText(text) {
      var want = d.norm(text);
      var roled = [].slice.call(document.querySelectorAll('[role="option"],[role="menuitem"],[role="menuitemradio"]'))
        .filter(function (o) { return d.visible(o) && d.norm(o.textContent) === want; });
      if (roled.length) return roled[0];
      return [].slice.call(document.querySelectorAll("div,span,li,button,p"))
        .filter(function (e) { return e.children.length === 0 && d.visible(e) && d.norm(e.textContent) === want; })[0] || null;
    }
    // Activate a menu option with ONE dispatch. The previous version called
    // clickEl() and then pressSequence() as a "fallback"; components that handle
    // the click fired TWICE, so "Variable Row" inserted TWO rows — the key landed
    // in the first and the picked variable in the second, and the tool could not
    // be added. pressSequence already ends with a click event, so it covers both
    // plain and Radix-style menus on its own. Verified live 2026-10-31.
    function clickOption(text) {
      var o = optionByText(text); if (!o) return false;
      d.pressSequence(o);
      return true;
    }
    // Open the newest row's "Search variable..." picker and choose the variable.
    async function selectSearchVariable(panel, item) {
      var combo = [].slice.call(panel.querySelectorAll("*"))
        .filter(function (e) { return d.visible(e) && /search variable/i.test(e.textContent || "") && d.norm(e.textContent).length < 40; }).pop();
      if (!combo) return false;
      d.openDropdown(combo);
      await sleep(450);
      var name = item.variable || item.value;
      // Dash2 lists custom variables as "custom_args.<name>". call_data /
      // platform_analysis / client_analysis / tool_output are Dash5-only sources
      // with no custom-variable equivalent — try the literal, else give up (flag).
      var wanted = [];
      var src = item.source || "custom_args";
      if (src === "custom_args") wanted.push("custom_args." + name);
      else { wanted.push(src + "." + name); wanted.push("custom_args." + name); }
      if (item.value) wanted.push(item.value);
      // If an inline search box appeared, type to filter the (possibly long) list.
      // LIVE 2026-11-02: the picker's filter box reads "Enter the value to filter".
      var filt = [].slice.call(document.querySelectorAll("input"))
        .filter(function (i) { return d.visible(i) && /search variable|value to filter|filter|search/i.test(i.placeholder || ""); })[0];
      if (filt) { d.setReactInput(filt, name); await sleep(400); }
      for (var w = 0; w < wanted.length; w++) {
        if (clickOption(wanted[w])) { await sleep(300); return true; }
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
    async function openSubTab(label) {
      var tab = [].slice.call(document.querySelectorAll('button[role="tab"]'))
        .filter(function (t) { return d.visible(t) && d.norm(t.textContent) === label; })[0];
      if (!tab) return null;
      // Radix tab triggers do NOT switch on a synthetic .click(): they listen for
      // the pointerdown/mouseup sequence. Verified live 2026-10-31 — clickEl()
      // left aria-selected="false", so Path/Query/Body never opened and every row
      // fell back into the default Headers panel. Escalate to pressSequence and
      // confirm via aria-selected before trusting the panel.
      for (var a = 0; a < 3 && tab.getAttribute("aria-selected") !== "true"; a++) {
        if (a === 0) d.clickEl(tab); else d.pressSequence(tab);
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
        var typeLabel = ROW_TYPE[item.kind];
        if (!typeLabel) {
          // "dynamic" (or any other kind) has no Dash2 row type — flag, don't guess.
          failed.push(sectionLabel + ": " + item.key + " (" + (item.kind || "unknown") + " — no matching row type on this dashboard)");
          continue;
        }
        var beforeInputs = [].slice.call(subPanel.querySelectorAll("input")).filter(function (x) { return d.visible(x); });
        var addRowBtn = [].slice.call(subPanel.querySelectorAll("[role='button'],button"))
          .filter(function (b) { return d.visible(b) && /^add row$/i.test(d.norm(b.textContent)); })[0];
        if (!addRowBtn) { failed.push(sectionLabel + ": " + item.key + " (Add Row not found)"); continue; }
        d.clickEl(addRowBtn);
        await sleep(350);
        if (!clickOption(typeLabel)) {
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
        var afterInputs = [].slice.call(panel.querySelectorAll("input")).filter(function (x) { return d.visible(x); });
        var rowInputs = afterInputs.filter(function (x) { return beforeInputs.indexOf(x) === -1; });
        if (!rowInputs.length) rowInputs = afterInputs;   // defensive fallback
        if (item.kind === "variable") {
          // variable row: [Key, picker-input] in DOM order — take the FIRST.
          var vKey = rowInputs[0];
          if (vKey) d.setReactInput(vKey, item.key);
          // Scope the picker to THIS row. selectSearchVariable() takes the last
          // "Search variable..." on the panel, so with any other row present it
          // bound the variable to the wrong row.
          var rowEl = vKey;
          for (var rk = 0; rk < 6 && rowEl; rk++) {
            rowEl = rowEl.parentElement;
            if (rowEl && /search variable/i.test(rowEl.textContent || "")) break;
          }
          var okVar = await selectSearchVariable(rowEl || panel, item);
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
          if (sVal) d.setReactInput(sVal, val);
        }
        await sleep(150);
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

    var lastToolError = "";
    async function addTool(parts) {
      lastToolError = "";
      // On a retry the tool may have been created by the previous attempt and
      // simply not rendered yet -- re-read once after a settle before adding.
      if (toolExists(parts.name)) return;
      await sleep(400);
      if (toolExists(parts.name)) return;
      closeOpenApiModal(); await sleep(150);
      // The control's textContent is "API" (the + is an SVG icon); matching the
      // literal "+ API" silently failed. Accept either. Verified live 2026-10-31.
      var addApi = [].slice.call(document.querySelectorAll("button,[role='button']"))
        .filter(function (b) { return d.visible(b) && /^\+?\s*API$/i.test(d.norm(b.textContent)); })[0];
      if (!addApi) return;
      d.clickEl(addApi);
      await sleep(900);
      var nm = formNameInput(); if (nm) d.setReactInput(nm, parts.name);
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
      for (var ma = 0; ma < 3 && !methodOk; ma++) {
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
        closeOpenApiModal();
        await sleep(200);
        return;
      }
      lastToolError = "";
      // All four parameter sections use the same row model (Body is NOT a JSON
      // editor — confirmed live: it uses Static/Variable/JQ rows like the rest).
      await addRowKV("Headers", parts.headers);
      await addRowKV("Query", parts.query);
      await addRowKV("Path", parts.path);
      await addRowKV("Body", parts.body);
      d.clickButtonByText("Add to Assistance");
      // WAIT for the tool row to appear before the attempt ends. The tools list
      // lags its own backend exactly as the subscription list does, and lags
      // more as rows accumulate -- so a blind sleep let the verify read a stale
      // panel, report "not created", and the retry added the SAME tool again.
      // Same defect class as the webhook duplicated on the 4th hook.
      await d.waitFor(function () { return toolExists(parts.name); }, 6000, 250);
      await sleep(300);
      if (!toolExists(parts.name) && apiDrawerOpen()) {
        // The dashboard refused the tool. Record what it complained about so the
        // report says WHY (a field marked invalid, an error line, a toast), then
        // close the drawer so the retry starts clean.
        var why = [];
        [].slice.call(document.querySelectorAll("[aria-invalid='true']")).forEach(function (f) {
          if (d.visible(f)) why.push((f.getAttribute("aria-label") || "a field") + " marked invalid");
        });
        [].slice.call(document.querySelectorAll("p,span,div,li")).forEach(function (e) {
          if (e.children.length || !d.visible(e)) return;
          var t = d.norm(e.textContent);
          if (t.length > 3 && t.length < 160 && /(required|invalid|error|failed|must|not allowed|already exists|unable)/i.test(t) && why.indexOf(t) === -1) why.push(t);
        });
        lastToolError = "the dashboard did not accept the tool" + (why.length ? ": " + why.slice(0, 3).join("; ") : "");
        closeOpenApiModal(); await sleep(300);
      }
    }

    for (var pi = 0; pi < PHASES.length; pi++) {
      var phase = PHASES[pi];
      var list = tools[phase] || []; if (!list.length) continue;
      if (d.isAuthRedirect()) return authStop("tools");
      // The phase tabs are Radix tab triggers too: clickButtonByText() uses
      // .click(), which does NOT switch them. The loop then stayed on whatever
      // phase was already selected and wrote that phase's tools into it —
      // observed live: "greetings" (pre_call) was added under On call.
      // Select by role=tab + verify aria-selected, exactly like the sub-tabs.
      var phasePanelEl = await openSubTab(PHASE_TAB[phase]);
      if (!phasePanelEl) {
        list.forEach(function (t) {
          failed.push(PHASE_TAB[phase] + ": " + toolLabel(t) + " (phase tab not selectable)");
        });
        continue;
      }
      await sleep(400);
      if (phaseUnavailable()) {
        list.forEach(function (t) { failed.push(PHASE_TAB[phase] + ": " + toolLabel(t) + " (phase not supported on destination)"); });
        continue;
      }
      for (var ti = 0; ti < list.length; ti++) {
        var parts = window.MagicPort.extractToolParts(list[ti]);
        var r = await withRetry(function () { return addTool(parts); }, function () { return toolExists(parts.name); }, 3);
        if (r.auth) return authStop("tools");
        if (r.ok) created++;
        else failed.push(PHASE_TAB[phase] + ": " + (parts.name || "(unnamed)") +
                         (lastToolError ? " (" + lastToolError + ")" : ""));
        await sleep(200);
      }
    }
    if (!d.clickSectionSave(null)) d.clickGlobalSave();
    await d.waitForToast(/saved|updated|success/i, 3000);
    // Variables are now bound via the Search-variable picker; only items the picker
    // didn't offer remain in pendingVariableItems (each already carries its reason).
    // Dedupe: a retried tool add can re-push the same row-level note.
    var allItems = failed.concat(pendingVariableItems).filter(function (v, i, a) { return a.indexOf(v) === i; });
    return { section: "tools", ok: allItems.length === 0, created: created, failedItems: allItems };
  }

  // ========================================================================
  //  top-level run
  // ========================================================================
  // config: parsed magicport.json ; dest: platform of THIS page ; ctx: hooks
  async function run(config, dest, ctx) {
    ctx = ctx || {};
    dest = dest || window.MagicPort.hostPlatform();
    var mapped = window.MagicPort.mapForDestination(config, dest);
    var results = [], notes = (mapped.notes || []).slice();

    if (dest !== DASH2) {
      return { ok: false, reason: "Magic Port imports into the 2-field dashboard; importing into a 5-field dashboard is not supported yet.", results: results };
    }

    // order: variables -> tools -> prompt -> language/voice -> analysis -> events
    var steps = [
      function () { return dash2Variables(mapped.data.variables); },
      function () { return dash2Tools(mapped.data.tools, ctx); },
      function () { return dash2Prompt(mapped, ctx); },
      function () { return dash2LanguageVoice(mapped.data.languageVoice); },
      function () { return dash2Analysis(mapped.data.analysis, ctx); },
      function () { return dash2Events(mapped.data.events); }
    ];
    // Raj: commit section-by-section. Each section function already inserts its
    // data and clicks its OWN section Save; after each one returns we ALSO click
    // the GLOBAL (overall) Save so the whole agent is committed after every
    // section — belt-and-braces against any unsaved-state loss, rather than a
    // single global commit at the very end.
    var stopped = false, globalCommits = 0, commitFailures = [], lastCommittedTab = "";
    for (var i = 0; i < steps.length; i++) {
      var r;
      try { r = await steps[i](); } catch (e) { r = { section: "step" + i, ok: false, reason: String(e) }; }
      results.push(r);
      if (r && r.stop) { stopped = true; break; } // auth redirect — stop, report where we got to
      // the section save may have bounced us to login — don't commit into the void
      if (dom().isAuthRedirect()) { results.push(authStop("commit")); stopped = true; break; }
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
        if (dom().clickGlobalSave()) globalCommits++;
        else commitFailures.push((r && r.section) || ("step" + i));
        await dom().waitForToast(/saved|updated|success/i, 3500);
      }
      // a global Save must not navigate us off the editor; if it bounced to login, stop
      if (dom().isAuthRedirect()) { results.push(authStop("commit")); stopped = true; break; }
    }

    // Second chance for sections that never got going because their tab could not
    // be opened (e.g. the dashboard was still busy after the previous save). Run
    // each once more now that the page has settled; commit if that tab has a Save.
    if (!stopped) {
      for (var j = 0; j < steps.length && j < results.length; j++) {
        var prev = results[j];
        if (!prev || prev.ok || !/tab could not be selected/.test(prev.reason || "")) continue;
        await sleep(1500);
        var again;
        try { again = await steps[j](); } catch (e) { again = { section: prev.section, ok: false, reason: String(e) }; }
        if (again) { again.retried = true; results[j] = again; }
        if (again && again.stop) { stopped = true; break; }
        if (again && again.ok && dom().findGlobalSave()) {
          if (dom().clickGlobalSave()) globalCommits++;
          await dom().waitForToast(/saved|updated|success/i, 3500);
        }
      }
    }

    // Report the commit cadence. ok means every tab that HAD an overall Save
    // was committed — not that all six tabs had one.
    if (!stopped) {
      results.push({ section: "final-save", ok: !commitFailures.length, commits: globalCommits,
        failedItems: commitFailures,
        reason: commitFailures.length
          ? "overall Save did not commit after: " + commitFailures.join(", ") : "" });
    }

    return { ok: results.every(function (r) { return r.ok; }), results: results, notes: notes };
  }

  window.MagicPortImport = {
    run: run,
    _sections: {
      variables: dash2Variables, analysis: dash2Analysis, events: dash2Events,
      prompt: dash2Prompt, languageVoice: dash2LanguageVoice, tools: dash2Tools
    },
    _read: { variableNames: readDash2VariableNames, variableTypes: readDash2VariableTypes, analysisKeyTypes: readDash2AnalysisKeyTypes },
    gotoTab: gotoTab
  };
})();
