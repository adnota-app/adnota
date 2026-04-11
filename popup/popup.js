document.addEventListener('DOMContentLoaded', async () => {
  const toggleBtn = document.getElementById('toggle-eraser');
  const clearBtn = document.getElementById('clear-page');
  const successCount = document.getElementById('success-count');
  const brokenAlert = document.getElementById('broken-alert');
  const brokenCount = document.getElementById('broken-count');

  // Load stats specifically for the current active tab
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (tabs.length === 0) return;
    const currentTab = tabs[0];
    const url = currentTab.url;

    // Load stats from restorer.js via storage
    const data = await chrome.storage.local.get('vellum_stats');
    if (data.vellum_stats && data.vellum_stats[url]) {
      const stats = data.vellum_stats[url];
      successCount.innerText = stats.success || 0;
      if (stats.broken > 0) {
        brokenCount.innerText = stats.broken;
        brokenAlert.classList.remove('hidden');
      }
    }

    // Connect toggle logic to current tab
    toggleBtn.addEventListener('click', () => {
      chrome.tabs.sendMessage(currentTab.id, { action: 'toggle-eraser' }, () => {
        if (!chrome.runtime.lastError) {
          window.close(); // Close popup if message successful
        } else {
          // You might be on a chrome:// page where content scripts cannot run
          toggleBtn.innerText = "Cannot erase on this page";
          toggleBtn.style.backgroundColor = "#ccc";
        }
      });
    });

    // Connect clear logic
    clearBtn.addEventListener('click', async () => {
      if (confirm("Are you sure you want to clear all exact-path edits for this page?")) {
        if (window.VellumStorage) {
          await window.VellumStorage.clearPage(url);
          // Reload the tab
          chrome.tabs.reload(currentTab.id);
          window.close();
        }
      }
    });
  });
});
