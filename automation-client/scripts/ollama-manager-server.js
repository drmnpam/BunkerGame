import express from 'express';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

let ollamaProcess: any = null;

app.get('/status', async (req, res) => {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags');
    const available = response.ok;
    const data = available ? await response.json() : null;
    res.json({ available, running: !!ollamaProcess, models: data?.models || [] });
  } catch {
    res.json({ available: false, running: !!ollamaProcess, models: [] });
  }
});

app.post('/start', async (req, res) => {
  if (ollamaProcess) {
    return res.json({ status: 'already running', pid: ollamaProcess.pid });
  }

  try {
    // Try to start ollama directly
    ollamaProcess = spawn('ollama', ['serve', '--port', '11434'], {
      detached: true,
      stdio: 'ignore',
    });
    ollamaProcess.unref();

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 2000));

    // Check if it's actually running
    try {
      const response = await fetch('http://127.0.0.1:11434/api/tags');
      if (response.ok) {
        return res.json({ status: 'started', pid: ollamaProcess.pid });
      }
    } catch {
      // ignore
    }

    res.status(500).json({ error: 'Failed to start Ollama. Is it installed and in PATH?' });
  } catch (err) {
    res.status(500).json({ error: (err as any).message });
  }
});

app.post('/stop', (req, res) => {
  if (ollamaProcess) {
    try {
      process.kill(-ollamaProcess.pid);
      ollamaProcess = null;
      res.json({ status: 'stopped' });
    } catch (err) {
      res.status(500).json({ error: (err as any).message });
    }
  } else {
    res.json({ status: 'not running' });
  }
});

const port = process.env.PORT || 5182;
app.listen(port, () => {
  console.log(`Ollama manager listening on http://localhost:${port}`);
});
