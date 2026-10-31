/*
 * magicport-dom.js  (ISOLATED world)  — PromptPort v4.0
 *
 * Low-level DOM-driving primitives for Magic Port import. Every technique here
 * was validated LIVE on Rezolv QA from in-page JS (see LIVE-CROSS-SITE-TEST):
 *
 *   openDropdown(trigger)      - full pointer/mouse event sequence (a bare
 *                                .click() does NOT open React/Radix dropdowns).
 *   selectSingleOption(text)   - single-select (non-modal): same event sequence
 *                                on the option row (e.g. key Type -> Number).
 *   selectMenuByKeyboard(..)   - multiselect inside a MODAL (e.g. Events): a
 *                                pointerdown on a portaled option closes the
 *                                dialog, so selection is done by KEYBOARD
 *                                (focus combo -> ArrowDown -> Enter). Portal-safe.
 *   setReactInput(el, value)   - React-controlled input write (native setter).
 *   findSectionSave(companion) - the CORRECT Save button: the section Save sits
 *                                with a section companion (e.g. "Test Analysis");
 *                                the GLOBAL save sits with "Back".
 *   clickButtonByText / click  - normal buttons DO respond to .click().
 *   isAuthRedirect()           - detect the Rezolv login bounce (never "save
 *                                into the void" after a session drop).
 *
 * All helpers are defensive and return booleans / found elements so the
 * orchestrator can assert and report.
 */
(function () {
  "use strict";

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function visible(el) {
    return !!(el && el.offsetParent !== null);
  }

  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

  // ---- event helpers ------------------------------------------------------
  function fire(target, type, Ctor, extra) {
    if (!target) return;
    var ev = new Ctor(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view: window }, extra || {}));
    target.dispatchEvent(ev);
  }

  // Full pointer+mouse press sequence. This is what opens React/Radix custom
  // dropdowns (and selects an option in a non-modal single-select).
  function pressSequence(target) {
    if (!target) return false;
    var PE = window.PointerEvent || MouseEvent;
    fire(target, "pointerdown", PE, { pointerId: 1, button: 0, isPrimary: true });
    fire(target, "mousedown", MouseEvent, { button: 0 });
    fire(target, "pointerup", PE, { pointerId: 1, button: 0, isPrimary: true });
    fire(target, "mouseup", MouseEvent, { button: 0 });
    fire(target, "click", MouseEvent, { button: 0 });
    return true;
  }

  function keyPress(el, key, keyCode) {
    if (!el) return;
    var init = { key: key, code: key, keyCode: keyCode || 0, which: keyCode || 0, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }
  var KEY = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Space: 32, Escape: 27 };

  // ---- inputs -------------------------------------------------------------
  // Write a value into a React-controlled <input>/<textarea> so React sees it.
  function setReactInput(el, value) {
    if (!el) return false;
    try {
      var proto = Object.getPrototypeOf(el);
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      (desc && desc.set ? desc.set : function (v) { el.value = v; }).call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }

  // ---- dropdowns ----------------------------------------------------------
  // Open a custom dropdown by its trigger element.
  function openDropdown(trigger) {
    if (!trigger) return false;
    try { trigger.focus(); } catch (e) {}
    return pressSequence(trigger);
  }

  // Find a visible option row whose text equals `text` (role=option/menuitem
  // preferred, else a leaf element).
  function findOption(text) {
    var want = norm(text);
    var roled = [].slice.call(document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemcheckbox"]'))
      .filter(function (o) { return visible(o) && norm(o.textContent) === want; });
    if (roled.length) return roled[0];
    var leaves = [].slice.call(document.querySelectorAll("*")).filter(function (el) {
      return el.children.length === 0 && visible(el) && norm(el.textContent) === want;
    });
    return leaves[0] || null;
  }

  // Select an option in a SINGLE-select, non-modal dropdown (the dropdown must
  // already be open). Option styles differ across Rezolv dropdowns:
  //   - some select on a full press sequence (e.g. the key Type dropdown),
  //   - some are role="menuitem" buttons that select on a bare .click()
  //     (e.g. the Language pickers) and ignore a press on the inner <span>.
  // So: bare-click first; if the option is still showing, fall back to a press.
  function selectSingleOption(text) {
    var opt = findOption(text);
    if (!opt) return false;
    clickEl(opt);
    var still = findOption(text);
    if (still && visible(still)) pressSequence(still);
    return true;
  }

  // Select one or more options in a MULTISELECT rendered in a modal, by
  // KEYBOARD (pointer events on a portaled option close the dialog). The combo
  // must be focusable; we open it, then arrow+Enter to each wanted option.
  // `optionOrder` is the full option list in menu order (top to bottom).
  async function selectMenuByKeyboard(combo, wantedTexts, optionOrder) {
    if (!combo) return { ok: false, reason: "no combobox" };
    try { combo.focus(); } catch (e) {}
    keyPress(combo, "ArrowDown", KEY.ArrowDown); // open / enter the menu
    await sleep(250);
    var selected = [];
    // Walk the menu top-to-bottom; toggle the ones we want.
    for (var i = 0; i < optionOrder.length; i++) {
      var active = document.activeElement || combo;
      // highlight the i-th item (we arrowed into item 0 already on open on some
      // builds; move down one per step after the first)
      if (i > 0) { keyPress(active, "ArrowDown", KEY.ArrowDown); await sleep(120); active = document.activeElement || combo; }
      var hereText = norm(active && active.textContent);
      if (wantedTexts.indexOf(hereText) !== -1 && selected.indexOf(hereText) === -1) {
        keyPress(active, "Enter", KEY.Enter);
        selected.push(hereText);
        await sleep(150);
      }
    }
    return { ok: selected.length === wantedTexts.length, selected: selected };
  }


  // Multi-select by CLICKING each option.
  // Radix/Headless-style listboxes move a VIRTUAL highlight
  // (aria-activedescendant) rather than real DOM focus, so the keyboard walk in
  // selectMenuByKeyboard read document.activeElement and almost never matched —
  // in the live run it ticked exactly ONE event and its stray Enter presses
  // submitted the dialog repeatedly, producing duplicate subscriptions.
  // Verified live on Rezolv QA 2026-10-31.
  async function selectMenuByClick(combo, wantedTexts) {
    var selected = [];
    if (!combo) return { ok: false, selected: selected };
    // The menu stays open across option clicks, and re-pressing the trigger
    // TOGGLES it shut -- so open exactly once and click every option in turn.
    openDropdown(combo);
    await sleep(400);
    for (var i = 0; i < wantedTexts.length; i++) {
      var want = wantedTexts[i];
      var opt = findOption(want);
      if (!opt) { await sleep(300); opt = findOption(want); }
      if (opt) { pressSequence(opt); selected.push(want); await sleep(400); }
    }
    // Close the menu by toggling the trigger. Escape would bubble to the
    // surrounding Radix dialog and dismiss it, losing the unsaved form.
    if (menuIsOpen()) { pressSequence(combo); await sleep(400); }
    if (menuIsOpen()) { pressSequence(combo); await sleep(400); }
    if (menuIsOpen()) await dismissMenu();
    return { ok: selected.length === wantedTexts.length, selected: selected };
  }

  // Close an open popup menu WITHOUT destroying the form or dialog that owns it.
  //
  // Escape is NOT safe here. It bubbles to the surrounding Radix dismissable
  // layer and tears down the whole host. Verified live 2026-10-31 on BOTH
  // surfaces: on the "Create Subscription" dialog Escape closed the dialog with
  // the filled-in form, and on the INLINE "+ API" editor (which is not even a
  // role=dialog) Escape removed the editor's "Add to Assistance" button -- the
  // in-progress tool was silently discarded.
  //
  // Radix closes a menu on any pointerdown outside the menu's own layer, so aim
  // at a neutral, non-interactive node that sits inside the host but outside the
  // menu: the menu reads it as "outside" and closes, the host reads it as
  // "inside" and survives. Verified live: menu 3 -> 0, editor still present.
  function neutralTargets(scope) {
    return [].slice
      .call((scope || document).querySelectorAll("label,h1,h2,h3,h4,p,span,div"))
      .filter(function (e) {
        return visible(e) && e.children.length === 0 && norm(e.textContent).length > 0 &&
          !e.closest("button,[role='button'],[role='menuitem'],[role='option']," +
                     "[role='menuitemcheckbox'],[role='combobox'],input,textarea,select");
      });
  }

  // Returns true once no menu is on screen. Never presses Escape.
  async function dismissMenu(scope) {
    if (!menuIsOpen()) return true;
    var host = scope || document.querySelector('[role="dialog"]') || document.body;
    var targets = neutralTargets(host);
    if (!targets.length && host !== document.body) targets = neutralTargets(document.body);
    for (var i = 0; i < targets.length && i < 3; i++) {
      pressSequence(targets[i]);
      await sleep(300);
      if (!menuIsOpen()) return true;
    }
    return !menuIsOpen();
  }

  // True while a popup menu/listbox is on screen.
  function menuIsOpen() {
    return [].slice
      .call(document.querySelectorAll('[role="menuitem"],[role="option"],[role="menuitemcheckbox"]'))
      .some(visible);
  }

  // Set a custom single-select dropdown to `value` in one call: open via the
  // trigger, then select the option. Returns true if the trigger now reads value.
  async function setSingleDropdown(trigger, value, readback) {
    openDropdown(trigger);
    await sleep(350);
    var ok = selectSingleOption(value);
    await sleep(250);
    if (typeof readback === "function") return readback() === value;
    return ok;
  }

  // ---- buttons / save -----------------------------------------------------
  function clickEl(el) { if (!el) return false; try { el.click(); return true; } catch (e) { return false; } }

  function buttonsByText(text) {
    var want = norm(text);
    return [].slice.call(document.querySelectorAll("button, [role='button']"))
      .filter(function (b) { return visible(b) && norm(b.textContent) === want; });
  }
  // Drive buttons with the full pointer sequence, not a bare .click().
  // React/Radix controls in the Rezolv panel (tab triggers, "Add to Assistance",
  // "Create Subscription", "Create") respond to pointerdown/mouseup and IGNORE a
  // synthetic click — live 2026-10-31 this silently produced "0 created" while
  // every step appeared to run. pressSequence still ends with a click event, so
  // plain buttons keep working.
  function clickButtonByText(text) {
    var b = buttonsByText(text)[0];
    if (!b) return false;
    pressSequence(b);
    return true;
  }

  // The CORRECT Save for a section: the visible "Save" whose sibling-button
  // group contains `companion` (e.g. "Test Analysis"), NOT the global one
  // (whose group contains "Back"). Falls back to the Save not grouped with Back.
  function findSectionSave(companion) {
    var saves = buttonsByText("Save");
    function groupTexts(b) {
      var p = b.parentElement;
      return p ? [].slice.call(p.querySelectorAll("button")).map(function (x) { return norm(x.textContent); }) : [];
    }
    // 1) grouped with the section companion
    if (companion) {
      for (var i = 0; i < saves.length; i++) {
        if (groupTexts(saves[i]).indexOf(norm(companion)) !== -1) return saves[i];
      }
    }
    // 2) a Save NOT grouped with "Back" (i.e. not the global bar)
    for (var j = 0; j < saves.length; j++) {
      if (groupTexts(saves[j]).indexOf("Back") === -1) return saves[j];
    }
    return saves[0] || null;
  }
  function clickSectionSave(companion) { return clickEl(findSectionSave(companion)); }

  // The GLOBAL page Save (bottom-right): the visible "Save" whose sibling-button
  // group contains "Back". Clicked once at the very end of a Rezolv import to
  // commit the whole agent.
  function findGlobalSave() {
    var saves = buttonsByText("Save");
    function groupTexts(b) {
      var p = b.parentElement;
      return p ? [].slice.call(p.querySelectorAll("button")).map(function (x) { return norm(x.textContent); }) : [];
    }
    for (var i = 0; i < saves.length; i++) {
      if (groupTexts(saves[i]).indexOf("Back") !== -1) return saves[i];
    }
    // fallback: the bottom-most / right-most Save on the page
    saves.sort(function (a, b) {
      var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.top - ra.top) || (rb.left - ra.left);
    });
    return saves[0] || null;
  }
  // Use the pointer sequence: the panel's overall Save is a React/Radix button
  // and a bare .click() is not guaranteed to register (same family as the tab
  // triggers and "Add to Assistance").
  function clickGlobalSave() {
    var b = findGlobalSave();
    if (!b) return false;
    pressSequence(b);
    return true;
  }

  // ---- state detection ----------------------------------------------------
  function isAuthRedirect() {
    return /\/accounts\/login/i.test(location.href || "") || /\/login(\?|$)/i.test(location.href || "");
  }

  async function waitFor(predicate, timeoutMs, stepMs) {
    var t = 0; stepMs = stepMs || 150; timeoutMs = timeoutMs || 5000;
    while (t < timeoutMs) {
      try { if (predicate()) return true; } catch (e) {}
      await sleep(stepMs); t += stepMs;
    }
    return false;
  }

  // Wait for a success toast matching `re`, or just a short settle.
  async function waitForToast(re, timeoutMs) {
    return waitFor(function () {
      var nodes = document.querySelectorAll('[class*="toast" i], [role="status"], [class*="sonner" i], [role="alert"]');
      for (var i = 0; i < nodes.length; i++) {
        if (re.test(norm(nodes[i].textContent))) return true;
      }
      return false;
    }, timeoutMs || 3000, 200);
  }

  window.MagicPortDom = {
    sleep: sleep, visible: visible, norm: norm,
    pressSequence: pressSequence, keyPress: keyPress, KEY: KEY,
    setReactInput: setReactInput,
    openDropdown: openDropdown, findOption: findOption,
    selectSingleOption: selectSingleOption, selectMenuByKeyboard: selectMenuByKeyboard, selectMenuByClick: selectMenuByClick, menuIsOpen: menuIsOpen, dismissMenu: dismissMenu,
    setSingleDropdown: setSingleDropdown,
    clickEl: clickEl, buttonsByText: buttonsByText, clickButtonByText: clickButtonByText,
    findSectionSave: findSectionSave, clickSectionSave: clickSectionSave,
    findGlobalSave: findGlobalSave, clickGlobalSave: clickGlobalSave,
    isAuthRedirect: isAuthRedirect, waitFor: waitFor, waitForToast: waitForToast
  };
})();
