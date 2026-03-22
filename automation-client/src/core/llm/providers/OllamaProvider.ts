import { LLMProvider } from '../LLMProvider';
import { LLMRequest, LLMResponse } from '../types';

type ErrorKind = 'network' | 'api' | 'model' | 'unavailable';

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  private logger?: (msg: string) => void;

  constructor(
    private baseUrl = 'http://127.0.0.1:11434',
    private defaultModel = 'llama3.1',
    logger?: (msg: string) => void,
  ) {
    this.logger = logger;
  }

  private isBrowser() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
  }

  // Used by LLMManager to soft-skip this provider in environments where it cannot work.
  async isAvailable(): Promise<boolean> {
    if (!this.baseUrl) {
      this.logger?.(`[Ollama] no baseUrl configured`);
      return false;
    }
    // Best-effort check (Node/browser). If using browser with CORS, ensure portal/proxy is configured.
    try {
      const url = `${this.baseUrl}/api/tags`;
      this.logger?.(`[Ollama] checking availability at ${url}...`);
      const res = await fetch(url, { method: 'GET' });
      const available = res.ok;
      if (available) {
        this.logger?.(`[Ollama] available (HTTP ${res.status})`);
      } else {
        this.logger?.(`[Ollama] unavailable (HTTP ${res.status})`);
      }
      return available;
    } catch (e) {
      const err = e as Error;
      this.logger?.(`[Ollama] connection failed: ${err.message}`);
      return false;
    }
  }

  async getAvailableModels(): Promise<string[]> {
    return [this.defaultModel];
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    // Resolve 'auto' model to actual default model
    const model = request.model && request.model !== 'auto' ? request.model : this.defaultModel;

    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const user = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');

    const prompt = system ? `${system}\n\n${user}` : user;

    const endpoint = `${this.baseUrl}/api/chat`;
    this.logger?.(`[Ollama] generate request: model=${model} baseUrl=${this.baseUrl} endpoint=${endpoint} promptLength=${prompt.length}`);

    try {
      // Ollama REST "chat" endpoint.
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          options: {
            temperature: request.temperature ?? 0.2,
            num_predict: request.maxTokens ?? 512,
          },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        const errMsg = `Ollama API error (HTTP ${res.status}): ${text}`;
        this.logger?.(`[Ollama] ${errMsg}`);
        const err = new Error(errMsg);
        (err as any).kind = 'api' as ErrorKind;
        throw err;
      }

      const json = (await res.json()) as any;
      const content = json?.message?.content ?? '';
      this.logger?.(`[Ollama] response received: length=${content.length}`);

      return {
        provider: this.name,
        model,
        content,
        raw: json,
      };
    } catch (e) {
      const err = e as Error;
      const errMsg = `Ollama fetch failed: ${err.message} (endpoint=${endpoint})`;
      this.logger?.(`[Ollama] ERROR: ${errMsg}`);
      const newErr = new Error(errMsg);
      (newErr as any).kind = 'network' as ErrorKind;
      throw newErr;
    }
  }
}

