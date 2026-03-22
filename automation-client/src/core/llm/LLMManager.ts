import { LLMProvider } from './LLMProvider';
import { LLMRequest, LLMResponse } from './types';

type FallbackKind = 'network' | 'model' | 'timeout' | 'api' | 'logic' | 'unavailable';

export class LLMManager {
  private providers = new Map<string, LLMProvider>();
  private activeProviderName: string | null = null;

  private providerFallbackOrder: string[] = [
    'gemini',
    'openrouter',
    'openai',
    'claude',
    'deepseek',
    'ollama',
  ];

  private readonly logger: (msg: string) => void;
  private readonly timeoutMs: number;
  private readonly retryDelayBaseMs: number;

  constructor(logger: (msg: string) => void) {
    this.logger = logger;
    this.timeoutMs = 30_000;
    this.retryDelayBaseMs = 350;
  }

  registerProvider(provider: LLMProvider) {
    this.providers.set(provider.name, provider);
    if (!this.activeProviderName) this.activeProviderName = provider.name;
  }

  setActiveProvider(name: string) {
    if (!this.providers.has(name)) {
      throw new Error(`Unknown provider: ${name}`);
    }
    this.activeProviderName = name;
  }

  setProviderFallbackOrder(order: string[]) {
    this.providerFallbackOrder = order;
  }

  getActiveProviderName() {
    return this.activeProviderName;
  }

  async generate(request: LLMRequest, retries = 1): Promise<LLMResponse> {
    if (!this.activeProviderName) throw new Error('No active LLM provider');

    // For local/offline providers (ollama), don't fallback to cloud providers
    const isLocalProvider = ['ollama'].includes(this.activeProviderName);
    const candidates = isLocalProvider ? [this.providers.get(this.activeProviderName)!] : this.getProvidersToTry();

    const sys = request.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n')
      .slice(0, 250);
    this.logger(
      `[LLM] request candidates=${candidates.map((p) => p.name).join(' -> ')} model=${request.model} retries=${retries} strictMode=${isLocalProvider}`,
    );
    this.logger(
      `[LLM] prompt summary: systemChars=${sys.length} userPreview="${user.replaceAll(
        '\n',
        ' ',
      )}"`,
    );

    let lastErr: unknown = null;

    const activeName = this.activeProviderName;
    for (const provider of candidates) {
      const isActive = provider.name === activeName;
      
      // In strict mode (local providers), skip availability check and go directly to generate
      // This avoids CORS issues and lets the real error surface
      if (!isLocalProvider) {
        const available = await provider.isAvailable().catch(() => false);
        if (!available) {
          this.logger(
            `[LLM] skip provider=${provider.name} isAvailable=false (activeProvider=${activeName})`,
          );
          continue;
        }
      }

      this.logger(`[LLM] trying provider=${provider.name}`);

      try {
        return await this.withRetry(provider, request, retries);
      } catch (e) {
        lastErr = e;
        const err = e as any;
        const kind = this.classifyProviderErrorKind(err);
        this.logger(
          `[LLM] provider failed provider=${provider.name} kind=${kind} message="${err?.message ?? String(e)}"`,
        );

        // Fallback only for network/model/timeout-ish failures.
        if (!this.shouldFallbackOnKind(kind)) {
          throw e;
        }
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error('LLM request failed');
  }

  private getProvidersToTry(): LLMProvider[] {
    if (!this.activeProviderName) throw new Error('No active LLM provider');
    const active = this.activeProviderName;
    const orderedNames = [
      active,
      ...this.providerFallbackOrder.filter((n) => n !== active),
    ];

    // Also include providers registered but not in fallback order.
    for (const name of this.providers.keys()) {
      if (!orderedNames.includes(name)) orderedNames.push(name);
    }

    const providers: LLMProvider[] = [];
    for (const name of orderedNames) {
      const p = this.providers.get(name);
      if (p) providers.push(p);
    }
    if (!providers.length) {
      throw new Error('No registered LLM providers');
    }
    return providers;
  }

  private shouldFallbackOnKind(kind: FallbackKind): boolean {
    return kind === 'network' || kind === 'model' || kind === 'timeout' || kind === 'unavailable';
  }

  private async withRetry(
    provider: LLMProvider,
    request: LLMRequest,
    retries: number,
  ): Promise<LLMResponse> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        this.logger(`[LLM] withRetry attempt ${attempt + 1}/${retries + 1} calling ${provider.name}.generate()`);
        const res = await this.withTimeout(
          provider.generate(request),
          this.timeoutMs,
          `${provider.name}.generate`,
        );
        const preview = res.content.replaceAll('\n', ' ').slice(0, 220);
        this.logger(
          `[LLM] response success provider=${res.provider} model=${res.model} preview="${preview}"`,
        );
        return res;
      } catch (e) {
        lastError = e;
        const delayMs = this.retryDelayBaseMs * (attempt + 1);
        const kind = this.classifyProviderErrorKind(e as any);
        const errorMsg = (e as Error).message;
        this.logger(
          `[LLM] attempt ${attempt + 1} failed provider=${provider.name}: "${errorMsg}"; kind=${kind}; sleep ${delayMs}ms`,
        );
        // Retrying immediately on unavailable/model/api usually doesn't help and just burns time.
        if (kind === 'unavailable' || kind === 'model' || kind === 'api') {
          this.logger(`[LLM] not retrying kind=${kind} - breaking retry loop`);
          break;
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    const errorMsg = lastError instanceof Error ? lastError.message : String(lastError);
    this.logger(`[LLM] withRetry exhausted all attempts for ${provider.name}, throwing: "${errorMsg}"`);
    throw lastError instanceof Error
      ? lastError
      : new Error('LLM request failed');
  }

  private async withTimeout<T>(
    p: Promise<T>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    let timer: number | undefined;
    return await Promise.race([
      p.finally(() => {
        if (timer) clearTimeout(timer);
      }),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} timeout after ${timeoutMs}ms`);
          (err as any).kind = 'timeout';
          reject(err);
        }, timeoutMs);
      }),
    ]);
  }

  private classifyProviderErrorKind(err: any): FallbackKind {
    const kind = err?.kind;
    if (typeof kind === 'string') {
      if (
        kind === 'network' ||
        kind === 'model' ||
        kind === 'timeout' ||
        kind === 'api' ||
        kind === 'unavailable'
      ) {
        return kind;
      }
    }

    const msg = err?.message ? String(err.message).toLowerCase() : '';
    if (
      msg.includes('api key') ||
      msg.includes('unauthorized') ||
      msg.includes('http 401') ||
      msg.includes('403')
    )
      return 'api';
    if (msg.includes('model not found') || msg.includes('not found')) return 'model';
    if (msg.includes('timeout')) return 'timeout';
    if (
      msg.includes('network') ||
      msg.includes('failed to fetch') ||
      msg.includes('cors')
    )
      return 'network';
    if (msg.includes('prompt tokens limit exceeded')) return 'unavailable';
    return 'logic';
  }
}

