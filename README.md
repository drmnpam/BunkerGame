# Kapture Automation Agent

Desktop-first browser automation agent with multi-LLM orchestration and Kapture MCP execution.

![Kapture Automation Agent Logo](automation-client/branding/logo.png)

## Overview

This project runs user tasks in a real browser tab through Kapture MCP:

1. User enters a task in natural language.
2. LLM provider returns the next browser action.
3. Action is executed through MCP tools.
4. Result is fed back into the loop until completion.

The app is focused on reliable step-by-step execution instead of brittle one-shot plans.

### Auto-Start Features

- **MCP Server**: Automatically starts local MCP server on port 61822
- **Ollama Manager**: Auto-starts Ollama manager on port 5182
- **MCP Client**: App auto-connects to MCP on startup
- **Ollama**: Auto-starts Ollama daemon when provider is selected

## Key Features

- Multi-provider LLM support:
  - OpenRouter
  - Gemini
  - OpenAI
  - Claude
  - DeepSeek
  - Ollama (local)
- MCP WebSocket client for browser control.
- Local MCP server included (no external dependency)
- Auto-start all components via PowerShell launcher
- Tool-based execution loop (`open_url`, `click`, `type`, `wait`, `extract`, `screenshot`).
- Runtime controls in UI:
  - Start / Pause / Continue
  - Copy logs
  - Auto-connect on startup
- Structured logs for LLM, planner, MCP and each step result.

## Repository Structure

- `automation-client/` - React + Vite desktop-style client.
  - `src/core/llm` - provider abstraction and adapters.
  - `src/core/planning` - tool-call planning and schema validation.
  - `src/core/mcp` - Kapture MCP transport and browser controller.
  - `src/core/execution` - agent loop executor and checkpoint/resume flow.
  - `src/core/ollama` - Ollama auto-start control.
  - `scripts/mcp-server.js` - Local MCP WebSocket server.
  - `scripts/ollama-manager-server.js` - Ollama process manager.
  - `scripts/start-automation-client.ps1` - one-click launcher script.
  - `Run Automation Client.cmd` - Windows launcher entrypoint.

## Requirements

- Node.js 18+
- Kapture browser extension connected to at least one tab
- API key for selected provider (unless using local Ollama)

### Components Auto-Started by Launcher

| Component | Port | Description |
|-----------|------|-------------|
| MCP Server | 61822 | Local WebSocket MCP server |
| Ollama Manager | 5182 | Ollama process controller |
| Dev Server | 5180 | React + Vite web UI |
| Browser | - | Auto-opened for automation |

## Local Ollama setup (recommended for offline / self-hosted usage)

1. Install Ollama:
   - https://ollama.com/docs/installation
2. The app will auto-start Ollama when you select the Ollama provider in the UI
3. Or manually run Ollama daemon:
   - `ollama serve`
   - Или с явным портом (в случае прокси): `ollama serve --port 11434`
4. Установите модель (пример):
   - `ollama pull llama3.1`
5. Настройте приложение:
   - в `automation-client/.env.local` (или `.env.example`):
     - `VITE_OLLAMA_URL=http://127.0.0.1:11434`

Если вы запускаете клиент из браузера и встречаете CORS, используйте прокси:
- Node.js / Express:
  - `app.use('/ollama', createProxyMiddleware({ target: 'http://127.0.0.1:11434', changeOrigin: true }));`
  - `VITE_OLLAMA_URL=http://localhost:5180/ollama`

Примеры аналогичных репозиториев:
- https://github.com/jmorganca/ollama-nextjs
- https://github.com/ollama/web-ui

## Enhancements included

Implemented improvements:
- Local MCP server (`scripts/mcp-server.js`) - no external dependency
- Auto-start all components via PowerShell launcher
- MCP client auto-connect on app startup
- Ollama auto-start when provider selected
- OllamaProxy + CORS handling, `VITE_OLLAMA_URL`
- vitest tests + coverage
- runtime provider status in UI (Ollama availability)
- app logs + status management
- `TaskExecutor`/LLMManager robustness extension

## Quick Start

### One-Click Launch (Windows)

Double-click `Run Automation Client.cmd` - it will automatically:
1. Start MCP server (port 61822)
2. Start Ollama manager (port 5182)
3. Start dev server (port 5180)
4. Open browser for automation

### Manual Launch

1. Configure environment:
   - copy `automation-client/.env.example` to `.env.local` if needed
   - set provider keys
   - optional browser auto-open settings:
     - `KAPTURE_AUTO_OPEN_BROWSER=true`
     - `KAPTURE_BROWSER_PATH=<full path to chrome/edge/yandex>`
     - `KAPTURE_AUTOMATION_URL=https://hh.ru`
2. Install and run:
   - `cd automation-client`
   - `npm install`
   - `npm run dev -- --host 127.0.0.1 --port 5180`
3. Open:
   - [http://127.0.0.1:5180](http://127.0.0.1:5180)

## Default MCP Endpoint

- `ws://localhost:61822/mcp`

## Build

- `cd automation-client`
- `npm run build`

## Notes

- If no tabs are connected in Kapture, execution will fail until the extension is attached.
- If another debugger is already attached to the tab, screenshot/DOM tools may fail until that conflict is resolved.
- `Run Automation Client.cmd` auto-starts all required components (MCP, Ollama manager, dev server)
