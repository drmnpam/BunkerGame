import { LLMProvider } from '../LLMProvider';
import { LLMRequest, LLMResponse } from '../types';

type ErrorKind = 'network' | 'model' | 'api' | 'unavailable';

class OpenRouterProviderError extends Error {
  kind: ErrorKind;
  status?: number;
  attemptedModel?: string;

  constructor(
    message: string,
    kind: ErrorKind,
    opts?: { status?: number; attemptedModel?: string },
  ) {
    super(message);
    this.name = 'OpenRouterProviderError';
    this.kind = kind;
    this.status = opts?.status;
    this.attemptedModel = opts?.attemptedModel;
  }
}

interface OpenRouterProviderConfig {
  baseUrl?: string;
  availableModels?: string[];
  appReferer?: string;
  appTitle?: string;
  reasoningEffort?: 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
  reasoningExclude?: boolean;
}

interface OpenRouterModelDescriptor {
  id?: string;
  name?: string;
  pricing?: {
    prompt?: string | number;
    completion?: string | number;
  };
}

export class OpenRouterProvider implements LLMProvider {
  name = 'openrouter';
  private readonly baseUrl: string;
  private readonly availableModels: string[];
  private readonly appReferer?: string;
  private readonly appTitle?: string;
  private readonly reasoningEffort: 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none';
  private readonly reasoningExclude: boolean;
  private readonly budgetCooldownMs: number;
  private readonly emptyContentCooldownMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly notFoundCooldownMs: number;
  private readonly incompatibleModelCooldownMs: number;
  private readonly modelBlockedUntil = new Map<string, number>();
  private readonly lowBudgetModeMs: number;
  private lowBudgetModeUntil = 0;
  private remoteFreeModelsCache: { models: string[]; fetchedAt: number } | null = null;
  private readonly remoteFreeModelsTtlMs = 10 * 60 * 1000;

  constructor(
    private apiKey: string,
    config?: OpenRouterProviderConfig,
  ) {
    this.apiKey =
      apiKey ||
      ((import.meta.env.VITE_OPENROUTER_API_KEY as string | undefined) ?? '');

    const envModels = import.meta.env.VITE_OPENROUTER_MODELS as string | undefined;
    this.baseUrl = config?.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.availableModels =
      config?.availableModels ??
      (envModels
        ? envModels.split(',').map((s) => s.trim()).filter(Boolean)
        : ['openrouter/auto']);
    this.appReferer =
      config?.appReferer ?? (import.meta.env.VITE_OPENROUTER_HTTP_REFERER as string | undefined);
    this.appTitle =
      config?.appTitle ?? (import.meta.env.VITE_OPENROUTER_TITLE as string | undefined);
    const envEffort = (import.meta.env.VITE_OPENROUTER_REASONING_EFFORT as string | undefined)
      ?.trim()
      .toLowerCase();
    const allowedEfforts = new Set(['xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
    this.reasoningEffort =
      config?.reasoningEffort ??
      (envEffort && allowedEfforts.has(envEffort)
        ? (envEffort as 'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none')
        : 'low');
    const envExclude = (import.meta.env.VITE_OPENROUTER_REASONING_EXCLUDE as string | undefined)
      ?.trim()
      .toLowerCase();
    this.reasoningExclude =
      config?.reasoningExclude ??
      (envExclude === undefined ? true : envExclude === '1' || envExclude === 'true');
    this.budgetCooldownMs = 10 * 60 * 1000;
    this.emptyContentCooldownMs = 3 * 60 * 1000;
    this.rateLimitCooldownMs = 60 * 1000;
    this.notFoundCooldownMs = 24 * 60 * 60 * 1000;
    this.incompatibleModelCooldownMs = 24 * 60 * 60 * 1000;
    this.lowBudgetModeMs = 15 * 60 * 1000;
  }

  async isAvailable(): Promise<boolean> {
    if (this.apiKey.trim().length === 0) return false;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(false),
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async getAvailableModels(): Promise<string[]> {
    return this.availableModels;
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new OpenRouterProviderError('OpenRouter API key is empty', 'api');
    }

    const modelsToTry = await this.resolveModelsToTry(request.model);
    if (!modelsToTry.length) {
      throw new OpenRouterProviderError('No OpenRouter models configured', 'unavailable');
    }

    let lastErr: OpenRouterProviderError | null = null;

    for (const model of modelsToTry) {
      let res: Response | null = null;
      let text = '';
      let maxTokens = Math.max(16, request.maxTokens ?? 320);

      for (let budgetAttempt = 0; budgetAttempt < 3; budgetAttempt++) {
        try {
          res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: this.buildHeaders(true),
            body: JSON.stringify({
              model,
              messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
              temperature: request.temperature ?? 0.2,
              max_tokens: maxTokens,
              reasoning: {
                effort: this.reasoningEffort,
                exclude: this.reasoningExclude,
              },
            }),
          });
        } catch (e) {
          throw new OpenRouterProviderError(
            `OpenRouter network error: ${(e as any)?.message ?? String(e)}`,
            'network',
            { attemptedModel: model },
          );
        }

        text = await res.text();
        if (res.ok) break;

        // Soft budget adaptation for low-balance accounts.
        // Example message: "You requested up to 900 tokens, but can only afford 194."
        if (res.status === 402) {
          const affordable = this.parseAffordableTokens(text);
          if (affordable !== null) {
            const nextBudget = Math.max(8, Math.min(maxTokens - 1, affordable - 8));
            if (nextBudget < maxTokens) {
              maxTokens = nextBudget;
              continue;
            }
          }
        }
        break;
      }

      if (!res) {
        throw new OpenRouterProviderError('OpenRouter request failed: empty response object', 'api', {
          attemptedModel: model,
        });
      }

      if (!res.ok) {
        const lower = text.toLowerCase();
        if (res.status === 401 || res.status === 403) {
          throw new OpenRouterProviderError(
            `OpenRouter unauthorized (HTTP ${res.status}).`,
            'api',
            { status: res.status, attemptedModel: model },
          );
        }

        if (
          res.status === 404 ||
          lower.includes('model not found') ||
          lower.includes('no such model') ||
          lower.includes('unknown model')
        ) {
          this.markModelTemporarilyBlocked(model, this.notFoundCooldownMs);
          lastErr = new OpenRouterProviderError(
            `OpenRouter model not found: ${model}.`,
            'model',
            { status: res.status, attemptedModel: model },
          );
          continue;
        }

        if (res.status === 429) {
          this.markModelTemporarilyBlocked(model, this.rateLimitCooldownMs);
          lastErr = new OpenRouterProviderError(
            `OpenRouter rate-limited (HTTP 429).`,
            'unavailable',
            { status: res.status, attemptedModel: model },
          );
          continue;
        }

        if (res.status === 402 && this.isBudgetError(lower)) {
          this.enterLowBudgetMode();
          this.markModelTemporarilyBlocked(model, this.budgetCooldownMs);
          lastErr = new OpenRouterProviderError(
            `OpenRouter budget insufficient for model ${model}.`,
            'unavailable',
            { status: res.status, attemptedModel: model },
          );
          continue;
        }

        if (res.status === 400 && this.isDeveloperInstructionUnsupported(lower)) {
          this.markModelTemporarilyBlocked(model, this.incompatibleModelCooldownMs);
          lastErr = new OpenRouterProviderError(
            `OpenRouter model incompatible with developer instructions: ${model}.`,
            'model',
            { status: res.status, attemptedModel: model },
          );
          continue;
        }

        throw new OpenRouterProviderError(
          `OpenRouter API error (HTTP ${res.status}): ${text}`,
          'api',
          { status: res.status, attemptedModel: model },
        );
      }

      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new OpenRouterProviderError(
          'Invalid OpenRouter response JSON',
          'api',
          { attemptedModel: model },
        );
      }

      const content = this.extractContent(json);
      if (!content) {
        // Some reasoning-heavy models occasionally return only reasoning with empty content.
        // Treat this as temporary provider/model unavailability and try next configured model.
        this.markModelTemporarilyBlocked(model, this.emptyContentCooldownMs);
        lastErr = new OpenRouterProviderError(
          'OpenRouter returned empty content',
          'unavailable',
          { attemptedModel: model },
        );
        continue;
      }

      return {
        provider: this.name,
        model,
        content,
        raw: json,
      };
    }

    if (lastErr) throw lastErr;
    throw new OpenRouterProviderError('OpenRouter request failed', 'api');
  }

  private extractContent(json: any): string {
    const msg = json?.choices?.[0]?.message;
    const rawContent = msg?.content;

    if (typeof rawContent === 'string') {
      const v = rawContent.trim();
      if (v) return v;
    }

    if (Array.isArray(rawContent)) {
      const joined = rawContent
        .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim();
      if (joined) return joined;
    }

    return '';
  }

  private async resolveModelsToTry(requestedModel?: string): Promise<string[]> {
    const configured = Array.from(
      new Set(this.availableModels.map((s) => s.trim()).filter(Boolean)),
    );
    const remoteFree = await this.getRemoteFreeModels();
    const mergedConfigured = Array.from(new Set([...configured, ...remoteFree]));
    if (!mergedConfigured.length) return [];

    const requested = requestedModel?.trim();
    // "auto" (from planner/UI default) means "use configured priority order".
    const normalizedRequested =
      requested && requested !== 'auto' ? requested : undefined;

    const now = Date.now();
    const lowBudgetModeActive = now < this.lowBudgetModeUntil;
    const augmentedPool = this.augmentWithBuiltInFreeModels(mergedConfigured);
    const budgetAwarePool = lowBudgetModeActive
      ? this.filterFreeSafeModels(augmentedPool)
      : augmentedPool;
    const eligibleConfigured = mergedConfigured.filter((model) => {
      const blockedUntil = this.modelBlockedUntil.get(model) ?? 0;
      return blockedUntil <= now;
    });
    const eligibleBudgetAware = budgetAwarePool.filter((model) => {
      const blockedUntil = this.modelBlockedUntil.get(model) ?? 0;
      return blockedUntil <= now;
    });
    const basePool = lowBudgetModeActive
      ? (eligibleBudgetAware.length ? eligibleBudgetAware : budgetAwarePool)
      : (eligibleBudgetAware.length
        ? eligibleBudgetAware
        : (eligibleConfigured.length ? eligibleConfigured : budgetAwarePool));
    const prioritized = this.prioritizeModels(basePool);

    const ordered: string[] = [];
    if (normalizedRequested && prioritized.includes(normalizedRequested)) {
      ordered.push(normalizedRequested);
    }
    for (const model of prioritized) {
      if (!ordered.includes(model)) ordered.push(model);
    }
    return ordered;
  }

  private parseAffordableTokens(errorBody: string): number | null {
    const m = errorBody.match(/can only afford\s+(\d+)/i);
    if (!m) return null;
    const parsed = Number(m[1]);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  }

  private isBudgetError(lowerBody: string): boolean {
    return (
      lowerBody.includes('can only afford') ||
      lowerBody.includes('requires more credits') ||
      lowerBody.includes('fewer max_tokens') ||
      lowerBody.includes('prompt tokens limit exceeded')
    );
  }

  private isDeveloperInstructionUnsupported(lowerBody: string): boolean {
    return (
      lowerBody.includes('developer instruction is not enabled') ||
      lowerBody.includes('developer instructions are not enabled')
    );
  }

  private prioritizeModels(models: string[]): string[] {
    return [...models].sort((a, b) => this.modelScore(b) - this.modelScore(a));
  }

  private modelScore(model: string): number {
    const m = model.toLowerCase();
    if (m === 'openrouter/auto') return -10000;
    if (!m.endsWith(':free')) return -5000;

    let score = 0;
    score += this.extractModelSizeScore(m);

    if (m.includes('gpt') || m.includes('claude') || m.includes('gemini')) score += 120;
    if (m.includes('llama') || m.includes('mistral') || m.includes('qwen')) score += 90;
    if (m.includes('hermes') || m.includes('nous')) score += 70;
    if (m.includes('instruct') || m.includes('chat')) score += 25;
    if (m.includes('coder')) score -= 10;
    if (m.includes('mini') || m.includes('small')) score -= 20;
    if (m.includes('3b') || m.includes('4b')) score -= 15;

    return score;
  }

  private markModelTemporarilyBlocked(model: string, cooldownMs: number) {
    this.modelBlockedUntil.set(model, Date.now() + cooldownMs);
  }

  private enterLowBudgetMode() {
    this.lowBudgetModeUntil = Date.now() + this.lowBudgetModeMs;
  }

  private filterFreeSafeModels(models: string[]): string[] {
    return models.filter((model) => {
      const m = model.toLowerCase();
      if (m === 'openrouter/auto') return false;
      return m.endsWith(':free');
    });
  }

  private augmentWithBuiltInFreeModels(models: string[]): string[] {
    const fallbackFree = [
      'stepfun/step-3.5-flash:free',
      'qwen/qwen3-4b:free',
      'google/gemma-3-4b-it:free',
      'meta-llama/llama-3.2-3b-instruct:free',
    ];
    const merged = [...models];
    for (const candidate of fallbackFree) {
      if (!merged.includes(candidate)) merged.push(candidate);
    }
    return merged;
  }

  private extractModelSizeScore(modelId: string): number {
    const match = modelId.match(/(\d+(?:\.\d+)?)b\b/i);
    if (!match) return 0;
    const size = Number(match[1]);
    if (!Number.isFinite(size)) return 0;
    return Math.round(size * 10);
  }

  private async getRemoteFreeModels(): Promise<string[]> {
    const now = Date.now();
    if (this.remoteFreeModelsCache && now - this.remoteFreeModelsCache.fetchedAt < this.remoteFreeModelsTtlMs) {
      return this.remoteFreeModelsCache.models;
    }

    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(false),
      });
      if (!res.ok) return this.remoteFreeModelsCache?.models ?? [];
      const json = await res.json();
      const free = this.extractFreeModelIds(json);
      this.remoteFreeModelsCache = { models: free, fetchedAt: now };
      return free;
    } catch {
      return this.remoteFreeModelsCache?.models ?? [];
    }
  }

  private extractFreeModelIds(payload: any): string[] {
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const out: string[] = [];
    for (const item of data as OpenRouterModelDescriptor[]) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (!id) continue;
      if (id.toLowerCase().endsWith(':free')) {
        out.push(id);
        continue;
      }

      const p = item?.pricing;
      const promptZero = p && (p.prompt === '0' || p.prompt === 0 || p.prompt === '0.0' || p.prompt === '0.00');
      const completionZero =
        p && (p.completion === '0' || p.completion === 0 || p.completion === '0.0' || p.completion === '0.00');
      if (promptZero && completionZero) out.push(id);
    }
    return Array.from(new Set(out));
  }

  private buildHeaders(includeContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (includeContentType) headers['Content-Type'] = 'application/json';
    if (this.appReferer) headers['HTTP-Referer'] = this.appReferer;
    if (this.appTitle) {
      headers['X-OpenRouter-Title'] = this.appTitle;
      headers['X-Title'] = this.appTitle;
    }
    return headers;
  }
}
