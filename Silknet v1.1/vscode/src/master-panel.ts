import * as vscode from 'vscode';
import * as http from 'http';

function httpGetJson(urlStr: string): Promise<any> {
  return new Promise((resolve) => {
    const req = http.get(urlStr, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2500, () => {
      req.destroy();
      resolve(null);
    });
  });
}

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

    // Handle messages sent from the Webview HTML UI
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'CHECK_STATUS': {
          await this.syncStatus();
          break;
        }
        case 'VOICE_DICTATION_CLICKED': {
          vscode.window.showInformationMessage(
            '🎤 Voice Prompting: Press [Win + H] on your keyboard to speak directly into the prompt box!',
            'Got it'
          );
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
        case 'CONSULT_ADVISOR': {
          await this.handleConsultAdvisor(data.payload);
          break;
        }
        case 'RUN_CONSENSUS': {
          await this.handleConsensus(data.payload);
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
            vscode.window.showInformationMessage('Code inserted into active editor!');
          } else {
            vscode.window.showWarningMessage('No active editor to insert code into.');
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
      const [status, approvalsData] = await Promise.all([
        httpGetJson(`${this._serverBase}/health`),
        httpGetJson(`${this._serverBase}/api/approvals`),
      ]);

      this._view.webview.postMessage({
        type: 'STATUS_UPDATE',
        status,
        approvals: approvalsData || { requireApproval: true, pendingApprovals: [] },
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
        this._view.webview.postMessage({ type: 'ADVISOR_LOADING', loading: false });
        this._view.webview.postMessage({
          type: 'ADVISOR_RESULT',
          result: { success: false, error: 'Emergency Killswitch triggered. Browser generation halted.' },
        });
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`Killswitch error: ${err.message}`);
    }
  }

  private async handleConsensus(payload: { prompt: string; attachments?: any[] }) {
    if (!this._view) return;

    this._view.webview.postMessage({ type: 'ADVISOR_LOADING', loading: true });

    try {
      const res = await fetch(`${this._serverBase}/api/consensus`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tab-bridge-source': 'manual-ui',
        },
        body: JSON.stringify(payload),
      });

      const data: any = await res.json();
      this._view.webview.postMessage({ type: 'CONSENSUS_RESULT', result: data });
    } catch (err: any) {
      this._view.webview.postMessage({
        type: 'CONSENSUS_RESULT',
        result: { success: false, error: `Consensus request failed: ${err.message}` },
      });
    } finally {
      this._view.webview.postMessage({ type: 'ADVISOR_LOADING', loading: false });
    }
  }

  private async handleConsultAdvisor(payload: {
    task: string;
    code?: string;
    error?: string;
    language?: string;
    provider?: string;
    mode?: string;
    guardrails?: string;
    attachments?: any[];
  }) {
    if (!this._view) return;

    this._view.webview.postMessage({ type: 'ADVISOR_LOADING', loading: true });

    try {
      const res = await fetch(`${this._serverBase}/api/advisor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tab-bridge-source': 'manual-ui' },
        body: JSON.stringify({
          task: payload.task,
          code: payload.code,
          error: payload.error,
          language: payload.language || 'typescript',
          provider: payload.provider || 'auto',
          mode: payload.mode || 'direct',
          guardrails: payload.guardrails || '',
          attachments: payload.attachments || [],
        }),
      });

      const data: any = await res.json();
      this._view.webview.postMessage({ type: 'ADVISOR_RESULT', result: data });
    } catch (err: any) {
      this._view.webview.postMessage({
        type: 'ADVISOR_RESULT',
        result: { success: false, error: err.message || String(err) },
      });
    } finally {
      this._view.webview.postMessage({ type: 'ADVISOR_LOADING', loading: false });
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
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 10px;
      margin: 0;
      box-sizing: border-box;
    }
    .header-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    .brand-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      font-size: 13px;
    }
    .version-pill {
      font-size: 9px;
      background: #6366f1;
      color: #fff;
      padding: 1px 5px;
      border-radius: 8px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      border-radius: 12px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      transition: background 0.2s;
    }
    .badge.online { background: #1b5e20; color: #a5d6a7; }
    .badge.offline { background: #b71c1c; color: #ffcdd2; }

    .gate-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 6px 10px;
      margin-bottom: 10px;
      white-space: nowrap;
    }
    .gate-label {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 11px;
      white-space: nowrap;
      margin: 0;
    }

    .row-flex {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .select-dropdown {
      flex: 1;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      padding: 4px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-family: inherit;
      outline: none;
    }

    .approval-box {
      display: none;
      background: #332200;
      border: 1px solid #ffb300;
      border-radius: 6px;
      padding: 8px;
      margin-bottom: 12px;
    }
    .approval-title {
      font-weight: 700;
      font-size: 11px;
      color: #ffd54f;
      display: flex;
      align-items: center;
      gap: 5px;
      margin-bottom: 4px;
    }
    .approval-desc {
      font-size: 11px;
      margin-bottom: 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .approval-actions {
      display: flex;
      gap: 6px;
    }

    .shield-badge {
      font-size: 10px;
      color: #81c784;
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 10px;
      opacity: 0.9;
    }
    .field-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    textarea, input {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 6px;
      box-sizing: border-box;
      font-family: inherit;
      font-size: 12px;
      margin-bottom: 10px;
      resize: vertical;
    }
    textarea:focus, input:focus, select:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }

    /* Voice Prompt Button styling */
    .task-container {
      position: relative;
      margin-bottom: 6px;
    }
    .task-container textarea {
      margin-bottom: 0;
      padding-right: 32px;
    }
    .mic-btn {
      position: absolute;
      right: 6px;
      top: 6px;
      background: transparent;
      border: none;
      cursor: pointer;
      color: var(--vscode-foreground);
      opacity: 0.6;
      padding: 3px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .mic-btn:hover { opacity: 1; background: rgba(255,255,255,0.1); }
    .mic-btn.active {
      color: #ef4444;
      opacity: 1;
      animation: pulse 1s infinite alternate;
    }
    @keyframes pulse { from { transform: scale(1); } to { transform: scale(1.2); } }

    .voice-hint-banner {
      display: none;
      align-items: center;
      gap: 6px;
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.4);
      color: #a5b4fc;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 10px;
      margin-bottom: 8px;
    }

    /* Attachment Dropzone styling */
    .attachment-zone {
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 4px;
      padding: 6px;
      text-align: center;
      margin-bottom: 8px;
      cursor: pointer;
      background: rgba(0,0,0,0.1);
      transition: border 0.2s;
      font-size: 11px;
    }
    .attachment-zone:hover { border-color: var(--vscode-focusBorder); }
    .attachment-hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .file-input { display: none; }

    .attachment-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }
    .file-chip {
      background: rgba(255,255,255,0.08);
      border: 1px solid var(--vscode-panel-border);
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

    .btn {
      width: 100%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-consensus {
      background: #4f46e5 !important;
      color: #ffffff !important;
      margin-bottom: 6px;
    }
    .btn-consensus:hover {
      background: #4338ca !important;
    }
    .btn-stop {
      background: #c62828 !important;
      color: #ffffff !important;
      margin-top: 6px;
    }
    .btn-stop:hover {
      background: #b71c1c !important;
    }
    .btn-approve {
      background: #2e7d32;
      color: #fff;
      padding: 4px 10px;
      font-size: 11px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-deny {
      background: #c62828;
      color: #fff;
      padding: 4px 10px;
      font-size: 11px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-grab {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-panel-border);
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 500;
      border-radius: 4px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s ease;
    }
    .btn-grab:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 4px 8px;
      font-size: 11px;
      width: auto;
      cursor: pointer;
    }

    .result-card {
      margin-top: 15px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 10px;
      background: var(--vscode-editor-background);
    }
    .result-header {
      font-weight: 600;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      white-space: pre-wrap;
    }
    .action-row {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .spinner {
      display: none;
      text-align: center;
      margin: 15px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    /* Consensus Results Styling */
    .consensus-badge-pill {
      font-size: 10px;
      background: rgba(99, 102, 241, 0.2);
      border: 1px solid rgba(99, 102, 241, 0.4);
      color: #818cf8;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: bold;
    }
    .breakdown-item {
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 6px 8px;
      margin-top: 6px;
    }
    .breakdown-header {
      font-weight: 600;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      justify-content: space-between;
    }
    .breakdown-body {
      margin-top: 4px;
      font-size: 11px;
      white-space: pre-wrap;
      max-height: 120px;
      overflow-y: auto;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 4px;
    }
  </style>
</head>
<body>
  <!-- Header with Custom Bridge Logo -->
  <div class="header-bar">
    <div class="brand-title">
      <svg width="18" height="18" viewBox="0 0 100 100" fill="none" style="vertical-align: middle;">
        <path d="M 12 28 L 32 44 L 68 44 L 88 28" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M 12 72 L 32 56 L 68 56 L 88 72" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Silknet</span>
      <span class="version-pill">v1.1</span>
    </div>
    <div id="status-pill" class="badge offline">Server Offline</div>
  </div>

  <!-- Target Model Selector -->
  <div class="row-flex">
    <label for="provider-select" style="font-size: 11px; font-weight: 600; opacity: 0.85; white-space: nowrap;">TARGET AI:</label>
    <select id="provider-select" class="select-dropdown">
      <option value="auto">🤖 Auto (Active Tab)</option>
      <option value="consensus">🧠 Multi-Tab Consensus (Claude + ChatGPT + Gemini)</option>
      <option value="claude">🟣 Claude</option>
      <option value="chatgpt">🟢 ChatGPT</option>
      <option value="gemini">🔵 Gemini</option>
    </select>
  </div>

  <!-- Human Approval Gate -->
  <div class="gate-bar">
    <label class="gate-label" title="When enabled, all automated queries from local AI or scripts must wait for your explicit approval before connecting.">
      <input type="checkbox" id="gate-checkbox" checked>
      <span>🔒 Require My Approval</span>
    </label>
    <span style="opacity: 0.7; font-size: 10px;">Human-in-Loop</span>
  </div>

  <!-- Approval Request Modal Box -->
  <div id="approval-box" class="approval-box">
    <div class="approval-title">
      <span>⚠️ Local AI Requesting Permission</span>
    </div>
    <div id="approval-desc" class="approval-desc">Local AI is requesting browser guidance...</div>
    <div class="approval-actions">
      <button type="button" id="approve-btn" class="btn-approve">✅ Approve & Send</button>
      <button type="button" id="deny-btn" class="btn-deny">❌ Deny</button>
    </div>
  </div>

  <div class="shield-badge">
    <span>🛡️ Privacy Shield Active (Secrets & Local Paths Scrubbed)</span>
  </div>

  <!-- Prompt Mode & Guardrails Setup -->
  <div class="row-flex">
    <label for="mode-select" style="font-size: 11px; font-weight: 600; opacity: 0.85; white-space: nowrap;">MODE:</label>
    <select id="mode-select" class="select-dropdown">
      <option value="direct">🎯 Direct / Clean (Natural Query)</option>
      <option value="code_only">⚡ Code Only (No Explanations / Yap)</option>
      <option value="debug">🛠️ Debug & Architect (Full Diagnosis)</option>
      <option value="custom">🎨 Custom Template & Guardrails</option>
    </select>
  </div>

  <!-- Custom Guardrails Box (Collapsible) -->
  <div id="guardrails-container" style="display: none; margin-bottom: 6px;">
    <div class="field-label" style="font-size: 10px;">
      <span>CUSTOM GUARDRAILS / INSTRUCTIONS:</span>
    </div>
    <textarea id="guardrails-input" rows="2" placeholder="e.g. Do not yap. Keep it under 2 sentences. Use Python 3.12 syntax..."></textarea>
  </div>

  <div>
    <!-- 1. What needs solving + Voice Button -->
    <div class="field-label">
      <span>1. What needs solving / guidance?</span>
      <span style="font-size: 9px; opacity: 0.8; color: #a5b4fc;">Press Win + H to speak</span>
    </div>
    <div class="task-container">
      <textarea id="task-input" rows="3" placeholder="e.g. ask a coding question... (or click 🎤 to speak)"></textarea>
      <button type="button" class="mic-btn" id="mic-btn" title="Click to speak (Press Win + H anytime)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      </button>
    </div>

    <!-- Voice Banner Tip -->
    <div id="voice-banner" class="voice-hint-banner">
      <span>🎙️ Voice Prompting Ready: Press <strong>Windows Key + H</strong> to speak!</span>
    </div>

    <!-- 1.1 Native File / Image Attachment Dropzone (Max 5 files, 20MB, No 3D/Video/Audio) -->
    <div class="attachment-zone" id="dropzone" title="Click to attach files/images (Max 5 files, 20MB total)">
      <span>📎 Click to Attach Files / Images</span>
      <div class="attachment-hint">Max 5 files • 20MB total • 3D/Video/Audio excluded</div>
      <input type="file" id="file-input" class="file-input" multiple accept="image/*,.txt,.md,.json,.ts,.js,.py,.html,.css,.csv,.xml,.pdf,.c,.cpp,.h">
    </div>
    <div class="attachment-chips" id="attachment-chips"></div>

    <!-- 2. Code Context -->
    <div class="field-label">
      <span>2. Code Context (Optional)</span>
      <button type="button" id="grab-btn" class="btn-grab" title="Grab currently highlighted code in active editor">
        <span>📋 Grab Editor Selection</span>
      </button>
    </div>
    <textarea id="code-input" rows="3" placeholder="Paste code or click 'Grab Editor Selection'..."></textarea>

    <!-- 3. Error Context -->
    <div class="field-label">
      <span>3. Error / Obstacle (Optional)</span>
    </div>
    <textarea id="error-input" rows="2" placeholder="Paste error stack trace or compiler message..."></textarea>

    <!-- Execution Buttons -->
    <button type="button" id="submit-btn" class="btn">
      <span>🚀 Ask Frontier Browser AI</span>
    </button>

    <button type="button" id="btn-consensus-quick" class="btn btn-consensus" style="margin-top: 6px;">
      <span>🧠 Multi-Tab AI Consensus</span>
    </button>

    <button type="button" id="stop-btn" class="btn btn-stop">
      <span>🛑 Emergency Stop / Killswitch</span>
    </button>
  </div>

  <div id="spinner" class="spinner">
    ⏳ Sending to Browser AI & waiting for response...
  </div>

  <!-- Result Container -->
  <div id="result-box" style="display: none;"></div>

  <script>
    const vscode = acquireVsCodeApi();

    const taskInput = document.getElementById('task-input');
    const micBtn = document.getElementById('mic-btn');
    const voiceBanner = document.getElementById('voice-banner');
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('file-input');
    const attachmentChips = document.getElementById('attachment-chips');
    const codeInput = document.getElementById('code-input');
    const errorInput = document.getElementById('error-input');
    const submitBtn = document.getElementById('submit-btn');
    const btnConsensusQuick = document.getElementById('btn-consensus-quick');
    const stopBtn = document.getElementById('stop-btn');
    const grabBtn = document.getElementById('grab-btn');
    const statusPill = document.getElementById('status-pill');
    const spinner = document.getElementById('spinner');
    const resultBox = document.getElementById('result-box');
    const gateCheckbox = document.getElementById('gate-checkbox');
    const providerSelect = document.getElementById('provider-select');
    const modeSelect = document.getElementById('mode-select');
    const guardrailsContainer = document.getElementById('guardrails-container');
    const guardrailsInput = document.getElementById('guardrails-input');

    const approvalBox = document.getElementById('approval-box');
    const approvalDesc = document.getElementById('approval-desc');
    const approveBtn = document.getElementById('approve-btn');
    const denyBtn = document.getElementById('deny-btn');

    let currentLanguage = 'typescript';
    let currentApprovalId = null;

    // Attachments State
    let attachedFiles = [];
    const MAX_FILES = 5;
    const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
    const FORBIDDEN_EXTS = ['.obj','.gltf','.glb','.stl','.blend','.fbx','.3ds','.mp4','.mov','.avi','.mkv','.webm','.mp3','.wav','.aac','.flac','.ogg','.m4a'];

    // Microphone / Voice Prompting
    micBtn.addEventListener('click', () => {
      taskInput.focus();
      micBtn.classList.toggle('active');
      voiceBanner.style.display = micBtn.classList.contains('active') ? 'flex' : 'none';
      vscode.postMessage({ type: 'VOICE_DICTATION_CLICKED' });
    });

    // File Attachments Handling
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
        alert('Maximum ' + MAX_FILES + ' files can be attached.');
        return;
      }

      const lower = file.name.toLowerCase();
      for (const ext of FORBIDDEN_EXTS) {
        if (lower.endsWith(ext)) {
          alert('File "' + file.name + '" rejected: 3D, video, and audio files cannot be attached.');
          return;
        }
      }

      const currentTotal = attachedFiles.reduce((acc, f) => acc + f.size, 0);
      if (currentTotal + file.size > MAX_SIZE_BYTES) {
        alert('Total attachment size exceeds 20 MB limit.');
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
        chip.innerHTML = '<span>' + escapeHtml(f.name) + ' (' + kb + ' KB)</span><span class="remove-btn" data-idx="' + idx + '">×</span>';
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

    // Load saved preferences
    try {
      const savedMode = localStorage.getItem('tab_bridge_mode');
      if (savedMode) modeSelect.value = savedMode;
      const savedGuardrails = localStorage.getItem('tab_bridge_guardrails');
      if (savedGuardrails) guardrailsInput.value = savedGuardrails;
      const savedProvider = localStorage.getItem('tab_bridge_provider');
      if (savedProvider) providerSelect.value = savedProvider;
      updateGuardrailsVisibility();
    } catch {}

    modeSelect.addEventListener('change', () => {
      updateGuardrailsVisibility();
      try { localStorage.setItem('tab_bridge_mode', modeSelect.value); } catch {}
    });

    guardrailsInput.addEventListener('input', () => {
      try { localStorage.setItem('tab_bridge_guardrails', guardrailsInput.value); } catch {}
    });

    providerSelect.addEventListener('change', () => {
      try { localStorage.setItem('tab_bridge_provider', providerSelect.value); } catch {}
      if (providerSelect.value === 'consensus') {
        submitBtn.innerHTML = '<span>🧠 Run Multi-Tab Consensus</span>';
      } else {
        submitBtn.innerHTML = '<span>🚀 Ask Frontier Browser AI</span>';
      }
    });

    function updateGuardrailsVisibility() {
      guardrailsContainer.style.display = (modeSelect.value === 'custom') ? 'block' : 'none';
    }

    grabBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'GRAB_SELECTION' });
    });

    submitBtn.addEventListener('click', () => {
      executeSubmission();
    });

    btnConsensusQuick.addEventListener('click', () => {
      providerSelect.value = 'consensus';
      executeSubmission();
    });

    function executeSubmission() {
      const task = taskInput.value.trim();
      if (!task) {
        alert('Please enter a question or problem description.');
        return;
      }

      if (providerSelect.value === 'consensus') {
        let fullPrompt = task;
        if (codeInput.value.trim()) {
          fullPrompt += '\\n\\nCODE CONTEXT:\\n\`\`\`' + currentLanguage + '\\n' + codeInput.value.trim() + '\\n\`\`\`';
        }
        if (errorInput.value.trim()) {
          fullPrompt += '\\n\\nERROR / OBSTACLE:\\n\`\`\`\\n' + errorInput.value.trim() + '\\n\`\`\`';
        }

        vscode.postMessage({
          type: 'RUN_CONSENSUS',
          payload: {
            prompt: fullPrompt,
            attachments: attachedFiles,
          }
        });
      } else {
        vscode.postMessage({
          type: 'CONSULT_ADVISOR',
          payload: {
            task,
            code: codeInput.value.trim(),
            error: errorInput.value.trim(),
            language: currentLanguage,
            provider: providerSelect.value,
            mode: modeSelect.value,
            guardrails: guardrailsInput.value.trim(),
            attachments: attachedFiles,
          }
        });
      }
    }

    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'EMERGENCY_STOP' });
    });

    gateCheckbox.addEventListener('change', () => {
      vscode.postMessage({
        type: 'TOGGLE_GATE',
        requireApproval: gateCheckbox.checked
      });
    });

    approveBtn.addEventListener('click', () => {
      if (currentApprovalId) {
        vscode.postMessage({ type: 'DECIDE_APPROVAL', id: currentApprovalId, approved: true });
        approvalBox.style.display = 'none';
        currentApprovalId = null;
      }
    });

    denyBtn.addEventListener('click', () => {
      if (currentApprovalId) {
        vscode.postMessage({ type: 'DECIDE_APPROVAL', id: currentApprovalId, approved: false });
        approvalBox.style.display = 'none';
        currentApprovalId = null;
      }
    });

    // Inbound Messages from VS Code Host
    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'STATUS_UPDATE') {
        updateStatus(msg.status, msg.approvals);
      } else if (msg.type === 'SET_CODE') {
        codeInput.value = msg.code || '';
        if (msg.language) currentLanguage = msg.language;
      } else if (msg.type === 'ADVISOR_LOADING') {
        spinner.style.display = msg.loading ? 'block' : 'none';
        submitBtn.disabled = msg.loading;
        btnConsensusQuick.disabled = msg.loading;
      } else if (msg.type === 'ADVISOR_RESULT') {
        renderAdvisorResult(msg.result);
      } else if (msg.type === 'CONSENSUS_RESULT') {
        renderConsensusResult(msg.result);
      }
    });

    function updateStatus(status, approvals) {
      if (!status) {
        statusPill.className = 'badge offline';
        statusPill.textContent = 'Server Offline';
        return;
      }

      const count = status.connectedTabsCount || 0;
      const providers = status.activeProviders || [];

      if (count === 0) {
        statusPill.className = 'badge offline';
        statusPill.textContent = 'No AI Tabs Detected';
      } else {
        statusPill.className = 'badge online';
        statusPill.textContent = '🟢 ' + providers.map(p => p.toUpperCase()).join(', ');
      }

      if (approvals) {
        gateCheckbox.checked = Boolean(approvals.requireApproval);
        const pending = approvals.pendingApprovals || [];
        if (pending.length > 0) {
          const first = pending[0];
          currentApprovalId = first.id;
          approvalDesc.textContent = '[' + first.provider.toUpperCase() + '] ' + first.caller + ': ' + first.task;
          approvalBox.style.display = 'block';
        } else {
          approvalBox.style.display = 'none';
          currentApprovalId = null;
        }
      }
    }

    // Direct client-side fetch from the server
    async function pollStatusDirect() {
      try {
        const res = await fetch('http://127.0.0.1:4040/health');
        if (res.ok) {
          const data = await res.json();
          updateStatus(data, null);
          return;
        }
      } catch (e) {
        // Fallback
      }
      vscode.postMessage({ type: 'CHECK_STATUS' });
    }

    // Initial check & interval
    pollStatusDirect();
    setInterval(pollStatusDirect, 2500);

    function renderAdvisorResult(result) {
      resultBox.style.display = 'block';

      if (!result.success) {
        resultBox.innerHTML = '<div class="result-card" style="border-color: #c62828;"><div class="result-header" style="color: #ef5350;"><span>❌ Execution Error</span></div><pre>' + escapeHtml(result.error || 'Unknown error') + '</pre></div>';
        return;
      }

      const durationSec = (result.durationMs / 1000).toFixed(1);
      const codeBlocks = result.extractedCodeBlocks || [];

      let codeBlocksHtml = '';
      if (codeBlocks.length > 0) {
        codeBlocksHtml = '<div style="margin-top: 10px; font-weight: 600; font-size: 11px;"><span>EXTRACTED PRODUCTION CODE:</span></div>';
        codeBlocks.forEach((code, i) => {
          codeBlocksHtml += '<div style="margin-top: 6px;"><pre id="code-block-' + i + '">' + escapeHtml(code) + '</pre><div class="action-row"><button type="button" class="btn btn-secondary insert-code-btn" data-idx="' + i + '">Insert into Editor</button><button type="button" class="btn btn-secondary copy-code-btn" data-idx="' + i + '">Copy</button></div></div>';
        });
      }

      resultBox.innerHTML = '<div class="result-card"><div class="result-header"><span>💡 ' + (result.provider || '').toUpperCase() + ' ADVICE (' + durationSec + 's)</span></div><pre>' + escapeHtml(result.advice) + '</pre>' + codeBlocksHtml + '</div>';

      resultBox.querySelectorAll('.insert-code-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const idx = Number(e.target.dataset.idx);
          vscode.postMessage({ type: 'INSERT_CODE', code: codeBlocks[idx] });
        });
      });

      resultBox.querySelectorAll('.copy-code-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const idx = Number(e.target.dataset.idx);
          navigator.clipboard.writeText(codeBlocks[idx]);
          alert('Code block copied to clipboard!');
        });
      });
    }

    function renderConsensusResult(result) {
      resultBox.style.display = 'block';

      if (!result.success) {
        resultBox.innerHTML = '<div class="result-card" style="border-color: #c62828;"><div class="result-header" style="color: #ef5350;"><span>❌ Multi-Tab Consensus Error</span></div><pre>' + escapeHtml(result.error || 'Failed to synthesize consensus') + '</pre></div>';
        return;
      }

      let breakdownHtml = '';
      const breakdown = result.breakdown || {};
      for (const [provider, text] of Object.entries(breakdown)) {
        breakdownHtml += '<div class="breakdown-item"><div class="breakdown-header"><span>🤖 ' + provider.toUpperCase() + ' Reply</span><span class="insert-sub-btn" data-reply="' + escapeHtml(text) + '" style="cursor: pointer; color: var(--vscode-button-background);">Insert</span></div><div class="breakdown-body">' + escapeHtml(text) + '</div></div>';
      }

      resultBox.innerHTML = '<div class="result-card" style="border-color: rgba(99, 102, 241, 0.4); background: rgba(99, 102, 241, 0.05);"><div class="result-header"><span class="consensus-badge-pill">🧠 ' + escapeHtml(result.sourceModel || 'Local AI Consensus') + '</span><div class="action-row" style="margin-top: 0;"><button type="button" class="btn btn-secondary" id="insert-consensus-btn">Insert</button><button type="button" class="btn btn-secondary" id="copy-consensus-btn">Copy</button></div></div><pre id="consensus-main-text">' + escapeHtml(result.consensus) + '</pre><div style="margin-top: 10px; font-weight: 600; font-size: 10px; text-transform: uppercase; color: var(--vscode-descriptionForeground);">Individual Model Responses:</div>' + breakdownHtml + '</div>';

      document.getElementById('insert-consensus-btn')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'INSERT_CODE', code: result.consensus });
      });

      document.getElementById('copy-consensus-btn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(result.consensus);
        alert('Consensus copied to clipboard!');
      });

      resultBox.querySelectorAll('.insert-sub-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          vscode.postMessage({ type: 'INSERT_CODE', code: e.target.dataset.reply });
        });
      });
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text || '';
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }
}
