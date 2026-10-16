# Silknet v1.1

> Multi-Model Parallel Consensus, Native File Attachments, and Local Synthesis for Developers.

Silknet v1.1 connects your local development workflow directly to active web browser sessions of **ChatGPT**, **Claude**, and **Gemini**. By operating directly through authenticated browser tabs, Silknet provides access to frontier models without recurring API billing, usage meters, or middleman servers.

---

## Core Capabilities

### 1. Multi-Tab Consensus Engine
* **Concurrent Dispatch**: Broadcasts queries simultaneously to active ChatGPT, Claude, and Gemini tabs.
* **Independent Stream Resolution**: Each provider tab runs an isolated observer that stabilizes responses as soon as generation completes, avoiding cross-tab blocking or slow-model bottlenecks.
* **Unified Local Synthesis**: Consolidates perspectives into a structured comparison (`Claude said...`, `ChatGPT suggested...`, `Gemini recommended...`) and generates a cohesive synthesis using local models (via Ollama at `127.0.0.1:11434` or the built-in heuristic synthesizer).

### 2. Native DOM File Attachments
* **Direct DataTransfer Pipeline**: Uses the browser's native `DataTransfer` and file input APIs to attach real binary files and images directly to chat composers.
* **Verification & Limits**: Enforces a 20 MB total payload ceiling and a maximum of 5 files per prompt.
* **Format Filtering**: Automatically validates file types to ensure compatibility and prevent browser crashes, explicitly rejecting unsupported 3D, high-bitrate video, and raw audio files.

### 3. Voice Dictation
* **Hands-Free Prompting**: Built-in speech-to-text input within the editor sidebar allows you to dictate complex technical queries directly without breaking your typing workflow.

### 4. Privacy Shield & Security Controls
* **Automatic Pattern Redaction**: Client-side inspection strips API credentials, private tokens, internal IP addresses, and user-specific filesystem paths before prompts leave the local environment.
* **Human-in-the-Loop Approval Gate**: Configurable confirmation requirement prior to any prompt dispatch.
* **Emergency Killswitch**: Immediate single-click termination signal that interrupts in-flight web generations and halts pending background tasks.

---

## Getting Started

### Prerequisites
* **Node.js**: v18.0.0 or later
* **Google Chrome** (or Chromium-based browser: Edge, Brave, Arc, Opera)
* **VS Code** (or Cursor / Windsurf)

---

### 1. Launch the Local Server
The bridge server coordinates communication between your code editor and browser tabs:

```bash
cd server
npm install
npm start
```
*The daemon listens on `http://127.0.0.1:4040`.*

---

### 2. Install the Browser Extension
1. Open Chrome and navigate to `chrome://extensions/`.
2. Toggle on **Developer mode** in the upper right corner.
3. Click **Load unpacked** and select the `extension` directory inside `Silknet v1.1`.
4. Open your model tabs:
   * [ChatGPT](https://chatgpt.com)
   * [Claude](https://claude.ai)
   * [Gemini](https://gemini.google.com)
5. Pin the Silknet extension to confirm connected tab indicators turn green.

---

### 3. Install the VS Code Extension
1. Open VS Code.
2. Press `Ctrl+Shift+X` to open the Extensions pane.
3. Select `...` (More Actions) in the top-right corner and choose **Install from VSIX...**.
4. Select `silknet-1.1.0.vsix` located in `vscode/` or `release/`.
5. Click the Silknet icon in the Activity Bar to open the Master Panel.

---

## Editor Keybindings

| Command | Shortcut | Purpose |
|---|---|---|
| `tabBridge.consensusAI` | `Ctrl+Alt+C` | Query all active browser models and synthesize consensus |
| `tabBridge.askAI` | `Ctrl+Alt+A` | Query the currently selected primary browser model |
| `tabBridge.sendSelection` | `Ctrl+Alt+S` | Dispatch highlighted code selection to browser model |
| `tabBridge.checkStatus` | Click Status Bar | Display active tab connectivity and daemon health |

---

## Technical Specifications

| Parameter | Specification |
|---|---|
| **Architecture** | Manifest V3 Chrome Extension + Local Node.js WebSocket Daemon |
| **Network Boundary** | Strict loopback (`127.0.0.1`), zero outbound telemetry |
| **Max Concurrent Models** | 3 tabs (ChatGPT, Claude, Gemini) |
| **Attachment Capacity** | Up to 5 files, 20 MB cumulative size limit |
| **Local Synthesis** | Ollama integration (`qwen2.5`, `llama3.2`, `gemma2`) with fallback heuristic engine |
| **Platform Compatibility** | Windows, macOS, Linux |

---

## License

Distributed under the MIT License. Open source and free for personal and commercial use.
