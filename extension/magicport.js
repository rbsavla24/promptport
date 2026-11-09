/*
 * magicport.js  (ISOLATED world)  — PromptPort v4.0
 *
 * Magic Port: migrate a FULL voice bot (prompt + configurations) between
 * Dash5 and Dash2. This file is the platform-agnostic ENGINE:
 *   - the Magic Port ZIP / config format,
 *   - extraction of all 6 data points from a source bot,
 *   - cross-platform type / event mapping (the rules verified with Raj),
 *   - validation that enforces the two correctness requirements.
 *
 * content.js is the orchestrator: it owns the captured API JSON (from
 * interceptor.js), the DOM, PPExtract (prompt buckets) and PPZip, and
 * calls into window.MagicPort here.
 *
 * The 6 data points (per the agreed spec):
 *   1. Prompt            — carried as the existing .md files (5 or 2 buckets)
 *   2. Custom Variables  — name (+ type on Dash2)
 *   3. Language & Voice  — primary + secondary language
 *   4. Custom Analysis   — prompt + required keys {name, type, required/default}
 *   5. Tools             — per-phase API tools (cURL)
 *   6. Event Subscription— webhooks {url, events[]}
 *
 * CORRECTNESS REQUIREMENTS (see MAGICPORT-BUILD-REQUIREMENTS):
 *   REQ-1  Copy ALL custom variables — read the complete list from the source
 *          API JSON (never a scrape of visible rows); verify the count.
 *   REQ-2  Map Integer correctly — Dash5 Integer/Number/Float -> Dash2 Number
 *          (NOT String); verify each key's type after import.
 *
 * NOTE on field names: the source API JSON field names are matched FLEXIBLY
 * (deep-search over candidate keys), the same defensive pattern extract.js
 * uses, so a minor naming change on either platform doesn't break export.
 * Exact names are confirmed against live captures during testing; where a name
 * is still to be confirmed it is marked CONFIRM@TEST.
 */
(function () {
  "use strict";

  var FORMAT = 1;                 // Magic Port config format version
  var CONFIG_NAME = "magicport.json";

  // ------------------------------------------------------------------ platforms
  var DASH5 = "dash5", DASH2 = "dash2";

  // The running build's version (manifest), for magicport.json.
  function buildVersion() {
    try {
      var v = chrome && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version;
      if (typeof v === "string" && v.trim()) return v.trim();
    } catch (e) {}
    return "4.1.0";
  }
  // The dashboard layout of this page (addresses come from manifest.json via host.js).
  function hostPlatform() {
    try { return (window.PPHost && window.PPHost.layout()) || ""; } catch (e) { return ""; }
  }
  // Files exported by v4.0.0 keyed the layouts by the platform's own name (a
  // 5-letter key for the 5-field layout, a 6-letter key for the 2-field one).
  // Those two exact keys are recognised by a fingerprint (so this file never
  // spells them out); any other value is returned as-is (lower-cased) and is
  // treated as neither layout by every caller -- never guessed from its length.
  var LEGACY_KEY = { 194936080: DASH5, 2123827613: DASH2 };
  function keyPrint(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; }
  var PLATFORM_SYNONYM = Object.create(null);
  ["dash5", "5-field", "5field", "5-field dashboard", "five-field"].forEach(function (k) { PLATFORM_SYNONYM[k] = DASH5; });
  ["dash2", "2-field", "2field", "2-field dashboard", "two-field"].forEach(function (k) { PLATFORM_SYNONYM[k] = DASH2; });
  function normPlatform(p) {
    p = String(p || "").trim().toLowerCase();
    if (!p) return p;
    if (PLATFORM_SYNONYM[p]) return PLATFORM_SYNONYM[p];
    if ((p.length === 5 || p.length === 6) && /^[a-z]+$/.test(p) && LEGACY_KEY[keyPrint(p)] &&
        (LEGACY_KEY[keyPrint(p)] === DASH5) === (p.length === 5)) return LEGACY_KEY[keyPrint(p)];
    return p;
  }
  function layoutLabel(p) { p = normPlatform(p); return p === DASH5 ? "5-field dashboard" : p === DASH2 ? "2-field dashboard" : "dashboard"; }

  // ------------------------------------------------------------------ type maps
  // Dash2 has TWO DIFFERENT type dropdowns (confirmed live, Raj):
  //   - Custom VARIABLES: String, Date
  //   - Custom ANALYSIS KEYS: String, Number, Boolean, String[]   (no Date)
  // Dash5 key/variable types: String, Number, Integer, Boolean, Array, Date, DateTime.

  function norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
  // Own-property test: maps keyed by user data (variable / key / event names)
  // must never see Object.prototype members (constructor, toString, __proto__ …).
  function own(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }

  // Dash5 stores languages as locale CODES (ta-IN, en-IN); Dash2 uses display
  // NAMES (Tamil, English). Map by the base code.
  var LANG_CODE_NAME = {
    en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", kn: "Kannada",
    ml: "Malayalam", mr: "Marathi", bn: "Bengali", gu: "Gujarati", pa: "Punjabi",
    or: "Odia", ur: "Urdu", as: "Assamese",
    // wider ISO 639-1/-2 table (Indian + common world languages)
    ne: "Nepali", si: "Sinhala", sa: "Sanskrit", sd: "Sindhi", ks: "Kashmiri", kok: "Konkani",
    mai: "Maithili", doi: "Dogri", mni: "Manipuri", sat: "Santali", brx: "Bodo",
    ar: "Arabic", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese",
    ru: "Russian", ja: "Japanese", ko: "Korean", zh: "Chinese", id: "Indonesian", ms: "Malay",
    th: "Thai", vi: "Vietnamese", tr: "Turkish", nl: "Dutch", pl: "Polish", sv: "Swedish",
    fa: "Persian", he: "Hebrew", sw: "Swahili", fil: "Filipino", tl: "Tagalog"
  };
  var LANG_NAME_CODE = (function () { var m = Object.create(null); Object.keys(LANG_CODE_NAME).forEach(function (k) { m[norm(LANG_CODE_NAME[k])] = k; }); return m; })();
  function langToName(v) {
    if (!v) return "";
    var base = String(v).split(/[-_]/)[0].toLowerCase();
    if (own(LANG_CODE_NAME, base)) return LANG_CODE_NAME[base];
    // already a display name?
    if (LANG_NAME_CODE[norm(v)]) return String(v);
    return String(v);
  }
  // A value that looks like a locale code (hi, ta-IN, zz_ZZ) but is not in the table.
  function langUnknownCode(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s || LANG_NAME_CODE[norm(s)]) return false;
    var base = s.split(/[-_]/)[0].toLowerCase();
    return /^[a-z]{2,3}([-_][a-z0-9]{2,8})*$/i.test(s) && !own(LANG_CODE_NAME, base);
  }

  // Dash5 ANALYSIS KEY type -> Dash2 analysis key type (REQ-2 lives here).
  function mapKeyTypeDash5ToDash2(t) {
    // Normalise spelling: case, spaces, and wrappers like array<string> / list[str].
    var n = norm(t).replace(/\s+/g, "");
    if (/^(array|list)(<|\[|\()?(string|str|text)?(>|\]|\))?$/.test(n) || n === "string[]" || n === "str[]" || n === "[string]" || n === "stringarray" || n === "string_array" || n === "array_of_strings" ||
        /^(array|list)(_?of_?)(strings?|strs?|texts?)$/.test(n))
      return { type: "String[]", flagged: false };
    // sized / unsigned numeric spellings: int8..int128, uint, uint32, float32/64, double, ...
    if (/^(u?int(8|16|32|64|128)?|uint|unsigned(int|integer)?|float(16|32|64)?|double(precision)?|f(32|64)|i(8|16|32|64)|u(8|16|32|64)|bigint|smallint|tinyint)$/.test(n))
      return { type: "Number", flagged: false };
    switch (n) {
      case "integer": case "int": case "int32": case "int64": case "long": case "short":
      case "number": case "float": case "double": case "decimal": case "numeric": case "real":
        return { type: "Number", flagged: false };
      case "boolean": case "bool":
        return { type: "Boolean", flagged: false };
      case "string": case "str": case "text": case "":
        return { type: "String", flagged: false };
      // The 2-field dashboard's analysis key dropdown has no Date -> String, flagged.
      case "date": case "datetime": case "time": case "timestamp":
        return { type: "String", flagged: true, from: t, why: "this dashboard has no Date key type" };
      default:
        // Anything we don't recognise (object, json, array of numbers, ...) is never
        // guessed silently: it becomes String and is flagged on screen.
        return { type: "String", flagged: true, from: t, why: "no matching key type on this dashboard" };
    }
  }

  // Dash5 VARIABLE type -> Dash2 variable type (dropdown = String/Date only).
  function mapVarTypeDash5ToDash2(t) {
    switch (norm(t)) {
      case "date": case "datetime": return { type: "Date", flagged: false };
      case "string": case "":       return { type: "String", flagged: false };
      default:                      return { type: "String", flagged: true, from: t };
    }
  }

  // Dash2 -> Dash5 is clean (Dash5 is a superset): keep the base type, strip []
  // array marker into Dash5's "Array".
  function mapKeyTypeDash2ToDash5(t) {
    var n = norm(t);
    if (n === "string[]" || /\[\]$/.test(n)) return { type: "Array", flagged: false };
    if (n === "number") return { type: "Number", flagged: false };
    if (n === "boolean") return { type: "Boolean", flagged: false };
    if (n === "date") return { type: "Date", flagged: false };
    return { type: "String", flagged: false };
  }

  // ------------------------------------------------------------------ event map
  // Dash5 stored event keys  <->  Dash2 UI events.
  // Dash2 has exactly 3 events (confirmed live): Transcript ready, Recording
  // ready, Analysis completed. Dash5's two analysis events collapse into
  // Dash2's single "Analysis completed".
  // Raj's rule: when importing INTO Dash2, ALWAYS select all 3 events per
  // webhook (see enforceDash2AllEvents), so no per-event map is needed.
  var DASH2_EVENTS = ["Transcript ready", "Recording ready", "Analysis completed"];

  function enforceDash2AllEvents(/* events */) {
    // Raj: always subscribe to all 3 on a Dash2 destination.
    return DASH2_EVENTS.slice();
  }

  // ------------------------------------------------------------- deep-search util
  // Mirrors extract.js findInObject: deep-walk, first non-empty value whose
  // normalized key matches a wanted candidate (earlier candidates win).
  function nk(k) { return String(k == null ? "" : k).toLowerCase().replace(/[^a-z0-9]/g, ""); }
  // presence: a CONTAINER lookup (custom_variables, custom_analysis_prompt, ...).
  // A candidate key that is present but empty ([] / {} / null) still counts as
  // found, so a bot with "custom_variables: []" does not fall through to some
  // unrelated nested "variables" list. At the same rank a non-empty value wins.
  function findEntry(obj, wanted, presence) {
    var wset = wanted.map(nk), best = null, seen = new Set();
    (function visit(node, depth) {
      if (node == null || typeof node !== "object" || depth > 8) return;
      if (seen.has(node)) return; seen.add(node);
      if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) visit(node[i], depth + 1); return; }
      Object.keys(node).forEach(function (k) {
        var rank = wset.indexOf(nk(k));
        if (rank !== -1) {
          var v = node[k];
          var has = (typeof v === "string" && v.trim()) ||
                    (Array.isArray(v) && v.length) ||
                    (v && typeof v === "object" && Object.keys(v).length) ||
                    (typeof v === "number") || (typeof v === "boolean");
          var empty = !has && presence && (v === null || (typeof v === "object"));
          if (has && (best === null || rank < best.rank || (rank === best.rank && best.empty))) best = { rank: rank, value: v };
          else if (empty && (best === null || rank < best.rank)) best = { rank: rank, value: v, empty: true };
        }
        visit(node[k], depth + 1);
      });
    })(obj, 0);
    return best ? { found: true, value: best.value, empty: !!best.empty } : { found: false, value: null, empty: false };
  }
  function findValue(obj, wanted, presence) { return findEntry(obj, wanted, presence).value; }

  // Pick the first present string field from an object by candidate names.
  function pickStr(o, cands) {
    if (!o || typeof o !== "object") return "";
    // The item's OWN top-level fields win over anything nested inside it
    // ({variable_name:"x", validation:{name:"regex"}} -> "x"); deep search is
    // only the fallback when no candidate is an own field.
    if (!Array.isArray(o)) {
      var ownKeys = Object.keys(o);
      for (var j = 0; j < cands.length; j++) {
        var want = nk(cands[j]);
        for (var q = 0; q < ownKeys.length; q++) {
          if (nk(ownKeys[q]) !== want) continue;
          var ov = o[ownKeys[q]];
          if (typeof ov === "string" && ov.trim()) return ov.trim();
          if (typeof ov === "number" || typeof ov === "boolean") return String(ov);
        }
      }
    }
    for (var i = 0; i < cands.length; i++) {
      var hit = findValue(o, [cands[i]]);
      if (typeof hit === "string" && hit.trim()) return hit.trim();
      if (typeof hit === "number" || typeof hit === "boolean") return String(hit);
    }
    return "";
  }

  // The source agent object may be wrapped in {data|agent|result|...}. Return
  // the inner config object (best effort).
  function unwrap(d) {
    if (!d || typeof d !== "object") return d;
    var inner = d.data || d.agent || d.result || d.assistant || d.payload;
    return (inner && typeof inner === "object") ? inner : d;
  }

  // The agent's top-level ids (after the agents:{...}/[...] envelope).
  function agentIds(a) {
    a = unwrap(a);
    if (a && a.agents && Array.isArray(a.agents) && a.agents[0]) a = a.agents[0];
    else if (a && isObj(a.agents)) a = a.agents;
    var out = [];
    if (!isObj(a)) return out;
    ["id", "agent_id", "agentId", "agentid", "uuid", "_id"].forEach(function (f) {
      var v = a[f];
      if ((typeof v === "string" && v.trim()) || typeof v === "number") out.push(String(v).trim().toLowerCase());
    });
    return out;
  }
  // Of several captured payloads, choose the agent to export.
  //   botId given -> the NEWEST agent-looking capture whose id is botId (null if none);
  //   no botId    -> the bot whose id is in the page address, else the first bot
  //                  seen (the page loads its own bot first), its NEWEST capture.
  // Within one bot only captures with the most agent markers count (so a small
  // side payload that happens to carry the id never wins); size breaks no ties
  // beyond that -- a newer, smaller save beats an older, bigger one.
  function pickAgent(captures, botId) {
    var list = Array.isArray(captures) ? captures : (captures ? [captures] : []);
    var cands = [];
    list.forEach(function (c, idx) {
      var a = unwrap(c);
      if (!a || typeof a !== "object") return;
      // Captures normally come from JSON.parse (never circular), but guard anyway
      // so one odd payload can't throw and abort the whole export.
      var json = ""; try { json = JSON.stringify(a); } catch (e) { json = ""; }
      var lower = json.toLowerCase();
      var k = Object.keys(a).map(nk).join(",");
      var hits = 0;
      ["objective", "firstmessage", "variable", "voice", "language", "analysis", "webhook", "tool"].forEach(function (w) {
        if (k.indexOf(nk(w)) !== -1 || lower.indexOf(w) !== -1) hits++;
      });
      cands.push({ agent: a, idx: idx, hits: hits, size: json.length, ids: agentIds(a) });
    });
    if (!cands.length) return null;
    var want = String(botId == null ? "" : botId).trim().toLowerCase();
    var group;
    if (want) {
      group = cands.filter(function (c) { return c.ids.indexOf(want) !== -1; });
      if (!group.length) return null;
    } else {
      var withId = cands.filter(function (c) { return c.ids.length && c.hits; });
      var href = ""; try { href = String((typeof location !== "undefined" && location.href) || "").toLowerCase(); } catch (e) { href = ""; }
      var inUrl = withId.filter(function (c) { return c.ids.some(function (id) { return id.length >= 4 && href.indexOf(id) !== -1; }); })[0];
      var first = inUrl || withId[0];
      group = first ? cands.filter(function (c) { return c.ids.indexOf(first.ids[0]) !== -1; }) : cands;
    }
    var maxHits = Math.max.apply(null, group.map(function (c) { return c.hits; }));
    var best = null;
    group.forEach(function (c) {
      if (c.hits !== maxHits) return;
      if (!best || c.idx > best.idx || (c.idx === best.idx && c.size > best.size)) best = c;
    });
    return best ? best.agent : null;
  }
  // A 5-field envelope can hold several versions in version_details; export the
  // ACTIVE one (active_agent_version_id). Returns a shallow copy of the agent in
  // which version_details holds only that version, so every extractor sees
  // exactly the shape of a single-version bot. Unknown/absent id -> unchanged.
  function activeVersionView(agentRaw) {
    var root = unwrap(agentRaw);
    if (!isObj(root)) return agentRaw;
    var a = root, wrapKind = "";
    if (Array.isArray(root.agents) && isObj(root.agents[0])) { a = root.agents[0]; wrapKind = "arr"; }
    else if (isObj(root.agents)) { a = root.agents; wrapKind = "obj"; }
    var vd = a.version_details;
    if (!isObj(vd) || Object.keys(vd).length < 2) return agentRaw;
    var act = strOr(a.active_agent_version_id) || strOr(a.active_version_id) || strOr(a.version_id);
    if (!act || !own(vd, act)) return agentRaw;
    var a2 = {}; Object.keys(a).forEach(function (k) { a2[k] = a[k]; });
    // defineProperty: an id like "__proto__" must stay an ordinary own key.
    a2.version_details = {};
    Object.defineProperty(a2.version_details, act, { value: vd[act], enumerable: true, writable: true, configurable: true });
    if (!wrapKind) return a2;
    var r2 = {}; Object.keys(root).forEach(function (k) { r2[k] = root[k]; });
    r2.agents = wrapKind === "arr" ? [a2].concat(root.agents.slice(1)) : a2;
    return r2;
  }

  // ------------------------------------------------------------------ extractors
  // ---- 2. Custom Variables (REQ-1: ALL of them) ---------------------------
  // CONFIRM@TEST candidate container & item field names against live JSON.
  function extractVariables(agent) {
    var arr = findValue(agent, [
      "custom_variables", "customvariables", "variables", "dynamic_variables",
      "dynamicvariables", "call_variables", "template_variables"
    ], true);
    var out = [];
    if (Array.isArray(arr)) {
      arr.forEach(function (v) {
        if (v == null) return;
        if (typeof v === "string") { out.push({ name: v.trim(), type: "String" }); return; }
        if (typeof v === "object") {
          var name = pickStr(v, ["name", "variable_name", "variablename", "key", "label", "slug"]);
          var type = pickStr(v, ["type", "data_type", "datatype", "value_type", "valuetype"]) || "String";
          if (name) out.push({ name: name, type: type });
        }
      });
    } else if (arr && typeof arr === "object") {
      // name -> type map form ({due_date: "Date"} or {due_date: {type: "Date"}})
      Object.keys(arr).forEach(function (name) {
        var v = arr[name];
        var type = (v && typeof v === "object") ? (pickStr(v, ["type", "data_type"]) || "String")
                 : ((typeof v === "string" && /^(string|str|text|date|datetime|time|timestamp|number|integer|int|long|float|double|decimal|boolean|bool|array|list|object|json)$/i.test(v.trim())) ? v.trim() : "String");
        out.push({ name: String(name).trim(), type: type });
      });
    }
    // de-dupe by name, keep first (null-prototype map: names like "constructor" are ordinary)
    var seen = Object.create(null), dedup = [];
    out.forEach(function (x) { if (x.name && !seen[x.name]) { seen[x.name] = 1; dedup.push(x); } });
    return dedup;
  }

  // ---- 3. Language & Voice ------------------------------------------------
  function extractLanguageVoice(agent) {
    return {
      primaryLanguage: pickStr(agent, ["primary_language", "primarylanguage", "language", "lang", "default_language"]),
      secondaryLanguage: pickStr(agent, ["secondary_language", "secondarylanguage", "secondary_lang", "additional_language"])
      // Voice id / speed intentionally NOT ported (per spec).
    };
  }

  // ---- 4. Custom Analysis (prompt + keys) (REQ-2 for key types) -----------
  // A required flag as stored: false/0/"false"/"0"/"no"/"n"/"off" -> false;
  // anything else (true/1/"true"/absent) -> true (the default).
  function parseRequired(v) {
    if (v === false || v === 0) return false;
    if (typeof v === "string" && /^(false|0|no|n|off)$/i.test(v.trim())) return false;
    return true;
  }
  function extractAnalysis(agent) {
    // Real Dash5 shape: custom_analysis_prompt = { prompt, keys:{name:type}, defaults:{name:val} }.
    var hit = findEntry(agent, [
      "custom_analysis_prompt", "customanalysisprompt",
      "advanced_analysis", "post_call_analysis", "custom_analysis", "analysis"
    ], true);
    var node = hit.value;
    // Present but empty (custom_analysis_prompt: null / {}) = this bot has no
    // custom analysis: never fall back to a deep search of the whole agent
    // (that would pick up a tool's prompt / fields).
    if (hit.found && hit.empty) return { prompt: "", keys: [] };
    var scope = (node && typeof node === "object" && !Array.isArray(node)) ? node : agent;
    var prompt = pickStr(scope, ["prompt", "analysis_prompt", "analysisprompt", "system_prompt", "instructions"]);
    var keysSrc = findValue(scope, [
      "keys", "required_keys", "requiredkeys", "schema", "fields", "data_points", "datapoints", "extraction_schema"
    ], scope !== agent);
    var defaults = findValue(scope, ["defaults", "default_values", "defaultvalues"]);
    var keys = [];
    if (Array.isArray(keysSrc)) {
      keysSrc.forEach(function (k) {
        if (k == null) return;
        if (typeof k === "string") { keys.push({ name: k.trim(), type: "String", required: true, default: "" }); return; }
        if (typeof k === "object") {
          var name = pickStr(k, ["name", "key", "field", "label"]);
          var type = pickStr(k, ["type", "data_type", "datatype", "value_type"]) || "String";
          var req = findValue(k, ["required", "is_required", "mandatory"]);
          var def = pickStr(k, ["default", "default_value", "defaultvalue"]);
          if (name) keys.push({ name: name, type: type, required: parseRequired(req), default: def });
        }
      });
    } else if (keysSrc && typeof keysSrc === "object") {
      // name -> type MAP (the real Dash5 shape); defaults is a parallel name -> value map.
      Object.keys(keysSrc).forEach(function (name) {
        var v = keysSrc[name];
        var type = (typeof v === "string") ? v : ((v && typeof v === "object") ? (pickStr(v, ["type", "data_type"]) || "String") : "String");
        var dv = (defaults && typeof defaults === "object" && own(defaults, name)) ? defaults[name] : null;
        var def = dv == null ? "" : (typeof dv === "object" ? d2JsonText(dv) : String(dv));
        keys.push({ name: String(name).trim(), type: type, required: true, default: def });
      });
    }
    return { prompt: prompt, keys: keys };
  }

  // ---- 6. Event Subscription ---------------------------------------------
  function extractWebhooks(agent) {
    var arr = findValue(agent, [
      "event_subscriptions", "eventsubscriptions", "webhooks", "subscriptions",
      "event_webhooks", "callbacks"
    ], true);
    var out = [];
    if (Array.isArray(arr)) {
      arr.forEach(function (w) {
        if (!w || typeof w !== "object") return;
        var url = pickStr(w, ["callback_url", "callbackurl", "url", "webhook_url", "webhookurl", "endpoint"]);
        var method = (pickStr(w, ["method_type", "method", "http_method"]) || "POST").toUpperCase();
        var evs = findValue(w, ["event_type", "events", "event_types", "eventtypes", "subscribed_events"]);
        if (typeof evs === "string") evs = evs.trim() ? [evs] : [];  // one event given as a plain string
        var events = [];
        if (Array.isArray(evs)) evs.forEach(function (e) {
          if (typeof e === "string") events.push(e.trim());
          else if (e && typeof e === "object") { var en = pickStr(e, ["name", "event", "type", "key"]); if (en) events.push(en); }
        });
        // Headers (often an Authorization token) are not ported: only COUNTED, so
        // the export and the import can say so instead of dropping them silently.
        var h = w.headers != null ? w.headers : (w.request_headers != null ? w.request_headers : w.webhook_headers);
        var hc = Array.isArray(h) ? h.filter(function (x) { return x != null; }).length : (isObj(h) ? Object.keys(h).length : 0);
        var hook = { url: url, method: method, events: events };
        if (hc) hook.headerCount = hc;
        if (url) out.push(hook);
      });
    }
    return out;
  }
  function webhookHeaderNote(w) {
    return "Webhook '" + (w.name || w.url) + "': has " + w.headerCount + " header(s) — headers are not ported; add them on the destination.";
  }

  // ---- 5. Tools: parsed from api-tool-fields captures (per phase) ---------
  // Dash5 endpoint: /ca/api/v0/agent/api-tool-fields/{id}?version_id=..&phase=pre_call|on_call|post_call
  // These flow through the interceptor when the user opens the Tools tab.
  var PHASES = ["pre_call", "on_call", "post_call"];
  // ASSISTANT-LEVEL tools (Raj): the bot's own per-phase tools live in the agent
  // JSON as pre_call_tools / on_call_tools / post_call_tools (each with a
  // `config` = {url, method, headers[], query[], path[], body[]}). This is NOT
  // the workspace library (available_tools) and NOT /agent/api-tool-fields/
  // (that endpoint is just the field/variable PALETTE).
  var TOOL_FIELD = { pre_call: "pre_call_tools", on_call: "on_call_tools", post_call: "post_call_tools" };
  // These phased arrays (pre/on/post_call_tools) + embedded_on_call_tools +
  // whatsapp_* are all ASSISTANT-LEVEL (confirmed live: each entry has its own
  // tool_id and none carry the workspace-palette markers is_default/can_disable;
  // the workspace library is the SEPARATE `available_tools` field — dtmf_output,
  // call_transfer, end_call, last_call, … — which we never read).
  // The phased arrays are MIXED by tool_type though: a phase can hold an API_TOOL
  // next to assistant-level NON-API tools (CALLBACK_SCHEDULE_TOOL, and the
  // embedded widgets CALENDER_WIDGET_TOOL / DOM_ACTION_TOOL / FORM_WIDGET_TOOL /
  // QUICK_REPLY_TOOL). Requirement #5 scopes tools to Pre/On/Post-call cURLs, i.e.
  // API tools only, and only API tools carry a config.url we can rebuild on the
  // destination. So we keep ONLY API tools (assistant-level) and record the rest
  // as not-portable — reported, never silently dropped or (worse) exported as a
  // broken empty API tool. The skip is on the API-vs-non-API axis, NOT
  // workspace-vs-assistant (all of these are assistant-level).
  // Any API-flavoured type: API_TOOL, api, custom_api, and the per-phase variants
  // such as pre_call_api_tool (seen live 2026-11-02 on a "greetings" pre-call tool).
  function isApiType(tt) { return /(^|_)api(_tool)?$/.test(tt); }
  // The 2-field dashboard's HTTP tool, whatever spelling the live type uses:
  // HTTP, HTTP_REQUEST, http-request, "HTTP Request" (+ an optional _TOOL suffix).
  function isHttpType(tt) { return /^http([ _-]?request)?([ _-]?tool)?$/i.test(String(tt == null ? "" : tt).trim()); }
  function toolUrl(t) {
    var cfg = (t && t.config) || {};
    var u = pickStr(cfg, ["url", "api_url", "endpoint"]) || pickStr(t || {}, ["url", "api_url", "endpoint"]);
    if (!u) { var deep = findValue(t || {}, ["url", "api_url", "endpoint", "request_url"]); if (typeof deep === "string") u = deep.trim(); }
    return u || "";
  }
  function isApiTool(t) {
    var tt = norm(t && (t.tool_type || t.type));
    if (tt) return isApiType(tt) || isHttpType(tt);
    // No explicit type: treat as an API tool only if it actually has a URL.
    var cfg = (t && t.config) || {};
    return !!(pickStr(cfg, ["url", "api_url", "endpoint"]) || pickStr(t || {}, ["url"]));
  }
  function extractTools(agent) {
    var byPhase = { pre_call: [], on_call: [], post_call: [] };
    var skipped = [];  // non-API tools found in the phased arrays (reported)
    // Non-API tool containers that are never API cURL tools — recorded whole.
    var NON_API_CONTAINERS = ["embedded_on_call_tools", "whatsapp_template_tools", "whatsapp_flow_tools"];
    PHASES.forEach(function (phase) {
      var arr = findValue(agent, [TOOL_FIELD[phase]], true);
      if (!Array.isArray(arr)) return;
      arr.forEach(function (t) {
        if (!t || typeof t !== "object") return;
        if (!isApiTool(t)) {
          skipped.push({ phase: phase, name: pickStr(t, ["tool_name", "name", "label"]),
                         toolType: pickStr(t, ["tool_type", "type"]) });
          return;
        }
        if (!toolUrl(t)) {
          // An API tool with no URL anywhere can't be rebuilt -- say so precisely.
          skipped.push({ phase: phase, name: pickStr(t, ["tool_name", "name", "label"]),
                         toolType: pickStr(t, ["tool_type", "type"]), why: "API tool, but no URL was found in its settings" });
          return;
        }
        var cfg = t.config || {};
        byPhase[phase].push({
          phase: phase,
          name: pickStr(t, ["tool_name", "name", "label"]),
          method: (pickStr(cfg, ["method", "http_method"]) || pickStr(t, ["method"]) || "POST").toUpperCase(),
          url: toolUrl(t),
          // The tool's OWN flag (a nested config.retry.is_enabled:false is not the tool's).
          enabled: own(t, "is_enabled") ? t.is_enabled !== false : (own(cfg, "is_enabled") ? cfg.is_enabled !== false : true),
          raw: t  // full tool definition (config.headers/body/... — CONTAINS CREDENTIALS)
        });
      });
    });
    NON_API_CONTAINERS.forEach(function (field) {
      var arr = findValue(agent, [field]);
      if (!Array.isArray(arr)) return;
      arr.forEach(function (t) {
        if (!t || typeof t !== "object") return;
        skipped.push({ phase: pickStr(t, ["tool_phase"]) || "", name: pickStr(t, ["tool_name", "name", "label"]),
                       toolType: pickStr(t, ["tool_type", "type"]) || field });
      });
    });
    byPhase._skipped = skipped;  // non-enumerable-ish marker; PHASES loops ignore it
    return byPhase;
  }

  // Normalize a captured tool into the fields the Dash2 "+ API" form needs.
  // Source field names vary (CONFIRM@TEST): defensively deep-search `raw`.
  // Returns { name, method, url, headers:[{key,value}], query:[{key,value}], body }.
  // A tool line item is either a STATIC value (e.g. Content-Type: application/json)
  // or a VARIABLE reference (e.g. body field client_loan_id -> {{client_loan_id}}).
  // The import must reproduce each in the same manner, so capture `kind` here.
  // The line item's kind. Dash5's `type` is not limited to static/variable — it
  // can be other values too — so we PRESERVE the explicit type verbatim
  // (normalizing only the obvious static/variable synonyms), and only fall back
  // to value-shape inference when no explicit type is given. This keeps export
  // faithful to any type; the import handles static + variable and flags the rest.
  function itemKind(it, value) {
    var t = norm(it && (it.kind || it.type || it.source || it.value_type || it.valueType || it.field_type));
    if (it && (it.is_variable === true || it.isVariable === true)) return "variable";
    if (t) {
      // Dash5 line-item types (the ⇄ toggle): Static, Variable, JQ, Dynamic.
      // Keep them distinct — "dynamic" and "jq" are NOT the same as "variable".
      if (/^(variable|custom_variable|customvariable|var)$/.test(t)) return "variable";
      if (/^(static|constant|fixed|value|literal)$/.test(t)) return "static";
      if (/^jq$/.test(t)) return "jq";
      if (/^dynamic$/.test(t)) return "dynamic";
      return t;  // preserve any other explicit type verbatim
    }
    if (typeof value === "string" && /\{\{\s*[\w.]+\s*\}\}/.test(value)) return "variable";
    if (typeof value === "string" && /^(custom_args|variables?|dynamic_variables?)\.[\w.]+$/.test(value.trim())) return "variable";
    return "static";
  }
  // A variable value references a SOURCE (the ⇄ toggle sets static vs variable;
  // within variable the value picks a source). Dash5 sources seen live:
  //   custom_args (custom variables), call_data (call metadata),
  //   platform_analysis, client_analysis, tool_output (another tool's output).
  // Only custom_args binds to a custom variable on the destination; the others
  // are platform sources that must map to the destination's equivalent.
  var VAR_SOURCES = ["custom_args", "call_data", "platform_analysis", "client_analysis", "tool_output"];
  function rawMapping(it, value) {
    var m = typeof value === "string" && value.match(/\{\{\s*([\w.]+)\s*\}\}/);
    if (m) return m[1];
    if (typeof value === "string" && value.trim()) return value.trim();
    return String(pickStr(it || {}, ["variable", "variable_name", "var", "value", "key_path", "mapping"]) || "");
  }
  // The source prefix of a variable value (e.g. "custom_args", "call_data").
  function itemSource(it, value) {
    var mp = rawMapping(it, value);
    var m = mp.match(/^([a-z_]+)\./i);
    var pfx = m ? m[1].toLowerCase() : "";
    if (VAR_SOURCES.indexOf(pfx) !== -1) return pfx;
    if (/^(variables?|dynamic_variables?)$/.test(pfx)) return "custom_args";
    return pfx ? "other" : "custom_args"; // a bare name defaults to a custom variable
  }
  // The field/variable name after the source prefix,
  // e.g. "custom_args.client_loan_id" -> "client_loan_id", "call_data.status" -> "status".
  function itemVar(it, value) {
    return rawMapping(it, value)
      .replace(/^(custom_args|call_data|platform_analysis|client_analysis|tool_output|variables?|dynamic_variables?)\./, "")
      .replace(/[{}]/g, "");
  }
  function kvItem(key, value, it) {
    var kind = itemKind(it, value);
    var item = { key: key, value: value, kind: kind };
    if (kind === "variable") { item.source = itemSource(it, value); item.variable = itemVar(it, value); }
    return item;
  }
  // A line item's value EXACTLY as stored (no trim, "" stays ""): `value` first;
  // val/default/example only when `value` is absent. An object/array value is
  // carried as its JSON text (reported via notes). Returns {value, json}.
  function itemValue(it) {
    var cands = ["value", "val", "default", "example"];
    for (var i = 0; i < cands.length; i++) {
      if (!own(it, cands[i]) || it[cands[i]] === undefined) continue;
      var v = it[cands[i]];
      if (v === null) return { value: "", json: false };
      if (typeof v === "object") return { value: d2JsonText(v), json: true };
      return { value: String(v), json: false };
    }
    return { value: "", json: false };
  }
  function kvList(node, section, notes) {
    var out = [];
    if (!node) return out;
    if (Array.isArray(node)) {
      node.forEach(function (it) {
        if (!it || typeof it !== "object") return;
        var k = pickStr(it, ["key", "name", "field", "header", "param"]);
        var iv = itemValue(it);
        var v = iv.value;
        if (!k) return;
        var item = kvItem(k, v, it);
        if (iv.json) {
          // an object/array value: in a Body it is a JSON row; elsewhere JSON text
          if (section === "body" && item.kind !== "variable" && item.kind !== "jq") item.kind = "json";
          if (notes) notes.push((section || "item") + " '" + k + "' holds an object — carried as JSON text " + (v.length > 60 ? v.slice(0, 57) + "..." : v) + "; check it on the destination.");
        }
        out.push(item);
      });
    } else if (typeof node === "object") {
      Object.keys(node).forEach(function (k) {
        var v = node[k];
        var val = (typeof v === "string" || typeof v === "number") ? String(v) : JSON.stringify(v);
        out.push(kvItem(k, val, null));
      });
    }
    return out;
  }
  function extractToolParts(tool) {
    var raw = (tool && tool.raw) || tool || {};
    var cfg = (raw && raw.config) || raw || {};
    var itemNotes = [];
    var headers = kvList(findValue(cfg, ["headers", "header", "request_headers"]), "header", itemNotes);
    var query = kvList(findValue(cfg, ["query", "query_params", "queryparams", "params"]), "query", itemNotes);
    var pathp = kvList(findValue(cfg, ["path", "path_params", "pathparams"]), "path", itemNotes);
    // Body is an array of key/value LINE ITEMS (each static or variable), same as
    // headers — not a JSON blob.
    var body = kvList(findValue(cfg, ["body", "request_body", "requestbody", "payload", "body_schema"]), "body", itemNotes);
    var name = (tool && tool.name) || pickStr(raw, ["tool_name", "name", "label"]);
    return {
      name: name,
      method: ((tool && tool.method) || pickStr(cfg, ["method", "http_method"]) || "POST").toUpperCase(),
      url: (tool && tool.url) || pickStr(cfg, ["url", "api_url", "apiurl", "endpoint"]),
      headers: headers, query: query, path: pathp, body: body,
      notes: itemNotes.map(function (n) { return "Tool '" + (name || "(unnamed)") + "': " + n; })
    };
  }

  // The 2-field dashboard marks a tool URL without a scheme ("google.com") as
  // invalid and refuses the tool (live 2026-11-03, send_payment_link). Prefix
  // https:// when there is no scheme; anything with "<scheme>://" is left as is,
  // and so is a URL that starts with a template/variable marker ({, $, <) since
  // its scheme may come from that variable. Returns { url, added }.
  // A path-only URL ("/api/v1/x") or a scheme typo ("http:/x") is left exactly
  // as it is (no https:// guess) with `warn` set, so the caller can say so.
  function dash2ToolUrl(u) {
    var s = String(u == null ? "" : u).trim();
    if (!s || /^[a-z][a-z0-9+.\-]*:\/\//i.test(s) || /^[{$<]/.test(s)) return { url: u, added: false };
    if (/^\/(?!\/)/.test(s)) return { url: u, added: false, warn: "has no host (a path only)" };
    if (/^[a-z][a-z0-9+.\-]*:\/(?!\/)/i.test(s)) return { url: u, added: false, warn: "looks malformed (scheme without //)" };
    return { url: "https://" + s.replace(/^\/\//, ""), added: true };
  }
  function dash2ToolUrlWarnNote(name, url, warn) {
    return "Tool '" + (name || "(unnamed)") + "': URL " + url + " " + warn + " — left as is; set the full URL on the destination.";
  }
  function dash2ToolUrlNote(name, from, to) {
    return "Tool '" + (name || "(unnamed)") + "': URL had no scheme — https:// added (" + from + " → " + to + ").";
  }

  // JQ on the 2-field dashboard (confirmed live 2026-11-02 with send_payment_link):
  // a JQ row's input is the variables object itself, so a variable is `.total_due`,
  // not `.custom_args.total_due` (the server rejects that with "references
  // undeclared variable(s): [custom_args]"). Variable rows keep custom_args.<name>.
  // The JQ field also takes the bare expression: no surrounding backticks (those
  // only appear in the JSON-editor/cURL view) -- they fail with 'unexpected token "`"'.
  //
  // Rules (code only -- never text inside a "string literal"; the code inside a
  // string interpolation "...\(code)..." IS code):
  //   .custom_args.x / .custom_args?.x / .custom_args."k" / .custom_args.["k"] -> .x / ."k" / .["k"]
  //   .custom_args["k"] -> .["k"]          bare .custom_args (the whole object) -> .
  // Only a ROOT path is rewritten: one preceded by start, space or an operator /
  // opening bracket -- never by an identifier, ], ), ", ? or a string (that makes
  // it a nested field of something else: .a.custom_args.x, .a?.custom_args.x,
  // ."k".custom_args.x stay as they are).
  // Only the ROOT custom_args is stripped, once. When what follows is itself a
  // field named custom_args (.custom_args.custom_args.x, a variable really named
  // custom_args) it is written .["custom_args"].x, which means the same in jq and
  // is never rewritten again -- so applying jqForDash2 twice is harmless.
  // Returns { value, changed, rewrote: number of custom_args paths rewritten }.
  function jqMask(v) {
    // Same-length copy of v in which string-literal text is \u0001 (quotes kept
    // as ") while interpolation code inside strings is kept verbatim.
    var m = v.split(""), i = 0, n = v.length;
    function code(stopAtParen) {
      var depth = 0;
      while (i < n) {
        var c = v.charAt(i);
        if (c === "\"") { str(); continue; }
        if (stopAtParen) {
          if (c === "(") depth++;
          else if (c === ")") { if (depth === 0) return; depth--; }
        }
        i++;
      }
    }
    function str() {
      i++;   // opening quote stays "
      while (i < n) {
        var c = v.charAt(i);
        if (c === "\\" && v.charAt(i + 1) === "(") {
          m[i] = "\u0001"; i += 2;          // "(" stays: interpolation starts like a group
          code(true);
          if (i < n) i++;                   // closing ")" stays
          continue;
        }
        if (c === "\\") { m[i] = "\u0001"; if (i + 1 < n) m[i + 1] = "\u0001"; i += 2; continue; }
        if (c === "\"") { i++; return; }
        m[i] = "\u0001"; i++;
      }
    }
    code(false);
    return m.join("");
  }
  function jqForDash2(expr) {
    var v = String(expr == null ? "" : expr).trim();
    var orig = v;
    if (v.length > 1 && v.charAt(0) === "`" && v.charAt(v.length - 1) === "`") v = v.slice(1, -1).trim();
    var mask = jqMask(v);
    var re = /(^|[^A-Za-z0-9_\]\)'$"?.\u0001])\.custom_args(?![A-Za-z0-9_])(\?)?/g, mm, edits = [];
    while ((mm = re.exec(mask))) {
      var start = mm.index + mm[1].length, end = mm.index + mm[0].length;
      var next = mask.charAt(end);
      if (next === "." && /^\.custom_args(?![A-Za-z0-9_])/.test(mask.slice(end))) {
        // .custom_args.custom_args... -> .["custom_args"]...
        edits.push({ s: start, e: end + 12, t: ".[\"custom_args\"]" });
        re.lastIndex = end + 12;
      } else if (next === ".") {
        edits.push({ s: start, e: end, t: "" });     // keep the following "."
      } else {
        edits.push({ s: start, e: end, t: "." });    // "[" follows, or the whole object
      }
    }
    for (var k = edits.length - 1; k >= 0; k--) v = v.slice(0, edits[k].s) + edits[k].t + v.slice(edits[k].e);
    return { value: v, changed: v !== orig, rewrote: edits.length };
  }

  // ------------------------------------------------------------------ bot name/id
  function botIdentity(agentRaw) {
    // Identity must read TOP-LEVEL fields only: a deep-search for "name" would
    // grab a nested custom-variable's name (e.g. "callee_name") instead of the
    // bot's own name. Shallow-pick on the unwrapped agent object.
    var a = unwrap(agentRaw) || agentRaw || {};
    // Real Dash5 envelope nests the agent under agents:[{...}].
    if (a && a.agents && Array.isArray(a.agents) && a.agents[0]) a = a.agents[0];
    else if (a && a.agents && typeof a.agents === "object") a = a.agents;
    function shallow(cands) {
      if (!a || typeof a !== "object") return "";
      for (var i = 0; i < cands.length; i++) {
        var v = a[cands[i]];
        if (typeof v === "string" && v.trim()) return v.trim();
        if (typeof v === "number") return String(v);
      }
      return "";
    }
    return {
      botId: shallow(["id", "agent_id", "agentId", "agentid", "uuid", "_id"]),
      botName: shallow(["agent_display_name", "name", "agent_name", "agentName", "agentname", "title", "display_name", "displayName"])
    };
  }

  // Tool cURLs and webhook URLs may carry API keys / tokens / Basic-auth headers
  // verbatim, so any exported tool or webhook marks the file as credential-bearing.
  function hasCredentials(tools, webhooks) {
    return PHASES.some(function (p) { return ((tools || {})[p] || []).length; }) ||
      ((webhooks || []).length > 0);
  }

  // ============================================================ 2-field SOURCE
  // Export from the 2-field dashboard. Its app authenticates with a bearer token,
  // so the plugin never calls the API: it reads the app's own responses captured
  // by interceptor.js (opts.captureMeta = [{url, data}]). Shapes: see
  // DASH2-SOURCE-SCHEMA.md; the output follows DASH2-SOURCE-CONTRACT.md.
  var DASH2_EVENT_LABEL = {
    "webhook.transcript.ready": "Transcript ready",
    "webhook.recording.ready": "Recording ready",
    "webhook.analysis.completed": "Analysis completed"
  };
  var TRIGGER_PHASE = { PRE_CALL: "pre_call", ON_CALL: "on_call", POST_CALL: "post_call" };

  function isObj(o) { return !!o && typeof o === "object" && !Array.isArray(o); }
  function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }
  function strOr(v) { return (typeof v === "string") ? v.trim() : (typeof v === "number" ? String(v) : ""); }

  // Normalised list of {url, data} entries. Un-tagged captures (no url, so no
  // bot id to filter on) are only a FALLBACK: they go first, so any url-tagged
  // response of the same kind (later entries win) always overrides them.
  function d2Entries(opts) {
    var tagged = [], seen = new Set(), untagged = [];
    (Array.isArray(opts.captureMeta) ? opts.captureMeta : []).forEach(function (m) {
      if (m && typeof m === "object" && m.data && typeof m.data === "object") { tagged.push({ url: String(m.url || ""), data: m.data }); seen.add(m.data); }
    });
    (Array.isArray(opts.captures) ? opts.captures : []).forEach(function (c) {
      if (!c || typeof c !== "object" || seen.has(c)) return;   // already tagged
      untagged.push({ url: "", data: c });
    });
    return untagged.concat(tagged);
  }
  function urlPath(u) { return String(u || "").split(/[?#]/)[0]; }
  function urlParam(u, name) {
    var m = String(u || "").match(new RegExp("[?&]" + name + "=([^&#]*)", "i"));
    return m ? decodeURIComponent(m[1]) : "";
  }
  // /v1/voiceagents/<id> with no further path (not compatible-voices / language-catalog).
  function d2AgentUrlId(u) {
    var m = urlPath(u).match(/\/v1\/voiceagents\/([^\/]+)\/?$/i);
    if (!m || /^(compatible-voices|language-catalog)$/i.test(m[1])) return "";
    return m[1];
  }
  function d2LooksLikeAgent(a) {
    return isObj(a) && ("variable_schema" in a || "agent_config" in a || "analysis_schema" in a ||
      ("system_prompt" in a && "opening_line" in a));
  }
  function d2PickAgent(entries, botId) {
    var cands = [];
    entries.forEach(function (e) {
      var a = isObj(e.data) && isObj(e.data.data) ? e.data.data : null;
      if (!a) return;
      if (e.url ? d2AgentUrlId(e.url) : d2LooksLikeAgent(a)) cands.push({ agent: a, urlId: e.url ? d2AgentUrlId(e.url) : "" });
    });
    if (!cands.length) return null;
    var want = String(botId == null ? "" : botId).trim().toLowerCase();
    if (want) {
      // this bot only -- never another bot's data (the caller says "not loaded yet")
      for (var i = cands.length - 1; i >= 0; i--) {
        var aid = String(cands[i].agent.id == null ? "" : cands[i].agent.id).trim().toLowerCase();
        if (aid === want || (!aid && String(cands[i].urlId).toLowerCase() === want)) return cands[i].agent;
      }
      return null;
    }
    return cands[cands.length - 1].agent;   // newest
  }
  var BOT_NOT_LOADED = "This bot's data hasn't loaded yet — reload the page and try again.";
  // The bot id in a /v1/<kind>/<id> url ("" when absent).
  function d2UrlBotId(u, kind) {
    var m = urlPath(u).match(new RegExp("/v1/" + kind + "/([^/]+)/?$", "i"));
    return m ? m[1] : "";
  }
  function d2SameBot(u, kind, botId) {
    var id = d2UrlBotId(u, kind);
    return !id || !botId || String(id).trim().toLowerCase() === String(botId).trim().toLowerCase();
  }

  // Deep-search every capture for an object with this id; return it (or null).
  function d2FindById(entries, id) {
    if (!id) return null;
    var hit = null, seen = new Set();
    function visit(node, depth) {
      if (hit || node == null || typeof node !== "object" || depth > 10) return;
      if (seen.has(node)) return; seen.add(node);
      if (Array.isArray(node)) { for (var i = 0; i < node.length && !hit; i++) visit(node[i], depth + 1); return; }
      if (String(node.id) === String(id) && (node.name || node.display_name || node.label || node.model_name || node.voice_name)) { hit = node; return; }
      // compatible-voices items carry no "id" — their key is tts_voice_id. The
      // agent itself also has a tts_voice_id (and a name), so it never counts.
      // A voice item may carry its own (e.g. numeric) id as well: match tts_voice_id either way.
      if (node.tts_voice_id != null && String(node.tts_voice_id) === String(id) &&
          (node.display_name || node.voice_id || node.voice_name) && !("agent_config" in node) && !("system_prompt" in node)) { hit = node; return; }
      Object.keys(node).forEach(function (k) { visit(node[k], depth + 1); });
    }
    entries.forEach(function (e) { visit(e.data, 0); });
    return hit;
  }
  function d2Name(o) {
    if (!o) return "";
    return strOr(o.display_name) || strOr(o.name) || strOr(o.label) || strOr(o.model_name) || strOr(o.voice_name);
  }
  function d2Provider(entries, o) {
    if (!o) return "";
    if (isObj(o.provider)) return d2Name(o.provider);
    var p = strOr(o.provider_display_name) || strOr(o.provider_name) || strOr(o.provider);
    if (p) return p;
    return d2Name(d2FindById(entries, o.provider_id));
  }
  function d2Model(o) {
    if (!o) return "";
    if (isObj(o.model)) return d2Name(o.model);
    return strOr(o.model_name) || strOr(o.model) || strOr(o.model_id);
  }

  // {Key:{type,value}} -> [{key, value, type}] in the raw shape the importer reads.
  // LIVE 2026-11-03: a Body "JSON Row" is stored as the BARE parsed JSON value
  // (config.body = {"payload": {"n":1}}), with no {type,value} wrapper, while
  // every other row is {"Key":{"type":"static"|"variable"|"jq","value":"..."}}.
  // So only an object of exactly {type: static|variable|jq, value: <string>} is
  // a wrapped row; ANY other value is a JSON row whose content is that value.
  var D2_ROW_TYPES = /^(static|variable|jq)$/;
  // In a Body, any value other than exactly {type, value} is a JSON row (live
  // shape above). Headers / query have no JSON rows, so there a wrapped row that
  // carries extra metadata (an id, ...) is still read as its {type, value} when
  // type is static|variable|jq (the extra fields are noted).
  function d2IsWrapped(r, allowExtra) {
    if (!isObj(r)) return false;
    return own(r, "type") && own(r, "value") && (allowExtra || Object.keys(r).length === 2) &&
      typeof r.type === "string" && D2_ROW_TYPES.test(norm(r.type)) && typeof r.value === "string";
  }
  function d2ExtraFields(r) { return Object.keys(r).filter(function (k) { return k !== "type" && k !== "value"; }); }
  function d2EmptyKeyNote(label) {
    return label + " row with an empty key (no name) — not ported; add it by hand on the destination if it is needed.";
  }
  // Shaped like a wrapper ({type,value} only) but not a known row type: most
  // likely bare JSON that happens to use those keys -- carried as JSON, noted.
  function d2LooksWrapped(r) {
    if (!isObj(r)) return false;
    var ks = Object.keys(r);
    return ks.length === 2 && ks.indexOf("type") !== -1 && ks.indexOf("value") !== -1 && typeof r.type === "string";
  }
  function d2JsonText(v) {
    if (typeof v === "string") return v;
    try { var s = JSON.stringify(v); return s === undefined ? "null" : s; } catch (e) { return String(v); }
  }
  function d2PushTyped(out, key, type, val) {
    if (type === "static" || !type) out.push({ key: key, value: val, type: "static" });
    else if (type === "variable") {
      var name = val.trim().replace(/^\{\{\s*|\s*\}\}$/g, "");
      out.push({ key: key, value: /^custom_args\./.test(name) ? name : "custom_args." + name, type: "variable" });
    } else if (type === "jq") out.push({ key: key, value: val, type: "jq" });
    else return false;
    return true;
  }
  function d2Rows(node, label, notes, isBody) {
    var out = [];
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
      // list form [{key, type, value}] (not what the API returns today; kept tolerant)
      node.filter(isObj).forEach(function (r) {
        var key = strOr(r.key) || strOr(r.name);
        if (!key) { notes.push(d2EmptyKeyNote(label)); return; }
        var type = norm(r.type);
        var v = r.value;
        if (type === "json") { out.push({ key: key, value: d2JsonText(v), type: "json" }); return; }
        var val = (v == null) ? "" : (typeof v === "string" ? v : (typeof v === "object" ? JSON.stringify(v) : String(v)));
        if (!d2PushTyped(out, key, type, val)) {
          out.push({ key: key, value: val, type: type });
          notes.push(label + " row '" + key + "' has type " + type + " — kept as-is; check it on the destination.");
        }
      });
      return out;
    }
    Object.keys(node).forEach(function (key) {
      if (!key.trim()) { notes.push(d2EmptyKeyNote(label)); return; }
      var r = node[key];
      if (d2IsWrapped(r, !isBody)) {
        d2PushTyped(out, key, norm(r.type), r.value);
        var extra = d2ExtraFields(r);
        if (extra.length) notes.push(label + " row '" + key + "' has extra field(s) " + extra.join(", ") +
          " — read as a " + norm(r.type) + " row; the extra fields are not ported.");
        return;
      }
      // a JSON row: the stored value IS the JSON (object, array, string, number, ...)
      var text; try { text = JSON.stringify(r); } catch (e) { text = undefined; }
      out.push({ key: key, value: text === undefined ? "null" : text, type: "json" });
      if (d2LooksWrapped(r))
        notes.push(label + " row '" + key + "' looks like a row of unknown type '" + r.type +
          "' — carried as a JSON row with exactly that content; check it on the destination.");
    });
    return out;
  }

  // URL path segments (config.path): a list (or a {name: row} map) of plain
  // strings or {type, value} rows. A static row is its text; a variable row is
  // carried as {{name}} (noted); anything else is never stringified into the
  // URL ("[object Object]") -- it is left out and noted.
  function d2PathSegs(path, label, notes) {
    var list = Array.isArray(path) ? path
             : isObj(path) ? Object.keys(path).map(function (k) { return path[k]; })
             : (path == null || path === "") ? [] : [path];
    var segs = [];
    list.forEach(function (s) {
      if (s == null) return;
      if (typeof s === "string" || typeof s === "number") {
        var x = String(s).replace(/^\/+|\/+$/g, "");
        if (x) segs.push(x);
        return;
      }
      if (isObj(s) && typeof s.type === "string" && typeof s.value === "string") {
        var ty = norm(s.type), val = s.value.trim();
        if (ty === "static") { val = val.replace(/^\/+|\/+$/g, ""); if (val) segs.push(val); return; }
        if (ty === "variable") {
          var nm = val.replace(/^\{\{\s*|\s*\}\}$/g, "").replace(/^custom_args\./, "");
          if (nm) {
            segs.push("{{" + nm + "}}");
            notes.push(label + ": URL path segment '" + nm + "' is a variable — carried as {{" + nm + "}} in the URL; check it on the destination.");
          }
          return;
        }
        notes.push(label + ": URL path segment of type " + ty + " (" + val + ") can't be written into the URL — not ported; add it on the destination.");
        return;
      }
      notes.push(label + ": URL path segment " + d2JsonText(s) + " is not text — not ported; add it on the destination.");
    });
    return segs;
  }
  // Join path segments onto a base URL, keeping any ?query / #fragment of the
  // base AFTER the path (https://h/v1?key=a + send -> https://h/v1/send?key=a).
  function d2JoinUrl(base, segs) {
    var qi = base.search(/[?#]/);
    var main = qi === -1 ? base : base.slice(0, qi), tail = qi === -1 ? "" : base.slice(qi);
    return main.replace(/\/+$/, "") + (segs.length ? "/" + segs.join("/") : "") + tail;
  }
  var PHASE_LABEL = { pre_call: "Pre-call", on_call: "On-call", post_call: "Post-call" };
  function d2Tools(entries, botId, notes, skipped) {
    // phase -> { pages: {page: tools[]}, total } built from the responses in
    // order; a newer response for the same phase + page replaces the older one,
    // and the pages are merged (by tool id) afterwards. The phase comes from the
    // url's ?trigger=, else from each tool's own trigger.
    var buckets = Object.create(null), unknown = [], unknownSeen = Object.create(null);
    function bucket(ph) { return buckets[ph] || (buckets[ph] = { pages: Object.create(null), total: null }); }
    function toolKey(t) { return isObj(t) ? (strOr(t.id) || strOr(t.tool_id) || "") : ""; }
    entries.forEach(function (e) {
      var d = isObj(e.data) && isObj(e.data.data) ? e.data.data : null;
      if (!d || !Array.isArray(d.tools)) return;
      if (e.url && !/\/v1\/tools\//i.test(e.url)) return;
      if (e.url && /\/v1\/tools\/types/i.test(e.url)) return;
      if (e.url && !d2SameBot(e.url, "tools", botId)) return;
      var page = String(urlParam(e.url, "page") || "1");
      var urlTrig = String(urlParam(e.url, "trigger") || "").toUpperCase();
      var tot = (d.total != null && String(d.total).trim() !== "" && isFinite(Number(d.total))) ? Number(d.total) : null;
      if (urlTrig) {
        if (!own(TRIGGER_PHASE, urlTrig)) return;
        var b = bucket(TRIGGER_PHASE[urlTrig]);
        b.pages[page] = d.tools;   // later captures override earlier ones
        if (tot !== null) b.total = tot;
        return;
      }
      var groups = Object.create(null);
      d.tools.forEach(function (t) {
        var tr = isObj(t) ? String(t.trigger || "").toUpperCase() : "";
        if (isObj(t) && !own(TRIGGER_PHASE, tr)) {
          var uk = toolKey(t) || strOr(t.name) || strOr(t.tool_name) || JSON.stringify(t).slice(0, 80);
          if (!unknownSeen[uk]) { unknownSeen[uk] = 1; unknown.push(t); }
          return;
        }
        if (!isObj(t)) return;
        (groups[TRIGGER_PHASE[tr]] = groups[TRIGGER_PHASE[tr]] || []).push(t);
      });
      Object.keys(groups).forEach(function (ph) { bucket(ph).pages[page] = groups[ph]; });
    });
    unknown.forEach(function (t) {
      skipped.push({ phase: "", name: strOr(t.name) || strOr(t.tool_name), toolType: t.tool_type || "HTTP",
                     why: "its phase (trigger " + JSON.stringify(t.trigger == null ? "" : t.trigger) + ") is unknown" });
    });
    var newest = Object.create(null);
    PHASES.forEach(function (phase) {
      var b = buckets[phase];
      if (!b) return;
      var pageKeys = Object.keys(b.pages).sort(function (x, y) {
        var nx = Number(x), ny = Number(y);
        return (isFinite(nx) && isFinite(ny)) ? nx - ny : (x < y ? -1 : x > y ? 1 : 0);
      });
      var merged = [], ids = Object.create(null);
      pageKeys.forEach(function (pk) {
        (b.pages[pk] || []).forEach(function (t) {
          var id = toolKey(t);
          if (id) { if (ids[id]) return; ids[id] = 1; }
          merged.push(t);
        });
      });
      var objs = merged.filter(isObj).length;
      if (b.total !== null && objs < b.total)
        notes.push(PHASE_LABEL[phase] + " tools: only " + objs + " of " + b.total + " were captured (the list has more pages) — " +
          "page through the " + PHASE_LABEL[phase] + " tools list so every page loads, then export again.");
      // execution order first (stable; tools without one keep their place after the ordered ones)
      newest[phase] = merged.map(function (t, i) {
        var eo = isObj(t) ? t.execution_order : null;
        var n = (eo === null || eo === undefined || eo === "" || typeof eo === "boolean" || !isFinite(Number(eo))) ? Infinity : Number(eo);
        return { t: t, i: i, n: n };
      }).sort(function (a, b2) { return a.n === b2.n ? a.i - b2.i : (a.n < b2.n ? -1 : 1); })
        .map(function (x) { return x.t; });
    });
    var byPhase = { pre_call: [], on_call: [], post_call: [] };
    PHASES.forEach(function (phase) {
      (newest[phase] || []).forEach(function (t) {
        if (!isObj(t)) return;
        var name = strOr(t.name) || strOr(t.tool_name);
        var tt = norm(t.tool_type);
        if (tt && !isHttpType(tt) && !isApiType(tt)) {
          skipped.push({ phase: phase, name: name, toolType: t.tool_type });
          return;
        }
        var cfg = isObj(t.config) ? t.config : {};
        var base = strOr(cfg.base_url) || strOr(cfg.url);
        if (!base) {
          skipped.push({ phase: phase, name: name, toolType: t.tool_type || "HTTP", why: "API tool, but no URL was found in its settings" });
          return;
        }
        var label = "Tool '" + (name || "(unnamed)") + "'";
        var segs = d2PathSegs(cfg.path, label, notes);
        var url = d2JoinUrl(base, segs);
        var method = (strOr(cfg.method) || "POST").toUpperCase();
        var enabled = t.enabled !== false;
        var om = isObj(t.output_mapping) ? t.output_mapping : {};
        if (Object.keys(om).length) notes.push(label + ": has an output mapping — kept as-is; check it on the destination.");
        byPhase[phase].push({
          phase: phase, name: name, method: method, url: url, enabled: enabled,
          raw: {
            tool_name: name, tool_type: "API_TOOL", tool_phase: phase, is_enabled: enabled,
            execution_order: t.execution_order, timeout_ms: cfg.timeout, output_mapping: clone(om),
            config: {
              url: url, method: method,
              headers: d2Rows(cfg.headers, label + " header", notes),
              query: d2Rows(cfg.query, label + " query", notes),
              path: [],
              body: d2Rows(cfg.body, label + " body", notes, true)
            }
          }
        });
      });
    });
    return byPhase;
  }

  function d2Events(entries, botId, notes) {
    var labels = Object.create(null);   // keyed by event value: "constructor" etc. are ordinary
    Object.keys(DASH2_EVENT_LABEL).forEach(function (k) { labels[k] = DASH2_EVENT_LABEL[k]; });
    var hooks = null, hookHeaders = false;
    entries.forEach(function (e) {
      var d = isObj(e.data) && isObj(e.data.data) ? e.data.data : null;
      if (!d) return;
      if (Array.isArray(d.events) && (!e.url || /\/v1\/webhook-events/i.test(e.url))) {
        d.events.forEach(function (ev) { if (isObj(ev) && ev.value && ev.label) labels[ev.value] = String(ev.label); });
      }
      if (Array.isArray(d.webhooks) && (!e.url || (/\/v1\/webhooks\//i.test(e.url) && d2SameBot(e.url, "webhooks", botId)))) hooks = d.webhooks;
    });
    var out = [];
    (hooks || []).forEach(function (w) {
      if (!isObj(w) || !strOr(w.url)) return;
      var nm = strOr(w.name);
      var evs = (Array.isArray(w.events) ? w.events : []).map(function (v) {
        v = String(v);
        if (labels[v]) return labels[v];
        notes.push("Webhook '" + (nm || w.url) + "': unknown event " + v + " — kept as-is.");
        return v;
      });
      if (isObj(w.headers) && Object.keys(w.headers).length) {
        hookHeaders = true;
        notes.push(webhookHeaderNote({ name: nm, url: w.url, headerCount: Object.keys(w.headers).length }));
      }
      out.push({ url: strOr(w.url), method: (strOr(w.method) || "POST").toUpperCase(), name: nm, events: evs });
    });
    return { events: out, hasHeaders: hookHeaders };
  }

  function d2Analysis(agent, notes) {
    var sch = isObj(agent.analysis_schema) ? agent.analysis_schema : {};
    var props = isObj(sch.properties) ? sch.properties : {};
    var req = Array.isArray(sch.required) ? sch.required.map(String) : [];
    var keys = Object.keys(props).map(function (name) {
      var p = props[name], t = isObj(p) ? p.type : p, type;
      var n = typeof t === "string" ? norm(t) : "";
      if (n === "string") type = "String";
      else if (n === "number" || n === "integer") type = "Number";
      else if (n === "boolean") type = "Boolean";
      else if (n === "array" && (!isObj(p.items) || p.items.type == null || norm(p.items.type) === "string")) type = "String[]";
      else {
        type = "String";
        var desc = n === "array" ? "array of " + JSON.stringify(p.items && p.items.type) : JSON.stringify(t);
        notes.push("Analysis key '" + name + "': type " + desc + " not recognised — exported as String; check it on the destination.");
      }
      return { name: name, type: type, required: req.indexOf(name) !== -1 };
    });
    return { prompt: typeof agent.analysis_prompt === "string" ? agent.analysis_prompt : "", keys: keys };
  }

  // {id, provider, model|name} for an environment-specific model id: screen names first, then captures.
  function d2Resolve(entries, id, ui, label, notes, nameField) {
    var o = d2FindById(entries, id);
    var provider = (ui && strOr(ui.provider)) || d2Provider(entries, o);
    var model = (ui && (strOr(ui.model) || strOr(ui.name))) || d2Name(o) || d2Model(o);
    if (id && (!provider || !model))
      notes.push(label + " name not captured (id " + id + ") — open the " + label + " settings tab before exporting, or set it by hand on the destination.");
    var r = { id: id || "", provider: provider };
    r[nameField || "model"] = model;
    return r;
  }

  function buildConfigDash2(opts) {
    var entries = d2Entries(opts);
    var agent = d2PickAgent(entries, opts.botId);
    if (!agent && strOr(opts.botId) && d2PickAgent(entries, "")) return { ok: false, reason: BOT_NOT_LOADED };
    if (!agent) return { ok: false, reason: "No 2-field bot data captured yet — open the bot so it loads, then try again." };
    var uiNames = isObj(opts.uiNames) ? opts.uiNames : {};
    var botId = strOr(opts.botId) || strOr(agent.id);
    var notes = [], skipped = [];

    // Variables (REQ-1: the complete variable_schema list)
    var vars = [], seenVar = Object.create(null);
    (Array.isArray(agent.variable_schema) ? agent.variable_schema : []).forEach(function (v) {
      var name = isObj(v) ? (strOr(v.key) || strOr(v.name)) : strOr(v);
      if (!name || seenVar[name]) return; seenVar[name] = 1;
      var t = isObj(v) ? norm(v.type) : "";
      var type = t === "date" ? "Date" : "String";
      if (t && t !== "date" && t !== "string")
        notes.push("Variable '" + name + "': type " + v.type + " not recognised — exported as String.");
      vars.push({ name: name, type: type });
    });

    var ac = isObj(agent.agent_config) ? agent.agent_config : {};

    // Language & voice
    var voice = null;
    if (strOr(agent.tts_voice_id)) {
      var vid = strOr(agent.tts_voice_id), vo = d2FindById(entries, vid), uv = isObj(uiNames.voice) ? uiNames.voice : null;
      voice = {
        id: vid,
        name: (uv && strOr(uv.name)) || d2Name(vo),
        provider: (uv && strOr(uv.provider)) || d2Provider(entries, vo),
        model: (uv && strOr(uv.model)) || d2Model(vo)
      };
      if (!voice.name) notes.push("Voice name not captured (id " + vid + ") — open Language and Voice before exporting, or pick the voice by hand on the destination.");
    }
    var sp = ac.speech_rate, speed = null;
    if (typeof sp === "number" && isFinite(sp)) speed = sp;
    else if (typeof sp === "string" && sp.trim() && isFinite(Number(sp))) speed = Number(sp);
    var lv = {
      primaryLanguage: strOr(agent.primary_language_name) || langToName(agent.primary_language),
      secondaryLanguage: strOr(agent.secondary_language_name) || langToName(agent.secondary_language),
      primaryCode: strOr(agent.primary_language),
      secondaryCode: strOr(agent.secondary_language),
      voice: voice,
      speed: speed
    };

    // Custom analysis (+ model; "" = dashboard default)
    var analysis = d2Analysis(agent, notes);
    var amId = strOr(agent.analysis_model_id);
    analysis.model = amId ? d2Resolve(entries, amId, uiNames.analysis, "Analysis model", notes, "name") : null;

    // LLM / STT
    var llmStt = {
      llm: d2Resolve(entries, strOr(agent.llm_model_id), uiNames.llm, "LLM", notes),
      stt: d2Resolve(entries, strOr(agent.stt_model_id), uiNames.stt, "STT", notes)
    };

    var tools = d2Tools(entries, botId, notes, skipped);
    var ev = d2Events(entries, botId, notes);

    var config = {
      magicport: { format: FORMAT, pluginVersion: (opts.pluginVersion || buildVersion()) },
      source: {
        platform: DASH2,
        botId: botId,
        botName: strOr(agent.name),
        url: location.href,
        host: location.host,
        exportedAt: new Date().toISOString()
      },
      containsCredentials: hasCredentials(tools, ev.events) || ev.hasHeaders,
      data: {
        promptFiles: (opts.promptFiles || []).map(function (f) { return f.name; }),
        variables: vars,
        variableCount: vars.length,
        languageVoice: lv,
        customAnalysis: analysis,
        tools: tools,
        events: ev.events,
        eventsExact: true,
        llmStt: llmStt,
        callConfig: clone(ac)
      },
      notes: notes,
      notPortable: { nonApiTools: skipped }
    };
    skipped.forEach(function (t) {
      notes.push("Tool '" + (t.name || "(unnamed)") + "' (" + (t.toolType || "non-API") +
        (t.phase ? ", " + t.phase : "") + ") " + (t.why ? "— " + t.why + " — not ported." : "is not a cURL/API tool — not ported."));
    });
    return { ok: true, config: config };
  }

  // ------------------------------------------------------------------ build config
  // promptFiles = [{name, content}] of the prompt .md files (from content.js).
  // captures    = array of captured JSON payloads (content.js `captured`).
  function buildConfig(opts) {
    opts = opts || {};
    var platform = opts.platform || hostPlatform();
    if (normPlatform(platform) === DASH2) return buildConfigDash2(opts);
    var captures = opts.captures || [];
    var botIdWanted = strOr(opts.botId);
    var agent = opts.agent || pickAgent(captures, botIdWanted);
    if (!agent && botIdWanted && pickAgent(captures, "")) return { ok: false, reason: BOT_NOT_LOADED };
    if (!agent) return { ok: false, reason: "No source bot data captured yet — open the bot and try again." };

    var ident = botIdentity(agent);
    agent = activeVersionView(agent);   // several versions: export the ACTIVE one
    var vars = extractVariables(agent);
    var lv = extractLanguageVoice(agent);
    var analysis = extractAnalysis(agent);
    var webhooks = extractWebhooks(agent);
    var tools = extractTools(agent);
    var skippedTools = tools._skipped || [];
    // additional_languages (3rd+ beyond primary/secondary) is intentionally not
    // captured — Raj: "no need to capture this" (spec = primary + secondary only).

    var containsCredentials = hasCredentials(tools, webhooks);

    var config = {
      magicport: { format: FORMAT, pluginVersion: (opts.pluginVersion || buildVersion()) },
      source: {
        platform: platform,
        botId: ident.botId,
        botName: ident.botName,
        url: location.href,
        exportedAt: new Date().toISOString()
      },
      containsCredentials: !!containsCredentials,
      data: {
        // prompt travels as the .md files in the zip; recorded here for reference
        promptFiles: (opts.promptFiles || []).map(function (f) { return f.name; }),
        variables: vars,
        languageVoice: lv,
        customAnalysis: analysis,
        tools: { pre_call: tools.pre_call, on_call: tools.on_call, post_call: tools.post_call },
        events: webhooks
      },
      notes: []
    };

    // REQ-1 self-check at export: record the count so import can verify round-trip.
    config.data.variableCount = vars.length;

    // Record items found on the source that are NOT ported, so the UI reports
    // them instead of leaving the user to wonder (non-API tools, extra langs).
    config.notPortable = {
      nonApiTools: skippedTools             // widget / callback / whatsapp / etc.
    };
    skippedTools.forEach(function (t) {
      config.notes.push("Tool '" + (t.name || "(unnamed)") + "' (" + (t.toolType || "non-API") +
        (t.phase ? ", " + t.phase : "") + ") " + (t.why ? "— " + t.why + " — not ported." : "is not a cURL/API tool — not ported."));
    });
    webhooks.forEach(function (w) { if (w.headerCount) config.notes.push(webhookHeaderNote(w)); });

    return { ok: true, config: config };
  }

  // Assemble the downloadable Magic Port ZIP: the existing prompt .md files +
  // magicport.json. Reuses PPZip.
  function buildZipFiles(config, promptFiles) {
    var files = (promptFiles || []).slice();
    files.push({ name: CONFIG_NAME, content: JSON.stringify(config, null, 2) });
    // A short, human-readable manifest so the zip is self-describing.
    files.push({
      name: "README-magicport.txt",
      content:
        "PromptPort — Magic Port export\n" +
        "Bot: " + (config.source.botName || "(unnamed)") + "  [" + layoutLabel(config.source.platform) + "]\n" +
        "Exported: " + config.source.exportedAt + "\n\n" +
        (config.containsCredentials
          ? "⚠ CONTAINS CREDENTIALS: tool cURLs and/or webhook URLs may include API keys,\n" +
            "tokens or Basic-auth headers, stored as-is. Handle this file like a secret.\n\n"
          : "") +
        "This archive holds the full bot config (magicport.json) plus the prompt\n" +
        "buckets as .md. Import it with PromptPort on the destination bot.\n"
    });
    return files;
  }

  // ------------------------------------------------------------------ validation
  // Cross-platform mapping of a parsed config for a given destination platform.
  // Returns the destination-ready data plus the flags/notes to show the user.
  function listOf(x) { return Array.isArray(x) ? x.filter(isObj) : []; }
  var NEWER_FORMAT_NOTE = "This file was made by a newer PromptPort — some settings may not import.";
  // Root .custom_args written as .["custom_args"] (same meaning in jq), so that
  // jqForDash2 leaves the expression alone. Used for a 2-field SOURCE, whose JQ
  // is already in this dashboard's form (there custom_args is a real variable name).
  function jqProtect(expr) {
    var v = String(expr == null ? "" : expr);
    var mask = jqMask(v);
    var re = /(^|[^A-Za-z0-9_\]\)'$"?.\u0001])\.custom_args(?![A-Za-z0-9_])/g, mm, at = [];
    while ((mm = re.exec(mask))) at.push(mm.index + mm[1].length);
    for (var k = at.length - 1; k >= 0; k--) v = v.slice(0, at[k]) + ".[\"custom_args\"]" + v.slice(at[k] + 12);
    return v;
  }
  // A copy of a (2-field source) tool whose JQ rows are jqProtect-ed; the tool
  // itself when none needs it (the parsed config is never modified).
  function d2ProtectJq(t) {
    var cfg = isObj(t.raw) && isObj(t.raw.config) ? t.raw.config : null;
    if (!cfg) return t;
    var secs = ["headers", "query", "path", "body"], need = secs.some(function (s) {
      return Array.isArray(cfg[s]) && cfg[s].some(function (r) { return isObj(r) && norm(r.type) === "jq" && jqForDash2(r.value).rewrote; });
    });
    if (!need) return t;
    var c = clone(t);
    secs.forEach(function (s) {
      (Array.isArray(c.raw.config[s]) ? c.raw.config[s] : []).forEach(function (r) {
        if (isObj(r) && norm(r.type) === "jq" && jqForDash2(r.value).rewrote) r.value = jqProtect(r.value);
      });
    });
    return c;
  }
  function mapForDestination(config, destPlatform) {
    destPlatform = normPlatform(destPlatform);   // accept legacy names from older builds/tests
    var notes = [];
    if (!isObj(config)) config = {};   // a damaged file maps to "nothing to import", never a crash
    var src = normPlatform(isObj(config.source) ? config.source.platform : "");
    var fmt = isObj(config.magicport) ? Number(config.magicport.format) : NaN;
    if (isFinite(fmt) && fmt > FORMAT) notes.push(NEWER_FORMAT_NOTE);
    var data = isObj(config.data) ? config.data : {};
    var lv = isObj(data.languageVoice) ? data.languageVoice : {};
    var dataTools = isObj(data.tools) ? data.tools : {};
    var dataVars = listOf(data.variables), dataEvents = listOf(data.events);
    var an0 = isObj(data.customAnalysis) ? data.customAnalysis : { prompt: "", keys: [] };
    var anKeys = listOf(an0.keys);
    // A damaged / hand-edited file: entries without a text name can't be created
    // (they would become "undefined" / "[object Object]") -- skip them, say so.
    function named(x) { return isObj(x) && typeof x.name === "string" && x.name.trim() !== ""; }
    var badVars = dataVars.filter(function (x) { return !named(x); }).length;
    var badKeys = anKeys.filter(function (x) { return !named(x); }).length;
    dataVars = dataVars.filter(named); anKeys = anKeys.filter(named);
    if (badVars) notes.push(badVars + " variable" + (badVars > 1 ? "s" : "") + " in the file had no name — skipped.");
    if (badKeys) notes.push(badKeys + " analysis key" + (badKeys > 1 ? "s" : "") + " in the file had no name — skipped.");
    var outLV = (destPlatform === DASH2)
      ? { primaryLanguage: langToName(lv.primaryLanguage), secondaryLanguage: langToName(lv.secondaryLanguage) }
      : lv;
    var out = { variables: [], languageVoice: outLV, analysis: null, tools: isObj(data.tools) ? data.tools : {}, events: [] };

    // Tools: say which JQ expressions will be adapted for this dashboard.
    if (destPlatform === DASH2) {
      // A URL with no scheme gets https:// (see dash2ToolUrl). Applied to a
      // shallow COPY of each tool (top-level .url wins in extractToolParts), so
      // the parsed config / export zip are never modified.
      var fixedTools = {};
      Object.keys(dataTools).forEach(function (ph) {
        var lst = dataTools[ph];
        if (!Array.isArray(lst)) { fixedTools[ph] = lst; return; }
        fixedTools[ph] = lst.filter(isObj).map(function (t) {
          var p0; try { p0 = extractToolParts(t); } catch (e) { return t; }
          var c = t;
          if (src === DASH2) c = d2ProtectJq(t);
          var fx = dash2ToolUrl(p0.url);
          if (fx.warn) notes.push(dash2ToolUrlWarnNote(p0.name, String(p0.url).trim(), fx.warn));
          if (!fx.added) return c;
          notes.push(dash2ToolUrlNote(p0.name, String(p0.url).trim(), fx.url));
          var c2 = {}; Object.keys(c).forEach(function (k) { c2[k] = c[k]; });
          c2.url = fx.url;
          return c2;
        });
      });
      out.tools = fixedTools;
      ["pre_call", "on_call", "post_call"].forEach(function (ph) {
        listOf(dataTools[ph]).forEach(function (t) {
          var parts; try { parts = extractToolParts(t); } catch (e) { return; }
          (parts.notes || []).forEach(function (n) { notes.push(n); });
          // A 2-field source's JQ is already in this dashboard's form: nothing is adapted.
          if (src === DASH2) return;
          var n = 0;
          ["headers", "query", "path", "body"].forEach(function (sec) {
            (parts[sec] || []).forEach(function (it) { if (it.kind === "jq" && jqForDash2(it.value).rewrote) n++; });
          });
          if (n) notes.push("Tool '" + (parts.name || "(unnamed)") + "': " + n + " JQ expression" + (n > 1 ? "s" : "") +
            " adapted for this dashboard (.custom_args.<name> → .<name>).");
        });
      });
      // Webhook settings the import can't write: headers (never ported) and a non-POST method.
      dataEvents.forEach(function (w) {
        if (w.headerCount) notes.push(webhookHeaderNote(w));
        var m = String(w.method || "POST").toUpperCase();
        if (m !== "POST") notes.push("Webhook '" + (w.name || w.url) + "': method " + m + " is not set by the import — check it on the destination.");
      });
    }

    // 2-field source -> 2-field destination: same dashboard, so no conversion at
    // all (contract): variables keep String/Date, keys keep their 4 types +
    // required, events are kept EXACTLY (no "always all 3"), and the settings
    // only this dashboard has travel through unchanged.
    if (destPlatform === DASH2 && src === DASH2) {
      var an2 = an0;
      out.languageVoice = lv;
      out.variables = dataVars.map(function (v) { return { name: v.name, type: v.type || "String" }; });
      out.analysis = {
        prompt: an2.prompt || "",
        keys: anKeys.map(function (k) { return { name: k.name, type: k.type || "String", required: k.required !== false }; }),
        model: an2.model || null
      };
      out.events = dataEvents.map(function (w) {
        return { url: w.url, method: w.method || "POST", name: w.name || "", events: (Array.isArray(w.events) ? w.events : []).slice() };
      });
      out.eventsExact = true;
      out.llmStt = data.llmStt || null;
      out.callConfig = data.callConfig || null;
      return { ok: true, data: out, notes: notes };
    }

    if (destPlatform === DASH2) {
      [lv.primaryLanguage, lv.secondaryLanguage].forEach(function (code) {
        if (langUnknownCode(code))
          notes.push("Language code " + String(code).trim() + " not recognised — carried as is; pick the language by hand on the destination.");
      });
    }

    // Variables
    dataVars.forEach(function (v) {
      if (destPlatform === DASH2) {
        // Raj (2026-10-31): Dash5 has NO type on custom variables, so on a
        // Dash2 destination they are always String. The exporter already
        // defaults to "String" when the source says nothing; this makes the
        // rule explicit rather than leaving it to a default two layers away.
        // If a source ever did carry a real type we do not drop it silently --
        // it is noted once -- but from Dash5 this cannot happen.
        var srcType = norm(v.type);
        if (srcType && srcType !== "string") {
          notes.push("Variable '" + v.name + "': source type " + v.type +
                     " ignored — custom variables on this dashboard are created as String.");
        }
        out.variables.push({ name: v.name, type: "String" });
      } else {
        out.variables.push({ name: v.name, type: v.type || "String" });
      }
    });
    // Direction rule: on a Dash2 destination, ensure mobile_number + callee_name exist.
    if (destPlatform === DASH2) {
      ["mobile_number", "callee_name"].forEach(function (n) {
        if (!out.variables.some(function (v) { return v.name === n; })) {
          out.variables.push({ name: n, type: "String" });
          notes.push("Added system variable '" + n + "' (required on this dashboard).");
        }
      });
    }

    // Custom Analysis keys
    var an = an0;
    if (destPlatform === DASH2) {
      // The 2-field dashboard's keys have no default value: list the ones that can't be carried.
      var defs = anKeys.filter(function (k) { return k.default != null && String(k.default) !== ""; })
        .map(function (k) { return k.name + " = " + JSON.stringify(String(k.default)); });
      if (defs.length) notes.push("Analysis key defaults can't be set on this dashboard — not ported: " + defs.join(", ") +
        ". Mention them in the analysis prompt if the bot relies on them.");
    }
    var keys = anKeys.map(function (k) {
      if (destPlatform === DASH2) {
        var m = mapKeyTypeDash5ToDash2(k.type);
        if (m.flagged) notes.push("Analysis key '" + k.name + "': type " + (m.from || k.type) + " -> String (" + (m.why || "no matching key type on this dashboard") + ").");
        return { name: k.name, type: m.type, required: k.required !== false };
      } else {
        var mm = mapKeyTypeDash2ToDash5(k.type);
        return { name: k.name, type: mm.type, default: k.default || "" };
      }
    });
    out.analysis = { prompt: an.prompt || "", keys: keys };

    // Events
    dataEvents.forEach(function (w) {
      var events;
      if (destPlatform === DASH2) {
        events = enforceDash2AllEvents(w.events);   // Raj: always all 3
      } else {
        events = (Array.isArray(w.events) ? w.events : []);
      }
      out.events.push({ url: w.url, method: w.method || "POST", events: events });
    });

    // Tools: phase-match; flag phases the destination can't accept (e.g. Dash2
    // QA has no Pre-Call). content.js checks live phase availability at import.
    return { ok: true, data: out, notes: notes };
  }

  // Post-import verification helpers (REQ-1 / REQ-2). content.js calls these
  // after re-reading the destination.
  function verifyVariables(expected, actualNames) {
    var missing = expected.map(function (v) { return v.name; })
      .filter(function (n) { return actualNames.indexOf(n) === -1; });
    return { ok: missing.length === 0, missing: missing,
      expectedCount: expected.length, actualCount: actualNames.length };
  }
  function verifyKeyTypes(expected, actualByName) {
    var wrong = [];
    expected.forEach(function (k) {
      var a = own(actualByName, k.name) ? actualByName[k.name] : undefined;
      if (!a) { wrong.push({ name: k.name, reason: "missing" }); return; }
      if (norm(a) !== norm(k.type)) wrong.push({ name: k.name, want: k.type, got: a });
    });
    return { ok: wrong.length === 0, wrong: wrong };
  }

  // ------------------------------------------------------------------ zip detect
  // Is a parsed set of zip entries a Magic Port archive (vs a plain prompt zip)?
  function isMagicPortZip(entryNames) {
    // Zips made on Windows may name entries with backslashes (bot\magicport.json).
    return (entryNames || []).some(function (n) { return /(^|[\/\\])magicport\.json$/i.test(String(n)); });
  }

  window.MagicPort = {
    FORMAT: FORMAT,
    CONFIG_NAME: CONFIG_NAME,
    DASH5: DASH5, DASH2: DASH2,
    normPlatform: normPlatform, layoutLabel: layoutLabel,
    hostPlatform: hostPlatform,
    // extraction
    pickAgent: pickAgent,
    buildConfig: buildConfig,
    buildZipFiles: buildZipFiles,
    // mapping / validation
    mapForDestination: mapForDestination,
    extractToolParts: extractToolParts,
    jqForDash2: jqForDash2,
    dash2ToolUrl: dash2ToolUrl,
    dash2ToolUrlNote: dash2ToolUrlNote,
    dash2ToolUrlWarnNote: dash2ToolUrlWarnNote,
    mapKeyTypeDash5ToDash2: mapKeyTypeDash5ToDash2,
    mapVarTypeDash5ToDash2: mapVarTypeDash5ToDash2,
    enforceDash2AllEvents: enforceDash2AllEvents,
    verifyVariables: verifyVariables,
    verifyKeyTypes: verifyKeyTypes,
    isMagicPortZip: isMagicPortZip,
    // exposed for tests / tuning
    _extract: {
      variables: extractVariables, languageVoice: extractLanguageVoice,
      analysis: extractAnalysis, webhooks: extractWebhooks, tools: extractTools,
      dash2: buildConfigDash2
    }
  };
})();
