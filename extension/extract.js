/*
 * extract.js  (ISOLATED world)
 *
 * Turns whatever we know about the current assistant into 5 sections.
 * Two independent strategies, tried in order per section:
 *   1) API  — search the captured assistant JSON for the matching field.
 *   2) DOM  — find the field on the page by its visible label.
 * Whichever produces non-empty text wins (API preferred).
 *
 * Exposes window.RinggExtract:
 *   .SECTIONS                      -> section definitions
 *   .fromApi(assistantObj)         -> { key: {text, source} }
 *   .fromDom()                     -> { key: {text, source} }
 *   .combine(apiObj)               -> ordered array of {key,title,filename,text,source}
 */
(function () {
  "use strict";

  var SECTIONS = [
    {
      key: "first-message",
      title: "First Message",
      filename: "First message.md",
      exportName: "First_Message",
      apiKeys: ["firstmessage", "first_message", "greeting", "welcomemessage",
                "welcome_message", "initialmessage", "openingmessage", "startmessage", "firstmsg"],
      labels: ["first message", "greeting", "welcome message", "opening message", "initial message"]
    },
    {
      key: "objective",
      title: "Objective",
      filename: "Objective.md",
      exportName: "Objective",
      apiKeys: ["objective", "objectives", "goal", "goals", "purpose",
                "agentobjective", "assistantobjective"],
      labels: ["objective", "objectives", "goal", "purpose"]
    },
    {
      key: "response-guideline",
      title: "Response Guidelines",
      filename: "Response Guidelines.md",
      exportName: "Response_Guidelines",
      apiKeys: ["responseguidelines", "responseguideline", "response_guidelines",
                "guidelines", "guideline", "responserules", "rules"],
      labels: ["response guidelines", "response guideline", "guidelines", "guideline"]
    },
    {
      key: "conversation-script",
      title: "Conversation Script",
      filename: "Conversation Script.md",
      exportName: "Conversation_Flow",
      apiKeys: ["conversationscript", "conversation_script", "script", "callscript",
                "conversationflow", "flow", "dialogscript", "callflow"],
      labels: ["conversation script", "call script", "script", "conversation flow"]
    },
    {
      key: "faqs",
      title: "FAQs",
      filename: "FAQs.md",
      exportName: "FAQs",
      apiKeys: ["faqs", "faq", "frequentlyaskedquestions", "frequently_asked_questions",
                "knowledgebase", "knowledge_base"],
      labels: ["faqs", "faq", "frequently asked questions", "knowledge base"]
    }
  ];

  function norm(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  // ---- HTML -> Markdown ---------------------------------------------------
  var _td = null;
  function turndown() {
    if (_td) return _td;
    if (typeof TurndownService === "undefined") return null;
    _td = new TurndownService({
      headingStyle: "atx",          // ## style
      bulletListMarker: "-",        // "- " list items
      codeBlockStyle: "fenced",
      emDelimiter: "*",
      strongDelimiter: "**",
      hr: "---"
    });
    // GFM tables / strikethrough / task lists
    try {
      if (typeof turndownPluginGfm !== "undefined") _td.use(turndownPluginGfm.gfm);
    } catch (e) {}
    // Strikethrough as GFM "~~x~~" (the plugin default "~x~" isn't read back).
    _td.addRule("ringgStrike", { filter: ["del", "s", "strike"], replacement: function (c) { return c.trim() ? "~~" + c + "~~" : c; } });
    // Table cells: a literal "|" (e.g. the @||tool|| variable form) would split
    // the cell on re-import, so escape it as "\|" (GFM's own cell escape).
    _td.addRule("ringgTableCell", {
      filter: ["th", "td"],
      replacement: function (content, node) {
        var idx = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
        // Several lines/paragraphs/list items in one cell are kept with <br>
        // (a markdown table row must stay on one line).
        var c = String(content).trim().replace(/[ \t]*\n+[ \t]*/g, "<br>").replace(/(\\*)\|/g, function (m, bs) { return bs.length % 2 ? m : bs + "\\|"; });
        return (idx === 0 ? "| " : " ") + c + " |";
      }
    });
    // Mention chips -> their variable token, e.g. "@{{callee_name}}".
    // The visible text of a chip is the friendly label ("Callee Name"), so the
    // token must come from data-id / data-label, NOT the rendered text.
    _td.addRule("ringgMention", {
      filter: function (node) {
        return node.nodeName === "SPAN" &&
          (node.getAttribute("data-type") === "mention" ||
           (node.getAttribute("class") || "").indexOf("mention") !== -1 ||
           node.hasAttribute("data-id"));
      },
      replacement: function (node_content, node) {
        // Export the BARE token, not the HTML span — e.g. "@{{customer_name}}",
        // "@((greetings.date))", "@||send_payment_link||". A chip's own text is
        // exactly its token (verified across every variable & tool type); we do
        // NOT reconstruct via mentionToken() (that force-wraps in {{ }} and would
        // corrupt the (( )) and || || forms). Fall back to data-id only if empty.
        var t = (node.textContent || "").trim();
        // Rezolv's chips show the bare token ("{{customer_name}}") and keep the
        // "@" in data-mention-suggestion-char — put it back so the markdown
        // token is the same "@{{…}}" form Ringg exports (and import re-hydrates).
        if (t && t.charAt(0) !== "@" && /^(\{\{[\s\S]*\}\}|\(\([\s\S]*\)\)|\|\|[\s\S]*\|\|)$/.test(t)) {
          t = (node.getAttribute("data-mention-suggestion-char") || "@") + t;
        }
        if (t) return t;
        var id = (node.getAttribute("data-id") || node.getAttribute("data-label") || "").trim();
        return id ? ("@" + id.replace(/^@+/, "")) : "";
      }
    });
    return _td;
  }

  function looksLikeHtml(s) {
    return typeof s === "string" && /<[a-z!/][^>]*>/i.test(s);
  }

  // Build the "@{{token}}" form for a mention node from its data attributes.
  function mentionToken(node) {
    var id = (node.getAttribute("data-id") || node.getAttribute("data-label") || "").trim();
    if (!id) {
      var t = (node.textContent || "").trim();
      if (/\{\{[^}]+\}\}/.test(t)) id = t; else return "";
    }
    id = id.replace(/^@+/, "");
    if (!/\{\{[\s\S]*\}\}/.test(id)) id = "{{" + id + "}}";
    return "@" + id;
  }

  // Same, for the raw-HTML string fallback path (Turndown unavailable).
  function mentionTokenFromAttrs(idAttr, labelAttr) {
    var id = (idAttr || labelAttr || "").trim().replace(/^@+/, "");
    if (!id) return "";
    if (!/\{\{[\s\S]*\}\}/.test(id)) id = "{{" + id + "}}";
    return "@" + id;
  }

  // A mention chip normally renders its token as visible text, so Turndown's
  // rule reads it from textContent. But an *empty* chip (no rendered label) is
  // pruned by Turndown as a blank inline node before any rule runs, which would
  // silently drop the variable. Pre-fill such chips from data-id/data-label so
  // both the Turndown and the tag-strip fallback paths keep the token.
  function fillEmptyMentions(html) {
    return String(html).replace(/<span\b([^>]*)>(\s*)<\/span>/gi, function (m, attrs) {
      var isMention = /data-type\s*=\s*"?mention/i.test(attrs) ||
                      /class\s*=\s*"[^"]*mention/i.test(attrs) ||
                      /data-id\s*=/i.test(attrs);
      if (!isMention) return m;
      var idm = attrs.match(/data-id\s*=\s*"([^"]*)"/i) ||
                attrs.match(/data-label\s*=\s*"([^"]*)"/i);
      var id = idm ? String(idm[1]).trim().replace(/^@+/, "") : "";
      if (!id) return m;
      return "<span" + attrs + ">@" + id + "</span>";
    });
  }

  // TipTap/ProseMirror HTML quirks that stop Turndown producing clean GFM:
  //  - <colgroup> before <tbody> hides the header row from the GFM table rule
  //    (the table then leaks through as raw HTML);
  //  - every list item / table cell wraps its text in a <p>, which makes lists
  //    "loose" and cells multi-line. Unwrap a lone <p>.
  //  - "tableWrapper" divs are pure layout.
  function tidyEditorHtml(html) {
    return String(html)
      .replace(/<colgroup\b[^>]*>[\s\S]*?<\/colgroup>/gi, "")
      .replace(/<(li|th|td)\b([^>]*)>\s*<p\b[^>]*>((?:(?!<\/?p\b)[\s\S])*?)<\/p>\s*(<(?:ul|ol)\b|<\/\1>)/gi,
        function (m, tag, attrs, inner, tail) { return "<" + tag + attrs + ">" + inner + tail; });
  }

  // Convert a stored field value to clean markdown. HTML is run through
  // Turndown; plain text / already-markdown is passed through untouched.
  function toMarkdown(val) {
    if (val == null) return "";
    if (typeof val !== "string") return String(val);
    var s = val;
    if (looksLikeHtml(s)) {
      s = fillEmptyMentions(s);
      s = tidyEditorHtml(s);
      var td = turndown();
      if (td) {
        try {
          var md = td.turndown(s);
          // Normalize Turndown's padded list markers ("-   x" -> "- x",
          // "1.  x" -> "1. x") while preserving any leading indentation.
          md = md.replace(/^([ \t]*[-*+])[ \t]{2,}/gm, "$1 ")
                 .replace(/^([ \t]*\d+\.)[ \t]{2,}/gm, "$1 ")
                 // a blank line inside a list item comes out as "    " — make it truly blank
                 .replace(/^[ \t]+$/gm, "");
          return md.trim();
        } catch (e) { /* fall through */ }
      }
      // Fallback if Turndown unavailable: strip tags, keeping inner text. A
      // mention span contains only its token text, so this yields the bare
      // token (e.g. "@{{customer_name}}") with no HTML wrapper.
      var tmp = s.replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, function (m) {
        return m.replace(/<\/?span[^>]*>/gi, "");
      });
      tmp = tmp
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/\n{3,}/g, "\n\n").trim();
      return tmp;
    }
    return s.trim();
  }

  // Format an arbitrary value into markdown text.
  function valueToMarkdown(val, sectionKey) {
    if (val == null) return "";
    if (typeof val === "string") return val.trim();
    if (typeof val === "number" || typeof val === "boolean") return String(val);

    // FAQs are often arrays of {question, answer}
    if (Array.isArray(val)) {
      var parts = [];
      val.forEach(function (item, i) {
        if (item == null) return;
        if (typeof item === "string") { parts.push("- " + item.trim()); return; }
        if (typeof item === "object") {
          var q = item.question || item.q || item.title || item.name || item.query;
          var a = item.answer || item.a || item.response || item.value || item.text;
          if (q || a) {
            parts.push("### " + (q ? String(q).trim() : ("Item " + (i + 1))));
            if (a) parts.push(String(a).trim());
            parts.push("");
          } else {
            parts.push("- " + JSON.stringify(item));
          }
        }
      });
      return parts.join("\n").trim();
    }

    if (typeof val === "object") {
      // Object of key->value; render as sub-sections.
      var lines = [];
      Object.keys(val).forEach(function (k) {
        var v = val[k];
        if (v == null || v === "") return;
        lines.push("### " + k);
        lines.push(typeof v === "string" ? v.trim() : JSON.stringify(v, null, 2));
        lines.push("");
      });
      return lines.join("\n").trim();
    }
    return "";
  }

  // Deep-walk the object collecting the first non-empty value whose normalized
  // key matches one of the wanted keys. Earlier keys in `wanted` win.
  function findInObject(obj, wanted) {
    var best = null;      // { rank, value }
    var wset = wanted.map(norm);

    function visit(node) {
      if (node == null || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      Object.keys(node).forEach(function (k) {
        var nk = norm(k);
        var rank = wset.indexOf(nk);
        if (rank !== -1) {
          var v = node[k];
          var hasContent = (typeof v === "string" && v.trim()) ||
                           (Array.isArray(v) && v.length) ||
                           (v && typeof v === "object" && Object.keys(v).length) ||
                           (typeof v === "number");
          if (hasContent && (best === null || rank < best.rank)) {
            best = { rank: rank, value: v };
          }
        }
        visit(node[k]);
      });
    }
    visit(obj);
    return best ? best.value : null;
  }

  // Accepts a single object OR an array of captured JSON payloads. For each
  // section it keeps the longest value found across all payloads.
  function fromApi(input) {
    var list = Array.isArray(input) ? input : (input ? [input] : []);
    var out = {};
    SECTIONS.forEach(function (sec) {
      var best = "";
      for (var i = 0; i < list.length; i++) {
        var val = findInObject(list[i], sec.apiKeys);
        var md = valueToMarkdown(val, sec.key);
        if (md && md.length > best.length) best = md;
      }
      if (best) out[sec.key] = { text: best, source: "api" };
    });
    return out;
  }

  // ---- DOM strategy -------------------------------------------------------
  // Returns the RAW value of a field (HTML for rich editors, .value for inputs).
  // Conversion to markdown happens later in combine() via toMarkdown().
  function visibleText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return (el.value || "").trim();

    // Rich editor (TipTap / ProseMirror / Quill): return the underlying HTML so
    // Turndown can convert headings, bold, lists, tables and mention chips.
    var host = el;
    var inner = el.querySelector && el.querySelector(".ProseMirror, .ql-editor, [contenteditable='true'], .tiptap");
    if (inner) host = inner;
    var html = (host.innerHTML || "").trim();
    if (html) return html;
    return (host.innerText || host.textContent || "").trim();
  }

  // The element's OWN text (direct text nodes only), so a big wrapper div whose
  // text happens to contain the label doesn't get treated as the label.
  function ownText(el) {
    var t = "";
    if (el.childNodes) {
      for (var i = 0; i < el.childNodes.length; i++) {
        if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent;
      }
    }
    t = t.trim();
    return t || el.textContent.trim();
  }

  function isEditable(el) {
    if (!el) return false;
    var tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      var ty = (el.getAttribute("type") || "text").toLowerCase();
      return ty === "text" || ty === "search" || ty === "";
    }
    if (el.getAttribute && el.getAttribute("contenteditable") === "true") return true;
    if (el.getAttribute && el.getAttribute("role") === "textbox") return true;
    if (el.classList && (el.classList.contains("ql-editor") ||
        el.classList.contains("ProseMirror") ||
        el.classList.contains("tiptap"))) return true;
    return false;
  }

  // All editable regions in the MAIN content (sidebar excluded), doc order.
  function allEditables() {
    var nodes = document.querySelectorAll(
      "textarea, input, [contenteditable='true'], [role='textbox'], .ql-editor, .ProseMirror, .tiptap"
    );
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (isEditable(nodes[i]) && !inSidebar(nodes[i])) out.push(nodes[i]);
    }
    return out;
  }

  // DOM strategy: for each section label, claim the CLOSEST editable that comes
  // after the label in document order and has not already been claimed by
  // another section. This prevents every section grabbing the first field.
  function fromDom() {
    var out = {};
    var editables = allEditables();
    var claimed = [];   // elements already assigned

    var candidates = Array.prototype.slice.call(
      document.querySelectorAll("label, h1, h2, h3, h4, h5, h6, p, span, div, legend, strong, b, dt")
    );

    SECTIONS.forEach(function (sec) {
      if (out[sec.key]) return;
      var wantSet = sec.labels.map(norm);

      // find the label element for this section (skip sidebar + in-editor text)
      var labelEl = null;
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (inSidebar(el) || inEditor(el)) continue;
        var txt = norm(ownText(el));
        if (wantSet.indexOf(txt) !== -1) { labelEl = el; break; }
      }
      if (!labelEl) return;

      // 1) explicit <label for="id">
      if (labelEl.htmlFor) {
        var target = document.getElementById(labelEl.htmlFor);
        if (isEditable(target) && claimed.indexOf(target) === -1) {
          var vt = visibleText(target);
          if (vt) { out[sec.key] = { text: vt, source: "dom" }; claimed.push(target); return; }
        }
      }

      // 2) closest editable that FOLLOWS the label and isn't claimed
      var best = null, bestPos = Infinity;
      for (var j = 0; j < editables.length; j++) {
        var ed = editables[j];
        if (claimed.indexOf(ed) !== -1) continue;
        if (labelEl.contains(ed)) continue;
        var rel = labelEl.compareDocumentPosition(ed);
        // DOCUMENT_POSITION_FOLLOWING = 4
        if (!(rel & 4)) continue;
        // rank by DOM distance (index in the editables list works as order)
        if (j < bestPos) { bestPos = j; best = ed; }
      }
      if (best) {
        var t2 = visibleText(best);
        if (t2) { out[sec.key] = { text: t2, source: "dom" }; claimed.push(best); return; }
        // even if empty, claim it so the next section doesn't grab it
        claimed.push(best);
        out[sec.key] = { text: "", source: "dom" };
        return;
      }

      // 3) next sibling block with substantial text (non-editable UIs)
      var sib = labelEl.nextElementSibling, guard = 0;
      while (sib && guard++ < 5) {
        var s = visibleText(sib);
        if (s && s.length > 1) { out[sec.key] = { text: s, source: "dom" }; break; }
        sib = sib.nextElementSibling;
      }
    });
    return out;
  }

  // ---- expand collapsed buckets ------------------------------------------
  // Only the element's OWN direct text (no textContent fallback), so a big
  // wrapper whose text merely contains the label is not mistaken for it.
  function directText(el) {
    var t = "";
    if (el.childNodes) {
      for (var i = 0; i < el.childNodes.length; i++) {
        if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent;
      }
    }
    return t.trim();
  }

  // Ignore the left navigation / sidebar so we never toggle those items.
  function inSidebar(el) {
    return !!(el.closest && el.closest(
      "nav, aside, [class*='sidebar' i], [class*='side-nav' i], [class*='sidenav' i], [class*='menu' i], [role='navigation']"
    ));
  }

  // Ignore anything INSIDE an editor — a bucket's own content can contain bold
  // sub-headings whose text equals another bucket's name (e.g. Response
  // Guidelines mentioning "FAQs"). Those are content, never bucket headers, so
  // header/label matching must skip them or a section grabs the wrong editor.
  function inEditor(el) {
    return !!(el.closest && el.closest(
      ".ProseMirror, .ql-editor, [contenteditable='true'], .tiptap, textarea, [role='textbox']"
    ));
  }

  // The bucket header element for a section, in the MAIN content.
  // Pass 1 (precise): an element whose OWN direct text is exactly the label.
  // Pass 2 (fallback): a header-like element (button / summary / heading /
  // legend) whose FULL short text equals the label — this catches headers that
  // wrap their label in a nested <span>, so those buckets still reach the copy
  // path instead of falling back to a plain DOM read.
  function headerFor(sec) {
    var want = sec.labels.map(norm);
    var candidates = document.querySelectorAll(
      "button, [role='button'], summary, h1, h2, h3, h4, h5, h6, legend, label, dt, span, p, strong, b, div"
    );
    var i, el;
    for (i = 0; i < candidates.length; i++) {
      el = candidates[i];
      if (inSidebar(el) || inEditor(el)) continue;
      var d = directText(el);
      if (d && want.indexOf(norm(d)) !== -1) return el;
    }
    for (i = 0; i < candidates.length; i++) {
      el = candidates[i];
      if (inSidebar(el) || inEditor(el)) continue;
      var tag = el.tagName;
      var headerish = tag === "BUTTON" || tag === "SUMMARY" || tag === "LEGEND" ||
        /^H[1-6]$/.test(tag) || (el.getAttribute && el.getAttribute("role") === "button");
      if (!headerish) continue;
      var full = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (full.length <= 60 && want.indexOf(norm(full)) !== -1) return el;
    }
    return null;
  }

  // The nearest accordion state element (carries aria-expanded / data-state /
  // <details>) for a header — but only if it's a header-sized toggle, not a big
  // panel wrapper that happens to carry state.
  function stateEl(h) {
    var e = h.closest && h.closest("[aria-expanded], [data-state], details");
    if (!e || inSidebar(e)) return null;
    if ((e.textContent || "").trim().length > 160) return null; // too big → not the header toggle
    return e;
  }

  function isCollapsed(el) {
    if (!el) return false;
    if (el.getAttribute) {
      if (el.getAttribute("aria-expanded") === "false") return true;
      if (el.getAttribute("data-state") === "closed") return true;
    }
    if (el.tagName === "DETAILS" && !el.open) return true;
    return false;
  }

  function isExpanded(el) {
    if (!el) return false;
    if (el.getAttribute) {
      if (el.getAttribute("aria-expanded") === "true") return true;
      if (el.getAttribute("data-state") === "open") return true;
    }
    if (el.tagName === "DETAILS" && el.open) return true;
    return false;
  }

  // Is there an editor between two elements in document order (i.e. does this
  // bucket currently show its content)?  Sidebar editors are ignored.
  function editorBetween(startEl, endEl) {
    var eds = allEditables();
    for (var i = 0; i < eds.length; i++) {
      var ed = eds[i];
      if (inSidebar(ed)) continue;
      if (!(startEl.compareDocumentPosition(ed) & 4)) continue;          // ed must follow start
      if (endEl && !(ed.compareDocumentPosition(endEl) & 4)) continue;   // and precede end
      return true;
    }
    return false;
  }

  // The disclosure control for a bucket header. Ringg renders each bucket as a
  // header row (a <div>) containing the label (an <h2>) plus a small chevron
  // <button> sibling; the header and the section themselves are INERT — only
  // that button toggles the bucket. It carries no aria-expanded/data-state, but
  // its aria-label/title reads "Expand" when collapsed and "Collapse" when open.
  // Look in the header's parent (the header row) first, then the header itself,
  // then the grandparent, and prefer a button that names the disclosure or is a
  // tiny icon button (the chevron).
  function toggleFor(h) {
    if (!h) return null;
    var scopes = [h.parentElement, h, h.parentElement && h.parentElement.parentElement];
    for (var i = 0; i < scopes.length; i++) {
      var sc = scopes[i];
      if (!sc || inSidebar(sc)) continue;
      var btns = sc.querySelectorAll("button, [role='button']");
      var iconBtn = null;
      for (var j = 0; j < btns.length; j++) {
        var b = btns[j];
        if (inSidebar(b)) continue;
        var lbl = (b.getAttribute("aria-label") || b.getAttribute("title") || "").toLowerCase();
        if (/expand|collapse/.test(lbl)) return b;            // explicit disclosure control
        if (!iconBtn && (b.textContent || "").trim().length <= 2) iconBtn = b; // chevron icon
      }
      if (iconBtn) return iconBtn;
    }
    return null;
  }

  // Collapsed/expanded read from the toggle's own label ("Expand" => collapsed,
  // "Collapse" => expanded). Returns true/false, or null when unknown so the
  // caller can fall back to attribute / content checks.
  function collapsedFromToggle(toggle) {
    if (!toggle) return null;
    var lbl = (toggle.getAttribute("aria-label") || toggle.getAttribute("title") || "").toLowerCase();
    if (/expand/.test(lbl)) return true;
    if (/collapse/.test(lbl)) return false;
    return null;
  }

  // Clicks open any of the 5 content buckets that are collapsed. Returns how
  // many it clicked so the caller can wait for content to render before copying.
  function expandCollapsed() {
    // Ringg-only: never click toggles on the Rezolv Voicebot Panel.
    if (/(^|\.)panels\.gorezolv\.com$/i.test(location.hostname || "")) return 0;
    var headers = SECTIONS.map(headerFor);
    var clicked = 0;

    for (var s = 0; s < SECTIONS.length; s++) {
      var h = headers[s];
      if (!h) continue;

      // find the next section header that follows this one in the document
      var next = null;
      for (var k = 0; k < headers.length; k++) {
        if (k === s || !headers[k]) continue;
        if (h.compareDocumentPosition(headers[k]) & 4) { // headers[k] follows h
          // keep the EARLIEST following header: replace next only if headers[k]
          // comes before the current next (i.e. next follows headers[k]).
          if (!next || (headers[k].compareDocumentPosition(next) & 4)) next = headers[k];
        }
      }

      var toggle = toggleFor(h);
      var st = stateEl(h);

      // Decide collapsed state: prefer the toggle's own "Expand"/"Collapse"
      // label, then an explicit state attribute, then infer from whether an
      // editor is currently showing between this header and the next.
      var collapsed = collapsedFromToggle(toggle);
      if (collapsed === null) {
        if (st && isCollapsed(st)) collapsed = true;         // explicit "closed"
        else if (st && isExpanded(st)) collapsed = false;    // explicit "open" — leave it
        else collapsed = !editorBetween(h, next);            // no state attr → infer from content
      }

      if (collapsed) {
        // Click the actual chevron button when we found one (Ringg's header/label
        // are inert). Fall back to a state element or the header, but never click
        // a plain element inside a link — it could navigate away.
        var target = toggle || st || h;
        var isToggle = !!toggle || !!st || target.tagName === "BUTTON" ||
          target.tagName === "SUMMARY" ||
          (target.getAttribute && target.getAttribute("role") === "button");
        var insideLink = target.closest && target.closest("a[href]");
        if (isToggle || !insideLink) {
          try { target.click(); clicked++; } catch (e) {}
        }
      }
    }
    return clicked;
  }

  // Map each section to its editor ELEMENT on the page. The editor is claimed
  // ONLY from the region between this bucket's header and the NEXT bucket's
  // header — so if a bucket's editor is absent, that section returns null
  // instead of stealing the following bucket's editor (prevents cascade
  // mis-assignment). Sidebar is excluded (headerFor + allEditables both filter).
  function sectionEditors() {
    var editables = allEditables();
    var headers = SECTIONS.map(headerFor);
    var claimed = [];

    return SECTIONS.map(function (sec, s) {
      var h = headers[s];
      var el = null;
      if (h) {
        // earliest header that follows this one → the region boundary
        var next = null;
        for (var k = 0; k < headers.length; k++) {
          if (k === s || !headers[k]) continue;
          if (h.compareDocumentPosition(headers[k]) & 4) {
            if (!next || (headers[k].compareDocumentPosition(next) & 4)) next = headers[k];
          }
        }
        // explicit <label for="id">
        if (h.htmlFor) {
          var t = document.getElementById(h.htmlFor);
          if (isEditable(t) && !inSidebar(t) && claimed.indexOf(t) === -1) el = t;
        }
        if (!el) {
          var best = null, bestPos = Infinity;
          for (var j = 0; j < editables.length; j++) {
            var ed = editables[j];
            if (claimed.indexOf(ed) !== -1) continue;
            if (h.contains(ed)) continue;
            if (!(h.compareDocumentPosition(ed) & 4)) continue;          // must follow this header
            if (next && !(ed.compareDocumentPosition(next) & 4)) continue; // must precede next header
            if (j < bestPos) { bestPos = j; best = ed; }
          }
          el = best;
        }
      }
      if (el) claimed.push(el);
      return { key: sec.key, title: sec.title, filename: sec.filename, el: el };
    });
  }

  function combine(assistantObj) {
    var api = fromApi(assistantObj);
    var dom = fromDom();
    var used = {};   // normalized text already assigned -> section key

    return SECTIONS.map(function (sec) {
      var pick = api[sec.key] || dom[sec.key] || { text: "", source: "none" };
      // Convert the raw field value (HTML from a rich editor / API) to markdown.
      var body = toMarkdown(pick.text || "").trim();

      // Safety net (fallback path only): blank a section only if its content is
      // IDENTICAL to another section's — using the FULL normalized text, so two
      // sections that merely share a prefix are never wrongly blanked.
      if (body) {
        var sig = norm(body);
        if (used[sig] && used[sig] !== sec.key) {
          pick = { text: "", source: "dup" };
          body = "";
        } else {
          used[sig] = sec.key;
        }
      }

      return {
        key: sec.key,
        title: sec.title,
        filename: sec.filename,
        text: body,
        source: pick.source
      };
    });
  }

  window.RinggExtract = {
    SECTIONS: SECTIONS,
    fromApi: fromApi,
    fromDom: fromDom,
    combine: combine,
    sectionEditors: sectionEditors,
    expandCollapsed: expandCollapsed,
    toMarkdown: toMarkdown
  };
})();
