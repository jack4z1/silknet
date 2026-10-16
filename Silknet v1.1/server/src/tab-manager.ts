import { WebSocket } from 'ws';

export interface FileAttachment {
  name: string;
  size: number;
  mimeType: string;
  base64: string;
}

export interface TabConnection {
  id: string;
  provider: 'chatgpt' | 'claude' | 'gemini' | 'unknown';
  title?: string;
  url?: string;
  ws: WebSocket;
  connectedAt: number;
  lastActive?: number;
}

export interface PromptResult {
  provider: string;
  success: boolean;
  reply: string;
  error?: string;
  durationMs: number;
}

export interface PendingApproval {
  id: string;
  timestamp: number;
  caller: string;
  task: string;
  prompt: string;
  provider: string;
  resolve: (approved: boolean) => void;
}

interface PendingRequest {
  id: string;
  provider: string;
  resolve: (result: PromptResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  startTime: number;
}

interface PendingMultiRequest {
  id: string;
  resolve: (results: PromptResult[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  startTime: number;
}

// Constraints specified by user
const FORBIDDEN_EXTENSIONS = [
  '.obj', '.gltf', '.glb', '.stl', '.blend', '.fbx', '.3ds', '.dae', '.step', '.iges',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v',
  '.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a', '.wma'
];
const MAX_FILE_COUNT = 5;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024; // 20 MB

export class TabManager {
  private tabs: Map<string, TabConnection> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private pendingMultiRequests: Map<string, PendingMultiRequest> = new Map();
  private requireApproval: boolean = true;
  private pendingApprovals: Map<string, PendingApproval> = new Map();

  public registerTab(ws: WebSocket, data: { id: string; provider: string; title?: string; url?: string }): TabConnection {
    const provider = this.normalizeProvider(data.provider);
    const tab: TabConnection = {
      id: data.id,
      provider,
      title: data.title,
      url: data.url,
      ws,
      connectedAt: Date.now(),
    };

    this.tabs.set(data.id, tab);
    console.log(`[TabManager] 🟢 Tab registered: ${provider.toUpperCase()} (${data.id})`);
    return tab;
  }

  public markTabActive(id: string): void {
    const tab = this.tabs.get(id);
    if (tab) {
      tab.lastActive = Date.now();
      console.log(`[TabManager] 🎯 Tab focused in browser: ${tab.provider.toUpperCase()} (${id})`);
    }
  }

  public unregisterTab(id: string): void {
    const tab = this.tabs.get(id);
    if (tab) {
      console.log(`[TabManager] 🔴 Tab disconnected: ${tab.provider.toUpperCase()} (${id})`);
      this.tabs.delete(id);

      for (const [reqId, req] of this.pendingRequests.entries()) {
        if (req.provider === tab.provider) {
          clearTimeout(req.timer);
          this.pendingRequests.delete(reqId);
          req.resolve({
            provider: tab.provider,
            success: false,
            reply: '',
            error: `Tab ${tab.provider} closed while awaiting response`,
            durationMs: Date.now() - req.startTime,
          });
        }
      }
    }
  }

  public unregisterTabsForSocket(ws: WebSocket): void {
    const toDelete: string[] = [];
    for (const [id, tab] of this.tabs.entries()) {
      if (tab.ws === ws) {
        toDelete.push(id);
      }
    }
    for (const id of toDelete) {
      this.unregisterTab(id);
    }
  }

  public syncTabsForSocket(
    ws: WebSocket,
    currentTabs: Array<{ id: string; provider: string; title?: string; url?: string }>,
  ): void {
    const currentIdSet = new Set(currentTabs.map((t) => t.id));
    for (const [id, tab] of this.tabs.entries()) {
      if (tab.ws === ws && !currentIdSet.has(id)) {
        this.unregisterTab(id);
      }
    }
    for (const t of currentTabs) {
      this.registerTab(ws, t);
    }
  }

  public getConnectedTabs(): Array<{ id: string; provider: string; title?: string; url?: string }> {
    const validTabs: Array<{ id: string; provider: string; title?: string; url?: string }> = [];
    const deadIds: string[] = [];

    for (const [id, tab] of this.tabs.entries()) {
      if (tab.ws.readyState !== WebSocket.OPEN) {
        deadIds.push(id);
      } else {
        validTabs.push({
          id: tab.id,
          provider: tab.provider,
          title: tab.title,
          url: tab.url,
        });
      }
    }

    for (const id of deadIds) {
      this.unregisterTab(id);
    }

    return validTabs;
  }

  public getActiveProviders(): string[] {
    const set = new Set<string>();
    for (const tab of this.getConnectedTabs()) {
      set.add(tab.provider);
    }
    return Array.from(set);
  }

  public validateAttachments(attachments?: FileAttachment[]): void {
    if (!attachments || attachments.length === 0) return;

    if (attachments.length > MAX_FILE_COUNT) {
      throw new Error(`Maximum 5 files can be attached at a time. (Received: ${attachments.length})`);
    }

    let totalBytes = 0;
    for (const f of attachments) {
      const lower = (f.name || '').toLowerCase();
      for (const ext of FORBIDDEN_EXTENSIONS) {
        if (lower.endsWith(ext)) {
          throw new Error(`Forbidden file format: "${f.name}". 3D, video, and audio files cannot be attached.`);
        }
      }

      if (f.mimeType) {
        const m = f.mimeType.toLowerCase();
        if (m.startsWith('audio/') || m.startsWith('video/') || m.includes('model/') || m.includes('gltf')) {
          throw new Error(`Forbidden file format: "${f.name}". 3D, video, and audio files cannot be attached.`);
        }
      }

      totalBytes += f.size || 0;
    }

    if (totalBytes > MAX_TOTAL_SIZE) {
      const mb = (totalBytes / (1024 * 1024)).toFixed(2);
      throw new Error(`Total attachment size (${mb} MB) exceeds maximum allowed limit of 20 MB.`);
    }
  }

  public pickProvider(requested?: string): TabConnection | null {
    if (this.tabs.size === 0) return null;

    if (requested && requested !== 'auto') {
      const normalized = this.normalizeProvider(requested);
      for (const tab of this.tabs.values()) {
        if (tab.provider === normalized && tab.ws.readyState === WebSocket.OPEN) {
          return tab;
        }
      }
      return null;
    }

    const openTabs = Array.from(this.tabs.values()).filter((t) => t.ws.readyState === WebSocket.OPEN);
    if (openTabs.length === 0) return null;

    openTabs.sort((a, b) => (b.lastActive || b.connectedAt) - (a.lastActive || a.connectedAt));
    return openTabs[0];
  }

  /**
   * Executes prompt on a single browser tab.
   */
  public async executePrompt(
    prompt: string,
    targetProvider?: string,
    timeoutMs = 180000,
    attachments: FileAttachment[] = [],
  ): Promise<PromptResult> {
    this.validateAttachments(attachments);

    const tab = this.pickProvider(targetProvider);
    if (!tab) {
      const available = this.getActiveProviders();
      throw new Error(
        `No browser tab available for provider "${targetProvider || 'auto'}". Open tabs: ${
          available.length > 0 ? available.join(', ') : 'none (please open ChatGPT, Claude, or Gemini in browser)'
        }`,
      );
    }

    const reqId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const startTime = Date.now();

    return new Promise<PromptResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        resolve({
          provider: tab.provider,
          success: false,
          reply: '',
          error: `Timed out waiting for response from ${tab.provider} (${timeoutMs}ms)`,
          durationMs: Date.now() - startTime,
        });
      }, timeoutMs);

      this.pendingRequests.set(reqId, {
        id: reqId,
        provider: tab.provider,
        resolve,
        reject,
        timer,
        startTime,
      });

      tab.ws.send(
        JSON.stringify({
          type: 'EXECUTE_PROMPT',
          id: reqId,
          prompt,
          provider: tab.provider,
          attachments,
        }),
      );

      console.log(`[TabManager] 🚀 Prompt sent to ${tab.provider.toUpperCase()} (${reqId})`);
    });
  }

  /**
   * Multi-Tab Consensus Broadcast (Max 3 tabs: ChatGPT, Claude, Gemini in parallel).
   */
  public async broadcastMultiPrompt(
    prompt: string,
    timeoutMs = 180000,
    attachments: FileAttachment[] = [],
  ): Promise<PromptResult[]> {
    this.validateAttachments(attachments);

    const activeTabs = Array.from(this.tabs.values()).filter((t) => t.ws.readyState === WebSocket.OPEN);
    if (activeTabs.length === 0) {
      throw new Error('No active browser AI tabs connected to execute multi-prompt. Please open ChatGPT, Claude, or Gemini.');
    }

    // Deduplicate by provider so we don't send duplicate prompts
    const uniqueTabs = new Map<string, TabConnection>();
    for (const t of activeTabs) {
      if (!uniqueTabs.has(t.provider) && ['chatgpt', 'claude', 'gemini'].includes(t.provider)) {
        uniqueTabs.set(t.provider, t);
      }
    }

    const targetList = Array.from(uniqueTabs.values()).slice(0, 3); // Max 3 tabs
    console.log(`[TabManager] 🌐 Silknet Multi-Tab Broadcast to ${targetList.length} tab(s): ${targetList.map((t) => t.provider).join(', ')}`);

    const promises = targetList.map(async (tab) => {
      try {
        return await this.executePrompt(prompt, tab.provider, timeoutMs, attachments);
      } catch (err: any) {
        return {
          provider: tab.provider,
          success: false,
          reply: '',
          error: err.message || String(err),
          durationMs: 0,
        };
      }
    });

    return await Promise.all(promises);
  }

  public handleMessageFromTab(data: any): void {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'PROMPT_RESULT') {
      const { id, success, reply, error, provider } = data;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        const durationMs = Date.now() - pending.startTime;
        console.log(`[TabManager] ✅ Received reply from ${provider.toUpperCase()} in ${durationMs}ms`);
        pending.resolve({
          provider: provider || pending.provider,
          success: Boolean(success),
          reply: reply || '',
          error: error || undefined,
          durationMs,
        });
      }
    } else if (data.type === 'MULTI_PROMPT_RESULT') {
      const { id, results } = data;
      const pendingMulti = this.pendingMultiRequests.get(id);
      if (pendingMulti) {
        clearTimeout(pendingMulti.timer);
        this.pendingMultiRequests.delete(id);
        pendingMulti.resolve(results || []);
      }
    }
  }

  public isApprovalRequired(): boolean {
    return this.requireApproval;
  }

  public setRequireApproval(enabled: boolean): void {
    this.requireApproval = enabled;
    console.log(`[TabManager] 🔒 Human-Approval Gate set to: ${enabled ? 'STRICTLY ENFORCED' : 'OFF'}`);
  }

  public getPendingApprovals(): Array<Omit<PendingApproval, 'resolve'>> {
    return Array.from(this.pendingApprovals.values()).map((a) => ({
      id: a.id,
      timestamp: a.timestamp,
      caller: a.caller,
      task: a.task,
      prompt: a.prompt,
      provider: a.provider,
    }));
  }

  public resolveApproval(id: string, approved: boolean): boolean {
    const item = this.pendingApprovals.get(id);
    if (!item) return false;
    this.pendingApprovals.delete(id);
    item.resolve(approved);
    return true;
  }

  public async requestApproval(data: { caller: string; task: string; prompt: string; provider: string }): Promise<boolean> {
    if (!this.requireApproval) return true;

    const id = `appr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(id)) {
          this.pendingApprovals.delete(id);
          resolve(false);
        }
      }, 300000);

      this.pendingApprovals.set(id, {
        id,
        timestamp: Date.now(),
        caller: data.caller,
        task: data.task,
        prompt: data.prompt,
        provider: data.provider,
        resolve: (approved) => {
          clearTimeout(timer);
          resolve(approved);
        },
      });

      console.log(`[TabManager] ⚠️ Human approval requested for: "${data.task}" (ID: ${id})`);
    });
  }

  public abortAll(): number {
    const count = this.pendingRequests.size + this.pendingMultiRequests.size;
    console.warn(`[TabManager] 🛑 EMERGENCY KILLSWITCH: Aborting all ${count} active request(s)...`);

    for (const tab of this.tabs.values()) {
      if (tab.ws.readyState === WebSocket.OPEN) {
        tab.ws.send(JSON.stringify({ type: 'ABORT_EXECUTION' }));
      }
    }

    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.resolve({
        provider: req.provider,
        success: false,
        reply: '',
        error: 'Execution cancelled by User Emergency Stop / Killswitch',
        durationMs: Date.now() - req.startTime,
      });
    }
    this.pendingRequests.clear();

    for (const [id, reqMulti] of this.pendingMultiRequests.entries()) {
      clearTimeout(reqMulti.timer);
      reqMulti.resolve([]);
    }
    this.pendingMultiRequests.clear();

    for (const appr of this.pendingApprovals.values()) {
      appr.resolve(false);
    }
    this.pendingApprovals.clear();

    return count;
  }

  private normalizeProvider(raw: string): 'chatgpt' | 'claude' | 'gemini' | 'unknown' {
    const str = (raw || '').toLowerCase();
    if (str.includes('chatgpt') || str.includes('openai')) return 'chatgpt';
    if (str.includes('claude') || str.includes('anthropic')) return 'claude';
    if (str.includes('gemini') || str.includes('google')) return 'gemini';
    return 'unknown';
  }
}
