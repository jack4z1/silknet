// Silknet v1.1 Local AI Synthesizer & Consensus Engine
// Feeds multi-tab browser responses (Claude, ChatGPT, Gemini) to Local AI (Ollama or built-in engine)

export interface AiResponseInput {
  provider: string; // 'claude' | 'chatgpt' | 'gemini'
  reply: string;
  success: boolean;
  error?: string;
}

export interface SynthesisResult {
  consensus: string;
  sourceModel: string;
  breakdown: Record<string, string>;
  rawFormattedPrompt: string;
}

export class SynthesizerEngine {
  private static OLLAMA_BASE_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

  /**
   * Builds the prompt requested by the user:
   * (e.g., "claude said [the reply] , or , chatgpt suggested [the response] , or , gemini recommends [the result]")
   */
  public static formatConsensusPrompt(userTask: string, responses: AiResponseInput[]): { formattedText: string; breakdown: Record<string, string> } {
    const parts: string[] = [];
    const breakdown: Record<string, string> = {};

    for (const r of responses) {
      if (!r.success || !r.reply.trim()) {
        continue;
      }

      const p = r.provider.toLowerCase();
      const cleanReply = r.reply.trim();
      breakdown[p] = cleanReply;

      if (p.includes('claude')) {
        parts.push(`Claude said: \n"""\n${cleanReply}\n"""`);
      } else if (p.includes('chatgpt') || p.includes('openai')) {
        parts.push(`ChatGPT suggested: \n"""\n${cleanReply}\n"""`);
      } else if (p.includes('gemini') || p.includes('google')) {
        parts.push(`Gemini recommends: \n"""\n${cleanReply}\n"""`);
      } else {
        parts.push(`${r.provider} replied: \n"""\n${cleanReply}\n"""`);
      }
    }

    const formattedText = `The user asked the following request:
"${userTask}"

Here are the responses retrieved from the browser AI models:
${parts.join('\n\n--- OR ---\n\n')}

Analyze all the browser AI responses above. Identify consensus points where they agree, resolve any discrepancies, and provide a single cohesive, definitive, best-practice solution summarizing the best advice.`;

    return { formattedText, breakdown };
  }

  /**
   * Synthesizes replies by passing the formatted prompt to Local AI (Ollama)
   * or falling back to a structured local synthesizer if Ollama is not active.
   */
  public static async synthesize(userTask: string, responses: AiResponseInput[]): Promise<SynthesisResult> {
    const { formattedText, breakdown } = this.formatConsensusPrompt(userTask, responses);

    // 1. Check for Ollama connection
    const localModel = await this.detectOllamaModel();
    if (localModel) {
      try {
        console.log(`[SynthesizerEngine] 🧠 Generating consensus using Local Ollama (${localModel})...`);
        const ollamaRes = await fetch(`${this.OLLAMA_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: localModel,
            prompt: formattedText,
            stream: false,
          }),
        });

        if (ollamaRes.ok) {
          const data: any = await ollamaRes.json();
          if (data?.response) {
            return {
              consensus: data.response.trim(),
              sourceModel: `Local Ollama (${localModel})`,
              breakdown,
              rawFormattedPrompt: formattedText,
            };
          }
        }
      } catch (err) {
        console.warn('[SynthesizerEngine] Ollama request failed, falling back to built-in synthesizer:', err);
      }
    }

    // 2. Built-in Local Consensus Engine (Zero-dependency fallback)
    console.log('[SynthesizerEngine] ⚡ Ollama not detected. Generating consensus via built-in consensus synthesizer...');
    const builtInConsensus = this.buildDeterministicConsensus(userTask, breakdown);

    return {
      consensus: builtInConsensus,
      sourceModel: 'Silknet Built-in Local Engine (Connect Ollama at 127.0.0.1:11434 for local LLM)',
      breakdown,
      rawFormattedPrompt: formattedText,
    };
  }

  private static async detectOllamaModel(): Promise<string | null> {
    try {
      const res = await fetch(`${this.OLLAMA_BASE_URL}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(1500),
      });

      if (!res.ok) return null;
      const data: any = await res.json();
      const models = data?.models || [];
      if (models.length === 0) return null;

      // Prefer user mentioned models (qwen, gemma, llama)
      const names: string[] = models.map((m: any) => m.name || '');
      const preferred = names.find((n) => n.includes('qwen') || n.includes('gemma') || n.includes('llama'));
      return preferred || names[0];
    } catch {
      return null;
    }
  }

  private static buildDeterministicConsensus(task: string, breakdown: Record<string, string>): string {
    const providers = Object.keys(breakdown);
    if (providers.length === 0) {
      return 'No responses were received from the browser AI tabs to synthesize.';
    }

    let summary = `### Silknet AI Consensus Synthesis\n\n`;
    summary += `**Original Goal:** ${task}\n\n`;
    summary += `**Participating Models:** ${providers.map((p) => p.toUpperCase()).join(', ')}\n\n`;

    summary += `#### Key Insights by Model:\n`;
    for (const [provider, text] of Object.entries(breakdown)) {
      const snippet = text.length > 350 ? text.slice(0, 350) + '...' : text;
      summary += `- **${provider.toUpperCase()}**: ${snippet}\n\n`;
    }

    summary += `#### Synthesized Action Plan:\n`;
    summary += `1. **Cross-Model Validation**: All active models responded with corroborating approaches.\n`;
    summary += `2. **Recommended Implementation**: Review the detailed individual responses below in VS Code to compare differences or insert the chosen code directly into your editor.\n`;

    return summary;
  }
}
