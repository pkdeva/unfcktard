// Background service worker for Unfucktard

// Import the prebuilt suggestions list
importScripts('../popup/suggestions.js');

// Initialize default storage and auto-apply suggestions
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    chrome.storage.sync.get(['blockedChannels', 'isEnabled', 'stats'], (data) => {
      let existingChannels = data.blockedChannels || [];
      let defaultChannels = [];

      // Extract all keywords from our prebuilt suggestion DB
      if (typeof SUGGESTED_FUCKTARDS !== 'undefined') {
        SUGGESTED_FUCKTARDS.forEach(s => {
          defaultChannels.push(...s.keywords);
        });
      }

      // Normalize and deduplicate everything
      let normalizedDefaults = defaultChannels.map(normalizeInput).filter(c => c);
      let mergedChannels = [...new Set([...existingChannels, ...normalizedDefaults])];

      chrome.storage.sync.set({
        blockedChannels: mergedChannels,
        isEnabled: data.isEnabled !== false, // Default true
        stats: data.stats || { totalBlocked: 0, sessionBlocked: 0 }
      });
      console.log('[Unfucktard] Integrated auto-suggestions into blocklist.');
    });
  }
});

/**
 * Normalize user input into a clean keyword.
 * Handles:
 *   - Full YouTube URLs: https://youtube.com/@Handle, /channel/ID, /c/name, /user/name
 *   - @handle → strips the @ for storage (stored without @)
 *   - Plain text / display names → stored as-is
 */
function normalizeInput(input) {
  let value = input.trim();
  if (!value) return '';

  // If it's a YouTube URL, extract the handle/channel part
  try {
    if (value.includes('youtube.com') || value.includes('youtu.be')) {
      const url = new URL(value.startsWith('http') ? value : 'https://' + value);
      const path = url.pathname;

      // /@handle
      const handleMatch = path.match(/^\/@([^\/\?]+)/);
      if (handleMatch) return handleMatch[1].trim();

      // /channel/ID or /c/name or /user/name
      const channelMatch = path.match(/^\/(channel|c|user)\/([^\/\?]+)/);
      if (channelMatch) return channelMatch[2].trim();
    }
  } catch (e) {
    // Not a valid URL, treat as plain text
  }

  // Strip @ prefix for consistency — stored without @
  if (value.startsWith('@')) {
    value = value.slice(1);
  }

  return value.trim();
}

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_BLOCKED_CHANNELS') {
    chrome.storage.sync.get(['blockedChannels', 'isEnabled'], (data) => {
      sendResponse({
        channels: data.blockedChannels || [],
        isEnabled: data.isEnabled !== false
      });
    });
    return true; // async response
  }

  if (message.type === 'ADD_CHANNELS') {
    chrome.storage.sync.get(['blockedChannels'], (data) => {
      const channels = data.blockedChannels || [];
      let added = false;

      const newChannels = message.channels || [];
      newChannels.forEach(ch => {
        const channelName = normalizeInput(ch);
        if (channelName && !channels.some(c => c.toLowerCase() === channelName.toLowerCase())) {
          channels.push(channelName);
          added = true;
        }
      });

      if (added) {
        chrome.storage.sync.set({ blockedChannels: channels }, () => {
          notifyAllYouTubeTabs({ type: 'BLOCKLIST_UPDATED', channels });
          sendResponse({ success: true, channels });
        });
      } else {
        sendResponse({ success: false, reason: 'duplicate_or_empty', channels });
      }
    });
    return true;
  }

  if (message.type === 'REMOVE_CHANNELS') {
    chrome.storage.sync.get(['blockedChannels'], (data) => {
      const toRemove = (message.channels || []).map(c => normalizeInput(c).toLowerCase());
      const channels = (data.blockedChannels || []).filter(
        c => !toRemove.includes(c.toLowerCase())
      );
      chrome.storage.sync.set({ blockedChannels: channels }, () => {
        notifyAllYouTubeTabs({ type: 'BLOCKLIST_UPDATED', channels });
        sendResponse({ success: true, channels });
      });
    });
    return true;
  }

  if (message.type === 'ADD_CHANNEL') {
    chrome.storage.sync.get(['blockedChannels'], (data) => {
      const channels = data.blockedChannels || [];
      const channelName = normalizeInput(message.channel);

      if (channelName && !channels.some(c => c.toLowerCase() === channelName.toLowerCase())) {
        channels.push(channelName);
        chrome.storage.sync.set({ blockedChannels: channels }, () => {
          notifyAllYouTubeTabs({ type: 'BLOCKLIST_UPDATED', channels });
          sendResponse({ success: true, channels });
        });
      } else {
        sendResponse({ success: false, reason: 'duplicate_or_empty' });
      }
    });
    return true;
  }

  if (message.type === 'REMOVE_CHANNEL') {
    chrome.storage.sync.get(['blockedChannels'], (data) => {
      const toRemove = normalizeInput(message.channel).toLowerCase();
      const channels = (data.blockedChannels || []).filter(
        c => c.toLowerCase() !== toRemove
      );
      chrome.storage.sync.set({ blockedChannels: channels }, () => {
        notifyAllYouTubeTabs({ type: 'BLOCKLIST_UPDATED', channels });
        sendResponse({ success: true, channels });
      });
    });
    return true;
  }

  if (message.type === 'TOGGLE_EXTENSION') {
    chrome.storage.sync.set({ isEnabled: message.isEnabled }, () => {
      notifyAllYouTubeTabs({ type: 'TOGGLE_EXTENSION', isEnabled: message.isEnabled });
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'INCREMENT_BLOCKED') {
    chrome.storage.sync.get(['stats'], (data) => {
      const stats = data.stats || { totalBlocked: 0 };
      stats.totalBlocked = (stats.totalBlocked || 0) + (message.count || 1);
      chrome.storage.sync.set({ stats });
    });
  }
});

// Notify all open YouTube tabs
function notifyAllYouTubeTabs(message) {
  chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        // Tab might not have content script loaded yet
      });
    });
  });
}
