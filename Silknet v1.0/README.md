# 🌉 Silknet — Connect Browser AI to Local AI

**Silknet** bridges your local IDE (VS Code, Cursor) and terminal AI tools directly to your active browser AI tabs (**ChatGPT**, **Claude**, and **Gemini**).

It turns your browser tabs into a **zero-cost, secure, privacy-first AI copilot**:
1. You (or your IDE's local AI) issue a prompt.
2. Silknet **auto-injects** the prompt into the browser tab.
3. Silknet **auto-sends** it programmatically.
4. Silknet **auto-waits** for streaming generation to finish.
5. Silknet **auto-reads** the pristine reply and delivers it straight to your IDE or terminal.

---

## 🛡️ Built-in Security & Safety Guards

1. **Human-in-the-Loop Permission Barrier:** Every automated request from local AI or terminal scripts is held in a secure gate until you explicitly click **Approve** in the VS Code panel. No rogue background calls can ever occur.
2. **Emergency Stop / Killswitch:** One-click killswitch immediately clicks the browser's native stop generation button and severs in-flight timers.
3. **Privacy & Redaction Shield:** Automatically strips local usernames, absolute Windows/Unix paths (`C:\Users\...`), IP addresses, and sensitive tokens/API keys (`sk-...`, `ghp_...`, AWS keys) before anything is transmitted to the browser AI.
4. **Localhost-Only:** All WebSocket and HTTP communication runs strictly over `127.0.0.1`. No data is ever sent to third-party telemetry servers.

---

## 🚀 Quick Setup (2 Steps)

### Step 1: Start the Local Bridge Server
Open a terminal in the `server` directory and run:
```bash
npm install
npm start
```
You will see:
```text
====================================================
🚀 Tab Bridge Server is running!
📡 Local HTTP & WebSocket: http://127.0.0.1:4040
🤖 OpenAI API Base URL:    http://127.0.0.1:4040/v1
📊 Status Endpoint:        http://127.0.0.1:4040/health
====================================================
```
*(On Windows, you can simply double-click `start-bridge.bat`)*

### Step 2: Load the Extension in Chrome
1. Open Google Chrome and navigate to `chrome://extensions`.
2. Turn ON **Developer mode** (top right switch).
3. Click **Load unpacked** (top left).
4. Select the `extension` folder.
5. Open any tab in Chrome to **ChatGPT**, **Claude**, or **Gemini**.
6. The extension will automatically connect to your local server in the background.

---

## 💡 How to Use It

### Method 1: In VS Code / Cursor
Install the pre-built `.vsix` extension located in `release/silknet-vscode-v1.0.0.vsix` or `vscode/silknet-1.0.0.vsix`:
* Open the **Silknet Master Panel** in the activity bar.
* **Target AI Selector:** Choose `Auto (Active Tab)`, `Claude`, `ChatGPT`, or `Gemini`.
* **Prompt Modes:** Choose `Direct / Clean`, `Code Only (No Explanations)`, `Debug & Architect`, or `Custom Template & Guardrails`.
* **Editor Integration:** Click **"Grab Editor Selection"** to automatically pull highlighted code, or **"Insert into Editor"** to paste returned code solutions.
* **Keyboard Shortcuts:**
  * `Ctrl+Alt+A`: **Ask Browser AI**
  * `Ctrl+Alt+S`: **Send Selected Code**

### Method 2: OpenAI-Compatible API Mode
Any local AI tool that supports custom OpenAI endpoints (such as **Ollama**, **Continue.dev**, **Cursor**, **Cline**, or custom Python scripts) can use your browser AI tabs as an LLM provider:
* **API Base URL:** `http://127.0.0.1:4040/v1`
* **API Key:** `dummy` (any string)
* **Model:**
  * `browser-auto`: Automatically routes to whatever tab is currently focused.
  * `browser-chatgpt`: Explicitly routes to ChatGPT.
  * `browser-claude`: Explicitly routes to Claude.
  * `browser-gemini`: Explicitly routes to Gemini.

### Method 3: Instant CLI Test
To test the entire pipeline:
```bash
node test-client.mjs
```
*(Or double-click `test-bridge.bat` on Windows)*

---

## 📦 Project Structure

```text
silknet/
├── extension/          # Chrome / Chromium Browser Extension
│   ├── manifest.json   # Manifest V3 configuration
│   ├── icons/          # Multi-resolution PNG & SVG icons
│   └── src/            # Service worker & DOM content automation
├── server/             # Local Node.js Bridge Server
│   └── src/            # TabManager, PrivacyShield, AdvisorEngine
├── vscode/             # VS Code / Cursor IDE Extension
│   └── src/            # Master Webview Panel & Editor commands
├── release/            # Pre-packaged ready-to-distribute archives
│   ├── silknet-chrome-v1.0.0.zip
│   └── silknet-vscode-v1.0.0.vsix
├── start-bridge.bat    # Windows 1-click server launcher
├── test-bridge.bat     # Windows 1-click test runner
└── test-client.mjs     # End-to-end verification client
```

---

## 📄 License
MIT License. Free and open source.
