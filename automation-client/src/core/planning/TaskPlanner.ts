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

  private readonly TOOL_SYSTEM_PROMPT = `You are a browser automation agent using MCP/Kapture for universal cross-site interaction.

CRITICAL: Return exactly ONE valid JSON object and nothing else. No markdown, no explanation.

═══════════════════════════════════════════════════════════════════════════════
UNIVERSAL SELECTOR PRIORITY (MUST follow this order):
═══════════════════════════════════════════════════════════════════════════════
1. [data-qa*="keyword"] - most portable across variations
2. [data-testid*="keyword"] - React/modern apps
3. [aria-label*="keyword"] - accessible labels
4. input[type="text"], button[type="submit"], etc - semantic HTML
5. [role="button"], [role="searchbox"] - WAI-ARIA roles
6. Small CSS class selectors [class*="keyword"]
7. LAST RESORT: nested selectors with careful structure

NEVER USE THESE (instant fail):
✗ #specific-ids (site-specific, won't generalize)
✗ nth-child(), nth-of-type() (fragile HTML structure)
✗ .class-with-site-hash (site-specific)
✗ > div > div > div chains (unmaintainable)

═══════════════════════════════════════════════════════════════════════════════
ERROR RECOVERY STRATEGIES (CRITICAL):
═══════════════════════════════════════════════════════════════════════════════

When you get "Element is not fillable: button" error:
→ The button is NOT an input field. DO NOT try type again.
→ Action: Look for nearby input[type="text"] or search field and target that.
→ Use extract first to find the actual input field location.

When you get "Selector not found" error:
→ DO NOT repeat the same selector.
→ Action: Use extract with body to understand page, then try completely different selector.

When stuck in similar extract loops:
→ You are gathering the same info repeatedly - STOP and ACT on what you know.
→ Action: Use click on element you found, or scroll to new section, or press_key.

When repeated actions fail (3+ in row):
→ Your strategy is wrong. Change approach entirely.
→ Action: Extract a DIFFERENT part of page (not body), or scroll, or try new selector pattern.

═══════════════════════════════════════════════════════════════════════════════
SPECIFIC STRATEGIES FOR COMMON SITES:
═══════════════════════════════════════════════════════════════════════════════

**For HH.ru (Russian job site):**
- Search input: look for [data-qa*="search"] or input[role="searchbox"]
- Vacancy list: [data-qa*="vacancy"], [data-qa*="vacancy-item"]
- Apply button: [data-qa*="apply"], [data-qa*="respond"]

**For LinkedIn:**
- Search: [data-testid*="search"] or input with aria-label
- Jobs list: articles with data-job-id or [class*="jobs"]
- Apply: button with "Apply" or "Easy Apply" text

**For Indeed:**
- Search input: input[id*="search"] or [aria-label*="job"]
- Listings: [data-testid*="job"], div[id*="job_"]
- Apply: button containing "Apply"

**For Glassdoor:**
- Search: input[placeholder*="job"] or [data-test*="search"]
- Jobs: [data-test*="jobCard"]
- Apply: button with "Apply"

═══════════════════════════════════════════════════════════════════════════════
DECISION TREE - WHAT TO DO NEXT:
═══════════════════════════════════════════════════════════════════════════════

1. Did last action FAIL? (error returned)
   → Is it "not fillable"? → Find input field instead (extract if needed)
   → Is it "not found"? → Extract body to understand structure
   → Other error? → Extract or scroll to find correct element

2. Did last action SUCCEED?
   → Did page change? → Extract to understand new content
   → No change? → Try next step OR extract to see if hidden content
   → Task complete? → status="done"

3. Are you repeating similar actions?
   → Do you have the info you need? → ACT on it (click, type, etc)
   → Do NOT keep extracting the same selector
   → Try scrolling, pressing keys, or clicking different elements

═══════════════════════════════════════════════════════════════════════════════
CORE ACTION RULES:
═══════════════════════════════════════════════════════════════════════════════

✅ ALWAYS include these in response:
   "status": "continue" | "done" (required)
   "action": "click" | "type" | "extract" | "press_key" | ... (required)
   "description": "human readable what you're doing" (required, non-empty)

✅ For action types:
   - click: needs |selector|
   - type: needs both |selector| and |value|
   - extract: needs |selector| and |extractStrategy| (inner_text, html, or attribute)
   - wait: needs |waitMs|
   - press_key: needs |key| (Enter, Tab, Escape, etc)
   - scroll: needs |direction| (up/down/left/right) and |deltaY| or |deltaX|
   - open_url: needs |value| (URL)

✅ Status rules:
   - "continue" → more steps needed
   - "done" → task finished, include |finalResult| field explaining outcome

VALID ACTION EXAMPLES:
{"status":"continue","action":"click","selector":"[data-qa*=\\"search-button\\"]","description":"Click search to find jobs"}
{"status":"continue","action":"type","selector":"input[type=\\"text\\"]","value":"Project Manager","description":"Enter job title"}
{"status":"continue","action":"extract","selector":"body","extractStrategy":"inner_text","description":"Understand page structure"}
{"status":"done","description":"Task complete","finalResult":"Applied to 5 jobs successfully"}

═══════════════════════════════════════════════════════════════════════════════
WHEN TO USE status="done" (IMPORTANT):
═══════════════════════════════════════════════════════════════════════════════

Use status="done" in these cases:
- Task objective achieved or mostly achieved (forms filled, jobs applied to, info found)
- Page blocked by authentication, CAPTCHA, or network error (can't proceed)
- Same error repeated 3+ times despite trying different selectors
- Extracted page content shows task is impossible (wrong site, no matching elements)
- Stuck in loop with no forward progress visible

DO NOT use status="done" just because of one failed action.
DO try: new selector patterns, keyboard shortcuts, scrolling, waiting.

═══════════════════════════════════════════════════════════════════════════════`;

  async generateNextToolCall(params: {
    taskText: string;
    actionsSoFar: BrowserAction[];
    lastObservation: any;
    lastErrorMessage: string | null;
    stepIndex: number;
    maxSteps: number;
  }): Promise<ToolCall> {
    const intent = await this.parseUserIntent(params.taskText);
    const loopDetection = this.detectLoopedActions(params.actionsSoFar);
    
    // Add special context for common errors
    let errorContext = '';
    if (params.lastErrorMessage) {
      if (params.lastErrorMessage.includes('not fillable')) {
        errorContext = `⚠️ CRITICAL ERROR: Element is NOT fillable (last tried: ${params.actionsSoFar[params.actionsSoFar.length - 1]?.selector || 'unknown'})
→ The selector found a button, link, or div - NOT an input field
→ IMMEDIATELY search for actual text input: input[type="text"], textarea, [role="searchbox"], [aria-label*="search"]
→ OR click on an element near the unfillable one to reveal hidden input
→ DO NOT try same selector again - it will fail again!\n\n`;
      } else if (params.lastErrorMessage.includes('not found')) {
        errorContext = `⚠️ ERROR: Selector didn't find any element.
→ The selector pattern doesn't match anything on this page
→ Use extract with HTML strategy to see ALL elements
→ Try completely different attribute: look for aria-label, role, class patterns
→ DO NOT use same selector again\n\n`;
      } else if (params.lastErrorMessage.includes('Loop detected') || params.lastErrorMessage.includes('loop')) {
        errorContext = `⚠️ LOOP DETECTED: You're repeating actions that don't advance
→ If extract body doesn't change, use extract with HTML strategy instead
→ If same selector fails: click different elements or scroll
→ Try NEW strategies: keyboard shortcuts (Tab, Enter), scroll up/down, look for alternative elements
→ If stuck 3+ steps, consider task impossible and use status="done"\n\n`;
      }
    }
    
    const fullUserPrompt =
      `TASK:\n${intent}\n\n` +
      `ACTIONS_TAIL:\n${this.actionsTail(params.actionsSoFar, 8)}\n\n` +
      `LAST_OBSERVATION_SUMMARY:\n${this.summarizeObservation(params.lastObservation)}\n\n` +
      `LAST_ERROR:\n${params.lastErrorMessage ? params.lastErrorMessage : 'none'}\n` +
      (errorContext ? `${errorContext}\n` : '\n') +
      (loopDetection.isLooped ? `⚠️ WARNING: You are in a LOOP - "${loopDetection.failedSelector}" repeated ${loopDetection.count} times.\nIMEDIATELY switch strategy: try different selector OR use extract to understand page structure.\n\n` : '') +
      `Now choose NEXT tool call. Return only one JSON object.\n` +
      `${loopDetection.isLooped ? '🔄 BREAK THE LOOP: Use extract with body selector or choose a completely different selector.\n' : 'Avoid repeated failing selectors.\n'}` +
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
              (params.lastErrorMessage?.includes('not fillable') ? `CRITICAL: Not fillable element. Switch to: input[type="text"], [role="searchbox"], textarea.\n` : '') +
              (loopDetection.isLooped ? `URGENT LOOP: "${loopDetection.failedSelector}" repeated ${loopDetection.count}x - try DIFFERENT approach NOW.\n` : '') +
              `LAST_ACTIONS:\n${this.actionsTail(params.actionsSoFar, 4)}\n` +
              `Return JSON only.`,
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
    const loopDetection = this.detectLoopedActions(params.actionsSoFar);
    const fullUserPrompt =
      `You returned invalid JSON for the tool call.\n` +
      `TASK:\n${intent}\n\n` +
      `ACTIONS_TAIL:\n${this.actionsTail(params.actionsSoFar, 6)}\n\n` +
      `LAST_OBSERVATION_SUMMARY:\n${this.summarizeObservation(params.lastObservation)}\n\n` +
      `LAST_ERROR:\n${params.lastErrorMessage ? params.lastErrorMessage : 'none'}\n\n` +
      (loopDetection.isLooped ? `⚠️ LOOP DETECTED: Selector "${loopDetection.failedSelector}" failed ${loopDetection.count} times. Use extract or change selector.\n\n` : '') +
      `INVALID_OUTPUT:\n${this.safeStringify(params.rawModelOutput, 700)}\n\n` +
      `PARSE_ERROR:\n${params.parseErrorMessage}\n\n` +
      `Return ONLY corrected JSON object that matches schema. ${loopDetection.isLooped ? 'Break the loop!' : ''}`;

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
              (loopDetection.isLooped ? `LOOP: "${loopDetection.failedSelector}" failed ${loopDetection.count}x - use extract or new selector.\n` : '') +
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

  private detectLoopedActions(actions: BrowserAction[]): { isLooped: boolean; failedSelector?: string; count: number } {
    if (actions.length < 2) return { isLooped: false, count: 0 };
    
    // Check last 15 actions for patterns
    const recentActions = actions.slice(-15);
    
    // Count by action TYPE - detect extract spam earlier
    const extractCount = recentActions.filter(a => a.action === 'extract').length;
    if (extractCount >= 5) {
      // 5+ extracts in last 15 actions = likely stuck extracting
      return { 
        isLooped: true, 
        failedSelector: 'extract-spam',
        count: extractCount 
      };
    }
    
    // Also check for individual selector repetition (more aggressive: 2+ instead of 3+)
    const selectorCounts = new Map<string, number>();
    for (const action of recentActions) {
      if ((action.action === 'click' || action.action === 'type' || action.action === 'extract') && action.selector) {
        const count = (selectorCounts.get(action.selector) ?? 0) + 1;
        selectorCounts.set(action.selector, count);
      }
    }
    
    for (const [selector, count] of selectorCounts) {
      if (selector === 'body' && count >= 3) {
        // Even more aggressive for body extracts
        return { isLooped: true, failedSelector: selector, count };
      }
      if (count >= 2) {
        // 2 repetitions of any selector (except body) = loop
        return { isLooped: true, failedSelector: selector, count };
      }
    }
    
    return { isLooped: false, count: 0 };
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
