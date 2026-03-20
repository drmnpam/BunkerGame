import { BrowserAction } from '../execution/ActionTypes';
import { MCPClient } from './MCPClient';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripHtmlToText(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,template').forEach((el) => el.remove());
  return doc.body?.innerText ?? '';
}

function normalizeDomResult(res: any): string {
  if (typeof res === 'string') return res;
  if (!res) return '';
  if (typeof res?.text === 'string') return res.text;
  if (typeof res?.html === 'string') return res.html;
  if (typeof res?.dom === 'string') return res.dom;
  if (typeof res?.content === 'string') return res.content;
  if (typeof res?.outerHTML === 'string') return res.outerHTML;
  if (typeof res?.result === 'string') return res.result;
  return JSON.stringify(res);
}

export class BrowserController {
  private tabId: string | null = null;
  private lastKnownUrl: string | null = null;
  private lastSearchQuery: string | null = null;
  private clipboardText: string = '';

  constructor(
    private readonly mcp: MCPClient,
    private readonly logger: (msg: string) => void,
  ) {}

  async ensureReady() {
    await this.ensureTabId();
  }

  private async ensureTabId() {
    if (this.tabId) return;
    let tabs: any[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      tabs = await this.mcp.listTabs();
      if (tabs.length) break;

      this.logger(`[MCP] no tabs found (attempt ${attempt}/3), trying new_tab...`);
      try {
        const created = await this.mcp.callTool('new_tab', { url: 'about:blank' });
        this.assertToolSuccess('new_tab', created);
      } catch (e) {
        this.logger(`[MCP] new_tab failed: ${(e as Error).message}`);
      }
      await sleep(1200);
    }

    if (!tabs.length) {
      throw new Error('No tabs connected in Kapture MCP after retries (check Kapture extension)');
    }

    this.tabId = String(tabs[0].tabId ?? tabs[0].id ?? '');
    if (!this.tabId) throw new Error('Kapture returned tabs but missing tabId');
    this.logger(`[MCP] using tabId=${this.tabId}`);
  }

  async executeAction(action: BrowserAction): Promise<any> {
    await this.ensureTabId();
    const tabId = this.tabId!;

    switch (action.action) {
      case 'open_url': {
        const url = action.url ?? action.value;
        if (!url) throw new Error('open_url requires value/url');
        this.logger(`[MCP] navigate url=${url}`);
        const res = await this.mcp.callTool('navigate', {
          tabId,
          url,
          timeout: 30_000,
        });
        const ok = this.assertToolSuccess('navigate', res);
        this.rememberContext(action, ok);
        return ok;
      }

      case 'click': {
        if (!action.selector) throw new Error('click requires selector');
        this.logger(`[MCP] click selector=${action.selector}`);
        try {
          const res = await this.mcp.callTool('click', {
            tabId,
            selector: action.selector,
          });
          const ok = this.assertToolSuccess('click', res);
          return await this.finalizeClickResult(tabId, action, action.selector, ok);
        } catch (e) {
          const err = e as Error;
          if (!this.isElementNotFoundError(err.message)) throw err;

          if (this.isSearchSubmitSelector(action.selector)) {
            const alt = await this.trySearchButtonFallbackClick(tabId, action.selector);
            if (alt) {
              return await this.finalizeClickResult(
                tabId,
                action,
                String(alt.selector ?? action.selector),
                alt,
              );
            }

            const navFallback = await this.trySearchUrlFallback(tabId);
            if (navFallback) {
              this.rememberContext(action, navFallback);
              return navFallback;
            }
          }

          if (this.isVacancyListSelector(action.selector)) {
            const alt = await this.tryVacancyCardFallbackClick(tabId, action.selector);
            if (alt) {
              return await this.finalizeClickResult(
                tabId,
                action,
                String(alt.selector ?? action.selector),
                alt,
              );
            }
          }

          if (this.isResponseSelector(action.selector)) {
            const alt = await this.tryResponseButtonFallbackClick(tabId, action.selector);
            if (alt) {
              return await this.finalizeClickResult(
                tabId,
                action,
                String(alt.selector ?? action.selector),
                alt,
              );
            }

            const recovered = await this.tryOpenVacancyAndRetryResponse(tabId, action.selector);
            if (recovered) {
              return await this.finalizeClickResult(
                tabId,
                action,
                String(recovered.selector ?? action.selector),
                recovered,
              );
            }
          }

          const generic = await this.tryGenericClickFallback(tabId, action.selector, action.description);
          if (generic) {
            return await this.finalizeClickResult(
              tabId,
              action,
              String(generic.selector ?? action.selector),
              generic,
            );
          }

          throw err;
        }
      }

      case 'type': {
        if (!action.selector) throw new Error('type requires selector');
        const value = action.value ?? '';
        this.logger(`[MCP] fill selector=${action.selector}`);
        try {
          const res = await this.mcp.callTool('fill', {
            tabId,
            selector: action.selector,
            value,
          });
          const ok = this.assertToolSuccess('fill', res);
          const submitted = await this.trySubmitAfterSearchInput(
            tabId,
            action.selector,
            value,
            action.description,
          );
          if (submitted) {
            this.rememberContext(action, submitted);
            return {
              ...submitted,
              searchSubmittedAfterType: true,
              selector: action.selector,
            };
          }
          this.rememberContext(action, ok);
          return ok;
        } catch (e) {
          const err = e as Error;
          if (!this.isElementNotFoundError(err.message)) throw err;

          if (this.isSearchInputSelector(action.selector)) {
            const recovered = await this.trySearchInputFallbackFill(tabId, action.selector, value);
            if (recovered) {
              const selectorUsed = String(recovered.selector ?? action.selector);
              const submitted = await this.trySubmitAfterSearchInput(
                tabId,
                selectorUsed,
                value,
                action.description,
              );
              if (submitted) {
                this.rememberContext({ ...action, selector: selectorUsed }, submitted);
                return {
                  ...submitted,
                  searchSubmittedAfterType: true,
                  selector: selectorUsed,
                };
              }
              this.rememberContext({ ...action, selector: selectorUsed }, recovered);
              return recovered;
            }
          }

          const generic = await this.tryGenericTypeFallback(
            tabId,
            action.selector,
            value,
            action.description,
          );
          if (generic) {
            const selectorUsed = String(generic.selector ?? action.selector);
            const submitted = await this.trySubmitAfterSearchInput(
              tabId,
              selectorUsed,
              value,
              action.description,
            );
            if (submitted) {
              this.rememberContext({ ...action, selector: selectorUsed }, submitted);
              return {
                ...submitted,
                searchSubmittedAfterType: true,
                selector: selectorUsed,
              };
            }
            this.rememberContext({ ...action, selector: selectorUsed }, generic);
            return generic;
          }

          throw err;
        }
      }

      case 'press_key': {
        const key = action.key?.trim();
        if (!key) throw new Error('press_key requires key');
        this.logger(`[MCP] press_key key=${key}`);

        const attempts: Array<{ name: string; args: Record<string, any> }> = [
          { name: 'press_key', args: { tabId, key } },
          { name: 'press', args: { tabId, key } },
          { name: 'keyboard', args: { tabId, key } },
          { name: 'key', args: { tabId, key } },
        ];

        for (const attempt of attempts) {
          try {
            const res = await this.mcp.callTool(attempt.name, attempt.args);
            const ok = this.assertToolSuccess(attempt.name, res);
            this.rememberContext(action, ok);
            return {
              ...ok,
              toolUsed: attempt.name,
            };
          } catch {
            // continue
          }
        }
        throw new Error('MCP press_key failed: no supported keyboard tool found');
      }

      case 'scroll': {
        const direction = action.direction ?? 'down';
        const dx = typeof action.deltaX === 'number' ? action.deltaX : 0;
        const dy =
          typeof action.deltaY === 'number'
            ? action.deltaY
            : direction === 'up'
            ? -700
            : direction === 'left'
            ? 0
            : direction === 'right'
            ? 0
            : 700;
        this.logger(`[MCP] scroll direction=${direction} deltaX=${dx} deltaY=${dy}`);

        const attempts: Array<{ name: string; args: Record<string, any> }> = [
          { name: 'scroll', args: { tabId, selector: action.selector, deltaX: dx, deltaY: dy } },
          { name: 'wheel', args: { tabId, deltaX: dx, deltaY: dy } },
        ];

        for (const attempt of attempts) {
          try {
            const res = await this.mcp.callTool(attempt.name, attempt.args);
            const ok = this.assertToolSuccess(attempt.name, res);
            this.rememberContext(action, ok);
            return {
              ...ok,
              toolUsed: attempt.name,
            };
          } catch {
            // continue
          }
        }
        throw new Error('MCP scroll failed: no supported scroll tool found');
      }

      case 'drag_drop': {
        if (!action.sourceSelector) throw new Error('drag_drop requires sourceSelector');
        if (!action.targetSelector) throw new Error('drag_drop requires targetSelector');
        this.logger(`[MCP] drag_drop ${action.sourceSelector} -> ${action.targetSelector}`);

        const attempts: Array<{ name: string; args: Record<string, any> }> = [
          {
            name: 'drag_drop',
            args: { tabId, sourceSelector: action.sourceSelector, targetSelector: action.targetSelector },
          },
          {
            name: 'drag',
            args: { tabId, sourceSelector: action.sourceSelector, targetSelector: action.targetSelector },
          },
          {
            name: 'dragAndDrop',
            args: { tabId, source: action.sourceSelector, target: action.targetSelector },
          },
        ];

        for (const attempt of attempts) {
          try {
            const res = await this.mcp.callTool(attempt.name, attempt.args);
            const ok = this.assertToolSuccess(attempt.name, res);
            this.rememberContext(action, ok);
            return {
              ...ok,
              toolUsed: attempt.name,
            };
          } catch {
            // continue
          }
        }
        throw new Error('MCP drag_drop failed: no supported drag tool found');
      }

      case 'copy': {
        if (action.selector) {
          this.logger(`[MCP] copy selector=${action.selector}`);
          try {
            const domRaw = await this.mcp.callTool('dom', { tabId, selector: action.selector });
            const dom = this.assertToolSuccess('dom', domRaw);
            const html = normalizeDomResult(dom);
            const text = stripHtmlToText(html).trim();
            this.clipboardText = text;
            this.rememberContext(action, { copiedChars: text.length, selector: action.selector });
            return {
              copiedText: text,
              copiedChars: text.length,
              selector: action.selector,
            };
          } catch (e) {
            const err = e as Error;
            if (!this.isElementNotFoundError(err.message)) throw err;
          }
        }

        const currentText = typeof action.value === 'string' ? action.value : this.clipboardText;
        if (currentText) {
          this.clipboardText = currentText;
          return { copiedText: currentText, copiedChars: currentText.length, source: 'memory' };
        }

        throw new Error('copy failed: selector/value missing and clipboard is empty');
      }

      case 'paste': {
        if (!action.selector) throw new Error('paste requires selector');
        const text = typeof action.value === 'string' ? action.value : this.clipboardText;
        if (!text) throw new Error('paste failed: clipboard is empty');
        this.logger(`[MCP] paste selector=${action.selector}`);
        const filled =
          (await this.tryGenericTypeFallback(tabId, action.selector, text, action.description)) ??
          (await this.trySearchInputFallbackFill(tabId, action.selector, text));
        if (filled) {
          this.rememberContext(action, filled);
          return {
            ...filled,
            pastedChars: text.length,
          };
        }
        const res = await this.mcp.callTool('fill', { tabId, selector: action.selector, value: text });
        const ok = this.assertToolSuccess('fill', res);
        this.rememberContext(action, ok);
        return {
          ...ok,
          pastedChars: text.length,
        };
      }

      case 'mcp_tool': {
        if (!action.toolName?.trim()) throw new Error('mcp_tool requires toolName');
        const toolName = action.toolName.trim();
        const args = { tabId, ...(action.toolArgs ?? {}) };
        this.logger(`[MCP] custom tool=${toolName}`);
        const res = await this.mcp.callTool(toolName, args);
        const ok = this.assertToolSuccess(toolName, res);
        this.rememberContext(action, ok);
        return {
          ...ok,
          toolUsed: toolName,
        };
      }

      case 'wait': {
        const ms = action.waitMs ?? 1000;
        this.logger(`[MCP] wait ms=${ms}`);
        await sleep(ms);
        return { waitedMs: ms };
      }

      case 'extract': {
        if (!action.selector) throw new Error('extract requires selector');
        this.logger(
          `[MCP] extract selector=${action.selector} strategy=${action.extractStrategy ?? 'inner_text'}`,
        );

        let dom: any;
        try {
          const domRaw = await this.mcp.callTool('dom', {
            tabId,
            selector: action.selector,
          });
          dom = this.assertToolSuccess('dom', domRaw);
        } catch (e) {
          const err = e as Error;
          if (!this.isElementNotFoundError(err.message)) {
            throw err;
          }

          let fallbackDom: any | null = null;
          if (this.isVacancyListSelector(action.selector)) {
            fallbackDom = await this.tryVacancyExtractFallback(tabId, action.selector);
          }
          if (!fallbackDom) {
            fallbackDom = await this.tryGenericExtractFallback(tabId, action.selector);
          }
          if (!fallbackDom) throw err;
          dom = fallbackDom;
        }

        const html = normalizeDomResult(dom);
        const strategy = action.extractStrategy ?? 'inner_text';
        if (strategy === 'html') {
          return { strategy, html };
        }
        if (strategy === 'attribute') {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const attr = action.attributeName ?? 'href';
          const elFromSelector = action.selector ? doc.querySelector(action.selector) : null;
          const el = elFromSelector ?? doc.body?.firstElementChild ?? null;
          const value = el?.getAttribute(attr) ?? null;
          return { strategy, attribute: attr, value };
        }

        const text = stripHtmlToText(html);
        return { strategy, text, html };
      }

      case 'screenshot': {
        this.logger('[MCP] screenshot');
        try {
          const res = await this.mcp.callTool('screenshot', {
            tabId,
            selector: action.selector,
            scale: 0.5,
          });
          const ok = this.assertToolSuccess('screenshot', res);
          this.rememberContext(action, ok);
          return ok;
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          if (msg.toLowerCase().includes('another debugger is already attached')) {
            this.logger('[MCP] screenshot soft-skip: debugger already attached');
            return {
              warning: 'screenshot_skipped_debugger_conflict',
              message: msg,
              url: this.lastKnownUrl,
            };
          }
          throw e;
        }
      }

      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  private assertToolSuccess(tool: string, result: any) {
    if (!result || typeof result !== 'object') return result;

    if (result.isError === true) {
      throw new Error(`MCP ${tool} failed: ${this.extractErrorMessage(result)}`);
    }
    if (result.error) {
      throw new Error(`MCP ${tool} failed: ${this.extractErrorMessage(result.error)}`);
    }
    if (result.success === false) {
      throw new Error(`MCP ${tool} failed: ${this.extractErrorMessage(result)}`);
    }
    return result;
  }

  private rememberContext(action: BrowserAction, result: any) {
    const urlFromResult = typeof result?.url === 'string' ? result.url : null;
    const urlFromAction = action.action === 'open_url' ? action.url ?? action.value ?? null : null;
    this.lastKnownUrl = urlFromResult ?? urlFromAction ?? this.lastKnownUrl;

    if (
      action.action === 'type' &&
      action.selector &&
      /search|query|text|поиск|найти/i.test(action.selector) &&
      typeof action.value === 'string' &&
      action.value.trim().length > 0
    ) {
      this.lastSearchQuery = action.value.trim();
    }
  }

  private isElementNotFoundError(message: string) {
    const m = message.toLowerCase();
    return m.includes('element not found') || m.includes('selector') || m.includes('not found');
  }

  private isSearchSubmitSelector(selector: string) {
    return /search|query|submit|find|поиск|найти/i.test(selector);
  }

  private isSearchInputSelector(selector: string) {
    return /search|query|text|input|combobox|поиск|найти/i.test(selector);
  }

  private isVacancyListSelector(selector: string) {
    return /vacancy-serp|serp-item__title|vacancy-title|\/vacancy\//i.test(selector);
  }

  private isResponseSelector(selector: string) {
    return /response|respond|apply|otklik|vacancy-response/i.test(selector);
  }

  private isVacancyUrl(url: string | null | undefined) {
    if (!url) return false;
    return /https?:\/\/[^/]*hh\.ru\/vacancy\//i.test(url);
  }

  private isSearchResultsUrl(url: string) {
    return /\/search\/vacancy/i.test(url);
  }

  private async finalizeClickResult(
    tabId: string,
    action: BrowserAction,
    selectorUsed: string,
    rawResult: any,
  ) {
    let result = rawResult;
    if (this.isVacancyListSelector(selectorUsed)) {
      const ensured = await this.ensureVacancyPageAfterTitleClick(tabId, selectorUsed, rawResult);
      if (ensured) result = ensured;
    }
    this.rememberContext({ ...action, selector: selectorUsed }, result);
    return result;
  }

  private async ensureVacancyPageAfterTitleClick(
    tabId: string,
    selectorUsed: string,
    result: any,
  ) {
    if (this.isVacancyUrl(result?.url) || this.isVacancyUrl(this.lastKnownUrl)) {
      return result;
    }

    const switched = await this.trySwitchToVacancyTab();
    if (switched) {
      return {
        ...result,
        switchedToVacancyTab: true,
        tabId: this.tabId,
        url: this.lastKnownUrl ?? result?.url,
      };
    }

    const navigated = await this.tryNavigateToVacancyBySelector(tabId, selectorUsed);
    if (navigated) {
      return {
        ...navigated,
        navigatedToVacancyByHref: true,
        selector: selectorUsed,
      };
    }

    return null;
  }

  private async trySwitchToVacancyTab() {
    try {
      const tabs = await this.mcp.listTabs();
      if (!tabs.length) return false;

      const vacancyTabs = tabs.filter((t) => this.isVacancyUrl(String(t?.url ?? '')));
      if (!vacancyTabs.length) return false;

      const currentId = this.tabId;
      const preferred =
        vacancyTabs.find((t) => String(t?.tabId ?? t?.id ?? '') !== currentId) ??
        vacancyTabs[0];

      const nextId = String(preferred?.tabId ?? preferred?.id ?? '').trim();
      if (!nextId) return false;

      this.tabId = nextId;
      this.lastKnownUrl = String(preferred?.url ?? this.lastKnownUrl ?? '');
      this.logger(`[MCP] switched to vacancy tabId=${this.tabId}`);
      return true;
    } catch {
      return false;
    }
  }

  private async tryOpenVacancyAndRetryResponse(tabId: string, originalSelector: string) {
    if (!this.isSearchResultsUrl(this.lastKnownUrl ?? '')) return null;

    this.logger('[MCP] response fallback: not on vacancy page, opening first vacancy...');
    const opened = await this.tryNavigateToVacancyBySelector(tabId, "a[data-qa='serp-item__title']");
    if (!opened) return null;

    await sleep(900);
    const retrySelectors = [originalSelector, ...this.getResponseSelectorCandidates()];
    const retried = await this.tryClickCandidates(tabId, '', retrySelectors);
    if (!retried) return null;
    return {
      ...retried,
      recoveredByOpeningVacancy: true,
    };
  }

  private async trySearchButtonFallbackClick(tabId: string, originalSelector: string) {
    const candidates = [
      "button[data-qa='search-button']",
      "button[data-qa='search-submit']",
      "button[type='submit']",
      "[data-qa='search-button']",
      "[data-qa='vacancy-search-button']",
      "[data-testid*='search']",
      "button[aria-label*='Find']",
      "button[aria-label*='Поиск']",
      "button[aria-label*='Найти']",
      "button[class*='search']",
      "button[class*='find']",
      "[role='button'][class*='search']",
      "[role='button'][class*='find']",
      'button[aria-label*="Search"]',
    ];
    return await this.tryClickCandidates(tabId, originalSelector, candidates);
  }

  private async tryVacancyCardFallbackClick(tabId: string, originalSelector: string) {
    const candidates = this.getVacancyTitleCandidates();
    return await this.tryClickCandidates(tabId, originalSelector, candidates);
  }

  private async tryResponseButtonFallbackClick(tabId: string, originalSelector: string) {
    const candidates = this.getResponseSelectorCandidates();
    return await this.tryClickCandidates(tabId, originalSelector, candidates);
  }

  private async trySearchInputFallbackFill(tabId: string, originalSelector: string, value: string) {
    const candidates = this.getSearchInputCandidates();
    for (const selector of candidates) {
      if (selector === originalSelector) continue;
      this.logger(`[MCP] fill fallback selector=${selector}`);
      try {
        const res = await this.mcp.callTool('fill', { tabId, selector, value });
        const ok = this.assertToolSuccess('fill', res);
        return { ...ok, selector };
      } catch {
        // try next selector
      }
    }

    if (this.isYandexMapsUrl(this.lastKnownUrl)) {
      const opened = await this.tryClickCandidates(tabId, '', this.getYandexSearchOpenCandidates());
      if (opened) {
        await sleep(300);
        for (const selector of candidates) {
          this.logger(`[MCP] fill retry-after-open selector=${selector}`);
          try {
            const res = await this.mcp.callTool('fill', { tabId, selector, value });
            const ok = this.assertToolSuccess('fill', res);
            return { ...ok, selector };
          } catch {
            // try next selector
          }
        }
      }
    }

    return null;
  }

  private async trySubmitAfterSearchInput(
    tabId: string,
    selector: string,
    value: string,
    description?: string,
  ) {
    if (!value.trim() || !this.isSearchInputSelector(`${selector} ${description ?? ''}`)) return null;

    if (this.isYandexMapsUrl(this.lastKnownUrl)) {
      const viaUrl = await this.trySearchUrlFallback(tabId);
      if (viaUrl) return viaUrl;
    }

    const candidates = this.getGenericSearchSubmitCandidates(selector, description);
    return await this.tryClickCandidates(tabId, '', candidates);
  }

  private async tryGenericClickFallback(tabId: string, originalSelector: string, description?: string) {
    const candidates = this.getGenericClickCandidates(originalSelector, description);
    return await this.tryClickCandidates(tabId, originalSelector, candidates);
  }

  private async tryGenericTypeFallback(
    tabId: string,
    originalSelector: string,
    value: string,
    description?: string,
  ) {
    const candidates = this.getGenericTypeCandidates(originalSelector, description);
    for (const selector of candidates) {
      if (selector === originalSelector) continue;
      this.logger(`[MCP] fill generic fallback selector=${selector}`);
      try {
        const res = await this.mcp.callTool('fill', { tabId, selector, value });
        const ok = this.assertToolSuccess('fill', res);
        return { ...ok, selector };
      } catch {
        // try next selector
      }
    }
    return null;
  }

  private async tryClickCandidates(tabId: string, originalSelector: string, candidates: string[]) {
    for (const selector of candidates) {
      if (selector === originalSelector) continue;
      this.logger(`[MCP] click fallback selector=${selector}`);
      try {
        const res = await this.mcp.callTool('click', { tabId, selector });
        const ok = this.assertToolSuccess('click', res);
        return { ...ok, selector };
      } catch {
        // try next selector
      }
    }
    return null;
  }

  private async tryVacancyExtractFallback(tabId: string, originalSelector: string) {
    const candidates = this.getVacancyTitleCandidates();
    for (const selector of candidates) {
      if (selector === originalSelector) continue;
      this.logger(`[MCP] extract fallback selector=${selector}`);
      try {
        const res = await this.mcp.callTool('dom', { tabId, selector });
        const ok = this.assertToolSuccess('dom', res);
        return { ...ok, selector };
      } catch {
        // try next selector
      }
    }
    return null;
  }

  private async tryGenericExtractFallback(tabId: string, originalSelector: string) {
    const candidates = this.getGenericExtractCandidates(originalSelector);
    for (const selector of candidates) {
      if (selector === originalSelector) continue;
      this.logger(`[MCP] extract generic fallback selector=${selector}`);
      try {
        const res = await this.mcp.callTool('dom', { tabId, selector });
        const ok = this.assertToolSuccess('dom', res);
        return { ...ok, selector };
      } catch {
        // try next selector
      }
    }
    return null;
  }

  private async trySearchUrlFallback(tabId: string) {
    if (!this.lastSearchQuery) return null;
    const query = encodeURIComponent(this.lastSearchQuery);
    let url: string;
    if (this.isYandexMapsUrl(this.lastKnownUrl)) {
      url = `https://yandex.ru/maps/?text=${query}`;
    } else {
      const origin = this.resolveHhOrigin();
      url = `${origin}/search/vacancy?text=${query}`;
    }

    this.logger(`[MCP] search fallback navigate url=${url}`);
    const res = await this.mcp.callTool('navigate', {
      tabId,
      url,
      timeout: 30_000,
    });
    return this.assertToolSuccess('navigate', res);
  }

  private async tryNavigateToVacancyBySelector(tabId: string, selectorHint: string) {
    const candidates = Array.from(new Set([selectorHint, ...this.getVacancyTitleCandidates()]));
    for (const selector of candidates) {
      this.logger(`[MCP] vacancy href fallback selector=${selector}`);
      try {
        const domRaw = await this.mcp.callTool('dom', { tabId, selector });
        const dom = this.assertToolSuccess('dom', domRaw);
        const html = normalizeDomResult(dom);
        const href = this.extractFirstHrefFromHtml(html);
        if (!href) continue;

        const url = this.toAbsoluteUrl(href);
        if (!this.isVacancyUrl(url)) continue;

        this.logger(`[MCP] vacancy href fallback navigate url=${url}`);
        const navRaw = await this.mcp.callTool('navigate', {
          tabId,
          url,
          timeout: 30_000,
        });
        return this.assertToolSuccess('navigate', navRaw);
      } catch {
        // continue
      }
    }
    return null;
  }

  private extractFirstHrefFromHtml(html: string) {
    if (!html) return null;
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const href = doc.querySelector('a[href]')?.getAttribute('href');
      if (href) return href;
    } catch {
      // ignore
    }
    const match = html.match(/href=['"]([^'"]+)['"]/i);
    return match?.[1] ?? null;
  }

  private toAbsoluteUrl(href: string) {
    try {
      const base = this.lastKnownUrl ?? this.resolveHhOrigin();
      return new URL(href, base).toString();
    } catch {
      return href;
    }
  }

  private getVacancyTitleCandidates() {
    return [
      "a[data-qa='serp-item__title']",
      "a[data-qa='vacancy-serp__vacancy-title']",
      "[data-qa='vacancy-title'] a",
      "a[href*='/vacancy/']",
    ];
  }

  private getResponseSelectorCandidates() {
    return [
      "button[data-qa='vacancy-response-button']",
      "a[data-qa='vacancy-response-link']",
      "a[data-qa='vacancy-response-link-top']",
      "button[data-qa='vacancy-response-link-top']",
      "button[data-qa*='vacancy-response']",
      "a[href*='response']",
    ];
  }

  private getSearchInputCandidates() {
    return [
      "input[type='search']",
      "input[type='text']",
      "input[role='combobox']",
      "input[name='text']",
      "input[id*='search']",
      "input[class*='search']",
      "input[class*='query']",
      "input[aria-label*='Search']",
      "input[aria-label*='Поиск']",
      "input[placeholder*='Search']",
      "input[placeholder*='Поиск']",
      'textarea',
      "[contenteditable='true']",
    ];
  }

  private getYandexSearchOpenCandidates() {
    return [
      "button[aria-label*='Search']",
      "button[aria-label*='Поиск']",
      "button[class*='search']",
      "button[class*='find']",
      "button[class*='searchbox']",
      "[class*='search'] button",
      "[data-testid*='search'] button",
      "[role='button'][class*='search']",
      "[role='button'][class*='find']",
    ];
  }

  private getGenericExtractCandidates(originalSelector: string) {
    const tokenSelectors = this.extractSelectorTokens(originalSelector).flatMap((t) => [
      `[data-testid*='${t}']`,
      `[data-qa*='${t}']`,
      `[id*='${t}']`,
      `[class*='${t}']`,
      `[name*='${t}']`,
    ]);
    return Array.from(
      new Set([
        ...tokenSelectors,
        "[role='main']",
        'main',
        'article',
        'section',
        'body',
      ]),
    );
  }

  private getGenericSearchSubmitCandidates(originalSelector: string, description?: string) {
    const tokens = this.extractSelectorTokens(`${originalSelector} ${description ?? ''}`);
    const tokenSelectors = tokens.flatMap((t) => [
      `button[id*='${t}']`,
      `button[class*='${t}']`,
      `[role='button'][class*='${t}']`,
      `[data-testid*='${t}']`,
      `[data-qa*='${t}']`,
    ]);
    return Array.from(
      new Set([
        ...tokenSelectors,
        "button[type='submit']",
        "button[aria-label*='Search']",
        "button[aria-label*='Find']",
        "button[aria-label*='Поиск']",
        "button[aria-label*='Найти']",
        "[data-testid*='search']",
        "[data-qa*='search']",
        "button[class*='search']",
        "button[class*='find']",
        "[role='button'][class*='search']",
        "[role='button'][class*='find']",
      ]),
    );
  }

  private getGenericClickCandidates(originalSelector: string, description?: string) {
    const tokens = this.extractSelectorTokens(`${originalSelector} ${description ?? ''}`);
    const tokenSelectors = tokens.flatMap((t) => [
      `[data-testid*='${t}']`,
      `[data-qa*='${t}']`,
      `[id*='${t}']`,
      `[name*='${t}']`,
      `[class*='${t}']`,
      `button[id*='${t}']`,
      `button[class*='${t}']`,
      `a[id*='${t}']`,
      `a[class*='${t}']`,
      `button[aria-label*='${t}']`,
      `a[aria-label*='${t}']`,
      `[role='button'][aria-label*='${t}']`,
    ]);
    return Array.from(
      new Set([
        ...tokenSelectors,
        "button[type='submit']",
        "button[aria-label*='Search']",
        "button[aria-label*='Find']",
        "[role='button']",
        'button',
        "a[role='button']",
      ]),
    );
  }

  private getGenericTypeCandidates(originalSelector: string, description?: string) {
    const tokens = this.extractSelectorTokens(`${originalSelector} ${description ?? ''}`);
    const tokenSelectors = tokens.flatMap((t) => [
      `input[id*='${t}']`,
      `input[name*='${t}']`,
      `input[class*='${t}']`,
      `input[placeholder*='${t}']`,
      `textarea[id*='${t}']`,
      `textarea[name*='${t}']`,
      `textarea[class*='${t}']`,
      `[contenteditable='true'][aria-label*='${t}']`,
    ]);
    return Array.from(
      new Set([
        ...tokenSelectors,
        ...this.getSearchInputCandidates(),
      ]),
    );
  }

  private extractSelectorTokens(source: string) {
    const raw = (source || '').toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
    return Array.from(new Set(raw.filter((t) => !this.isNoiseSelectorToken(t)))).slice(0, 12);
  }

  private isNoiseSelectorToken(token: string) {
    return (
      token.length < 3 ||
      [
        'data',
        'testid',
        'qa',
        'class',
        'name',
        'role',
        'aria',
        'label',
        'type',
        'input',
        'button',
        'click',
        'open',
        'wait',
        'поиск',
        'найти',
        'кнопка',
        'поле',
      ].includes(token)
    );
  }

  private isYandexMapsUrl(url: string | null | undefined) {
    if (!url) return false;
    try {
      const host = new URL(url).hostname;
      return host.includes('yandex.ru') || host.includes('yandex.com');
    } catch {
      return false;
    }
  }

  private resolveHhOrigin() {
    try {
      if (this.lastKnownUrl) {
        const u = new URL(this.lastKnownUrl);
        if (u.hostname.includes('hh.ru')) {
          return `${u.protocol}//${u.host}`;
        }
      }
    } catch {
      // ignore parse errors
    }
    return 'https://hh.ru';
  }

  private extractErrorMessage(value: any): string {
    if (!value) return 'unknown error';
    if (typeof value === 'string') return value;
    if (typeof value?.message === 'string') return value.message;
    if (typeof value?.error?.message === 'string') return value.error.message;
    try {
      return JSON.stringify(value);
    } catch {
      return 'unknown error';
    }
  }
}
