// Silknet v1.1 Background Service Worker
// Coordinates WebSocket bridge to the local server, manages tab filtering (max 3), and handles parallel multi-tab execution.

const BRIDGE_WS_URL = 'ws://127.0.0.1:4040/ws';
let ws = null;
let reconnectTimer = null;
let isEnabled = true;
let selectedTabs = ['chatgpt', 'claude', 'gemini'];

console.log('[Silknet v1.1 Worker] Service worker initialized');

function safeSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      return true;
    } catch (e) {
      console.warn('[Silknet v1.1 Worker] Failed to send over WebSocket:', e);
    }
  }
  return false;
}

// Initialize settings from chrome.storage
chrome.storage.local.get({ enabled: true, selectedTabs: ['chatgpt', 'claude', 'gemini'] }, (data) => {
  isEnabled = data.enabled;
  selectedTabs = data.selectedTabs || ['chatgpt', 'claude', 'gemini'];
  if (isEnabled) {
    connectBridge();
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TOGGLE_MASTER') {
    isEnabled = Boolean(msg.enabled);
    if (!isEnabled && ws) {
      ws.close();
      ws = null;
    } else if (isEnabled) {
      connectBridge();
    }
    sendResponse({ success: true, enabled: isEnabled });
    return false;
  }

  if (msg.type === 'UPDATE_TAB_SELECTION') {
    selectedTabs = msg.selectedTabs || [];
    syncAllAiTabs();
    sendResponse({ success: true, selectedTabs });
    return false;
  }

  if (msg.type === 'GET_BRIDGE_STATUS') {
    getActiveAiTabs().then((activeTabs) => {
      sendResponse({
        serverConnected: Boolean(ws && ws.readyState === WebSocket.OPEN),
        enabled: isEnabled,
        selectedTabs,
        activeTabs,
      });
    });
    return true; // Keep message channel open for async response
  }
});

async function connectBridge() {
  if (!isEnabled) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  // Pre-check HTTP health before opening WebSocket to avoid unhandled browser badges
  try {
    const res = await fetch('http://127.0.0.1:4040/health', { method: 'GET' });
    if (!res.ok) throw new Error('Server not ready');
  } catch {
    scheduleReconnect();
    return;
  }

  console.log('[Silknet v1.1 Worker] Connecting to local server at', BRIDGE_WS_URL);

  try {
    ws = new WebSocket(BRIDGE_WS_URL);

    ws.onopen = async () => {
      console.log('[Silknet v1.1 Worker] 🟢 Connected to Silknet Server!');
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }
      await syncAllAiTabs();
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log('[Silknet v1.1 Worker] Received server message:', msg.type);

        if (msg.type === 'EXECUTE_PROMPT') {
          await handleExecuteRequest(msg);
        } else if (msg.type === 'EXECUTE_MULTI_PROMPT') {
          await handleMultiExecuteRequest(msg);
        } else if (msg.type === 'ABORT_EXECUTION') {
          console.log('[Silknet v1.1 Worker] 🛑 Received ABORT_EXECUTION from server');
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (getProviderFromUrl(tab.url) && tab.id) {
              chrome.tabs.sendMessage(tab.id, { type: 'ABORT_EXECUTION' }).catch(() => {});
            }
          }
        }
      } catch (err) {
        console.error('[Silknet v1.1 Worker] Error handling message:', err);
      }
    };

    ws.onclose = () => {
      console.log('[Silknet v1.1 Worker] 🔴 Disconnected from local server. Retrying...');
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.log('[Silknet v1.1 Worker] WebSocket error:', err);
      ws?.close();
    };
  } catch (e) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!reconnectTimer && isEnabled) {
    reconnectTimer = setInterval(() => {
      connectBridge();
    }, 3000);
  }
}

async function getActiveAiTabs() {
  const tabs = await chrome.tabs.query({});
  const active = { chatgpt: false, claude: false, gemini: false };
  for (const t of tabs) {
    const p = getProviderFromUrl(t.url);
    if (p && selectedTabs.includes(p)) {
      active[p] = true;
    }
  }
  return active;
}

async function syncAllAiTabs() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !isEnabled) return;

  const tabs = await chrome.tabs.query({});
  const aiTabs = [];

  for (const tab of tabs) {
    const provider = getProviderFromUrl(tab.url);
    if (provider && selectedTabs.includes(provider) && tab.id) {
      aiTabs.push({
        id: String(tab.id),
        provider,
        title: tab.title,
        url: tab.url,
      });
      safeSend({
        type: 'HELLO',
        id: String(tab.id),
        provider,
        title: tab.title,
        url: tab.url,
      });
    }
  }

  safeSend({
    type: 'SYNC_ALL_TABS',
    tabs: aiTabs,
  });
}

// Single prompt execution
async function handleExecuteRequest(msg) {
  const { id, prompt, provider, attachments } = msg;

  try {
    const tab = await findTargetTab(provider);
    if (!tab || !tab.id) {
      throw new Error(`No active browser tab found for provider: ${provider}`);
    }

    // Ensure content script injection
    await ensureContentScript(tab.id);

    console.log(`[Silknet v1.1 Worker] Dispatching prompt to Tab ${tab.id} (${provider})...`);

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_PROMPT',
      id,
      prompt,
      attachments: attachments || [],
    });

    safeSend({
      type: 'PROMPT_RESULT',
      id,
      provider: result?.provider || provider,
      success: result?.success ?? false,
      reply: result?.reply || '',
      error: result?.error,
    });
  } catch (err) {
    safeSend({
      type: 'PROMPT_RESULT',
      id,
      provider,
      success: false,
      reply: '',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Multi-Tab execution: Dispatches prompt & attachments in parallel across up to 3 selected tabs
async function handleMultiExecuteRequest(msg) {
  const { id, prompt, attachments, targetProviders } = msg;
  const providersToRun = targetProviders && targetProviders.length > 0
    ? targetProviders.filter((p) => selectedTabs.includes(p))
    : selectedTabs;

  console.log(`[Silknet v1.1 Worker] Executing multi-tab prompt across: ${providersToRun.join(', ')}`);

  const dispatchPromises = providersToRun.map(async (provider) => {
    try {
      const tab = await findTargetTab(provider);
      if (!tab || !tab.id) {
        return {
          provider,
          success: false,
          reply: '',
          error: `Tab not open for ${provider}`,
        };
      }

      await ensureContentScript(tab.id);

      const result = await chrome.tabs.sendMessage(tab.id, {
        type: 'EXECUTE_PROMPT',
        id: `${id}_${provider}`,
        prompt,
        attachments: attachments || [],
      });

      return {
        provider,
        success: result?.success ?? false,
        reply: result?.reply || '',
        error: result?.error,
      };
    } catch (err) {
      return {
        provider,
        success: false,
        reply: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const results = await Promise.all(dispatchPromises);

  safeSend({
    type: 'MULTI_PROMPT_RESULT',
    id,
    results,
  });
}

async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (ping?.status === 'ok') return;
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content.js'],
    });
  } catch (e) {
    console.warn('[Silknet v1.1 Worker] Content script execution warning:', e);
  }
}

async function findTargetTab(requestedProvider) {
  const tabs = await chrome.tabs.query({});
  const matched = [];

  for (const tab of tabs) {
    const p = getProviderFromUrl(tab.url);
    if (p && selectedTabs.includes(p)) {
      matched.push({ tab, provider: p });
    }
  }

  if (matched.length === 0) return null;

  if (requestedProvider && requestedProvider !== 'auto') {
    const exact = matched.find((m) => m.provider === requestedProvider);
    return exact ? exact.tab : null;
  }

  const activeTab = matched.find((m) => m.tab.active);
  if (activeTab) return activeTab.tab;

  return matched[0].tab;
}

function getProviderFromUrl(url) {
  if (!url) return null;
  if (url.includes('chatgpt.com')) return 'chatgpt';
  if (url.includes('claude.ai')) return 'claude';
  if (url.includes('gemini.google.com')) return 'gemini';
  return null;
}

// Watch for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const provider = getProviderFromUrl(tab.url);
    if (provider && selectedTabs.includes(provider)) {
      safeSend({
        type: 'HELLO',
        id: String(tabId),
        provider,
        title: tab.title,
        url: tab.url,
      });
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  safeSend({ type: 'TAB_CLOSED', id: String(tabId) });
  setTimeout(syncAllAiTabs, 200);
});

chrome.windows.onRemoved.addListener(() => {
  setTimeout(syncAllAiTabs, 200);
});

// Keepalive ping
setInterval(() => {
  safeSend({ type: 'PING' });
}, 20000);
