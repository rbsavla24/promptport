/*
 * host.js — which dashboard is this page?
 *
 * The extension supports two voice-bot dashboard layouts:
 *   - "dash5": a 5-field editor (First Message, Objective, Response
 *     Guidelines, Conversation Script, FAQs)
 *   - "dash2": a 2-field editor (First Message, Main Prompt)
 * Their web addresses live in ONE place only: manifest.json. content_scripts
 * entry [1] lists the 5-field dashboard's addresses and entry [2] the 2-field
 * dashboard's. This file reads those match patterns at run time, so no
 * address is repeated anywhere in the code.
 */
(function () {
  "use strict";
  var esc = function (s) { return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"); };
  function parse(pattern) {
    var m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern || "");
    if (!m) return null;
    var host = m[2] === "*" ? "[^/]+" : (m[2].indexOf("*.") === 0 ? "(?:[^/]+\\.)?" + esc(m[2].slice(2)) : esc(m[2]));
    return {
      host: new RegExp("^" + host + "$", "i"),
      url: new RegExp("^" + (m[1] === "*" ? "https?" : m[1]) + ":\\/\\/" + host + esc(m[3]).replace(/\\\*/g, ".*").replace(/\*/g, ".*") + "$", "i")
    };
  }
  var cache = null;
  function lists() {
    if (cache) return cache;
    var cs = [];
    try { cs = (chrome.runtime.getManifest().content_scripts) || []; } catch (e) {}
    var pick = function (i) { return ((cs[i] && cs[i].matches) || []).map(parse).filter(Boolean); };
    cache = { dash5: pick(1), dash2: pick(2) };
    return cache;
  }
  function any(list, key, value) { return list.some(function (p) { return p[key].test(value); }); }
  // In-page: by hostname, so in-app navigation to other paths keeps the layout.
  function layout(hostname) {
    var h = String(hostname != null ? hostname : (typeof location !== "undefined" ? location.hostname : "") || "");
    var L = lists();
    if (any(L.dash2, "host", h)) return "dash2";
    if (any(L.dash5, "host", h)) return "dash5";
    return "";
  }
  // Toolbar popup: by full address, exactly as Chrome injects the content scripts.
  function layoutOfUrl(url) {
    var u = String(url || ""), L = lists();
    if (any(L.dash2, "url", u)) return "dash2";
    if (any(L.dash5, "url", u)) return "dash5";
    return "";
  }
  window.PPHost = { layout: layout, layoutOfUrl: layoutOfUrl };
})();
