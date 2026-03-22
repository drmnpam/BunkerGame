import express from 'express';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app = express();

// Enable CORS for all routes to allow browser requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

let ollamaProcess = null;

app.get('/status', async (req, res) => {
  try {
    console.log('[Manager] GET /status - checking Ollama at http://127.0.0.1:11434');
    const response = await fetch('http://127.0.0.1:11434/api/tags', { timeout: 5000 });
    const available = response.ok;
    const data = available ? await response.json() : null;
    console.log(`[Manager] Ollama status: available=${available} models=${data?.models?.length ?? 0}`);
    res.json({ available, running: !!ollamaProcess, models: data?.models || [] });
  } catch (err) {
    console.error(`[Manager] Status check failed: ${err.message}`);
    res.json({ available: false, running: !!ollamaProcess, models: [] });
  }
});

app.post('/start', async (req, res) => {
  console.log('[Manager] POST /start - start Ollama request');
  if (ollamaProcess) {
    console.log(`[Manager] Ollama already running (PID: ${ollamaProcess.pid})`);
    return res.json({ status: 'already running', pid: ollamaProcess.pid });
  }

  try {
    // Try to start ollama directly
    console.log('[Manager] Spawning ollama serve --port 11434...');
    ollamaProcess = spawn('ollama', ['serve', '--port', '11434'], {
      detached: true,
      stdio: 'ignore',
    });
    ollamaProcess.unref();

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 2000));

    // Check if it's actually running
    try {
      console.log('[Manager] Checking if Ollama is actually running...');
      const response = await fetch('http://127.0.0.1:11434/api/tags', { timeout: 5000 });
      if (response.ok) {
        console.log(`[Manager] Ollama started successfully (PID: ${ollamaProcess.pid})`);
        return res.json({ status: 'started', pid: ollamaProcess.pid });
      }
    } catch (e) {
      console.error(`[Manager] Ollama started but not responding: ${e.message}`);
      // ignore
    }

    res.status(500).json({ error: 'Failed to start Ollama. Is it installed and in PATH?' });
  } catch (err) {
    console.error(`[Manager] Start failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/stop', (req, res) => {
  console.log('[Manager] POST /stop - stop Ollama request');
  if (ollamaProcess) {
    try {
      console.log(`[Manager] Killing Ollama process (PID: ${ollamaProcess.pid})`);
      process.kill(-ollamaProcess.pid);
      ollamaProcess = null;
      console.log('[Manager] Ollama stopped successfully');
      res.json({ status: 'stopped' });
    } catch (err) {
      console.error(`[Manager] Stop failed: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  } else {
    console.log('[Manager] No Ollama process to stop');
    res.json({ status: 'not running' });
  }
});

// Proxy endpoints to forward requests to actual Ollama instance
// This allows browser clients to communicate with Ollama through this manager
app.get('/api/tags', async (req, res) => {
  try {
    console.log('[Manager] GET /api/tags - proxying to Ollama at http://127.0.0.1:11434/api/tags');
    const response = await fetch('http://127.0.0.1:11434/api/tags', { timeout: 5000 });
    console.log(`[Manager] /api/tags response: HTTP ${response.status}`);
    const data = await response.json();
    console.log(`[Manager] /api/tags success: ${data?.models?.length} models available`);
    res.json(data);
  } catch (err) {
    console.error(`[Manager] /api/tags proxy failed: ${err.message}`);
    console.error(`[Manager] /api/tags error stack: ${err.stack}`);
    res.status(500).json({ error: `Proxy failed: ${err.message}` });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const model = req.body?.model || 'unknown';
    const promptLength = JSON.stringify(req.body).length;
    console.log(`[Manager] POST /api/chat - received request (model=${model} bodySize=${promptLength})`);
    console.log(`[Manager] Proxying to Ollama at http://127.0.0.1:11434/api/chat`);
    
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      timeout: 60000,
    });
    
    console.log(`[Manager] /api/chat response: HTTP ${response.status}`);
    
    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Manager] /api/chat Ollama error: HTTP ${response.status} - ${errText.substring(0, 200)}`);
      return res.status(response.status).json({ error: errText });
    }
    
    const data = await response.json();
    const contentLength = data?.message?.content?.length || 0;
    console.log(`[Manager] /api/chat success: content length=${contentLength}`);
    res.json(data);
  } catch (err) {
    console.error(`[Manager] /api/chat proxy failed: ${err.message}`);
    console.error(`[Manager] Error name: ${err.name}`);
    console.error(`[Manager] Error code: ${err.code}`);
    console.error(`[Manager] Error stack: ${err.stack}`);
    res.status(500).json({ error: `Proxy failed: ${err.message}` });
  }
});

const port = process.env.PORT || 5182;
app.listen(port, () => {
  console.log(`[Manager] Ollama manager listening on http://localhost:${port}`);
});
