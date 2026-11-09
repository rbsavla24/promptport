/*
 * bridge.js  (ISOLATED world, document_start) — the extension's end of the
 * private channel with interceptor.js (MAIN world).
 *
 * Both scripts run before any page script. They meet on one
 * <promptport-bridge> element: whichever runs first adds it under <html>, the
 * other takes it out again. From then on the element is detached and only these
 * two scripts hold it, so events dispatched on it can't be seen or forged by the
 * page. content.js (same isolated world, later) reads window.__ppBridge.
 */
(function () {
  "use strict";
  if (window.__ppBridge) return;
  var el = null;
  try {
    var de = document.documentElement;
    if (de) {
      var TAG = "promptport-bridge";
      for (var c = de.firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName === TAG && c.getAttribute("data-pp") === "1") { el = c; break; }
      }
      if (el) de.removeChild(el);
      else {
        el = document.createElement(TAG);
        el.setAttribute("data-pp", "1");
        de.appendChild(el);
        var drop = function () { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) {} };
        setTimeout(drop, 0);
        document.addEventListener("readystatechange", drop, { once: true });
      }
    }
  } catch (e) { el = null; }
  // Messages that arrive before content.js is ready are queued (bounded).
  var queue = [], handler = null;
  if (el) el.addEventListener("pp-to-ext", function (ev) {
    var m = ev.detail;
    if (!m || typeof m !== "object") return;
    if (handler) { try { handler(m); } catch (e) {} }
    else { queue.push(m); if (queue.length > 20) queue.shift(); }
  });
  window.__ppBridge = {
    ok: !!el,
    send: function (msg) {
      if (!el) return false;
      try { el.dispatchEvent(new CustomEvent("pp-to-page", { detail: msg })); return true; } catch (e) { return false; }
    },
    listen: function (fn) {
      handler = fn;
      var q = queue; queue = [];
      q.forEach(function (m) { try { fn(m); } catch (e) {} });
    }
  };
})();
