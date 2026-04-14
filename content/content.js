// Unfucktard - Content Script
// Keyword-based YouTube content blocker — blocks videos, sections, and mentions
// matching any keyword from the user's blocklist.

(function () {
  'use strict';

  const SHIELD_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1 14.5l-4-4 1.41-1.41L11 13.67l5.59-5.59L18 9.5l-7 7z"/></svg>`;
  const BAN_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.902 7.902 0 014 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.902 7.902 0 0120 12c0 4.42-3.58 8-8 8z"/></svg>`;

  let blockedKeywords = []; // lowercased keyword strings
  let isEnabled = true;
  let blockedCount = 0;
  let observer = null;
  let scanTimeout = null;

  // ——— Initialization ———

  async function init() {
    const data = await sendMessage({ type: 'GET_BLOCKED_CHANNELS' });
    if (data) {
      blockedKeywords = buildKeywords(data.channels || []);
      isEnabled = data.isEnabled !== false;
    }
    if (isEnabled) {
      checkChannelPage();
      scanPage();
      startObserver();
    }
  }

  /**
   * Build a flat array of lowercased keyword variants from stored entries.
   * Each entry might be a display name, @handle, or raw handle.
   * We generate variants: as-is, without @, without spaces (for handle matching).
   */
  function buildKeywords(channels) {
    const kw = new Set();
    for (const raw of channels) {
      const lower = raw.trim().toLowerCase();
      if (!lower) continue;
      kw.add(lower);
      // If it starts with @, also add without @
      if (lower.startsWith('@')) {
        kw.add(lower.slice(1));
      }
    }
    return Array.from(kw);
  }

  // ——— Messaging ———

  function sendMessage(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) {
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // Listen for updates from background/popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'BLOCKLIST_UPDATED') {
      blockedKeywords = buildKeywords(message.channels || []);
      resetAndRescan();
    }
    if (message.type === 'TOGGLE_EXTENSION') {
      isEnabled = message.isEnabled;
      if (isEnabled) {
        checkChannelPage();
        scanPage();
        startObserver();
      } else {
        unhideAll();
        removeChannelPageOverlay();
        stopObserver();
      }
    }
  });

  // ——— Keyword Matching ———

  /**
   * Check if a text string contains any blocked keyword.
   * Returns the matched keyword or null.
   */
  function matchesBlocklist(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    for (const keyword of blockedKeywords) {
      if (lower.includes(keyword)) {
        return keyword;
      }
    }
    return null;
  }

  // ——— Core Blocking Logic ———

  // ---- Video/item-level selectors ----
  // ytd-channel-renderer is intentionally EXCLUDED — that's the channel result card in search,
  // which we want to keep visible.
  const VIDEO_SELECTORS = [
    // Home feed
    'ytd-rich-item-renderer',
    // Search results — videos
    'ytd-video-renderer',
    // Sidebar / next-up recommendations
    'ytd-compact-video-renderer',
    // Channel page video grid
    'ytd-grid-video-renderer',
    // Shorts items inside a shelf (classic)
    'ytd-reel-item-renderer',
    // Shorts items (modern lockup architectures)
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
    'ytd-shorts-lockup-view-model',
    'ytm-reel-item-renderer',
    // Shorts full-page grid (youtube.com/shorts)
    'ytd-rich-grid-slim-media',
    // Playlist sidebar panel
    'ytd-playlist-panel-video-renderer',
    // Search mix / ad-free video renderer variant
    'ytd-radio-renderer',
    // Movie/show items
    'ytd-movie-renderer',
    // Chips / mini video cards in horizontal lists
    'ytd-grid-short-renderer'
  ].join(', ');

  // ---- Section/shelf-level selectors ----
  // When a whole shelf is titled with the blocked keyword (e.g. "Latest Shorts from Ishan Sharma",
  // "Latest from Ishan Sharma"), we hide the entire shelf instead of individual items.
  // NOTE: ytd-item-section-renderer is intentionally NOT included here — it wraps every
  // individual search result and would cause mass false-positives.
  const SECTION_SELECTORS = [
    'ytd-rich-section-renderer',          // Home page sections
    'ytd-shelf-renderer',                 // Generic shelves
    'ytd-reel-shelf-renderer',            // Shorts shelves in search & home
    'ytd-horizontal-card-list-renderer',  // Horizontal card rows
    'ytd-vertical-list-renderer'          // Vertical list sections
  ].join(', ');

  // ---- Channel name extraction selectors (tried in order) ----
  const CHANNEL_NAME_SELECTORS = [
    'ytd-channel-name yt-formatted-string a',
    'ytd-channel-name yt-formatted-string',
    '#channel-name yt-formatted-string a',
    '#channel-name yt-formatted-string',
    '#channel-name a',
    '.ytd-channel-name a',
    '#text.ytd-channel-name',
    '[id="text"].ytd-channel-name'
  ];

  // ---- Channel handle extraction (from any @-link inside the element) ----
  const HANDLE_LINK_ATTR = [
    'a[href*="/@"]',
    'a[href*="/channel/"]',
    'a[href*="/c/"]',
    'a[href*="/user/"]'
  ].join(', ');

  // ---- Video/Short title selectors ----
  const TITLE_SELECTORS = [
    '#video-title',
    'h3 a#video-title-link',
    '#video-title-link',
    'yt-formatted-string#video-title',
    'span#video-title',
    '#title-wrapper h3',
    // Shorts-specific properties
    'h3.shortsLockupViewModelHostMetadataTitle',
    '.shortsLockupViewModelHostMetadataTitle span',
    '[class*="metadataTitle"]',
    '[class*="MetadataTitle"]',
    '[class*="titleText"]',
    'span.yt-core-attributed-string'
  ];

  function getChannelName(videoElement) {
    for (const selector of CHANNEL_NAME_SELECTORS) {
      const el = videoElement.querySelector(selector);
      if (el) {
        const name = (el.textContent || '').trim();
        if (name && name.length > 0 && name.length < 200) {
          return name;
        }
      }
    }
    return null;
  }

  function getChannelHandle(videoElement) {
    // Try any link that looks like a channel link
    const links = videoElement.querySelectorAll(HANDLE_LINK_ATTR);
    for (const link of links) {
      // @handle pattern
      let match = link.href.match(/\/@([^\/\?&]+)/);
      if (match) return match[1];
      // /channel/UCxxxxx
      match = link.href.match(/\/channel\/([^\/\?&]+)/);
      if (match) return match[1];
      // /c/name or /user/name
      match = link.href.match(/\/(?:c|user)\/([^\/\?&]+)/);
      if (match) return match[1];
    }
    return null;
  }

  function getVideoTitle(videoElement) {
    for (const selector of TITLE_SELECTORS) {
      const el = videoElement.querySelector(selector);
      if (el) {
        const title = (
          el.getAttribute('title') ||
          el.getAttribute('aria-label') ||
          el.textContent ||
          ''
        ).trim();
        if (title && title.length > 0 && title.length < 500) return title;
      }
    }
    return null;
  }

  /**
   * Get all searchable text from an element — used as a broad last-resort scan.
   * Collects: aria-labels, title attrs, link hrefs, and visible text.
   */
  function getBroadText(el) {
    const parts = new Set();
    // aria-label on the element itself
    const rootAria = el.getAttribute('aria-label');
    if (rootAria) parts.add(rootAria.trim());
    // aria-label on children
    el.querySelectorAll('[aria-label]').forEach(e => {
      const v = e.getAttribute('aria-label');
      if (v) parts.add(v.trim());
    });
    // title attributes
    el.querySelectorAll('[title]').forEach(e => {
      const v = e.getAttribute('title');
      if (v) parts.add(v.trim());
    });
    // href text (extract @handle from links)
    el.querySelectorAll('a[href]').forEach(e => {
      const m = e.href.match(/\/@([^\/\?&]+)/);
      if (m) parts.add(m[1]);
      const m2 = e.href.match(/\/(?:c|user)\/([^\/\?&]+)/);
      if (m2) parts.add(m2[1]);
    });
    return Array.from(parts).join(' ');
  }

  /**
   * Check if a video/item element should be blocked.
   * Pass 1: explicit channel name → handle → title
   * Pass 2: broad text scan (catches Shorts items with no explicit channel els)
   * Returns { keyword, source, type } or null.
   */
  function shouldBlockVideo(videoElement) {
    // Skip the channel-result card in search — we explicitly leave those visible
    if (videoElement.tagName && videoElement.tagName.toLowerCase() === 'ytd-channel-renderer') {
      return null;
    }

    // 1. Channel display name
    const channelName = getChannelName(videoElement);
    let match = matchesBlocklist(channelName);
    if (match) return { keyword: match, source: channelName, type: 'channel' };

    // 2. Channel handle (extracted from any @-URL in the element)
    const handle = getChannelHandle(videoElement);
    match = matchesBlocklist(handle);
    if (match) return { keyword: match, source: '@' + handle, type: 'channel' };

    // 3. Video/Short title
    const title = getVideoTitle(videoElement);
    match = matchesBlocklist(title);
    if (match) return { keyword: match, source: title, type: 'title' };

    // 4. Broad innerText scan (Ultimate Fallback)
    // Catches modern lockup models or obfuscated DOMs where titles lack IDs/classes
    // Since videoElement strictly bounds one video card, any appearance of the keyword
    // in its inner text (title, channel, views) is a guaranteed match.
    const rawText = (videoElement.innerText || '').toLowerCase();
    for (const kw of blockedKeywords) {
      if (rawText.includes(kw)) {
        return { keyword: kw, source: 'Content text match', type: 'broad' };
      }
    }

    // 5. Broad sweep — aria-labels, embedded @handles in links
    // This catches Shorts items that render the creator name only in aria-label
    // and might lack innerText (e.g., purely graphic carousels)
    const broad = getBroadText(videoElement);
    match = matchesBlocklist(broad);
    if (match) return { keyword: match, source: '(matched in metadata)', type: 'broad' };

    return null;
  }

  /**
   * Check if a section/shelf should be blocked.
   * Matches against: shelf title text (e.g. "Latest Shorts from Ishan Sharma"),
   * and also does a broad handle scan across all links in the shelf.
   */
  function shouldBlockSection(sectionElement) {
    // Don't block ytd-item-section-renderer that wraps the channel card — those have
    // a ytd-channel-renderer inside. If the ONLY video-like child is a channel card, skip.
    const childTags = Array.from(sectionElement.children).map(c => c.tagName.toLowerCase());
    if (childTags.length === 1 && childTags[0] === 'ytd-channel-renderer') return null;

    // 1. Shelf title text
    const titleSelectors = [
      '#title-text',
      '#title yt-formatted-string',
      '#title span',
      '#title',
      'h2 yt-formatted-string',
      'h2 span',
      'h2',
      '#rich-shelf-header yt-formatted-string',
      '#rich-shelf-header span',
      'yt-dynamic-text-view-model',
      '.shortsShelfTitleCellRendererTitle'
    ];
    for (const sel of titleSelectors) {
      const el = sectionElement.querySelector(sel);
      if (el) {
        const text = (el.textContent || '').trim();
        if (text.length < 5) continue; // skip empty / whitespace nodes
        const match = matchesBlocklist(text);
        if (match) return { keyword: match, source: text };
      }
    }

    // 2. Scan all @-handles in links inside the shelf
    //    Catches "Latest Shorts" where the title may not embed the name
    const links = sectionElement.querySelectorAll('a[href*="/@"]');
    const handles = new Set();
    for (const link of links) {
      const m = link.href.match(/\/@([^\/\?&]+)/);
      if (m) handles.add(m[1]);
    }
    for (const h of handles) {
      const match = matchesBlocklist(h);
      if (match) return { keyword: match, source: '@' + h };
    }

    return null;
  }

  function createBlockedPlaceholder(matchInfo, originalElement) {
    const placeholder = document.createElement('div');
    placeholder.className = 'unfucktard-blocked-placeholder';
    placeholder.setAttribute('data-unfucktard', 'placeholder');

    const typeLabel = matchInfo.type === 'title' ? 'Title match' : 'Channel match';
    const displaySource = matchInfo.source && matchInfo.source.length > 60
      ? matchInfo.source.substring(0, 57) + '...'
      : matchInfo.source || matchInfo.keyword;

    placeholder.innerHTML = `
      <div class="unfucktard-blocked-inner">
        <div class="unfucktard-blocked-icon">${SHIELD_SVG}</div>
        <div class="unfucktard-blocked-text">
          <span class="unfucktard-blocked-label">Fucktard detected & blocked by Unfucktard</span>
          <span class="unfucktard-blocked-channel">${escapeHtml(displaySource)} · ${typeLabel}</span>
        </div>
        <div style="margin-left: auto; display: flex; gap: 12px; align-items: center;">
          <button class="unfucktard-blocked-show-anyway" title="Show content for this session" style="background: none; border: none; color: rgba(255,255,255,0.4); font-size: 10px; cursor: pointer; padding: 4px; text-decoration: underline;">Show anyway</button>
          <button class="unfucktard-blocked-dismiss" title="Dismiss">Hide</button>
        </div>
      </div>
    `;

    const showBtn = placeholder.querySelector('.unfucktard-blocked-show-anyway');
    showBtn.addEventListener('click', () => {
      originalElement.classList.remove('unfucktard-hidden');
      placeholder.remove();
    });

    const dismissBtn = placeholder.querySelector('.unfucktard-blocked-dismiss');
    dismissBtn.addEventListener('click', () => {
      placeholder.style.transition = 'all 0.3s ease';
      placeholder.style.opacity = '0';
      placeholder.style.maxHeight = '0';
      placeholder.style.padding = '0';
      placeholder.style.margin = '0';
      setTimeout(() => placeholder.remove(), 300);
    });

    return placeholder;
  }

  function createSectionPlaceholder(matchInfo, originalElement) {
    const placeholder = document.createElement('div');
    placeholder.className = 'unfucktard-blocked-placeholder';
    placeholder.setAttribute('data-unfucktard', 'placeholder');

    placeholder.innerHTML = `
      <div class="unfucktard-blocked-inner">
        <div class="unfucktard-blocked-icon">${SHIELD_SVG}</div>
        <div class="unfucktard-blocked-text">
          <span class="unfucktard-blocked-label">Fucktard detected & blocked by Unfucktard</span>
          <span class="unfucktard-blocked-channel">Section: ${escapeHtml(matchInfo.source)}</span>
        </div>
        <div style="margin-left: auto; display: flex; gap: 12px; align-items: center;">
          <button class="unfucktard-blocked-show-anyway" title="Show content for this session" style="background: none; border: none; color: rgba(255,255,255,0.4); font-size: 10px; cursor: pointer; padding: 4px; text-decoration: underline;">Show anyway</button>
          <button class="unfucktard-blocked-dismiss" title="Dismiss">Hide</button>
        </div>
      </div>
    `;

    const showBtn = placeholder.querySelector('.unfucktard-blocked-show-anyway');
    showBtn.addEventListener('click', () => {
      originalElement.classList.remove('unfucktard-hidden');
      placeholder.remove();
    });

    const dismissBtn = placeholder.querySelector('.unfucktard-blocked-dismiss');
    dismissBtn.addEventListener('click', () => {
      placeholder.style.transition = 'all 0.3s ease';
      placeholder.style.opacity = '0';
      placeholder.style.maxHeight = '0';
      placeholder.style.padding = '0';
      placeholder.style.margin = '0';
      setTimeout(() => placeholder.remove(), 300);
    });

    return placeholder;
  }

  function blockVideo(videoElement) {
    if (videoElement.hasAttribute('data-unfucktard-processed')) return;

    const matchInfo = shouldBlockVideo(videoElement);
    if (!matchInfo) {
      videoElement.setAttribute('data-unfucktard-processed', 'clean');
      injectQuickBlockButton(videoElement);
      return;
    }

    videoElement.setAttribute('data-unfucktard-processed', 'blocked');
    videoElement.classList.add('unfucktard-hidden');

    const placeholder = createBlockedPlaceholder(matchInfo, videoElement);
    videoElement.parentNode.insertBefore(placeholder, videoElement);

    blockedCount++;
    sendMessage({ type: 'INCREMENT_BLOCKED', count: 1 });
  }

  function blockSection(sectionElement) {
    if (sectionElement.hasAttribute('data-unfucktard-processed')) return;

    const matchInfo = shouldBlockSection(sectionElement);
    if (!matchInfo) {
      sectionElement.setAttribute('data-unfucktard-processed', 'clean');
      return;
    }

    sectionElement.setAttribute('data-unfucktard-processed', 'blocked');
    sectionElement.classList.add('unfucktard-hidden');

    const placeholder = createSectionPlaceholder(matchInfo, sectionElement);
    sectionElement.parentNode.insertBefore(placeholder, sectionElement);

    blockedCount++;
    sendMessage({ type: 'INCREMENT_BLOCKED', count: 1 });
  }

  function injectQuickBlockButton(videoElement) {
    if (videoElement.querySelector('.unfucktard-quick-block')) return;

    // Get the best available keyword for the block operation
    const channelName = getChannelName(videoElement) || getChannelHandle(videoElement);
    if (!channelName) return;

    const btn = document.createElement('button');
    btn.className = 'unfucktard-quick-block';
    btn.title = `Block "${channelName}" with unfcktard`;
    btn.innerHTML = typeof BAN_SVG !== 'undefined' ? BAN_SVG : SHIELD_SVG;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const result = await sendMessage({ type: 'ADD_CHANNELS', channels: [channelName] });
      if (result && result.success) {
        blockedKeywords = buildKeywords(result.channels);
        showToast(`Target ignored: "${channelName}"`);
        resetAndRescan();
      }
    });

    if (window.getComputedStyle(videoElement).position === 'static') {
      videoElement.style.position = 'relative';
    }

    videoElement.appendChild(btn);
  }

  // ——— Channel Page Blocking ———

  function getChannelFromUrl() {
    const url = location.pathname;
    const handleMatch = url.match(/^\/@([^\/]+)/);
    if (handleMatch) return { handle: '@' + handleMatch[1], raw: handleMatch[1] };

    const channelMatch = url.match(/^\/(channel|c|user)\/([^\/]+)/);
    if (channelMatch) return { handle: channelMatch[2], raw: channelMatch[2] };

    return null;
  }

  function isOnBlockedChannelPage() {
    const channelInfo = getChannelFromUrl();
    if (!channelInfo) return null;

    // Check URL handle against keywords
    const handle = channelInfo.handle.toLowerCase();
    const raw = channelInfo.raw.toLowerCase();

    if (matchesBlocklist(handle) || matchesBlocklist(raw)) {
      return channelInfo.handle;
    }

    // Also check display name from the page header
    const pageChannelName = getPageChannelName();
    if (pageChannelName && matchesBlocklist(pageChannelName)) {
      return pageChannelName;
    }

    return null;
  }

  function getPageChannelName() {
    const selectors = [
      'yt-dynamic-text-view-model .yt-core-attributed-string--white-space-pre-wrap',
      '#channel-header ytd-channel-name yt-formatted-string',
      '#channel-header-container ytd-channel-name yt-formatted-string',
      'ytd-c4-tabbed-header-renderer #channel-name yt-formatted-string',
      '#inner-header-container #text.ytd-channel-name',
      '#channel-header #text',
      'ytd-c4-tabbed-header-renderer #text'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const name = (el.textContent || '').trim();
        if (name && name.length > 0 && name.length < 200) return name;
      }
    }
    return null;
  }

  function checkChannelPage() {
    if (!isEnabled) return;
    removeChannelPageOverlay();

    const blockedChannel = isOnBlockedChannelPage();
    if (blockedChannel) {
      showChannelPageOverlay(blockedChannel);
    }
  }

  function showChannelPageOverlay(channelName) {
    if (document.getElementById('unfucktard-channel-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'unfucktard-channel-overlay';
    overlay.className = 'unfucktard-channel-overlay';

    overlay.innerHTML = `
      <div class="unfucktard-channel-overlay-content">
        <div class="unfucktard-channel-overlay-icon">${SHIELD_SVG}</div>
        <h2 class="unfucktard-channel-overlay-title">Fucktard Detected</h2>
        <p class="unfucktard-channel-overlay-channel">${escapeHtml(channelName)}</p>
        <p class="unfucktard-channel-overlay-desc">This fucktard is on your blocklist and got blocked by Unfucktard.<br>You won't see any content from this channel.</p>
        <div class="unfucktard-channel-overlay-actions">
          <button class="unfucktard-overlay-btn unfucktard-overlay-btn-back" id="unfucktard-go-back">Go Back</button>
          <button class="unfucktard-overlay-btn unfucktard-overlay-btn-unblock" id="unfucktard-unblock">Unblock Channel</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    document.getElementById('unfucktard-go-back').addEventListener('click', () => {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = 'https://www.youtube.com';
      }
    });

    document.getElementById('unfucktard-unblock').addEventListener('click', async () => {
      const channelInfo = getChannelFromUrl();
      const promises = [];
      if (channelInfo) {
        promises.push(sendMessage({ type: 'REMOVE_CHANNEL', channel: channelInfo.handle }));
        promises.push(sendMessage({ type: 'REMOVE_CHANNEL', channel: channelInfo.raw }));
        promises.push(sendMessage({ type: 'REMOVE_CHANNEL', channel: '@' + channelInfo.raw }));
      }
      const pageName = getPageChannelName();
      if (pageName) {
        promises.push(sendMessage({ type: 'REMOVE_CHANNEL', channel: pageName }));
      }
      promises.push(sendMessage({ type: 'REMOVE_CHANNEL', channel: channelName }));
      await Promise.all(promises);

      removeChannelPageOverlay();
      showToast(`Unblocked "${channelName}"`);
    });
  }

  function removeChannelPageOverlay() {
    const overlay = document.getElementById('unfucktard-channel-overlay');
    if (overlay) {
      overlay.remove();
      document.body.style.overflow = '';
    }
  }

  // ——— Shorts Page Blocking ———
  // When the user is on /shorts/VIDEO_ID, detect the creator and overlay if blocked.

  function checkShortsPage() {
    if (!isEnabled) return;

    // Only applies on /shorts/* pages
    if (!location.pathname.startsWith('/shorts/')) return;

    // If overlay already up, recheck in case creator changed (SPA scroll)
    removeChannelPageOverlay();

    // Try to get creator from the Shorts player page
    const creatorName = getShortsCreatorName();
    const creatorHandle = getShortsCreatorHandle();

    const nameMatch = matchesBlocklist(creatorName);
    const handleMatch = matchesBlocklist(creatorHandle);

    if (nameMatch || handleMatch) {
      showChannelPageOverlay(creatorName || creatorHandle || 'Unknown creator');
    }
  }

  function getShortsCreatorName() {
    const selectors = [
      // New Shorts player layout
      '#channel-name .yt-core-attributed-string',
      '#channel-name yt-formatted-string',
      'ytd-reel-player-overlay-renderer #channel-name',
      '.shortsChannelDetailsChannelName',
      'ytd-channel-name yt-formatted-string',
      // Overlay text
      '[class*="channelName"] span',
      '[class*="ChannelName"] span'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        const name = (el.textContent || '').trim();
        if (name && name.length > 0 && name.length < 200) return name;
      }
    }
    return null;
  }

  function getShortsCreatorHandle() {
    // Look for @handle links in the Shorts overlay
    const links = document.querySelectorAll(
      'ytd-reel-player-overlay-renderer a[href*="/@"], ' +
      '.shortsChannelDetailsContainer a[href*="/@"], ' +
      '#channel-name a[href*="/@"]'
    );
    for (const link of links) {
      const m = link.href.match(/\/@([^\/\?&]+)/);
      if (m) return m[1];
    }
    return null;
  }

  // ——— Page Scanning ———

  function scanPage() {
    if (!isEnabled) return;

    // Check channel page overlay first
    checkChannelPage();
    // Check Shorts standalone page
    checkShortsPage();

    // Scan sections FIRST — if a whole shelf is blocked, mark it so individual
    // video items inside don't each get their own placeholder on top.
    const sections = document.querySelectorAll(SECTION_SELECTORS);
    sections.forEach(section => {
      if (!section.hasAttribute('data-unfucktard-processed')) {
        blockSection(section);
      }
    });

    // Scan individual video/item elements — skip any that are inside an already-blocked section
    const videos = document.querySelectorAll(VIDEO_SELECTORS);
    videos.forEach(video => {
      if (!video.hasAttribute('data-unfucktard-processed')) {
        // If this item is inside a section that's already been hidden, just mark it
        if (video.closest('.unfucktard-hidden')) {
          video.setAttribute('data-unfucktard-processed', 'blocked-parent');
          return;
        }
        blockVideo(video);
      }
    });
  }

  function debouncedScan() {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => scanPage(), 150);
  }

  function resetAndRescan() {
    document.querySelectorAll('[data-unfucktard-processed]').forEach(el => {
      el.removeAttribute('data-unfucktard-processed');
    });
    document.querySelectorAll('[data-unfucktard="placeholder"]').forEach(el => el.remove());
    document.querySelectorAll('.unfucktard-quick-block').forEach(el => el.remove());
    document.querySelectorAll('.unfucktard-hidden').forEach(el => {
      el.classList.remove('unfucktard-hidden');
    });
    removeChannelPageOverlay();
    scanPage();
  }

  function unhideAll() {
    document.querySelectorAll('.unfucktard-hidden').forEach(el => {
      el.classList.remove('unfucktard-hidden');
      el.removeAttribute('data-unfucktard-processed');
    });
    document.querySelectorAll('[data-unfucktard="placeholder"]').forEach(el => el.remove());
    document.querySelectorAll('.unfucktard-quick-block').forEach(el => el.remove());
  }

  // ——— MutationObserver ———

  function startObserver() {
    if (observer) return;

    observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          shouldScan = true;
          break;
        }
      }
      if (shouldScan) {
        debouncedScan();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // ——— YouTube SPA Navigation ———

  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => {
        resetAndRescan();
      }, 500);
    }
  });
  urlObserver.observe(document.querySelector('title') || document.head, {
    childList: true,
    subtree: true
  });

  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => resetAndRescan(), 300);
  });

  // Shorts SPA uses a different event
  window.addEventListener('yt-page-data-updated', () => {
    setTimeout(() => resetAndRescan(), 400);
  });

  // ——— Utilities ———

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message) {
    document.querySelectorAll('.unfucktard-toast').forEach(t => t.remove());

    const toast = document.createElement('div');
    toast.className = 'unfucktard-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  // ——— Start ———
  init();
})();
