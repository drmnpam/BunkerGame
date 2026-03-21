import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import net from 'net';

const MCP_PORT = process.env.MCP_PORT || 61822;
const MCP_HOST = process.env.MCP_HOST || '127.0.0.1';

// Connected browser tabs
const tabs = new Map();
let tabIdCounter = 1;

// Track pending operations from client
const pendingOperations = new Map();

function createResponse(req, result, error) {
  if (error) {
    return { jsonrpc: '2.0', id: req.id, error };
  }
  return { jsonrpc: '2.0', id: req.id, result };
}

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer, path: '/mcp' });

// Browser extension connections
const browserWss = new WebSocketServer({ server: httpServer, path: '/browser' });

// Handle browser extension connections
browserWss.on('connection', (ws) => {
  const tabId = `tab-${tabIdCounter++}`;
  console.log(`[MCP] Browser connected: ${tabId}`);
  tabs.set(tabId, { ws });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Handle browser responses to pending operations
      if (msg.id && pendingOperations.has(msg.id)) {
        const pending = pendingOperations.get(msg.id);
        pendingOperations.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
    } catch (e) {
      console.error('[MCP] Error handling browser message:', e);
    }
  });

  ws.on('close', () => {
    console.log(`[MCP] Browser disconnected: ${tabId}`);
    tabs.delete(tabId);
  });

  ws.on('error', (err) => {
    console.error(`[MCP] Browser error ${tabId}:`, err.message);
  });
});

// Handle MCP client connections
wss.on('connection', (ws) => {
  console.log('[MCP] Client connected');

  ws.on('message', async (data) => {
    try {
      const raw = data.toString();
      console.log(`[MCP] Raw message: ${raw.substring(0, 200)}`);
      const req = JSON.parse(raw);
      console.log(`[MCP] Request: ${req.method} (id=${req.id})`);

      // Handle initialize
      if (req.method === 'initialize') {
        ws.send(JSON.stringify(createResponse(req, { 
          protocolVersion: '2024-11-05', 
          serverInfo: { name: 'kapture-mcp-server', version: '1.0.0' }, 
          capabilities: {} 
        })));
        return;
      }

      // Handle tools/list
      if (req.method === 'tools/list') {
        ws.send(JSON.stringify(createResponse(req, {
          tools: [
            { name: 'list_tabs', description: 'List connected browser tabs' },
            { name: 'new_tab', description: 'Open new browser tab' },
            { name: 'navigate', description: 'Navigate tab to URL' },
            { name: 'click', description: 'Click element by selector' },
            { name: 'fill', description: 'Fill input by selector' },
            { name: 'type', description: 'Type text into element' },
            { name: 'screenshot', description: 'Take screenshot' },
            { name: 'get_html', description: 'Get page HTML' },
            { name: 'get_text', description: 'Get page text content' },
            { name: 'find_element', description: 'Find element by selector' },
            { name: 'scroll', description: 'Scroll page' },
          ]
        })));
        return;
      }

      // Handle tools/call - forward to browser
      if (req.method === 'tools/call') {
        const { name, arguments: args } = req.params || {};
        
        // Find first available tab
        const firstTab = tabs.entries().next().value;
        if (!firstTab) {
          ws.send(JSON.stringify(createResponse(req, undefined, { 
            code: -32000, 
            message: 'No browser tabs connected. Open Kapture extension.' 
          })));
          return;
        }

        const [tabId, tab] = firstTab;
        
        // Forward to browser and wait for response
        try {
          const result = await forwardToBrowser(tab.ws, req.id, name, { ...args, tabId });
          ws.send(JSON.stringify(createResponse(req, { 
            content: [{ type: 'text', text: JSON.stringify(result) }] 
          })));
        } catch (err) {
          ws.send(JSON.stringify(createResponse(req, undefined, { 
            code: -32000, 
            message: err.message 
          })));
        }
        return;
      }

      // Default response
      ws.send(JSON.stringify(createResponse(req, undefined, { 
        code: -32601, 
        message: `Method not found: ${req.method}` 
      })));
    } catch (e) {
      console.error('[MCP] Error processing message:', e.message);
      console.error('[MCP] Stack:', e.stack);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    }
  });

  ws.on('close', () => {
    console.log('[MCP] Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[MCP] Client error:', err.message);
  });
});

function forwardToBrowser(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingOperations.delete(id);
      reject(new Error('Browser operation timeout'));
    }, 30000);

    pendingOperations.set(id, {
      resolve: (v) => {
        clearTimeout(timeout);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      }
    });

    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Check if port is already in use
function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(true))
      .once('listening', () => {
        tester.close();
        resolve(false);
      })
      .listen(port, MCP_HOST);
  });
}

async function start() {
  const inUse = await isPortInUse(Number(MCP_PORT));
  if (inUse) {
    console.log(`[MCP] Port ${MCP_PORT} already in use, server may already be running`);
    process.exit(0);
  }

  httpServer.listen(Number(MCP_PORT), MCP_HOST, () => {
    console.log(`[MCP] Server running on ws://${MCP_HOST}:${MCP_PORT}/mcp`);
    console.log(`[MCP] Browser extension endpoint: ws://${MCP_HOST}:${MCP_PORT}/browser`);
  });
}

start().catch(console.error);
