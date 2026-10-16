// Silknet v1.1 Background Service Worker
// Coordinates WebSocket bridge to the local server, manages tab filtering (max 3), and handles parallel multi-tab execution.
// Fixed: Service worker eviction resilience — content scripts send results independently via chrome.runtime.sendMessage

const BRIDGE_WS_URL = 'ws://127.0.0.1:4040/ws';
let ws = null;
let reconnectTimer = null;
let isEnabled = true;
let selectedTabs = ['chatgpt', 'claude', 'gemini'];

// Track which request IDs we've already forwarded to avoid duplicates
const forwardedResults = new Set();
// Track active operations to keep service worker alive
let activeOps = 0;
let keepAliveInterval = null;

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

// Keep service worker alive during active operations
function startKeepAlive() {
  activeOps++;
  if (!keepAliveInterval) {
    keepAliveInterval = setInterval(() => {
      // Any activity prevents service worker eviction
      if (activeOps > 0) {
        safeSend({ type: 'PING' });
      }
    }, 15000);
  }
}

function stopKeepAlive() {
  activeOps = Math.max(0, activeOps - 1);
  if (activeOps <= 0 && keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// Initialize settings from chrome.storage
chrome.storage.local.get({ enabled: true, selectedTabs: ['chatgpt', 'claude', 'gemini'] }, (data) => {
  isEnabled = data.enabled;
  selectedTabs = data.selectedTabs || ['chatgpt', 'claude', 'gemini'];
  if (isEnabled) {
    connectBridge();
  }
});

// Listen for messages from popup AND from content scripts
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

  // === CRITICAL FIX: Content script sends results independently ===
  // This handles results even if the service worker was restarted mid-operation
  if (msg.type === 'PROMPT_RESULT_FROM_CONTENT') {
    const reqId = msg.id;
    console.log(`[Silknet v1.1 Worker] 📬 Received independent result from content script: ${msg.provider} (${reqId})`);

    // Avoid sending duplicate results
    if (!forwardedResults.has(reqId)) {
      forwardedResults.add(reqId);

      // Clean up old entries after 5 minutes
      setTimeout(() => forwardedResults.delete(reqId), 300000);

      // Ensure WebSocket is connected before forwarding
      ensureConnectedThenSend({
        type: 'PROMPT_RESULT',
        id: reqId,
        provider: msg.provider,
        success: msg.success,
        reply: msg.reply || '',
        error: msg.error,
      });
    }

    stopKeepAlive();
    sendResponse({ received: true });
    return false;
  }
});

// Ensure we're connected to the server, then send the message
async function ensureConnectedThenSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    safeSend(data);
    return;
  }

  // Queue in persistent storage so it survives service worker restarts
  try {
    const stored = await chrome.storage.local.get({ pendingQueue: [] });
    stored.pendingQueue.push(data);
    await chrome.storage.local.set({ pendingQueue: stored.pendingQueue });
    console.log(`[Silknet v1.1 Worker] 💾 Queued result in storage (${data.provider})`);
  } catch {}

  // Try to reconnect
  try {
    await connectBridge();
  } catch {
    console.warn('[Silknet v1.1 Worker] Could not reconnect immediately to forward result');
  }
}

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

      // Flush any queued results from storage
      try {
        const stored = await chrome.storage.local.get({ pendingQueue: [] });
        if (stored.pendingQueue && stored.pendingQueue.length > 0) {
          console.log(`[Silknet v1.1 Worker] 🚀 Flushing ${stored.pendingQueue.length} queued result(s) to server`);
          for (const item of stored.pendingQueue) {
            safeSend(item);
          }
          await chrome.storage.local.set({ pendingQueue: [] });
        }
      } catch (err) {
        console.warn('[Silknet v1.1 Worker] Error flushing result queue:', err);
      }

      try {
        await syncAllAiTabs();
      } catch (e) {
        // Ignored during service worker reload/unload
      }
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        console.log('[Silknet v1.1 Worker] Received server message:', msg.type);

        if (msg.type === 'EXECUTE_PROMPT') {
          // Fire-and-forget: don't await so we don't block other messages
          handleExecuteRequest(msg).catch((err) => {
            console.error('[Silknet v1.1 Worker] handleExecuteRequest error:', err);
          });
        } else if (msg.type === 'EXECUTE_MULTI_PROMPT') {
          handleMultiExecuteRequest(msg).catch((err) => {
            console.error('[Silknet v1.1 Worker] handleMultiExecuteRequest error:', err);
          });
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
  try {
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
  } catch (err) {
    // Graceful exit if SW is terminating
  }
}

// Single prompt execution
async function handleExecuteRequest(msg) {
  const { id, prompt, provider, attachments } = msg;

  startKeepAlive();

  try {
    const tab = await findTargetTab(provider);
    if (!tab || !tab.id) {
      throw new Error(`No active browser tab found for provider: ${provider}`);
    }

    // Ensure content script injection
    await ensureContentScript(tab.id);

    console.log(`[Silknet v1.1 Worker] Dispatching prompt to Tab ${tab.id} (${provider})...`);

    // Dispatch to content script without blocking for completion.
    // The content script acknowledges immediately and delivers the real result
    // via chrome.runtime.sendMessage ('PROMPT_RESULT_FROM_CONTENT').
    chrome.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_PROMPT',
      id,
      prompt,
      attachments: attachments || [],
    }).catch((err) => {
      console.warn(`[Silknet v1.1 Worker] Could not dispatch prompt to tab ${tab.id}:`, err);
      if (!forwardedResults.has(id)) {
        forwardedResults.add(id);
        setTimeout(() => forwardedResults.delete(id), 300000);
        safeSend({
          type: 'PROMPT_RESULT',
          id,
          provider,
          success: false,
          reply: '',
          error: `Could not send prompt to ${provider} tab: ${err.message}`,
        });
      }
    });
  } catch (err) {
    if (!forwardedResults.has(id)) {
      forwardedResults.add(id);
      setTimeout(() => forwardedResults.delete(id), 300000);
      safeSend({
        type: 'PROMPT_RESULT',
        id,
        provider,
        success: false,
        reply: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    stopKeepAlive();
  }
}

// Multi-Tab execution: Dispatches prompt & attachments in parallel across up to 3 selected tabs
async function handleMultiExecuteRequest(msg) {
  const { id, prompt, attachments, targetProviders } = msg;
  const providersToRun = targetProviders && targetProviders.length > 0
    ? targetProviders.filter((p) => selectedTabs.includes(p))
    : selectedTabs;

  console.log(`[Silknet v1.1 Worker] Executing multi-tab prompt across: ${providersToRun.join(', ')}`);

  startKeepAlive();

  try {
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
  } finally {
    stopKeepAlive();
  }
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

// Watch for tab updates — only notify server if tab URL actually changed
const knownTabUrls = new Map();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    const provider = getProviderFromUrl(tab.url);
    if (provider && selectedTabs.includes(provider)) {
      const prev = knownTabUrls.get(tabId);
      if (prev !== tab.url) {
        knownTabUrls.set(tabId, tab.url);
        safeSend({
          type: 'HELLO',
          id: String(tabId),
          provider,
          title: tab.title,
          url: tab.url,
        });
      }
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  knownTabUrls.delete(tabId);
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
