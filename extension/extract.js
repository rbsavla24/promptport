/*
 * extract.js  (ISOLATED world)
 *
 * Turns whatever we know about the current assistant into 5 sections.
 * Two independent strategies, tried in order per section:
 *   1) API  — search the captured assistant JSON for the matching field.
 *   2) DOM  — find the field on the page by its visible label.
 * Whichever produces non-empty text wins (API preferred).
 *
 * Exposes window.PPExtract:
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
    _td.escape = ppEscape(_td.escape || TurndownService.prototype.escape);
    // Strikethrough as GFM "~~x~~" (the plugin default "~x~" isn't read back).
    _td.addRule("ppStrike", { filter: ["del", "s", "strike"], replacement: function (c) { return c.trim() ? "~~" + c + "~~" : c; } });
    // Every table becomes a GFM table. TipTap lets the user switch the header
    // row off (all <td>) or use a header COLUMN; the GFM plugin keeps those as
    // raw HTML (chips leak out as <span>s). A markdown table always has a header
    // row, so the FIRST row is promoted to it.
    function ownerTable(node) {
      var t = node.parentNode;
      while (t && t.nodeName !== "TABLE") t = t.parentNode;
      return t;
    }
    _td.addRule("ppTable", {
      filter: function (node) { return node.nodeName === "TABLE" && !!(node.rows && node.rows.length); },
      replacement: function (content) {
        return "\n\n" + String(content).replace(/\n\n+/g, "\n").replace(/^\n+|\n+$/g, "") + "\n\n";
      }
    });
    _td.addRule("ppTableRow", {
      filter: "tr",
      replacement: function (content, node) {
        var t = ownerTable(node), border = "";
        if (t && t.rows && t.rows[0] === node) {
          var cells = [];
          for (var i = 0; i < node.childNodes.length; i++) {
            var c = node.childNodes[i];
            if (c.nodeName !== "TH" && c.nodeName !== "TD") continue;
            var al = (c.getAttribute("align") || "").toLowerCase();
            cells.push(al === "left" ? ":--" : al === "right" ? "--:" : al === "center" ? ":-:" : "---");
          }
          if (cells.length) border = "| " + cells.join(" | ") + " |";
        }
        return "\n" + content + (border ? "\n" + border : "");
      }
    });
    // Two lists in a row ("- a" list, then another "- b" list) would merge into
    // ONE list on re-import. An empty HTML comment between them keeps them apart
    // (the importer drops comments).
    _td.addRule("ppList", {
      filter: ["ul", "ol"],
      replacement: function (content, node) {
        var parent = node.parentNode;
        if (parent && parent.nodeName === "LI" && parent.lastElementChild === node) return "\n" + content;
        var prev = node.previousSibling;
        while (prev && prev.nodeType === 3 && !/\S/.test(prev.nodeValue)) prev = prev.previousSibling;
        var sep = (prev && prev.nodeName === node.nodeName && !(parent && parent.nodeName === "LI")) ? "<!-- -->\n\n" : "";
        return "\n\n" + sep + content + "\n\n";
      }
    });
    // List items: Turndown's own rule finds an <ol> item's number with
    // indexOf(parent.children) for EVERY item (quadratic: a 20k-item list took
    // a minute). Same output, the positions counted once per list.
    var liIndex = typeof WeakMap === "function" ? new WeakMap() : null;
    function itemIndex(parent, node) {
      if (!liIndex) return Array.prototype.indexOf.call(parent.children, node);
      var m = liIndex.get(parent);
      if (!m) {
        m = new Map();
        for (var i = 0, k = parent.children; i < k.length; i++) m.set(k[i], i);
        liIndex.set(parent, m);
      }
      return m.has(node) ? m.get(node) : Array.prototype.indexOf.call(parent.children, node);
    }
    _td.addRule("ppListItem", {
      filter: "li",
      replacement: function (content, node, options) {
        var prefix = options.bulletListMarker + "   ";
        var parent = node.parentNode;
        if (parent && parent.nodeName === "OL") {
          var start = parent.getAttribute("start");
          var index = itemIndex(parent, node);
          prefix = (start ? Number(start) + index : index + 1) + ".  ";
        }
        var isParagraph = /\n$/.test(content);
        content = String(content).replace(/^\n+/, "");
        var e = content.length;
        while (e > 0 && content.charAt(e - 1) === "\n") e--;
        content = content.substring(0, e) + (isParagraph ? "\n" : "");
        content = content.replace(/\n/gm, "\n" + " ".repeat(prefix.length));
        return prefix + content + (node.nextSibling ? "\n" : "");
      }
    });
    // Table cells: a literal "|" (e.g. the @||tool|| variable form) would split
    // the cell on re-import, so escape it as "\|" (GFM's own cell escape).
    _td.addRule("ppTableCell", {
      filter: ["th", "td"],
      replacement: function (content, node) {
        var idx = Array.prototype.indexOf.call(node.parentNode.childNodes, node);
        // Several lines/paragraphs/list items in one cell are kept with <br>
        // (a markdown table row must stay on one line).
        var c = String(content).trim()
          // a list in a cell: "-   x" → "- x" (same as top-level lists)
          .replace(/^([ \t]*[-*+])[ \t]{2,}/gm, "$1 ").replace(/^([ \t]*\d+\.)[ \t]{2,}/gm, "$1 ")
          .replace(/[ \t]*\n+[ \t]*/g, "<br>").replace(/(\\*)\|/g, function (m, bs) { return bs.length % 2 ? m : bs + "\\|"; });
        return (idx === 0 ? "| " : " ") + c + " |";
      }
    });
    // Mention chips -> their variable token, e.g. "@{{callee_name}}".
    // The visible text of a chip is the friendly label ("Callee Name"), so the
    // token must come from data-id / data-label, NOT the rendered text.
    _td.addRule("ppMention", {
      filter: function (node) {
        // Not the new 2-field editor's live-only decoration of a PLAIN {{x}}
        // (span.mention-unknown-text): that is text, not a chip.
        var cls = node.getAttribute("class") || "";
        return node.nodeName === "SPAN" &&
          (node.getAttribute("data-type") === "mention" ||
           (cls.indexOf("mention") !== -1 && !/(^|\s)mention-unknown-text(\s|$)/.test(cls)) ||
           node.hasAttribute("data-id"));
      },
      replacement: function (node_content, node) {
        // Export the BARE token, not the HTML span — e.g. "@{{customer_name}}",
        // "@((greetings.date))", "@||send_payment_link||". A chip's own text is
        // exactly its token (verified across every variable & tool type); we do
        // NOT force-wrap the id in {{ }} (that would
        // corrupt the (( )) and || || forms). Fall back to data-id only if empty.
        var t = (node.textContent || "").trim();
        // Dash2's chips show the bare token ("{{customer_name}}") and keep the
        // "@" in data-mention-suggestion-char — put it back so the markdown
        // token is the same "@{{…}}" form Dash5 exports (and import re-hydrates).
        if (t && t.charAt(0) !== "@" && TOKEN_SHAPE.test(t)) {
          t = (node.getAttribute("data-mention-suggestion-char") || "@") + t;
        }
        var id = (node.getAttribute("data-id") || node.getAttribute("data-label") || "").trim();
        // The text is a friendly display label ("Callee Name"), not a token:
        // the token is in data-id / data-label.
        if (t && !TOKEN_SHAPE.test(t.replace(/^@+/, "")) && TOKEN_SHAPE.test(id.replace(/^@+/, ""))) t = "@" + id.replace(/^@+/, "");
        if (t) return normalizeMentionToken(t);
        return id ? normalizeMentionToken("@" + id.replace(/^@+/, "")) : "";
      }
    });
    return _td;
  }

  var TOKEN_SHAPE = /^(\{\{[\s\S]*\}\}|\(\([\s\S]*\)\)|\|\|[\s\S]*\|\|)$/;
  // A chip damaged by an older 2-field import carries its token wrapped in extra
  // {{ }}: "@{{{{||send_payment_link||}}}}", "@{{{{((greetings.date))}}}}",
  // "@{{{{callee_name}}}}". Peel the extra wraps: "@||send_payment_link||",
  // "@((greetings.date))", "@{{callee_name}}". Any other token is returned as is.
  function normalizeMentionToken(tok) {
    var s = String(tok == null ? "" : tok);
    var m = s.match(/^(@+)\{\{(?=\{\{|\(\(|\|\|)/);
    if (!m) return s;
    var lead = m[1], core = s.slice(lead.length), w;
    while ((w = core.match(/^\{\{([\s\S]*)\}\}$/)) && TOKEN_SHAPE.test(w[1])) core = w[1];
    return lead + core;
  }

  // Turndown escapes every "_" in plain text, so a reference kept as plain text
  // (the 2-field dashboard has no chip for @((…)) / @||…||) would export as
  // "@||send\_payment\_link||". An underscore between two word characters is
  // never emphasis in GFM, so the escape is dropped inside such tokens.
  function unescapeTokenUnderscores(md) {
    // (in a table cell the pipes come out escaped: "@\|\|send\_payment\_link\|\|")
    return String(md).replace(/@(?:\{\{[^{}\n]+\}\}|\(\([^()\n]+\)\)|\|\|[^|\n]+\|\||\\\|\\\|[^|\n]+?\\\|\\\|)/g, function (tok) {
      return tok.replace(/([A-Za-z0-9])\\_(?=[A-Za-z0-9])/g, "$1_");
    });
  }

  // Is this string real editor HTML (copied text/html, innerHTML, an API value
  // stored as HTML)? Only a real block tag or a mention chip counts: plain text
  // or markdown that merely CONTAINS something tag-like ("<END_CALL>",
  // '<break time="1s"/>') is prompt text and must pass through unchanged —
  // running it through Turndown would drop the "tag" and flatten the lines.
  var HTML_BLOCK_RE = /<(?:p|h[1-6]|ul|ol|li|div|br|table|thead|tbody|tr|td|th|pre|blockquote|hr)\b[^<>]*>/i;
  var HTML_MENTION_RE = /<span\b[^<>]*\b(?:data-type\s*=\s*["']?mention|class\s*=\s*["'][^"']*\bmention|data-id\s*=)[^<>]*>/i;
  function looksLikeHtml(s) {
    return typeof s === "string" && (HTML_BLOCK_RE.test(s) || HTML_MENTION_RE.test(s));
  }

  // Turndown's text escaping, plus:
  //  - "<" that starts something tag-like ("<END_CALL>", "<!-- x -->", "</b>",
  //    "<?x") is escaped as "\<" (a CommonMark escape), so literal angle-bracket
  //    text in a prompt is read back as text, never as HTML, on re-import;
  //  - an underscore BETWEEN two letters/digits ("snake_case") is never
  //    emphasis in GFM, so its "\_" escape is dropped (keeps exports readable).
  // Only text nodes go through here — code spans / blocks stay verbatim.
  var INTRAWORD_US_RE = (function () {
    try { return new RegExp("([\\p{L}\\p{M}\\p{N}])\\\\_(?=[\\p{L}\\p{M}\\p{N}])", "gu"); }
    catch (e) { return /([A-Za-z0-9])\\_(?=[A-Za-z0-9])/g; }
  })();
  function ppEscape(base) {
    return function (string) {
      var out = base.call(this, string);
      out = out.replace(/<(?=[A-Za-z\/!?])/g, "\\<");
      // A typed "~~" (or "~~~" fence) would come back as strikethrough / code:
      // escape every tilde of a run of two or more ("\~\~" reads back as "~~").
      out = out.replace(/~{2,}/g, function (r) { return r.replace(/~/g, "\\~"); });
      return out.replace(INTRAWORD_US_RE, "$1_");
    };
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

  // Turndown glues its output together one top-level block at a time, and each
  // step re-reads the whole string so far — quadratic: a 1 MB prompt took
  // seconds per conversion. A big document is converted in runs of top-level
  // blocks instead and the runs joined with a blank line (exactly what
  // Turndown puts between blocks). A run never ends between two lists of the
  // same kind (their separator needs both) or next to inline content.
  var CHUNK_BLOCKS = { P: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, UL: 1, OL: 1, TABLE: 1, PRE: 1, BLOCKQUOTE: 1, DIV: 1, HR: 1 };
  // One top-level list with thousands of items, or one paragraph with thousands
  // of inline nodes, is quadratic inside Turndown too. Such a block is converted
  // in runs and the runs joined exactly as Turndown would have joined them.
  // Returns null for an ordinary block.
  var BIG_RUN = 500, SPLIT_MARK = "\uE000ppsplit\uE000";
  function bigBlock(td, doc, node) {
    var kids = node.childNodes, i;
    if ((node.nodeName === "UL" || node.nodeName === "OL") && node.children.length > 2 * BIG_RUN) {
      for (i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === 1 ? kids[i].nodeName !== "LI" : (kids[i].nodeType === 3 && /\S/.test(kids[i].nodeValue))) return null;
      }
      var items = Array.prototype.slice.call(node.children);
      if (node.parentNode) node.parentNode.removeChild(node);   // detached first: moving its items is much cheaper
      var start = node.getAttribute("start"), first = start ? Number(start) : 1;
      var md = "";
      for (var at = 0; at < items.length; at += BIG_RUN) {
        var list = node.cloneNode(false);
        if (at && node.nodeName === "OL") list.setAttribute("start", String(first + at));
        items.slice(at, at + BIG_RUN).forEach(function (li) { list.appendChild(li); });   // moved: the caller drops the node
        var more = at + BIG_RUN < items.length;
        // A marker item after the run gives the run's last item its real
        // spacing to the next one; the marker line is then cut off.
        if (more) { var mk = doc.createElement("li"); mk.textContent = SPLIT_MARK; list.appendChild(mk); }
        var wrap = doc.createElement("div"); wrap.appendChild(list);
        var part = td.turndown(wrap);
        if (more) {
          var mi = part.lastIndexOf(SPLIT_MARK);
          part = mi < 0 ? part + "\n" : part.substring(0, part.lastIndexOf("\n", mi) + 1);
        }
        md += part;
      }
      return md;
    }
    if (node.nodeName === "P" && kids.length > 2 * BIG_RUN) {
      // Split only at a space between two words / inline elements, so the runs
      // join with one " " exactly where the paragraph had collapsed whitespace.
      var cuts = [], count = 0;
      var nodes = Array.prototype.slice.call(kids);
      var inl = function (x) { return !x || x.nodeType !== 1 || !/^(BR|IMG)$/.test(x.nodeName); };
      for (i = 0; i < nodes.length; i++) {
        var c = nodes[i], m;
        if (count >= BIG_RUN && c.nodeType === 3 && (m = /\s+/.exec(c.nodeValue))) {
          var left = c.nodeValue.slice(0, m.index), right = c.nodeValue.slice(m.index + m[0].length);
          var prev = left ? left : (nodes[i - 1] ? nodes[i - 1].textContent : "");
          var next = right ? right : (nodes[i + 1] ? nodes[i + 1].textContent : "");
          if (/\S$/.test(prev) && /^\S/.test(next) && (left || inl(nodes[i - 1])) && (right || inl(nodes[i + 1]))) {
            cuts.push({ at: i, left: left, right: right }); count = right ? 1 : 0;
            continue;
          }
        }
        count++;
      }
      if (!cuts.length) return null;
      // (nodes are moved from here on: the caller drops the node)
      if (node.parentNode) node.parentNode.removeChild(node);   // detached first: moving its children is much cheaper
      var runs = [], cur = node.cloneNode(false), ci = 0;
      for (i = 0; i < nodes.length; i++) {
        var cut = cuts[ci];
        if (cut && cut.at === i) {
          if (cut.left) cur.appendChild(doc.createTextNode(cut.left));
          runs.push(cur); cur = node.cloneNode(false); ci++;
          if (cut.right) cur.appendChild(doc.createTextNode(cut.right));
          continue;
        }
        cur.appendChild(nodes[i]);
      }
      runs.push(cur);
      return runs.map(function (p) { var w = doc.createElement("div"); w.appendChild(p); return td.turndown(w); })
        .filter(function (x) { return x; }).join(" ");
    }
    return null;
  }
  function turndownChunked(td, html) {
    if (html.length < 60000 || typeof DOMParser === "undefined") return td.turndown(html);
    var doc = new DOMParser().parseFromString("<div id='__pp_root'>" + html + "</div>", "text/html");
    var root = doc.getElementById("__pp_root");
    if (!root) return td.turndown(html);
    var out = [], chunk = doc.createElement("div"), n = 0, lastEl = null, sepNext = "";
    function flush() {
      if (!chunk.firstChild) return;
      var md = td.turndown(chunk);
      if (md) out.push(sepNext + md);
      sepNext = "";
      chunk = doc.createElement("div"); n = 0;
    }
    while (root.firstChild) {
      var node = root.firstChild;
      // One huge list / paragraph is itself converted in runs (see bigBlock).
      var big = node.nodeType === 1 ? bigBlock(td, doc, node) : null;
      if (big !== null) {
        // Two lists of the same kind in a row keep their separator.
        var sameKind = lastEl && (node.nodeName === "UL" || node.nodeName === "OL") && lastEl.nodeName === node.nodeName;
        flush(); sepNext = "";
        if (node.parentNode === root) root.removeChild(node);
        if (big) out.push((sameKind ? "<!-- -->\n\n" : "") + big);
        lastEl = node;
        // the next same-kind list (after blank text only) needs the separator too
        var nx = root.firstChild;
        while (nx && nx.nodeType === 3 && !/\S/.test(nx.nodeValue)) nx = nx.nextSibling;
        if (nx && (node.nodeName === "UL" || node.nodeName === "OL") && nx.nodeName === node.nodeName) sepNext = "<!-- -->\n\n";
        continue;
      }
      if (node.nodeType === 1 && n >= 200 && lastEl && CHUNK_BLOCKS[node.nodeName] && CHUNK_BLOCKS[lastEl.nodeName] &&
          !((node.nodeName === "UL" || node.nodeName === "OL") && node.nodeName === lastEl.nodeName)) flush();
      chunk.appendChild(node);
      n++;
      if (node.nodeType === 1) lastEl = node;
      else if (node.nodeType === 3 && /\S/.test(node.nodeValue)) lastEl = null;   // inline text: no split right after it
    }
    flush();
    return out.join("\n\n");
  }

  // Convert a stored field value to clean markdown. HTML is run through
  // Turndown; plain text / already-markdown is passed through untouched.
  // opts.html: the value IS HTML (copied text/html, an editor's innerHTML) —
  // convert it even without a block tag. opts.text: the value is plain text /
  // markdown (a textarea value, a text/plain copy) — never parse it as HTML.
  // Without either, only a string with a real block tag / chip is HTML.
  function toMarkdown(val, opts) {
    if (val == null) return "";
    if (typeof val !== "string") return String(val);
    var s = val;
    var isHtml = opts && opts.text ? false : (opts && opts.html ? true : looksLikeHtml(s));
    if (isHtml) {
      s = fillEmptyMentions(s);
      s = tidyEditorHtml(s);
      var td = turndown();
      if (td) {
        try {
          var md = turndownChunked(td, s);
          // Normalize Turndown's padded list markers ("-   x" -> "- x",
          // "1.  x" -> "1. x") while preserving any leading indentation.
          md = md.replace(/^([ \t]*[-*+])[ \t]{2,}/gm, "$1 ")
                 .replace(/^([ \t]*\d+\.)[ \t]{2,}/gm, "$1 ")
                 // a blank line inside a list item comes out as "    " — make it truly blank
                 .replace(/^[ \t]+$/gm, "");
          md = unescapeTokenUnderscores(md);
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

  function isField(el) { return !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT"); }

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
          if (vt) { out[sec.key] = { text: vt, source: "dom", plain: isField(target) }; claimed.push(target); return; }
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
        if (t2) { out[sec.key] = { text: t2, source: "dom", plain: isField(best) }; claimed.push(best); return; }
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

  // The disclosure control for a bucket header. Dash5 renders each bucket as a
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
    // Dash5-only: never click toggles on the 2-field dashboard (prod or QA/dev).
    if (window.PPHost && window.PPHost.layout() === "dash2") return 0;
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
        // Click the actual chevron button when we found one (Dash5's header/label
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
      // (a textarea / input value is plain text — never parsed as HTML)
      var body = toMarkdown(pick.text || "", pick.plain ? { text: true } : null).trim();

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

  window.PPExtract = {
    SECTIONS: SECTIONS,
    fromApi: fromApi,
    fromDom: fromDom,
    combine: combine,
    sectionEditors: sectionEditors,
    expandCollapsed: expandCollapsed,
    toMarkdown: toMarkdown,
    normalizeMentionToken: normalizeMentionToken
  };
})();
