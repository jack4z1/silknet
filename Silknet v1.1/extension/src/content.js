// Silknet v1.1 Content Script — Multi-Tab Consensus & Native File/Image Attachment Injector
// Direct DOM injection with DataTransfer file attachments, robust completion detection, and emergency stop.

console.log('[Silknet v1.1] Content script loaded on', window.location.hostname);

function detectProvider() {
  const host = window.location.hostname;
  if (host.includes('chatgpt.com')) return 'chatgpt';
  if (host.includes('claude.ai')) return 'claude';
  if (host.includes('gemini.google.com')) return 'gemini';
  return 'unknown';
}

const PROVIDER = detectProvider();
let isAborted = false;

// Forbidden file extensions per user specifications
const FORBIDDEN_EXTENSIONS = [
  // 3D formats
  '.obj', '.gltf', '.glb', '.stl', '.blend', '.fbx', '.3ds', '.dae', '.step', '.iges',
  // Video formats
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.3gp',
  // Audio formats
  '.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.wma', '.aiff', '.opus'
];

const MAX_TOTAL_SIZE = 20 * 1024 * 1024; // 20 MB limit
const MAX_FILE_COUNT = 5;

// Listen for execution commands from background worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PING') {
    sendResponse({ status: 'ok', provider: PROVIDER, url: window.location.href });
    return false;
  }

  if (message.type === 'ABORT_EXECUTION') {
    isAborted = true;
    console.log('[Silknet v1.1] 🛑 EMERGENCY KILLSWITCH: Stopping execution on', PROVIDER);
    clickStopButton(PROVIDER);
    sendResponse({ success: false, aborted: true });
    return false;
  }

  if (message.type === 'EXECUTE_PROMPT') {
    isAborted = false;
    handleExecutePrompt(message.prompt, message.attachments || [])
      .then((result) => sendResponse(result))
      .catch((err) => {
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          reply: '',
          provider: PROVIDER,
        });
      });
    return true; // Keep channel open for async response
  }
});

function clickStopButton(provider) {
  let selectors = [];
  if (provider === 'chatgpt') {
    selectors = ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]'];
  } else if (provider === 'claude') {
    selectors = ['button[aria-label*="Stop"]', 'button[data-testid*="stop"]'];
  } else if (provider === 'gemini') {
    selectors = ['button[aria-label*="Stop"]', 'button[data-test-id*="stop"]'];
  }

  for (const s of selectors) {
    const el = document.querySelector(s);
    if (el && isVisible(el)) {
      console.log('[Silknet v1.1] 🛑 Clicking native Stop button on', provider);
      el.click();
      return true;
    }
  }
  return false;
}

async function handleExecutePrompt(promptText, attachments) {
  console.log(`[Silknet v1.1] Executing prompt on ${PROVIDER} with ${attachments.length} attachment(s)...`);

  // Validate attachments
  validateAttachments(attachments);

  // 1. Locate message composer
  const composer = await findComposer(PROVIDER);
  if (!composer) {
    throw new Error(`Could not find chat composer on ${PROVIDER}`);
  }

  // Record baseline turns before submission
  const baselineCount = countAssistantTurns(PROVIDER);

  // 2. Inject real file/image attachments if present
  if (attachments && attachments.length > 0) {
    await injectAttachments(composer, attachments, PROVIDER);
    // Allow website to process/render attachment thumbnail in DOM
    await sleep(800);
  }

  // 3. Inject prompt text
  await injectText(composer, promptText, PROVIDER);

  // 4. Trigger auto-send (waits for upload to finish and send button to be enabled)
  await autoSend(composer, PROVIDER);

  // 5. Wait for streaming response completion
  const reply = await waitForResponseCompletion(PROVIDER, baselineCount);

  return {
    success: true,
    provider: PROVIDER,
    reply,
  };
}

function validateAttachments(attachments) {
  if (!attachments || attachments.length === 0) return;

  if (attachments.length > MAX_FILE_COUNT) {
    throw new Error(`Exceeded maximum file attachment limit. Max: ${MAX_FILE_COUNT} files, received: ${attachments.length}`);
  }

  let totalSize = 0;
  for (const file of attachments) {
    const lowerName = (file.name || '').toLowerCase();
    for (const ext of FORBIDDEN_EXTENSIONS) {
      if (lowerName.endsWith(ext)) {
        throw new Error(`File "${file.name}" rejected. 3D, video, and audio files cannot be attached.`);
      }
    }

    if (file.mimeType) {
      const mime = file.mimeType.toLowerCase();
      if (mime.startsWith('audio/') || mime.startsWith('video/') || mime.includes('model/') || mime.includes('gltf')) {
        throw new Error(`File "${file.name}" rejected. 3D, video, and audio files cannot be attached.`);
      }
    }

    totalSize += file.size || 0;
  }

  if (totalSize > MAX_TOTAL_SIZE) {
    const sizeMb = (totalSize / (1024 * 1024)).toFixed(2);
    throw new Error(`Total attachment size (${sizeMb} MB) exceeds maximum allowed limit of 20 MB.`);
  }
}

async function injectAttachments(composer, attachments, provider) {
  console.log(`[Silknet v1.1] Attaching ${attachments.length} file(s) via DataTransfer API...`);

  // Create real DOM File objects from base64 payloads
  const fileObjects = [];
  for (const item of attachments) {
    const byteCharacters = atob(item.base64);
    const byteArrays = [];
    const sliceSize = 512;

    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
      const slice = byteCharacters.slice(offset, offset + sliceSize);
      const byteNumbers = new Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      byteArrays.push(new Uint8Array(byteNumbers));
    }

    const blob = new Blob(byteArrays, { type: item.mimeType || 'application/octet-stream' });
    const file = new File([blob], item.name, { type: item.mimeType || 'application/octet-stream' });
    fileObjects.push(file);
  }

  const dt = new DataTransfer();
  fileObjects.forEach((f) => dt.items.add(f));

  // Strategy A: Find native file inputs on the page
  const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
  let attached = false;

  for (const input of fileInputs) {
    try {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      attached = true;
      console.log('[Silknet v1.1] Successfully injected files into native file input');
      break;
    } catch (e) {
      console.warn('[Silknet v1.1] Native file input injection warning:', e);
    }
  }

  // If native file input succeeded, STOP HERE. Do not fire paste or drop events to prevent duplicates!
  if (attached) {
    console.log('[Silknet v1.1] Native file attachment successful, skipping paste/drop fallbacks.');
    await sleep(1000);
    return;
  }

  // Strategy B: Synthetic paste event directly onto composer (for dropzones without accessible file input)
  try {
    composer.focus();
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    composer.dispatchEvent(pasteEvent);
    console.log('[Silknet v1.1] Dispatched synthetic paste event with DataTransfer items');
    await sleep(1000);
    return;
  } catch (e) {
    console.warn('[Silknet v1.1] Synthetic paste event fallback:', e);
  }

  // Strategy C: Drop event fallback
  try {
    const dropEvent = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    });
    composer.dispatchEvent(dropEvent);
    console.log('[Silknet v1.1] Dispatched drop event fallback');
  } catch (e) {
    console.warn('[Silknet v1.1] Drop event fallback warning:', e);
  }

  await sleep(1000);
}

async function findComposer(provider, maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    let el = null;
    if (provider === 'chatgpt') {
      el = document.querySelector('#prompt-textarea') ||
           document.querySelector('div[contenteditable="true"]') ||
           document.querySelector('textarea');
    } else if (provider === 'claude') {
      el = document.querySelector('div.ProseMirror[contenteditable="true"]') ||
           document.querySelector('div[contenteditable="true"]');
    } else if (provider === 'gemini') {
      el = document.querySelector('div.ql-editor[contenteditable="true"]') ||
           document.querySelector('div[contenteditable="true"]') ||
           document.querySelector('textarea');
    }

    if (el && isVisible(el)) return el;
    await sleep(200);
  }
  return null;
}

async function injectText(el, text, provider) {
  el.focus();
  const view = el.ownerDocument.defaultView || window;

  const isTextArea = el.tagName === 'TEXTAREA';
  const isInput = el.tagName === 'INPUT';

  if (isTextArea || isInput) {
    el.dispatchEvent(
      new view.InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      }),
    );

    const proto = isTextArea ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    const nativeSetter = descriptor?.set;
    if (nativeSetter) {
      nativeSetter.call(el, text);
    } else {
      el.value = text;
    }

    el.dispatchEvent(new view.Event('input', { bubbles: true }));
    el.dispatchEvent(new view.Event('change', { bubbles: true }));
  } else {
    // Rich text / ProseMirror / Quill
    const sel = view.getSelection();
    if (sel) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    let inserted = false;
    if (typeof el.ownerDocument.execCommand === 'function') {
      inserted = el.ownerDocument.execCommand('insertText', false, text);
    }

    if (!inserted) {
      el.textContent = text;
    }

    el.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new view.Event('input', { bubbles: true }));
  }

  await sleep(300);
}

async function waitForSendButtonReady(provider, maxWaitMs = 6000) {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    if (isAborted) throw new Error('Execution aborted by user emergency stop.');

    const btn = findSendButton(provider);
    if (btn && isVisible(btn)) {
      const isDisabled =
        btn.disabled ||
        btn.getAttribute('aria-disabled') === 'true' ||
        btn.hasAttribute('disabled') ||
        btn.classList.contains('disabled');

      if (!isDisabled) {
        return btn;
      }
    }
    await sleep(200);
  }

  return findSendButton(provider);
}

async function autoSend(composerEl, provider) {
  console.log(`[Silknet v1.1] Triggering Auto-Send on ${provider}...`);
  const view = composerEl.ownerDocument.defaultView || window;

  // 1. Wait until send button is enabled (allows file attachments to finish uploading)
  const sendBtn = await waitForSendButtonReady(provider, 6000);

  // 2. Click the send button with complete pointer/mouse sequence
  let clicked = false;
  if (sendBtn) {
    try {
      sendBtn.removeAttribute('disabled');
      sendBtn.disabled = false;
      sendBtn.focus();
      sendBtn.dispatchEvent(new view.PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new view.PointerEvent('pointerup', { bubbles: true, cancelable: true }));
      sendBtn.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      sendBtn.click();
      clicked = true;
      console.log(`[Silknet v1.1] Dispatched click to send button on ${provider}`);
    } catch (e) {
      console.warn(`[Silknet v1.1] Send button click error on ${provider}:`, e);
    }
  }

  await sleep(400);

  // 3. Fallback: If still has text in composer and generation hasn't started, dispatch Enter key
  const stillHasText = (composerEl.value || composerEl.textContent || '').trim().length > 0;
  const stopPresent = isStopButtonPresent(provider);

  if (!stopPresent && (!clicked || stillHasText)) {
    console.log(`[Silknet v1.1] Triggering Enter key fallback on ${provider}...`);
    composerEl.focus();

    const enterOpts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
    };

    composerEl.dispatchEvent(new view.KeyboardEvent('keydown', enterOpts));
    composerEl.dispatchEvent(new view.KeyboardEvent('keypress', enterOpts));
    composerEl.dispatchEvent(new view.KeyboardEvent('keyup', enterOpts));
  }
}

function findSendButton(provider) {
  let selectors = [];
  if (provider === 'chatgpt') {
    selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid="fruitjuice-send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="send" i]',
      '#composer-background button[data-testid="send-button"]',
      '#composer-background button:has(svg)',
      'form button[data-testid="send-button"]',
      'form button:last-of-type'
    ];
  } else if (provider === 'claude') {
    selectors = [
      'button[aria-label*="Send" i]',
      'button[data-testid*="send" i]',
      'button:has(svg)'
    ];
  } else if (provider === 'gemini') {
    selectors = [
      'button[aria-label*="Send" i]',
      'button.send-button',
      'div.send-button',
      'button:has(mat-icon)'
    ];
  }

  for (const s of selectors) {
    try {
      const el = document.querySelector(s);
      if (el && isVisible(el)) return el;
    } catch {}
  }
  return null;
}

function countAssistantTurns(provider) {
  if (provider === 'chatgpt') {
    return document.querySelectorAll('article, [data-message-author-role="assistant"]').length;
  }
  if (provider === 'claude') {
    return document.querySelectorAll(
      'div[data-is-streaming], div.font-claude-message, [data-message-author="assistant"], div[class*="font-claude-message"], [data-testid="message-content"]'
    ).length;
  }
  if (provider === 'gemini') {
    return document.querySelectorAll('model-response, message-content, [data-test-id="model-response"]').length;
  }
  return 0;
}

async function waitForResponseCompletion(provider, baselineCount, maxTimeoutMs = 180000) {
  console.log(`[Silknet v1.1] Waiting for completion on ${provider} (baseline turns: ${baselineCount})...`);
  const start = Date.now();

  // 1. Wait for generation to start
  let started = false;
  while (Date.now() - start < 15000) {
    if (isAborted) {
      throw new Error('Execution aborted by user emergency stop.');
    }
    if (isStopButtonPresent(provider) || countAssistantTurns(provider) > baselineCount) {
      started = true;
      break;
    }
    await sleep(250);
  }

  // 2. Wait for generation to complete (stop button disappears and text is stable)
  let lastText = '';
  let stableTicks = 0;

  while (Date.now() - start < maxTimeoutMs) {
    if (isAborted) {
      throw new Error('Execution aborted by user emergency stop.');
    }
    const stopPresent = isStopButtonPresent(provider);
    const currentReply = extractLatestReply(provider);

    if (stopPresent) {
      stableTicks = 0;
      lastText = currentReply;
    } else {
      if (currentReply.length > 0 && currentReply === lastText) {
        stableTicks++;
        if (stableTicks >= 3) { // 3 consecutive ticks of stability (~1.2s)
          console.log(`[Silknet v1.1] AI generation complete and verified stable on ${provider}.`);
          return currentReply;
        }
      } else {
        lastText = currentReply;
        stableTicks = 0;
      }
    }

    await sleep(400);
  }

  return extractLatestReply(provider);
}

function isStopButtonPresent(provider) {
  let selectors = [];
  if (provider === 'chatgpt') {
    selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label*="Stop" i]'
    ];
  } else if (provider === 'claude') {
    selectors = [
      'button[aria-label="Stop Response"]',
      'button[aria-label*="Stop" i]',
      'button[data-testid="stop-button"]',
      'button[data-testid*="stop"]'
    ];
  } else if (provider === 'gemini') {
    selectors = [
      'button[aria-label*="Stop" i]',
      'button[data-test-id*="stop" i]',
      'button.stop-button'
    ];
  }

  for (const s of selectors) {
    try {
      const el = document.querySelector(s);
      if (el && isVisible(el)) return true;
    } catch {}
  }
  return false;
}

function extractLatestReply(provider) {
  let elements = [];
  if (provider === 'chatgpt') {
    elements = Array.from(document.querySelectorAll('div[data-message-author-role="assistant"], article'));
  } else if (provider === 'claude') {
    elements = Array.from(
      document.querySelectorAll(
        'div.font-claude-message, [data-message-author="assistant"], div[class*="font-claude-message"], [data-testid="message-content"]'
      )
    );
  } else if (provider === 'gemini') {
    elements = Array.from(document.querySelectorAll('model-response, message-content, [data-test-id="model-response"]'));
  }

  if (elements.length === 0) return '';
  const last = elements[elements.length - 1];

  const clone = last.cloneNode(true);
  const buttons = clone.querySelectorAll('button, svg, [role="button"], .copy-button');
  buttons.forEach((b) => b.remove());

  return (clone.textContent || '').trim();
}

function isVisible(el) {
  return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
