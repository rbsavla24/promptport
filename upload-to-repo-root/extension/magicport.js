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

  // The dashboard layout of this page (addresses come from manifest.json via host.js).
  function hostPlatform() {
    try { return (window.PPHost && window.PPHost.layout()) || ""; } catch (e) { return ""; }
  }
  // Files exported by v4.0.0 keyed the layouts by the platform's own name; those
  // keys were 5 and 6 letters long (5-field and 2-field layout respectively).
  function normPlatform(p) {
    p = String(p || "").toLowerCase();
    if (p === DASH5 || p === DASH2 || !p) return p;
    return p.length === 5 ? DASH5 : p.length === 6 ? DASH2 : p;
  }
  function layoutLabel(p) { p = normPlatform(p); return p === DASH5 ? "5-field dashboard" : p === DASH2 ? "2-field dashboard" : "dashboard"; }

  // ------------------------------------------------------------------ type maps
  // Dash2 has TWO DIFFERENT type dropdowns (confirmed live, Raj):
  //   - Custom VARIABLES: String, Date
  //   - Custom ANALYSIS KEYS: String, Number, Boolean, String[]   (no Date)
  // Dash5 key/variable types: String, Number, Integer, Boolean, Array, Date, DateTime.
  var DASH2_VAR_TYPES = ["String", "Date"];
  var DASH2_KEY_TYPES = ["String", "Number", "Boolean", "String[]"];

  function norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }

  // Dash5 stores languages as locale CODES (ta-IN, en-IN); Dash2 uses display
  // NAMES (Tamil, English). Map by the base code.
  var LANG_CODE_NAME = {
    en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", kn: "Kannada",
    ml: "Malayalam", mr: "Marathi", bn: "Bengali", gu: "Gujarati", pa: "Punjabi",
    or: "Odia", ur: "Urdu", as: "Assamese"
  };
  var LANG_NAME_CODE = (function () { var m = {}; Object.keys(LANG_CODE_NAME).forEach(function (k) { m[norm(LANG_CODE_NAME[k])] = k; }); return m; })();
  function langToName(v) {
    if (!v) return "";
    var base = String(v).split(/[-_]/)[0].toLowerCase();
    if (LANG_CODE_NAME[base]) return LANG_CODE_NAME[base];
    // already a display name?
    if (LANG_NAME_CODE[norm(v)]) return String(v);
    return String(v);
  }

  // Dash5 ANALYSIS KEY type -> Dash2 analysis key type (REQ-2 lives here).
  function mapKeyTypeDash5ToDash2(t) {
    // Normalise spelling: case, spaces, and wrappers like array<string> / list[str].
    var n = norm(t).replace(/\s+/g, "");
    if (/^(array|list)(<|\[|\()?(string|str|text)?(>|\]|\))?$/.test(n) || n === "string[]" || n === "str[]" || n === "[string]" || n === "stringarray" || n === "string_array" || n === "array_of_strings")
      return { type: "String[]", flagged: false };
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
  // webhook (see enforceDash2AllEvents). The map below is kept for fidelity /
  // Dash5-destination use.
  var DASH2_EVENTS = ["Transcript ready", "Recording ready", "Analysis completed"];
  var DASH5_TO_DASH2_EVENT = {
    "transcript_completed": "Transcript ready",
    "transcript_ready": "Transcript ready",
    "recording_completed": "Recording ready",
    "recording_ready": "Recording ready",
    "client_analysis_completed": "Analysis completed",
    "platform_analysis_completed": "Analysis completed",
    "advanced_analysis_complete": "Analysis completed",
    "analysis_completed": "Analysis completed"
  };

  function enforceDash2AllEvents(/* events */) {
    // Raj: always subscribe to all 3 on a Dash2 destination.
    return DASH2_EVENTS.slice();
  }

  // ------------------------------------------------------------- deep-search util
  // Mirrors extract.js findInObject: deep-walk, first non-empty value whose
  // normalized key matches a wanted candidate (earlier candidates win).
  function nk(k) { return String(k == null ? "" : k).toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function findValue(obj, wanted) {
    var wset = wanted.map(nk), best = null, seen = [];
    (function visit(node, depth) {
      if (node == null || typeof node !== "object" || depth > 8) return;
      if (seen.indexOf(node) !== -1) return; seen.push(node);
      if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) visit(node[i], depth + 1); return; }
      Object.keys(node).forEach(function (k) {
        var rank = wset.indexOf(nk(k));
        if (rank !== -1) {
          var v = node[k];
          var has = (typeof v === "string" && v.trim()) ||
                    (Array.isArray(v) && v.length) ||
                    (v && typeof v === "object" && Object.keys(v).length) ||
                    (typeof v === "number") || (typeof v === "boolean");
          if (has && (best === null || rank < best.rank)) best = { rank: rank, value: v };
        }
        visit(node[k], depth + 1);
      });
    })(obj, 0);
    return best ? best.value : null;
  }

  // Pick the first present string field from an object by candidate names.
  function pickStr(o, cands) {
    if (!o || typeof o !== "object") return "";
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

  // Of several captured payloads, choose the richest agent-looking one.
  function pickAgent(captures) {
    var list = Array.isArray(captures) ? captures : (captures ? [captures] : []);
    var best = null, bestScore = -1;
    list.forEach(function (c) {
      var a = unwrap(c);
      if (!a || typeof a !== "object") return;
      // Captures normally come from JSON.parse (never circular), but guard anyway
      // so one odd payload can't throw and abort the whole export.
      var json = ""; try { json = JSON.stringify(a); } catch (e) { json = ""; }
      var s = json.length;
      var lower = json.toLowerCase();
      var k = Object.keys(a).map(nk).join(",");
      var score = 0;
      ["objective", "firstmessage", "variable", "voice", "language", "analysis", "webhook", "tool"].forEach(function (w) {
        if (k.indexOf(nk(w)) !== -1 || lower.indexOf(w) !== -1) score += s;
      });
      if (score > bestScore) { bestScore = score; best = a; }
    });
    return best;
  }

  // ------------------------------------------------------------------ extractors
  // ---- 2. Custom Variables (REQ-1: ALL of them) ---------------------------
  // CONFIRM@TEST candidate container & item field names against live JSON.
  function extractVariables(agent) {
    var arr = findValue(agent, [
      "custom_variables", "customvariables", "variables", "dynamic_variables",
      "dynamicvariables", "call_variables", "template_variables"
    ]);
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
      // name -> type map form
      Object.keys(arr).forEach(function (name) {
        var v = arr[name];
        var type = (v && typeof v === "object") ? (pickStr(v, ["type", "data_type"]) || "String")
                 : (typeof v === "string" ? "String" : "String");
        out.push({ name: String(name).trim(), type: type });
      });
    }
    // de-dupe by name, keep first
    var seen = {}, dedup = [];
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
  function extractAnalysis(agent) {
    // Real Dash5 shape: custom_analysis_prompt = { prompt, keys:{name:type}, defaults:{name:val} }.
    var node = findValue(agent, [
      "custom_analysis_prompt", "customanalysisprompt",
      "advanced_analysis", "post_call_analysis", "custom_analysis", "analysis"
    ]);
    var scope = (node && typeof node === "object" && !Array.isArray(node)) ? node : agent;
    var prompt = pickStr(scope, ["prompt", "analysis_prompt", "analysisprompt", "system_prompt", "instructions"]);
    var keysSrc = findValue(scope, [
      "keys", "required_keys", "requiredkeys", "schema", "fields", "data_points", "datapoints", "extraction_schema"
    ]);
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
          if (name) keys.push({ name: name, type: type, required: req === false ? false : true, default: def });
        }
      });
    } else if (keysSrc && typeof keysSrc === "object") {
      // name -> type MAP (the real Dash5 shape); defaults is a parallel name -> value map.
      Object.keys(keysSrc).forEach(function (name) {
        var v = keysSrc[name];
        var type = (typeof v === "string") ? v : ((v && typeof v === "object") ? (pickStr(v, ["type", "data_type"]) || "String") : "String");
        var def = (defaults && typeof defaults === "object" && defaults[name] != null) ? String(defaults[name]) : "";
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
    ]);
    var out = [];
    if (Array.isArray(arr)) {
      arr.forEach(function (w) {
        if (!w || typeof w !== "object") return;
        var url = pickStr(w, ["callback_url", "callbackurl", "url", "webhook_url", "webhookurl", "endpoint"]);
        var method = (pickStr(w, ["method_type", "method", "http_method"]) || "POST").toUpperCase();
        var evs = findValue(w, ["event_type", "events", "event_types", "eventtypes", "subscribed_events"]);
        var events = [];
        if (Array.isArray(evs)) evs.forEach(function (e) {
          if (typeof e === "string") events.push(e.trim());
          else if (e && typeof e === "object") { var en = pickStr(e, ["name", "event", "type", "key"]); if (en) events.push(en); }
        });
        if (url) out.push({ url: url, method: method, events: events });
      });
    }
    return out;
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
  function toolUrl(t) {
    var cfg = (t && t.config) || {};
    var u = pickStr(cfg, ["url", "api_url", "endpoint"]) || pickStr(t || {}, ["url", "api_url", "endpoint"]);
    if (!u) { var deep = findValue(t || {}, ["url", "api_url", "endpoint", "request_url"]); if (typeof deep === "string") u = deep.trim(); }
    return u || "";
  }
  function isApiTool(t) {
    var tt = norm(t && (t.tool_type || t.type));
    if (tt) return isApiType(tt);
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
      var arr = findValue(agent, [TOOL_FIELD[phase]]);
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
          enabled: findValue(t, ["is_enabled"]) !== false,
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
  function kvList(node) {
    var out = [];
    if (!node) return out;
    if (Array.isArray(node)) {
      node.forEach(function (it) {
        if (!it || typeof it !== "object") return;
        var k = pickStr(it, ["key", "name", "field", "header", "param"]);
        var v = pickStr(it, ["value", "val", "default", "example"]);
        if (k) out.push(kvItem(k, v, it));
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
    var headers = kvList(findValue(cfg, ["headers", "header", "request_headers"]));
    var query = kvList(findValue(cfg, ["query", "query_params", "queryparams", "params"]));
    var pathp = kvList(findValue(cfg, ["path", "path_params", "pathparams"]));
    // Body is an array of key/value LINE ITEMS (each static or variable), same as
    // headers — not a JSON blob.
    var body = kvList(findValue(cfg, ["body", "request_body", "requestbody", "payload", "body_schema"]));
    return {
      name: (tool && tool.name) || pickStr(raw, ["tool_name", "name", "label"]),
      method: ((tool && tool.method) || pickStr(cfg, ["method", "http_method"]) || "POST").toUpperCase(),
      url: (tool && tool.url) || pickStr(cfg, ["url", "api_url", "apiurl", "endpoint"]),
      headers: headers, query: query, path: pathp, body: body
    };
  }

  // JQ on the 2-field dashboard (confirmed live 2026-11-02 with send_payment_link):
  // a JQ row's input is the variables object itself, so a variable is `.total_due`,
  // not `.custom_args.total_due` (the server rejects that with "references
  // undeclared variable(s): [custom_args]"). Variable rows keep custom_args.<name>.
  // The JQ field also takes the bare expression: no surrounding backticks (those
  // only appear in the JSON-editor/cURL view) -- they fail with 'unexpected token "`"'.
  function jqForDash2(expr) {
    var v = String(expr == null ? "" : expr).trim();
    var orig = v;
    if (v.length > 1 && v.charAt(0) === "`" && v.charAt(v.length - 1) === "`") v = v.slice(1, -1).trim();
    // Only a ROOT path: preceded by start, space or an operator/bracket -- never
    // by an identifier, ] or ) (which would make it a nested field of something else).
    // Rewrite code only -- never text inside a "string literal".
    var parts = v.split(/("(?:[^"\\]|\\.)*")/);
    for (var i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i]
        .replace(/(^|[^A-Za-z0-9_\]\)'$])\.custom_args\.(?=[A-Za-z_"]|$)/g, "$1.")
        .replace(/(^|[^A-Za-z0-9_\]\)'$])\.custom_args\[/g, "$1.[");
    }
    v = parts.join("");
    return { value: v, changed: v !== orig };
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

  // ------------------------------------------------------------------ build config
  // promptFiles = [{name, content}] of the prompt .md files (from content.js).
  // captures    = array of captured JSON payloads (content.js `captured`).
  function buildConfig(opts) {
    opts = opts || {};
    var platform = opts.platform || hostPlatform();
    var captures = opts.captures || [];
    var agent = opts.agent || pickAgent(captures);
    if (!agent) return { ok: false, reason: "No source bot data captured yet — open the bot and try again." };

    var ident = botIdentity(agent);
    var vars = extractVariables(agent);
    var lv = extractLanguageVoice(agent);
    var analysis = extractAnalysis(agent);
    var webhooks = extractWebhooks(agent);
    var tools = extractTools(agent);
    var skippedTools = tools._skipped || [];
    // additional_languages (3rd+ beyond primary/secondary) is intentionally not
    // captured — Raj: "no need to capture this" (spec = primary + secondary only).

    var containsCredentials =
      (PHASES.some(function (p) { return (tools[p] || []).length; })) ||
      (webhooks.length > 0);

    var config = {
      magicport: { format: FORMAT, pluginVersion: (opts.pluginVersion || "4.0.0") },
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
  function mapForDestination(config, destPlatform) {
    destPlatform = normPlatform(destPlatform);   // accept legacy names from older builds/tests
    var notes = [];
    var src = normPlatform(config.source ? config.source.platform : "");
    var data = config.data || {};
    var lv = data.languageVoice || {};
    var outLV = (destPlatform === DASH2)
      ? { primaryLanguage: langToName(lv.primaryLanguage), secondaryLanguage: langToName(lv.secondaryLanguage) }
      : lv;
    var out = { variables: [], languageVoice: outLV, analysis: null, tools: data.tools || {}, events: [] };

    // Tools: say which JQ expressions will be adapted for this dashboard.
    if (destPlatform === DASH2) {
      ["pre_call", "on_call", "post_call"].forEach(function (ph) {
        ((data.tools || {})[ph] || []).forEach(function (t) {
          var parts; try { parts = extractToolParts(t); } catch (e) { return; }
          var n = 0;
          ["headers", "query", "path", "body"].forEach(function (sec) {
            (parts[sec] || []).forEach(function (it) { if (it.kind === "jq" && jqForDash2(it.value).changed) n++; });
          });
          if (n) notes.push("Tool '" + (parts.name || "(unnamed)") + "': " + n + " JQ expression" + (n > 1 ? "s" : "") +
            " adapted for this dashboard (.custom_args.<name> → .<name>).");
        });
      });
    }

    // Variables
    (data.variables || []).forEach(function (v) {
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
    var an = data.customAnalysis || { prompt: "", keys: [] };
    var keys = (an.keys || []).map(function (k) {
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
    (data.events || []).forEach(function (w) {
      var events;
      if (destPlatform === DASH2) {
        events = enforceDash2AllEvents(w.events);   // Raj: always all 3
      } else {
        events = (w.events || []);
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
      var a = actualByName[k.name];
      if (!a) { wrong.push({ name: k.name, reason: "missing" }); return; }
      if (norm(a) !== norm(k.type)) wrong.push({ name: k.name, want: k.type, got: a });
    });
    return { ok: wrong.length === 0, wrong: wrong };
  }

  // ------------------------------------------------------------------ zip detect
  // Is a parsed set of zip entries a Magic Port archive (vs a plain prompt zip)?
  function isMagicPortZip(entryNames) {
    return (entryNames || []).some(function (n) { return /(^|\/)magicport\.json$/i.test(n); });
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
    mapKeyTypeDash5ToDash2: mapKeyTypeDash5ToDash2,
    mapVarTypeDash5ToDash2: mapVarTypeDash5ToDash2,
    enforceDash2AllEvents: enforceDash2AllEvents,
    verifyVariables: verifyVariables,
    verifyKeyTypes: verifyKeyTypes,
    isMagicPortZip: isMagicPortZip,
    // exposed for tests / tuning
    _extract: {
      variables: extractVariables, languageVoice: extractLanguageVoice,
      analysis: extractAnalysis, webhooks: extractWebhooks, tools: extractTools
    }
  };
})();
