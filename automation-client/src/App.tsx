import React, { useMemo, useRef, useState } from 'react';
import './App.css';
import { GeminiProvider } from './core/llm/providers/GeminiProvider';
import { LLMManager } from './core/llm/LLMManager';
import { OllamaProvider } from './core/llm/providers/OllamaProvider';
import { OpenAIProvider } from './core/llm/providers/OpenAIProvider';
import { OpenRouterProvider } from './core/llm/providers/OpenRouterProvider';
import { ClaudeProvider } from './core/llm/providers/ClaudeProvider';
import { DeepSeekProvider } from './core/llm/providers/DeepSeekProvider';
import { TaskPlanner } from './core/planning/TaskPlanner';
import { MCPClient } from './core/mcp/MCPClient';
import { BrowserController } from './core/mcp/BrowserController';
import { StateManager } from './core/state/StateManager';
import { TaskExecutionCheckpoint, TaskExecutor } from './core/execution/TaskExecutor';
import { BrowserAction } from './core/execution/ActionTypes';
import { TaskHistoryEntry, TaskStatus } from './core/state/types';

type ProviderName = 'gemini' | 'openrouter' | 'openai' | 'claude' | 'deepseek' | 'ollama';

export const App: React.FC = () => {
  const [provider, setProvider] = useState<ProviderName>('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [taskText, setTaskText] = useState('');

  const [status, setStatus] = useState<TaskStatus>('idle');
  const [isPaused, setIsPaused] = useState(false);
  const pausedRef = useRef(false);

  const [log, setLog] = useState<string[]>([]);
  const [currentStep, setCurrentStep] = useState<{ index: number; step: BrowserAction } | null>(null);
  const [lastStepResult, setLastStepResult] = useState<any>(null);
  const [finalEntry, setFinalEntry] = useState<TaskHistoryEntry | null>(null);
  const [resumeCheckpoint, setResumeCheckpoint] = useState<TaskExecutionCheckpoint | null>(null);

  const appendLog = (msg: string) => {
    setLog((prev) => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);
  };

  const canRun = useMemo(
    () => status !== 'running' && status !== 'paused' && taskText.trim().length > 0,
    [status, taskText],
  );
  const canContinue = useMemo(
    () => status !== 'running' && status !== 'paused' && resumeCheckpoint !== null,
    [status, resumeCheckpoint],
  );
  const canPauseToggle = status === 'running' || status === 'paused';

  const apiKeyPlaceholder = useMemo(() => {
    if (provider === 'ollama') return 'Ollama does not require API key';
    if (provider === 'openrouter') return 'OpenRouter API key (or .env.local)';
    return 'API key';
  }, [provider]);

  const handlePauseToggle = () => {
    if (!canPauseToggle) return;
    const next = !isPaused;
    setIsPaused(next);
    pausedRef.current = next;
    setStatus(next ? 'paused' : 'running');
    appendLog(next ? '[UI] pause requested' : '[UI] resume requested');
  };

  const handleCopyLogs = async () => {
    if (!log.length) return;
    try {
      await navigator.clipboard.writeText(log.join('\n'));
      appendLog('[UI] logs copied to clipboard');
    } catch (e) {
      appendLog(`[UI] failed to copy logs: ${(e as Error).message}`);
    }
  };

  const runExecutor = async (opts: { mode: 'fresh' | 'continue' }) => {
    if (opts.mode === 'fresh' && !taskText.trim()) return;
    if (opts.mode === 'continue' && !resumeCheckpoint) return;

    const runTaskText = opts.mode === 'continue' ? resumeCheckpoint!.taskText : taskText;
    const runProvider = opts.mode === 'continue' ? (resumeCheckpoint!.providerName as ProviderName) : provider;

    try {
      setStatus('running');
      setIsPaused(false);
      pausedRef.current = false;

      if (opts.mode === 'fresh') {
        setLog([]);
        setCurrentStep(null);
        setLastStepResult(null);
        setFinalEntry(null);
        setResumeCheckpoint(null);
      } else {
        appendLog(`[UI] continue requested from stepIndex=${resumeCheckpoint!.nextStepIndex}`);
      }

      appendLog(`Provider selected=${runProvider}`);

      const llmManager = new LLMManager(appendLog);
      llmManager.registerProvider(new GeminiProvider(apiKey));
      llmManager.registerProvider(new OpenRouterProvider(apiKey));
      llmManager.registerProvider(new OllamaProvider());
      llmManager.registerProvider(new OpenAIProvider(apiKey));
      llmManager.registerProvider(new ClaudeProvider(apiKey));
      llmManager.registerProvider(new DeepSeekProvider(apiKey));
      llmManager.setActiveProvider(runProvider);

      const state = new StateManager();
      const mcp = new MCPClient(appendLog);
      const browser = new BrowserController(mcp, appendLog);
      const planner = new TaskPlanner(llmManager, 'auto');

      const executor = new TaskExecutor(
        planner,
        browser,
        state,
        {
          onStatusChange: (s) => {
            setStatus(s);
          },
          onPlanChange: () => {
            // hidden in UI; execution details are available in logs
          },
          onCurrentStep: (index, step) => {
            setCurrentStep({ index, step });
          },
          onStepLog: (msg) => appendLog(msg),
          onStepResult: (_index, _step, result) => {
            setLastStepResult(result);
          },
          onTaskDone: (entry) => {
            setFinalEntry(entry);
            appendLog(`[Done] ${entry.resultSummary}${entry.error ? ` error=${entry.error}` : ''}`);
          },
          onCheckpoint: (checkpoint) => {
            setResumeCheckpoint(checkpoint);
          },
        },
        {
          isPaused: () => pausedRef.current,
        },
        appendLog,
      );

      await executor.run(runTaskText, runProvider, {
        resumeFrom: opts.mode === 'continue' ? resumeCheckpoint : null,
      });
    } catch (e) {
      const err = e as Error;
      appendLog(`Fatal error: ${err.message}`);
      setStatus('error');
    } finally {
      setIsPaused(false);
      pausedRef.current = false;
    }
  };

  const handleRun = async () => {
    await runExecutor({ mode: 'fresh' });
  };

  const handleContinue = async () => {
    await runExecutor({ mode: 'continue' });
  };

  return (
    <div className="app-shell">
      <div className="app-bg-orb app-bg-orb-1" />
      <div className="app-bg-orb app-bg-orb-2" />

      <main className="app-main">
        <section className="hero-card">
          <div className="hero-title-wrap">
            <h1 className="hero-title">Browser Automation</h1>
            <p className="hero-subtitle">Kapture MCP + Multi-LLM Agent</p>
          </div>
          <div className={`status-pill status-${status}`}>{status.toUpperCase()}</div>
        </section>

        <section className="controls-card">
          <div className="control-grid">
            <label className="field-label">
              Provider
              <select
                className="select-input"
                value={provider}
                onChange={(e) => setProvider(e.target.value as ProviderName)}
              >
                <option value="openrouter">OpenRouter</option>
                <option value="gemini">Gemini</option>
                <option value="openai">OpenAI</option>
                <option value="claude">Claude</option>
                <option value="deepseek">DeepSeek</option>
                <option value="ollama">Ollama</option>
              </select>
            </label>

            <label className="field-label">
              API key
              <input
                className="text-input"
                type="password"
                placeholder={apiKeyPlaceholder}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={provider === 'ollama'}
              />
            </label>
          </div>

          <label className="field-label">
            Task
            <textarea
              className="task-input"
              rows={4}
              placeholder="Опишите задачу: найти, заполнить, кликнуть, скопировать/вставить, перетащить, пролистать, распознать текст или изображение..."
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
            />
          </label>

          <div className="button-row">
            <button className="btn btn-primary" onClick={handleRun} disabled={!canRun}>
              {status === 'running' || status === 'paused' ? 'Running...' : 'Run'}
            </button>
            <button className="btn btn-secondary" onClick={handleContinue} disabled={!canContinue}>
              Continue
            </button>
            <button className="btn btn-secondary" onClick={handlePauseToggle} disabled={!canPauseToggle}>
              {isPaused ? 'Resume' : 'Pause'}
            </button>
            <button className="btn btn-tertiary" onClick={handleCopyLogs} disabled={!log.length}>
              Copy logs
            </button>
          </div>
        </section>

        <section className="panel-grid panel-grid-compact">
          <article className="panel-card">
            <h3 className="panel-title">Current step</h3>
            <div className="panel-content">
              {currentStep ? (
                <>
                  <div>#{currentStep.index + 1}</div>
                  <div className="step-action">{currentStep.step.action}</div>
                  <div>{currentStep.step.description}</div>
                </>
              ) : (
                '—'
              )}
            </div>
          </article>

          <article className="panel-card">
            <h3 className="panel-title">User result</h3>
            <div className="panel-content">
              {finalEntry ? (
                <>
                  <div className="step-action">{finalEntry.error ? 'Execution failed' : 'Execution finished'}</div>
                  <div>{finalEntry.resultSummary ?? 'No summary from agent'}</div>
                  {finalEntry.error ? <div>Error: {finalEntry.error}</div> : null}
                  <div>Executed steps: {finalEntry.plan.length}</div>
                  {typeof lastStepResult?.url === 'string' ? <div>Last URL: {lastStepResult.url}</div> : null}
                </>
              ) : (
                'Result will appear here after completion.'
              )}
            </div>
          </article>
        </section>

        <section className="logs-card">
          <div className="logs-head">
            <h3 className="logs-title">Execution log</h3>
            <span className="logs-count">{log.length} lines</span>
          </div>
          <div className="logs-content">
            {log.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
};
