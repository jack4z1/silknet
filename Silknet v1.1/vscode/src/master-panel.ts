import * as vscode from 'vscode';

export class MasterPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'tabBridge.masterView';
  private _view?: vscode.WebviewView;

  constructor(private readonly _serverBase: string) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'CHECK_STATUS': {
          await this.syncStatus();
          break;
        }
        case 'GRAB_SELECTION': {
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            const selection = editor.document.getText(editor.selection);
            const lineCount = selection ? selection.split('\n').length : 0;
            webviewView.webview.postMessage({
              type: 'SET_CODE',
              code: selection,
              lineCount,
              language: editor.document.languageId,
            });
          } else {
            vscode.window.showWarningMessage('No active editor tab found.');
          }
          break;
        }
        case 'RUN_CONSENSUS': {
          await this.handleConsensus(data.payload);
          break;
        }
        case 'CONSULT_ADVISOR': {
          await this.handleConsultAdvisor(data.payload);
          break;
        }
        case 'EMERGENCY_STOP': {
          await this.handleEmergencyStop();
          break;
        }
        case 'TOGGLE_GATE': {
          try {
            await fetch(`${this._serverBase}/api/gate/toggle`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ requireApproval: Boolean(data.requireApproval) }),
            });
            await this.syncStatus();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to update approval gate: ${err.message}`);
          }
          break;
        }
        case 'DECIDE_APPROVAL': {
          try {
            await fetch(`${this._serverBase}/api/approvals/decide`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: data.id, approved: Boolean(data.approved) }),
            });
            await this.syncStatus();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to record approval decision: ${err.message}`);
          }
          break;
        }
        case 'INSERT_CODE': {
          const editor = vscode.window.activeTextEditor;
          if (editor && data.code) {
            editor.edit((editBuilder) => {
              if (editor.selection.isEmpty) {
                editBuilder.insert(editor.selection.active, data.code);
              } else {
                editBuilder.replace(editor.selection, data.code);
              }
            });
            vscode.window.showInformationMessage('Content inserted into active editor!');
          } else {
            vscode.window.showWarningMessage('No active editor to insert content into.');
          }
          break;
        }
      }
    });

    this.syncStatus();
  }

  public async syncStatus() {
    if (!this._view) return;
    try {
      const [resHealth, resApprovals] = await Promise.all([
        fetch(`${this._serverBase}/health`).catch(() => null),
        fetch(`${this._serverBase}/api/approvals`).catch(() => null),
      ]);

      let status = null;
      let approvalsData: any = { requireApproval: true, pendingApprovals: [] };

      if (resHealth && resHealth.ok) {
        status = await resHealth.json();
      }
      if (resApprovals && resApprovals.ok) {
        approvalsData = await resApprovals.json();
      }

      this._view.webview.postMessage({
        type: 'STATUS_UPDATE',
        status,
        approvals: approvalsData,
      });
    } catch {
      this._view.webview.postMessage({ type: 'STATUS_UPDATE', status: null, approvals: null });
    }
  }

  private async handleEmergencyStop() {
    try {
      const res = await fetch(`${this._serverBase}/api/killswitch`, { method: 'POST' });
      const data: any = await res.json();
      vscode.window.showWarningMessage(`🛑 EMERGENCY STOP: ${data.message || 'Halted all browser AI executions.'}`);
      if (this._view) {
        this._view.webview.postMessage({ type: 'CONSENSUS_LOADING', loading: false });
        this._view.webview.postMessage({
          type: 'CONSENSUS_RESULT',
          result: { success: false, error: 'Emergency Killswitch triggered. Browser generation halted.' },
        });
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Killswitch error: ${err.message}`);
    }
  }

  private async handleConsensus(payload: { prompt: string; attachments?: any[] }) {
    if (!this._view) return;

    this._view.webview.postMessage({ type: 'CONSENSUS_LOADING', loading: true });

    try {
      const res = await fetch(`${this._serverBase}/api/consensus`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-bridge-source': 'manual-ui',
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      this._view.webview.postMessage({ type: 'CONSENSUS_LOADING', loading: false });
      this._view.webview.postMessage({ type: 'CONSENSUS_RESULT', result: data });
    } catch (err: any) {
      this._view.webview.postMessage({ type: 'CONSENSUS_LOADING', loading: false });
      this._view.webview.postMessage({
        type: 'CONSENSUS_RESULT',
        result: { success: false, error: `Connection to Silknet server failed: ${err.message}` },
      });
    }
  }

  private async handleConsultAdvisor(payload: any) {
    if (!this._view) return;

    this._view.webview.postMessage({ type: 'CONSENSUS_LOADING', loading: true });

    try {
      const res = await fetch(`${this._serverBase}/api/advisor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-bridge-source': 'manual-ui',
        },
        body: JSON.stringify(payload),
      });

      const data: any = await res.json();
      this._view.webview.postMessage({ type: 'CONSENSUS_LOADING', loading: false });
      this._view.webview.postMessage({
        type: 'CONSENSUS_RESULT',
        result: {
          success: data.success,
          consensus: data.advice,
          sourceModel: `${data.provider?.toUpperCase()} Advisor`,
          breakdown: { [data.provider || 'ai']: data.advice },
          error: data.error,
        },
      });
    } catch (err: any) {
      this._view.webview.postMessage({ type: 'CONSENSUS_LOADING', loading: false });
      this._view.webview.postMessage({
        type: 'CONSENSUS_RESULT',
        result: { success: false, error: err.message },
      });
    }
  }

  private _getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Silknet Master Panel</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --card-bg: var(--vscode-sideBar-background, #252526);
      --border: var(--vscode-panel-border, #333333);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
      --accent-fg: var(--vscode-button-foreground, #ffffff);
      --danger: #e51400;
      --success: #89d185;
      --warning: #cca700;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: var(--vscode-font-family, -apple-system, sans-serif); }
    body { background: var(--bg); color: var(--fg); padding: 12px; font-size: 12px; line-height: 1.4; }

    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 12px;
    }
    .brand-title {
      font-weight: 700;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .version-pill {
      font-size: 9px;
      background: #6366f1;
      color: #fff;
      padding: 1px 5px;
      border-radius: 8px;
    }

    .status-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .status-badge.online { background: rgba(137, 209, 133, 0.2); color: var(--success); }
    .status-badge.offline { background: rgba(229, 20, 0, 0.2); color: var(--danger); }

    .control-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 12px;
    }
    .card-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Prompt & Voice Row */
    .prompt-container {
      position: relative;
      margin-bottom: 8px;
    }
    textarea {
      width: 100%;
      height: 75px;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px;
      padding-right: 36px;
      resize: vertical;
      font-size: 12px;
      outline: none;
    }
    textarea:focus { border-color: var(--accent); }

    .mic-btn {
      position: absolute;
      right: 6px;
      top: 6px;
      background: transparent;
      border: none;
      cursor: pointer;
      color: var(--fg);
      opacity: 0.6;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .mic-btn:hover { opacity: 1; background: rgba(255,255,255,0.1); }
    .mic-btn.recording {
      color: #ef4444;
      opacity: 1;
      animation: pulse 1s infinite alternate;
    }
    @keyframes pulse { from { transform: scale(1); } to { transform: scale(1.15); } }

    /* Attachment Zone */
    .attachment-zone {
      border: 1px dashed var(--border);
      border-radius: 4px;
      padding: 8px;
      text-align: center;
      margin-bottom: 8px;
      cursor: pointer;
      background: rgba(0,0,0,0.1);
      transition: border 0.2s;
    }
    .attachment-zone:hover { border-color: var(--accent); }
    .attachment-hint { font-size: 10px; color: #888; }
    .file-input { display: none; }

    .attachment-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
    }
    .file-chip {
      background: rgba(255,255,255,0.08);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 10px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .file-chip .remove-btn {
      cursor: pointer;
      color: #f87171;
      font-weight: bold;
    }

    /* Buttons */
    .btn-row {
      display: flex;
      gap: 6px;
      margin-bottom: 8px;
    }
    button.btn {
      flex: 1;
      padding: 7px 10px;
      background: var(--accent);
      color: var(--accent-fg);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      transition: background 0.15s;
    }
    button.btn:hover { background: var(--accent-hover); }
    button.btn-secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }
    button.btn-secondary:hover { background: rgba(255,255,255,0.05); }
    button.btn-danger {
      background: var(--danger);
      color: #fff;
    }
    button.btn-danger:hover { background: #b81000; }

    /* Results */
    .result-section {
      margin-top: 10px;
    }
    .consensus-card {
      background: rgba(99, 102, 241, 0.08);
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 10px;
    }
    .consensus-title {
      font-size: 11px;
      font-weight: 700;
      color: #818cf8;
      margin-bottom: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .response-content {
      white-space: pre-wrap;
      font-size: 11px;
      line-height: 1.5;
      max-height: 250px;
      overflow-y: auto;
    }

    /* Individual AI Breakdown */
    .breakdown-item {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px;
      margin-top: 6px;
    }
    .breakdown-header {
      font-weight: 600;
      font-size: 10px;
      color: #94a3b8;
      display: flex;
      justify-content: space-between;
      cursor: pointer;
    }
    .breakdown-body {
      margin-top: 6px;
      font-size: 11px;
      white-space: pre-wrap;
      max-height: 140px;
      overflow-y: auto;
      border-top: 1px solid var(--border);
      padding-top: 6px;
    }

    .loading-spinner {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 12px;
      font-weight: 500;
      color: #818cf8;
    }
  </style>
</head>
<body>
  <div class="header-bar">
    <div class="brand-title">
      <span>🌐 Silknet</span>
      <span class="version-pill">v1.1</span>
    </div>
    <div id="status-badge" class="status-badge offline">Checking...</div>
  </div>

  <!-- Prompt & Multi-Tab Consensus Box -->
  <div class="control-card">
    <div class="card-title">
      <span>AI Consensus & Prompting</span>
      <span id="detected-tabs-lbl" style="font-size: 9px; color: #888;">0 Tabs Active</span>
    </div>

    <div class="prompt-container">
      <textarea id="prompt-input" placeholder="Type your prompt, or click the mic to speak..."></textarea>
      <button type="button" class="mic-btn" id="mic-btn" title="Click to speak (Voice Prompt)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      </button>
    </div>

    <!-- File Attachment Zone (20MB total, max 5 files, no 3D/video/audio) -->
    <div class="attachment-zone" id="dropzone" title="Click to attach files/images (Max 5 files, 20MB total)">
      <span>📎 Click to Attach Files / Images</span>
      <div class="attachment-hint">Max 5 files • 20MB total • 3D/Video/Audio excluded</div>
      <input type="file" id="file-input" class="file-input" multiple accept="image/*,.txt,.md,.json,.ts,.js,.py,.html,.css,.csv,.xml,.pdf,.c,.cpp,.h">
    </div>

    <div class="attachment-chips" id="attachment-chips"></div>

    <div class="btn-row">
      <button type="button" class="btn" id="btn-consensus">
        ⚡ Multi-Tab Consensus
      </button>
      <button type="button" class="btn btn-secondary" id="btn-grab-code" title="Grab active code from editor">
        📄 Grab Code
      </button>
    </div>

    <div class="btn-row">
      <button type="button" class="btn btn-danger" id="btn-emergency-stop">
        🛑 Emergency Stop
      </button>
    </div>
  </div>

  <div id="loading-spinner" class="loading-spinner">
    <span>⏳ Polling browser AI tabs and synthesizing consensus...</span>
  </div>

  <!-- Results Section -->
  <div class="result-section" id="result-section" style="display: none;">
    <!-- Consensus Card -->
    <div class="consensus-card">
      <div class="consensus-title">
        <span id="consensus-model-lbl">🧠 Local AI Consensus</span>
        <div>
          <button type="button" class="btn btn-secondary" id="btn-insert-consensus" style="padding: 2px 6px; font-size: 10px;">Insert</button>
          <button type="button" class="btn btn-secondary" id="btn-copy-consensus" style="padding: 2px 6px; font-size: 10px;">Copy</button>
        </div>
      </div>
      <div class="response-content" id="consensus-text"></div>
    </div>

    <!-- Individual AI Responses Breakdown -->
    <div class="card-title">Individual Browser AI Responses</div>
    <div id="individual-breakdowns"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let attachedFiles = [];
    const MAX_FILES = 5;
    const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
    const FORBIDDEN_EXTS = ['.obj','.gltf','.glb','.stl','.blend','.fbx','.3ds','.mp4','.mov','.avi','.mkv','.webm','.mp3','.wav','.aac','.flac','.ogg','.m4a'];

    const promptInput = document.getElementById('prompt-input');
    const micBtn = document.getElementById('mic-btn');
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    const attachmentChips = document.getElementById('attachment-chips');
    const btnConsensus = document.getElementById('btn-consensus');
    const btnGrabCode = document.getElementById('btn-grab-code');
    const btnEmergencyStop = document.getElementById('btn-emergency-stop');
    const statusBadge = document.getElementById('status-badge');
    const detectedTabsLbl = document.getElementById('detected-tabs-lbl');
    const loadingSpinner = document.getElementById('loading-spinner');
    const resultSection = document.getElementById('result-section');
    const consensusText = document.getElementById('consensus-text');
    const consensusModelLbl = document.getElementById('consensus-model-lbl');
    const individualBreakdowns = document.getElementById('individual-breakdowns');
    const btnInsertConsensus = document.getElementById('btn-insert-consensus');
    const btnCopyConsensus = document.getElementById('btn-copy-consensus');

    // Speech-to-Text (Voice Prompting)
    let recognition = null;
    let isRecording = false;

    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onstart = () => {
        isRecording = true;
        micBtn.classList.add('recording');
      };

      recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        if (transcript) {
          const prev = promptInput.value;
          promptInput.value = prev ? (prev + ' ' + transcript) : transcript;
        }
      };

      recognition.onerror = () => {
        isRecording = false;
        micBtn.classList.remove('recording');
      };

      recognition.onend = () => {
        isRecording = false;
        micBtn.classList.remove('recording');
      };
    }

    micBtn.addEventListener('click', () => {
      if (!recognition) {
        alert('Speech recognition is not supported in this environment.');
        return;
      }
      if (isRecording) {
        recognition.stop();
      } else {
        recognition.start();
      }
    });

    // File Attachments
    dropzone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      for (const file of files) {
        await processFile(file);
      }
      renderChips();
      fileInput.value = '';
    });

    async function processFile(file) {
      if (attachedFiles.length >= MAX_FILES) {
        alert(\`Maximum \${MAX_FILES} files can be attached.\`);
        return;
      }

      const lower = file.name.toLowerCase();
      for (const ext of FORBIDDEN_EXTS) {
        if (lower.endsWith(ext)) {
          alert(\`File "\${file.name}" rejected: 3D, video, and audio files cannot be attached.\`);
          return;
        }
      }

      const currentTotal = attachedFiles.reduce((acc, f) => acc + f.size, 0);
      if (currentTotal + file.size > MAX_SIZE_BYTES) {
        alert(\`Total attachment size exceeds 20 MB limit.\`);
        return;
      }

      const base64 = await toBase64(file);
      attachedFiles.push({
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        base64: base64.split(',')[1] || '',
      });
    }

    function toBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = (error) => reject(error);
      });
    }

    function renderChips() {
      attachmentChips.innerHTML = '';
      attachedFiles.forEach((f, idx) => {
        const chip = document.createElement('div');
        chip.className = 'file-chip';
        const kb = (f.size / 1024).toFixed(1);
        chip.innerHTML = \`<span>\${f.name} (\${kb} KB)</span><span class="remove-btn" data-idx="\${idx}">×</span>\`;
        attachmentChips.appendChild(chip);
      });

      attachmentChips.querySelectorAll('.remove-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const idx = Number(e.target.dataset.idx);
          attachedFiles.splice(idx, 1);
          renderChips();
        });
      });
    }

    // Actions
    btnGrabCode.addEventListener('click', () => {
      vscode.postMessage({ type: 'GRAB_SELECTION' });
    });

    btnConsensus.addEventListener('click', () => {
      const prompt = promptInput.value.trim();
      if (!prompt) {
        alert('Please enter a prompt or question.');
        return;
      }

      vscode.postMessage({
        type: 'RUN_CONSENSUS',
        payload: {
          prompt,
          attachments: attachedFiles,
        },
      });
    });

    btnEmergencyStop.addEventListener('click', () => {
      vscode.postMessage({ type: 'EMERGENCY_STOP' });
    });

    btnInsertConsensus.addEventListener('click', () => {
      vscode.postMessage({ type: 'INSERT_CODE', code: consensusText.textContent });
    });

    btnCopyConsensus.addEventListener('click', () => {
      navigator.clipboard.writeText(consensusText.textContent);
      alert('Consensus copied to clipboard!');
    });

    // Inbound Messages from Extension Host
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'STATUS_UPDATE') {
        updateStatus(msg.status);
      } else if (msg.type === 'SET_CODE') {
        if (msg.code) {
          const current = promptInput.value;
          const snippet = \`\\n\\n\`\`\`\${msg.language || ''}\\n\${msg.code}\\n\`\`\`\`;
          promptInput.value = current ? current + snippet : \`Review and improve this code:\` + snippet;
        }
      } else if (msg.type === 'CONSENSUS_LOADING') {
        loadingSpinner.style.display = msg.loading ? 'flex' : 'none';
        btnConsensus.disabled = msg.loading;
      } else if (msg.type === 'CONSENSUS_RESULT') {
        renderResult(msg.result);
      }
    });

    function updateStatus(status) {
      if (!status) {
        statusBadge.className = 'status-badge offline';
        statusBadge.textContent = 'Server Offline';
        detectedTabsLbl.textContent = '0 Tabs Active';
        return;
      }

      statusBadge.className = 'status-badge online';
      statusBadge.textContent = 'Server Online';

      const active = status.activeProviders || [];
      detectedTabsLbl.textContent = active.length > 0
        ? \`\${active.length} Tab(s): \${active.map(s => s.toUpperCase()).join(', ')}\`
        : '0 Tabs Connected';
    }

    function renderResult(result) {
      resultSection.style.display = 'block';

      if (!result.success) {
        consensusModelLbl.textContent = '⚠️ Consensus Execution Error';
        consensusText.textContent = result.error || 'An unknown error occurred.';
        individualBreakdowns.innerHTML = '';
        return;
      }

      consensusModelLbl.textContent = \`🧠 \${result.sourceModel || 'Local AI Consensus'}\`;
      consensusText.textContent = result.consensus || '';

      // Render individual tabs
      individualBreakdowns.innerHTML = '';
      const breakdown = result.breakdown || {};
      for (const [provider, reply] of Object.entries(breakdown)) {
        const item = document.createElement('div');
        item.className = 'breakdown-item';
        item.innerHTML = \`
          <div class="breakdown-header">
            <span>🤖 \${provider.toUpperCase()} Reply</span>
            <span class="insert-sub-btn" style="cursor: pointer; color: var(--accent);">Insert</span>
          </div>
          <div class="breakdown-body">\${escapeHtml(reply)}</div>
        \`;
        item.querySelector('.insert-sub-btn').addEventListener('click', () => {
          vscode.postMessage({ type: 'INSERT_CODE', code: reply });
        });
        individualBreakdowns.appendChild(item);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }

    // Auto-refresh status
    setInterval(() => {
      vscode.postMessage({ type: 'CHECK_STATUS' });
    }, 4000);
  </script>
</body>
</html>`;
  }
}
