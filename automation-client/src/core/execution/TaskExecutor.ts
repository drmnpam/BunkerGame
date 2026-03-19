import { BrowserController } from '../mcp/BrowserController';
import { TaskPlanner } from '../planning/TaskPlanner';
import { StateManager } from '../state/StateManager';
import { BrowserAction } from './ActionTypes';
import { TaskHistoryEntry, TaskStatus } from '../state/types';
import { ToolCall } from '../planning/toolCallSchema';

export interface TaskExecutorCallbacks {
  onStatusChange: (status: TaskStatus) => void;
  onPlanChange: (plan: BrowserAction[]) => void;
  onCurrentStep: (index: number, step: BrowserAction) => void;
  onStepLog: (msg: string) => void;
  onStepResult: (index: number, step: BrowserAction, result: any) => void;
  onTaskDone: (entry: TaskHistoryEntry) => void;
  onCheckpoint?: (checkpoint: TaskExecutionCheckpoint) => void;
}

export interface TaskExecutionControl {
  isPaused: () => boolean;
}

export interface TaskExecutionCheckpoint {
  taskText: string;
  providerName: string;
  plan: BrowserAction[];
  lastObservation: any;
  lastErrorMessage: string;
  nextStepIndex: number;
}

export interface TaskRunOptions {
  resumeFrom?: TaskExecutionCheckpoint | null;
}

function makeTaskId() {
  return `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class TaskExecutor {
  constructor(
    private readonly planner: TaskPlanner,
    private readonly browser: BrowserController,
    private readonly state: StateManager,
    private readonly callbacks: TaskExecutorCallbacks,
    private readonly control: TaskExecutionControl | null,
    private readonly logger: (msg: string) => void,
    private readonly maxSteps = 24,
    private readonly maxToolCallRetriesPerStep = 2,
    private readonly maxConsecutiveMcpErrors = 3,
  ) {}

  async run(taskText: string, providerName: string, options?: TaskRunOptions) {
    const taskId = makeTaskId();
    const startedAt = Date.now();

    const resume = options?.resumeFrom ?? null;

    let plan: BrowserAction[] = resume?.plan ? [...resume.plan] : [];
    let lastErrorMessage = resume?.lastErrorMessage ?? '';
    let lastObservation: any = resume?.lastObservation ?? null;
    let stepStart = Math.max(0, resume?.nextStepIndex ?? 0);
    const stepEndExclusive = stepStart + this.maxSteps;

    let consecutiveMcpErrors = 0;

    this.state.setStatus('running');
    this.callbacks.onStatusChange('running');

    this.logger(`[Executor] taskId=${taskId} starting provider=${providerName}`);
    this.callbacks.onStepLog(`[Executor] taskId=${taskId}`);
    if (resume) {
      this.callbacks.onStepLog(
        `[Executor] continue from stepIndex=${stepStart} with existingPlan=${plan.length}`,
      );
    }
    this.emitCheckpoint({
      taskText,
      providerName,
      plan,
      lastObservation,
      lastErrorMessage,
      nextStepIndex: stepStart,
    });

    for (let stepIndex = stepStart; stepIndex < stepEndExclusive; stepIndex++) {
      await this.waitIfPaused(stepIndex);
      this.callbacks.onPlanChange(plan);

      this.callbacks.onStepLog(
        `[AgentLoop] requesting next tool call (stepIndex=${stepIndex}, maxSteps=${this.maxSteps})...`,
      );

      let toolCall: ToolCall | null = null;
      let toolCallRetry = 0;
      let lastRawModelOutput = '';
      let lastParseErrorMessage = '';

      while (!toolCall && toolCallRetry <= this.maxToolCallRetriesPerStep) {
        try {
          if (toolCallRetry === 0) {
            toolCall = await this.planner.generateNextToolCall({
              taskText,
              actionsSoFar: plan,
              lastObservation,
              lastErrorMessage: lastErrorMessage || null,
              stepIndex,
              maxSteps: this.maxSteps,
            });
          } else {
            this.callbacks.onStepLog(`[Planner] tool call self-correct... (retry=${toolCallRetry})`);
            toolCall = await this.planner.selfCorrectToolCall({
              taskText,
              actionsSoFar: plan,
              lastObservation,
              lastErrorMessage: lastErrorMessage || null,
              stepIndex,
              maxSteps: this.maxSteps,
              rawModelOutput: lastRawModelOutput,
              parseErrorMessage: lastParseErrorMessage || 'invalid tool call output',
            });
          }
        } catch (e) {
          const err = e as any;
          this.callbacks.onStepLog(`[PlannerError] ${err?.message ?? String(e)}`);
          lastRawModelOutput = err?.rawModelOutput ?? lastRawModelOutput;
          lastParseErrorMessage = err?.message ?? String(e);
          if (
            this.isLikelyToolFormatError(lastParseErrorMessage) &&
            this.isLikelyTruncatedToolCall(lastRawModelOutput)
          ) {
            const fallback = this.makeFallbackToolCall(stepIndex, lastErrorMessage);
            this.callbacks.onStepLog(
              `[Planner] fallback tool call injected after truncated model output: ${fallback.action}`,
            );
            toolCall = fallback as ToolCall;
            break;
          }

          if (toolCallRetry >= this.maxToolCallRetriesPerStep) {
            if (
              this.isLikelyToolFormatError(lastParseErrorMessage) ||
              this.isLikelyProviderTemporaryFailure(lastParseErrorMessage)
            ) {
              const fallback = this.makeFallbackToolCall(stepIndex, lastErrorMessage);
              this.callbacks.onStepLog(
                `[Planner] fallback tool call injected after planner failures: ${fallback.action}`,
              );
              toolCall = fallback as ToolCall;
              break;
            }
            throw e;
          }
        }
        toolCallRetry++;
      }

      if (!toolCall) {
        throw new Error('Agent loop failed to produce a tool call');
      }

      if (toolCall.status === 'done') {
        const finishedAt = Date.now();
        const entry: TaskHistoryEntry = {
          id: taskId,
          startedAt,
          finishedAt,
          taskText,
          provider: providerName,
          plan,
          resultSummary: toolCall.finalResult ?? toolCall.description ?? 'done',
        };
        this.state.setStatus('success');
        this.callbacks.onStatusChange('success');
        this.callbacks.onTaskDone(entry);
        return;
      }

      const step = toolCall as any as BrowserAction;

      // Update UI step.
      this.state.setCurrentStep(stepIndex, step);
      this.callbacks.onCurrentStep(stepIndex, step);
      const stepHeader = `[Step ${stepIndex + 1}/${this.maxSteps}] ${step.action} ${step.description}`;
      this.callbacks.onStepLog(stepHeader);
      this.logger(stepHeader);
      this.logger(`[StepInput] ${JSON.stringify(step)}`);

      try {
        await this.waitIfPaused(stepIndex);
        const result = await this.browser.executeAction(step);
        consecutiveMcpErrors = 0;
        lastErrorMessage = '';
        lastObservation = result;

        // Append executed step to the plan.
        plan = [...plan, step];
        this.callbacks.onPlanChange(plan);

        this.callbacks.onStepResult(stepIndex, step, result);
        this.callbacks.onStepLog(`[StepResult] ${this.summarize(result)}`);
        this.emitCheckpoint({
          taskText,
          providerName,
          plan,
          lastObservation,
          lastErrorMessage,
          nextStepIndex: stepIndex + 1,
        });
      } catch (e) {
        const err = e as Error;
        consecutiveMcpErrors += 1;
        lastErrorMessage = err?.message || String(e);
        lastObservation = { error: lastErrorMessage };

        // Append attempted step so user can see what failed.
        plan = [...plan, step];
        this.callbacks.onPlanChange(plan);

        this.callbacks.onStepResult(stepIndex, step, { error: lastErrorMessage });
        this.callbacks.onStepLog(`[MCPError] ${lastErrorMessage}`);
        this.logger(`[MCPError] stepIndex=${stepIndex} ${lastErrorMessage}`);
        this.emitCheckpoint({
          taskText,
          providerName,
          plan,
          lastObservation,
          lastErrorMessage,
          nextStepIndex: stepIndex + 1,
        });

        if (consecutiveMcpErrors >= this.maxConsecutiveMcpErrors) {
          const finishedAt = Date.now();
          const entry: TaskHistoryEntry = {
            id: taskId,
            startedAt,
            finishedAt,
            taskText,
            provider: providerName,
            plan,
            resultSummary: 'error',
            error: lastErrorMessage,
          };

          this.state.setStatus('error');
          this.callbacks.onStatusChange('error');
          this.callbacks.onTaskDone(entry);
          throw err;
        }
      }
    }

    // Max steps reached without done.
    const finishedAt = Date.now();
    const entry: TaskHistoryEntry = {
      id: taskId,
      startedAt,
      finishedAt,
      taskText,
      provider: providerName,
      plan,
      resultSummary: 'error',
      error: `Max steps reached (${this.maxSteps}) for this run segment without status="done"`,
    };

    this.state.setStatus('error');
    this.callbacks.onStatusChange('error');
    this.callbacks.onTaskDone(entry);
    throw new Error(entry.error ?? 'Max steps reached');
  }

  private async waitIfPaused(stepIndex: number) {
    if (!this.control?.isPaused()) return;
    this.state.setStatus('paused');
    this.callbacks.onStatusChange('paused');
    this.callbacks.onStepLog(`[Executor] paused at stepIndex=${stepIndex}`);

    while (this.control.isPaused()) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    this.state.setStatus('running');
    this.callbacks.onStatusChange('running');
    this.callbacks.onStepLog('[Executor] resumed');
  }

  private summarize(result: any) {
    try {
      if (typeof result === 'string') return result.slice(0, 300);
      if (result == null) return 'null';
      const json = typeof result === 'object' ? JSON.stringify(result) : String(result);
      return json.length > 300 ? `${json.slice(0, 300)}...` : json;
    } catch {
      return '[unserializable result]';
    }
  }

  private emitCheckpoint(checkpoint: TaskExecutionCheckpoint) {
    this.callbacks.onCheckpoint?.(checkpoint);
  }

  private isLikelyToolFormatError(message: string) {
    const m = message.toLowerCase();
    return (
      m.includes('invalid tool call json') ||
      m.includes('no json object found') ||
      m.includes('invalid input') ||
      m.includes('zod')
    );
  }

  private isLikelyProviderTemporaryFailure(message: string) {
    const m = message.toLowerCase();
    return (
      m.includes('returned empty content') ||
      m.includes('budget insufficient') ||
      m.includes('rate-limited') ||
      m.includes('prompt tokens limit exceeded') ||
      m.includes('requires more credits') ||
      m.includes('can only afford')
    );
  }

  private isLikelyTruncatedToolCall(rawOutput: string) {
    const s = (rawOutput ?? '').trim();
    if (!s) return false;
    return s.startsWith('{') && !s.endsWith('}');
  }

  private makeFallbackToolCall(stepIndex: number, lastErrorMessage?: string): BrowserAction {
    const err = (lastErrorMessage ?? '').toLowerCase();
    if (err.includes('debugger') || err.includes('screenshot')) {
      return {
        action: 'wait',
        waitMs: 1400,
        description: 'Fallback: short wait due debugger/screenshot conflict.',
      };
    }

    if (stepIndex % 2 === 0) {
      return {
        action: 'screenshot',
        description: 'Fallback: taking screenshot after invalid planner output.',
      };
    }
    return {
      action: 'wait',
      waitMs: 1200,
      description: 'Fallback: short wait after invalid planner output.',
    };
  }
}

