"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const master_panel_1 = require("./master-panel");
const SERVER_BASE = 'http://127.0.0.1:4040';
let statusBarItem;
let outputChannel;
let masterPanelProvider;
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('Silknet v1.1');
    // 0. Register Master Webview Panel
    masterPanelProvider = new master_panel_1.MasterPanelProvider(SERVER_BASE);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(master_panel_1.MasterPanelProvider.viewType, masterPanelProvider));
    // 1. Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'tabBridge.checkStatus';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();
    updateStatusBar();
    const timer = setInterval(() => {
        updateStatusBar();
        masterPanelProvider.syncStatus();
    }, 4000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    // 2. Command: Multi-Tab AI Consensus
    const consensusCmd = vscode.commands.registerCommand('tabBridge.consensusAI', async () => {
        const prompt = await vscode.window.showInputBox({
            prompt: '[Silknet Consensus] Query up to 3 Browser AIs simultaneously & synthesize with Local AI',
            placeHolder: 'e.g. Design a fault-tolerant WebSocket reconnection strategy in TypeScript...',
        });
        if (!prompt)
            return;
        await executeConsensusWithProgress(prompt);
    });
    // 3. Command: Ask Single Browser AI
    const askCmd = vscode.commands.registerCommand('tabBridge.askAI', async () => {
        const prompt = await vscode.window.showInputBox({
            prompt: 'Ask your active Browser AI (ChatGPT / Claude / Gemini)',
            placeHolder: 'e.g. Write a TypeScript function to parse URL query strings...',
        });
        if (!prompt)
            return;
        await executeWithProgress(`Asking Browser AI...`, prompt, 'auto');
    });
    // 4. Command: Send Selection to Browser AI
    const selectionCmd = vscode.commands.registerCommand('tabBridge.sendSelection', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active code editor.');
            return;
        }
        const selection = editor.document.getText(editor.selection);
        if (!selection) {
            vscode.window.showWarningMessage('Please select some code first.');
            return;
        }
        const instruction = await vscode.window.showInputBox({
            prompt: 'What would you like the Browser AI to do with this code?',
            value: 'Review this code and optimize or fix any bugs:',
        });
        if (!instruction)
            return;
        const fullPrompt = `${instruction}\n\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``;
        await executeWithProgress(`Processing selected code with Browser AI...`, fullPrompt, 'auto');
    });
    // 5. Command: Check Status
    const statusCmd = vscode.commands.registerCommand('tabBridge.checkStatus', async () => {
        try {
            const status = await fetchStatus();
            if (!status) {
                vscode.window.showErrorMessage('Silknet Server is offline. Please run "npm start" in the server folder.');
                return;
            }
            const tabs = status.connectedTabs || [];
            if (tabs.length === 0) {
                vscode.window.showInformationMessage('Silknet Server is ON, but no browser tabs are connected. Open ChatGPT, Claude, or Gemini in your browser!');
            }
            else {
                const list = tabs.map((t) => `• ${t.provider.toUpperCase()} (${t.title || 'Tab'})`).join('\n');
                vscode.window.showInformationMessage(`🟢 Connected Browser AI Tabs (${tabs.length}):\n${list}`);
            }
        }
        catch (err) {
            vscode.window.showErrorMessage(`Error checking status: ${err.message}`);
        }
    });
    context.subscriptions.push(consensusCmd, askCmd, selectionCmd, statusCmd);
}
function deactivate() { }
async function updateStatusBar() {
    try {
        const status = await fetchStatus();
        if (!status) {
            statusBarItem.text = `$(circle-slash) Silknet: Offline`;
            statusBarItem.tooltip = `Silknet server is not running on ${SERVER_BASE}`;
            return;
        }
        const count = status.connectedTabsCount || 0;
        const providers = status.activeProviders || [];
        if (count === 0) {
            statusBarItem.text = `$(warning) Silknet: No Tabs`;
            statusBarItem.tooltip = `Server running, but no ChatGPT/Claude/Gemini tab detected in browser.`;
        }
        else {
            const names = providers.map((p) => capitalize(p)).join(', ');
            statusBarItem.text = `$(globe) Silknet: ${names}`;
            statusBarItem.tooltip = `Active browser tabs: ${names}. Click to view details.`;
        }
    }
    catch {
        statusBarItem.text = `$(circle-slash) Silknet: Offline`;
    }
}
async function fetchStatus() {
    try {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${SERVER_BASE}/health`, { signal: controller.signal });
        clearTimeout(id);
        if (!res.ok)
            return null;
        return await res.json();
    }
    catch {
        return null;
    }
}
async function executeConsensusWithProgress(prompt) {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Silknet: Gathering Multi-Tab AI Consensus...',
        cancellable: false,
    }, async () => {
        try {
            const res = await fetch(`${SERVER_BASE}/api/consensus`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt }),
            });
            const data = await res.json();
            if (!data.success) {
                vscode.window.showErrorMessage(`Consensus failed: ${data.error}`);
                return;
            }
            outputChannel.clear();
            outputChannel.appendLine(`======================================================`);
            outputChannel.appendLine(`  🧠 SILKNET MULTI-TAB AI CONSENSUS SUMMARY`);
            outputChannel.appendLine(`  Synthesized via: ${data.sourceModel}`);
            outputChannel.appendLine(`======================================================\n`);
            outputChannel.appendLine(data.consensus);
            outputChannel.appendLine(`\n------------------------------------------------------`);
            outputChannel.appendLine(`  INDIVIDUAL BROWSER AI RESPONSES:`);
            outputChannel.appendLine(`------------------------------------------------------\n`);
            for (const [provider, reply] of Object.entries(data.breakdown || {})) {
                outputChannel.appendLine(`🤖 [${provider.toUpperCase()}]`);
                outputChannel.appendLine(String(reply));
                outputChannel.appendLine(`\n`);
            }
            outputChannel.show(true);
            const choice = await vscode.window.showInformationMessage(`Consensus synthesized from ${Object.keys(data.breakdown || {}).length} browser AIs!`, 'Insert Consensus at Cursor', 'Open Output Window');
            if (choice === 'Insert Consensus at Cursor') {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    editor.edit((editBuilder) => {
                        editBuilder.insert(editor.selection.active, data.consensus);
                    });
                }
            }
        }
        catch (err) {
            vscode.window.showErrorMessage(`Consensus error: ${err.message}`);
        }
    });
}
async function executeWithProgress(title, prompt, provider = 'auto') {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
    }, async () => {
        try {
            const res = await fetch(`${SERVER_BASE}/api/prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, provider }),
            });
            const data = await res.json();
            if (!data.success) {
                vscode.window.showErrorMessage(`Browser AI failed: ${data.error || 'Unknown error'}`);
                return;
            }
            outputChannel.clear();
            outputChannel.appendLine(`=== Response from ${data.provider.toUpperCase()} (${(data.durationMs / 1000).toFixed(1)}s) ===\n`);
            outputChannel.appendLine(data.reply);
            outputChannel.show(true);
            const choice = await vscode.window.showInformationMessage(`Received response from ${data.provider.toUpperCase()}!`, 'Insert at Cursor', 'Open Output Window');
            if (choice === 'Insert at Cursor') {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    editor.edit((editBuilder) => {
                        editBuilder.insert(editor.selection.active, data.reply);
                    });
                }
            }
        }
        catch (err) {
            vscode.window.showErrorMessage(`Failed to communicate with Silknet: ${err.message}`);
        }
    });
}
function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
//# sourceMappingURL=extension.js.map