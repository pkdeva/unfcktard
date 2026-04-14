// Unfucktard — Popup Script

document.addEventListener('DOMContentLoaded', () => {
  const elements = {
    toggle: document.getElementById('toggleExtension'),
    input: document.getElementById('channelInput'),
    addBtn: document.getElementById('addBtn'),
    channelList: document.getElementById('channelList'),
    emptyState: document.getElementById('emptyState'),
    clearAllBtn: document.getElementById('clearAllBtn'),
    channelCount: document.getElementById('channelCount'),
    totalBlocked: document.getElementById('totalBlocked'),
    container: document.querySelector('.popup-container'),
    autocomplete: document.getElementById('autocompleteDropdown'),
    suggestionsSection: document.getElementById('suggestionsSection'),
    suggestionsGrid: document.getElementById('suggestionsGrid')
  };

  let channels = [];
  let autocompleteIndex = -1; // keyboard nav index

  // ——— Init ———
  loadData();
  renderSuggestions();

  // ——— Event Listeners ———

  elements.addBtn.addEventListener('click', () => {
    addChannelFromInput();
  });

  elements.input.addEventListener('keydown', (e) => {
    const items = elements.autocomplete.querySelectorAll('.ac-item');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      autocompleteIndex = Math.min(autocompleteIndex + 1, items.length - 1);
      updateAutocompleteHighlight(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      autocompleteIndex = Math.max(autocompleteIndex - 1, -1);
      updateAutocompleteHighlight(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (autocompleteIndex >= 0 && items[autocompleteIndex]) {
        items[autocompleteIndex].click();
      } else {
        addChannelFromInput();
      }
    } else if (e.key === 'Escape') {
      hideAutocomplete();
      elements.input.blur();
    }
  });

  elements.input.addEventListener('input', () => {
    const query = elements.input.value.trim();
    if (query.length > 0) {
      showAutocomplete(query);
    } else {
      hideAutocomplete();
    }
  });

  elements.input.addEventListener('focus', () => {
    const query = elements.input.value.trim();
    if (query.length > 0) {
      showAutocomplete(query);
    }
  });

  // Close autocomplete when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.input-container')) {
      hideAutocomplete();
    }
  });

  elements.toggle.addEventListener('change', () => {
    const isEnabled = elements.toggle.checked;
    chrome.runtime.sendMessage({ type: 'TOGGLE_EXTENSION', isEnabled }, () => {
      updateDisabledState(isEnabled);
    });
  });

  elements.clearAllBtn.addEventListener('click', () => {
    if (channels.length === 0) return;

    if (confirm('Remove all blocked channels?')) {
      chrome.runtime.sendMessage({ type: 'REMOVE_CHANNELS', channels }, (response) => {
        if (response && response.success) {
          channels = [];
          renderChannelList();
          updateStats();
          renderSuggestions();
        }
      });
    }
  });

  // ——— Autocomplete ———

  function showAutocomplete(query) {
    const q = query.toLowerCase();
    autocompleteIndex = -1;

    // Search through suggestions
    const matches = SUGGESTED_FUCKTARDS.filter(s => {
      // Don't suggest already-blocked entries
      const allKeywords = [s.name, s.handle, '@' + s.handle, ...s.keywords];
      const isAlreadyBlocked = allKeywords.some(kw =>
        channels.some(ch => ch.toLowerCase() === kw.toLowerCase())
      );
      if (isAlreadyBlocked) return false;

      // Match against name, handle, keywords
      return (
        s.name.toLowerCase().includes(q) ||
        s.handle.toLowerCase().includes(q) ||
        s.keywords.some(kw => kw.toLowerCase().includes(q))
      );
    });

    if (matches.length === 0) {
      hideAutocomplete();
      return;
    }

    elements.autocomplete.innerHTML = '';

    // Show top 6 matches
    matches.slice(0, 6).forEach((suggestion, idx) => {
      const item = document.createElement('div');
      item.className = 'ac-item';
      item.setAttribute('data-index', idx);

      const cat = CATEGORY_META[suggestion.category] || { label: '', color: '#888' };

      item.innerHTML = `
        <div class="ac-avatar" style="background: ${cat.color}20; color: ${cat.color}; border-color: ${cat.color}40;">
          ${suggestion.name[0].toUpperCase()}
        </div>
        <div class="ac-info">
          <span class="ac-name">${highlightMatch(suggestion.name, query)}</span>
          <span class="ac-handle">@${highlightMatch(suggestion.handle, query)} · ${cat.label}</span>
        </div>
        <div class="ac-add-icon">
          <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        </div>
      `;

      item.addEventListener('click', () => {
        addSuggestion(suggestion);
        hideAutocomplete();
        elements.input.value = '';
        elements.input.focus();
      });

      item.addEventListener('mouseenter', () => {
        autocompleteIndex = idx;
        updateAutocompleteHighlight(elements.autocomplete.querySelectorAll('.ac-item'));
      });

      elements.autocomplete.appendChild(item);
    });

    elements.autocomplete.classList.add('visible');
  }

  function hideAutocomplete() {
    elements.autocomplete.classList.remove('visible');
    autocompleteIndex = -1;
  }

  function updateAutocompleteHighlight(items) {
    items.forEach((item, i) => {
      item.classList.toggle('highlighted', i === autocompleteIndex);
    });
    // Scroll into view
    if (autocompleteIndex >= 0 && items[autocompleteIndex]) {
      items[autocompleteIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
    return escaped.replace(regex, '<mark>$1</mark>');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ——— Suggestions Grid ———

  function renderSuggestions() {
    elements.suggestionsGrid.innerHTML = '';

    // Filter out already-blocked suggestions
    const available = SUGGESTED_FUCKTARDS.filter(s => {
      const allKeywords = [s.name, s.handle, '@' + s.handle, ...s.keywords];
      return !allKeywords.some(kw =>
        channels.some(ch => ch.toLowerCase() === kw.toLowerCase())
      );
    });

    if (available.length === 0) {
      elements.suggestionsSection.style.display = 'none';
      return;
    }

    elements.suggestionsSection.style.display = 'block';

    // Show shuffled selection of chips
    const shuffled = available.sort(() => Math.random() - 0.5).slice(0, 12);

    shuffled.forEach(suggestion => {
      const chip = document.createElement('button');
      chip.className = 'suggestion-chip';

      const cat = CATEGORY_META[suggestion.category] || { label: '', color: '#888' };

      chip.innerHTML = `
        <span class="chip-name">${escapeHtml(suggestion.name)}</span>
        <span class="chip-add">+</span>
      `;
      chip.style.setProperty('--chip-color', cat.color);
      chip.title = `Block ${suggestion.name} (@${suggestion.handle}) — adds ${suggestion.keywords.length} keywords`;

      chip.addEventListener('click', () => {
        addSuggestion(suggestion);
        chip.classList.add('chip-added');
        chip.disabled = true;
        chip.innerHTML = `
          <span class="chip-name">${escapeHtml(suggestion.name)}</span>
          <span class="chip-check">✓</span>
        `;
        setTimeout(() => {
          chip.style.transition = 'all 0.3s ease';
          chip.style.opacity = '0';
          chip.style.transform = 'scale(0.8)';
          setTimeout(() => chip.remove(), 300);
        }, 600);
      });

      elements.suggestionsGrid.appendChild(chip);
    });
  }

  // ——— Add Channel Logic ———

  function addSuggestion(suggestion) {
    // Add all keywords from the suggestion using the safe plural endpoint
    const toAdd = [...new Set(suggestion.keywords)];
    
    chrome.runtime.sendMessage({ type: 'ADD_CHANNELS', channels: toAdd }, (response) => {
      // response.channels is the updated list
      if (response && response.channels) {
        channels = response.channels;
        renderChannelList();
        updateStats();
        renderSuggestions();
      }
    });
  }

  function addChannelFromInput() {
    const value = elements.input.value.trim();
    if (!value) {
      elements.input.classList.add('shake');
      setTimeout(() => elements.input.classList.remove('shake'), 300);
      return;
    }

    // Check if input matches a suggestion — if so, add all keywords
    const matchedSuggestion = SUGGESTED_FUCKTARDS.find(s =>
      s.name.toLowerCase() === value.toLowerCase() ||
      s.handle.toLowerCase() === value.toLowerCase() ||
      ('@' + s.handle).toLowerCase() === value.toLowerCase() ||
      s.keywords.some(kw => kw.toLowerCase() === value.toLowerCase())
    );

    if (matchedSuggestion) {
      addSuggestion(matchedSuggestion);
      elements.input.value = '';
      hideAutocomplete();
      return;
    }

    // Otherwise add as custom keyword
    chrome.runtime.sendMessage({ type: 'ADD_CHANNEL', channel: value }, (response) => {
      if (response && response.success) {
        channels = response.channels;
        elements.input.value = '';
        hideAutocomplete();
        renderChannelList();
        updateStats();
        renderSuggestions();
      } else {
        elements.input.classList.add('shake');
        setTimeout(() => elements.input.classList.remove('shake'), 300);
      }
    });
  }

  // ——— Data Loading ———

  function loadData() {
    chrome.storage.sync.get(['blockedChannels', 'isEnabled', 'stats'], (data) => {
      channels = data.blockedChannels || [];
      const isEnabled = data.isEnabled !== false;
      const stats = data.stats || { totalBlocked: 0 };

      elements.toggle.checked = isEnabled;
      elements.totalBlocked.textContent = formatNumber(stats.totalBlocked || 0);
      updateDisabledState(isEnabled);
      renderChannelList();
      updateStats();
      renderSuggestions();
    });
  }

  // ——— Channel List ———

  function removeChannel(channelName) {
    chrome.runtime.sendMessage({ type: 'REMOVE_CHANNEL', channel: channelName }, (response) => {
      if (response && response.success) {
        channels = response.channels;
        renderChannelList();
        updateStats();
        renderSuggestions();
      }
    });
  }

  function renderChannelList() {
    elements.channelList.innerHTML = '';

    if (channels.length === 0) {
      elements.emptyState.style.display = 'flex';
      elements.channelList.style.display = 'none';
      elements.clearAllBtn.style.display = 'none';
      return;
    }

    elements.emptyState.style.display = 'none';
    elements.channelList.style.display = 'block';
    elements.clearAllBtn.style.display = 'inline-block';

    channels.forEach((channel, index) => {
      const item = document.createElement('div');
      item.className = 'channel-item';
      item.style.animationDelay = `${index * 30}ms`;

      const initial = channel.startsWith('@') ? channel[1] : channel[0];

      // Check if this keyword belongs to a suggestion
      const parentSuggestion = SUGGESTED_FUCKTARDS.find(s =>
        s.keywords.some(kw => kw.toLowerCase() === channel.toLowerCase()) ||
        s.handle.toLowerCase() === channel.toLowerCase()
      );
      const catDot = parentSuggestion
        ? `<span class="cat-dot" style="background: ${(CATEGORY_META[parentSuggestion.category] || {}).color || '#888'}"></span>`
        : '';

      item.innerHTML = `
        <div class="channel-item-icon">${escapeHtml((initial || '?').toUpperCase())}</div>
        <span class="channel-item-name" title="${escapeHtml(channel)}">${catDot}${escapeHtml(channel)}</span>
        <button class="channel-item-remove" title="Unblock ${escapeHtml(channel)}">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      `;

      const removeBtn = item.querySelector('.channel-item-remove');
      removeBtn.addEventListener('click', () => {
        item.style.transition = 'all 0.2s ease';
        item.style.opacity = '0';
        item.style.transform = 'translateX(20px)';
        setTimeout(() => removeChannel(channel), 200);
      });

      elements.channelList.appendChild(item);
    });
  }

  // ——— Utilities ———

  function updateStats() {
    elements.channelCount.textContent = channels.length;
  }

  function updateDisabledState(isEnabled) {
    if (isEnabled) {
      elements.container.classList.remove('disabled');
    } else {
      elements.container.classList.add('disabled');
    }
  }

  function formatNumber(num) {
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'k';
    }
    return num.toString();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
});
