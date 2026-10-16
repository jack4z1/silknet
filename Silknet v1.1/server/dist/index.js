import http from 'node:http';
import { WebSocketServer } from 'ws';
import { TabManager } from './tab-manager.js';
import { PrivacyShield } from './sanitizer.js';
import { AdvisorEngine } from './advisor.js';
import { SynthesizerEngine } from './synthesizer.js';
const PORT = Number(process.env.PORT || 4040);
const HOST = '127.0.0.1';
const tabManager = new TabManager();
// Create HTTP server
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-tab-bridge-source');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    // 1. Health & Status
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/status')) {
        const tabs = tabManager.getConnectedTabs();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            version: '1.1.0',
            server: 'Silknet Bridge Server v1.1',
            connectedTabsCount: tabs.length,
            connectedTabs: tabs,
            activeProviders: tabManager.getActiveProviders(),
        }));
        return;
    }
    // 2. Direct Prompt API: POST /api/prompt
    if (req.method === 'POST' && url.pathname === '/api/prompt') {
        try {
            const body = await parseJsonBody(req);
            const prompt = body.prompt;
            const provider = body.provider || 'auto';
            const attachments = body.attachments || [];
            if (!prompt || typeof prompt !== 'string') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required string field: "prompt"' }));
                return;
            }
            // Validate attachments (20MB total limit, 5 files max, no 3D/video/audio)
            tabManager.validateAttachments(attachments);
            const sanitized = PrivacyShield.sanitize(prompt);
            if (sanitized.redactedCount > 0) {
                console.log(`[PrivacyShield] 🛡️ Scrubbed ${sanitized.redactedCount} items (${sanitized.redactionsSummary.join(', ')}) from prompt`);
            }
            const isManualUi = req.headers['x-tab-bridge-source'] === 'manual-ui';
            if (!isManualUi && tabManager.isApprovalRequired()) {
                const approved = await tabManager.requestApproval({
                    caller: 'Terminal / Automated Tool',
                    task: prompt.slice(0, 120) + (prompt.length > 120 ? '...' : ''),
                    prompt: sanitized.cleanText,
                    provider,
                });
                if (!approved) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Blocked: Human user denied permission to consult browser AI.' }));
                    return;
                }
            }
            if (provider === 'all') {
                const results = await tabManager.broadcastMultiPrompt(sanitized.cleanText, 180000, attachments);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, multi: true, results, redacted: sanitized.redactionsSummary }));
                return;
            }
            const result = await tabManager.executePrompt(sanitized.cleanText, provider, 180000, attachments);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...result, redacted: sanitized.redactionsSummary }));
        }
        catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
        }
        return;
    }
    // 3. Multi-Tab Consensus Synthesis: POST /api/consensus
    // Broadcasts prompt across up to 3 open AI tabs (Claude, ChatGPT, Gemini),
    // gathers replies, and feeds them into Local AI (Ollama or built-in engine) to summarize
    if (req.method === 'POST' && url.pathname === '/api/consensus') {
        try {
            const body = await parseJsonBody(req);
            const prompt = body.prompt;
            const attachments = body.attachments || [];
            if (!prompt || typeof prompt !== 'string') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required field: "prompt"' }));
                return;
            }
            tabManager.validateAttachments(attachments);
            const sanitized = PrivacyShield.sanitize(prompt);
            console.log(`[Consensus API] 🌐 Initiating Multi-Tab consensus query: "${sanitized.cleanText.slice(0, 80)}..."`);
            // 1. Broadcast prompt + attachments across all connected browser tabs (max 3)
            const tabResults = await tabManager.broadcastMultiPrompt(sanitized.cleanText, 180000, attachments);
            // 2. Synthesize answers via Local AI
            const synthesis = await SynthesizerEngine.synthesize(sanitized.cleanText, tabResults);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                consensus: synthesis.consensus,
                sourceModel: synthesis.sourceModel,
                breakdown: synthesis.breakdown,
                tabResults,
                redacted: sanitized.redactionsSummary,
            }));
        }
        catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
        }
        return;
    }
    // 4. Advisor Handoff API: POST /api/advisor
    if (req.method === 'POST' && url.pathname === '/api/advisor') {
        try {
            const body = await parseJsonBody(req);
            if (!body.task) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing required "task" description' }));
                return;
            }
            tabManager.validateAttachments(body.attachments);
            const isManualUi = req.headers['x-tab-bridge-source'] === 'manual-ui';
            if (!isManualUi && tabManager.isApprovalRequired()) {
                const approved = await tabManager.requestApproval({
                    caller: 'Local AI / Automated Advisor Client',
                    task: body.task.slice(0, 120),
                    prompt: body.task,
                    provider: body.provider || 'auto',
                });
                if (!approved) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Blocked: Human user denied permission to consult browser AI.' }));
                    return;
                }
            }
            const response = await AdvisorEngine.consultAdvisor(tabManager, {
                task: body.task,
                code: body.code,
                error: body.error,
                language: body.language,
                provider: body.provider,
                mode: body.mode,
                guardrails: body.guardrails,
                attachments: body.attachments,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
        }
        catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
        }
        return;
    }
    // 5. Emergency Killswitch API: POST /api/killswitch
    if (req.method === 'POST' && url.pathname === '/api/killswitch') {
        const abortedCount = tabManager.abortAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Emergency Killswitch executed. Aborted ${abortedCount} active request(s).` }));
        return;
    }
    // 6. Human Gate Toggle: POST /api/gate/toggle
    if (req.method === 'POST' && url.pathname === '/api/gate/toggle') {
        const body = await parseJsonBody(req);
        const requireApproval = Boolean(body.requireApproval);
        tabManager.setRequireApproval(requireApproval);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, requireApproval }));
        return;
    }
    // 7. Human Approvals Query: GET /api/approvals
    if (req.method === 'GET' && url.pathname === '/api/approvals') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            requireApproval: tabManager.isApprovalRequired(),
            pendingApprovals: tabManager.getPendingApprovals(),
        }));
        return;
    }
    // 8. Human Decision POST /api/approvals/decide
    if (req.method === 'POST' && url.pathname === '/api/approvals/decide') {
        const body = await parseJsonBody(req);
        const success = tabManager.resolveApproval(body.id, Boolean(body.approved));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success }));
        return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
});
// Create WebSocket server for browser extension tabs
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
    console.log('[Silknet Server] 🔌 Browser extension connected to WebSocket');
    ws.on('message', (messageData) => {
        try {
            const msg = JSON.parse(messageData.toString());
            if (msg.type === 'HELLO') {
                tabManager.registerTab(ws, {
                    id: msg.id,
                    provider: msg.provider,
                    title: msg.title,
                    url: msg.url,
                });
            }
            else if (msg.type === 'SYNC_ALL_TABS') {
                tabManager.syncTabsForSocket(ws, msg.tabs || []);
            }
            else if (msg.type === 'TAB_ACTIVATED') {
                tabManager.markTabActive(msg.id);
            }
            else if (msg.type === 'TAB_CLOSED') {
                tabManager.unregisterTab(msg.id);
            }
            else if (msg.type === 'PROMPT_RESULT' || msg.type === 'MULTI_PROMPT_RESULT') {
                tabManager.handleMessageFromTab(msg);
            }
            else if (msg.type === 'PING') {
                ws.send(JSON.stringify({ type: 'PONG', time: Date.now() }));
            }
        }
        catch (err) {
            console.error('[Silknet Server] Error parsing WebSocket message:', err);
        }
    });
    ws.on('close', () => {
        console.log('[Silknet Server] 🔌 Browser extension disconnected');
        tabManager.unregisterTabsForSocket(ws);
    });
    ws.on('error', (err) => {
        console.warn('[Silknet Server] WebSocket error:', err.message);
    });
});
server.listen(PORT, HOST, () => {
    console.log(`\n======================================================`);
    console.log(`  🌐 SILKNET v1.1 BRIDGE SERVER ACTIVE`);
    console.log(`  🔗 Endpoint: http://${HOST}:${PORT}`);
    console.log(`  ⚡ Multi-Tab Consensus: Enabled (Max 3 Tabs)`);
    console.log(`  📎 File & Image Attachments: Native DataTransfer Enabled`);
    console.log(`  🛑 Emergency Killswitch: Ready`);
    console.log(`======================================================\n`);
});
async function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            // Allow up to 25MB for file attachments payload
            if (body.length > 25 * 1024 * 1024) {
                reject(new Error('Request payload too large (max 25MB)'));
            }
        });
        req.on('end', () => {
            if (!body.trim())
                return resolve({});
            try {
                resolve(JSON.parse(body));
            }
            catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}
