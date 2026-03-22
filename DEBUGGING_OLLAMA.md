# Ollama Integration Debugging Guide

## "Failed to fetch" Error - Complete Diagnostics

If you see `[LLM] attempt 1 failed provider=ollama: Failed to fetch` in logs, follow this checklist:

### 1. Check Manager Server is Running
Look for these logs in **manager console** (npm run serve:ollama):
```
[Manager] Ollama manager listening on http://localhost:5182
```

**If NOT present:**
- Manager is not running. Start it: `npm run serve:ollama`
- Check console for startup errors

### 2. Check Browser-to-Manager Connection
Look for in browser console logs:
```
[Manager] GET /api/tags - proxying to Ollama at http://127.0.0.1:11434/api/tags
[Manager] /api/tags response: HTTP 200
```

**If you see:**
- `[Manager] /api/tags proxy failed: ...` → Manager can't reach Ollama on 11434
- No [Manager] logs at all → Browser request never reached manager

### 3. Check Ollama Server on Port 11434
Manager server logs should show:
```
[Manager] POST /api/chat - received request (model=llama3.1 bodySize=XXXX)
[Manager] Proxying to Ollama at http://127.0.0.1:11434/api/chat
[Manager] /api/chat response: HTTP 200
[Manager] /api/chat success: content length=XXXX
```

**If you see different HTTP codes:**
- HTTP 404 → Ollama not listening on 11434 or wrong port
- HTTP 500 → Ollama error (check Ollama console)
- Connection failed → Ollama not running at all

### 4. Browser OllamaProvider Logs
Look for:
```
[Ollama] generate request: model=llama3.1 baseUrl=http://127.0.0.1:5182 endpoint=http://127.0.0.1:5182/api/chat promptLength=6809
```

**If you see:**
- `[Ollama] ERROR: Ollama fetch failed: ...` → Network error, check manager
- `[Ollama] response received: length=XXXX` → Success!

### 5. LLMManager Tracking
```
[LLM] trying provider=ollama
[LLM] withRetry attempt 1/3 calling ollama.generate()
[LLM] attempt 1 failed provider=ollama: "..."; kind=network; sleep 350ms
[LLM] attempt 2 failed provider=ollama: "..."; kind=network; sleep 700ms
[LLM] withRetry exhausted all attempts for ollama, throwing: "Failed to fetch"
```

## Minimal Working Setup

```
Console 1: npm run serve:ollama
[Manager] Ollama manager listening on http://localhost:5182

Console 2: npm run dev
✓ Local: http://127.0.0.1:5180/

Browser:
1. Open DevTools Console
2. Select "Ollama" provider
3. Enter task
4. Watch logs for [UI], [Ollama], [Manager], and [LLM] prefixes
```

## Common Issues

| Error | Cause | Fix |
|-------|-------|-----|
| `Failed to fetch` at 5182 | Manager not running | `npm run serve:ollama` |
| Manager logs show "proxy failed" | Ollama not on 11434 | Start Ollama or check port |
| HTTP 404 from /api/chat | Ollama version mismatch | Check Ollama version supports /api/chat |
| Manager logs are missing | Browser or manager disabled console | Re-enable console logging |

## Log Prefixes Reference

- `[UI]` - Browser UI state changes
- `[Ollama]` - OllamaProvider fetch/response details  
- `[LLM]` - LLMManager provider selection and retries
- `[Manager]` - Manager server proxying logs
- `[MCP]` - Kapture MCP connection
- `[Executor]` - Task execution loop

All timestamps are in HH:MM:SS format in browser console.
