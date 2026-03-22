# Complete Logging Implementation

## Browser-Side Logging (OllamaProvider)

### File: `src/core/llm/providers/OllamaProvider.ts`

#### 1. Constructor
- Optional `logger` parameter for detailed diagnostics
- All instances pass `appendLog` from App.tsx

#### 2. isAvailable() Method
Logs:
- `[Ollama] checking availability at http://127.0.0.1:5182/api/tags...`
- `[Ollama] available (HTTP 200)` or `[Ollama] unavailable (HTTP XXX)`
- `[Ollama] connection failed: {error message}`

#### 3. generate() Method
Logs:
- `[Ollama] generate request: model=llama3.1 baseUrl=http://127.0.0.1:5182 endpoint=... promptLength=XXXX`
- On success: `[Ollama] response received: length=XXXX`
- On error: `[Ollama] ERROR: Ollama fetch failed: {message} (endpoint={url})`

Error types logged:
- Network: "Failed to fetch", connection refused, timeout
- API: HTTP error responses
- Parse: JSON parse errors

---

## Node.js Manager Server Logging

### File: `scripts/ollama-manager-server.js`

#### 1. CORS Middleware
```
[Manager] Initial request received (middleware logs all requests with headers)
```

#### 2. GET /status
```
[Manager] GET /status - checking Ollama at http://127.0.0.1:11434
[Manager] Ollama status: available=true/false models=N
[Manager] Status check failed: {error message}
```

#### 3. POST /start
```
[Manager] POST /start - start Ollama request
[Manager] Ollama already running (PID: XXXX)
[Manager] Spawning ollama serve --port 11434...
[Manager] Checking if Ollama is actually running...
[Manager] Ollama started successfully (PID: XXXX)
[Manager] Ollama started but not responding: {error message}
[Manager] Start failed: {error message}
```

#### 4. POST /stop
```
[Manager] POST /stop - stop Ollama request
[Manager] Killing Ollama process (PID: XXXX)
[Manager] Ollama stopped successfully
[Manager] Stop failed: {error message}
[Manager] No Ollama process to stop
```

#### 5. GET /api/tags (Proxy)
```
[Manager] GET /api/tags - proxying to Ollama at http://127.0.0.1:11434/api/tags
[Manager] /api/tags response: HTTP 200
[Manager] /api/tags success: {model_count} models available
[Manager] /api/tags proxy failed: {error message}
[Manager] /api/tags error stack: ... (full stack trace)
```

#### 6. POST /api/chat (Proxy)
```
[Manager] POST /api/chat - received request (model=llama3.1 bodySize=XXXX)
[Manager] Proxying to Ollama at http://127.0.0.1:11434/api/chat
[Manager] /api/chat response: HTTP 200
[Manager] /api/chat success: content length=XXXX
[Manager] /api/chat Ollama error: HTTP XXX - {error text}
[Manager] /api/chat proxy failed: {error message}
[Manager] Error name: {error name}
[Manager] Error code: {error code}
[Manager] Error stack: ... (full stack trace)
```

---

## LLM Manager (Browser-Side)

### File: `src/core/llm/LLMManager.ts`

#### Provider Initialization
```
[LLM] request candidates=ollama model=auto retries=1 strictMode=true
[LLM] prompt summary: systemChars=XXXX userPreview="..."
```

#### Provider Availability Check (non-strict mode only)
```
[LLM] skip provider=ollama isAvailable=false (activeProvider=ollama)
[LLM] trying provider=ollama
```

#### Retry Loop
```
[LLM] withRetry attempt 1/3 calling ollama.generate()
[LLM] attempt 1 failed provider=ollama: "{message}"; kind={kind}; sleep 350ms
[LLM] attempt 2 failed provider=ollama: "{message}"; kind={kind}; sleep 700ms
[LLM] not retrying kind={kind} - breaking retry loop
[LLM] withRetry exhausted all attempts for ollama, throwing: "{message}"
```

Error kinds:
- `network` - fetch failed, connection issues
- `api` - HTTP error from server
- `timeout` - request took too long
- `model` - model not found
- `unavailable` - service unavailable
- `logic` - parsing or format error

#### Success
```
[LLM] response success provider=ollama model=llama3.1 preview="content preview..."
```

---

## App.tsx (Browser UI)

#### Provider Selection
```
[UI] Provider selected: ollama (will NOT fallback to other providers)
[UI] Provider changed to: ollama (checkpoint cleared)
[UI] LLM Manager initialized with ollama as strict primary
```

#### Ollama Availability Checking
```
[UI] checking Ollama availability at http://127.0.0.1:5182...
[UI] Ollama available: true/false
[UI] Ollama check failed: {error message}
```

#### Start/Stop Ollama
```
[UI] Waiting for Ollama to fully start...
[UI] Ollama started successfully and is available
[UI] Ollama started but still not available - check installation
```

---

## Data Flow with Logging

### Request Path:
```
App.tsx: [UI] Provider selected
  ↓
LLMManager: [LLM] request candidates=ollama
  ↓
OllamaProvider.generate(): [Ollama] generate request → fetch()
  ↓
Manager: [Manager] POST /api/chat received
  ↓
Manager: [Manager] Proxying to Ollama at http://127.0.0.1:11434
  ↓
Real Ollama: processes request
  ↓
Manager: [Manager] /api/chat response: HTTP 200
  ↓
Manager: [Manager] /api/chat success
  ↓
OllamaProvider: [Ollama] response received
  ↓
LLMManager: [LLM] response success
  ↓
TaskExecutor: processes tool call
```

### Error Path:
```
OllamaProvider: [Ollama] ERROR: Ollama fetch failed
  ↓
LLMManager: [LLM] attempt 1 failed ... kind=network
  ↓
LLMManager: [LLM] attempt 2 failed ... kind=network
  ↓
LLMManager: [LLM] withRetry exhausted all attempts
  ↓
TaskPlanner: [PlannerError] Failed to fetch or {actual error}
  ↓
App.tsx: Fatal error
```

---

## How to Capture Complete Diagnostics

1. **Browser Console** (F12):
   - All [UI], [Ollama], [LLM] logs
   - Shows timing and sequence
   - Include timestamps

2. **Manager Server Console** (npm run serve:ollama):
   - All [Manager] logs
   - Connection details and proxying status
   - Include full error stacks

3. **Ollama Console** (if running):
   - Ollama's own debug logs
   - Model loading status
   - API response times

4. **Full Flow Test**:
```
# Terminal 1: Manager
npm run serve:ollama
# Should show: [Manager] Ollama manager listening on http://localhost:5182

# Terminal 2: App
npm run dev
# Should show: ✓ Local: http://127.0.0.1:5180/

# Browser: Open http://127.0.0.1:5180
# Open DevTools Console (F12)
# Select Ollama provider
# Should see: [UI] Provider selected: ollama
# Enter simple task: "test"
# Should see complete log flow ending in either success or specific error
```
