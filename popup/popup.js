document.addEventListener('DOMContentLoaded', async () => {
  const toggleEraserBtn = document.getElementById('toggle-eraser');
  const toggleStickyBtn = document.getElementById('toggle-sticky');
  const clearBtn = document.getElementById('clear-page');
  const successCount = document.getElementById('success-count');
  const notesCount = document.getElementById('notes-count');
  const brokenAlert = document.getElementById('broken-alert');
  const brokenCount = document.getElementById('broken-count');

  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (tabs.length === 0) return;
    const currentTab = tabs[0];
    const url = currentTab.url;

    // Load stats
    const data = await chrome.storage.local.get('vellum_stats');
    if (data.vellum_stats && data.vellum_stats[url]) {
      const stats = data.vellum_stats[url];
      successCount.innerText = stats.success || 0;
      notesCount.innerText = stats.notes || 0;
      if (stats.broken > 0) {
        brokenCount.innerText = stats.broken;
        brokenAlert.classList.remove('hidden');
      }
    }

    // Handlers
    toggleEraserBtn.addEventListener('click', () => {
      chrome.tabs.sendMessage(currentTab.id, { action: 'toggle-eraser' }, () => {
        if (!chrome.runtime.lastError) window.close();
      });
    });

    toggleStickyBtn.addEventListener('click', () => {
      chrome.tabs.sendMessage(currentTab.id, { action: 'toggle-sticky' }, () => {
        if (!chrome.runtime.lastError) window.close();
      });
    });

    clearBtn.addEventListener('click', async () => {
      if (confirm("Are you sure you want to clear all active erasures and notes on this exact path?")) {
        if (window.VellumStorage) {
          await window.VellumStorage.clearPage(url);
          chrome.tabs.reload(currentTab.id);
          window.close();
        }
      }
    });
  });
});
