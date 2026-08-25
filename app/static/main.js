document.addEventListener('DOMContentLoaded', () => {
  const metricPlaced = document.getElementById('metric-placed');
  const metricSpots = document.getElementById('metric-spots');
  const inProgressContainer = document.getElementById('in-progress-container');
  const whosNextContainer = document.getElementById('whos-next-container');
  const activeCountPill = document.getElementById('active-session-count');
  const nextCountPill = document.getElementById('next-session-count');
  const refreshBtn = document.getElementById('refresh-btn');

  const MAX_CAPACITY = 25;

  async function fetchLivePlacements() {
    try {
      inProgressContainer.innerHTML = `
        <div class="status-state-box">
          <div class="spinner"></div>
          <span>Loading session status...</span>
        </div>`;
      whosNextContainer.innerHTML = `
        <div class="status-state-box">
          <div class="spinner"></div>
          <span>Loading queue status...</span>
        </div>`;

      const response = await fetch('/api/placements');
      if (!response.ok) throw new Error('Failed to fetch data');

      const data = await response.json();
      renderData(data);
    } catch (err) {
      console.error(err);
      inProgressContainer.innerHTML = '<div class="status-state-box">Unable to load placement data.</div>';
      whosNextContainer.innerHTML = '<div class="status-state-box">Unable to load queue data.</div>';
    }
  }

  function renderData(rows) {
    if (!rows || rows.length === 0) {
      inProgressContainer.innerHTML = '<div class="status-state-box"><span>No sessions currently in progress</span></div>';
      whosNextContainer.innerHTML = '<div class="status-state-box"><span>No upcoming placements in queue</span></div>';
      if (activeCountPill) activeCountPill.textContent = '0 Active';
      if (nextCountPill) nextCountPill.textContent = '0 Queued';
      metricPlaced.textContent = 0;
      metricSpots.textContent = MAX_CAPACITY;
      return;
    }

    let placedCount = 0;
    const inProgressList = [];
    const whosNextList = [];

    rows.forEach(row => {
      const placementVal = String(row[0] || '').trim();
      const rawStatus = String(row[1] || 'Pending').trim();
      const statusVal = rawStatus.toLowerCase();

      const isNumeric = !isNaN(parseInt(placementVal, 10));
      const isPriority = placementVal.toUpperCase().startsWith('P');

      if (isNumeric || isPriority) {
        placedCount++;
      }

      // Filter In Progress vs. Queued (Check-In or Pending)
      if (statusVal === 'in progress' || statusVal === 'inprogress') {
        inProgressList.push({ id: placementVal, status: rawStatus });
      } else if (statusVal === 'check-in' || statusVal === 'checkin' || statusVal === 'pending') {
        whosNextList.push({ id: placementVal, status: rawStatus, isCheckIn: statusVal.includes('check') });
      }
    });

    // Update Pills (Displays total queued count)
    if (activeCountPill) activeCountPill.textContent = `${inProgressList.length} Active`;
    if (nextCountPill) nextCountPill.textContent = `${whosNextList.length} Queued`;

    // Render "Active Session" Cards
    if (inProgressList.length > 0) {
      inProgressContainer.innerHTML = inProgressList
        .map(item => `
          <div class="in-progress-card">
            <span class="badge badge-in-progress">${item.status}</span>
            <span class="placement-id">Placement ${item.id}</span>
          </div>
        `).join('');
    } else {
      inProgressContainer.innerHTML = '<div class="status-state-box"><span>No sessions currently in progress</span></div>';
    }

    // Render ONLY the next 2 cards in "Up Next" Queue
    if (whosNextList.length > 0) {
      whosNextContainer.innerHTML = whosNextList
        .slice(0, 2)
        .map(item => `
          <div class="next-card">
            <span class="badge ${item.isCheckIn ? 'badge-checkin' : 'badge-pending'}">${item.status}</span>
            <span class="placement-id">Placement ${item.id}</span>
          </div>
        `).join('');
    } else {
      whosNextContainer.innerHTML = '<div class="status-state-box"><span>No upcoming placements in queue</span></div>';
    }

    // Dashboard calculations
    const spotsLeft = Math.max(0, MAX_CAPACITY - placedCount);
    metricPlaced.textContent = placedCount;
    metricSpots.textContent = spotsLeft;
  }

  refreshBtn.addEventListener('click', fetchLivePlacements);
  fetchLivePlacements();
});
