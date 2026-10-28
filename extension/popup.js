/* popup.js — toolbar popup UI. Talks to the active tab's content script. */
(function () {
  "use strict";

  var statusEl = document.getElementById("status");
  var listEl = document.getElementById("list");
  var dlBtn = document.getElementById("dl");
  var panelBtn = document.getElementById("panel");

  function activeTab(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      cb(tabs && tabs[0]);
    });
  }

  function onRinggPage(tab) {
    return tab && tab.url && (
      /:\/\/[^/]*ringg\.ai\//.test(tab.url) ||
      /:\/\/panels\.gorezolv\.com\/voicebot\//.test(tab.url)
    );
  }

  function send(tabId, msg, cb) {
    chrome.tabs.sendMessage(tabId, msg, function (resp) {
      if (chrome.runtime.lastError) { cb(null); return; }
      cb(resp);
    });
  }

  function renderList(sections) {
    listEl.innerHTML = "";
    var anyFound = false;
    sections.forEach(function (s) {
      if (s.found) anyFound = true;
      var li = document.createElement("li");
      var dot = document.createElement("span");
      dot.className = "dot " + (s.found ? "ok" : "no");
      dot.textContent = s.found ? "✓" : "—";
      var name = document.createElement("span");
      name.textContent = s.title;
      var meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = s.found ? "on page" : "collapsed?";
      li.appendChild(dot); li.appendChild(name); li.appendChild(meta);
      listEl.appendChild(li);
    });
    dlBtn.disabled = false; // opens the on-page exporter; collapsed buckets are expanded there
    statusEl.textContent = anyFound
      ? "Click below to open the exporter on the page."
      : "Some sections may be collapsed — the exporter will open them.";
  }

  function refresh() {
    activeTab(function (tab) {
      if (!onRinggPage(tab)) {
        statusEl.textContent = "Open a supported prompt page to use this.";
        dlBtn.disabled = true; panelBtn.disabled = true;
        return;
      }
      send(tab.id, { type: "get-status" }, function (resp) {
        if (!resp) {
          statusEl.textContent = "Couldn't reach the page. Reload it and try again.";
          dlBtn.disabled = true;
          return;
        }
        renderList(resp.sections || []);
      });
    });
  }

  dlBtn.addEventListener("click", function () {
    activeTab(function (tab) {
      if (!onRinggPage(tab)) return;
      // Copying must happen under a real page click, so open the on-page panel
      // and let the user press Download there (guarantees a genuine copy).
      send(tab.id, { type: "open-panel" }, function () { window.close(); });
    });
  });

  panelBtn.addEventListener("click", function () {
    activeTab(function (tab) {
      if (!onRinggPage(tab)) return;
      send(tab.id, { type: "open-panel" }, function () { window.close(); });
    });
  });

  refresh();
})();
