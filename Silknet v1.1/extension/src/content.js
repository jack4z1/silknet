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
    const requestId = message.id; // Track the request ID from the server

    // Acknowledge receipt immediately to avoid Chrome MV3 30-second channel timeout
    sendResponse({ status: 'started' });

    handleExecutePrompt(message.prompt, message.attachments || [])
      .then((result) => {
        const payload = {
          type: 'PROMPT_RESULT_FROM_CONTENT',
          id: requestId,
          provider: result.provider || PROVIDER,
          success: result.success,
          reply: result.reply || '',
        };

        // Deliver result independently to background worker
        chrome.runtime.sendMessage(payload).catch((err) => {
          console.warn('[Silknet v1.1] Failed to send prompt result to background:', err);
        });
      })
      .catch((err) => {
        const errorPayload = {
          type: 'PROMPT_RESULT_FROM_CONTENT',
          id: requestId,
          provider: PROVIDER,
          success: false,
          reply: '',
          error: err instanceof Error ? err.message : String(err),
        };

        chrome.runtime.sendMessage(errorPayload).catch(() => {});
      });

    return false; // Return false so port closes cleanly right away
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
  await autoSend(composer, PROVIDER, Boolean(attachments && attachments.length > 0));

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
    try {
      el.dispatchEvent(
        new view.InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        }),
      );
    } catch {}

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
    // Rich text / ProseMirror / Lexical / Quill (ChatGPT div, Claude, Gemini)
    // Dispatch beforeinput first so rich-text state handlers (ProseMirror/Lexical) receive it
    try {
      el.dispatchEvent(
        new view.InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        }),
      );
    } catch {}

    const sel = view.getSelection();
    if (sel) {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    let inserted = false;
    if (typeof el.ownerDocument.execCommand === 'function') {
      try {
        inserted = el.ownerDocument.execCommand('insertText', false, text);
      } catch {}
    }

    if (!inserted) {
      const p = el.querySelector('p');
      if (p) {
        p.textContent = text;
      } else {
        el.textContent = text;
      }
    }

    try {
      el.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } catch {}
    el.dispatchEvent(new view.Event('input', { bubbles: true }));
    el.dispatchEvent(new view.Event('change', { bubbles: true }));
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
    await sleep(250);
  }

  return findSendButton(provider);
}

async function autoSend(composerEl, provider, hasAttachments = false) {
  console.log(`[Silknet v1.1] Triggering Auto-Send on ${provider} (hasAttachments: ${hasAttachments})...`);
  const view = composerEl.ownerDocument.defaultView || window;

  // 1. Wait until send button is enabled (allows file attachments to finish uploading)
  // When files are attached, allow up to 25 seconds for upload to finish; otherwise 6 seconds
  const maxWaitMs = hasAttachments ? 25000 : 6000;
  const sendBtn = await waitForSendButtonReady(provider, maxWaitMs);

  // 2. Click send button and verify generation starts (retry up to 4 times)
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (isAborted) throw new Error('Execution aborted by user emergency stop.');

    // If generation already started, we're done
    if (isStopButtonPresent(provider)) {
      console.log(`[Silknet v1.1] Generation confirmed started on ${provider}`);
      return;
    }

    const currentBtn = findSendButton(provider) || sendBtn;
    if (currentBtn) {
      try {
        currentBtn.removeAttribute('disabled');
        currentBtn.disabled = false;
        currentBtn.focus();
        currentBtn.dispatchEvent(new view.PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        currentBtn.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        currentBtn.dispatchEvent(new view.PointerEvent('pointerup', { bubbles: true, cancelable: true }));
        currentBtn.dispatchEvent(new view.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        currentBtn.click();
        console.log(`[Silknet v1.1] Dispatched click to send button on ${provider} (attempt ${attempt})`);
      } catch (e) {
        console.warn(`[Silknet v1.1] Send button click error on ${provider}:`, e);
      }
    }

    await sleep(500);

    if (isStopButtonPresent(provider)) {
      console.log(`[Silknet v1.1] Generation confirmed started on ${provider}`);
      return;
    }

    // 3. Fallback: Dispatch Enter key on composer
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

    await sleep(600);

    if (isStopButtonPresent(provider)) {
      console.log(`[Silknet v1.1] Generation confirmed started via Enter key on ${provider}`);
      return;
    }
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
    return document.querySelectorAll('[data-message-author-role="assistant"], article .markdown, div.agent-turn').length;
  }
  if (provider === 'claude') {
    return document.querySelectorAll(
      '.standard-markdown, div.font-claude-message, div[class*="font-claude"], div.font-claude-response, [data-message-author="assistant"], [data-testid="message-content"], div.grid-cols-1, div.prose'
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
      console.log(`[Silknet v1.1] Generation confirmed started on ${provider}`);
      break;
    }
    await sleep(250);
  }

  // 2. Wait for generation to complete (stop button disappears, send button returns, or text stabilizes)
  let lastText = '';
  let stableTicks = 0;

  while (Date.now() - start < maxTimeoutMs) {
    if (isAborted) {
      throw new Error('Execution aborted by user emergency stop.');
    }

    const stopPresent = isStopButtonPresent(provider);
    const sendBtn = findSendButton(provider);
    const sendBtnReady = sendBtn && isVisible(sendBtn);
    const currentReply = extractLatestReply(provider);

    // If the Send button has reappeared in the composer, streaming has ended
    const isStreaming = stopPresent && !sendBtnReady;

    if (currentReply.length > 0) {
      if (currentReply === lastText) {
        stableTicks++;
      } else {
        lastText = currentReply;
        stableTicks = 0;
      }
    }

    if (isStreaming) {
      started = true;
      // While streaming, text is arriving. If text has NOT changed for 8 consecutive ticks (~3.2s),
      // it means streaming has finished even if the stop button was not cleanly unmounted
      if (currentReply.length > 0 && stableTicks >= 8) {
        console.log(`[Silknet v1.1] AI generation complete on ${provider} (stream stabilized, ${currentReply.length} chars).`);
        return currentReply;
      }
    } else {
      // Not streaming: stop button is absent OR send button has returned
      if (currentReply.length > 0) {
        if (stableTicks >= 2) { // 2 consecutive ticks (~800ms) of stable text after streaming finishes
          console.log(`[Silknet v1.1] AI generation complete and verified stable on ${provider} (${currentReply.length} chars).`);
          return currentReply;
        }
      } else if (started) {
        const fallbackText = extractBroadFallback(provider);
        if (fallbackText.length > 0) {
          console.log(`[Silknet v1.1] AI generation captured via broad fallback on ${provider} (${fallbackText.length} chars).`);
          return fallbackText;
        }
      }
    }

    await sleep(400);
  }

  console.warn(`[Silknet v1.1] Max timeout reached on ${provider}, returning best available response.`);
  return extractLatestReply(provider) || extractBroadFallback(provider);
}

function isStopButtonPresent(provider) {
  if (provider === 'chatgpt') {
    // If the Send button has returned, ChatGPT is definitely not generating
    const sendBtn = document.querySelector('button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"], button[data-testid="composer-send-button"]');
    if (sendBtn && isVisible(sendBtn)) {
      return false;
    }
    const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]');
    if (stopBtn && isVisible(stopBtn)) {
      return true;
    }
    return false;
  }

  if (provider === 'claude') {
    const sendBtn = document.querySelector('button[aria-label*="Send" i], button[data-testid*="send" i]');
    if (sendBtn && isVisible(sendBtn)) {
      const isStreaming = Boolean(document.querySelector('[data-is-streaming="true"], [data-is-streaming="1"]'));
      if (!isStreaming) return false;
    }
    if (document.querySelector('[data-is-streaming="true"], [data-is-streaming="1"]')) {
      return true;
    }
    const stopBtn = document.querySelector('button[aria-label="Stop Response"], button[data-testid="stop-button"]');
    if (stopBtn && isVisible(stopBtn)) return true;
    return false;
  }

  if (provider === 'gemini') {
    const sendBtn = document.querySelector('button[aria-label*="Send" i], button.send-button');
    if (sendBtn && isVisible(sendBtn)) {
      return false;
    }
    const stopBtn = document.querySelector('button[aria-label*="Stop" i], button.stop-button, button[data-test-id*="stop" i]');
    if (stopBtn && isVisible(stopBtn)) return true;
    return false;
  }

  return false;
}

function extractLatestReply(provider) {
  let elements = [];
  if (provider === 'chatgpt') {
    // Primary: assistant markdown container (cleanest, direct reply text)
    elements = Array.from(document.querySelectorAll('[data-message-author-role="assistant"] .markdown, article .markdown, div.agent-turn .markdown, div.markdown'));
    if (elements.length === 0) {
      elements = Array.from(document.querySelectorAll('div[data-message-author-role="assistant"], div.agent-turn'));
    }
    if (elements.length === 0) {
      elements = Array.from(document.querySelectorAll('article'));
    }
  } else if (provider === 'claude') {
    // In modern Claude, .standard-markdown directly contains the clean response text
    elements = Array.from(document.querySelectorAll('.standard-markdown'));
    if (elements.length === 0) {
      elements = Array.from(
        document.querySelectorAll(
          'div.font-claude-message, div[class*="font-claude"], div.font-claude-response, [data-message-author="assistant"], [data-testid="message-content"], div.grid-cols-1, div.prose'
        )
      );
    }
  } else if (provider === 'gemini') {
    elements = Array.from(document.querySelectorAll('model-response, message-content, [data-test-id="model-response"]'));
  }

  if (elements.length === 0) return '';
  const last = elements[elements.length - 1];

  const clone = last.cloneNode(true);
  const buttons = clone.querySelectorAll('.copy-button, button, svg');
  buttons.forEach((b) => b.remove());

  return (clone.textContent || '').trim();
}

function extractBroadFallback(provider) {
  try {
    if (provider === 'claude') {
      const msgs = document.querySelectorAll('main div.prose, main .standard-markdown, div[class*="conversation"] p');
      if (msgs.length > 0) {
        return (msgs[msgs.length - 1].textContent || '').trim();
      }
    } else if (provider === 'chatgpt') {
      const msgs = document.querySelectorAll('main .markdown, main div[data-message-author-role="assistant"], main p');
      if (msgs.length > 0) {
        return (msgs[msgs.length - 1].textContent || '').trim();
      }
    } else if (provider === 'gemini') {
      const msgs = document.querySelectorAll('main model-response, main message-content, main .response-container');
      if (msgs.length > 0) {
        return (msgs[msgs.length - 1].textContent || '').trim();
      }
    }
  } catch {}
  return '';
}

function isVisible(el) {
  return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
