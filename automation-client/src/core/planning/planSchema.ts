import { z } from 'zod';
import {
  BrowserAction,
  ExtractStrategy,
} from '../execution/ActionTypes';

const extractStrategySchema = z.union([
  z.literal('inner_text'),
  z.literal('html'),
  z.literal('attribute'),
]).optional();

export const browserActionSchema: z.ZodType<BrowserAction> = z
  .object({
    action: z.union([
      z.literal('open_url'),
      z.literal('click'),
      z.literal('type'),
      z.literal('wait'),
      z.literal('extract'),
      z.literal('screenshot'),
      z.literal('press_key'),
      z.literal('scroll'),
      z.literal('drag_drop'),
      z.literal('copy'),
      z.literal('paste'),
      z.literal('mcp_tool'),
    ]),
    selector: z.string().optional(),
    value: z.string().optional(),
    url: z.string().optional(),
    waitMs: z.number().int().positive().optional(),
    description: z.string(),
    extractStrategy: extractStrategySchema as any,
    attributeName: z.string().optional(),
    key: z.string().optional(),
    sourceSelector: z.string().optional(),
    targetSelector: z.string().optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    direction: z.union([z.literal('up'), z.literal('down'), z.literal('left'), z.literal('right')]).optional(),
    toolName: z.string().optional(),
    toolArgs: z.record(z.string(), z.any()).optional(),
  })
  .superRefine((val, ctx) => {
    const hasUrl = typeof val.url === 'string' && val.url.trim().length > 0;
    const hasValue = typeof val.value === 'string' && val.value.trim().length > 0;

    if (val.action === 'open_url') {
      if (!hasUrl && !hasValue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'open_url requires value (URL) or url',
        });
      }
    }

    if (val.action === 'click') {
      if (!val.selector) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selector'],
          message: 'click requires selector',
        });
      }
    }

    if (val.action === 'type') {
      if (!val.selector) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selector'],
          message: 'type requires selector',
        });
      }
      if (!hasValue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'type requires value',
        });
      }
    }

    if (val.action === 'wait') {
      if (typeof val.waitMs !== 'number') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['waitMs'],
          message: 'wait requires waitMs',
        });
      }
    }

    if (val.action === 'extract') {
      if (!val.selector) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selector'],
          message: 'extract requires selector',
        });
      }
    }

    if (val.action === 'press_key') {
      if (!val.key || val.key.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['key'],
          message: 'press_key requires key',
        });
      }
    }

    if (val.action === 'drag_drop') {
      if (!val.sourceSelector) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceSelector'],
          message: 'drag_drop requires sourceSelector',
        });
      }
      if (!val.targetSelector) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targetSelector'],
          message: 'drag_drop requires targetSelector',
        });
      }
    }

    if (val.action === 'paste') {
      if (!val.selector) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selector'],
          message: 'paste requires selector',
        });
      }
    }

    if (val.action === 'mcp_tool') {
      if (!val.toolName || val.toolName.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toolName'],
          message: 'mcp_tool requires toolName',
        });
      }
    }
  });

export const actionPlanSchema = z.array(browserActionSchema);

