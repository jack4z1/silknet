// Silknet v1.1 Popup Controller
// Manages Master ON/OFF toggle, Provider Tab selection (Max 3), and Realtime Status indicators

const PROVIDERS = ['chatgpt', 'claude', 'gemini'];

document.addEventListener('DOMContentLoaded', async () => {
  const masterToggle = document.getElementById('master-toggle');
  const serverStatusCard = document.getElementById('server-status');
  const serverStatusText = document.getElementById('server-status-text');

  // Load saved preferences
  const state = await chrome.storage.local.get({
    enabled: true,
    selectedTabs: ['chatgpt', 'claude', 'gemini'],
  });

  masterToggle.checked = state.enabled;
  updateToggleUi(state.enabled);

  // Initialize Tab selection buttons
  PROVIDERS.forEach((p) => {
    const btn = document.getElementById(`btn-${p}`);
    if (state.selectedTabs.includes(p)) {
      btn.classList.add('selected');
    } else {
      btn.classList.remove('selected');
    }

    btn.addEventListener('click', async () => {
      if (!masterToggle.checked) return;

      btn.classList.toggle('selected');
      const updated = getSelectedTabs();
      await chrome.storage.local.set({ selectedTabs: updated });
      // Notify background worker of changed tab selection
      chrome.runtime.sendMessage({ type: 'UPDATE_TAB_SELECTION', selectedTabs: updated }).catch(() => {});
    });
  });

  // Handle Master Toggle Changes
  masterToggle.addEventListener('change', async () => {
    const isEnabled = masterToggle.checked;
    await chrome.storage.local.set({ enabled: isEnabled });
    updateToggleUi(isEnabled);
    chrome.runtime.sendMessage({ type: 'TOGGLE_MASTER', enabled: isEnabled }).catch(() => {});
    refreshStatus();
  });

  function updateToggleUi(isEnabled) {
    if (!isEnabled) {
      serverStatusCard.className = 'status-card disabled';
      serverStatusText.textContent = 'Silknet Bridge Disabled';
      PROVIDERS.forEach((p) => {
        setProviderStatus(p, 'dot-red', 'Disabled');
      });
    }
  }

  function getSelectedTabs() {
    const selected = [];
    PROVIDERS.forEach((p) => {
      const btn = document.getElementById(`btn-${p}`);
      if (btn.classList.contains('selected')) {
        selected.push(p);
      }
    });
    return selected;
  }

  // Real-time status update
  async function refreshStatus() {
    if (!masterToggle.checked) return;

    try {
      // Query background script for current connection & active tabs
      const response = await chrome.runtime.sendMessage({ type: 'GET_BRIDGE_STATUS' }).catch(() => null);

      if (response && response.serverConnected) {
        serverStatusCard.className = 'status-card connected';
        serverStatusText.textContent = 'Connected (Port 4040)';

        const activeTabs = response.activeTabs || {};
        PROVIDERS.forEach((p) => {
          if (activeTabs[p]) {
            setProviderStatus(p, 'dot-green', 'Connected');
          } else {
            setProviderStatus(p, 'dot-red', 'Tab Offline');
          }
        });
      } else {
        serverStatusCard.className = 'status-card disconnected';
        serverStatusText.textContent = 'Server Offline (Port 4040)';
        PROVIDERS.forEach((p) => {
          setProviderStatus(p, 'dot-red', 'Offline');
        });
      }
    } catch (e) {
      serverStatusCard.className = 'status-card disconnected';
      serverStatusText.textContent = 'Disconnected';
      PROVIDERS.forEach((p) => {
        setProviderStatus(p, 'dot-red', 'Offline');
      });
    }
  }

  function setProviderStatus(provider, dotClass, label) {
    const dot = document.getElementById(`dot-${provider}`);
    const lbl = document.getElementById(`lbl-${provider}`);
    if (dot && lbl) {
      dot.className = `indicator-dot ${dotClass}`;
      lbl.textContent = label;
    }
  }

  // Initial fetch and interval poll
  refreshStatus();
  const pollInterval = setInterval(refreshStatus, 1500);

  window.addEventListener('unload', () => {
    clearInterval(pollInterval);
  });
});
