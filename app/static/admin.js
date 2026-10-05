// Global toggle for mobile edit drawer (MUST be outside DOMContentLoaded for inline onclick handlers)
window.toggleMobileDrawer = function(infoEl) {
  const tr = infoEl.closest('tr');
  const drawer = tr ? tr.querySelector('.mobile-edit-drawer') : null;
  if (drawer) drawer.classList.toggle('open');
};

document.addEventListener('DOMContentLoaded', () => {
  const queueTableBody = document.getElementById("queueTableBody");

  if (!queueTableBody) return;

  const clientSearchInput = document.getElementById("clientSearch");
  const addClientForm = document.getElementById("addClientForm");
  const logsTableBody = document.getElementById("logsTableBody");
  const masterCheckbox = document.getElementById("masterCheckbox");
  const statusAlert = document.getElementById("statusAlert");
  const batchActionBar = document.getElementById("batchActionBar");
  const selectedCountBadge = document.getElementById("selectedCountBadge");
  const clearSelectionBtn = document.getElementById("clearSelectionBtn");
  const activityBar = document.getElementById("activityBar");
  const syncBadge = document.getElementById("syncBadge");
  const syncBadgeText = document.getElementById("syncBadgeText");
  
  let draggedRow = null;
  let alertTimer = null;

  // Consistency-layer state (see "Consistency layer" below)
  const REFRESH_AFTER_SAVE_MS = 100;   // successful POST already waits for Apps Script
  const AUTO_REFRESH_MS = 30000;       // background sync with the sheet
  let opChain = Promise.resolve();     // saves run one at a time, in order
  let pendingOps = 0;                  // saves / bulk jobs queued or running
  let refreshTimer = null;
  let refreshForce = false;
  let loadSeq = 0;                     // lets a newer queue load supersede an older one
  let lastQueueSignature = null;       // skip re-rendering when nothing changed
  let placementTouched = false;        // don't overwrite a placement the admin picked by hand

  // Activity-indicator state
  let loadsInFlight = 0;               // visible (non-background) queue loads running
  let refreshPending = false;          // a post-save refresh is scheduled
  const busyNames = new Set();         // clients whose change is queued or being saved
  const syncingNames = new Set();      // keep edited rows locked until a fresh snapshot arrives
  const rowPhases = new Map();
  let queueNameSet = new Set();        // normalized names currently in the queue (duplicate guard)

  // Escape untrusted text before using innerHTML
  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // fetch wrapper: detects expired sessions and non-JSON responses
  async function apiFetch(url, options) {
    const res = await fetch(url, options);

    if (res.redirected && res.url.includes("/admin/login")) {
      showAlert("Session expired. Redirecting to login...", "#fee2e2", "#991b1b");
      setTimeout(() => { window.location.href = "/admin/login"; }, 1500);
      const err = new Error("Session expired");
      err.sessionExpired = true;
      throw err;
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("Unexpected server response (HTTP " + res.status + ")");
    }
    return res;
  }

  // Enable drop target for Desktop HTML5 Drag & Drop
  queueTableBody.addEventListener("dragover", (e) => {
    e.preventDefault(); // Prevents the red 'not-allowed' circle symbol
    e.dataTransfer.dropEffect = "move"; // Shows the move cursor

    if (!draggedRow) return;

    const afterElement = getDragAfterElement(queueTableBody, e.clientY);
    if (afterElement == null) {
      queueTableBody.appendChild(draggedRow);
    } else {
      queueTableBody.insertBefore(draggedRow, afterElement);
    }
  });

  // ---------------------------------------------------------------------------
  // Client-name autocomplete (custom dropdown)
  // Markup it drives: #clientSearch (input), #autocompleteSpinner, #autocompleteDropdown
  // ---------------------------------------------------------------------------
  const AC_MIN_CHARS = 2;                  // don't search for a single letter
  const AC_DEBOUNCE_MS = 200;
  const AC_CACHE_TTL_MS = 5 * 60 * 1000;   // the server caches the roster for 5 minutes too
  const acDropdown = document.getElementById("autocompleteDropdown");
  const acSpinner = document.getElementById("autocompleteSpinner");
  const acCache = new Map();               // lowercased query -> { names, at }
  let acResults = [];                      // names currently listed
  let acSeq = 0;                           // bumped on every search/close so late replies are ignored
  let acAbort = null;                      // cancels the in-flight request
  let acComposing = false;                 // IME composition in progress

  // Debounce helper to prevent flooding the backend on every keypress
  function debounce(func, delay = 300) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => func.apply(this, args), delay);
    };
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Wrap each typed word in <mark>. Everything is HTML-escaped first, so odd names can't inject markup.
  function highlightMatch(name, query) {
    const parts = query.split(/[\s,]+/).filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp);
    if (parts.length === 0) return escapeHtml(name);
    const pieces = String(name).split(new RegExp("(" + parts.join("|") + ")", "i"));
    return pieces
      .map((piece, i) => (i % 2 === 1 ? '<mark class="ac-match">' + escapeHtml(piece) + '</mark>' : escapeHtml(piece)))
      .join("");
  }

  function extractClientNames(data) {
    const raw = Array.isArray(data) ? data : (data.results || data.clients || data.data || []);
    return raw.map(item => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        return item.Name || item.name || item.Client_Name || item.client_name || item.full_name || "";
      }
      return "";
    }).filter(Boolean);
  }

  function isAutocompleteOpen() {
    return !!acDropdown && acDropdown.classList.contains("open");
  }

  function openAutocomplete() {
    if (!acDropdown) return;
    acDropdown.classList.add("open");
    clientSearchInput.setAttribute("aria-expanded", "true");
  }

  function setAutocompleteLoading(on) {
    if (acSpinner) acSpinner.classList.toggle("is-loading", on);
    if (clientSearchInput) clientSearchInput.setAttribute("aria-busy", on ? "true" : "false");
  }

  // Hide the list and cancel anything still in flight
  function closeAutocomplete() {
    if (!acDropdown) return;
    acSeq++;
    if (acAbort) { acAbort.abort(); acAbort = null; }
    acDropdown.classList.remove("open");
    clientSearchInput.setAttribute("aria-expanded", "false");
    clientSearchInput.removeAttribute("aria-activedescendant");
    setAutocompleteLoading(false);
  }

  function showAutocompleteMessage(text, kind) {
    acResults = [];
    acDropdown.textContent = "";
    const row = document.createElement("div");
    row.className = "autocomplete-status" + (kind ? " " + kind : "");
    row.setAttribute("role", "presentation");
    row.textContent = text;
    acDropdown.appendChild(row);
    clientSearchInput.removeAttribute("aria-activedescendant");
    openAutocomplete();
  }

  function renderAutocomplete(query, names) {
    if (names.length === 0) {
      showAutocompleteMessage("No matching clients", "");
      return;
    }

    acResults = names;
    acDropdown.textContent = "";
    clientSearchInput.removeAttribute("aria-activedescendant");

    names.forEach((name, i) => {
      const item = document.createElement("div");
      item.className = "autocomplete-item";
      item.id = "ac-option-" + i;
      item.dataset.index = String(i);
      item.setAttribute("role", "option");

      const label = document.createElement("span");
      label.className = "autocomplete-item-name";
      label.innerHTML = highlightMatch(name, query);
      item.appendChild(label);

      // Names are the identity everywhere else on this page, so the same name twice in the
      // queue would make edits ambiguous. Show it, but don't let it be picked again.
      if (queueNameSet.has(normalizeName(name))) {
        item.classList.add("is-disabled");
        item.setAttribute("aria-disabled", "true");
        const tag = document.createElement("span");
        tag.className = "autocomplete-item-tag";
        tag.textContent = "Already in queue";
        item.appendChild(tag);
      }

      acDropdown.appendChild(item);
    });

    openAutocomplete();
  }

  function enabledAutocompleteItems() {
    return [...acDropdown.querySelectorAll(".autocomplete-item:not(.is-disabled)")];
  }

  function setAutocompleteActive(item) {
    acDropdown.querySelectorAll(".autocomplete-item.active").forEach(el => {
      el.classList.remove("active");
      el.removeAttribute("aria-selected");
    });
    if (!item) {
      clientSearchInput.removeAttribute("aria-activedescendant");
      return;
    }
    item.classList.add("active");
    item.setAttribute("aria-selected", "true");
    clientSearchInput.setAttribute("aria-activedescendant", item.id);
    item.scrollIntoView({ block: "nearest" });
  }

  function moveAutocompleteActive(delta) {
    const items = enabledAutocompleteItems();
    if (items.length === 0) return;
    const current = items.findIndex(el => el.classList.contains("active"));
    let next;
    if (current === -1) next = delta > 0 ? 0 : items.length - 1;
    else next = (current + delta + items.length) % items.length;
    setAutocompleteActive(items[next]);
  }

  function selectAutocompleteItem(item) {
    const name = acResults[Number(item.dataset.index)];
    if (!name) return;
    clientSearchInput.value = name;
    closeAutocomplete();
    clientSearchInput.focus();
  }

  async function runAutocompleteSearch(query) {
    const key = query.toLowerCase();
    const seq = ++acSeq;
    if (acAbort) acAbort.abort();

    const cached = acCache.get(key);
    if (cached && (Date.now() - cached.at) < AC_CACHE_TTL_MS) {
      acAbort = null;
      setAutocompleteLoading(false);
      renderAutocomplete(query, cached.names);
      return;
    }

    setAutocompleteLoading(true);
    // First search of a session: nothing to show yet, so say so rather than staying blank
    if (!isAutocompleteOpen() || acResults.length === 0) {
      showAutocompleteMessage("Searching...", "");
    }

    acAbort = new AbortController();
    try {
      const res = await apiFetch(`/api/clients/search?q=${encodeURIComponent(query)}`, { signal: acAbort.signal });
      const data = await res.json();
      if (seq !== acSeq) return; // a newer search (or a close) superseded this one
      if (!res.ok) throw new Error(data.error || "Search failed");

      const names = extractClientNames(data);
      if (acCache.size >= 50) acCache.delete(acCache.keys().next().value);
      acCache.set(key, { names, at: Date.now() });
      renderAutocomplete(query, names);
    } catch (err) {
      if (err.name === "AbortError" || err.sessionExpired || seq !== acSeq) return;
      console.error("[Autocomplete] search failed:", err);
      showAutocompleteMessage("Couldn't search right now. You can still type the full name.", "error");
    } finally {
      if (seq === acSeq) setAutocompleteLoading(false);
    }
  }

  const debouncedAutocompleteSearch = debounce(() => {
    const query = clientSearchInput.value.trim();
    // Skip if the field was emptied or the user already moved on
    if (query.length < AC_MIN_CHARS || document.activeElement !== clientSearchInput) return;
    runAutocompleteSearch(query);
  }, AC_DEBOUNCE_MS);

  if (clientSearchInput && acDropdown) {
    // Screen-reader semantics (set here so the HTML doesn't need to change)
    // The page may still carry the old native <datalist>; unlink it so there aren't two suggestion lists
    clientSearchInput.removeAttribute("list");
    clientSearchInput.setAttribute("role", "combobox");
    clientSearchInput.setAttribute("aria-autocomplete", "list");
    clientSearchInput.setAttribute("aria-expanded", "false");
    clientSearchInput.setAttribute("aria-controls", "autocompleteDropdown");
    acDropdown.setAttribute("role", "listbox");
    acDropdown.setAttribute("aria-label", "Matching clients");

    clientSearchInput.addEventListener("compositionstart", () => { acComposing = true; });
    clientSearchInput.addEventListener("compositionend", () => {
      acComposing = false;
      debouncedAutocompleteSearch();
    });

    clientSearchInput.addEventListener("input", () => {
      if (acComposing) return;
      if (clientSearchInput.value.trim().length < AC_MIN_CHARS) {
        closeAutocomplete();
        return;
      }
      debouncedAutocompleteSearch();
    });

    // Coming back to the field: show the last results for what is typed, if we have them
    clientSearchInput.addEventListener("focus", () => {
      const query = clientSearchInput.value.trim();
      const cached = acCache.get(query.toLowerCase());
      if (query.length >= AC_MIN_CHARS && cached && (Date.now() - cached.at) < AC_CACHE_TTL_MS) {
        renderAutocomplete(query, cached.names);
      }
    });

    clientSearchInput.addEventListener("blur", closeAutocomplete);

    clientSearchInput.addEventListener("keydown", (e) => {
      if (e.isComposing) return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const query = clientSearchInput.value.trim();
        const cached = acCache.get(query.toLowerCase());
        if (!isAutocompleteOpen() && query.length >= AC_MIN_CHARS && cached) {
          renderAutocomplete(query, cached.names);
        }
        if (isAutocompleteOpen()) {
          e.preventDefault();
          moveAutocompleteActive(e.key === "ArrowDown" ? 1 : -1);
        }
      } else if (e.key === "Enter") {
        // Only take over Enter when a suggestion is highlighted; otherwise it submits the form as usual
        const active = isAutocompleteOpen() ? acDropdown.querySelector(".autocomplete-item.active") : null;
        if (active) {
          e.preventDefault();
          selectAutocompleteItem(active);
        }
      } else if (e.key === "Escape") {
        if (isAutocompleteOpen()) {
          e.preventDefault();
          closeAutocomplete();
        }
      }
    });

    // mousedown (not click) so the input keeps focus and doesn't blur-close the list first
    acDropdown.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const item = e.target.closest(".autocomplete-item");
      if (item && !item.classList.contains("is-disabled")) selectAutocompleteItem(item);
    });

    acDropdown.addEventListener("mouseover", (e) => {
      const item = e.target.closest(".autocomplete-item");
      if (item && !item.classList.contains("is-disabled")) setAutocompleteActive(item);
    });

    if (addClientForm) addClientForm.addEventListener("reset", closeAutocomplete);
  }

  // Handle 'Add Client' Form Submission
  if (addClientForm) {
    const addSubmitBtn = addClientForm.querySelector('button[type="submit"]');

    addClientForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (addSubmitBtn && addSubmitBtn.disabled) return; // already submitting

      const clientName = clientSearchInput.value.trim();
      const placement = document.getElementById("placementInput").value;
      const action = document.getElementById("actionInput").value;

      if (!clientName) {
        showAlert("Please enter or select a client name", "#fee2e2", "#991b1b");
        return;
      }

      // Everything on this page identifies people by name, so refuse a duplicate
      if (queueNameSet.has(normalizeName(clientName))) {
        showAlert(`"${clientName}" is already in the waiting room.`, "#fee2e2", "#991b1b");
        return;
      }

      setButtonLoading(addSubmitBtn, true);
      showAlert("Adding client...", "#dbeafe", "#1e40af", { busy: true });

      try {
        const res = await apiFetch("/api/waiting-room/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            name: clientName, 
            placement: placement, 
            action: action 
          })
        });

        if (res.ok) {
          showAlert("Client added to waiting room!", "#dcfce7", "#166534");
          addClientForm.reset();
          placementTouched = false;
          await loadWaitingRoom({ force: true });
        } else {
          const errData = await res.json().catch(() => ({}));
          showAlert(errData.error || errData.message || "Failed to add client", "#fee2e2", "#991b1b");
        }
      } catch (err) {
        if (err.sessionExpired) return;
        console.error("Error submitting add client form:", err);
        showAlert("Server connection error", "#fee2e2", "#991b1b");
      } finally {
        setButtonLoading(addSubmitBtn, false);
      }
    });
  }

  function getPlacementOptionsHTML(selectedValue) {
    const valStr = selectedValue !== null && selectedValue !== undefined ? String(selectedValue).trim() : "";
    let html = `<option value="">--</option>`;
    for (let p = 1; p <= 5; p++) {
      const val = `P${p}`;
      html += `<option value="${val}" ${valStr === val ? 'selected' : ''}>P${p}</option>`;
    }
    for (let i = 1; i <= 25; i++) {
      const val = String(i);
      html += `<option value="${val}" ${valStr === val ? 'selected' : ''}>${i}</option>`;
    }
    html += `<option value="Overflow" ${valStr === 'Overflow' ? 'selected' : ''}>Overflow</option>`;
    return html;
  }

  function getActionOptionsHTML(selectedValue) {
    const actions = ["Pending", "Check-in", "In Progress", "Successful", "No-Show", "Rejected"];
    return actions.map(act => 
      `<option value="${act}" ${selectedValue === act ? 'selected' : ''}>${act}</option>`
    ).join('');
  }

  function applyActionColorClass(selectElement) {
    if (!selectElement) return;
    // Swap only the colour class; keep every other class (e.g. "mob-act-sel") intact
    [...selectElement.classList]
      .filter(c => c.startsWith('action-') && c !== 'action-select')
      .forEach(c => selectElement.classList.remove(c));
    selectElement.classList.add('action-' + selectElement.value.replace(/\s+/g, '-'));
  }

  function sortQueueData(queue) {
    let pRows = [], standardRows = [], overflowRows = [], blankRows = [];

    queue.forEach(item => {
      const name = String(item.Name || '').trim();
      const val = String(item.Placement || '').trim().toUpperCase();

      if (!name) blankRows.push(item);
      else if (val.startsWith('P')) pRows.push(item);
      else if (val === 'OVERFLOW') overflowRows.push(item);
      else standardRows.push(item);
    });

    pRows.sort((a, b) => {
      const getRank = (v) => parseInt(String(v || '').replace(/\D/g, ''), 10) || 99;
      return getRank(a.Placement) - getRank(b.Placement);
    });

    standardRows.sort((a, b) => {
      const numA = parseInt(a.Placement, 10);
      const numB = parseInt(b.Placement, 10);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      if (!isNaN(numA)) return -1;
      if (!isNaN(numB)) return 1;
      return 0;
    });

    return [...pRows, ...standardRows, ...overflowRows, ...blankRows];
  }

  function updateBatchBarState() {
    // Only query desktop checkboxes to avoid duplicating count
    const checkedRows = new Set(
      [...queueTableBody.querySelectorAll("td .row-checkbox:checked")].map(cb => cb.value)
    );
    const count = checkedRows.size;
  
    if (count > 0) {
      if (selectedCountBadge) selectedCountBadge.innerText = `${count} Selected`;
      if (batchActionBar) batchActionBar.classList.add("visible");
    } else {
      if (batchActionBar) batchActionBar.classList.remove("visible");
      if (masterCheckbox) {
        masterCheckbox.checked = false;
        masterCheckbox.indeterminate = false;
      }
    }
  
    const totalRows = new Set(
      [...queueTableBody.querySelectorAll("td .row-checkbox")].map(cb => cb.value)
    );
  
    if (masterCheckbox && totalRows.size > 0) {
      if (count === totalRows.size) {
        masterCheckbox.checked = true;
        masterCheckbox.indeterminate = false;
      } else if (count > 0 && count < totalRows.size) {
        masterCheckbox.checked = false;
        masterCheckbox.indeterminate = true;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Consistency layer
  // The sheet can re-sort / re-index / remove rows when a status or placement
  // changes (and admins can edit the sheet directly), so a row_index captured
  // when the table was drawn can go stale. To keep every change tied to the
  // right PERSON we:
  //   1. run saves one at a time, in order
  //   2. re-look-up the person's current row by NAME right before writing
  //   3. reload the queue after saving so the page matches the sheet
  // ---------------------------------------------------------------------------
  // ---- Activity indicators -------------------------------------------------
  // One source of truth: the top bar + header badge are on whenever a save is
  // queued/running, a queue load is running, or a post-save refresh is waiting.
  function updateActivityIndicator() {
    const active = pendingOps > 0 || loadsInFlight > 0 || refreshPending;
    if (activityBar) activityBar.classList.toggle("active", active);
    if (syncBadge) {
      syncBadge.hidden = !active;
      if (syncBadgeText) {
        syncBadgeText.textContent = pendingOps > 0 ? "Saving changes..." : "Syncing with sheet...";
      }
    }
  }

  function findRowsByName(name) {
    return [...queueTableBody.querySelectorAll("tr[data-client-name]")]
      .filter(tr => tr.dataset.clientName === name);
  }

  function applyBusyState(tr, on) {
    tr.classList.toggle("row-busy", on);
    tr.setAttribute("aria-busy", on ? "true" : "false");
    // Lock this person's dropdowns while their change is in flight
    tr.querySelectorAll("select").forEach(sel => { sel.disabled = on; });
    tr.draggable = !on;
    tr.querySelectorAll(".row-save-state").forEach(label => {
      label.textContent = on ? (rowPhases.get(tr.dataset.clientName) || "Saving…") : "";
    });
  }

  function setRowPhase(name, phase) {
    rowPhases.set(name, phase);
    setRowBusy(name, true);
  }

  function finishQueueSync() {
    syncingNames.forEach(name => {
      setRowBusy(name, false);
      rowPhases.delete(name);
    });
    syncingNames.clear();
  }

  function setRowBusy(name, on) {
    if (!name) return;
    if (on) busyNames.add(name);
    else busyNames.delete(name);
    findRowsByName(name).forEach(tr => applyBusyState(tr, on));
  }

  function flashRow(name, kind) {
    if (!name) return;
    const cls = kind === "ok" ? "row-flash-ok" : "row-flash-err";
    findRowsByName(name).forEach(tr => {
      tr.classList.remove("row-flash-ok", "row-flash-err");
      void tr.offsetWidth; // restart the animation if it is already running
      tr.classList.add(cls);
      setTimeout(() => tr.classList.remove(cls), 1300);
    });
  }

  // Statuses after which the sheet removes the client from the Waiting Room
  const REMOVAL_STATUSES = new Set(["Successful", "Rejected", "No-Show"]);

  function uncheckRowsByName(name) {
    findRowsByName(name).forEach(tr => {
      tr.querySelectorAll(".row-checkbox").forEach(cb => { cb.checked = false; });
    });
    updateBatchBarState();
  }

  // A save was CONFIRMED by the server: show the new status on the row now (don't wait for the
  // sheet re-sync) and take it out of the selection. Failures are left alone on purpose, so they
  // stay selected and can be retried.
  function applySavedStateToRows(name, action) {
    findRowsByName(name).forEach(tr => {
      const desktopAct = tr.querySelector("td .action-select");
      const mobileAct = tr.querySelector(".mob-act-sel");
      [desktopAct, mobileAct].forEach(sel => {
        if (sel) {
          sel.value = action;
          applyActionColorClass(sel);
        }
      });

      const mobLabel = tr.querySelector(".mob-status-label");
      if (mobLabel) {
        mobLabel.innerText = action;
        mobLabel.className = 'mobile-status-tag mob-status-label action-' + action.replace(/\s+/g, '-');
      }

      tr.querySelectorAll(".row-checkbox").forEach(cb => { cb.checked = false; });

      // This client is about to leave the queue: dim it so that is obvious
      if (REMOVAL_STATUSES.has(action)) tr.classList.add("row-leaving");
    });
    updateBatchBarState();
  }

  // Remove a row from the table right away (used after a confirmed delete)
  function removeRowsByName(name) {
    findRowsByName(name).forEach(tr => {
      tr.classList.add("row-removing");
      setTimeout(() => {
        tr.remove();
        updateBatchBarState();
      }, 260);
    });
  }

  function setButtonLoading(btn, on) {
    if (!btn) return;
    btn.classList.toggle("is-loading", on);
    btn.disabled = on;
    btn.setAttribute("aria-busy", on ? "true" : "false");
  }

  function normalizeName(value) {
    return String(value || "").trim().toLowerCase();
  }

  function enqueue(job) {
    loadSeq++; // invalidate reads started before this edit
    pendingOps++;
    updateActivityIndicator();
    const result = opChain.then(() => job());
    opChain = result.catch(() => {}).then(() => {
      pendingOps--;
      updateActivityIndicator();
    });
    return result;
  }

  async function fetchQueue() {
    const res = await apiFetch("/api/waiting-room");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load queue");
    return data.queue || [];
  }

  // Find a client's CURRENT sheet row by name (using the remembered row as a tie-breaker)
  async function resolveRowIndex(name, hintIndex) {
    const queue = await fetchQueue();
    const target = normalizeName(name);
    const matches = queue.filter(r => normalizeName(r.Name) === target);

    if (matches.length === 0) return { status: "missing" };

    const exact = matches.find(r => r.row_index === hintIndex);
    if (exact) return { status: "ok", row_index: exact.row_index };
    if (matches.length === 1) return { status: "ok", row_index: matches[0].row_index };

    return { status: "ambiguous" };
  }

  async function persistUpdate({ name, rowIndex, placement, action }) {
    // Flask and Apps Script both resolve the current row by name before writing.
    // A separate browser GET adds latency without making that check safer.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await apiFetch("/api/waiting-room/update", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          row_index: rowIndex,
          name: name,
          placement: placement,
          action: action
        })
      });

      const body = await res.json();
      if (res.ok) return { ok: true, note: body.note || "" };
      return { ok: false, reason: "http", message: body.error || "" };
    } finally {
      clearTimeout(timeout);
    }
  }

  function describeFailure(result) {
    const reason = result && result.reason;
    if (reason === "missing") return "That client is no longer in the queue. Refreshing...";
    if (reason === "ambiguous") return "More than one client has that name, so nothing was saved. Edit it in the sheet.";
    return (result && result.message) || "Update failed";
  }

  function scheduleRefresh(delay = REFRESH_AFTER_SAVE_MS, force = false) {
    refreshForce = refreshForce || force;
    refreshPending = true;
    updateActivityIndicator();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      // Never rebuild the table while saves are running or a row is being dragged
      if (pendingOps > 0 || draggedRow) {
        scheduleRefresh(500);
        return;
      }
      const forceNow = refreshForce;
      refreshForce = false;
      refreshPending = false;
      await loadWaitingRoom({ force: forceNow }); // keeps the indicator on while it loads
    }, delay);
  }

  function autoSaveSingleParticipant(tr, changedField) {
    const rawRowIndex = tr.dataset.rowIndex;
    const rowIndex = parseInt(rawRowIndex, 10);
    const clientName = tr.dataset.clientName || "";
    const placement = changedField === "action" ? undefined : tr.querySelector(".placement-select").value;
    const action = changedField === "placement" ? undefined : tr.querySelector(".action-select").value;
  
    if (isNaN(rowIndex) && !clientName) {
      console.error("Invalid row index or name for auto-save:", rawRowIndex, clientName);
      showAlert("Error saving: Invalid Client Data", "#fee2e2", "#991b1b");
      return;
    }

    // Release focus from the dropdown so background sync isn't blocked by it
    if (document.activeElement && document.activeElement.tagName === "SELECT") {
      document.activeElement.blur();
    }
  
    const mobPlacement = tr.querySelector(".mob-place-label");
    const mobAction = tr.querySelector(".mob-status-label");
    if (mobPlacement && placement !== undefined) mobPlacement.innerText = `${placement || '-'}.`;
    if (mobAction && action !== undefined) {
      mobAction.innerText = action;
      mobAction.className = 'mobile-status-tag mob-status-label action-' + action.replace(/\s+/g, '-');
    }

    // Spinner on this row right away (even if the save is queued behind another one)
    setRowPhase(clientName, pendingOps > 0 ? "Queued…" : "Saving…");
  
    return enqueue(async () => {
      setRowPhase(clientName, "Saving…");
      const slowTimer = setTimeout(() => setRowPhase(clientName, "Still saving…"), 8000);
      try {
        const result = await persistUpdate({ name: clientName, rowIndex, placement, action });
        if (result.ok) {
          showAlert(result.note || "Saved. Refreshing queue…", "#dbeafe", "#1e40af");
          scheduleRefresh(REFRESH_AFTER_SAVE_MS, true);
        } else {
          showAlert(describeFailure(result), "#fee2e2", "#991b1b");
          flashRow(clientName, "err");
          scheduleRefresh(300, true);      // put the screen back in line with the sheet
        }
      } catch (err) {
        if (err.sessionExpired) return;
        console.error("Auto-save error:", err);
        showAlert("Save could not be confirmed. Refreshing the queue before you retry.", "#fee2e2", "#991b1b");
        flashRow(clientName, "err");
        scheduleRefresh(300, true);
      } finally {
        clearTimeout(slowTimer);
        syncingNames.add(clientName);
        setRowPhase(clientName, "Refreshing queue…");
      }
    });
  }

  // Helper to determine if a placement warrants the green pulse animation
  function shouldPlacementPulse(placement) {
    const val = String(placement || '').trim();
    
    // Strictly matches P1, P2, P3, P4, P5 (or any 'P' followed by digits, like P12)
    return /^P\d+$/i.test(val);
  }

  async function loadWaitingRoom({ force = false, silent = false } = {}) {
    if (pendingOps > 0 || draggedRow) {
      if (!silent) scheduleRefresh(100, force);
      return;
    }
    const seq = ++loadSeq;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    // silent = background poll: don't flash the progress indicator every 30s
    if (!silent) {
      loadsInFlight++;
      updateActivityIndicator();
    }
    try {
      const res = await apiFetch("/api/waiting-room", { signal: controller.signal, cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load queue");
      if (seq !== loadSeq || pendingOps > 0 || draggedRow) return;
      finishQueueSync();

      const queue = data.queue || [];
      queueNameSet = new Set(queue.map(r => normalizeName(r.Name)).filter(Boolean));
      autoSetNextPlacement(queue);

      const sortedQueue = sortQueueData(queue);

      // Nothing changed since the last draw -> leave the table alone (keeps dropdowns/selection intact)
      const signature = sortedQueue
        .map(r => [r.row_index, r.Name, r.Placement, r.Action].join("|"))
        .join("\n");
      if (!force && signature === lastQueueSignature) return;
      lastQueueSignature = signature;

      // Remember UI state (by client name) so a refresh doesn't wipe it
      const selectedNames = new Set();
      const openDrawerNames = new Set();
      queueTableBody.querySelectorAll("tr[data-client-name]").forEach(existing => {
        const cb = existing.querySelector("td .row-checkbox");
        if (cb && cb.checked) selectedNames.add(existing.dataset.clientName);
        const drawer = existing.querySelector(".mobile-edit-drawer");
        if (drawer && drawer.classList.contains("open")) openDrawerNames.add(existing.dataset.clientName);
      });

      queueTableBody.innerHTML = "";
      if (sortedQueue.length === 0) {
        queueTableBody.innerHTML = `<tr><td colspan="5" class="table-loading">No clients currently in waiting room.</td></tr>`;
        updateBatchBarState();
        return;
      }

      sortedQueue.forEach((row) => {
        const tr = document.createElement("tr");
        tr.draggable = true;
        tr.dataset.rowIndex = row.row_index;
        tr.dataset.clientName = row.Name || '';

        const currentAction = row.Action || 'Pending';
        const actionClass = 'action-' + currentAction.replace(/\s+/g, '-').replace(/[^\w-]/g, '');
        const currentPlacement = row.Placement || '';

        // Determine initial pulse class state
        const isPulsing = shouldPlacementPulse(currentPlacement);
        const pulseClass = isPulsing ? 'queue-name-pulse' : '';

        tr.innerHTML = `
          <td class="drag-handle" style="cursor: grab;">⋮⋮</td>
          <td><input type="checkbox" class="row-checkbox" value="${row.row_index}"></td>
          <td class="${pulseClass}" style="font-weight: 600; color: #0f172a;">${escapeHtml(row.Name)}<span class="row-spinner" aria-hidden="true"></span><span class="row-save-state" role="status"></span></td>
          <td>
            <select class="form-control form-control-sm placement-select" style="min-width: 90px;">
              ${getPlacementOptionsHTML(currentPlacement)}
            </select>
          </td>
          <td>
            <select class="form-control form-control-sm action-select ${actionClass}" style="min-width: 125px;">
              ${getActionOptionsHTML(currentAction)}
            </select>
          </td>

          <div class="mobile-card-summary">
            <div class="mobile-card-info" onclick="toggleMobileDrawer(this)">
              <span class="mobile-placement-tag mob-place-label">${currentPlacement ? escapeHtml(currentPlacement) + '.' : '-.'}</span>
              <span class="${pulseClass}">${escapeHtml(row.Name)}<span class="row-spinner" aria-hidden="true"></span><span class="row-save-state" role="status"></span></span>
              <span class="mobile-status-tag mob-status-label ${actionClass}">${escapeHtml(currentAction)}</span>
            </div>
            <input type="checkbox" class="row-checkbox mobile-cb" value="${row.row_index}">
          </div>

          <div class="mobile-edit-drawer">
            <div class="mobile-drawer-grid">
              <div>
                <label>Placement</label>
                <select class="form-control form-control-sm placement-select mob-place-sel">
                  ${getPlacementOptionsHTML(currentPlacement)}
                </select>
              </div>
              <div>
                <label>Status</label>
                <select class="form-control form-control-sm action-select mob-act-sel ${actionClass}">
                  ${getActionOptionsHTML(currentAction)}
                </select>
              </div>
            </div>
          </div>
        `;

        const desktopPlace = tr.querySelector('td .placement-select');
        const mobilePlace = tr.querySelector('.mob-place-sel');
        const desktopAct = tr.querySelector('td .action-select');
        const mobileAct = tr.querySelector('.mob-act-sel');

        // References for live pulse updating
        const desktopNameTd = tr.querySelector('td:nth-child(3)');
        const mobileNameSpan = tr.querySelector('.mobile-card-info > span:nth-child(2)');

        function updateNameGlow(placementVal) {
          const active = shouldPlacementPulse(placementVal);
          if (desktopNameTd) desktopNameTd.classList.toggle('queue-name-pulse', active);
          if (mobileNameSpan) mobileNameSpan.classList.toggle('queue-name-pulse', active);
        }

        desktopPlace.addEventListener('change', () => {
          mobilePlace.value = desktopPlace.value;
          updateNameGlow(desktopPlace.value);
          autoSaveSingleParticipant(tr, "placement");
        });
        mobilePlace.addEventListener('change', () => {
          desktopPlace.value = mobilePlace.value;
          updateNameGlow(mobilePlace.value);
          autoSaveSingleParticipant(tr, "placement");
        });

        desktopAct.addEventListener('change', () => {
          mobileAct.value = desktopAct.value;
          applyActionColorClass(desktopAct);
          applyActionColorClass(mobileAct);
          autoSaveSingleParticipant(tr, "action");
        });
        mobileAct.addEventListener('change', () => {
          desktopAct.value = mobileAct.value;
          applyActionColorClass(desktopAct);
          applyActionColorClass(mobileAct);
          autoSaveSingleParticipant(tr, "action");
        });

        const desktopCb = tr.querySelector('td .row-checkbox');
        const mobileCb = tr.querySelector('.mobile-cb');
        desktopCb.addEventListener('change', () => {
          mobileCb.checked = desktopCb.checked;
          updateBatchBarState();
        });
        mobileCb.addEventListener('change', () => {
          desktopCb.checked = mobileCb.checked;
          updateBatchBarState();
        });

        // Restore selection / open drawer from before the refresh
        if (selectedNames.has(row.Name || '')) {
          desktopCb.checked = true;
          mobileCb.checked = true;
        }
        if (openDrawerNames.has(row.Name || '')) {
          tr.querySelector('.mobile-edit-drawer').classList.add('open');
        }

        // A save for this client is still in flight: keep showing its spinner
        if (busyNames.has(row.Name || '')) applyBusyState(tr, true);

        // Desktop HTML5 drag event handlers
        tr.addEventListener("dragstart", (e) => {
          if (pendingOps > 0 || refreshPending || syncingNames.size > 0 || loadsInFlight > 0) {
            e.preventDefault();
            return;
          }
          loadSeq++;
          draggedRow = tr;
          tr.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", ""); // Required by Firefox to initiate dragging
        });

        tr.addEventListener("dragend", async () => {
          tr.classList.remove("dragging");
          const saving = updatePlacementsAfterReorder();
          draggedRow = null;
          await saving;
        });

        attachMobilePressAndHold(tr);
        queueTableBody.appendChild(tr);
      });

      updateBatchBarState();
      applyTableFilter();

    } catch (err) {
      if (seq !== loadSeq) return;
      finishQueueSync();
      lastQueueSignature = null; // next successful refresh must restore unsaved controls
      console.error("Error loading waiting room:", err);

      if (queueTableBody.querySelector("tr[data-client-name]")) {
        // Keep showing the last good data instead of wiping the table on a hiccup
        showAlert("Couldn't refresh the queue. Showing last known data.", "#fee2e2", "#991b1b");
      } else {
        lastQueueSignature = null;
        queueTableBody.innerHTML = `<tr><td colspan="5" class="table-loading" style="color: #ef4444;">Failed to load queue.</td></tr>`;
      }
    } finally {
      clearTimeout(timeout);
      if (!silent) {
        loadsInFlight--;
        updateActivityIndicator();
      }
    }
  }

  async function loadLogs() {
    if (!logsTableBody) return;
    try {
      const res = await apiFetch("/api/logs");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load logs");

      if (!data.logs || data.logs.length === 0) {
        logsTableBody.innerHTML = `<tr><td colspan="6" class="table-loading">No activity log entries found.</td></tr>`;
        return;
      }

      logsTableBody.innerHTML = "";
      data.logs.forEach(row => {
        const statusClass = 'action-' + String(row['Status'] || '').replace(/\s+/g, '-').replace(/[^\w-]/g, '');
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(row['Submission Time']) || '-'}</td>
          <td style="font-weight: 600; color: #0f172a;">${escapeHtml(row['Name']) || '-'}</td>
          <td>${escapeHtml(row['Tattoo Session Date']) || '-'}</td>
          <td>
            <span class="mobile-status-tag ${statusClass}">${escapeHtml(row['Status']) || '-'}</span>
          </td>
          <td style="color: #64748b; font-size: 0.85rem;">${escapeHtml(row['Reviewed By']) || '-'}</td>
          <td style="color: #64748b; font-size: 0.85rem;">${escapeHtml(row['Reviewed At']) || '-'}</td>
        `;
        logsTableBody.appendChild(tr);
      });
    } catch (err) {
      console.error("Error loading logs:", err);
      logsTableBody.innerHTML = `<tr><td colspan="6" class="table-loading" style="color: #ef4444;">Failed to load activity logs.</td></tr>`;
    }
  }

  function attachMobilePressAndHold(tr) {
    let holdTimer = null;
    let isHolding = false;

    tr.addEventListener('touchstart', (e) => {
      if (pendingOps > 0 || refreshPending || syncingNames.size > 0 || loadsInFlight > 0) return;
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;

      holdTimer = setTimeout(() => {
        if (pendingOps > 0 || refreshPending || syncingNames.size > 0 || loadsInFlight > 0) return;
        loadSeq++;
        isHolding = true;
        draggedRow = tr;
        tr.classList.add('mobile-holding', 'dragging');
        if (navigator.vibrate) navigator.vibrate(50);
      }, 400);
    }, { passive: true });

    tr.addEventListener('touchmove', (e) => {
      if (!isHolding) {
        clearTimeout(holdTimer);
        return;
      }
      e.preventDefault();
      const touchLocation = e.touches[0];
      const afterElement = getDragAfterElement(queueTableBody, touchLocation.clientY);
      if (afterElement == null) {
        queueTableBody.appendChild(draggedRow);
      } else {
        queueTableBody.insertBefore(draggedRow, afterElement);
      }
    }, { passive: false });

    tr.addEventListener('touchend', async () => {
      clearTimeout(holdTimer);
      if (isHolding) {
        tr.classList.remove('mobile-holding', 'dragging');
        isHolding = false;
        const saving = updatePlacementsAfterReorder();
        draggedRow = null;
        await saving;
      }
    });

    tr.addEventListener('touchcancel', () => {
      clearTimeout(holdTimer);
      if (!isHolding) return;
      isHolding = false;
      tr.classList.remove('mobile-holding', 'dragging');
      draggedRow = null;
      scheduleRefresh(100, true);
    });
  }

  async function updatePlacementsAfterReorder() {
    if (!draggedRow) return;
  
    const rows = [...queueTableBody.querySelectorAll("tr")];
    const newIndex = rows.indexOf(draggedRow);
  
    if (newIndex === -1) return;
  
    let newPlacement = String(newIndex + 1);
  
    // If dragged to top
    if (newIndex === 0) {
      newPlacement = "1";
    } else {
      const rowAbove = rows[newIndex - 1];
      const aboveValStr = rowAbove ? (rowAbove.querySelector(".placement-select")?.value || "").toUpperCase() : "";
  
      if (aboveValStr.startsWith("P")) {
        // If dropped directly below a Priority row, default to position 1
        newPlacement = "1";
      } else {
        const aboveVal = parseInt(aboveValStr, 10);
        if (!isNaN(aboveVal)) {
          newPlacement = String(aboveVal + 1);
        }
      }
    }
  
    const placementSelect = draggedRow.querySelector(".placement-select");
    const mobPlacementLabel = draggedRow.querySelector(".mob-place-label");
    const mobPlacementSelect = draggedRow.querySelector(".mob-place-sel");
    const rowIndex = parseInt(draggedRow.dataset.rowIndex, 10);
    const clientName = draggedRow.dataset.clientName || "";
  
    if (placementSelect && placementSelect.value !== newPlacement) {
      placementSelect.value = newPlacement;
      if (mobPlacementSelect) mobPlacementSelect.value = newPlacement;
      if (mobPlacementLabel) mobPlacementLabel.innerText = `${newPlacement}.`;
  
      setRowPhase(clientName, "Saving…");
      await enqueue(async () => {
        const slowTimer = setTimeout(() => setRowPhase(clientName, "Still saving…"), 8000);
        try {
          const result = await persistUpdate({ name: clientName, rowIndex, placement: newPlacement });
          if (result.ok) {
            showAlert(result.note || "Saved. Refreshing queue…", "#dbeafe", "#1e40af");
            scheduleRefresh(REFRESH_AFTER_SAVE_MS, true);
          } else {
            showAlert(describeFailure(result), "#fee2e2", "#991b1b");
            flashRow(clientName, "err");
            scheduleRefresh(300, true);
          }
        } catch (err) {
          if (err.sessionExpired) return;
          console.error("Failed to update dragged row position:", err);
          showAlert("Save could not be confirmed. Refreshing the queue before you retry.", "#fee2e2", "#991b1b");
          flashRow(clientName, "err");
          scheduleRefresh(300, true);
        } finally {
          clearTimeout(slowTimer);
          syncingNames.add(clientName);
          setRowPhase(clientName, "Refreshing queue…");
        }
      });
    } else {
      // Dropped somewhere that doesn't change its placement: snap back to the sheet's order
      scheduleRefresh(200, true);
    }
  }
  
  function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('tr:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  if (masterCheckbox) {
    masterCheckbox.addEventListener("change", function() {
      queueTableBody.querySelectorAll(".row-checkbox").forEach(cb => cb.checked = masterCheckbox.checked);
      updateBatchBarState();
    });
  }

  if (clearSelectionBtn) {
    clearSelectionBtn.addEventListener("click", () => {
      queueTableBody.querySelectorAll(".row-checkbox").forEach(cb => cb.checked = false);
      updateBatchBarState();
    });
  }

  const applyBulkBtn = document.getElementById("applyBulkActionBtn");
  const deleteSelectedBtn = document.getElementById("deleteSelectedBtn");
  const bulkActionSelect = document.getElementById("bulkActionSelect");

  // Lock the batch bar while a bulk job runs; the pressed button shows a spinner
  function setBatchBusy(on, activeBtn) {
    [applyBulkBtn, deleteSelectedBtn, clearSelectionBtn, bulkActionSelect].forEach(el => {
      if (el) el.disabled = on;
    });
    if (activeBtn) setButtonLoading(activeBtn, on);
  }

  if (applyBulkBtn) {
    applyBulkBtn.addEventListener("click", () => {
      const actionVal = bulkActionSelect.value;
      if (!actionVal) return alert("Please select a status action.");

      const selectedRows = [...queueTableBody.querySelectorAll("td .row-checkbox:checked")].map(cb => {
        const tr = cb.closest("tr");
        return {
          row_index: parseInt(tr.dataset.rowIndex, 10),
          name: tr.dataset.clientName || "",
          placement: tr.querySelector(".placement-select").value,
          action: actionVal
        };
      });

      if (selectedRows.length === 0) return;

      const total = selectedRows.length;
      let done = 0;

      setBatchBusy(true, applyBulkBtn);
      selectedRows.forEach(item => setRowBusy(item.name, true));
      showAlert(`Updating 0 of ${total}...`, "#dbeafe", "#1e40af", { busy: true, progress: 0 });

      enqueue(async () => {
        let failed = 0;
        let gone = 0;
        try {
          for (const item of selectedRows) {
            // Each item is looked up by name at the moment it is saved, because
            // the previous item's change may already have re-sorted/removed rows.
            const result = await persistUpdate({
              name: item.name,
              rowIndex: item.row_index,
              placement: item.placement,
              action: item.action
            });
            done++;
            setRowBusy(item.name, false);

            if (result.ok) {
              // Confirmed: new status on screen + out of the selection, right now
              applySavedStateToRows(item.name, item.action);
              flashRow(item.name, "ok");
            } else if (result.reason === "missing") {
              gone++;
              uncheckRowsByName(item.name);
            } else {
              // Stays selected (and flashes red) so it can be retried
              failed++;
              flashRow(item.name, "err");
            }
            showAlert(`Updating ${done} of ${total}...`, "#dbeafe", "#1e40af", { busy: true, progress: done / total });
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        } catch (err) {
          if (err.sessionExpired) return;
          console.error("Bulk update error:", err);
          showAlert("Bulk update interrupted. Reloading queue...", "#fee2e2", "#991b1b");
          scheduleRefresh(300, true);
          return;
        } finally {
          selectedRows.forEach(item => setRowBusy(item.name, false));
          setBatchBusy(false, applyBulkBtn);
        }

        scheduleRefresh(REFRESH_AFTER_SAVE_MS, true);
        if (failed || gone) {
          const parts = [];
          if (failed) parts.push(`${failed} failed`);
          if (gone) parts.push(`${gone} no longer in the queue`);
          const retryNote = failed ? " (failed rows stay selected so you can retry)" : "";
          showAlert(`Bulk update finished: ${parts.join(", ")}${retryNote}`, "#fee2e2", "#991b1b");
        } else {
          showAlert("Selected status updated!", "#dcfce7", "#166534");
          bulkActionSelect.value = ""; // all clean: ready for the next batch
        }
      });
    });
  }

  if (deleteSelectedBtn) {
    deleteSelectedBtn.addEventListener("click", () => {
      const selectedClients = [...queueTableBody.querySelectorAll("td .row-checkbox:checked")].map(cb => {
        const tr = cb.closest("tr");
        return {
          row_index: parseInt(tr.dataset.rowIndex, 10),
          name: tr.dataset.clientName || ""
        };
      });

      if (selectedClients.length === 0) return;

      selectedClients.sort((a, b) => (b.row_index || 0) - (a.row_index || 0));

      if (!confirm(`Are you sure you want to delete ${selectedClients.length} client(s)?`)) return;

      const total = selectedClients.length;
      let done = 0;

      setBatchBusy(true, deleteSelectedBtn);
      selectedClients.forEach(client => setRowBusy(client.name, true));
      showAlert(`Deleting 0 of ${total}...`, "#fee2e2", "#991b1b", { busy: true, progress: 0 });

      enqueue(async () => {
        let failed = 0;
        try {
          for (const client of selectedClients) {
            let targetRow = client.row_index;
            let outcome = "pending"; // pending -> deleted | gone | failed

            // Look the person up by name right now, so a shifted sheet can't make us delete someone else
            if (client.name) {
              const found = await resolveRowIndex(client.name, client.row_index);
              if (found.status === "missing") outcome = "gone";            // already gone
              else if (found.status === "ambiguous") { failed++; outcome = "failed"; }
              else targetRow = found.row_index;
            }

            if (outcome === "pending") {
              const res = await apiFetch("/api/waiting-room/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                  row_index: targetRow, 
                  name: client.name 
                })
              });
              if (res.ok) outcome = "deleted";
              else { failed++; outcome = "failed"; }
              await new Promise(resolve => setTimeout(resolve, 100));
            }

            done++;
            setRowBusy(client.name, false);

            if (outcome === "deleted" || outcome === "gone") {
              removeRowsByName(client.name);   // a delete is certain, so drop the row now
            } else {
              flashRow(client.name, "err");    // stays selected so it can be retried
            }
            showAlert(`Deleting ${done} of ${total}...`, "#fee2e2", "#991b1b", { busy: true, progress: done / total });
          }
        } catch (err) {
          if (err.sessionExpired) return;
          console.error("Bulk delete error:", err);
          showAlert("Delete interrupted. Reloading queue...", "#fee2e2", "#991b1b");
          scheduleRefresh(300, true);
          return;
        } finally {
          selectedClients.forEach(client => setRowBusy(client.name, false));
          setBatchBusy(false, deleteSelectedBtn);
        }

        scheduleRefresh(300, true);
        if (failed) {
          showAlert(`${failed} of ${total} deletions failed (duplicate names must be removed in the sheet)`, "#fee2e2", "#991b1b");
        } else {
          showAlert("Selected row(s) deleted successfully!", "#dcfce7", "#166534");
        }
      });
    });
  }

  const tableSearch = document.getElementById("tableSearch");

  // Filter on the row's real values (name, placement, status). The old version used
  // innerText, which also matched the hidden <option> labels, so e.g. "rejected"
  // matched every row.
  function applyTableFilter() {
    if (!tableSearch) return;
    const term = tableSearch.value.toLowerCase().trim();
    queueTableBody.querySelectorAll("tr").forEach(tr => {
      let text;
      if (tr.dataset.clientName !== undefined) {
        const place = tr.querySelector(".placement-select");
        const act = tr.querySelector(".action-select");
        text = [tr.dataset.clientName, place ? place.value : "", act ? act.value : ""].join(" ").toLowerCase();
      } else {
        text = tr.innerText.toLowerCase(); // loading / empty-state rows
      }
      tr.style.display = text.includes(term) ? "" : "none";
    });
  }

  if (tableSearch) tableSearch.addEventListener("input", applyTableFilter);

  // opts.busy     -> show a spinner and keep the banner up until the next message replaces it
  // opts.progress -> 0..1, draws a thin progress bar under the text
  function showAlert(msg, bg, color, opts = {}) {
    if (!statusAlert) return;

    statusAlert.textContent = "";

    if (opts.busy) {
      const spinner = document.createElement("span");
      spinner.className = "alert-spinner";
      spinner.setAttribute("aria-hidden", "true");
      statusAlert.appendChild(spinner);
    }

    statusAlert.appendChild(document.createTextNode(msg));

    if (typeof opts.progress === "number") {
      const track = document.createElement("span");
      track.className = "alert-progress";
      const fill = document.createElement("span");
      fill.style.width = Math.round(Math.max(0, Math.min(1, opts.progress)) * 100) + "%";
      track.appendChild(fill);
      statusAlert.appendChild(track);
    }

    statusAlert.style.backgroundColor = bg;
    statusAlert.style.color = color;
    statusAlert.style.display = "block";

    clearTimeout(alertTimer);
    if (!opts.busy) {
      alertTimer = setTimeout(() => { statusAlert.style.display = "none"; }, 3500);
    }
  }

  // --- Client Name Pulse Logic ---
  const placementInputEl = document.getElementById("placementInput");

  function checkPlacementGlow() {
    if (!clientSearchInput || !placementInputEl) return;
    const val = placementInputEl.value.trim();

    // Pulses if placement is Priority (P1-P5), Numeric (1-25), or Overflow
    const isPriorityOrNumeric = /^P?\d+$/i.test(val) || val.toLowerCase() === "overflow";

    if (isPriorityOrNumeric) {
      clientSearchInput.classList.add("placement-pulse");
    } else {
      clientSearchInput.classList.remove("placement-pulse");
    }
  }

  function autoSetNextPlacement(queueData) {
    if (!placementInputEl) return;

    // Don't overwrite a placement the admin picked by hand while a refresh happens
    if (placementTouched) return;

    let maxPlacement = 0;

    if (Array.isArray(queueData)) {
      queueData.forEach(item => {
        const val = parseInt(item.Placement, 10);
        if (!isNaN(val) && val > maxPlacement) {
          maxPlacement = val;
        }
      });
    }

    const next = maxPlacement + 1;
    placementInputEl.value = next <= 25 ? String(next) : "Overflow";

    // Trigger glow check after programmatically updating placement value
    checkPlacementGlow();
  }

  if (placementInputEl) {
    placementInputEl.addEventListener("change", () => {
      placementTouched = true;
      checkPlacementGlow();
    });
    placementInputEl.addEventListener("input", checkPlacementGlow);
  }

  // Background sync: pick up changes made in the Google Sheet or by another admin
  setInterval(() => {
    if (document.hidden) return;
    if (pendingOps > 0 || draggedRow) return;

    const active = document.activeElement;
    if (active && active.tagName === "SELECT" && queueTableBody.contains(active)) return; // don't close an open dropdown

    loadWaitingRoom({ silent: true });
    loadLogs();
  }, AUTO_REFRESH_MS);

  // Initialize page data
  loadWaitingRoom({ force: true });
  loadLogs();
});
