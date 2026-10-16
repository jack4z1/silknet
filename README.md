# Silknet

> A local developer bridge connecting code editors directly to active browser-based language model sessions (ChatGPT, Claude, and Gemini) with parallel consensus synthesis and zero cloud dependencies.

---

## Overview

Modern software development often involves consulting multiple frontier language models to evaluate trade-offs, catch regressions, and verify architectural decisions. However, relying on separate paid APIs requires managing multiple billing accounts, incurring ongoing token fees, and losing the context, project instructions, and subscription benefits already present in your daily web sessions.

**Silknet** eliminates this friction. It runs a lightweight local WebSocket daemon and a Chrome extension that safely interfaces with your existing web tabs. From within VS Code or compatible editors, you can query your active ChatGPT, Claude, and Gemini sessions simultaneously, attach project files directly into the browser DOM, and synthesize the responses into a cohesive recommendation using local models.

All communication occurs strictly over `127.0.0.1`. No telemetry, external servers, or proxy services are involved.

---

## Repository Structure

```
silknet/
├── Silknet v1.0/         # Original baseline release (Single-tab bridge, privacy shield)
└── Silknet v1.1/         # Current release (Consensus engine, native attachments, voice dictation)
    ├── extension/        # Manifest V3 browser content script and service worker
    ├── server/           # Local Node.js WebSocket orchestration server
    ├── vscode/           # VS Code extension and Master Panel UI
    └── release/          # Prebuilt .vsix and Chrome extension packages
```

* **[`Silknet v1.1/`](./Silknet%20v1.1)** — Recommended release. Features multi-tab consensus querying, binary file attachments via native `DataTransfer`, voice dictation, and independent response stabilization.
* **[`Silknet v1.0/`](./Silknet%20v1.0)** — Preserved initial release. Focused on single-tab routing, prompt broadcasting, and baseline security controls.

---

## Architecture at a Glance

1. **Editor Master Panel**: A webview sidebar inside VS Code allows you to compose prompts, record dictation, attach workspace files, and trigger single-model or consensus workflows.
2. **Local Bridge Server**: A standalone Node.js process running on `http://127.0.0.1:4040` manages tab registrations, sanitizes outgoing data through an automated privacy shield, and synthesizes multi-model outputs.
3. **Browser Adapter (MV3)**: A lightweight content script monitors tab state, injects text and file attachments safely into composer elements, detects response completion across modern web frontends, and relays results back to the local daemon.

---

## License

This project is licensed under the MIT License. Open source and free for personal and commercial use.
