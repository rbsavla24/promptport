/*
 * interceptor.js  (runs in the PAGE / MAIN world, at document_start)
 *
 * Ringg's dashboard is a single-page app: the assistant's configuration
 * (First Message, Objective, Response Guideline, Conversation Script, FAQs)
 * is loaded from Ringg's own API as JSON. This script patches fetch() and
 * XMLHttpRequest so we can capture that JSON as it flows by, then hands the
 * relevant payload to our extension (the ISOLATED-world content script) via
 * window.postMessage.
 *
 * It also remembers the URL/method of the request that returned the assistant
 * so the extension can ask it to re-fetch fresh data on demand (useful if the
 * page had already loaded before the extension was enabled).
 */
(function () {
  "use strict";

  var NS = "RINGG_MD_EXPORTER";
  var captures = [];        // recent JSON payloads seen, most recent last
  var assistantReq = null;  // { url, method } of a GET that returned the assistant
  var lastAssistant = null; // newest assistant payload, kept even after captures roll over

  function looksLikeAssistant(obj) {
    if (!obj || typeof obj !== "object") return false;
    // Cheap heuristic: does the JSON (anywhere) mention any of our target concepts?
    var s;
    try { s = JSON.stringify(obj).toLowerCase(); } catch (e) { return false; }
    var hits = 0;
    ["objective", "first_message", "firstmessage", "greeting",
     "response_guideline", "responseguideline", "guideline",
     "conversation", "script", "faq"].forEach(function (k) {
      if (s.indexOf(k) !== -1) hits++;
    });
    return hits >= 2;
  }

  function record(url, method, text) {
    if (!text || typeof text !== "string") return;
    var data;
    try { data = JSON.parse(text); } catch (e) { return; }
    captures.push({ url: url, at: Date.now(), data: data });
    if (captures.length > 25) captures.shift();
    if (looksLikeAssistant(data)) {
      // Keep the newest assistant payload even after it scrolls out of `captures`.
      lastAssistant = { url: url, data: data };
      // Only a read (GET) is ever safe to repeat. Never remember a save
      // (POST/PUT/PATCH/DELETE): re-sending it without its body could
      // overwrite or clear the assistant on the server.
      var m = (method || "GET").toUpperCase();
      if (m === "GET") assistantReq = { url: url, method: "GET" };
      post("assistant-data", { url: url, data: data });
    }
  }

  // Look for assistant data embedded in the initial HTML (SSR / Next.js).
  function scanEmbedded() {
    var found = [];
    try { if (window.__NEXT_DATA__) found.push({ url: "__NEXT_DATA__", data: window.__NEXT_DATA__ }); } catch (e) {}
    var scripts = document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__');
    for (var i = 0; i < scripts.length; i++) {
      var t = scripts[i].textContent || "";
      if (t.length > 200 && /objective|first_?message|faq|guideline|script/i.test(t)) {
        try { found.push({ url: "embedded-script", data: JSON.parse(t) }); } catch (e) {}
      }
    }
    return found;
  }

  function post(type, payload) {
    try {
      window.postMessage({ __ns: NS, type: type, payload: payload }, "*");
    } catch (e) { /* payload not clonable — ignore */ }
  }

  // ---- patch fetch --------------------------------------------------------
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function () {
      var args = arguments;
      var url = "";
      try {
        url = (typeof args[0] === "string") ? args[0]
            : (args[0] && args[0].url) ? args[0].url : String(args[0]);
      } catch (e) {}
      var method = (args[1] && args[1].method) ||
                   (args[0] && args[0].method) || "GET";
      return origFetch.apply(this, args).then(function (res) {
        try {
          var ct = res.headers.get("content-type") || "";
          if (ct.indexOf("json") !== -1 || url.indexOf("api") !== -1) {
            res.clone().text().then(function (t) { record(url, method, t); })
                               .catch(function () {});
          }
        } catch (e) {}
        return res;
      });
    };
  }

  // ---- patch XMLHttpRequest ----------------------------------------------
  var OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    var open = OrigXHR.prototype.open;
    var send = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url) {
      this.__ringg_url = url;
      this.__ringg_method = method;
      return open.apply(this, arguments);
    };
    OrigXHR.prototype.send = function () {
      var xhr = this;
      xhr.addEventListener("load", function () {
        try {
          var t = (xhr.responseType === "" || xhr.responseType === "text")
                    ? xhr.responseText
                    : (xhr.responseType === "json" ? JSON.stringify(xhr.response) : null);
          if (t) record(xhr.__ringg_url || "", xhr.__ringg_method, t);
        } catch (e) {}
      });
      return send.apply(this, arguments);
    };
  }

  // ---- respond to requests from the extension -----------------------------
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var msg = ev.data;
    if (!msg || msg.__ns !== NS) return;

    if (msg.type === "request-latest") {
      // Send EVERY captured JSON payload so the extension can deep-search them
      // all (field naming varies; we don't want to rely on one guess).
      post("captures", {
        list: captures.map(function (c) { return { url: c.url, data: c.data }; })
      });
      // Include anything embedded in the page (covers server-rendered data).
      var embedded = scanEmbedded();
      if (embedded.length) post("captures", { list: embedded });
      // Also flag any assistant-looking payloads (used for naming, etc.).
      for (var i = captures.length - 1; i >= 0; i--) {
        if (looksLikeAssistant(captures[i].data)) {
          post("assistant-data", { url: captures[i].url, data: captures[i].data });
          return;
        }
      }
      // Assistant payload has scrolled out of `captures` — resend the copy we kept.
      if (lastAssistant) {
        post("assistant-data", { url: lastAssistant.url, data: lastAssistant.data });
        return;
      }
      // Nothing captured yet — re-fetch the known assistant endpoint (GET only).
      if (assistantReq && assistantReq.method === "GET") {
        try {
          window.fetch(assistantReq.url, { method: "GET", credentials: "include" })
            .then(function (r) { return r.text(); })
            .then(function (t) { record(assistantReq.url, assistantReq.method, t); })
            .catch(function () { post("no-data", {}); });
        } catch (e) { post("no-data", {}); }
      } else {
        post("no-data", {});
      }
    }
  });

  post("interceptor-ready", {});
})();
