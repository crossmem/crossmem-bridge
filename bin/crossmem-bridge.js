#!/usr/bin/env node
// crossmem-bridge — WebSocket relay between CLI and crossmem Chrome extension
// Usage: npx crossmem-bridge

import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

const PORT = process.env.BRIDGE_PORT || 7600;
const CWS_URL = 'https://chromewebstore.google.com/detail/crossmem/kmpfhoimimgfdglaglpjegjiahkfolpa';
let extensionWs = null;
const pending = new Map();

// HTTP server for CLI commands
const httpServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: extensionWs?.readyState === WebSocket.OPEN,
      pending: pending.size,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/command') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const cmd = JSON.parse(body);
        if (!cmd.id) cmd.id = randomUUID();

        if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Extension not connected. Is Chrome running with crossmem installed?' }));
          return;
        }

        const timeout = cmd.timeout || 30000;
        const result = await sendToExtension(cmd, timeout);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// WebSocket server for extension
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('[bridge] ✅ extension connected');
  extensionWs = ws;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'llm') {
        handleLlmRequest(msg, ws);
        return;
      }

      if (msg.type === 'save_memory') {
        handleSaveMemory(msg, ws);
        return;
      }

      if (msg.type === 'open_file') {
        const filePath = msg.path.replace(/^~/, homedir());
        if (existsSync(filePath)) {
          spawn('open', ['-R', filePath]);
        } else {
          for (const ext of ['.pdf', '.png', '.jpg']) {
            if (existsSync(filePath + ext)) {
              spawn('open', ['-R', filePath + ext]);
              return;
            }
          }
          const dir = filePath.substring(0, filePath.lastIndexOf('/'));
          if (existsSync(dir)) spawn('open', [dir]);
        }
        return;
      }

      const p = pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(msg.id);
        p.resolve(msg);
      }
    } catch {}
  });

  ws.on('close', () => {
    console.log('[bridge] extension disconnected');
    if (extensionWs === ws) extensionWs = null;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ id, success: false, error: 'Extension disconnected' });
    }
    pending.clear();
  });
});

function sendToExtension(cmd, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(cmd.id);
      resolve({ id: cmd.id, success: false, error: `Timeout after ${timeout}ms` });
    }, timeout);
    pending.set(cmd.id, { resolve, timer });
    extensionWs.send(JSON.stringify(cmd));
  });
}

// Reverse channel: extension → local Claude Code
function handleLlmRequest(msg, ws) {
  const { id, prompt } = msg;
  console.log(`[bridge:llm] request: ${prompt.slice(0, 80)}...`);

  const proc = spawn('claude', ['-p', prompt], {
    env: { ...process.env, ANTHROPIC_API_KEY: '' },
    timeout: 120000,
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk; });
  proc.stderr.on('data', (chunk) => { stderr += chunk; });

  proc.on('close', (code) => {
    if (code === 0) {
      console.log(`[bridge:llm] done (${stdout.length} chars)`);
      ws.send(JSON.stringify({ type: 'llm_response', id, success: true, data: stdout.trim() }));
    } else {
      console.error(`[bridge:llm] failed: ${stderr}`);
      ws.send(JSON.stringify({ type: 'llm_response', id, success: false, error: stderr || `exit ${code}` }));
    }
  });

  proc.on('error', (err) => {
    ws.send(JSON.stringify({ type: 'llm_response', id, success: false, error: err.message }));
  });
}

// Reverse channel: extension → save memory to ~/crossmem/{raw,wiki}
const CROSSMEM_DIR = join(homedir(), 'crossmem');

async function handleSaveMemory(msg, ws) {
  const { id, data } = msg;
  const { slug, date, screenshot, markdown, arxivId } = data;

  try {
    const rawDir = join(CROSSMEM_DIR, 'raw');
    const wikiDir = join(CROSSMEM_DIR, 'wiki');
    await mkdir(rawDir, { recursive: true });
    await mkdir(wikiDir, { recursive: true });

    const baseName = `${date}_${slug}`;
    const files = [];

    if (arxivId) {
      const pdfPath = join(rawDir, `${baseName}.pdf`);
      try {
        const pdfUrl = `https://arxiv.org/pdf/${arxivId}`;
        console.log(`[bridge:save] downloading arxiv PDF: ${pdfUrl}`);
        const res = await fetch(pdfUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 50 * 1024 * 1024) {
            console.warn(`[bridge:save] PDF too large (${(buf.length / 1024 / 1024).toFixed(1)}MB), skipping`);
          } else {
            await writeFile(pdfPath, buf);
            files.push(pdfPath);
            console.log(`[bridge:save] raw (pdf): ${pdfPath} (${(buf.length / 1024).toFixed(0)}KB)`);
          }
        }
      } catch (pdfErr) {
        console.warn(`[bridge:save] arxiv PDF download error:`, pdfErr.message);
      }
    } else if (screenshot) {
      const pngPath = join(rawDir, `${baseName}.png`);
      const base64 = screenshot.replace(/^data:image\/png;base64,/, '');
      await writeFile(pngPath, Buffer.from(base64, 'base64'));
      files.push(pngPath);
      console.log(`[bridge:save] raw (png): ${pngPath}`);
    }

    if (markdown) {
      const mdPath = join(wikiDir, `${baseName}.md`);
      await writeFile(mdPath, markdown, 'utf-8');
      files.push(mdPath);
      console.log(`[bridge:save] wiki: ${mdPath}`);
    }

    const wikiPath = join(wikiDir, `${baseName}.md`);
    const rawPath = files.length > 0 ? files[0] : null;
    ws.send(JSON.stringify({ type: 'save_memory_response', id, success: true, data: { files, wikiPath, rawPath } }));
  } catch (err) {
    console.error(`[bridge:save] failed:`, err);
    ws.send(JSON.stringify({ type: 'save_memory_response', id, success: false, error: err.message }));
  }
}

// Auto-open CWS if extension doesn't connect within 10s
let cwsOpened = false;
setTimeout(() => {
  if (!extensionWs && !cwsOpened) {
    cwsOpened = true;
    console.log('[bridge] Extension not detected. Install it:');
    console.log(`[bridge] → ${CWS_URL}`);
    if (platform() === 'darwin') {
      spawn('open', [CWS_URL]);
    } else if (platform() === 'win32') {
      spawn('start', [CWS_URL], { shell: true });
    } else {
      spawn('xdg-open', [CWS_URL]);
    }
  }
}, 10000);

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] crossmem-bridge v${process.env.npm_package_version || '0.1.0'}`);
  console.log(`[bridge] relay server on http://127.0.0.1:${PORT}`);
  console.log('[bridge] POST /command — send commands to extension');
  console.log('[bridge] GET  /status  — check connection status');
  console.log('[bridge] waiting for extension...');
});
