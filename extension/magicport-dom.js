/*
 * magicport-dom.js  (ISOLATED world)  — PromptPort v4.0
 *
 * Low-level DOM-driving primitives for Magic Port import. Every technique here
 * was validated LIVE on Dash2 QA from in-page JS (see LIVE-CROSS-SITE-TEST):
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
 *   isAuthRedirect()           - detect the Dash2 login bounce (never "save
 *                                into the void" after a session drop).
 *
 * All helpers are defensive and return booleans / found elements so the
 * orchestrator can assert and report.
 */
(function () {
  "use strict";

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function visible(el) {
    if (!el) return false;
    if (el.offsetParent !== null) {
      // In-flow, but visibility:hidden (inherited) still renders nothing:
      // a Save inside a hidden panel is not a button the user can see.
      try { var vs = window.getComputedStyle(el); if (vs && (vs.visibility === "hidden" || vs.visibility === "collapse")) return false; } catch (e) {}
      return true;
    }
    // offsetParent is ALSO null for a position:fixed element (Radix dialogs,
    // "unsaved changes" prompts, portaled popovers), so those read as hidden.
    // For a fixed element check that it renders: client rects in a browser,
    // else no display:none / hidden ancestor.
    try {
      if (!el.isConnected || el.nodeType !== 1) return false;
      var cs = window.getComputedStyle(el);
      if (!cs || cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") return false;
      var rs = el.getClientRects ? el.getClientRects() : null;
      if (rs && rs.length) return true;
      for (var n = el.parentElement; n; n = n.parentElement) {
        if (n.hidden) return false;
        var ps = window.getComputedStyle(n);
        if (ps && ps.display === "none") return false;
      }
      return true;
    } catch (e) { return false; }
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

  // ---- open popovers -------------------------------------------------------
  // Option-like items that belong to a POPUP (menu / listbox / portaled list),
  // never to permanent page furniture: a sidebar of role=menuitem links, a
  // menubar or a tab list is always on screen and is not "an open menu".
  var ITEM_SEL = '[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]';
  var FURNITURE_SEL = "nav,[role='navigation'],[role='menubar'],[role='tablist']";
  // Portal / popper wrappers that only ever hold a popup.
  var PORTAL_SEL = "[data-radix-popper-content-wrapper],[data-floating-ui-portal],[data-radix-portal],.MuiPopover-root,.MuiPopper-root,.MuiMenu-root";
  // A popup that is animating out (Radix / MUI exit transition) is not open.
  function closing(el) { return !!(el && el.closest && el.closest('[data-state="closed"]')); }
  function outOfFlow(el) {
    for (var n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      try { var p = window.getComputedStyle(n).position; if (p === "fixed" || p === "absolute") return true; } catch (e) { return false; }
    }
    return false;
  }
  function expandedController(el) {
    if (!el || !el.id) return null;
    return [].slice.call(document.querySelectorAll("[aria-expanded='true'][aria-controls],[aria-expanded='true'][aria-owns]")).filter(function (t) {
      return ((t.getAttribute("aria-controls") || "") + " " + (t.getAttribute("aria-owns") || "")).split(/\s+/).indexOf(el.id) !== -1;
    })[0] || null;
  }
  // A menu/listbox that is a POPUP (open dropdown), not a list rendered in the
  // page (e.g. a listbox of voice choice cards): role=menu, inside a portal /
  // popper wrapper, controlled by an expanded trigger, or positioned out of flow.
  function isPopupRoot(r) {
    if (!r || r.closest(FURNITURE_SEL) || closing(r)) return false;
    if (r.getAttribute("role") === "menu") return true;
    if (r.closest(PORTAL_SEL) || expandedController(r)) return true;
    if (r.querySelector("[data-choice-card]")) return false;
    return outOfFlow(r);
  }
  function popoverItems() {
    return [].slice.call(document.querySelectorAll(ITEM_SEL))
      .filter(function (o) {
        if (!visible(o) || o.closest(FURNITURE_SEL) || closing(o)) return false;
        var r = o.closest("[role='menu'],[role='listbox']");
        return !r || isPopupRoot(r);
      });
  }
  // Role-less popover containers (MUI Popover: role=presentation, fixed) that
  // hold role-less option rows. Never a dialog.
  function popoverContainers() {
    return [].slice.call(document.querySelectorAll(PORTAL_SEL + ",[role='presentation']")).filter(function (c) {
      if (!visible(c) || closing(c) || c.closest(FURNITURE_SEL)) return false;
      if (c.matches("[role='dialog'],[role='alertdialog'],.MuiDialog-root") || c.querySelector("[role='dialog'],[role='alertdialog']")) return false;
      if (c.matches("[role='presentation']") && !(outOfFlow(c) && c.querySelector("ul,ol,[role='listbox'],[role='menu']"))) return false;
      return true;
    });
  }
  // The containers of the open popup(s): explicit menu/listbox roots, or the
  // parent of loose (portaled) option items.
  function popoverRoots() {
    var roots = [].slice.call(document.querySelectorAll("[role='menu'],[role='listbox']"))
      .filter(function (r) { return visible(r) && isPopupRoot(r); });
    popoverContainers().forEach(function (c) {
      if (roots.indexOf(c) === -1 && !roots.some(function (x) { return x.contains(c); })) {
        roots = roots.filter(function (x) { return !c.contains(x); });
        roots.push(c);
      }
    });
    popoverItems().forEach(function (o) {
      var r = o.closest("[role='menu'],[role='listbox']," + PORTAL_SEL) || o.parentElement;
      if (!r || r === document.body || r === document.documentElement) return;
      if (roots.indexOf(r) === -1 && !roots.some(function (x) { return x.contains(r); })) roots.push(r);
    });
    return roots;
  }

  // Find a visible option row whose text equals `text` INSIDE THE OPEN POPUP
  // (role=option/menuitem preferred, else a leaf of the popup). With no popup
  // open this returns null: a leaf anywhere on the page (a link's <span>,
  // another row's badge) is never "the option".
  function findOption(text) {
    var want = norm(text);
    var roled = popoverItems().filter(function (o) { return norm(o.textContent) === want; });
    if (roled.length) return roled[0];
    var roots = popoverRoots();
    for (var i = 0; i < roots.length; i++) {
      var leaf = [].slice.call(roots[i].querySelectorAll("*")).filter(function (el) {
        return el.children.length === 0 && visible(el) && norm(el.textContent) === want;
      })[0];
      if (leaf) return leaf;
    }
    return null;
  }

  // Select an option in a SINGLE-select, non-modal dropdown (the dropdown must
  // already be open). Option styles differ across Dash2 dropdowns:
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
  // Verified live on Dash2 QA 2026-10-31.
  async function selectMenuByClick(combo, wantedTexts) {
    var selected = [];
    if (!combo) return { ok: false, selected: selected };
    // The menu stays open across option clicks, and re-pressing the trigger
    // TOGGLES it shut -- so open exactly once and click every option in turn.
    openDropdown(combo);
    await sleep(400);
    // Only role'd items of the OPEN popup count -- never a leaf elsewhere (an
    // existing subscription row's event badge once passed for the option).
    function menuOpt(want) {
      return popoverItems().filter(function (o) { return norm(o.textContent) === want && !(combo.contains && combo.contains(o)); })[0] || null;
    }
    var host = combo.closest ? (combo.closest("[role='dialog'],[role='alertdialog']") || combo.parentElement) : null;
    function chipShown(want) {
      if (!host) return false;
      return [].slice.call(host.querySelectorAll("*")).some(function (e) {
        return e.children.length === 0 && visible(e) && norm(e.textContent) === want;
      });
    }
    function stateOf(o) {
      var a = o.getAttribute("aria-checked") || o.getAttribute("aria-selected");
      if (a !== null) return a === "true";
      var ds = o.getAttribute("data-state");
      if (ds) return /^(checked|on|selected|active)$/.test(ds);
      return null;
    }
    // Some menus close after every pick: re-open before the next one (only
    // when it is really closed -- pressing an open trigger toggles it shut).
    function comboOpen() {
      var ae = combo.getAttribute && combo.getAttribute("aria-expanded");
      if (ae === "true") return true;
      if (ae === "false") return false;
      return menuIsOpen();
    }
    for (var i = 0; i < wantedTexts.length; i++) {
      var want = norm(wantedTexts[i]);
      if (i > 0 && !comboOpen()) { openDropdown(combo); await sleep(400); }
      var opt = menuOpt(want);
      if (!opt) { await sleep(300); opt = menuOpt(want); }
      if (!opt) continue;
      var hadState = stateOf(opt) !== null, chipBefore = chipShown(want);
      if (hadState && stateOf(opt) === true) { selected.push(wantedTexts[i]); continue; }
      pressSequence(opt);
      await sleep(400);
      // Count it only on a confirmation the UI offers: the item's checked /
      // selected state, the item leaving the list, or a chip in the form.
      // An item that exposes none of these cues is trusted to have taken.
      var after = opt.isConnected && visible(opt) ? stateOf(opt) : "gone";
      var confirmed = after === "gone" || after === true || (!chipBefore && chipShown(want)) ||
        (!hadState && after === null);
      if (confirmed) selected.push(wantedTexts[i]);
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
  // Never a <label> (it forwards the press to its control), a link, or any
  // control: only inert text.
  var NOT_NEUTRAL = "button,[role='button'],[role='menuitem'],[role='option'],[role='menuitemcheckbox'],[role='menuitemradio']," +
    "[role='combobox'],[role='link'],[role='radio'],[role='switch'],[role='tab'],[role='checkbox'],[role='slider']," +
    "input,textarea,select,label,a,summary,[contenteditable=''],[contenteditable='true'],[tabindex]:not([tabindex='-1'])";
  function neutralTargets(scope) {
    var roots = popoverRoots();
    return [].slice
      .call((scope || document).querySelectorAll("h1,h2,h3,h4,p,span,div"))
      .filter(function (e) {
        return visible(e) && e.children.length === 0 && norm(e.textContent).length > 0 &&
          !e.closest(NOT_NEUTRAL) && !roots.some(function (r) { return r.contains(e); });
      });
  }
  // The trigger of the open popup: pressing it again closes it (Radix toggles).
  function openTrigger() {
    return [].slice.call(document.querySelectorAll("[aria-expanded='true']"))
      .filter(function (t) {
        return visible(t) && !t.closest(FURNITURE_SEL) &&
          (t.hasAttribute("aria-haspopup") || t.getAttribute("role") === "combobox");
      })[0] || null;
  }

  // Returns true once no menu is on screen. Never presses Escape.
  // `trigger` (optional): the control that opened the menu; pressing it again
  // is the preferred, side-effect-free way to close it.
  async function dismissMenu(scope, trigger) {
    if (!menuIsOpen()) return true;
    var trig = (trigger && visible(trigger)) ? trigger : openTrigger();
    if (trig) {
      pressSequence(trig);
      await sleep(300);
      if (!menuIsOpen()) return true;
    }
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

  // True while a popup menu/listbox is on screen (page furniture such as a
  // role=menuitem sidebar does not count).
  function menuIsOpen() {
    if (popoverItems().length) return true;
    return [].slice.call(document.querySelectorAll("[role='menu'],[role='listbox']"))
      .some(function (r) { return visible(r) && isPopupRoot(r); });
  }

  // The expanded control that belongs to `trigger` (the trigger itself, or --
  // MUI: readonly input + div[role=button] -- a sibling inside its wrapper).
  function expandedFor(trigger) {
    if (!trigger) return null;
    if (trigger.getAttribute && trigger.getAttribute("aria-expanded") === "true") return trigger;
    var p = trigger.parentElement;   // its own wrapper only: never another field's trigger
    return p ? p.querySelector("[aria-expanded='true'][aria-haspopup],[aria-expanded='true'][role='combobox']") : null;
  }
  // A popup that the trigger / dismissMenu could not close: an MUI-style
  // invisible backdrop that sits in the SAME popover as the menu (never a
  // dialog overlay) closes it on click.
  async function clickPopoverBackdrop() {
    var roots = popoverRoots();
    var bd = [].slice.call(document.querySelectorAll("[class*='backdrop' i]")).filter(function (b) {
      return b.isConnected && !b.closest("[role='dialog'],[role='alertdialog']") && b.parentElement &&
        roots.some(function (r) { return b.parentElement.contains(r) && !b.contains(r); });
    })[0];
    if (!bd) return false;
    clickEl(bd);
    await sleep(300);
    return true;
  }

  // Set a custom single-select dropdown to `value` in one call: open via the
  // trigger, then select the option. Returns true if the trigger now reads value.
  // A trigger whose menu is already open is NOT pressed again (that toggles it
  // shut), and a failed pick never leaves the menu (and its backdrop) open.
  async function setSingleDropdown(trigger, value, readback) {
    if (!expandedFor(trigger)) {
      if (menuIsOpen()) await dismissMenu();
      openDropdown(trigger);
      await sleep(350);
    }
    var ok = false, deadline = Date.now() + 1500;
    while (true) {
      if (findOption(value)) { ok = selectSingleOption(value); break; }
      if (Date.now() >= deadline) break;
      await sleep(150);
    }
    await sleep(250);
    if (!ok) {
      var exp = expandedFor(trigger);
      if (menuIsOpen() || exp) await dismissMenu(null, exp || null);
      if (menuIsOpen() || expandedFor(trigger)) await clickPopoverBackdrop();
    }
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
  // React/Radix controls in the Dash2 panel (tab triggers, "Add to Assistance",
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
  // The texts of a Save's own button group: the closest ancestor (a few levels
  // up, so a tooltip <span> around the button does not hide its group) that
  // holds other buttons. An ancestor that also holds ANOTHER Save is a page
  // container, not this Save's group.
  function saveGroupTexts(b) {
    var p = b.parentElement;
    for (var i = 0; p && i < 4 && p !== document.body && p !== document.documentElement; i++, p = p.parentElement) {
      var bs = [].slice.call(p.querySelectorAll("button"));
      if (bs.length < 2) continue;
      var texts = bs.map(function (x) { return norm(x.textContent); });
      if (bs.some(function (x) { return x !== b && norm(x.textContent) === "Save"; })) return [norm(b.textContent)];
      return texts;
    }
    return [norm(b.textContent)];
  }
  function findSectionSave(companion) {
    var saves = buttonsByText("Save");
    var groupTexts = saveGroupTexts;
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
  // group contains "Back". Clicked once at the very end of a Dash2 import to
  // commit the whole agent.
  function findGlobalSave() {
    var saves = buttonsByText("Save");
    var groupTexts = saveGroupTexts;
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
  // The app's sign-in pages: the WHOLE path is an auth path ("/login",
  // "/login/", "/accounts/login", "/auth/signin", ...; query and hash are
  // ignored). A bot or page inside the app whose path merely ENDS in "login"
  // (e.g. ".../voicebot/login") is not the login bounce.
  var AUTH_PATH = /^(\/(accounts|account|auth|users?|identity))?\/(login|log-in|signin|sign-in|sso\/login)$/i;
  function isAuthRedirect() {
    var path = "";
    try { path = location.pathname || ""; } catch (e) { path = ""; }
    path = path.replace(/\/+$/, "") || "/";
    return AUTH_PATH.test(path);
  }

  // Wall-clock budget: a hidden tab throttles timers, so counting steps
  // (t += stepMs) made an 800 ms wait take many seconds.
  async function waitFor(predicate, timeoutMs, stepMs) {
    stepMs = stepMs || 150; timeoutMs = timeoutMs || 5000;
    var deadline = Date.now() + timeoutMs;
    while (true) {
      try { if (predicate()) return true; } catch (e) {}
      if (Date.now() >= deadline) return false;
      await sleep(Math.max(0, Math.min(stepMs, deadline - Date.now())));
    }
  }

  // Toasts. A failure message ("You have unsaved changes", "Changes not
  // saved", "Couldn’t be updated", "... failed", "error", "Fix 2 fields in X")
  // never counts as success, even though it contains "saved"/"updated".
  // Only toasts that are NEW (or whose text CHANGED) since a snapshot taken
  // right before the click count, so a toast left over from an earlier save
  // can never confirm this one.
  var TOAST_SEL = '[class*="toast" i], [role="status"], [class*="sonner" i], [role="alert"], [data-sonner-toast]';
  var TOAST_FAIL = /unsaved changes|not saved|not been saved|could not|couldn['\u2019]?t|cannot|can['\u2019]?t|failed|failure|error|unable|fix \d+ fields? in/i;
  function toastNodes() {
    var all = [].slice.call(document.querySelectorAll(TOAST_SEL));
    try { v2Toasts().forEach(function (t) { if (all.indexOf(t) === -1) all.push(t); }); } catch (e) {}
    // Leaf-most only: a toaster container's text mixes old and new toasts.
    return all.filter(function (n) { return !all.some(function (o) { return o !== n && n.contains(o); }); });
  }
  // Opaque snapshot of the toasts on screen now (node -> text).
  function toastSnapshot() {
    var m = new Map();
    toastNodes().forEach(function (n) { m.set(n, norm(n.textContent)); });
    return { m: m, at: Date.now() };
  }
  // Texts of toasts that appeared or changed since `before` (all when no snapshot).
  function freshToastTexts(before) {
    return toastNodes().filter(function (n) {
      if (!before || !before.m) return true;
      return !before.m.has(n) || before.m.get(n) !== norm(n.textContent);
    }).map(function (n) { return norm(n.textContent); }).filter(Boolean);
  }
  // { state: "ok"|"fail"|"none", text } — a fresh failure wins over a fresh success.
  // Without a snapshot (legacy callers) the toasts on screen at the call are
  // only weak evidence: they may be left over from an earlier save. A
  // pre-existing success counts only after a grace period in which no fresh
  // failure appeared, and a permanent status line ("Last saved 2 min ago")
  // never counts.
  var STATUS_LINE = /\b(last|auto)[- ]?saved\b|\bago\b/i;
  async function waitToastResult(re, timeoutMs, before) {
    timeoutMs = timeoutMs || 3000;
    var start = Date.now(), deadline = start + timeoutMs, ok = null, preOk = null;
    var implicit = !before || !before.m;
    if (implicit) {
      before = toastSnapshot();
      var pre = [];
      before.m.forEach(function (t) { if (t) pre.push(t); });
      var preBad = pre.filter(function (t) { return TOAST_FAIL.test(t); })[0];
      if (preBad) return { state: "fail", text: preBad };
      preOk = pre.filter(function (t) { return re.test(t) && !STATUS_LINE.test(t); })[0] || null;
    }
    var grace = Math.min(1500, timeoutMs);
    while (true) {
      var fresh = freshToastTexts(before);
      var bad = fresh.filter(function (t) { return TOAST_FAIL.test(t); })[0];
      if (bad) return { state: "fail", text: bad };
      var good = fresh.filter(function (t) { return re.test(t) && !TOAST_FAIL.test(t); })[0];
      if (good) ok = good;
      if (ok && !saveInFlight()) return { state: "ok", text: ok };
      if (!ok && preOk && Date.now() - start >= grace && !saveInFlight()) return { state: "ok", text: preOk };
      if (Date.now() >= deadline) break;
      await sleep(200);
    }
    if (!ok && preOk) ok = preOk;
    return ok ? { state: "ok", text: ok } : { state: "none", text: "" };
  }
  // Legacy boolean form; pass `before` (toastSnapshot()) to ignore old toasts.
  async function waitForToast(re, timeoutMs, before) {
    var r = await waitToastResult(re, timeoutMs, before);
    return r.state === "ok";
  }
  // A save still running: "Saving…" text, aria-busy, or (new UI) a disabled
  // Save in an open "Unsaved changes" bar that isn't asking to fix fields.
  function saveInFlight() {
    try {
      var bar = v2SaveBar();
      if (bar) {
        var bt = norm(bar.textContent);
        if (/\bsaving\b/i.test(bt) || bar.querySelector('[aria-busy="true"], [role="progressbar"]')) return true;
        var b = v2SaveButton();
        if (b && (b.disabled || b.getAttribute("aria-disabled") === "true") && !/fix \d+ fields? in|can['\u2019]?t save/i.test(bt)) return true;
      }
      var btns = document.querySelectorAll('button, [role="button"]');
      for (var i = 0; i < btns.length; i++) {
        var x = btns[i];
        if (!visible(x)) continue;
        if (/^saving\b/i.test(norm(x.textContent)) || (x.getAttribute("aria-busy") === "true" && /save/i.test(norm(x.textContent)))) return true;
      }
    } catch (e) {}
    return false;
  }
  // Resolve true once no save is running (false if still running at the deadline).
  async function waitSaveIdle(timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 20000);
    await sleep(120);
    while (saveInFlight()) {
      if (Date.now() >= deadline) return false;
      await sleep(200);
    }
    return true;
  }


  // ======================================================================
  //  New 2-field dashboard UI (2026-11-05): sidebar sections, combobox
  //  dropdowns, one page-wide "Unsaved changes" bar with a single Save.
  //  Verified live on QA; see /newui docs. Old-UI helpers above stay for
  //  the old layout.
  // ======================================================================
  var V2_SECTIONS = {
    prompt: "prompt", variables: "custom-variables", languageVoice: "language-voice",
    llmStt: "llm-stt", analysis: "custom-analysis", callConfig: "call-config",
    tools: "tools", events: "event-subscription"
  };
  var V2_NAV_SEL = 'nav[aria-label="Agent sections"] button[data-outline-item]';
  function v2NavButtons() {
    var inNav = [].slice.call(document.querySelectorAll(V2_NAV_SEL));
    return inNav.length ? inNav : [].slice.call(document.querySelectorAll("button[data-outline-item]"));
  }
  // True on the new UI: the "Agent sections" sidebar with its section buttons
  // is present (a stray data-outline-item button elsewhere is not enough).
  function v2IsNewUi() { return document.querySelectorAll(V2_NAV_SEL).length > 0; }
  function v2SectionButton(slug) {
    return v2NavButtons().filter(function (b) { return b.getAttribute("data-outline-item") === slug; })[0] || null;
  }
  function v2ActiveSection() {
    var b = v2NavButtons().filter(function (x) { return x.getAttribute("aria-current") === "page"; })[0];
    return b ? b.getAttribute("data-outline-item") : "";
  }
  // Open a section and wait until it is the active one (and, optionally, until
  // ready() is true — only the active section is mounted). Pending edits in
  // other sections survive the switch (no dialog on the new UI).
  // After a click the app may switch the URL (?section=) at once and mark the
  // button aria-current later: while the URL already names the section the
  // switch is under way, so wait (up to 3 s) before clicking again -- every
  // extra click remounts the section.
  function v2UrlSection() {
    try { var m = /[?&]section=([^&#]*)/.exec(location.search || ""); return m ? decodeURIComponent(m[1]) : ""; } catch (e) { return ""; }
  }
  async function v2GotoSection(slug, ready, budgetMs) {
    v2GotoSection.lastWhy = "";
    var deadline = Date.now() + (budgetMs || 9000), clicked = 0, lastClick = 0, patience = 450;
    while (Date.now() < deadline) {
      var b = v2SectionButton(slug);
      if (b && b.getAttribute("aria-current") === "page" && (!ready || safeBool(ready))) return true;
      if (b && b.getAttribute("aria-current") !== "page" && !b.disabled) {
        if (!clicked || Date.now() - lastClick >= patience) {
          if (clicked % 2 === 0) clickEl(b); else pressSequence(b);
          clicked++; lastClick = Date.now();
          await sleep(150);
          patience = v2UrlSection() === slug ? 3000 : 450;
        } else await sleep(150);
      } else await sleep(250);
    }
    var b2 = v2SectionButton(slug);
    v2GotoSection.lastWhy = !b2 ? ("section '" + slug + "' not found in the sidebar")
      : (b2.getAttribute("aria-current") !== "page" ? "the section never became active (clicked " + clicked + "x)" : "the section opened but its content never loaded");
    return false;
  }
  function safeBool(fn) { try { return !!fn(); } catch (e) { return false; } }

  // ---- combobox dropdowns: <label for=id> + button[role=combobox] ----------
  // Accessible label of a control: aria-labelledby (every id; parts inside
  // the control itself -- its value -- are skipped), <label for>, a wrapping
  // <label> (minus the control's own text), then aria-label.
  function textOutside(root, skip) {
    var out = [];
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c === skip) continue;
        if (c.nodeType === 3) out.push(c.nodeValue);
        else if (c.nodeType === 1) walk(c);
      }
    })(root);
    return norm(out.join(" "));
  }
  function v2LabelOf(btn) {
    if (!btn || !btn.getAttribute) return "";
    var ids = (btn.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    var parts = ids.map(function (id) { return document.getElementById(id); })
      .filter(function (l) { return l && l !== btn && !btn.contains(l); })
      .map(function (l) { return norm(l.textContent); }).filter(Boolean);
    if (parts.length) return norm(parts.join(" "));
    var l = null;
    if (btn.id) { try { l = document.querySelector('label[for="' + btn.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"]'); } catch (e) { l = null; } }
    if (l) return norm(l.textContent);
    var wl = btn.parentElement && btn.parentElement.closest ? btn.parentElement.closest("label") : null;
    if (wl) { var wt = textOutside(wl, btn); if (wt) return wt; }
    return norm(btn.getAttribute("aria-label") || "");
  }
  // The combobox in scope whose label equals labelText (case-insensitive;
  // a trailing "*" / "(required)" ignored). nth picks among equal labels.
  function v2Combo(scope, labelText, nth) {
    var want = norm(labelText).toLowerCase();
    var list = [].slice.call((scope || document).querySelectorAll('button[role="combobox"]')).filter(function (b) {
      return norm(v2LabelOf(b)).toLowerCase().replace(/\s*(\*|\(required\))\s*$/, "") === want;
    });
    return list[nth || 0] || null;
  }
  var V2_PLACEHOLDER = /^(select\b.*|pick\b.*|choose\b.*|search\b.*|—|-)$/i;
  function v2ComboValue(btn) {
    if (!btn) return "";
    var t = norm(btn.textContent);
    return V2_PLACEHOLDER.test(t) ? "" : t;
  }
  // The combobox's OWN listbox: the one aria-controls / aria-owns (or the
  // id + "-listbox" convention) names. Only when the trigger names none that
  // exists is a listbox accepted that appeared AFTER the combobox was opened
  // (`pre` = listboxes on the page before) -- never one that was already on
  // the page (a voice list, another field's list).
  function v2Listbox(btn, pre) {
    var ids = ((btn.getAttribute("aria-controls") || "") + " " + (btn.getAttribute("aria-owns") || "")).split(/\s+/).filter(Boolean);
    if (btn.id) ids.push(btn.id + "-listbox");
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (!el) continue;
      if (el.getAttribute("role") === "listbox") return el;
      var inner = el.querySelector('[role="listbox"]');
      if (inner) return inner;
    }
    if (!pre) return null;
    return [].slice.call(document.querySelectorAll('[role="listbox"]')).filter(function (x) {
      return pre.indexOf(x) === -1 && visible(x) && !closing(x);
    }).pop() || null;
  }
  // The option's NAME: decorations (aria-hidden check marks, icons / flags,
  // "New" / "Beta" badges) are skipped; a "span > span" lead (name + sub-text)
  // is preferred when the option has no text of its own.
  var V2_BADGE_CLASS = /(^|[\s_-])(badge|tag|chip|pill|icon|check|checkmark|flag|indicator|kbd)([\s_-]|$)/i;
  var V2_BADGE_WORD = /^(new|beta|alpha|preview|recommended|default|legacy|deprecated|popular|experimental|soon|coming soon|selected|current)$/i;
  function textBefore(root, el) {
    var out = "", done = false;
    (function walk(n) {
      for (var c = n.firstChild; c && !done; c = c.nextSibling) {
        if (c === el) { done = true; return; }
        if (c.nodeType === 3) out += c.nodeValue; else if (c.nodeType === 1) walk(c);
      }
    })(root);
    return norm(out);
  }
  function v2OptionText(o) {
    var full = norm(o.textContent);
    var c;
    try { c = o.cloneNode(true); } catch (e) { return full; }
    [].slice.call(c.querySelectorAll("*")).forEach(function (e) {
      if (!e.parentNode) return;
      var tag = (e.tagName || "").toLowerCase(), t = norm(e.textContent);
      var cls = typeof e.className === "string" ? e.className : (e.getAttribute("class") || "");
      if (e.getAttribute("aria-hidden") === "true" || tag === "svg" || tag === "img" || tag === "kbd" ||
          V2_BADGE_CLASS.test(cls) || !/[\p{L}\p{N}]/u.test(t)) { e.parentNode.removeChild(e); return; }
      if (V2_BADGE_WORD.test(t) && textBefore(c, e)) e.parentNode.removeChild(e);   // a trailing badge
    });
    var own = [].slice.call(c.childNodes).some(function (n) { return n.nodeType === 3 && norm(n.nodeValue); });
    var name = own ? norm(c.textContent) : "";
    if (!name) { var lead = c.querySelector("span > span") || c.querySelector("span"); name = norm(lead && lead.textContent); }
    return name || norm(c.textContent) || full;
  }
  function v2Disabled(el) {
    return !!el && (el.disabled === true || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled"));
  }
  function v2Expanded(btn) { return !!btn && btn.getAttribute("aria-expanded") === "true"; }
  // Close the combobox WITHOUT Escape (Escape bubbles to a surrounding
  // dialog / editor and dismisses it): re-press the trigger, then an outside
  // press on inert text (dismissMenu).
  async function v2CloseCombo(btn) {
    if (!v2Expanded(btn)) return;
    clickEl(btn); await sleep(200);
    if (v2Expanded(btn)) { pressSequence(btn); await sleep(250); }
    if (v2Expanded(btn) && menuIsOpen()) { await dismissMenu(null, null); }
  }
  // The trigger shows a decorated value ("OpenAI · gpt-4o"): `want` counts when
  // it stands as a whole token (not "gpt-4o" inside "gpt-4o-mini").
  var V2_SEP = " ·•|:/,()[]—–>";
  function v2ValueHas(now, want) {
    var a = norm(now).toLowerCase(), w = norm(want).toLowerCase();
    if (!w) return false;
    for (var i = a.indexOf(w); i !== -1; i = a.indexOf(w, i + 1)) {
      var pre = i === 0 ? " " : a.charAt(i - 1), post = i + w.length >= a.length ? " " : a.charAt(i + w.length);
      if (V2_SEP.indexOf(pre) !== -1 && V2_SEP.indexOf(post) !== -1) return true;
    }
    return false;
  }
  // The popover's OWN search box: an input that aria-controls the listbox, or
  // a search/filter input in the listbox's popover wrapper (floating-ui portal,
  // or the listbox's parent when that is not <body>/<html>). Climbing to <body>
  // once found the page's own name input and typed the option text into it.
  function v2SearchBox(lb) {
    var byCtl = lb.id ? [].slice.call(document.querySelectorAll("input")).filter(function (i) {
      return visible(i) && (i.getAttribute("aria-controls") || "").split(/\s+/).indexOf(lb.id) !== -1;
    })[0] : null;
    if (byCtl) return byCtl;
    var pop = lb.closest("[data-floating-ui-portal]") ||
      (lb.parentElement && lb.parentElement !== document.body && lb.parentElement !== document.documentElement ? lb.parentElement : null);
    return pop ? [].slice.call(pop.querySelectorAll("input")).filter(function (i) {
      return visible(i) && !lb.contains(i) && /search|filter/i.test((i.getAttribute("placeholder") || "") + " " + (i.getAttribute("aria-label") || ""));
    })[0] || null : null;
  }
  function v2Options(lb) { return lb ? [].slice.call(lb.querySelectorAll('[role="option"]')) : []; }
  // Pick an option by exact text (or by a matcher fn(optionText, li)).
  // opts.force: pick even if the value already reads `want`. Returns
  // { ok, value, offered[], why? }.
  async function v2PickCombo(getBtn, want, opts) {
    opts = opts || {};
    var isText = typeof want === "string";
    var match = !isText ? want : function (t) { return norm(t).toLowerCase() === norm(want).toLowerCase(); };
    function cur() { var b = typeof getBtn === "function" ? getBtn() : null; return b || btn; }
    var btn = typeof getBtn === "function" ? getBtn() : getBtn;
    if (!btn) return { ok: false, value: "", offered: [], why: "control not found" };
    if (!opts.force && isText && match(v2ComboValue(btn))) return { ok: true, value: v2ComboValue(btn), offered: [] };
    function took(b) { var now = v2ComboValue(b); return !isText || match(now) || v2ValueHas(now, want); }
    var offered = [], opened = false, listSeen = false, pre = null;
    for (var a = 0; a < 3; a++) {
      btn = cur();
      if (v2Disabled(btn)) return { ok: false, value: v2ComboValue(btn), offered: offered, why: "the dropdown is disabled" };
      if (!v2Expanded(btn)) {
        pre = [].slice.call(document.querySelectorAll('[role="listbox"]'));
        // Full pointer sequence first (pointerdown-driven triggers open at
        // once); a bare click on the next attempt for triggers that toggle on
        // both pointerdown and click.
        if (a % 2 === 0) pressSequence(btn); else clickEl(btn);
        for (var w0 = 0; w0 < 6 && !v2Expanded(cur()) && !v2Listbox(cur(), pre); w0++) await sleep(120);
        btn = cur();
        if (!v2Expanded(btn) && !v2Listbox(btn, pre)) continue;
      }
      opened = true;
      var lb = null, until = Date.now() + 3200;
      while (!lb && Date.now() < until) { lb = v2Listbox(cur(), pre); if (!lb) await sleep(150); }
      if (!lb) continue;
      listSeen = true;
      var search = isText ? v2SearchBox(lb) : null, typed = false;
      // A query left in the box (persisting search) hides options: clear it.
      if (search && search.value) { setReactInput(search, ""); await sleep(300); lb = v2Listbox(cur(), pre) || lb; }
      var opts2 = v2Options(lb), until2 = Date.now() + 3000;
      while (!opts2.length && Date.now() < until2) { await sleep(200); lb = v2Listbox(cur(), pre) || lb; opts2 = v2Options(lb); }
      // Read what is offered BEFORE typing into a search box.
      offered = opts2.map(v2OptionText);
      var hit = opts2.filter(function (o) { return match(v2OptionText(o), o); });
      if (!hit.length && search) {
        // Long / lazy lists: search for it.
        setReactInput(search, want); typed = true;
        var until3 = Date.now() + 1200;
        while (!hit.length && Date.now() < until3) {
          await sleep(200);
          lb = v2Listbox(cur(), pre) || lb;
          hit = v2Options(lb).filter(function (o) { return match(v2OptionText(o), o); });
        }
      }
      var pick = hit[opts.index || 0];
      if (!pick || v2Disabled(pick)) {
        if (typed && search.isConnected) { setReactInput(search, ""); await sleep(150); }
        await v2CloseCombo(cur());
        return { ok: false, value: v2ComboValue(cur()), offered: offered, why: pick ? "the option is disabled" : "not offered" };
      }
      clickEl(pick); await sleep(300);
      btn = cur();
      // Lists that select on mousedown / pointerdown ignore a bare click.
      if (!took(btn) && pick.getAttribute("aria-selected") !== "true" && pick.isConnected && visible(pick) && v2Expanded(btn)) {
        var PE = window.PointerEvent || MouseEvent;
        fire(pick, "pointerdown", PE, { pointerId: 1, button: 0, isPrimary: true });
        fire(pick, "mousedown", MouseEvent, { button: 0 });
        fire(pick, "pointerup", PE, { pointerId: 1, button: 0, isPrimary: true });
        fire(pick, "mouseup", MouseEvent, { button: 0 });
        await sleep(300);
      }
      btn = cur();
      if (typed && search.isConnected && v2Expanded(btn)) { setReactInput(search, ""); await sleep(150); }
      if (v2Expanded(btn)) await v2CloseCombo(btn);
      // A controlled value may commit a little later.
      for (var w3 = 0; w3 < 8 && !took(cur()); w3++) await sleep(200);
      btn = cur();
      if (took(btn)) return { ok: true, value: v2ComboValue(btn), offered: offered };
    }
    btn = cur();
    if (v2Expanded(btn)) await v2CloseCombo(btn);
    return { ok: false, value: v2ComboValue(btn), offered: offered,
      why: !opened ? "the list never opened" : (!listSeen ? "the list never appeared" : "did not take") };
  }

  // ---- switches: label[for] + button[role=switch][aria-checked] -----------
  function v2Switch(scope, labelText) {
    var want = norm(labelText).toLowerCase();
    var ls = [].slice.call((scope || document).querySelectorAll("label[for]")).filter(function (l) { return norm(l.textContent).toLowerCase() === want; });
    for (var i = 0; i < ls.length; i++) {
      var el = document.getElementById(ls[i].getAttribute("for"));
      if (el && el.getAttribute("role") === "switch") return el;
    }
    // aria-label, aria-labelledby or a wrapping <label>.
    return [].slice.call((scope || document).querySelectorAll('[role="switch"]')).filter(function (s) {
      return norm(s.getAttribute("aria-label") || "").toLowerCase() === want || v2LabelOf(s).toLowerCase() === want;
    })[0] || null;
  }
  async function v2SetSwitch(sw, on) {
    if (!sw) return false;
    for (var a = 0; a < 3; a++) {
      if ((sw.getAttribute("aria-checked") === "true") === !!on) return true;
      if (a === 0) clickEl(sw); else pressSequence(sw);
      await sleep(250);
    }
    return (sw.getAttribute("aria-checked") === "true") === !!on;
  }

  // ---- the page-wide save bar ---------------------------------------------
  function v2SaveBar() { return document.querySelector('[role="region"][aria-label="Unsaved changes"]'); }
  function v2SaveButton() {
    var bar = v2SaveBar(); if (!bar) return null;
    return [].slice.call(bar.querySelectorAll("button")).filter(function (b) { return norm(b.textContent) === "Save"; })[0] || null;
  }
  function v2Toasts() {
    // data-tone is also used OUTSIDE toasts (tool-list method chips "POST",
    // the Discard / unsaved-changes dialogs' buttons): those are never toasts.
    var NOT_TOAST = '[role="dialog"], [role="alertdialog"], [role="region"][aria-label="Unsaved changes"], main, nav, table, ul, ol:not([data-sonner-toaster]), section:not([aria-label^="Notifications"]), form';
    var list = [].slice.call(document.querySelectorAll("[data-sonner-toast], [data-tone]")).filter(function (t) {
      if (t.matches("[data-sonner-toast]")) return true;
      if (t.closest("[data-sonner-toast]")) return false;
      if (t.closest("[data-sonner-toaster], section[aria-label^='Notifications']")) return true;
      return !t.closest(NOT_TOAST);
    });
    // Remember what each toast said, so a toast UPDATED IN PLACE (sonner
    // reuses one element per toast id / toast.promise) counts as new.
    try { Object.defineProperty(list, "sigs", { value: list.map(v2ToastSig), enumerable: false }); } catch (e) {}
    return list;
  }
  function v2ToastInfo(t) {
    var toneEl = t.matches("[data-tone]") ? t : t.querySelector("[data-tone]");
    var tone = toneEl ? toneEl.getAttribute("data-tone") : (t.getAttribute("data-type") || "");
    return { tone: tone, text: norm(t.textContent) };
  }
  function v2ToastSig(t) { var i = v2ToastInfo(t); return i.tone + "|" + i.text; }
  // Toasts that appeared, or changed text / tone, since `before` (a v2Toasts() result).
  function v2FreshToasts(before) {
    before = before || [];
    return v2Toasts().filter(function (t) {
      var k = before.indexOf(t);
      if (k === -1) return true;
      return !!before.sigs && before.sigs[k] !== v2ToastSig(t);
    }).map(v2ToastInfo).filter(function (x) { return x.text; });
  }
  var V2_OK_RE = /changes saved|saved|updated|created|added/i,
    V2_FAIL_RE = /couldn['’]?t save|can['’]?t save|something went wrong|failed|error|not allowed|invalid/i;
  // Texts that are about the SAVE failing (an unrelated error toast -- "Couldn't
  // load usage stats" -- is not). "Fix N fields in X" means the save is blocked.
  var V2_SAVE_FAIL_RE = /couldn['’]?t save|could not save|can['’]?t save|cannot save|unable to save|failed to save|save failed|saving failed|not saved|wasn['’]?t saved|changes (were|was) not|couldn['’]?t update|could not update|failed to update|update failed|something went wrong|not allowed|fix \d+ fields? in/i;
  var V2_FIX_RE = /Fix \d+ fields? in [^.]+/i;
  function v2ToneBad(x) { return x.tone === "error" || x.tone === "destructive"; }
  function v2ToneOk(x) { return x.tone === "success"; }
  // Press the bar's Save and wait for the outcome. Only toasts that appear (or
  // change) AFTER the call count. Returns { state: "none"|"saved"|"failed"|"blocked"|"unconfirmed", text }.
  //   none        — no bar: nothing pending, nothing to save
  //   saved       — success toast after the click and the bar is gone
  //   failed      — a save-failure toast ("Couldn't save your changes", "Can't save yet", "Something went wrong")
  //   blocked     — invalid fields ("Fix N fields in …"), or a Save that stays disabled with no save running
  //   unconfirmed — neither within the time budget
  // A Save already IN FLIGHT (disabled / "Saving…" with no "Fix N fields") is
  // not pressed again and not "blocked": its outcome is awaited like our own.
  async function v2SaveAll(timeoutMs) {
    var bar = v2SaveBar();
    if (!bar) return { state: "none", text: "" };
    var deadline = Date.now() + (timeoutMs || 15000);
    var before = v2Toasts();
    var btn = v2SaveButton();
    var fix = norm(bar.textContent).match(V2_FIX_RE);
    var enabled = function (b) { return !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true"; };
    if (fix && !enabled(btn)) return { state: "blocked", text: fix[0] };
    // "Saving…" / aria-busy: a save is certainly running (a merely disabled
    // Save may also be one -- awaited, but "blocked" if it never changes).
    var surelyBusy = function (b) { return !!b && (/\bsaving\b/i.test(norm(b.textContent)) || !!b.querySelector('[aria-busy="true"], [role="progressbar"]')); };
    var clicked = false, busySeen = false, sawOk = null, suspect = null, idleSince = 0, goneSince = 0, enabledSince = 0;
    if (enabled(btn)) { clickEl(btn); clicked = true; }
    else busySeen = surelyBusy(bar);
    while (Date.now() < deadline) {
      await sleep(250);
      var fresh = v2FreshToasts(before);
      var fx = fresh.filter(function (x) { return V2_FIX_RE.test(x.text); })[0];
      if (fx) return { state: "blocked", text: fx.text.match(V2_FIX_RE)[0] };
      var bad = fresh.filter(function (x) { return V2_SAVE_FAIL_RE.test(x.text); })[0];
      if (bad) return { state: "failed", text: bad.text };
      // An error-toned toast that does not speak about saving may be unrelated
      // (a list failing to load): remembered, decisive only if the save then
      // ends without closing the bar.
      var odd = fresh.filter(function (x) { return v2ToneBad(x) || (V2_FAIL_RE.test(x.text) && !v2ToneOk(x)); })[0];
      if (odd && !suspect) suspect = odd;
      var good = fresh.filter(function (x) { return !v2ToneBad(x) && (v2ToneOk(x) || V2_OK_RE.test(x.text)) && !V2_FAIL_RE.test(x.text); })[0];
      if (good) sawOk = good;
      var b2 = v2SaveBar();
      if (sawOk && !b2) return { state: "saved", text: sawOk.text };
      if (!b2) { if (!goneSince) goneSince = Date.now(); else if (Date.now() - goneSince > 1500) break; continue; }
      goneSince = 0;
      var f2 = norm(b2.textContent).match(V2_FIX_RE);
      var sb = v2SaveButton();
      if (f2 && !enabled(sb)) return { state: "blocked", text: f2[0] };
      var busy = saveInFlight();
      if (surelyBusy(b2)) busySeen = true;
      if (!clicked) {
        // Someone else's save was running: once it ends and the bar is still
        // there (no toast told us anything), press Save ourselves.
        if (enabled(sb) && !busy) {
          if (!enabledSince) enabledSince = Date.now();
          else if (Date.now() - enabledSince >= 500) { before = v2Toasts(); clickEl(sb); clicked = true; enabledSince = 0; }
        } else enabledSince = 0;
        continue;
      }
      if (suspect && !busy) {
        if (!idleSince) idleSince = Date.now();
        else if (Date.now() - idleSince >= 1500) return { state: "failed", text: suspect.text };
      } else if (busy) idleSince = 0;
    }
    if (!v2SaveBar()) return sawOk ? { state: "saved", text: sawOk.text } : { state: "unconfirmed", text: "the bar closed but no confirmation appeared" };
    if (!clicked && !busySeen) {
      var fz = norm(v2SaveBar().textContent).match(V2_FIX_RE);
      return { state: "blocked", text: fz ? fz[0] : "the Save button is disabled" };
    }
    if (suspect) return { state: "failed", text: suspect.text };
    return { state: "unconfirmed", text: "the Save didn't finish" };
  }
  // Wait for a NEW (or updated-in-place) toast after `before` (a snapshot from
  // v2Toasts()): returns { ok:true|false|null, text } — null = none within the budget.
  async function v2WaitToast(before, okRe, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      await sleep(200);
      var fresh = v2FreshToasts(before);
      var bad = fresh.filter(function (x) { return v2ToneBad(x) || V2_FAIL_RE.test(x.text); })[0];
      if (bad) return { ok: false, text: bad.text };
      var good = fresh.filter(function (x) { return x.tone === "success" || (okRe || V2_OK_RE).test(x.text); })[0];
      if (good) return { ok: true, text: good.text };
    }
    return { ok: null, text: "" };
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
    isAuthRedirect: isAuthRedirect, waitFor: waitFor, waitForToast: waitForToast,
    toastSnapshot: toastSnapshot, freshToastTexts: freshToastTexts, waitToastResult: waitToastResult,
    saveInFlight: saveInFlight, waitSaveIdle: waitSaveIdle, TOAST_FAIL: TOAST_FAIL,
    popoverItems: popoverItems,
    // new 2-field UI
    V2_SECTIONS: V2_SECTIONS, v2IsNewUi: v2IsNewUi, v2SectionButton: v2SectionButton, v2ActiveSection: v2ActiveSection,
    v2GotoSection: v2GotoSection, v2LabelOf: v2LabelOf, v2Combo: v2Combo, v2ComboValue: v2ComboValue, v2PickCombo: v2PickCombo,
    v2Switch: v2Switch, v2SetSwitch: v2SetSwitch, v2SaveBar: v2SaveBar, v2SaveButton: v2SaveButton,
    v2Toasts: v2Toasts, v2SaveAll: v2SaveAll, v2WaitToast: v2WaitToast
  };
})();
