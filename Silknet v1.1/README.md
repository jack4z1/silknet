# Silknet v1.1 🌐

> **Connect Browser AI to Local AI — Multi-Tab AI Consensus, Voice Prompting & Native File Attachments**

Silknet v1.1 is the advanced bridge that turns your frontier web browser AI tabs (**ChatGPT, Claude, Gemini**) into an integrated consensus engine for your local IDE and local AI models (**Ollama / Qwen / Gemma / Llama**).

---

## 🌟 What's New in v1.1

### 1. 🧠 Multi-Tab AI Consensus (Max 3 Tabs)
- Automatically detects open **ChatGPT**, **Claude**, and **Gemini** tabs in your browser.
- Broadcasts your prompt to all active tabs simultaneously.
- Formats replies dynamically:
  - *Claude said [response]*
  - *ChatGPT suggested [response]*
  - *Gemini recommends [response]*
- Feeds all three viewpoints into your **Local AI** (via Ollama at `127.0.0.1:11434` or Silknet's built-in local consensus synthesizer) to produce a unified, best-practice consensus solution.

### 2. 📎 Real File & Image Attachments (Native DataTransfer)
- **Direct DOM injection**: Fixes previous text-only injection limitations by attaching real binary files and images via the browser's native `DataTransfer` / `input[type="file"]` system.
- **Strict Size Guard**: Maximum **20 MB** total attachment size.
- **Quantity Guard**: Maximum **5 files** per prompt.
- **Safety Filter**: Strictly excludes 3D files (`.obj`, `.gltf`, `.stl`, `.blend`), video files (`.mp4`, `.mov`, etc.), and audio files (`.mp3`, `.wav`, etc.).

### 3. 🎤 Voice Prompting (Speech-to-Text)
- Dedicated microphone button in the VS Code master panel.
- Speak naturally to dictate prompts directly into the prompt box without typing.

### 4. 🎛️ Minimalist Browser Extension UI
- **Zero bloat**: Heavy UI and local AI processing remain 100% inside VS Code.
- **Master ON/OFF Toggle**: Easily disable the bridge with one click.
- **Status Indicators**: Real-time connection badge (Connected / Connecting / Disconnected).
- **Tab Workforce Selector (Max 3)**: Select or deselect individual AI tabs (ChatGPT, Claude, Gemini) with live colored status dots:
  - 🟢 **Green**: Connected & tab detected
  - 🟡 **Yellow/Blue**: Connecting / busy
  - 🔴 **Red**: Disconnected / tab offline

### 5. 🛡️ Privacy Shield & Emergency Stop
- **Auto-Redaction**: Scrubs API keys, passwords, bearer tokens, IP addresses, and personal filesystem paths before prompts leave your machine.
- **Human Approval Gate**: Optional confirmation modal before external web AI is queried.
- **🛑 Emergency Killswitch**: Instantly aborts all active web AI executions with one click.

---

## 🚀 Quick Setup Guide

### Step 1: Start the Local Bridge Server
```bash
cd server
npm install
npm start
```
*Server runs locally at `http://127.0.0.1:4040`.*

### Step 2: Install Browser Extension
1. Open Chrome (or Edge / Brave / Opera) and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension` folder inside `silknet v1.1`.
4. Open your favorite AI tabs: [ChatGPT](https://chatgpt.com), [Claude](https://claude.ai), and [Gemini](https://gemini.google.com).

### Step 3: Install the VS Code Extension
1. Open VS Code.
2. Go to the Extensions view (`Ctrl+Shift+X`).
3. Click the `...` (Views and More Actions) menu in the top-right corner of the Extensions pane.
4. Select **Install from VSIX...** and pick `silknet-1.1.0.vsix` located in `vscode/` or `release/`.
5. Click the Silknet bridge icon in the Activity Bar to launch the Consensus Panel!

---

## ⌨️ Keyboard Shortcuts (VS Code)

| Command | Shortcut | Description |
|---|---|---|
| `tabBridge.consensusAI` | `Ctrl+Alt+C` | Query up to 3 Browser AIs simultaneously & synthesize with Local AI |
| `tabBridge.askAI` | `Ctrl+Alt+A` | Ask single active Browser AI |
| `tabBridge.sendSelection` | `Ctrl+Alt+S` | Send highlighted code to Browser AI |
| `tabBridge.checkStatus` | Click status bar | View connected tabs and health |

---

## 🔒 Security & Privacy Guarantees
- Zero cloud servers: all communication happens strictly over `127.0.0.1` (localhost).
- No credentials or cookies stored.
- Fully compatible with Ollama local models (`qwen2.5`, `gemma2`, `llama3.2`).
