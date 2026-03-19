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

## Key Features

- Multi-provider LLM support:
  - OpenRouter
  - Gemini
  - OpenAI
  - Claude
  - DeepSeek
  - Ollama (local)
- MCP WebSocket client for browser control.
- Tool-based execution loop (`open_url`, `click`, `type`, `wait`, `extract`, `screenshot`).
- Runtime controls in UI:
  - Start
  - Pause / Continue
  - Copy logs
- Structured logs for LLM, planner, MCP and each step result.

## Repository Structure

- `automation-client/` - React + Vite desktop-style client.
  - `src/core/llm` - provider abstraction and adapters.
  - `src/core/planning` - tool-call planning and schema validation.
  - `src/core/mcp` - Kapture MCP transport and browser controller.
  - `src/core/execution` - agent loop executor and checkpoint/resume flow.
  - `scripts/start-automation-client.ps1` - one-click launcher script.
  - `Run Automation Client.cmd` - Windows launcher entrypoint.

## Requirements

- Node.js 18+
- Running Kapture MCP server
- Kapture browser extension connected to at least one tab
- API key for selected provider (unless using local Ollama)

## Quick Start

1. Configure environment:
   - copy `automation-client/.env.example` to `.env.local` if needed
   - set provider keys and MCP URL
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
