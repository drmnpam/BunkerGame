export type BrowserActionType =
  | 'open_url'
  | 'click'
  | 'type'
  | 'wait'
  | 'extract'
  | 'screenshot'
  | 'press_key'
  | 'scroll'
  | 'drag_drop'
  | 'copy'
  | 'paste'
  | 'mcp_tool';

export type ExtractStrategy = 'inner_text' | 'html' | 'attribute';

export interface BrowserAction {
  action: BrowserActionType;
  selector?: string;
  value?: string;
  url?: string;
  waitMs?: number;
  description: string;
  extractStrategy?: ExtractStrategy;
  attributeName?: string;
  key?: string;
  sourceSelector?: string;
  targetSelector?: string;
  deltaX?: number;
  deltaY?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  toolName?: string;
  toolArgs?: Record<string, any>;
}

