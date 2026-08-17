/**
 * mcpBridge.ts → dist/mcp-bridge.cjs
 * Stdio MCP server. Bridges Claude Code / Cursor <-> NoteVs HTTP server.
 * Automatically injects process.cwd() as folderPath so notes are always
 * scoped to the repo the agent is running in.
 */

import * as http from 'http';
import * as readline from 'readline';

const PORT = 37492;
const BASE = `http://127.0.0.1:${PORT}`;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function httpGet(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

function httpPost(path: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: PORT, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function send(msg: JsonRpcResponse): void { process.stdout.write(JSON.stringify(msg) + '\n'); }
function sendError(id: number | string | null, code: number, message: string): void { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function checkExtension(): Promise<boolean> {
  try { const r = await httpGet('/health') as { ok?: boolean }; return r.ok === true; } catch { return false; }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line: string) => {
    let req: JsonRpcRequest;
    try { req = JSON.parse(line.trim()) as JsonRpcRequest; } catch { sendError(null, -32700, 'Parse error'); return; }
    const { id, method, params } = req;

    switch (method) {
      case 'initialize':
        send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'notevs-mcp', version: '1.0.0' } } });
        break;

      case 'notifications/initialized':
        break;

      case 'tools/list':
        try {
          const r = await httpGet('/tools') as { tools?: unknown[] };
          send({ jsonrpc: '2.0', id, result: { tools: r.tools ?? [] } });
        } catch { sendError(id, -32603, 'NoteVs extension not running. Open VS Code with NoteVs installed.'); }
        break;

      case 'tools/call': {
        const alive = await checkExtension();
        if (!alive) { sendError(id, -32603, 'NoteVs extension not running. Open VS Code with NoteVs installed.'); break; }

        const { name, arguments: args = {} } = params as { name: string; arguments?: Record<string, unknown> };

        // ── Inject cwd so notes are scoped to the agent's current repo ──────
        const enrichedArgs = { folderPath: process.cwd(), ...args };

        try {
          const r = await httpPost('/call', { tool: name, args: enrichedArgs }) as { result?: unknown; error?: string };
          if (r.error) { sendError(id, -32603, r.error); break; }
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r.result, null, 2) }], isError: false } });
        } catch (err: unknown) {
          sendError(id, -32603, `Tool call failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  });

  rl.on('close', () => { process.exit(0); });

  const alive = await checkExtension();
  process.stderr.write(alive
    ? `[NoteVs MCP] Connected. Scoping notes to: ${process.cwd()}\n`
    : '[NoteVs MCP] Warning: VS Code extension not detected on port 37492.\n');
}

main().catch((err) => { process.stderr.write(`[NoteVs MCP] Fatal: ${err}\n`); process.exit(1); });
