import { LLMManager } from '../llm/LLMManager';
import { BrowserAction } from '../execution/ActionTypes';
import { extractFirstJsonObject } from '../utils/json';
import { ToolCall, toolCallSchema } from './toolCallSchema';

export class TaskPlanner {
  constructor(
    private llm: LLMManager,
    private model: string,
  ) {}

  async parseUserIntent(taskText: string): Promise<string> {
    // MVP: пока используем задачу как есть.
    return taskText;
  }

  private readonly TOOL_SYSTEM_PROMPT = `Ты — агент автоматизации браузера через MCP/Kapture.

Ты вызываешь ИМЕННО ОДНУ следующую операцию за раз (tool call).

ТВОЯ ЗАДАЧА:
- по задаче пользователя и текущему контексту выбрать следующий tool call
- либо завершить работу (status="done")

ВАЖНО:
- Верни ТОЛЬКО валидный JSON-ОБЪЕКТ (без markdown, без комментариев, без текста вокруг).
- Никаких массивов.
- Не используй обертки "tool_code", "tool_call", "next_action" или вложенный объект "action".
- Поле "action" должно быть строкой из: open_url | click | type | wait | extract | screenshot.

TOOLS (allowed actions):
- open_url: { action:"open_url", value:"https://...", description:"..." }
- click: { action:"click", selector:"#login", description:"..." }
- type: { action:"type", selector:"#email", value:"text", description:"..." }
- wait: { action:"wait", waitMs: 1000, description:"..." }
- extract: { action:"extract", selector:".item", extractStrategy:"inner_text", description:"..." }
- screenshot: { action:"screenshot", description:"..." }

Обязательные поля:
- status: "continue" или "done"
- description: непустая строка

Если status="done":
- finalResult: строка (что удалось получить/сделать)
`;

  async generateNextToolCall(params: {
    taskText: string;
    actionsSoFar: BrowserAction[];
    lastObservation: any;
    lastErrorMessage: string | null;
    stepIndex: number;
    maxSteps: number;
  }): Promise<ToolCall> {
    const intent = await this.parseUserIntent(params.taskText);
    const fullUserPrompt =
      `TASK:\n${intent}\n\n` +
      `ACTIONS_SO_FAR (executed so far):\n${JSON.stringify(params.actionsSoFar, null, 2)}\n\n` +
      `LAST_OBSERVATION (result from MCP for the last step; may be large):\n${this.safeStringify(params.lastObservation)}\n\n` +
      `LAST_ERROR (if previous MCP/action failed):\n${params.lastErrorMessage ? params.lastErrorMessage : 'none'}\n\n` +
      `Now choose the NEXT tool call. You must return JSON with either status="continue" or status="done".\n` +
      `If the goal is already sufficiently achieved, or further automation is blocked by auth/captcha/permissions/uncertain selectors, return status="done" with finalResult.\n` +
      `stepIndex=${params.stepIndex} maxSteps=${params.maxSteps}`;

    let response;
    try {
      response = await this.llm.generate({
        model: this.model,
        temperature: 0.2,
        maxTokens: 260,
        messages: [
          { role: 'system', content: this.TOOL_SYSTEM_PROMPT },
          { role: 'user', content: fullUserPrompt },
        ],
      });
    } catch (e) {
      if (!this.isPromptBudgetError(e)) throw e;
      response = await this.llm.generate({
        model: this.model,
        temperature: 0.2,
        maxTokens: 180,
        messages: [
          { role: 'system', content: this.TOOL_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `TASK:\n${intent}\n` +
              `stepIndex=${params.stepIndex} maxSteps=${params.maxSteps}\n` +
              `LAST_ERROR:\n${params.lastErrorMessage ? params.lastErrorMessage : 'none'}\n` +
              `LAST_ACTIONS_TAIL:\n${this.actionsTail(params.actionsSoFar, 3)}\n` +
              `LAST_OBSERVATION_SHORT:\n${this.safeStringify(params.lastObservation, 420)}\n` +
              `Return ONLY one valid JSON object.`,
          },
        ],
      });
    }

    return this.parseToolCallOrThrow(response.content, 'generateNextToolCall');
  }

  async selfCorrectToolCall(params: {
    taskText: string;
    actionsSoFar: BrowserAction[];
    lastObservation: any;
    lastErrorMessage: string | null;
    stepIndex: number;
    maxSteps: number;
    rawModelOutput: string;
    parseErrorMessage: string;
  }): Promise<ToolCall> {
    const intent = await this.parseUserIntent(params.taskText);
    const fullUserPrompt =
      `You returned invalid JSON for the tool call.\n` +
      `TASK:\n${intent}\n\n` +
      `ACTIONS_SO_FAR:\n${JSON.stringify(params.actionsSoFar, null, 2)}\n\n` +
      `LAST_OBSERVATION:\n${this.safeStringify(params.lastObservation)}\n\n` +
      `LAST_ERROR:\n${params.lastErrorMessage ? params.lastErrorMessage : 'none'}\n\n` +
      `INVALID_OUTPUT:\n${params.rawModelOutput}\n\n` +
      `PARSE_ERROR:\n${params.parseErrorMessage}\n\n` +
      `Return ONLY a corrected JSON object that matches the schema.`;

    let response;
    try {
      response = await this.llm.generate({
        model: this.model,
        temperature: 0.2,
        maxTokens: 220,
        messages: [
          {
            role: 'system',
            content: this.TOOL_SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: fullUserPrompt,
          },
        ],
      });
    } catch (e) {
      if (!this.isPromptBudgetError(e)) throw e;
      response = await this.llm.generate({
        model: this.model,
        temperature: 0.2,
        maxTokens: 170,
        messages: [
          { role: 'system', content: this.TOOL_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `Invalid JSON. Return corrected JSON object only.\n` +
              `TASK:\n${intent}\n` +
              `LAST_ERROR:${params.lastErrorMessage ? params.lastErrorMessage : 'none'}\n` +
              `PARSE_ERROR:${params.parseErrorMessage}\n` +
              `INVALID_OUTPUT_SHORT:\n${this.safeStringify(params.rawModelOutput, 300)}`,
          },
        ],
      });
    }

    return this.parseToolCallOrThrow(response.content, 'selfCorrectToolCall');
  }

  private safeStringify(v: any, maxLen = 1800) {
    try {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
    } catch {
      return String(v);
    }
  }

  private actionsTail(actions: BrowserAction[], count: number): string {
    const tail = actions.slice(Math.max(0, actions.length - count));
    return this.safeStringify(tail, 350);
  }

  private isPromptBudgetError(err: unknown): boolean {
    const message = (err as any)?.message;
    if (!message || typeof message !== 'string') return false;
    const lower = message.toLowerCase();
    return (
      lower.includes('prompt tokens limit exceeded') ||
      lower.includes('requires more credits') ||
      lower.includes('fewer max_tokens') ||
      lower.includes('can only afford')
    );
  }

  private parseToolCallOrThrow(raw: string, origin: string): ToolCall {
    try {
      const obj = extractFirstJsonObject(raw);
      const normalized = this.normalizeToolCallShape(obj);
      return toolCallSchema.parse(normalized);
    } catch (e) {
      const repaired = this.tryHeuristicToolCallRepair(raw);
      if (repaired) {
        return repaired;
      }
      const err = e as Error;
      const parseErrorMessage = `${origin}: invalid tool call JSON: ${err.message}`;
      (err as any).rawModelOutput = raw;
      throw err;
    }
  }

  private tryHeuristicToolCallRepair(raw: string): ToolCall | null {
    const action = this.pickStringField(raw, 'action');
    const status = this.pickStringField(raw, 'status') ?? (action ? 'continue' : undefined);
    if (!status) return null;

    if (status === 'done') {
      const finalResult = this.pickStringField(raw, 'finalResult');
      const description =
        this.pickStringField(raw, 'description') ??
        finalResult ??
        'Task finished';
      try {
        return toolCallSchema.parse({
          status: 'done',
          description,
          finalResult: finalResult ?? undefined,
        });
      } catch {
        return null;
      }
    }

    if (!action) return null;
    const normalizedAction = this.normalizeActionName(action);
    const repaired: Record<string, any> = {
      status: 'continue',
      action: normalizedAction,
      description: this.pickStringField(raw, 'description') ?? `Fallback parsed action: ${normalizedAction}`,
    };

    const value = this.pickStringField(raw, 'value') ?? this.pickStringField(raw, 'url');
    const selector = this.pickStringField(raw, 'selector');
    const waitMs = this.pickNumberField(raw, 'waitMs');
    const extractStrategy = this.pickStringField(raw, 'extractStrategy');

    if (value) repaired.value = value;
    if (selector) repaired.selector = selector;
    if (typeof waitMs === 'number') repaired.waitMs = waitMs;
    if (extractStrategy) repaired.extractStrategy = extractStrategy;

    if (normalizedAction === 'open_url' && !repaired.value) {
      repaired.value = 'https://hh.ru/';
    }
    if (normalizedAction === 'wait' && !repaired.waitMs) {
      repaired.waitMs = 1000;
    }
    if ((normalizedAction === 'click' || normalizedAction === 'type' || normalizedAction === 'extract') && !repaired.selector) {
      return null;
    }
    if (normalizedAction === 'type' && !repaired.value) {
      return null;
    }

    try {
      return toolCallSchema.parse(repaired);
    } catch {
      return null;
    }
  }

  private pickStringField(text: string, field: string): string | undefined {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`"${escapedField}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"`, 'i');
    const m = text.match(re);
    if (!m?.[1]) return undefined;
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  }

  private pickNumberField(text: string, field: string): number | undefined {
    const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`"${escapedField}"\\s*:\\s*(\\d+)`, 'i');
    const m = text.match(re);
    if (!m?.[1]) return undefined;
    const v = Number(m[1]);
    if (!Number.isFinite(v)) return undefined;
    return Math.floor(v);
  }

  private normalizeToolCallShape(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;

    const unwrapKeys = ['tool_code', 'tool_call', 'next_action', 'nextAction', 'step', 'operation'];
    for (const key of unwrapKeys) {
      if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
        obj = {
          ...obj,
          ...obj[key],
        };
      }
    }

    // Some models wrap action payload into nested shape:
    // { status:"continue", description:"...", action: { action:"open_url", value:"..." } }
    if (
      obj.action &&
      typeof obj.action === 'object' &&
      !Array.isArray(obj.action)
    ) {
      const nested = obj.action;
      obj = {
        ...obj,
        ...nested,
        action: nested.action ?? obj.action,
        description: obj.description ?? nested.description ?? '',
      };
    }

    if (typeof obj.action === 'string') {
      obj.action = this.normalizeActionName(obj.action);
    }

    // If model returned done without description, synthesize it from finalResult.
    if (obj.status === 'done') {
      if (!obj.description || typeof obj.description !== 'string' || obj.description.trim().length === 0) {
        const fallbackDesc =
          typeof obj.finalResult === 'string' && obj.finalResult.trim().length > 0
            ? obj.finalResult
            : 'Task finished';
        obj = {
          ...obj,
          description: fallbackDesc,
        };
      }
      return obj;
    }

    // If model omitted/blank/unknown status but returned action payload, default to continue.
    if (
      (!obj.status || (obj.status !== 'continue' && obj.status !== 'done')) &&
      (typeof obj.action === 'string' || (obj.action && typeof obj.action === 'object'))
    ) {
      obj = {
        ...obj,
        status: 'continue',
      };
    }

    return obj;
  }

  private normalizeActionName(action: string): string {
    const normalized = action.trim().toLowerCase();
    const map: Record<string, string> = {
      open: 'open_url',
      openurl: 'open_url',
      navigate: 'open_url',
      goto: 'open_url',
      input: 'type',
      fill: 'type',
      type_text: 'type',
      write: 'type',
      delay: 'wait',
      sleep: 'wait',
      wait_for: 'wait',
      read: 'extract',
      scrape: 'extract',
      snapshot: 'screenshot',
      screen: 'screenshot',
      capture: 'screenshot',
    };

    return map[normalized] ?? normalized;
  }
}

