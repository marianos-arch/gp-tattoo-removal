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
  const clientList = document.getElementById("clientList");
  const addClientForm = document.getElementById("addClientForm");
  const logsTableBody = document.getElementById("logsTableBody");
  const masterCheckbox = document.getElementById("masterCheckbox");
  const statusAlert = document.getElementById("statusAlert");
  const batchActionBar = document.getElementById("batchActionBar");
  const selectedCountBadge = document.getElementById("selectedCountBadge");
  const clearSelectionBtn = document.getElementById("clearSelectionBtn");
  
  let draggedRow = null;
  let cachedClients = [];
  let alertTimer = null;

  // Consistency-layer state (see "Consistency layer" below)
  const REFRESH_AFTER_SAVE_MS = 1500;  // wait for the sheet/Apps Script to finish re-sorting or removing rows
  const AUTO_REFRESH_MS = 30000;       // background sync with the sheet
  let opChain = Promise.resolve();     // saves run one at a time, in order
  let pendingOps = 0;                  // saves / bulk jobs queued or running
  let refreshTimer = null;
  let refreshForce = false;
  let loadSeq = 0;                     // lets a newer queue load supersede an older one
  let lastQueueSignature = null;       // skip re-rendering when nothing changed
  let placementTouched = false;        // don't overwrite a placement the admin picked by hand

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

  // Preload initial client cache / popular suggestions safely
  async function preloadClientCache() {
    if (!clientList) return;
    
    try {
      const res = await apiFetch('/api/clients/search?q=');
      if (!res.ok) {
        console.error("Failed to fetch clients list:", res.status);
        return;
      }  
  
      const data = await res.json();
      
      const rawClients = Array.isArray(data) ? data : (data.results || data.clients || data.data || []);
      
      cachedClients = rawClients.map(item => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null) {
          return item.Name || item.name || item.Client_Name || item.client_name || item.full_name || '';
        }
        return '';
      }).filter(Boolean);  
  
      updateDatalist(cachedClients);
    } catch (err) {
      console.error("Error preloading client cache:", err);
    }
  }

  // Helper to update datalist options
  function updateDatalist(names) {
    if (!clientList) return;
    clientList.innerHTML = "";
    const fragment = document.createDocumentFragment();
    names.forEach(name => {
      const option = document.createElement("option");
      option.value = name;
      fragment.appendChild(option);
    });
    clientList.appendChild(fragment);
  }

  // Debounce helper to prevent flooding the backend on every keypress
  function debounce(func, delay = 300) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => func.apply(this, args), delay);
    };
  }

  // Dynamic live search with fallback to cached options + debounced fetch
  if (clientSearchInput) {
    // Show initial cached list when input field gains focus
    clientSearchInput.addEventListener("focus", () => {
      if (cachedClients.length > 0 && (!clientList.children || clientList.children.length === 0)) {
        updateDatalist(cachedClients);
      }
    });

    clientSearchInput.addEventListener("input", function(e) {
      if (e.inputType === "insertReplacementText" || e.inputType === "insertFromText") return;

      const searchTerm = this.value.trim().toLowerCase();

      // Show instant filter from preloaded cache if search term is less than 3 chars
      if (searchTerm.length < 3) {
        if (cachedClients.length > 0) {
          const filtered = cachedClients.filter(name => name.toLowerCase().includes(searchTerm));
          updateDatalist(filtered);
        }
        return;
      }

      // Execute debounced backend search for 3+ characters
      debouncedSearch(searchTerm);
    });

    const debouncedSearch = debounce(async (searchTerm) => {
      try {
        const res = await apiFetch(`/api/clients/search?q=${encodeURIComponent(searchTerm)}`);
        if (!res.ok) {
          console.warn(`[Search Fetch] Request failed with HTTP ${res.status}`);
          return;
        }

        const data = await res.json();
        const rawClients = Array.isArray(data) ? data : (data.results || data.clients || data.data || []);

        const results = rawClients.map(item => {
          if (typeof item === 'string') return item;
          if (typeof item === 'object' && item !== null) {
            return item.Name || item.name || item.Client_Name || item.client_name || '';
          }
          return '';
        }).filter(Boolean);

        updateDatalist(results);
      } catch (err) {
        console.error("[Search Fetch] Network/Parse Error:", err);
      }
    }, 300);
  }

  // Handle 'Add Client' Form Submission
  if (addClientForm) {
    addClientForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const clientName = clientSearchInput.value.trim();
      const placement = document.getElementById("placementInput").value;
      const action = document.getElementById("actionInput").value;

      if (!clientName) {
        showAlert("Please enter or select a client name", "#fee2e2", "#991b1b");
        return;
      }

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
        console.error("Error submitting add client form:", err);
        showAlert("Server connection error", "#fee2e2", "#991b1b");
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
    selectElement.className = 'form-control form-control-sm action-select action-' + selectElement.value.replace(/\s+/g, '-');
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
  function normalizeName(value) {
    return String(value || "").trim().toLowerCase();
  }

  function enqueue(job) {
    pendingOps++;
    const result = opChain.then(() => job());
    opChain = result.catch(() => {}).then(() => { pendingOps--; });
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
    let targetRow = rowIndex;

    if (name) {
      const found = await resolveRowIndex(name, rowIndex);
      if (found.status !== "ok") return { ok: false, reason: found.status };
      targetRow = found.row_index;
    }

    const res = await apiFetch("/api/waiting-room/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        row_index: targetRow,
        name: name,
        placement: placement,
        action: action
      })
    });

    return res.ok ? { ok: true } : { ok: false, reason: "http" };
  }

  function describeFailure(reason) {
    if (reason === "missing") return "That client is no longer in the queue. Refreshing...";
    if (reason === "ambiguous") return "More than one client has that name, so nothing was saved. Edit it in the sheet.";
    return "Update failed";
  }

  function scheduleRefresh(delay = REFRESH_AFTER_SAVE_MS, force = false) {
    refreshForce = refreshForce || force;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      // Never rebuild the table while saves are running or a row is being dragged
      if (pendingOps > 0 || draggedRow) {
        scheduleRefresh(500);
        return;
      }
      const forceNow = refreshForce;
      refreshForce = false;
      await loadWaitingRoom({ force: forceNow });
    }, delay);
  }

  function autoSaveSingleParticipant(tr) {
    const rawRowIndex = tr.dataset.rowIndex;
    const rowIndex = parseInt(rawRowIndex, 10);
    const clientName = tr.dataset.clientName || "";
    const placement = tr.querySelector(".placement-select").value;
    const action = tr.querySelector(".action-select").value;
  
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
    if (mobPlacement) mobPlacement.innerText = `${placement || '-'}.`;
    if (mobAction) {
      mobAction.innerText = action;
      mobAction.className = 'mobile-status-tag action-' + action.replace(/\s+/g, '-');
    }
  
    return enqueue(async () => {
      try {
        const result = await persistUpdate({ name: clientName, rowIndex, placement, action });
        if (result.ok) {
          showAlert("Updated!", "#dcfce7", "#166534");
          scheduleRefresh();               // pick up any re-sort / removal done by the sheet
        } else {
          showAlert(describeFailure(result.reason), "#fee2e2", "#991b1b");
          scheduleRefresh(300, true);      // put the screen back in line with the sheet
        }
      } catch (err) {
        if (err.sessionExpired) return;
        console.error("Auto-save error:", err);
        showAlert("Network error during save", "#fee2e2", "#991b1b");
        scheduleRefresh(300, true);
      }
    });
  }

  async function loadWaitingRoom({ force = false } = {}) {
    const seq = ++loadSeq;
    try {
      const res = await apiFetch("/api/waiting-room");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load queue");
      if (seq !== loadSeq) return; // a newer load has superseded this one

      const queue = data.queue || [];
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

        tr.innerHTML = `
          <td class="drag-handle" style="cursor: grab;">⋮⋮</td>
          <td><input type="checkbox" class="row-checkbox" value="${row.row_index}"></td>
          <td style="font-weight: 600; color: #0f172a;">${escapeHtml(row.Name)}</td>
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
              <span>${escapeHtml(row.Name)}</span>
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

        desktopPlace.addEventListener('change', () => {
          mobilePlace.value = desktopPlace.value;
          autoSaveSingleParticipant(tr);
        });
        mobilePlace.addEventListener('change', () => {
          desktopPlace.value = mobilePlace.value;
          autoSaveSingleParticipant(tr);
        });

        desktopAct.addEventListener('change', () => {
          mobileAct.value = desktopAct.value;
          applyActionColorClass(desktopAct);
          applyActionColorClass(mobileAct);
          autoSaveSingleParticipant(tr);
        });
        mobileAct.addEventListener('change', () => {
          desktopAct.value = mobileAct.value;
          applyActionColorClass(desktopAct);
          applyActionColorClass(mobileAct);
          autoSaveSingleParticipant(tr);
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

        // Desktop HTML5 drag event handlers
        tr.addEventListener("dragstart", (e) => {
          draggedRow = tr;
          tr.classList.add("dragging");
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", ""); // Required by Firefox to initiate dragging
        });

        tr.addEventListener("dragend", async () => {
          tr.classList.remove("dragging");
          await updatePlacementsAfterReorder();
          draggedRow = null;
        });

        attachMobilePressAndHold(tr);
        queueTableBody.appendChild(tr);
      });

      updateBatchBarState();
      applyTableFilter();

    } catch (err) {
      if (seq !== loadSeq) return;
      console.error("Error loading waiting room:", err);

      if (queueTableBody.querySelector("tr[data-client-name]")) {
        // Keep showing the last good data instead of wiping the table on a hiccup
        showAlert("Couldn't refresh the queue. Showing last known data.", "#fee2e2", "#991b1b");
      } else {
        lastQueueSignature = null;
        queueTableBody.innerHTML = `<tr><td colspan="5" class="table-loading" style="color: #ef4444;">Failed to load queue.</td></tr>`;
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
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;

      holdTimer = setTimeout(() => {
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
        await updatePlacementsAfterReorder();
        draggedRow = null;
      }
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
    const actionSelect = draggedRow.querySelector(".action-select");
    const mobPlacementLabel = draggedRow.querySelector(".mob-place-label");
    const mobPlacementSelect = draggedRow.querySelector(".mob-place-sel");
    const rowIndex = parseInt(draggedRow.dataset.rowIndex, 10);
    const clientName = draggedRow.dataset.clientName || "";
  
    if (placementSelect && placementSelect.value !== newPlacement) {
      const action = actionSelect ? actionSelect.value : "Pending";
      placementSelect.value = newPlacement;
      if (mobPlacementSelect) mobPlacementSelect.value = newPlacement;
      if (mobPlacementLabel) mobPlacementLabel.innerText = `${newPlacement}.`;
  
      await enqueue(async () => {
        try {
          const result = await persistUpdate({ name: clientName, rowIndex, placement: newPlacement, action });
          if (result.ok) {
            showAlert("Queue order saved!", "#dcfce7", "#166534");
            scheduleRefresh();
          } else {
            showAlert(describeFailure(result.reason), "#fee2e2", "#991b1b");
            scheduleRefresh(300, true);
          }
        } catch (err) {
          if (err.sessionExpired) return;
          console.error("Failed to update dragged row position:", err);
          showAlert("Network error saving new position", "#fee2e2", "#991b1b");
          scheduleRefresh(300, true);
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
  if (applyBulkBtn) {
    applyBulkBtn.addEventListener("click", () => {
      const actionVal = document.getElementById("bulkActionSelect").value;
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

      showAlert(`Updating ${selectedRows.length} rows...`, "#dbeafe", "#1e40af");

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
            if (!result.ok) {
              if (result.reason === "missing") gone++;
              else failed++;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        } catch (err) {
          if (err.sessionExpired) return;
          console.error("Bulk update error:", err);
          showAlert("Bulk update interrupted. Reloading queue...", "#fee2e2", "#991b1b");
          scheduleRefresh(300, true);
          return;
        }

        scheduleRefresh(REFRESH_AFTER_SAVE_MS, true);
        if (failed || gone) {
          const parts = [];
          if (failed) parts.push(`${failed} failed`);
          if (gone) parts.push(`${gone} no longer in the queue`);
          showAlert(`Bulk update finished: ${parts.join(", ")}`, "#fee2e2", "#991b1b");
        } else {
          showAlert("Selected status updated!", "#dcfce7", "#166534");
        }
      });
    });
  }

  const deleteSelectedBtn = document.getElementById("deleteSelectedBtn");
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

      showAlert(`Deleting ${selectedClients.length} row(s)...`, "#fee2e2", "#991b1b");

      enqueue(async () => {
        let failed = 0;
        try {
          for (const client of selectedClients) {
            let targetRow = client.row_index;

            // Look the person up by name right now, so a shifted sheet can't make us delete someone else
            if (client.name) {
              const found = await resolveRowIndex(client.name, client.row_index);
              if (found.status === "missing") continue;   // already gone
              if (found.status === "ambiguous") { failed++; continue; }
              targetRow = found.row_index;
            }

            const res = await apiFetch("/api/waiting-room/delete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                row_index: targetRow, 
                name: client.name 
              })
            });
            if (!res.ok) failed++;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } catch (err) {
          if (err.sessionExpired) return;
          console.error("Bulk delete error:", err);
          showAlert("Delete interrupted. Reloading queue...", "#fee2e2", "#991b1b");
          scheduleRefresh(300, true);
          return;
        }

        scheduleRefresh(300, true);
        if (failed) {
          showAlert(`${failed} of ${selectedClients.length} deletions failed (duplicate names must be removed in the sheet)`, "#fee2e2", "#991b1b");
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

  function showAlert(msg, bg, color) {
    if (!statusAlert) return;
    statusAlert.innerText = msg;
    statusAlert.style.backgroundColor = bg;
    statusAlert.style.color = color;
    statusAlert.style.display = "block";
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => { statusAlert.style.display = "none"; }, 3500);
  }

  function autoSetNextPlacement(queueData) {
    const placementInput = document.getElementById("placementInput");
    if (!placementInput) return;

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
    placementInput.value = next <= 25 ? String(next) : "Overflow";
  }

  const placementInputEl = document.getElementById("placementInput");
  if (placementInputEl) {
    // 'change' only fires for user edits, not for the programmatic default above
    placementInputEl.addEventListener("change", () => { placementTouched = true; });
  }

  // Background sync: pick up changes made in the Google Sheet or by another admin
  setInterval(() => {
    if (document.hidden) return;
    if (pendingOps > 0 || draggedRow) return;

    const active = document.activeElement;
    if (active && active.tagName === "SELECT" && queueTableBody.contains(active)) return; // don't close an open dropdown

    loadWaitingRoom();
    loadLogs();
  }, AUTO_REFRESH_MS);

  // Initialize page data
  preloadClientCache();
  loadWaitingRoom({ force: true });
  loadLogs();
});
