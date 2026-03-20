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
    // MVP: use task text as-is.
    return taskText;
  }

  private readonly TOOL_SYSTEM_PROMPT = `You are a browser automation agent using MCP/Kapture.

Return exactly ONE valid JSON object and nothing else.

Rules:
- No markdown.
- No arrays.
- No wrapper fields like "tool_code", "tool_call", "next_action".
- Field "action" must be one of: open_url | click | type | wait | extract | screenshot | press_key | scroll | drag_drop | copy | paste | mcp_tool.
- "status" is required: "continue" or "done".
- "description" is required and must be a non-empty string.
- For status="done", include "finalResult" with concrete findings and user-visible outcome.
- Do not repeat the same failing selector or identical action payload.
- If a selector is uncertain, prefer extract with selector "body" and extractStrategy "inner_text".
- extractStrategy can only be: inner_text | html | attribute.
- Use mcp_tool only for advanced interaction when standard actions are insufficient.

Action shapes:
- open_url: { "status":"continue", "action":"open_url", "value":"https://...", "description":"..." }
- click: { "status":"continue", "action":"click", "selector":"...", "description":"..." }
- type: { "status":"continue", "action":"type", "selector":"...", "value":"...", "description":"..." }
- wait: { "status":"continue", "action":"wait", "waitMs":1000, "description":"..." }
- extract: { "status":"continue", "action":"extract", "selector":"body", "extractStrategy":"inner_text", "description":"..." }
- screenshot: { "status":"continue", "action":"screenshot", "description":"..." }
- press_key: { "status":"continue", "action":"press_key", "key":"Enter", "description":"..." }
- scroll: { "status":"continue", "action":"scroll", "direction":"down", "deltaY":700, "description":"..." }
- drag_drop: { "status":"continue", "action":"drag_drop", "sourceSelector":"...", "targetSelector":"...", "description":"..." }
- copy: { "status":"continue", "action":"copy", "selector":"...", "description":"..." }
- paste: { "status":"continue", "action":"paste", "selector":"...", "value":"...", "description":"..." }
- mcp_tool: { "status":"continue", "action":"mcp_tool", "toolName":"...", "toolArgs":{}, "description":"..." }

Use status="done" only when enough information is gathered or a user-visible result is completed.`;

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
      `ACTIONS_TAIL:\n${this.actionsTail(params.actionsSoFar, 8)}\n\n` +
      `LAST_OBSERVATION_SUMMARY:\n${this.summarizeObservation(params.lastObservation)}\n\n` +
      `LAST_ERROR:\n${params.lastErrorMessage ? params.lastErrorMessage : 'none'}\n\n` +
      `Now choose NEXT tool call. Return only one JSON object.\n` +
      `Avoid repeated failing selectors.\n` +
      `If blocked or objective achieved, return status="done" with finalResult describing exactly what was achieved.\n` +
      `stepIndex=${params.stepIndex} maxSteps=${params.maxSteps}`;

    let response;
    try {
      response = await this.llm.generate({
        model: this.model,
        temperature: 0.2,
        maxTokens: 220,
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
        maxTokens: 160,
        messages: [
          { role: 'system', content: this.TOOL_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `TASK:\n${intent}\n` +
              `stepIndex=${params.stepIndex} maxSteps=${params.maxSteps}\n` +
              `LAST_ERROR:\n${params.lastErrorMessage ? params.lastErrorMessage : 'none'}\n` +
              `LAST_ACTIONS_TAIL:\n${this.actionsTail(params.actionsSoFar, 5)}\n` +
              `LAST_OBSERVATION_SHORT:\n${this.summarizeObservation(params.lastObservation, 420)}\n` +
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
      `ACTIONS_TAIL:\n${this.actionsTail(params.actionsSoFar, 6)}\n\n` +
      `LAST_OBSERVATION_SUMMARY:\n${this.summarizeObservation(params.lastObservation)}\n\n` +
      `LAST_ERROR:\n${params.lastErrorMessage ? params.lastErrorMessage : 'none'}\n\n` +
      `INVALID_OUTPUT:\n${this.safeStringify(params.rawModelOutput, 700)}\n\n` +
      `PARSE_ERROR:\n${params.parseErrorMessage}\n\n` +
      `Return ONLY corrected JSON object that matches schema.`;

    let response;
    try {
      response = await this.llm.generate({
        model: this.model,
        temperature: 0.2,
        maxTokens: 180,
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
        maxTokens: 150,
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
    const start = Math.max(0, actions.length - count);
    const tail = actions.slice(start).map((a, i) => ({
      i: start + i + 1,
      action: a.action,
      selector: a.selector,
      value: typeof a.value === 'string' ? this.trimInline(a.value, 80) : undefined,
      description: this.trimInline(a.description, 120),
    }));
    return this.safeStringify(tail, 600);
  }

  private summarizeObservation(v: any, maxLen = 1200) {
    try {
      if (v == null) return 'null';
      if (typeof v === 'string') return this.trimInline(v, maxLen);
      const summary: Record<string, any> = {};
      for (const key of ['success', 'url', 'title', 'selector', 'warning', 'message', 'error']) {
        if (v[key] != null) summary[key] = v[key];
      }
      if (typeof v.text === 'string') summary.text = this.trimInline(v.text, 220);
      if (typeof v.html === 'string') summary.html = this.trimInline(v.html, 220);
      if (typeof v.preview === 'string') summary.preview = v.preview;
      const base = Object.keys(summary).length ? summary : v;
      return this.safeStringify(base, maxLen);
    } catch {
      return this.safeStringify(v, maxLen);
    }
  }

  private trimInline(value: string, max: number) {
    const compact = value.replace(/\s+/g, ' ').trim();
    if (compact.length <= max) return compact;
    return `${compact.slice(0, max)}...`;
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
      (err as any).parseErrorMessage = parseErrorMessage;
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
    const key = this.pickStringField(raw, 'key');
    const sourceSelector = this.pickStringField(raw, 'sourceSelector');
    const targetSelector = this.pickStringField(raw, 'targetSelector');
    const toolName = this.pickStringField(raw, 'toolName');

    if (value) repaired.value = value;
    if (selector) repaired.selector = selector;
    if (typeof waitMs === 'number') repaired.waitMs = waitMs;
    if (extractStrategy) repaired.extractStrategy = extractStrategy;
    if (key) repaired.key = key;
    if (sourceSelector) repaired.sourceSelector = sourceSelector;
    if (targetSelector) repaired.targetSelector = targetSelector;
    if (toolName) repaired.toolName = toolName;

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
    if (normalizedAction === 'press_key' && !repaired.key) {
      return null;
    }
    if (normalizedAction === 'drag_drop' && (!repaired.sourceSelector || !repaired.targetSelector)) {
      return null;
    }
    if (normalizedAction === 'paste' && !repaired.selector) {
      return null;
    }
    if (normalizedAction === 'mcp_tool' && !repaired.toolName) {
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

    // Some models wrap action payload into nested shape.
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
      keypress: 'press_key',
      press: 'press_key',
      scrollby: 'scroll',
      dragdrop: 'drag_drop',
      copy_text: 'copy',
      paste_text: 'paste',
      tool: 'mcp_tool',
    };

    return map[normalized] ?? normalized;
  }
}
