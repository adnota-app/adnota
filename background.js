// background.js

chrome.commands.onCommand.addListener((command, tab) => {
  if (tab.id && (command === 'toggle-eraser' || command === 'toggle-sticky' || command === 'toggle-highlighter' || command === 'toggle-view')) {
    chrome.tabs.sendMessage(tab.id, { action: command }).catch(() => {
      // Ignore errors if content script unavail
    });
  }
});
