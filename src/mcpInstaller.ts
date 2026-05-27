import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BRIDGE_DIR  = path.join(os.homedir(), '.notevs');
const BRIDGE_DEST = path.join(BRIDGE_DIR, 'mcp-bridge.cjs');

const MCP_ENTRY = { type: 'stdio', command: 'node', args: [BRIDGE_DEST] };

function upsertMcpConfig(configPath: string): void {
  let config: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch { /* corrupt or missing */ }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers['notevs'] = MCP_ENTRY;
  config.mcpServers = servers;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

export function installMcpBridge(context: vscode.ExtensionContext): void {
  try {
    const src = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-bridge.cjs').fsPath;
    if (!fs.existsSync(src)) { return; }
    fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    fs.copyFileSync(src, BRIDGE_DEST);
    try { fs.chmodSync(BRIDGE_DEST, 0o755); } catch { /* Windows no-op */ }
    // Claude Code
    try { upsertMcpConfig(path.join(os.homedir(), '.claude.json')); } catch { /* skip */ }
    // Cursor
    try { upsertMcpConfig(path.join(os.homedir(), '.cursor', 'mcp.json')); } catch { /* skip */ }
    // VS Code Copilot agent mode
    try { upsertMcpConfig(path.join(os.homedir(), '.vscode', 'mcp.json')); } catch { /* skip */ }
  } catch { /* never crash the extension */ }
}
