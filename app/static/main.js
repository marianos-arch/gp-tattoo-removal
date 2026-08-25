document.addEventListener('DOMContentLoaded', () => {
  const metricPlaced = document.getElementById('metric-placed');
  const metricSpots = document.getElementById('metric-spots');
  const tableBody = document.getElementById('table-body');
  const refreshBtn = document.getElementById('refresh-btn');

  const MAX_CAPACITY = 25; // Matching Google Apps Script daily capacity cap

  async function fetchLivePlacements() {
    try {
      tableBody.innerHTML = '<tr><td colspan="2" class="loading-cell">Updating data...</td></tr>';

      const response = await fetch('/api/placements');
      if (!response.ok) throw new Error('Failed to fetch data');
      
      const data = await response.json();
      renderData(data);
    } catch (err) {
      console.error(err);
      tableBody.innerHTML = '<tr><td colspan="2" class="loading-cell">Unable to load placement data at this time.</td></tr>';
    }
  }

  function renderData(rows) {
    if (!rows || rows.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="2" class="loading-cell">No active records found.</td></tr>';
      metricPlaced.textContent = 0;
      metricSpots.textContent = MAX_CAPACITY;
      return;
    }

    let placedCount = 0;
    tableBody.innerHTML = '';

    rows.forEach(row => {
      const placementVal = String(row[0] || '').trim();
      const statusVal = String(row[1] || 'Pending').trim();

      // Check if entry has a valid placement (Numeric 1-25 or Priority P1-P5)
      const isNumeric = !isNaN(parseInt(placementVal, 10));
      const isPriority = placementVal.toUpperCase().startsWith('P');

      if (isNumeric || isPriority) {
        placedCount++;
      }

      const tr = document.createElement('tr');
      
      // Determine badge class while safely handling variations (spaces vs hyphens)
      const cleanStatus = statusVal.toLowerCase();
      let badgeClass = 'badge-pending';

      if (cleanStatus === 'approved' || cleanStatus === 'successful') {
        badgeClass = 'badge-success';
      } else if (cleanStatus === 'in progress' || cleanStatus === 'inprogress') {
        badgeClass = 'badge-in-progress';
      } else if (cleanStatus === 'check-in' || cleanStatus === 'checkin') {
        badgeClass = 'badge-checkin';
      }

      tr.innerHTML = `
        <td><strong>Placement ${placementVal}</strong></td>
        <td><span class="badge ${badgeClass}">${statusVal}</span></td>
      `;
      tableBody.appendChild(tr);
    });

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
