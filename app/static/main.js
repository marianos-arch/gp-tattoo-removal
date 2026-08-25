document.addEventListener('DOMContentLoaded', () => {
  const metricPlaced = document.getElementById('metric-placed');
  const metricSpots = document.getElementById('metric-spots');
  const tableBody = document.getElementById('table-body');
  const refreshBtn = document.getElementById('refresh-btn');

  async function fetchLivePlacements() {
    try {
      tableBody.innerHTML = '<tr><td colspan="2" class="loading-cell">Updating data...</td></tr>';

      const response = await fetch('/api/placements');
      if (!response.ok) throw new Error('Failed to fetch data');
      
      const data = await response.json();
      
      // Expected payload format: [ [ "Placement ID / Name", "Status" ], ... ]
      // Adjust indexes depending on your Apps Script output array mapping
      renderData(data);
    } catch (err) {
      console.error(err);
      tableBody.innerHTML = '<tr><td colspan="2" class="loading-cell">Unable to load placement data at this time.</td></tr>';
    }
  }

  function renderData(rows) {
    if (!rows || rows.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="2" class="loading-cell">No active records found.</td></tr>';
      return;
    }

    let placedCount = 0;
    let availableCount = 0;
    tableBody.innerHTML = '';

    rows.forEach(row => {
      const placementName = row[0] || 'Unassigned';
      const status = row[1] || 'Pending';

      if (status.toLowerCase() === 'successful' || status.toLowerCase() === 'placed') {
        placedCount++;
      } else {
        availableCount++;
      }

      const tr = document.createElement('tr');
      const badgeClass = status.toLowerCase() === 'successful' ? 'badge-success' : 'badge-pending';

      tr.innerHTML = `
        <td><strong>${placementName}</strong></td>
        <td><span class="badge ${badgeClass}">${status}</span></td>
      `;
      tableBody.appendChild(tr);
    });

    // Update Top Counters
    metricPlaced.textContent = placedCount;
    metricSpots.textContent = availableCount;
  }

  refreshBtn.addEventListener('click', fetchLivePlacements);

  // Initial Fetch on page load
  fetchLivePlacements();
});
