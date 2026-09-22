// Global toggle for mobile edit drawer
window.toggleMobileDrawer = function(infoEl) {
  const tr = infoEl.closest('tr');
  const drawer = tr.querySelector('.mobile-edit-drawer');
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

  // Pre-cache client names on page load
  async function preloadClientCache() {
    if (!clientList) return;
    try {
      const res = await fetch("/api/clients");
      if (!res.ok) return;

      const data = await res.json();
      
      // Handle array of strings or array of objects [{ Name: "..." }]
      const names = Array.isArray(data) ? data : (data.clients || []);
      cachedClients = names.map(item => 
        typeof item === 'string' ? item : (item.Name || item.name || '')
      ).filter(Boolean);

      // Populate datalist statically
      clientList.innerHTML = "";
      cachedClients.forEach(name => {
        const option = document.createElement("option");
        option.value = name;
        clientList.appendChild(option);
      });
    } catch (err) {
      console.error("Error preloading client cache:", err);
    }
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
        const res = await fetch("/api/waiting-room/add", {
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
          await loadWaitingRoom();
        } else {
          const errData = await res.json().catch(() => ({}));
          showAlert(errData.message || "Failed to add client", "#fee2e2", "#991b1b");
        }
      } catch (err) {
        console.error("Error submitting add client form:", err);
        showAlert("Server connection error", "#fee2e2", "#991b1b");
      }
    });
  }

  async function preloadClientCache() {
    const clientList = document.getElementById("clientList");
    if (!clientList) return;
  
    try {
      const res = await fetch("/api/clients");
      if (!res.ok) {
        console.error("Failed to fetch clients list:", res.status);
        return;
      }
  
      const data = await res.json();
      console.log("Clients API response:", data); // Check browser console to inspect data shape
  
      // Handle array directly or nested object keys
      const rawClients = Array.isArray(data) ? data : (data.clients || data.data || []);
      
      // Extract string values regardless of field naming convention
      cachedClients = rawClients.map(item => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item !== null) {
          return item.Name || item.name || item.Client_Name || item.client_name || item.full_name || '';
        }
        return '';
      }).filter(Boolean);
  
      // Rebuild datalist options
      clientList.innerHTML = "";
      const fragment = document.createDocumentFragment();
      
      cachedClients.forEach(name => {
        const option = document.createElement("option");
        option.value = name;
        fragment.appendChild(option);
      });
  
      clientList.appendChild(fragment);
      console.log(`Successfully cached ${cachedClients.length} clients for autocomplete.`);
    } catch (err) {
      console.error("Error preloading client cache:", err);
    }
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
    const checkedRows = new Set(
      [...queueTableBody.querySelectorAll(".row-checkbox:checked")].map(cb => cb.value)
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
      [...queueTableBody.querySelectorAll(".row-checkbox")].map(cb => cb.value)
    ).size;
  
    if (masterCheckbox && totalRows > 0) {
      if (count === totalRows) {
        masterCheckbox.checked = true;
        masterCheckbox.indeterminate = false;
      } else if (count > 0 && count < totalRows) {
        masterCheckbox.checked = false;
        masterCheckbox.indeterminate = true;
      }
    }
  }

  async function autoSaveSingleParticipant(tr) {
    const rawRowIndex = tr.dataset.rowIndex;
    const rowIndex = parseInt(rawRowIndex, 10);
    const placement = tr.querySelector(".placement-select").value;
    const action = tr.querySelector(".action-select").value;

    if (isNaN(rowIndex)) {
      console.error("Invalid row index for auto-save:", rawRowIndex);
      showAlert("Error saving: Invalid Row", "#fee2e2", "#991b1b");
      return;
    }

    const mobPlacement = tr.querySelector(".mob-place-label");
    const mobAction = tr.querySelector(".mob-status-label");
    if (mobPlacement) mobPlacement.innerText = `${placement || '-'}.`;
    if (mobAction) {
      mobAction.innerText = action;
      mobAction.className = 'mobile-status-tag action-' + action.replace(/\s+/g, '-');
    }

    const res = await fetch("/api/waiting-room/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ row_index: rowIndex, placement, action })
    });

    if (res.ok) {
      showAlert("Updated!", "#dcfce7", "#166534");
      await loadWaitingRoom();
    } else {
      showAlert("Update failed", "#fee2e2", "#991b1b");
    }
  }

  async function loadWaitingRoom() {
    try {
      const res = await fetch("/api/waiting-room");
      const data = await res.json();
      
      autoSetNextPlacement(data.queue || []);
      
      queueTableBody.innerHTML = "";
      if (!data.queue || data.queue.length === 0) {
        queueTableBody.innerHTML = `<tr><td colspan="5" class="table-loading">No clients currently in waiting room.</td></tr>`;
        updateBatchBarState();
        return;
      }

      const sortedQueue = sortQueueData(data.queue);

      sortedQueue.forEach((row) => {
        const tr = document.createElement("tr");
        tr.draggable = true;
        tr.dataset.rowIndex = row.row_index;

        const currentAction = row.Action || 'Pending';
        const actionClass = 'action-' + currentAction.replace(/\s+/g, '-');
        const currentPlacement = row.Placement || '';

        tr.innerHTML = `
          <td class="drag-handle">⋮⋮</td>
          <td><input type="checkbox" class="row-checkbox" value="${row.row_index}"></td>
          <td style="font-weight: 600; color: #0f172a;">${row.Name || ''}</td>
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
              <span class="mobile-placement-tag mob-place-label">${currentPlacement ? currentPlacement + '.' : '-.'}</span>
              <span>${row.Name || ''}</span>
              <span class="mobile-status-tag mob-status-label ${actionClass}">${currentAction}</span>
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

        tr.addEventListener("dragstart", () => {
          draggedRow = tr;
          tr.classList.add("dragging");
        });
        tr.addEventListener("dragend", async () => {
          tr.classList.remove("dragging");
          draggedRow = null;
          await updatePlacementsAfterReorder();
        });

        attachMobilePressAndHold(tr);
        queueTableBody.appendChild(tr);
      });

      updateBatchBarState();

    } catch (err) {
      queueTableBody.innerHTML = `<tr><td colspan="5" class="table-loading" style="color: #ef4444;">Failed to load queue.</td></tr>`;
    }
  }

  async function loadLogs() {
    if (!logsTableBody) return;
    try {
      const res = await fetch("/api/logs");
      const data = await res.json();

      if (!data.logs || data.logs.length === 0) {
        logsTableBody.innerHTML = `<tr><td colspan="6" class="table-loading">No activity log entries found.</td></tr>`;
        return;
      }

      logsTableBody.innerHTML = "";
      data.logs.forEach(row => {
        const statusClass = 'action-' + String(row['Status'] || '').replace(/\s+/g, '-');
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${row['Submission Time'] || '-'}</td>
          <td style="font-weight: 600; color: #0f172a;">${row['Name'] || '-'}</td>
          <td>${row['Tattoo Session Date'] || '-'}</td>
          <td>
            <span class="mobile-status-tag ${statusClass}">${row['Status'] || '-'}</span>
          </td>
          <td style="color: #64748b; font-size: 0.85rem;">${row['Reviewed By'] || '-'}</td>
          <td style="color: #64748b; font-size: 0.85rem;">${row['Reviewed At'] || '-'}</td>
        `;
        logsTableBody.appendChild(tr);
      });
    } catch (err) {
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
        draggedRow = null;
        await updatePlacementsAfterReorder();
      }
    });
  }

  async function updatePlacementsAfterReorder() {
    const rows = queueTableBody.querySelectorAll("tr");
    let updatedCount = 0;
    
    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i];
      const placementSelect = tr.querySelector(".placement-select");
      const currentValue = placementSelect ? placementSelect.value : "";
      
      if (currentValue && !currentValue.startsWith("P") && currentValue !== "Overflow") {
        const newPlacement = String(i + 1);
        const mobPlacementLabel = tr.querySelector(".mob-place-label");
        const actionSelect = tr.querySelector(".action-select");
        const rowIndex = parseInt(tr.dataset.rowIndex, 10);
        
        if (placementSelect && placementSelect.value !== newPlacement && !isNaN(rowIndex)) {
          placementSelect.value = newPlacement;
          if (mobPlacementLabel) mobPlacementLabel.innerText = `${newPlacement}.`;
          
          await fetch("/api/waiting-room/update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              row_index: rowIndex,
              placement: newPlacement,
              action: actionSelect.value
            })
          });
          updatedCount++;
        }
      }
    }
    
    if (updatedCount > 0) {
      showAlert("Queue order saved!", "#dcfce7", "#166534");
      await loadWaitingRoom();
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
    applyBulkBtn.addEventListener("click", async () => {
      const actionVal = document.getElementById("bulkActionSelect").value;
      if (!actionVal) return alert("Please select a status action.");

      const selectedRows = [...queueTableBody.querySelectorAll("td .row-checkbox:checked")].map(cb => {
        const tr = cb.closest("tr");
        return {
          tr,
          row_index: parseInt(tr.dataset.rowIndex, 10),
          placement: tr.querySelector(".placement-select").value,
          action: actionVal
        };
      });

      if (selectedRows.length === 0) return;

      showAlert(`Updating ${selectedRows.length} rows...`, "#dbeafe", "#1e40af");

      for (let i = 0; i < selectedRows.length; i++) {
        const item = selectedRows[i];
        await fetch("/api/waiting-room/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            row_index: item.row_index,
            placement: item.placement,
            action: item.action
          })
        });
        await new Promise(r => setTimeout(r, 100));
      }

      showAlert("Selected status updated!", "#dcfce7", "#166534");
      await loadWaitingRoom();
    });
  }

  const deleteSelectedBtn = document.getElementById("deleteSelectedBtn");
  if (deleteSelectedBtn) {
    deleteSelectedBtn.addEventListener("click", async () => {
      const selectedRowIndexes = [...new Set(
        [...queueTableBody.querySelectorAll(".row-checkbox:checked")].map(cb => parseInt(cb.value, 10))
      )];
  
      if (selectedRowIndexes.length === 0) return;
  
      if (!confirm(`Are you sure you want to delete ${selectedRowIndexes.length} client(s)?`)) return;
  
      showAlert(`Deleting ${selectedRowIndexes.length} row(s)...`, "#fee2e2", "#991b1b");
  
      for (let i = 0; i < selectedRowIndexes.length; i++) {
        const rowIndex = selectedRowIndexes[i];
  
        await fetch("/api/waiting-room/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ row_index: rowIndex })
        });
        await new Promise(r => setTimeout(r, 100));
      }
  
      await loadWaitingRoom();
      showAlert("Selected row(s) deleted successfully!", "#dcfce7", "#166534");
    });
  }

  const tableSearch = document.getElementById("tableSearch");
  if (tableSearch) {
    tableSearch.addEventListener("input", function() {
      const term = this.value.toLowerCase();
      const rows = queueTableBody.querySelectorAll("tr");
      rows.forEach(tr => {
        const text = tr.innerText.toLowerCase();
        tr.style.display = text.includes(term) ? "" : "none";
      });
    });
  }

  function showAlert(msg, bg, color) {
    if (!statusAlert) return;
    statusAlert.innerText = msg;
    statusAlert.style.backgroundColor = bg;
    statusAlert.style.color = color;
    statusAlert.style.display = "block";
    setTimeout(() => { statusAlert.style.display = "none"; }, 3500);
  }

  // Add this helper function to auto-set the next placement position in the form
  function autoSetNextPlacement(queueData) {
    const placementInput = document.getElementById("placementInput");
    if (!placementInput) return;
  
    // Calculate highest numeric placement currently in use
    let maxPlacement = 0;
    
    if (Array.isArray(queueData)) {
      queueData.forEach(item => {
        const val = parseInt(item.Placement, 10);
        if (!isNaN(val) && val > maxPlacement) {
          maxPlacement = val;
        }
      });
    }
  
    const nextPlacement = String(maxPlacement + 1);
  
    // Set selected value if the calculated position exists as an option
    if (placementInput.querySelector(`option[value="${nextPlacement}"]`)) {
      placementInput.value = nextPlacement;
    } else {
      // Default fallback to Next number or standard dropdown state
      placementInput.value = nextPlacement;
    }
  }

  // Initialize page data
  preloadClientCache();
  loadWaitingRoom();
  loadLogs();
});
