// background.js

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-eraser' && tab.id) {
    // Forward the command to the content script in the active tab
    chrome.tabs.sendMessage(tab.id, { action: 'toggle-eraser' }).catch(() => {
      // Ignore errors if the content script isn't loaded (e.g. on chrome:// pages)
    });
  }
});
