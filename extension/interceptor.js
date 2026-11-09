/*
 * interceptor.js  (runs in the PAGE / MAIN world, at document_start)
 *
 * The dashboards are single-page apps: the bot's configuration is loaded from
 * their own APIs as JSON. This script patches fetch() and XMLHttpRequest so we
 * can keep a copy of the RELEVANT JSON responses (bot / agent / gateway APIs,
 * application/json only, at most 5 MB each) as they flow by, and hands them to
 * the extension's content script (ISOLATED world) on request.
 *
 * Private channel: at document_start — before any page script can run — this
 * script and bridge.js (ISOLATED world, also document_start) meet on one
 * <promptport-bridge> element that is taken out of the document straight away.
 * Events dispatched on that detached element reach only the two scripts that
 * hold a reference to it, so a script in the page can neither read nor forge
 * what the extension receives.
 *
 * Every kept response is tagged with the page it was captured on (page key =
 * the bot id in the address, else the path) and with the bot id in the
 * request's own address when it has one. When the page moves to another bot the
 * previous bot's responses are dropped, so one bot's data never travels with
 * another bot's export. Only response BODIES are read — never request headers
 * or tokens.
 */
(function () {
  "use strict";

  var NS = "PROMPTPORT_BRIDGE";
  var MAX_BYTES = 5 * 1024 * 1024;   // never keep (or even read) a body larger than this
  var RING_MAX = 25;
  var captures = [];        // recent relevant JSON payloads, most recent last: { url, at, data, key, urlBot }
  var lastAssistant = null; // newest assistant payload (same shape), kept even after captures roll over

  // ---- page identity --------------------------------------------------------
  function pathBot(path) {
    var m = String(path || "").match(/\/voice-agents\/([0-9a-f-]{36})(?:[\/?#]|$)/i) ||
            String(path || "").match(/\/assistants\/([0-9a-f-]{8,})(?:[\/?#]|$)/i);
    return m ? m[1].toLowerCase() : "";
  }
  function pageKeyOf(path) { var b = pathBot(path); return b ? "bot:" + b : "path:" + String(path || ""); }
  function curPath() { try { return String(location.pathname || ""); } catch (e) { return ""; } }
  var ringKey = pageKeyOf(curPath());
  var initialKey = ringKey;          // what embedded (server-rendered) data belongs to
  // The bot a request's own address names (tools/<bot>, voiceagents/<bot>, agent/<bot>, …).
  var URL_BOT_RE = /\/(?:assistants?|agents?|voiceagents|voice-agents|tools|webhooks|bots?)\/([0-9a-f][0-9a-f-]{7,})(?=[\/?#]|$)/i;
  function urlBot(url) { var m = String(url || "").match(URL_BOT_RE); return m ? m[1].toLowerCase() : ""; }

  // The page moved to another bot (SPA navigation): drop what belongs to the
  // previous one. Responses whose own address names the new bot stay (the app
  // may load the next bot just before it changes the address).
  function syncPage() {
    var k = pageKeyOf(curPath());
    if (k === ringKey) return;
    ringKey = k;
    var bot = k.indexOf("bot:") === 0 ? k.slice(4) : "";
    var keep = function (c) { return !!(c && bot && c.urlBot && c.urlBot === bot); };
    captures = captures.filter(keep);
    if (lastAssistant && !keep(lastAssistant)) lastAssistant = null;
  }

  // ---- 2-field gateway store ----------------------------------------------
  // The bot is loaded from a gateway API in many separate responses (agent,
  // tools per phase, webhooks, catalogues). A big bot's responses would roll out
  // of the small ring buffer above, so they are also kept here, newest response
  // per URL. Entries tied to another bot id are dropped when the page's bot changes.
  var GATEWAY_RE = /\/v1\/(voiceagents\/[0-9a-f-]{36}(\?|$)|tools\/[0-9a-f-]{36}|webhooks\/[0-9a-f-]{36}|webhook-events|providers|provider-models|voiceagents\/compatible-voices|voiceagents\/language-catalog)/i;
  var BOT_SCOPED_RE = /\/v1\/(?:voiceagents|tools|webhooks)\/([0-9a-f-]{36})(?:[?#\/]|$)/i;
  var gateway = {};          // url -> { url, at, data }
  var gatewayBot = "";       // bot id of the page the store belongs to
  function pageBotId() {
    var m = curPath().match(/\/voice-agents\/([0-9a-f-]{36})(?:[\/?#]|$)/i);
    return m ? m[1].toLowerCase() : "";
  }
  function gwUrlBotId(url) {
    var m = String(url || "").match(BOT_SCOPED_RE);
    return m ? m[1].toLowerCase() : "";
  }
  function pruneGateway() {
    var bot = pageBotId();
    if (bot === gatewayBot) return;
    gatewayBot = bot;
    if (!bot) return;
    Object.keys(gateway).forEach(function (u) {
      var id = gwUrlBotId(u);
      if (id && id !== bot) delete gateway[u];
    });
  }
  // The new layout saves with POST /v1/voiceagents/update/<id> and answers with
  // the saved agent: kept under the agent's own GET address (the store is keyed
  // by address, and the export looks the agent up there).
  var UPDATE_RE = /^(.*\/v1\/voiceagents\/)update\/([0-9a-f-]{36})\/?(?:[?#].*)?$/i;
  var GW_MAX = 80;           // bounded: the bot list page prefetches every listed bot
  function recordGateway(url, method, data) {
    var m = (method || "GET").toUpperCase();
    var up = m === "POST" ? String(url || "").match(UPDATE_RE) : null;
    if (up) {
      var ud = data && typeof data === "object" ? (data.data && typeof data.data === "object" ? data.data : data) : null;
      if (!ud || !("variable_schema" in ud || "agent_config" in ud || "system_prompt" in ud)) return;
      if (ud.id != null && String(ud.id).toLowerCase() !== up[2].toLowerCase()) return;
      url = up[1] + up[2];
      m = "GET";
    }
    if (m !== "GET") {
      // A save (PATCH/PUT on the agent itself) answers with the saved agent:
      // keep it as the newest copy, so an export after a save without a
      // re-read uses what was saved, not the older GET.
      if (!(m === "PATCH" || m === "PUT") || !/\/v1\/voiceagents\/[^\/?#]+\/?(?:[?#]|$)/i.test(String(url || ""))) return;
      var d = data && typeof data === "object" ? (data.data && typeof data.data === "object" ? data.data : data) : null;
      if (!d || !("variable_schema" in d || "agent_config" in d || "system_prompt" in d)) return;
    }
    if (!GATEWAY_RE.test(String(url || ""))) return;
    // Also on the bot LIST page (no bot in the address): it prefetches every
    // listed bot's agent and the voice catalogue, and a bot opened from the list
    // within ~30 s is NOT fetched again — those responses are the only copy.
    // Once a bot page is open, pruneGateway drops the other bots' entries.
    pruneGateway();
    var id = gwUrlBotId(url);
    if (id && gatewayBot && id !== gatewayBot) return;   // another bot's response
    gateway[url] = { url: url, at: Date.now(), data: data };
    var keys = Object.keys(gateway);
    if (keys.length > GW_MAX) {
      // Evicted first: other bots' entries, then catalogues; this bot's own
      // (agent, tools, webhooks) last. Oldest first within each.
      var rank = function (u) { var b = gwUrlBotId(u); return !b ? 1 : (gatewayBot && b === gatewayBot ? 2 : 0); };
      keys.sort(function (a, b) { return (rank(a) - rank(b)) || (gateway[a].at - gateway[b].at); });
      for (var i = 0; i < keys.length - GW_MAX; i++) delete gateway[keys[i]];
    }
  }

  // Only bot-related API responses are kept (never arbitrary page traffic).
  var RELEVANT_RE = /assistant|agent|bot\b|bots\b|tool|webhook|voice|language|provider/i;
  function relevant(url) {
    var u = String(url || "");
    if (!u || /^(blob|data):/i.test(u)) return false;
    var p = u;
    try { var x = new URL(u, location.href); p = x.pathname + x.search; } catch (e) {}
    return GATEWAY_RE.test(p) || RELEVANT_RE.test(p);
  }
  function jsonType(ct) { ct = String(ct || "").toLowerCase(); return ct.indexOf("json") !== -1 && ct.indexOf("event-stream") === -1; }

  var ASSIST_KEYS = ["objective", "first_message", "firstmessage", "greeting",
    "response_guideline", "responseguideline", "guideline", "conversation", "script", "faq"];
  function looksLikeAssistant(s) {
    if (typeof s !== "string") { try { s = JSON.stringify(s); } catch (e) { return false; } }
    s = String(s || "").toLowerCase();
    var hits = 0;
    ASSIST_KEYS.forEach(function (k) { if (s.indexOf(k) !== -1) hits++; });
    return hits >= 2;
  }

  // reqKey: the page key when the request was MADE (a response that lands after
  // the page moved on belongs to the page that asked for it).
  function record(url, method, text, data, reqKey) {
    if (data === undefined) {
      if (!text || typeof text !== "string" || text.length > MAX_BYTES) return;
      try { data = JSON.parse(text); } catch (e) { return; }
    }
    if (!data || typeof data !== "object") return;
    syncPage();
    var ub = urlBot(url);
    // Without its own bot id, a response asked for by a page we already left is dropped.
    if (!ub && reqKey && reqKey !== ringKey) return;
    var entry = { url: url, at: Date.now(), data: data, key: reqKey || ringKey, urlBot: ub };
    captures.push(entry);
    if (captures.length > RING_MAX) captures.shift();
    try { recordGateway(url, method, data); } catch (e) {}
    if (looksLikeAssistant(text != null ? text : data)) {
      lastAssistant = entry;
      send("assistant-data", tagged(entry));
    }
  }
  function tagged(c) { return { url: c.url, at: c.at, data: c.data, key: c.key, urlBot: c.urlBot }; }

  // Look for assistant data embedded in the initial HTML (SSR / Next.js).
  function scanEmbedded() {
    var found = [];
    try { if (window.__NEXT_DATA__) found.push({ url: "__NEXT_DATA__", data: window.__NEXT_DATA__, key: initialKey, urlBot: "" }); } catch (e) {}
    var scripts = document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__');
    for (var i = 0; i < scripts.length; i++) {
      var t = scripts[i].textContent || "";
      if (t.length > 200 && t.length <= MAX_BYTES && /objective|first_?message|faq|guideline|script/i.test(t)) {
        try { found.push({ url: "embedded-script", data: JSON.parse(t), key: initialKey, urlBot: "" }); } catch (e) {}
      }
    }
    return found;
  }

  // ---- private channel ------------------------------------------------------
  var bridgeEl = null;
  (function handshake() {
    try {
      var de = document.documentElement;
      if (!de) return;
      var TAG = "promptport-bridge";
      for (var c = de.firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName === TAG && c.getAttribute("data-pp") === "1") { bridgeEl = c; break; }
      }
      if (bridgeEl) { de.removeChild(bridgeEl); return; }
      // First of the two: leave it for bridge.js (same document_start batch) and
      // take it out at the latest once the current task ends.
      bridgeEl = document.createElement(TAG);
      bridgeEl.setAttribute("data-pp", "1");
      de.appendChild(bridgeEl);
      var drop = function () { try { if (bridgeEl.parentNode) bridgeEl.parentNode.removeChild(bridgeEl); } catch (e) {} };
      setTimeout(drop, 0);
      document.addEventListener("readystatechange", drop, { once: true });
    } catch (e) {}
  })();
  function send(type, payload) {
    if (!bridgeEl) return;
    try { bridgeEl.dispatchEvent(new CustomEvent("pp-to-ext", { detail: { __ns: NS, type: type, payload: payload } })); }
    catch (e) { /* payload not clonable — ignore */ }
  }

  // ---- patch fetch --------------------------------------------------------
  // Read a clone with a byte cap; a body that goes past it is cancelled.
  function readCapped(res) {
    var body = res.clone().body;
    if (!body || typeof body.getReader !== "function") return Promise.resolve(null);
    var rd = body.getReader(), chunks = [], n = 0;
    return (function pump() {
      return rd.read().then(function (c) {
        if (c.done) {
          var all = new Uint8Array(n), o = 0;
          chunks.forEach(function (ch) { all.set(ch, o); o += ch.length; });
          return new TextDecoder().decode(all);
        }
        n += c.value.length;
        if (n > MAX_BYTES) { try { rd.cancel(); } catch (e) {} return null; }
        chunks.push(c.value);
        return pump();
      });
    })();
  }
  // ---- GET/DELETE tool fix (only while a Magic Port run is adding tools) ----
  // The 2-field dashboard's tool form always sends an empty body and a
  // Content-Type header, and its server refuses both for GET/DELETE ("config.body
  // is not allowed for GET/DELETE"), so a GET tool can't be added at all. While
  // the extension asks for it (a migration is running), an EMPTY body and the
  // JSON Content-Type header are dropped from such a tool request. Nothing else
  // is changed, and a non-empty body is left for the server to judge.
  var toolFixUntil = 0;
  function isEmptyBody(b) {
    if (b == null || b === "") return true;
    if (Array.isArray(b)) return !b.length;
    return typeof b === "object" && !Object.keys(b).length;
  }
  function fixToolBody(url, body) {
    try {
      if (!(toolFixUntil > Date.now()) || typeof body !== "string" || body.length > 200000) return null;
      if (!/\/v1\/tools(\/|$|\?)/.test(String(url))) return null;
      var j = JSON.parse(body), c = j && j.config;
      if (!c || typeof c !== "object" || !/^(GET|DELETE)$/i.test(String(c.method || ""))) return null;
      var changed = false;
      if ("body" in c && isEmptyBody(c.body)) { delete c.body; changed = true; }
      var h = c.headers;
      if (changed && h && typeof h === "object" && !Array.isArray(h)) {
        Object.keys(h).forEach(function (k) {
          var v = h[k], val = v && typeof v === "object" ? v.value : v;
          if (/^content-type$/i.test(k) && /^application\/json\b/i.test(String(val || ""))) delete h[k];
        });
      }
      return changed ? JSON.stringify(j) : null;
    } catch (e) { return null; }
  }
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function () {
      var args = arguments;
      try {
        var f0 = args[0], f1 = args[1];
        if (toolFixUntil > Date.now() && f1 && typeof f1 === "object" && typeof f1.body === "string" &&
            /^(POST|PUT|PATCH)$/i.test(String(f1.method || ""))) {
          var u0 = (f0 && typeof f0 === "object" && typeof f0.url === "string") ? f0.url : String(f0);
          var nb = fixToolBody(u0, f1.body);
          if (nb !== null) { var ni = {}; for (var k in f1) ni[k] = f1[k]; ni.body = nb; args = [f0, ni]; }
        }
      } catch (e) {}
      var url = "", method = "GET", reqKey = "";
      try {
        var a0 = args[0];
        url = (a0 && typeof a0 === "object" && typeof a0.url === "string") ? a0.url : String(a0);
        method = String((args[1] && args[1].method) || (a0 && typeof a0 === "object" && a0.method) || "GET");
        reqKey = pageKeyOf(curPath());
      } catch (e) {}
      var p = origFetch.apply(this, args);
      try {
        if (relevant(url)) {
          p.then(function (res) {
            try {
              if (!res || !jsonType(res.headers.get("content-type"))) return;
              var cl = +(res.headers.get("content-length") || 0);
              if (cl > MAX_BYTES) return;
              readCapped(res).then(function (t) { if (t) record(url, method, t, undefined, reqKey); }).catch(function () {});
            } catch (e) {}
          }, function () {});
        }
      } catch (e) {}
      return p;
    };
  }

  // ---- patch XMLHttpRequest ----------------------------------------------
  var OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    var open = OrigXHR.prototype.open;
    var sendX = OrigXHR.prototype.send;
    var info = new WeakMap();   // xhr -> { url, method, key, hooked }
    var onLoad = function () {
      var xhr = this, i = info.get(xhr);
      if (!i || !relevant(i.url)) return;
      try {
        if (!jsonType(xhr.getResponseHeader("content-type"))) return;
        if (xhr.responseType === "" || xhr.responseType === "text") {
          var t = xhr.responseText;
          if (t && t.length <= MAX_BYTES) record(i.url, i.method, t, undefined, i.key);
        } else if (xhr.responseType === "json") {
          var r = xhr.response;
          if (r && typeof r === "object") record(i.url, i.method, null, r, i.key);
        }
      } catch (e) {}
    };
    OrigXHR.prototype.open = function (method, url) {
      try {
        var i = info.get(this) || {};
        i.url = String(url); i.method = String(method || "GET"); i.key = pageKeyOf(curPath());
        info.set(this, i);
      } catch (e) {}
      return open.apply(this, arguments);
    };
    OrigXHR.prototype.send = function () {
      var sargs = arguments;
      try {
        var i0 = info.get(this);
        if (i0 && toolFixUntil > Date.now() && /^(POST|PUT|PATCH)$/i.test(i0.method) && typeof sargs[0] === "string") {
          var nbx = fixToolBody(i0.url, sargs[0]);
          if (nbx !== null) sargs = [nbx];
        }
      } catch (e) {}
      try {
        var i = info.get(this);
        if (i && !i.hooked) { i.hooked = true; this.addEventListener("load", onLoad); }   // once per instance
      } catch (e) {}
      return sendX.apply(this, sargs);
    };
  }

  // ---- answer the extension -------------------------------------------------
  function answer(post) {
    syncPage();
    // Every kept response, tagged with the page / bot it belongs to.
    post("captures", { list: captures.map(tagged) });
    // 2-field bot: every kept gateway response for this bot (oldest first).
    try {
      pruneGateway();
      var gw = Object.keys(gateway).map(function (u) { return gateway[u]; })
        .sort(function (a, b) { return a.at - b.at; })
        .map(function (c) { return { url: c.url, at: c.at, data: c.data, key: ringKey, urlBot: gwUrlBotId(c.url) }; });
      if (gw.length || pageBotId()) post("captures", { list: gw, gateway: true, botId: gatewayBot });
    } catch (e) {}
    var embedded = scanEmbedded();
    if (embedded.length) post("captures", { list: embedded });
    if (lastAssistant) post("assistant-data", tagged(lastAssistant));
  }
  if (bridgeEl) bridgeEl.addEventListener("pp-to-page", function (ev) {
    var msg = ev.detail;
    if (msg && msg.__ns === NS && msg.type === "request-latest") answer(send);
    else if (msg && msg.__ns === NS && msg.type === "tool-fix") toolFixUntil = msg.on ? Date.now() + 30 * 60 * 1000 : 0;
  });
  // Diagnostics for the page's own scripts (and the test harness): a same-window
  // "request-latest" is answered on the window. It only repeats what the page
  // itself already received; nothing posted on the window is ever read by the
  // extension.
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var msg = ev.data;
    if (!msg || msg.__ns !== NS || msg.type !== "request-latest") return;
    answer(function (type, payload) {
      try { window.postMessage({ __ns: NS, type: type, payload: payload }, "*"); } catch (e) {}
    });
  });
})();
