document.addEventListener('DOMContentLoaded', () => {
  const metricPlaced = document.getElementById('metric-placed');
  const metricSpots = document.getElementById('metric-spots');
  const inProgressContainer = document.getElementById('in-progress-container');
  const refreshBtn = document.getElementById('refresh-btn');

  const MAX_CAPACITY = 25; // Matching Google Apps Script daily capacity cap

  async function fetchLivePlacements() {
    try {
      inProgressContainer.innerHTML = '<div class="loading-cell">Updating data...</div>';

      const response = await fetch('/api/placements');
      if (!response.ok) throw new Error('Failed to fetch data');
      
      const data = await response.json();
      renderData(data);
    } catch (err) {
      console.error(err);
      inProgressContainer.innerHTML = '<div class="loading-cell">Unable to load placement data at this time.</div>';
    }
  }

  function renderData(rows) {
    if (!rows || rows.length === 0) {
      inProgressContainer.innerHTML = '<div class="empty-state">No active sessions at the moment.</div>';
      metricPlaced.textContent = 0;
      metricSpots.textContent = MAX_CAPACITY;
      return;
    }

    let placedCount = 0;
    const inProgressPlacements = [];

    rows.forEach(row => {
      const placementVal = String(row[0] || '').trim();
      const statusVal = String(row[1] || 'Pending').trim().toLowerCase();

      // Check if entry has a valid placement (Numeric 1-25 or Priority P1-P5)
      const isNumeric = !isNaN(parseInt(placementVal, 10));
      const isPriority = placementVal.toUpperCase().startsWith('P');

      if (isNumeric || isPriority) {
        placedCount++;
      }

      // Collect only "In Progress" placements for display
      if (statusVal === 'in progress' || statusVal === 'inprogress') {
        inProgressPlacements.push(placementVal);
      }
    });

    // Render "In Progress" items or an empty state message
    if (inProgressPlacements.length > 0) {
      inProgressContainer.innerHTML = inProgressPlacements
        .map(id => `
          <div class="in-progress-card">
            <span class="badge badge-in-progress">In Progress</span>
            <span class="placement-id">Placement ${id}</span>
          </div>
        `).join('');
    } else {
      inProgressContainer.innerHTML = '<div class="empty-state">No sessions currently in progress.</div>';
    }

    // Correct Metrics Calculation: 25 max capacity minus placed count
    const spotsLeft = Math.max(0, MAX_CAPACITY - placedCount);

    // Update Dashboard UI
    metricPlaced.textContent = placedCount;
    metricSpots.textContent = spotsLeft;
  }

  refreshBtn.addEventListener('click', fetchLivePlacements);

  // Initial Fetch on page load
  fetchLivePlacements();
});
