import * as vscode from 'vscode';
import axios from 'axios';
import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { installMcpBridge } from './mcpInstaller';
import { startMcpServer, type OnNoteMutated } from './mcpServer';
import {
  sendToNotion, clearNotionToken, resetNotionPage, hasNotionToken,
  sendToObsidian, clearObsidianApiKey, clearObsidianVaultPath, getObsidianStatus,
} from './integrations';
import {
  sendToTodoist, hasTodoistToken, clearTodoistToken,
  sendToGoogleTasks, isGoogleTasksConnected, disconnectGoogleTasks, connectGoogleTasks,
  sendToTaskProvider, clearTaskProviderPreference,
  manageExistingReminder,
  type OnRemindedCallback,
} from './taskIntegrations';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApiUrl(): string {
  return vscode.workspace.getConfiguration('notevs').get('apiUrl', 'http://localhost:3001');
}
function getFolderPath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) { return null; }
  try { return fs.realpathSync(folders[0].uri.fsPath); } catch { return folders[0].uri.fsPath; }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function getTokens(s: vscode.SecretStorage) {
  return { accessToken: (await s.get('accessToken')) || null, refreshToken: (await s.get('refreshToken')) || null };
}
async function setTokens(s: vscode.SecretStorage, a: string, r: string) {
  await s.store('accessToken', a); await s.store('refreshToken', r);
}
async function clearTokens(s: vscode.SecretStorage) {
  await s.delete('accessToken'); await s.delete('refreshToken'); await s.delete('user');
}
async function refreshAccessToken(s: vscode.SecretStorage): Promise<string | null> {
  const { refreshToken } = await getTokens(s);
  if (!refreshToken) { return null; }
  try {
    const { data } = await axios.post(`${getApiUrl()}/auth/refresh`, { refreshToken });
    if (data.success) { await setTokens(s, data.data.accessToken, data.data.refreshToken); return data.data.accessToken; }
  } catch { /* expired */ }
  return null;
}
async function makeRequest<T>(s: vscode.SecretStorage, fn: (t: string) => Promise<T>): Promise<T> {
  let { accessToken } = await getTokens(s);
  if (!accessToken) { accessToken = await refreshAccessToken(s); }
  if (!accessToken) { throw new Error('NOT_AUTHENTICATED'); }
  try { return await fn(accessToken); } catch (e: unknown) {
    if ((e as { response?: { status?: number } })?.response?.status === 401) {
      accessToken = await refreshAccessToken(s);
      if (!accessToken) { throw new Error('NOT_AUTHENTICATED'); }
      return await fn(accessToken);
    }
    throw e;
  }
}
const base = () => getApiUrl();
const hdr = (t: string) => ({ Authorization: `Bearer ${t}` });
async function apiGet(s: vscode.SecretStorage, path: string, params?: Record<string, string>) {
  return makeRequest(s, t => axios.get(`${base()}${path}`, { headers: hdr(t), params }));
}
async function apiPost(s: vscode.SecretStorage, path: string, body: unknown) {
  return makeRequest(s, t => axios.post(`${base()}${path}`, body, { headers: hdr(t) }));
}
async function apiPatch(s: vscode.SecretStorage, path: string, body: unknown) {
  return makeRequest(s, t => axios.patch(`${base()}${path}`, body, { headers: hdr(t) }));
}
async function apiDelete(s: vscode.SecretStorage, path: string) {
  return makeRequest(s, t => axios.delete(`${base()}${path}`, { headers: hdr(t) }));
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Annotation {
  id: string; noteId: string;
  filePath: string; lineStart: number; lineEnd: number;
  codeSnippet?: string; comment: string; status: string;
  createdAt: string; updatedAt: string;
}

interface NoteItem {
  id: string; title: string; content: string;
  updatedAt: string; pinned: boolean; tags: string[]; editorMode: string;
  priority: string; status: string;
  filePath?: string; lineStart?: number; lineEnd?: number; codeSnippet?: string;
  annotations?: Annotation[];
  // local-first fields
  localId?: string;
  createdAt?: string;
  folderPath?: string;
  deletedAt?: string | null;
  syncedAt?: string | null;
  // export tracking
  exports?: { notion?: { ts: string; pageId: string; pageUrl: string }; obsidian?: string };
  // task reminder tracking
  reminders?: { todoist?: { ts: string; due: string; taskId?: string; recurrence?: string }; googleTasks?: { ts: string; due: string; taskId?: string; taskListId?: string } };
}

interface NotesCacheEntry {
  notes: NoteItem[];
  cachedAt: string;
}

interface LocalMeta {
  version: number;
  noteIndex: Array<{ id: string; title: string; updatedAt: string; folderPath: string }>;
}

interface OfflineQueueItem {
  id: string;
  patch: {
    title: string; content: string; editorMode: string;
    pinned: boolean; tags: string[]; priority: string; status: string;
  };
  localUpdatedAt: string;
}

const PRIORITY_ORDER: Record<string, number> = {
  emergency: 5, urgent: 4, important: 3, medium: 2, low: 1, none: 0,
};
const PRIORITY_LABEL: Record<string, string> = {
  emergency: 'Emergency', urgent: 'Urgent', important: 'Important', medium: 'Medium', low: 'Low', none: 'None',
};
function topPriorityNote(notes: NoteItem[]): NoteItem | null {
  if (!notes.length) { return null; }
  return [...notes].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority ?? 'none'] ?? 0;
    const pb = PRIORITY_ORDER[b.priority ?? 'none'] ?? 0;
    if (pb !== pa) { return pb - pa; }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  })[0];
}

// ── Local Storage Helpers ────────────────────────────────────────────────────

function getNotesDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'notes');
}

function getMetaPath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'meta.json');
}

function ensureLocalDirs(context: vscode.ExtensionContext): void {
  const notesDir = getNotesDir(context);
  if (!fs.existsSync(notesDir)) { fs.mkdirSync(notesDir, { recursive: true }); }
}

function readLocalMeta(context: vscode.ExtensionContext): LocalMeta {
  const metaPath = getMetaPath(context);
  try {
    if (fs.existsSync(metaPath)) {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as LocalMeta;
    }
  } catch { /* corrupt — rebuild */ }
  return { version: 1, noteIndex: [] };
}

function writeLocalMeta(context: vscode.ExtensionContext, meta: LocalMeta): void {
  fs.writeFileSync(getMetaPath(context), JSON.stringify(meta, null, 2), 'utf8');
}

function readLocalNote(context: vscode.ExtensionContext, id: string): NoteItem | null {
  const notePath = path.join(getNotesDir(context), `${id}.json`);
  try {
    if (fs.existsSync(notePath)) {
      return JSON.parse(fs.readFileSync(notePath, 'utf8')) as NoteItem;
    }
  } catch { /* corrupt */ }
  return null;
}

function writeLocalNote(context: vscode.ExtensionContext, note: NoteItem): void {
  ensureLocalDirs(context);
  fs.writeFileSync(path.join(getNotesDir(context), `${note.id}.json`), JSON.stringify(note, null, 2), 'utf8');
  const meta = readLocalMeta(context);
  const entry = { id: note.id, title: note.title, updatedAt: note.updatedAt, folderPath: note.folderPath || '' };
  const idx = meta.noteIndex.findIndex(e => e.id === note.id);
  if (idx !== -1) { meta.noteIndex[idx] = entry; } else { meta.noteIndex.unshift(entry); }
  writeLocalMeta(context, meta);
}

function deleteLocalNote(context: vscode.ExtensionContext, id: string): void {
  const notePath = path.join(getNotesDir(context), `${id}.json`);
  if (fs.existsSync(notePath)) { fs.unlinkSync(notePath); }
  const meta = readLocalMeta(context);
  meta.noteIndex = meta.noteIndex.filter(e => e.id !== id);
  writeLocalMeta(context, meta);
}

function readLocalNotes(context: vscode.ExtensionContext, folderPath: string): NoteItem[] {
  ensureLocalDirs(context);
  const meta = readLocalMeta(context);
  const notes: NoteItem[] = [];
  for (const entry of meta.noteIndex) {
    if (entry.folderPath !== folderPath) { continue; }
    const note = readLocalNote(context, entry.id);
    if (note && !note.deletedAt) { notes.push(note); }
  }
  return notes.sort((a, b) => {
    if (a.pinned && !b.pinned) { return -1; }
    if (!a.pinned && b.pinned) { return 1; }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

// Returns notes grouped by folderPath for monorepo workspaces.
// Root notes (folderPath === workspacePath) come first, then subfolders alphabetically.
export interface NoteGroup { label: string; folderPath: string; notes: NoteItem[]; }
function readLocalNotesGrouped(context: vscode.ExtensionContext, workspacePath: string): NoteGroup[] {
  ensureLocalDirs(context);
  const meta = readLocalMeta(context);
  const sep = workspacePath.endsWith('/') ? workspacePath : workspacePath + '/';
  const map = new Map<string, NoteItem[]>();
  for (const entry of meta.noteIndex) {
    const fp = entry.folderPath;
    if (fp !== workspacePath && !fp.startsWith(sep)) { continue; }
    const note = readLocalNote(context, entry.id);
    if (!note || note.deletedAt) { continue; }
    if (!map.has(fp)) { map.set(fp, []); }
    map.get(fp)!.push(note);
  }
  const sortNotes = (arr: NoteItem[]) => arr.sort((a, b) => {
    if (a.pinned && !b.pinned) { return -1; }
    if (!a.pinned && b.pinned) { return 1; }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  const groups: NoteGroup[] = [];
  // Root group first
  if (map.has(workspacePath)) {
    const label = workspacePath.split(/[\/\\]/).filter(Boolean).pop() ?? workspacePath;
    groups.push({ label, folderPath: workspacePath, notes: sortNotes(map.get(workspacePath)!) });
  }
  // Subfolders alphabetically — always included even if root has no notes
  const subKeys = [...map.keys()].filter(k => k !== workspacePath).sort();
  for (const fp of subKeys) {
    const label = fp.slice(sep.length).split(/[\/\\]/)[0];
    groups.push({ label, folderPath: fp, notes: sortNotes(map.get(fp)!) });
  }
  return groups;
}

// All notes under workspace (flat), used for annotations/gutter
function readLocalNotesForWorkspace(context: vscode.ExtensionContext, workspacePath: string): NoteItem[] {
  return readLocalNotesGrouped(context, workspacePath).flatMap(g => g.notes);
}

// Discover subfolders for the picker: combine known ones from meta.json
// with one-level-deep directory scan of the workspace root.
function getSubfolderOptions(context: vscode.ExtensionContext, workspacePath: string): Array<{label: string; folderPath: string}> {
  const sep = workspacePath.endsWith('/') ? workspacePath : workspacePath + '/';
  const seen = new Set<string>();
  // 1. From meta.json (already have notes)
  const meta = readLocalMeta(context);
  for (const entry of meta.noteIndex) {
    if (entry.folderPath !== workspacePath && entry.folderPath.startsWith(sep)) {
      const rel = entry.folderPath.slice(sep.length).split(/[\/\\]/)[0];
      seen.add(rel);
    }
  }
  // 2. From filesystem scan (one level deep, directories only, skip hidden)
  try {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        seen.add(entry.name);
      }
    }
  } catch { /* can't read — skip */ }
  return [...seen].sort().map(name => ({ label: name, folderPath: sep + name }));
}

// ── Color palette ─────────────────────────────────────────────────────────────

const BG_COLORS = [
  { label: 'Dark',        bg: '#1e1e1e', text: '#d4d4d4' },
  { label: 'Deep night',  bg: '#0d1117', text: '#c9d1d9' },
  { label: 'Midnight',    bg: '#1a1b26', text: '#a9b1d6' },
  { label: 'Dark plum',   bg: '#1e1e2e', text: '#cdd6f4' },
  { label: 'Warm dark',   bg: '#1c1917', text: '#e7e5e4' },
  { label: 'Forest',      bg: '#1a2e1a', text: '#d4edda' },
  { label: 'Deep ocean',  bg: '#0a192f', text: '#ccd6f6' },
  { label: 'Sepia',       bg: '#f4ecd8', text: '#3b2f1e' },
  { label: 'Cream',       bg: '#fdfaf5', text: '#2c2c2c' },
  { label: 'Paper',       bg: '#f8f5f0', text: '#333333' },
  { label: 'Mint',        bg: '#f0faf4', text: '#1a3d2b' },
  { label: 'Lavender',    bg: '#f3f0ff', text: '#2d1f6e' },
];

// ── HTML: Welcome ─────────────────────────────────────────────────────────────

function welcomeHtml(iconUri: string, existingUser: boolean): string {
  const title = existingUser ? 'Welcome back' : 'NoteVs';
  const description = existingUser
    ? 'NoteVs now works offline by default. Your existing notes are still synced. Choose how you\'d like to work.'
    : 'Project notes and code annotations, right inside VS Code. No account needed.';
  const primaryLabel = existingUser ? '&#9729;&#65039;&nbsp; Keep Cloud Sync' : '&#9654;&nbsp; Get Started';
  const primaryMsg  = existingUser ? 'keepSync'    : 'getStarted';
  const secondaryLabel = existingUser ? '&#128187;&nbsp; Switch to Local Only' : '&#9729;&#65039;&nbsp; Enable Cloud Sync';
  const secondaryMsg   = existingUser ? 'goLocalOnly' : 'enableSync';
  const hint = existingUser ? '' : '<p class="sync-hint">Sync lets you view notes on the web and across machines. Requires a free account.</p>';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css"/>
  <style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:40px 24px;margin:0;display:flex;flex-direction:column;align-items:center;text-align:center;box-sizing:border-box;min-height:100vh;justify-content:center}
    .icon-container{position:relative;margin-bottom:32px}
    .icon-container img{width:96px;height:96px;filter:drop-shadow(0 4px 12px rgba(0,0,0,0.2));transition:transform 0.3s ease}
    .icon-container:hover img{transform:scale(1.05)}
    h1{font-size:20px;font-weight:600;margin:0 0 12px;color:var(--vscode-foreground)}
    p{font-size:13px;color:var(--vscode-descriptionForeground);margin-bottom:32px;line-height:1.6;max-width:240px}
    .btn{width:100%;padding:10px 16px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;transition:background 0.2s;display:flex;align-items:center;justify-content:center;gap:8px;box-sizing:border-box}
    .btn:hover{background:var(--vscode-button-hoverBackground)}
    .btn-secondary{width:100%;padding:10px 16px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;transition:background 0.2s;display:flex;align-items:center;justify-content:center;gap:8px;margin-top:8px;box-sizing:border-box}
    .btn-secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
    .sync-hint{font-size:11px;color:var(--vscode-descriptionForeground);text-align:center;max-width:200px;line-height:1.5;margin-top:16px;margin-bottom:0}
  </style></head><body>
  <div class="icon-container"><img src="${iconUri}" alt="NoteVs"/></div>
  <h1>${title}</h1>
  <p>${description}</p>
  <button class="btn" id="primary">${primaryLabel}</button>
  <button class="btn-secondary" id="secondary">${secondaryLabel}</button>
  ${hint}
  <script>
    const vscode=acquireVsCodeApi();
    document.getElementById('primary').addEventListener('click',()=>vscode.postMessage({type:'${primaryMsg}'}));
    document.getElementById('secondary').addEventListener('click',()=>vscode.postMessage({type:'${secondaryMsg}'}));
  <\/script></body></html>`;
}

// ── HTML: Login ───────────────────────────────────────────────────────────────

function loginHtml(iconUri: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css"/>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 40px 24px; margin: 0; display: flex; flex-direction: column; align-items: center; text-align: center; box-sizing: border-box; min-height: 100vh; justify-content: center; }
    .icon-container { position: relative; margin-bottom: 32px; }
    .icon-container img { width: 96px; height: 96px; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.2)); transition: transform 0.3s ease; }
    .icon-container:hover img { transform: scale(1.05); }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; color: var(--vscode-foreground); }
    p { font-size: 13px; color: var(--vscode-descriptionForeground); margin-bottom: 32px; line-height: 1.6; max-width: 240px; }
    .btn { width: 100%; padding: 10px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600; transition: background 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn:active { background: var(--vscode-button-secondaryHoverBackground); }
  </style></head><body>
  <div class="icon-container"><img src="${iconUri}" alt="NoteVs"/></div>
  <h1>NoteVs</h1>
  <p>Your private project notepad, synced across all your devices.</p>
  <button class="btn" id="b"><i class="codicon codicon-github-inverted"></i> Sign in / Sign up</button>
  <script>
    const vscode=acquireVsCodeApi();
    document.getElementById('b').addEventListener('click',()=>vscode.postMessage({type:'startLogin'}));
  </script></body></html>`;
}

// ── HTML: Settings ────────────────────────────────────────────────────────────

function settingsHtml(
  autoShow: boolean,
  noteBgColor: string,
  syncEnabled: boolean,
  syncUserEmail?: string | null,
  lastSyncAt?: string | null,
  notionConnected?: boolean,
  obsidianApiKey?: boolean,
  obsidianVaultPath?: string,
  notionAutoSync?: boolean,
  todoistConnected?: boolean,
  googleTasksConnected?: boolean,
): string {
  const swatches = BG_COLORS.map(c => `
    <div class="swatch${c.bg === noteBgColor ? ' active' : ''}" data-bg="${c.bg}" data-text="${c.text}"
      style="background:${c.bg};border-color:${c.bg === noteBgColor ? 'var(--vscode-focusBorder)' : 'transparent'}" title="${c.label}">
      ${c.bg === noteBgColor ? '<i class="codicon codicon-check check"></i>' : ''}
    </div>`).join('');

  const lastSyncLabel = lastSyncAt
    ? (() => {
        const diff = Date.now() - new Date(lastSyncAt).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) { return 'just now'; }
        if (mins < 60) { return `${mins} min ago`; }
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) { return `${hrs} hr ago`; }
        return new Date(lastSyncAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      })()
    : 'Never';

  const syncStatusHtml = syncEnabled
    ? `${syncUserEmail ? `<div class="sync-connected"><i class="codicon codicon-check"></i> Connected &middot; ${syncUserEmail.replace(/</g, '&lt;')}</div>` : ''}
       <div class="sync-last">Last sync: ${lastSyncLabel}</div>
       <button class="sync-now-btn" id="syncNowBtn"><i class="codicon codicon-sync"></i> Sync Now</button>`
    : `<div class="setting-hint">Notes stay on this device until sync is enabled.</div>`;

  const logoutHtml = syncEnabled
    ? `<button class="logout-btn" id="lo"><i class="codicon codicon-sign-out"></i> Sign out of NoteVs</button>`
    : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css"/>
  <style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:16px;margin:0;box-sizing:border-box}
    h2{font-size:14px;font-weight:600;margin:0 0 16px}
    .label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);margin:20px 0 10px}
    .row{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
    .row label{font-size:13px}
    .back-btn{background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;font-size:12px;padding:0;margin-bottom:16px;display:flex;align-items:center;gap:4px}
    .back-btn:hover{text-decoration:none;opacity:0.8}
    .swatches{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
    .swatch{width:100%;aspect-ratio:1;border-radius:4px;cursor:pointer;border:2px solid transparent;position:relative;display:flex;align-items:center;justify-content:center;transition:transform 0.1s,border-color 0.2s;box-shadow:0 2px 4px rgba(0,0,0,0.1)}
    .swatch:hover{transform:scale(1.05)}
    .swatch.active{border-color:var(--vscode-focusBorder)!important}
    .collapse-header{display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;padding:4px 0;margin:20px 0 0}
    .collapse-header:hover .collapse-label{color:var(--vscode-foreground)}
    .collapse-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground)}
    .collapse-chevron{font-size:12px;color:var(--vscode-descriptionForeground);transition:transform .2s}
    .collapse-chevron.open{transform:rotate(90deg)}
    .collapse-body{display:none;margin-top:10px}
    .collapse-body.open{display:block}
    .steps-box{background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px 12px;margin:-4px 0 10px}
    .steps-box ol{margin:0;padding-left:16px}
    .steps-box li{font-size:11px;color:var(--vscode-foreground);line-height:1.8}
    .steps-box a{color:var(--vscode-textLink-foreground);text-decoration:none}
    .steps-box a:hover{text-decoration:underline}
    .steps-toggle{background:none;border:none;cursor:pointer;color:var(--vscode-textLink-foreground);font-size:10px;padding:0;display:inline-flex;align-items:center;gap:3px;margin-bottom:6px;font-family:var(--vscode-font-family)}
    .steps-toggle:hover{text-decoration:underline}
    .check{font-size:16px;color:var(--vscode-focusBorder);filter:drop-shadow(0 0 2px rgba(0,0,0,0.3))}
    .logout-btn{margin-top:32px;width:100%;padding:8px;background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-errorForeground);border:1px solid var(--vscode-inputValidation-errorBorder);border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;transition:opacity 0.2s;display:flex;align-items:center;justify-content:center;gap:8px;box-sizing:border-box}
    .logout-btn:hover{opacity:0.9}
    .setting-hint{font-size:11px;color:var(--vscode-descriptionForeground);margin:-4px 0 12px;line-height:1.5}
    .sync-connected{font-size:11px;color:#3fb950;margin-bottom:4px;display:flex;align-items:center;gap:4px}
    .sync-last{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:10px}
    .sync-now-btn{padding:5px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;margin-bottom:16px;display:inline-flex;align-items:center;gap:6px}
    .sync-now-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
    .int-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}
    .int-input{flex:1;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);font-size:11px;padding:4px 8px;border-radius:4px;font-family:var(--vscode-font-family);outline:none}
    .int-input:focus{border-color:var(--vscode-focusBorder)}
    .int-btn{padding:4px 10px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap;flex-shrink:0;font-family:var(--vscode-font-family)}
    .int-btn:hover{background:var(--vscode-button-secondaryHoverBackground)}
    .int-btn.danger{background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-errorForeground)}
    .int-hint{font-size:10px;color:var(--vscode-descriptionForeground);margin:-4px 0 10px;line-height:1.5}
    .int-status{font-size:11px;color:#3fb950;display:flex;align-items:center;gap:4px}
  </style></head><body>
  <button class="back-btn" id="bk"><i class="codicon codicon-arrow-left"></i> Back</button>
  <h2>Settings</h2>
  <div class="row"><label>Auto-show on project open</label><input type="checkbox" id="as" ${autoShow ? 'checked' : ''}/></div>
  <!-- Cloud Sync section hidden until feature is ready
  <div class="label">Cloud Sync</div>
  <div class="row"><label>Sync to web &amp; across machines</label><input type="checkbox" id="syncToggle" ${syncEnabled ? 'checked' : ''}/></div>
  ${syncStatusHtml}
  -->
  <div class="collapse-header" id="colourToggle">
    <span class="collapse-label">Note background colour</span>
    <i class="codicon codicon-chevron-right collapse-chevron" id="colourChevron"></i>
  </div>
  <div class="collapse-body" id="colourBody">
    <div class="swatches">${swatches}</div>
  </div>
  <div class="label">Integrations</div>

  <div class="collapse-header" id="exportingToggle">
    <span class="collapse-label">Exporting</span>
    <i class="codicon codicon-chevron-right collapse-chevron" id="exportingChevron"></i>
  </div>
  <div class="collapse-body" id="exportingBody">
    <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--vscode-foreground)">Notion</div>
    ${notionConnected
      ? `<div class="int-row"><span class="int-status"><i class="codicon codicon-check"></i> Token saved</span><button class="int-btn danger" id="notionClear">Disconnect</button><button class="int-btn" id="notionChangePage">Change page</button></div>`
      : `<div class="int-row"><input class="int-input" id="notionTokenInput" type="password" placeholder="Paste token (secret_\u2026 or ntn_\u2026)"/><button class="int-btn" id="notionSave">Save</button></div>`
    }
    <button class="steps-toggle" id="notionStepsToggle"><i class="codicon codicon-info"></i> How to get your token</button>
    <div class="steps-box" id="notionStepsBox" style="display:none">
      <ol>
        <li>Go to <a href="https://app.notion.com/developers/connections" id="notionLink">app.notion.com/developers/connections</a></li>
        <li>Click <strong>+ New connection</strong></li>
        <li>Name it <strong>NoteVs</strong>, keep <strong>Access token</strong> selected, click <strong>Create connection</strong></li>
        <li>Copy the token shown (starts with <code>ntn_</code> or <code>secret_</code>)</li>
        <li>Paste it in the field above and click <strong>Save</strong></li>
        <li>Finally, open any Notion page you want notes to land in &rarr; click <strong>&middot;&middot;&middot;</strong> &rarr; <strong>Connections</strong> &rarr; select <strong>NoteVs</strong></li>
      </ol>
    </div>
    <div class="row" style="margin-top:10px">
      <label style="font-size:12px">Auto-sync on save <span style="font-size:10px;color:var(--vscode-descriptionForeground);display:block;margin-top:2px">Push updates to Notion 60s after you stop typing (notes already exported only)</span></label>
      <input type="checkbox" id="notionAutoSync" ${notionAutoSync ? 'checked' : ''}/>
    </div>

    <div style="font-size:12px;font-weight:600;margin:14px 0 6px;color:var(--vscode-foreground)">Obsidian</div>
    ${obsidianApiKey
      ? `<div class="int-row"><span class="int-status"><i class="codicon codicon-check"></i> REST API key saved</span><button class="int-btn danger" id="obsApiClear">Clear key</button></div>`
      : `<div class="int-row"><input class="int-input" id="obsApiInput" type="password" placeholder="Local REST API key\u2026"/><button class="int-btn" id="obsApiSave">Save key</button></div>`
    }
    <div class="int-row">
      <span style="font-size:11px;color:var(--vscode-descriptionForeground);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${obsidianVaultPath ? obsidianVaultPath : 'No vault folder set'}</span>
      <button class="int-btn" id="obsBrowse">Browse vault</button>
      ${obsidianVaultPath ? '<button class="int-btn danger" id="obsPathClear">Clear</button>' : ''}
    </div>
    <div class="int-hint">REST API: install "Local REST API" plugin in Obsidian. Vault folder: works without the plugin.</div>
  </div>

  <div class="collapse-header" id="tasksToggle">
    <span class="collapse-label">Tasks</span>
    <i class="codicon codicon-chevron-right collapse-chevron" id="tasksChevron"></i>
  </div>
  <div class="collapse-body" id="tasksBody">
    <div class="int-hint" style="margin-top:4px">Connect your task manager to use the &ldquo;Remind me&rdquo; button in the note editor.</div>

    <div style="font-size:12px;font-weight:600;margin:8px 0 6px;color:var(--vscode-foreground)">Todoist</div>
    ${todoistConnected
      ? `<div class="int-row"><span class="int-status"><i class="codicon codicon-check"></i> Token saved</span><button class="int-btn danger" id="todoistClear">Disconnect</button></div>`
      : `<div class="int-row"><input class="int-input" id="todoistTokenInput" type="password" placeholder="Paste your Todoist API token\u2026"/><button class="int-btn" id="todoistSave">Save</button></div>`
    }
    <button class="steps-toggle" id="todoistStepsToggle"><i class="codicon codicon-info"></i> How to get your token</button>
    <div class="steps-box" id="todoistStepsBox" style="display:none">
      <ol>
        <li>Open <a id="todoistLink" href="#">app.todoist.com</a> and sign in</li>
        <li>Click your avatar (top-left) &rarr; <strong>Settings</strong></li>
        <li>Go to <strong>Integrations</strong> &rarr; <strong>Developer</strong> tab</li>
        <li>Copy the <strong>API token</strong> shown</li>
        <li>Paste it in the field above and click <strong>Save</strong></li>
      </ol>
    </div>

    <div style="font-size:12px;font-weight:600;margin:14px 0 6px;color:var(--vscode-foreground)">Google Tasks</div>
    ${googleTasksConnected
      ? `<div class="int-row"><span class="int-status"><i class="codicon codicon-check"></i> Connected</span><button class="int-btn danger" id="googleTasksDisconnect">Disconnect</button></div>`
      : `<div class="int-row"><button class="int-btn" id="googleTasksConnect" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground)"><i class="codicon codicon-account"></i> Connect Google account &rarr;</button></div>`
    }
    <button class="steps-toggle" id="googleStepsToggle"><i class="codicon codicon-info"></i> How this works</button>
    <div class="steps-box" id="googleStepsBox" style="display:none">
      <ol>
        <li>Click <strong>Connect Google account</strong> above</li>
        <li>A browser window opens &mdash; sign in with <strong>your own</strong> Google account</li>
        <li>Click <strong>Allow</strong> to grant NoteVs access to your Tasks</li>
        <li>Return to VS Code &mdash; you&rsquo;re connected!</li>
      </ol>
    </div>

    <div class="int-hint" style="margin-top:10px">If both Todoist and Google Tasks are connected, you&rsquo;ll be asked which to use when you click &ldquo;Remind me&rdquo;.</div>
  </div>

  ${logoutHtml}
  <script>
    const vscode=acquireVsCodeApi();
    document.getElementById('bk').addEventListener('click',()=>vscode.postMessage({type:'showList'}));
    document.getElementById('as').addEventListener('change',e=>vscode.postMessage({type:'setSetting',key:'autoShow',value:e.target.checked}));
    const notionAutoSyncEl=document.getElementById('notionAutoSync');
    if(notionAutoSyncEl){notionAutoSyncEl.addEventListener('change',e=>vscode.postMessage({type:'setSetting',key:'notionAutoSync',value:e.target.checked}));}
    const syncNowBtn=document.getElementById('syncNowBtn');
    if(syncNowBtn){syncNowBtn.addEventListener('click',()=>vscode.postMessage({type:'syncNow'}));}
    const loBtn=document.getElementById('lo');
    if(loBtn){loBtn.addEventListener('click',()=>vscode.postMessage({type:'logout'}));}
    document.querySelectorAll('.swatch').forEach(s=>{
      s.addEventListener('click',()=>{
        document.querySelectorAll('.swatch').forEach(x=>{x.classList.remove('active');x.style.borderColor='transparent';x.innerHTML='';});
        s.classList.add('active');s.style.borderColor='var(--vscode-focusBorder)';s.innerHTML='<i class="codicon codicon-check check"></i>';
        vscode.postMessage({type:'setSetting',key:'noteBgColor',value:s.dataset.bg,textColor:s.dataset.text});
      });
    });
    const notionSaveBtn=document.getElementById('notionSave');
    if(notionSaveBtn){notionSaveBtn.addEventListener('click',()=>{const v=document.getElementById('notionTokenInput').value.trim();if(v){vscode.postMessage({type:'saveNotionToken',token:v});}});}
    const notionClearBtn=document.getElementById('notionClear');
    if(notionClearBtn){notionClearBtn.addEventListener('click',()=>vscode.postMessage({type:'clearNotionToken'}));}
    const notionChangePageBtn=document.getElementById('notionChangePage');
    if(notionChangePageBtn){notionChangePageBtn.addEventListener('click',()=>vscode.postMessage({type:'changeNotionPage'}));}
    const obsApiSaveBtn=document.getElementById('obsApiSave');
    if(obsApiSaveBtn){obsApiSaveBtn.addEventListener('click',()=>{const v=document.getElementById('obsApiInput').value.trim();if(v){vscode.postMessage({type:'saveObsidianApiKey',key:v});}});}
    const obsApiClearBtn=document.getElementById('obsApiClear');
    if(obsApiClearBtn){obsApiClearBtn.addEventListener('click',()=>vscode.postMessage({type:'clearObsidianApiKey'}));}
    document.getElementById('obsBrowse').addEventListener('click',()=>vscode.postMessage({type:'browseObsidianVault'}));
    const obsPathClearBtn=document.getElementById('obsPathClear');
    if(obsPathClearBtn){obsPathClearBtn.addEventListener('click',()=>vscode.postMessage({type:'clearObsidianVaultPath'}));}
    // ── Collapse toggles ──────────────────────────────────────────────────────
    function bindCollapse(toggleId, bodyId, chevronId) {
      document.getElementById(toggleId).addEventListener('click',()=>{
        const body=document.getElementById(bodyId);
        const chevron=document.getElementById(chevronId);
        const open=body.classList.toggle('open');
        chevron.classList.toggle('open',open);
      });
    }
    bindCollapse('colourToggle','colourBody','colourChevron');
    bindCollapse('exportingToggle','exportingBody','exportingChevron');
    bindCollapse('tasksToggle','tasksBody','tasksChevron');

    // ── Steps toggles ─────────────────────────────────────────────────────────
    function bindStepsToggle(btnId, boxId, labelOpen, labelClose) {
      const btn=document.getElementById(btnId);
      if(!btn) return;
      btn.addEventListener('click',()=>{
        const box=document.getElementById(boxId);
        const visible=box.style.display==='none';
        box.style.display=visible?'block':'none';
        btn.innerHTML=visible?'<i class="codicon codicon-chevron-up"></i> '+labelClose:'<i class="codicon codicon-info"></i> '+labelOpen;
      });
    }
    bindStepsToggle('notionStepsToggle','notionStepsBox','How to get your token','Hide steps');
    bindStepsToggle('todoistStepsToggle','todoistStepsBox','How to get your token','Hide steps');
    bindStepsToggle('googleStepsToggle','googleStepsBox','How this works','Hide');

    // Notion external link
    document.getElementById('notionLink').addEventListener('click',(e)=>{
      e.preventDefault();
      vscode.postMessage({type:'openExternal',url:'https://app.notion.com/developers/connections'});
    });
    // Todoist external link
    const todoistLinkEl=document.getElementById('todoistLink');
    if(todoistLinkEl){todoistLinkEl.addEventListener('click',(e)=>{e.preventDefault();vscode.postMessage({type:'openExternal',url:'https://app.todoist.com/app/settings/integrations/developer'});});}

    // ── Todoist ───────────────────────────────────────────────────────────────
    const todoistSaveBtn=document.getElementById('todoistSave');
    if(todoistSaveBtn){todoistSaveBtn.addEventListener('click',()=>{const v=document.getElementById('todoistTokenInput').value.trim();if(v){vscode.postMessage({type:'saveTodoistToken',token:v});}});}
    const todoistClearBtn=document.getElementById('todoistClear');
    if(todoistClearBtn){todoistClearBtn.addEventListener('click',()=>vscode.postMessage({type:'clearTodoistToken'}));}

    // ── Google Tasks ──────────────────────────────────────────────────────────
    const googleConnectBtn=document.getElementById('googleTasksConnect');
    if(googleConnectBtn){googleConnectBtn.addEventListener('click',()=>vscode.postMessage({type:'connectGoogleTasks'}));}
    const googleDisconnectBtn=document.getElementById('googleTasksDisconnect');
    if(googleDisconnectBtn){googleDisconnectBtn.addEventListener('click',()=>vscode.postMessage({type:'disconnectGoogleTasks'}));}
  <\/script></body></html>`;
}

// ── HTML: Notes List ──────────────────────────────────────────────────────────

function noFolderHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css"/>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 24px; margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; box-sizing: border-box; }
    .icon { font-size: 48px; margin-bottom: 20px; color: var(--vscode-descriptionForeground); opacity: 0.6; }
    h3 { font-size: 16px; font-weight: 600; margin: 0 0 10px; color: var(--vscode-foreground); }
    p { font-size: 13px; color: var(--vscode-descriptionForeground); line-height: 1.6; margin: 0 0 24px; max-width: 240px; }
    .btn { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; font-family: var(--vscode-font-family); transition: background 0.2s; display: flex; align-items: center; gap: 8px; }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
  </style></head><body>
  <i class="codicon codicon-folder-opened icon"></i>
  <h3>No project folder open</h3>
  <p>Open a folder to start managing your project-specific notes.</p>
  <button class="btn" id="openBtn"><i class="codicon codicon-folder"></i> Open Folder</button>
  <script>
    const vscode=acquireVsCodeApi();
    document.getElementById('openBtn').addEventListener('click',()=>vscode.postMessage({type:'openFolder'}));
  </script>
  </body></html>`;
}

function notesListHtml(
  projectName: string,
  groups: NoteGroup[],
  subfolderOptions: Array<{label: string; folderPath: string}>,
  syncStatus: 'local' | 'syncing' | 'synced' | 'error',
  lastSyncAt?: string | null,
  syncError?: string | null,
): string {
  const notes = groups.flatMap(g => g.notes); // for empty check & search
  const syncBarContent = syncStatus === 'local'
    ? `<span>&#9675; Local only</span>` // Enable cloud sync link hidden until feature is ready
    : syncStatus === 'syncing'
    ? `<span>&#8635; Syncing&hellip;</span>`
    : syncStatus === 'synced'
    ? `<span>&#9679; Synced &middot; Last sync: ${lastSyncAt ? (() => { const diff = Date.now() - new Date(lastSyncAt).getTime(); const m = Math.floor(diff/60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m/60)} hr ago`; })() : 'never'}</span>`
    : `<span>&#9888; Sync failed</span><a class="sync-status-link" id="retrySync">&nbsp;&middot;&nbsp; Retry &rarr;</a>`;

  const syncBarClass = syncStatus === 'error' ? 'sync-status-bar error' : 'sync-status-bar local';

  const CARD_ACCENTS = [
    { border: 'rgba(108,142,245,0.5)', glow: 'rgba(108,142,245,0.08)' },
    { border: 'rgba(63,185,80,0.5)',   glow: 'rgba(63,185,80,0.08)' },
    { border: 'rgba(251,146,60,0.5)',  glow: 'rgba(251,146,60,0.08)' },
    { border: 'rgba(232,121,249,0.5)', glow: 'rgba(232,121,249,0.08)' },
    { border: 'rgba(251,191,36,0.5)',  glow: 'rgba(251,191,36,0.08)' },
    { border: 'rgba(34,211,238,0.5)',  glow: 'rgba(34,211,238,0.08)' },
    { border: 'rgba(248,113,113,0.5)', glow: 'rgba(248,113,113,0.08)' },
    { border: 'rgba(52,211,153,0.5)',  glow: 'rgba(52,211,153,0.08)' },
  ];

  let globalIdx = 0;
  const renderNote = (n: NoteItem) => {
    const i = globalIdx++;
    const accent = CARD_ACCENTS[i % CARD_ACCENTS.length];
    const date = new Date(n.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const safeTitle = n.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rawPreview = n.editorMode === 'markdown'
      ? (n.content || '').replace(/[#*_`\[\]]/g, '').replace(/\n/g, ' ')
      : (() => { try { const d = JSON.parse(n.content || ''); return (d.ops||[]).map((op: {insert?: unknown}) => typeof op.insert === 'string' ? op.insert : '').join('').replace(/\n/g, ' '); } catch { return (n.content || '').replace(/<[^>]+>/g, ' '); } })();
    const preview = rawPreview.trim().slice(0, 60).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tagBadges = n.tags.slice(0, 3).map(t => `<span class="tag">${t.replace(/</g, '&lt;')}</span>`).join('');
    const priorityBadge = n.priority && n.priority !== 'none'
      ? `<span class="priority-indicator p-${n.priority}" title="${PRIORITY_LABEL[n.priority]}"><i class="codicon codicon-circle-filled"></i></span>` : '';
    const statusBadge = n.status === 'done' ? '<span class="status-badge done"><i class="codicon codicon-check"></i> done</span>'
      : n.status === 'passed' ? '<span class="status-badge passed"><i class="codicon codicon-pass-filled"></i> passed</span>' : '';
    const annotationCount = (n.annotations?.length ?? 0) || (n.filePath ? 1 : 0);
    const fileBadge = annotationCount > 0
      ? (n.annotations && n.annotations.length > 0
        ? `<span class="file-badge" title="${annotationCount} code annotation(s)"><i class="codicon codicon-link"></i> ${annotationCount} annotation${annotationCount > 1 ? 's' : ''}</span>`
        : `<span class="file-badge" data-id="${n.id}" data-file="${n.filePath}" data-line="${n.lineStart ?? 1}" data-line-start="${n.lineStart ?? 1}" data-line-end="${n.lineEnd ?? n.lineStart ?? 1}" title="Jump to ${n.filePath}:${n.lineStart}\u2013${n.lineEnd}"><i class="codicon codicon-link"></i> ${(n.filePath ?? '').split('/').pop()}:${n.lineStart}\u2013${n.lineEnd}</span>`)
      : '';
    const exportBadges = (() => {
      const badges: string[] = [];
      if (n.exports?.notion) { badges.push(`<span class="export-badge" title="Exported to Notion on ${new Date(n.exports.notion.ts).toLocaleString()}">&#10003; Notion</span>`); }
      if (n.exports?.obsidian) { badges.push(`<span class="export-badge" title="Saved to Obsidian on ${new Date(n.exports.obsidian).toLocaleString()}">&#10003; Obsidian</span>`); }
      if (n.reminders?.todoist) {
        const r = n.reminders.todoist;
        const label = r.recurrence ? `Todoist — ${r.recurrence}` : `Todoist — ${r.due.slice(0, 10)}`;
        badges.push(`<span class="export-badge task-badge" title="Reminded via Todoist on ${new Date(r.ts).toLocaleString()}">⏰ ${label}</span>`);
      }
      if (n.reminders?.googleTasks) {
        const r = n.reminders.googleTasks;
        badges.push(`<span class="export-badge task-badge" title="Added to Google Tasks on ${new Date(r.ts).toLocaleString()}">⏰ Google Tasks — ${r.due.slice(0, 10)}</span>`);
      }
      return badges.length ? `<div class="export-badges">${badges.join('')}</div>` : '';
    })();
    return `<div class="note-row" data-id="${n.id}" style="border-left: 3px solid ${accent.border}; background: ${accent.glow};">
      <div class="note-main">
        <div class="note-header">${priorityBadge}${n.pinned ? '<i class="codicon codicon-pin pin-icon"></i>' : ''}<span class="note-title">${safeTitle}</span><span class="note-date">${date}</span></div>
        ${fileBadge ? `<div class="file-row">${fileBadge}</div>` : ''}
        <div class="note-preview">${preview || '<span class="dim">Empty note</span>'}</div>
        ${exportBadges}
        <div class="note-footer">${tagBadges ? `<div class="tags">${tagBadges}</div>` : '<div></div>'}${statusBadge}</div>
      </div>
      <button class="del-btn" data-id="${n.id}" title="Delete"><i class="codicon codicon-trash"></i></button>
    </div>`;
  };

  const isMonorepo = groups.length > 1 || (groups.length === 1 && groups[0].folderPath !== groups[0].folderPath);
  const showHeaders = groups.length > 1 || (groups.length === 1 && subfolderOptions.length > 0);
  const items = groups.map(group => {
    const header = showHeaders
      ? `<div class="group-header"><i class="codicon codicon-folder"></i> ${group.label}</div>`
      : '';
    return header + group.notes.map(renderNote).join('');
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css"/>
  <style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:0;margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box}
    .toolbar{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background);z-index:10}
    .project-name{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}
    .toolbar-right{display:flex;align-items:center;gap:4px}
    .icon-btn{background:none;border:none;cursor:pointer;color:var(--vscode-foreground);opacity:.7;font-size:16px;padding:4px;border-radius:4px;line-height:1;transition:opacity .2s,background .2s}
    .icon-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}
    .search-bar{padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    .search-bar input{width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);border-radius:4px;padding:6px 10px;font-size:12px;outline:none;font-family:var(--vscode-font-family);box-sizing:border-box}
    .search-bar input:focus{border-color:var(--vscode-focusBorder)}
    .new-note-row{display:none;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--vscode-focusBorder);border-radius:6px;background:var(--vscode-input-background);margin:0 0 4px}
    .new-note-row.visible{display:flex}
    .new-note-input{flex:1;background:transparent;border:none;color:var(--vscode-input-foreground);font-size:13px;font-weight:500;outline:none;font-family:var(--vscode-font-family);padding:2px 4px}
    .new-note-hint{font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;opacity:.7}
    .notes-list{flex:1;overflow-y:auto;padding:8px 12px;display:flex;flex-direction:column;gap:8px}
    .group-header{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);padding:12px 2px 6px;display:flex;align-items:center;gap:5px;opacity:.7}
    .group-header:first-child{padding-top:4px}
    .note-row{display:flex;align-items:flex-start;padding:10px;cursor:pointer;border:1px solid var(--vscode-panel-border);border-radius:6px;background:var(--vscode-sideBar-background);transition:border-color .2s,box-shadow .2s,background .2s;position:relative;gap:8px}
    .note-row:hover{border-color:var(--vscode-focusBorder);filter:brightness(1.15);box-shadow:0 2px 8px rgba(0,0,0,.15)}
    .note-row.hidden{display:none}
    .note-main{flex:1;min-width:0}
    .note-header{display:flex;align-items:center;gap:6px;margin-bottom:4px}
    .pin-icon{font-size:12px;color:var(--vscode-symbolIcon-propertyForeground);flex-shrink:0}
    .note-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:var(--vscode-foreground)}
    .note-date{font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;flex-shrink:0}
    .note-preview{font-size:12px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.4;margin-bottom:8px;min-height:1.4em}
    .note-footer{display:flex;justify-content:space-between;align-items:center;gap:8px}
    .tags{display:flex;gap:4px;flex-wrap:wrap}
    .tag{font-size:10px;padding:1px 6px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border:1px solid rgba(128,128,128,.2)}
    .dim{opacity:.5;font-style:italic}
    .del-btn{background:none;border:none;cursor:pointer;color:var(--vscode-errorForeground);opacity:0;font-size:14px;padding:4px;border-radius:4px;flex-shrink:0;transition:opacity .2s}
    .note-row:hover .del-btn{opacity:.6}
    .del-btn:hover{opacity:1!important;background:var(--vscode-inputValidation-errorBackground)}
    .empty{padding:60px 20px;text-align:center;font-size:13px;color:var(--vscode-descriptionForeground);line-height:1.6}
    .empty i{font-size:32px;display:block;margin-bottom:12px;opacity:.3}
    .status-badge{font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;flex-shrink:0;display:flex;align-items:center;gap:4px}
    .status-badge.done{background:rgba(63,185,80,.15);color:#3fb950;border:1px solid rgba(63,185,80,.3)}
    .status-badge.passed{background:rgba(108,142,245,.15);color:#6c8ef5;border:1px solid rgba(108,142,245,.3)}
    .export-badge{font-size:10px;padding:1px 6px;border-radius:4px;display:inline-flex;align-items:center;gap:3px;border:1px solid rgba(128,128,128,.2);color:var(--vscode-descriptionForeground);background:transparent;opacity:.75}
    .export-badge.task-badge{border-color:rgba(251,191,36,.35);color:#fbbf24;opacity:.85}
    .export-badges{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px}
    .priority-indicator{font-size:10px;flex-shrink:0;display:flex;align-items:center}
    .priority-indicator.p-emergency{color:#f87171}.priority-indicator.p-urgent{color:#fb923c}.priority-indicator.p-important{color:#fbbf24}.priority-indicator.p-medium{color:#84cc16}.priority-indicator.p-low{color:#22c55e}
    .file-row{margin-bottom:6px}
    .file-badge{font-size:11px;color:var(--vscode-textLink-foreground);cursor:pointer;opacity:.8;display:flex;align-items:center;gap:4px}
    .file-badge:hover{opacity:1;text-decoration:underline}
    .sync-status-bar{padding:5px 12px;border-bottom:1px solid var(--vscode-panel-border);font-size:11px;flex-shrink:0;display:flex;align-items:center;gap:4px;cursor:default}
    .sync-status-bar.local{color:var(--vscode-descriptionForeground);background:transparent}
    .sync-status-bar.error{background:var(--vscode-inputValidation-warningBackground);color:var(--vscode-inputValidation-warningForeground)}
    .sync-status-link{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:none}
    .sync-status-link:hover{text-decoration:underline}
  </style></head><body>
  <div class="toolbar">
    <span class="project-name" title="${projectName}">${projectName}</span>
    <div class="toolbar-right">
      <button class="icon-btn" id="newBtn" title="New note"><i class="codicon codicon-add"></i></button>
      <button class="icon-btn" id="settingsBtn" title="Settings"><i class="codicon codicon-settings-gear"></i></button>
    </div>
  </div>
  <div class="search-bar"><input id="search" placeholder="Search notes\u2026" autocomplete="off"/></div>
  <div class="${syncBarClass}">${syncBarContent}</div>
  <div class="notes-list" id="list">
    <div class="new-note-row" id="newNoteRow">
      <i class="codicon codicon-note" style="font-size:14px;opacity:.6;flex-shrink:0"></i>
      <input class="new-note-input" id="newNoteInput" placeholder="Note name\u2026 (Enter to create, Esc to cancel)" autocomplete="off" maxlength="120"/>
      <span class="new-note-hint">\u21b5 create</span>
    </div>
    ${items}
    ${notes.length === 0 ? '<div class="empty"><i class="codicon codicon-note"></i>No notes yet.<br/>Press <strong>+</strong> to create one.</div>' : ''}
  </div>
  <script>
    const vscode=acquireVsCodeApi();
    const newNoteRow=document.getElementById('newNoteRow');
    const newNoteInput=document.getElementById('newNoteInput');
    const workspaceRoot=${JSON.stringify(groups[0]?.folderPath ?? '')};
    const subfolders=${JSON.stringify(subfolderOptions)};
    const rootFolder=${JSON.stringify(groups[0]?.folderPath ?? '')};
    const rootLabel=${JSON.stringify(groups[0]?.label ?? projectName)};
    document.getElementById('newBtn').addEventListener('click',()=>{
      if(subfolders.length > 0){
        vscode.postMessage({type:'chooseFolder', subfolders, rootFolder, rootLabel});
      } else {
        newNoteRow.classList.add('visible');newNoteInput.value='';newNoteInput.focus();
      }
    });
    newNoteInput.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();const t=newNoteInput.value.trim();if(t){vscode.postMessage({type:'newNote',title:t,targetFolder:newNoteRow.dataset.folder||rootFolder});}newNoteRow.classList.remove('visible');}
      if(e.key==='Escape'){newNoteRow.classList.remove('visible');}
    });
    newNoteInput.addEventListener('blur',()=>{setTimeout(()=>{newNoteRow.classList.remove('visible');},150);});
    window.addEventListener('message',e=>{
      if(e.data.type==='showNewNoteInput'){
        newNoteRow.dataset.folder=e.data.folderPath;
        newNoteRow.classList.add('visible');newNoteInput.value='';newNoteInput.focus();
      }
    });
    document.getElementById('settingsBtn').addEventListener('click',()=>vscode.postMessage({type:'openSettings'}));
    document.querySelectorAll('.note-row').forEach(row=>{
      row.addEventListener('click',e=>{if(e.target.closest('.del-btn'))return;vscode.postMessage({type:'openNote',id:row.dataset.id});});
    });
    document.querySelectorAll('.del-btn').forEach(btn=>{
      btn.addEventListener('click',e=>{e.stopPropagation();vscode.postMessage({type:'deleteNote',id:btn.dataset.id});});
    });
    document.getElementById('search').addEventListener('input',e=>{
      const q=e.target.value.toLowerCase().trim();
      document.querySelectorAll('.note-row').forEach(row=>{
        const title=row.querySelector('.note-title')?.textContent?.toLowerCase()||'';
        const preview=row.querySelector('.note-preview')?.textContent?.toLowerCase()||'';
        row.classList.toggle('hidden',q!==''&&!title.includes(q)&&!preview.includes(q));
      });
    });
    document.querySelectorAll('.file-badge').forEach(badge=>{
      badge.addEventListener('click',e=>{
        e.stopPropagation();
        vscode.postMessage({type:'jumpToFile',file:badge.dataset.file,line:parseInt(badge.dataset.lineStart||badge.dataset.line||'1'),lineStart:parseInt(badge.dataset.lineStart||'1'),lineEnd:parseInt(badge.dataset.lineEnd||badge.dataset.lineStart||'1')});
      });
    });
    document.addEventListener('keydown',e=>{
      if((e.metaKey||e.ctrlKey)&&e.key==='n'){e.preventDefault();if(subfolders.length>0){vscode.postMessage({type:'chooseFolder',subfolders,rootFolder,rootLabel});}else{newNoteRow.classList.add('visible');newNoteInput.value='';newNoteInput.focus();}}
    });
    // const enableSyncLink=document.getElementById('enableSyncLink');
    // if(enableSyncLink){enableSyncLink.addEventListener('click',()=>vscode.postMessage({type:'enableSync'}));}
    const retrySync=document.getElementById('retrySync');
    if(retrySync){retrySync.addEventListener('click',()=>vscode.postMessage({type:'syncNow'}));}
  </script></body></html>`;
}

// ── HTML: Note Editor ─────────────────────────────────────────────────────────

function noteEditorHtml(note: NoteItem, projectName: string, bgColor: string, textColor: string): string {
  const safeTitle = (note.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const isMarkdown = note.editorMode === 'markdown';
  const contentJson = JSON.stringify(note.content || '');

  const exportHistoryBar = (() => {
    const chips: string[] = [];
    if (note.exports?.notion) { chips.push(`<span class="export-chip" data-dest="notion" title="Last exported ${new Date(note.exports.notion.ts).toLocaleString()}">&#10003; Exported to Notion</span>`); }
    if (note.exports?.obsidian) { chips.push(`<span class="export-chip" data-dest="obsidian" title="Last saved ${new Date(note.exports.obsidian).toLocaleString()}">&#10003; Saved to Obsidian</span>`); }
    if (note.reminders?.todoist) {
      const r = note.reminders.todoist;
      const label = r.recurrence ? r.recurrence : r.due.slice(0, 10);
      chips.push(`<span class="export-chip" style="border-color:rgba(251,191,36,.35);color:#fbbf24" title="Reminded via Todoist on ${new Date(r.ts).toLocaleString()}">⏰ Todoist — ${label}</span>`);
    }
    if (note.reminders?.googleTasks) {
      const r = note.reminders.googleTasks;
      chips.push(`<span class="export-chip" style="border-color:rgba(251,191,36,.35);color:#fbbf24" title="Added to Google Tasks on ${new Date(r.ts).toLocaleString()}">⏰ Google Tasks — ${r.due.slice(0, 10)}</span>`);
    }
    return chips.length ? `<div class="export-history-bar" id="exportHistoryBar">${chips.join('')}</div>` : '';
  })();

  const annotationsHtml = (note.annotations && note.annotations.length > 0)
    ? note.annotations.map(ann => {
      const commentPreview = (ann.comment || '').trim().slice(0, 60).replace(/</g, '&lt;');
      const previewText = commentPreview || (ann.codeSnippet ? ann.codeSnippet.trim().replace(/\n/g,' ').slice(0,60).replace(/</g,'&lt;') : '');
      return `
  <div class="annotation-block" data-ann-id="${ann.id}">
    <div class="ann-header" onclick="toggleAnnotation('${ann.id}')">
      <i class="codicon codicon-chevron-right ann-chevron"></i>
      <span class="ann-file" onclick="event.stopPropagation();vscode.postMessage({type:'jumpToFile',file:'${ann.filePath}',noteFolderPath:'${note.folderPath||''}',lineStart:${ann.lineStart},lineEnd:${ann.lineEnd},line:${ann.lineStart}})">
        <i class="codicon codicon-link"></i> ${ann.filePath}:${ann.lineStart}\u2013${ann.lineEnd}
      </span>
      ${previewText ? `<span class="ann-preview">${previewText}</span>` : ''}
      <select class="ann-status styled-select ${ann.status}" data-ann-id="${ann.id}" onclick="event.stopPropagation()" onchange="saveAnnotation('${ann.id}')">
        <option value="open"${ann.status==='open'?' selected':''}>Open</option>
        <option value="done"${ann.status==='done'?' selected':''}>Done</option>
        <option value="closed"${ann.status==='closed'?' selected':''}>Closed</option>
      </select>
      <button class="ann-del-btn" onclick="event.stopPropagation();deleteAnnotation('${ann.id}')" title="Remove annotation"><i class="codicon codicon-trash"></i></button>
    </div>
    <div class="ann-body">
      ${ann.codeSnippet ? `<pre class="ann-snippet">${ann.codeSnippet.replace(/</g,'&lt;').slice(0,300)}</pre>` : ''}
      <textarea class="ann-comment" data-ann-id="${ann.id}" placeholder="Comment on this code\u2026" oninput="scheduleAnnotationSave('${ann.id}')">${(ann.comment||'').replace(/</g,'&lt;')}</textarea>
    </div>
  </div>`;
    }).join('')
    : (note.filePath ? `
  <div class="annotation-banner" id="annotationBanner" style="cursor:pointer" title="Jump to this location">
    <span><i class="codicon codicon-link"></i> ${note.filePath}:${note.lineStart}\u2013${note.lineEnd}</span>
    <span class="code-snippet">${(note.codeSnippet||'').replace(/</g,'&lt;').slice(0,80)}</span>
  </div>` : '');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css"/>
  <link rel="stylesheet" href="https://cdn.quilljs.com/1.3.7/quill.snow.css"/>
  <script src="https://cdn.quilljs.com/1.3.7/quill.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
  <style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:0;margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box}
    .toolbar{display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;gap:8px;background:var(--vscode-sideBar-background)}
    .back-btn{background:none;border:none;cursor:pointer;color:var(--vscode-textLink-foreground);font-size:12px;padding:4px;white-space:nowrap;flex-shrink:0;display:flex;align-items:center;gap:4px;border-radius:4px}
    .back-btn:hover{background:var(--vscode-toolbar-hoverBackground)}
    .title-input{flex:1;background:transparent;border:none;color:var(--vscode-foreground);font-size:13px;font-weight:600;outline:none;min-width:0;font-family:var(--vscode-font-family);padding:4px;border-radius:4px}
    .title-input:focus{background:var(--vscode-input-background);border:1px solid var(--vscode-focusBorder)}
    .status{font-size:10px;color:#4caf50;white-space:nowrap;flex-shrink:0;min-width:40px;text-align:right;font-weight:600;text-transform:uppercase}
    .meta-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;flex-wrap:wrap;background:var(--vscode-sideBar-background)}
    .pin-btn{background:none;border:none;cursor:pointer;font-size:16px;padding:4px;border-radius:4px;color:var(--vscode-foreground);opacity:.5;transition:opacity .2s,color .2s;display:flex;align-items:center}
    .pin-btn.active{opacity:1;color:var(--vscode-symbolIcon-propertyForeground)}
    .tags-input{flex:1;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);font-size:11px;outline:none;font-family:var(--vscode-font-family);min-width:100px;padding:4px 8px;border-radius:4px}
    .mode-toggle{display:flex;gap:2px;flex-shrink:0;background:var(--vscode-button-secondaryBackground);padding:2px;border-radius:6px}
    .mode-btn{background:none;border:none;color:var(--vscode-button-secondaryForeground);font-size:10px;padding:3px 8px;border-radius:4px;cursor:pointer;font-weight:600;transition:background .2s}
    .mode-btn.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
    .select-wrap{display:flex;gap:4px;flex-shrink:0}
    .styled-select{background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);font-size:11px;padding:3px 6px;border-radius:4px;cursor:pointer;font-family:var(--vscode-font-family);outline:none}
    .status-select.open{color:#f87171}.status-select.done{color:#3fb950}.status-select.passed{color:#6c8ef5}
    .word-count{padding:4px 12px;font-size:10px;color:var(--vscode-descriptionForeground);flex-shrink:0;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);display:flex;justify-content:space-between;align-items:center}
    .export-btn{background:none;border:1px solid var(--vscode-panel-border);cursor:pointer;color:var(--vscode-descriptionForeground);font-size:11px;padding:3px 7px;border-radius:4px;display:flex;align-items:center;gap:3px;transition:background .15s,color .15s,border-color .15s;white-space:nowrap;font-family:var(--vscode-font-family);flex-shrink:0}
    .export-btn:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground);border-color:var(--vscode-focusBorder)}
    .task-btn{background:none;border:1px solid var(--vscode-panel-border);cursor:pointer;color:var(--vscode-descriptionForeground);font-size:10px;padding:2px 7px;border-radius:4px;display:inline-flex;align-items:center;gap:3px;transition:background .15s,color .15s,border-color .15s;white-space:nowrap;font-family:var(--vscode-font-family);flex-shrink:0}
    .task-btn:hover{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground);border-color:var(--vscode-focusBorder)}
    .export-history-bar{display:flex;align-items:center;gap:6px;padding:3px 12px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;flex-wrap:wrap}
    .export-chip{font-size:10px;padding:1px 7px;border-radius:4px;display:inline-flex;align-items:center;gap:3px;border:1px solid rgba(128,128,128,.2);color:var(--vscode-descriptionForeground);background:transparent;opacity:.75}
    .editor-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;background:${bgColor};color:${textColor}}
    .ql-toolbar{background:rgba(128,128,128,.05)!important;border:none!important;border-bottom:1px solid var(--vscode-panel-border)!important;flex-shrink:0;padding:6px!important}
    .ql-toolbar .ql-stroke{stroke:${textColor}!important;opacity:.8}.ql-toolbar .ql-fill{fill:${textColor}!important;opacity:.8}.ql-toolbar .ql-picker{color:${textColor}!important}
    .ql-toolbar button:hover .ql-stroke,.ql-toolbar button.ql-active .ql-stroke{stroke:var(--vscode-textLink-foreground)!important;opacity:1}
    .ql-container{flex:1;font-size:13px;border:none!important;overflow:auto}
    .ql-editor{color:${textColor};min-height:200px;line-height:1.6;padding:16px;font-family:var(--vscode-font-family)}
    .ql-editor.ql-blank::before{color:${textColor};opacity:.35;font-style:italic}
    .md-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;background:${bgColor}}
    .md-panes{flex:1;display:flex;overflow:hidden}
    textarea.md-edit{flex:1;background:${bgColor};color:${textColor};border:none;resize:none;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;line-height:1.6;padding:16px;outline:none}
    .md-preview{flex:1;overflow-y:auto;padding:16px;color:${textColor};font-size:13px;line-height:1.6;border-left:1px solid rgba(128,128,128,.2)}
    .md-preview h1,.md-preview h2,.md-preview h3{margin-top:1em;margin-bottom:.5em;color:inherit}
    .md-preview code{background:rgba(128,128,128,.15);padding:2px 4px;border-radius:4px;font-size:12px;font-family:var(--vscode-editor-font-family,monospace)}
    .md-preview pre{background:rgba(128,128,128,.15);padding:12px;border-radius:6px;overflow-x:auto;margin:12px 0}
    .md-preview a{color:var(--vscode-textLink-foreground)}
    .md-tabs{display:flex;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);flex-shrink:0;padding:0 8px}
    .md-tab{padding:8px 16px;font-size:11px;font-weight:600;cursor:pointer;color:var(--vscode-descriptionForeground);border:none;background:none;border-bottom:2px solid transparent;transition:color .2s,border-color .2s}
    .md-tab.active{color:var(--vscode-foreground);border-bottom-color:var(--vscode-focusBorder)}
    .annotation-banner{padding:8px 12px;background:rgba(108,142,245,.1);border-bottom:1px solid var(--vscode-panel-border);font-size:11px;color:var(--vscode-textLink-foreground);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:8px;cursor:pointer}
    .code-snippet{opacity:.7;font-family:var(--vscode-editor-font-family,monospace);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
    .annotation-block{border-left:3px solid rgba(108,142,245,.6);background:rgba(108,142,245,.05);margin:0;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    .ann-header{display:flex;align-items:center;gap:6px;padding:7px 12px;cursor:pointer;user-select:none}
    .ann-header:hover{background:rgba(108,142,245,.08)}
    .ann-chevron{font-size:10px;color:var(--vscode-descriptionForeground);flex-shrink:0;transition:transform .2s;opacity:.7}
    .annotation-block.expanded .ann-chevron{transform:rotate(90deg)}
    .ann-preview{font-size:11px;color:var(--vscode-descriptionForeground);opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-style:italic}
    .ann-body{display:none;padding:0 12px 8px 12px}
    .annotation-block.expanded .ann-body{display:block}
    .ann-file{font-size:11px;color:var(--vscode-textLink-foreground);cursor:pointer;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:4px}
    .ann-file:hover{text-decoration:underline}
    .ann-status.open{color:#f87171}.ann-status.done{color:#3fb950}.ann-status.closed{color:var(--vscode-descriptionForeground)}
    .ann-del-btn{background:none;border:none;cursor:pointer;color:var(--vscode-errorForeground);opacity:.5;font-size:12px;padding:2px;border-radius:3px;flex-shrink:0}
    .ann-del-btn:hover{opacity:1;background:var(--vscode-inputValidation-errorBackground)}
    .ann-snippet{font-family:var(--vscode-editor-font-family,monospace);font-size:10px;background:rgba(0,0,0,.15);padding:4px 6px;border-radius:3px;margin:0 0 6px;overflow-x:auto;white-space:pre;color:${textColor};opacity:.8;max-height:60px}
    .ann-comment{width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);font-size:11px;font-family:var(--vscode-font-family);border-radius:3px;padding:4px 6px;outline:none;resize:vertical;min-height:40px;box-sizing:border-box}
    .ann-comment:focus{border-color:var(--vscode-focusBorder)}

  </style></head><body>
  <div class="toolbar">
    <button class="back-btn" id="backBtn"><i class="codicon codicon-arrow-left"></i> Notes</button>
    <input class="title-input" id="titleInput" value="${safeTitle}" placeholder="Note title\u2026"/>
    <span class="status" id="status"></span>
    <button class="export-btn" id="notionBtn" title="${note.exports?.notion ? 'Re-export to Notion (updates existing page)' : 'Export to Notion'}">${note.exports?.notion ? '&#8635; Re-export' : '<i class="codicon codicon-cloud-upload"></i> Notion'}</button>
    <button class="export-btn" id="obsidianBtn" title="${note.exports?.obsidian ? 'Re-save to Obsidian (overwrites existing file)' : 'Save to Obsidian vault'}">${note.exports?.obsidian ? '&#8635; Re-save' : '<i class="codicon codicon-file"></i> Obsidian'}</button>
  </div>
  <div class="meta-bar">
    <button class="pin-btn${note.pinned ? ' active' : ''}" id="pinBtn" title="${note.pinned ? 'Unpin' : 'Pin note'}"><i class="codicon codicon-pin"></i></button>
    <div class="select-wrap">
      <select class="styled-select" id="prioritySelect" title="Priority">
        <option value="none"${(note.priority||'none')==='none'?' selected':''}>Priority: None</option>
        <option value="low"${note.priority==='low'?' selected':''}>Low</option>
        <option value="medium"${note.priority==='medium'?' selected':''}>Medium</option>
        <option value="important"${note.priority==='important'?' selected':''}>Important</option>
        <option value="urgent"${note.priority==='urgent'?' selected':''}>Urgent</option>
        <option value="emergency"${note.priority==='emergency'?' selected':''}>Emergency</option>
      </select>
      <select class="styled-select status-select ${note.status||'open'}" id="statusSelect" title="Status">
        <option value="open"${(note.status||'open')==='open'?' selected':''}>Open</option>
        <option value="done"${note.status==='done'?' selected':''}>Done</option>
        <option value="passed"${note.status==='passed'?' selected':''}>Passed</option>
      </select>
    </div>
    <input class="tags-input" id="tagsInput" value="${note.tags.join(', ')}" placeholder="Tags (comma separated)\u2026"/>
    <div class="mode-toggle">
      <button class="mode-btn${!isMarkdown ? ' active' : ''}" id="modeWysiwyg">Edit</button>
      <button class="mode-btn${isMarkdown ? ' active' : ''}" id="modeMd">Markdown</button>
    </div>
  </div>
  ${annotationsHtml}
  ${exportHistoryBar}
  <div class="editor-wrap" id="wysiwygWrap" style="display:${isMarkdown ? 'none' : 'flex'}">
    <div id="quillEditor"></div>
  </div>
  <div class="md-wrap" id="mdWrap" style="display:${isMarkdown ? 'flex' : 'none'};flex-direction:column">
    <div class="md-tabs">
      <button class="md-tab active" id="tabEdit">Edit</button>
      <button class="md-tab" id="tabPreview">Preview</button>
    </div>
    <div class="md-panes">
      <textarea class="md-edit" id="mdEdit" placeholder="Write Markdown\u2026"></textarea>
      <div class="md-preview" id="mdPreview" style="display:none"></div>
    </div>
  </div>
  <div class="word-count">
    <span id="wordCount">0 words \u00b7 0 chars</span>
    <span style="display:flex;align-items:center;gap:6px">
      <button class="task-btn" id="todoistBtn" title="Set a reminder in Todoist">&#9200; Remind me</button>
      <span id="saveStatus" style="opacity:.6;font-style:italic">Saved</span>
    </span>
  </div>

  <script>
    const vscode=acquireVsCodeApi();
    const noteId="${note.id}";
    let mode="${note.editorMode||'wysiwyg'}";
    let pinned=${note.pinned};
    let saveTimer=null;
    const annSaveTimers={};
    const quill=new Quill('#quillEditor',{theme:'snow',placeholder:'Start writing\u2026',modules:{toolbar:[['bold','italic','underline','strike'],['blockquote','code-block'],[{'list':'ordered'},{'list':'bullet'}],[{'header':[1,2,3,false]}],['link'],['clean']]}});
    const rawContent=${contentJson};
    if(mode==='wysiwyg'){try{quill.setContents(JSON.parse(rawContent));}catch{quill.setText(rawContent);}}
    else{document.getElementById('mdEdit').value=rawContent;updateMdPreview();}
    function updateWordCount(text){const words=text.trim()?text.trim().split(/\\s+/).length:0;document.getElementById('wordCount').textContent=words+' words \u00b7 '+text.length+' chars';}
    quill.on('text-change',()=>{updateWordCount(quill.getText());scheduleSave();});
    document.getElementById('mdEdit').addEventListener('input',e=>{updateWordCount(e.target.value);updateMdPreview();scheduleSave();});
    updateWordCount(mode==='wysiwyg'?quill.getText():document.getElementById('mdEdit').value);
    function updateMdPreview(){document.getElementById('mdPreview').innerHTML=marked.parse(document.getElementById('mdEdit').value);}
    document.getElementById('tabEdit').addEventListener('click',()=>{document.getElementById('tabEdit').classList.add('active');document.getElementById('tabPreview').classList.remove('active');document.getElementById('mdEdit').style.display='';document.getElementById('mdPreview').style.display='none';});
    document.getElementById('tabPreview').addEventListener('click',()=>{document.getElementById('tabPreview').classList.add('active');document.getElementById('tabEdit').classList.remove('active');document.getElementById('mdEdit').style.display='none';document.getElementById('mdPreview').style.display='';updateMdPreview();});
    function switchMode(newMode){if(newMode===mode)return;mode=newMode;document.getElementById('modeWysiwyg').classList.toggle('active',mode==='wysiwyg');document.getElementById('modeMd').classList.toggle('active',mode==='markdown');document.getElementById('wysiwygWrap').style.display=mode==='wysiwyg'?'flex':'none';document.getElementById('mdWrap').style.display=mode==='markdown'?'flex':'none';if(mode==='markdown'){document.getElementById('mdEdit').value=quill.getText();updateMdPreview();}else{quill.setText(document.getElementById('mdEdit').value);}scheduleSave();}
    document.getElementById('modeWysiwyg').addEventListener('click',()=>switchMode('wysiwyg'));
    document.getElementById('modeMd').addEventListener('click',()=>switchMode('markdown'));
    document.getElementById('pinBtn').addEventListener('click',()=>{pinned=!pinned;document.getElementById('pinBtn').classList.toggle('active',pinned);document.getElementById('pinBtn').title=pinned?'Unpin':'Pin note';scheduleSave();});
    document.getElementById('prioritySelect').addEventListener('change',scheduleSave);
    document.getElementById('statusSelect').addEventListener('change',e=>{e.target.className='styled-select status-select '+e.target.value;scheduleSave();});
    document.getElementById('titleInput').addEventListener('input',scheduleSave);
    document.getElementById('tagsInput').addEventListener('input',scheduleSave);
    document.getElementById('backBtn').addEventListener('click',()=>{doSave();vscode.postMessage({type:'showList'});});
    const legacyBanner=document.getElementById('annotationBanner');
    if(legacyBanner){legacyBanner.addEventListener('click',()=>{vscode.postMessage({type:'jumpToFile',file:"${note.filePath||''}",noteFolderPath:"${note.folderPath||''}",line:${note.lineStart||1},lineStart:${note.lineStart||1},lineEnd:${note.lineEnd||note.lineStart||1}});});}
    function getContent(){return mode==='wysiwyg'?JSON.stringify(quill.getContents()):document.getElementById('mdEdit').value;}
    function getTags(){return document.getElementById('tagsInput').value.split(',').map(t=>t.trim()).filter(Boolean);}
    function scheduleSave(){document.getElementById('saveStatus').textContent='Unsaved\u2026';document.getElementById('saveStatus').style.opacity='1';clearTimeout(saveTimer);saveTimer=setTimeout(doSave,1000);}
    function doSave(){vscode.postMessage({type:'saveNote',id:noteId,title:document.getElementById('titleInput').value,content:getContent(),editorMode:mode,pinned:pinned,tags:getTags(),priority:document.getElementById('prioritySelect').value,status:document.getElementById('statusSelect').value});}
    function scheduleAnnotationSave(annId){clearTimeout(annSaveTimers[annId]);annSaveTimers[annId]=setTimeout(()=>saveAnnotation(annId),1000);}
    function saveAnnotation(annId){const comment=document.querySelector('.ann-comment[data-ann-id="'+annId+'"]')?.value||'';const status=document.querySelector('.ann-status[data-ann-id="'+annId+'"]')?.value||'open';vscode.postMessage({type:'saveAnnotation',annotationId:annId,comment,status});}
    function deleteAnnotation(annId){vscode.postMessage({type:'deleteAnnotation',annotationId:annId});}
    function toggleAnnotation(annId){const block=document.querySelector('.annotation-block[data-ann-id="'+annId+'"]');if(block){block.classList.toggle('expanded');}}
    document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();clearTimeout(saveTimer);doSave();}});
    const titleEl=document.getElementById('titleInput');
    if(titleEl.value==='Untitled'){titleEl.focus();titleEl.select();}
    window.addEventListener('message',e=>{
      if(e.data.type==='saved'){document.getElementById('saveStatus').textContent='Saved';document.getElementById('saveStatus').style.opacity='.6';const s=document.getElementById('status');s.textContent='\u2713 Saved';setTimeout(()=>{s.textContent='';},2000);}
      if(e.data.type==='notionSynced'){
        const bar=document.getElementById('exportHistoryBar');
        if(bar){const chip=bar.querySelector('.export-chip[data-dest="notion"]');if(chip){const d=new Date(e.data.ts);chip.title='Last auto-synced '+d.toLocaleString();}}
      }
      if(e.data.type==='taskReminded'){
        const btn=document.getElementById('todoistBtn');
        if(btn){
          const label=e.data.recurrence?e.data.recurrence:e.data.due?e.data.due.slice(0,10):'';
          const providerLabel=e.data.provider==='todoist'?'Todoist':'Google Tasks';
          btn.innerHTML='\u2713 '+providerLabel+(label?' \u2014 '+label:'');
          btn.style.color='#fbbf24';
          btn.style.borderColor='rgba(251,191,36,.4)';
          btn.title='Reminder set \u2014 click to manage';
          setTimeout(()=>{
            btn.innerHTML='\u23f0 Remind me';
            btn.style.color='';
            btn.style.borderColor='';
            btn.title='Set a reminder';
          },6000);
        }
      }
      if(e.data.type==='addTaskChip'){
        let bar=document.getElementById('exportHistoryBar');
        if(!bar){
          // Create the bar if it doesn't exist yet (note had no exports before)
          bar=document.createElement('div');
          bar.id='exportHistoryBar';
          bar.className='export-history-bar';
          // Insert after annotations/before editor-wrap
          const editorWrap=document.getElementById('wysiwygWrap')||document.getElementById('mdWrap');
          if(editorWrap){editorWrap.parentNode.insertBefore(bar,editorWrap);}
        }
        // Remove existing chip for this provider if any
        const existing=bar.querySelector('.task-chip-'+e.data.provider);
        if(existing){existing.remove();}
        const chip=document.createElement('span');
        chip.className='export-chip task-chip-'+e.data.provider;
        chip.style.borderColor='rgba(251,191,36,.35)';
        chip.style.color='#fbbf24';
        chip.title=e.data.chipTitle;
        chip.textContent=e.data.chipText;
        bar.appendChild(chip);
      }
    });
    document.getElementById('notionBtn').addEventListener('click',()=>{
      doSave();
      vscode.postMessage({type:'exportToNotion',id:noteId});
    });
    document.getElementById('obsidianBtn').addEventListener('click',()=>{
      doSave();
      vscode.postMessage({type:'exportToObsidian',id:noteId});
    });
    document.getElementById('todoistBtn').addEventListener('click',()=>{
      doSave();
      vscode.postMessage({type:'sendToTodoist',id:noteId});
    });
  <\/script></body></html>`;
}

// ── Extension Entry Point ─────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  const secrets = context.secrets;
  let panel: vscode.WebviewView | undefined;
  let currentNoteId: string | null = null;
  let iconUri = '';
  installMcpBridge(context);

  const openNotePanels = new Map<string, vscode.WebviewPanel>();
  const openingNotes = new Set<string>();

  // ── Notion auto-sync state ────────────────────────────────────────────────────
  const SYNC_DEBOUNCE_MS  = 60_000;  // wait 60s of idle before syncing
  const SYNC_COOLDOWN_MS  = 300_000; // minimum 5min between syncs per note
  const notionSyncTimers    = new Map<string, ReturnType<typeof setTimeout>>();
  const notionSyncCooldowns = new Map<string, number>(); // noteId → last sync epoch ms

  function getNoteColors(): { bg: string; text: string } {
    const config = vscode.workspace.getConfiguration('notevs');
    return { bg: config.get('noteBgColor', '#1e1e1e'), text: config.get('noteTextColor', '#d4d4d4') };
  }

  let memCache: { notes: NoteItem[]; cachedAt: string } | null = null;

  function cacheKey(): string {
    const fp = getFolderPath();
    return fp ? `notesCache:${fp}` : 'notesCache:__none__';
  }

  function loadCache(): { notes: NoteItem[]; cachedAt: string } | null {
    if (memCache) { return memCache; }
    const raw = context.globalState.get<NotesCacheEntry>(cacheKey());
    if (raw) { memCache = raw; }
    return memCache;
  }

  async function saveCache(notes: NoteItem[]): Promise<void> {
    const entry: NotesCacheEntry = { notes, cachedAt: new Date().toISOString() };
    memCache = entry;
    await context.globalState.update(cacheKey(), entry);
  }

  function updateNoteInCache(updated: NoteItem): void {
    if (!memCache) { return; }
    const idx = memCache.notes.findIndex(n => n.id === updated.id);
    if (idx !== -1) { memCache.notes[idx] = updated; }
    context.globalState.update(cacheKey(), memCache);
  }

  function patchNoteInCache(id: string, patch: Partial<NoteItem>): void {
    if (!memCache) { return; }
    const idx = memCache.notes.findIndex(n => n.id === id);
    if (idx !== -1) { memCache.notes[idx] = { ...memCache.notes[idx], ...patch, updatedAt: new Date().toISOString() }; }
    context.globalState.update(cacheKey(), memCache);
  }

  const QUEUE_KEY = 'offlineQueue';

  function getQueue(): OfflineQueueItem[] {
    return context.globalState.get<OfflineQueueItem[]>(QUEUE_KEY) ?? [];
  }

  async function enqueueOfflinePatch(item: OfflineQueueItem): Promise<void> {
    const q = getQueue().filter(i => i.id !== item.id);
    q.push(item);
    await context.globalState.update(QUEUE_KEY, q);
    patchNoteInCache(item.id, { ...item.patch });
  }

  async function flushOfflineQueue(): Promise<void> {
    const q = getQueue();
    if (!q.length) { return; }
    const remaining: OfflineQueueItem[] = [];
    for (const item of q) {
      try {
        const res = await apiGet(secrets, `/notes/${item.id}`);
        const serverNote: NoteItem = res.data.data;
        const serverUpdated = new Date(serverNote.updatedAt).getTime();
        const localEdited = new Date(item.localUpdatedAt).getTime();
        const cachedAt = memCache ? new Date(memCache.cachedAt).getTime() : 0;
        if (serverUpdated > cachedAt && serverUpdated > localEdited) {
          const choice = await vscode.window.showWarningMessage(
            `"${serverNote.title}" was edited on another machine while offline. Which version to keep?`,
            { modal: true }, 'Keep my offline version', 'Keep server version'
          );
          if (choice === 'Keep server version') { updateNoteInCache(serverNote); continue; }
        }
        await apiPatch(secrets, `/notes/${item.id}`, item.patch);
        updateNoteInCache({ ...serverNote, ...item.patch, updatedAt: new Date().toISOString() });
      } catch { remaining.push(item); }
    }
    await context.globalState.update(QUEUE_KEY, remaining);
  }

  // ── openNote ──────────────────────────────────────────────────────────────────
  async function openNote(id: string) {
    const folderPath = getFolderPath();
    const projectName = folderPath?.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project';
    const { bg, text } = getNoteColors();

    const existingPanel = openNotePanels.get(id);
    if (existingPanel) { existingPanel.reveal(vscode.ViewColumn.Beside); return; }

    if (openingNotes.has(id)) { return; }
    openingNotes.add(id);

    const cached = loadCache();
    const cachedNote = cached?.notes.find(n => n.id === id);
    const noteTitle = cachedNote?.title || 'Note';

    const notePanel = vscode.window.createWebviewPanel(
      'notenest.note', noteTitle,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    openNotePanels.set(id, notePanel);
    openingNotes.delete(id);
    notePanel.onDidDispose(() => {
      openNotePanels.delete(id);
      // Cancel any pending auto-sync timer for this note
      const t = notionSyncTimers.get(id);
      if (t) { clearTimeout(t); notionSyncTimers.delete(id); }
    }, null, context.subscriptions);

    const syncEnabledOpen = context.globalState.get<boolean>('notevs.syncEnabled') ?? false;

    const localNote = readLocalNote(context, id);
    const displayNote = localNote || cachedNote;
    if (displayNote) {
      notePanel.webview.html = noteEditorHtml(displayNote, projectName, bg, text);
    } else {
      notePanel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);font-size:13px;}</style></head><body>Loading note\u2026</body></html>`;
    }

    if (syncEnabledOpen) {
      try {
        const res = await apiGet(secrets, `/notes/${id}`);
        const freshNote: NoteItem = res.data.data;
        updateNoteInCache(freshNote);
        notePanel.title = freshNote.title || 'Note';
        notePanel.webview.html = noteEditorHtml(freshNote, projectName, bg, text);
      } catch {
        if (!displayNote) { notePanel.dispose(); }
      }
    }

    notePanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'saveNote') {
        const patch = { title: msg.title, content: msg.content, editorMode: msg.editorMode, pinned: msg.pinned, tags: msg.tags, priority: msg.priority, status: msg.status };
        notePanel.title = msg.title || 'Note';
        const syncEnabledSave = context.globalState.get<boolean>('notevs.syncEnabled') ?? false;
        const fp2 = getFolderPath();
        const pn2 = fp2?.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project';
        if (!syncEnabledSave) {
          const existing = readLocalNote(context, msg.id);
          if (existing) {
            const updated: NoteItem = { ...existing, ...patch, updatedAt: new Date().toISOString() };
            writeLocalNote(context, updated);

            // ── Notion auto-sync ──
            const autoSync = vscode.workspace.getConfiguration('notevs').get<boolean>('notionAutoSync', false);
            if (autoSync && updated.exports?.notion?.pageId) {
              // Reset debounce timer
              const prev = notionSyncTimers.get(msg.id);
              if (prev) { clearTimeout(prev); }
              const timer = setTimeout(async () => {
                notionSyncTimers.delete(msg.id);
                // Enforce cooldown
                const lastSync = notionSyncCooldowns.get(msg.id) ?? 0;
                if (Date.now() - lastSync < SYNC_COOLDOWN_MS) { return; }
                notionSyncCooldowns.set(msg.id, Date.now());
                // Read the freshest version of the note before syncing
                const fresh = readLocalNote(context, msg.id);
                if (!fresh?.exports?.notion?.pageId) { return; }
                await sendToNotion(secrets, context.globalState, fresh, (dest, ts, pgId, pgUrl) => {
                  const afterSync = readLocalNote(context, msg.id);
                  if (afterSync && pgId) {
                    afterSync.exports = { ...afterSync.exports, notion: { ts, pageId: pgId, pageUrl: pgUrl || '' } };
                    writeLocalNote(context, afterSync);
                    // Update the chip in the open panel without re-rendering the full editor
                    notePanel.webview.postMessage({ type: 'notionSynced', ts });
                    // Refresh sidebar list quietly
                    const fp3 = getFolderPath();
                    if (panel && fp3) { const pn3 = fp3.split(/[\/\\]/).filter(Boolean).pop() ?? 'Project'; panel.webview.html = notesListHtml(pn3, readLocalNotesGrouped(context, fp3), getSubfolderOptions(context, fp3), 'local'); }
                  }
                }, { silent: true });
              }, SYNC_DEBOUNCE_MS);
              notionSyncTimers.set(msg.id, timer);
            }
            // ── end auto-sync ──
          }
          if (panel && fp2) { panel.webview.html = notesListHtml(pn2, readLocalNotesGrouped(context, fp2), getSubfolderOptions(context, fp2), 'local'); }
          notePanel.webview.postMessage({ type: 'saved' });
        } else {
          patchNoteInCache(msg.id, patch);
          if (panel && fp2) { panel.webview.html = notesListHtml(pn2, readLocalNotesGrouped(context, fp2), getSubfolderOptions(context, fp2), 'local'); }
          try {
            await apiPatch(secrets, `/notes/${msg.id}`, patch);
            flushOfflineQueue().catch(() => {});
            notePanel.webview.postMessage({ type: 'saved' });
          } catch (e: unknown) {
            const err = e as { message?: string };
            if (err.message === 'NOT_AUTHENTICATED') { if (panel) { panel.webview.html = loginHtml(iconUri); } }
            else { await enqueueOfflinePatch({ id: msg.id, patch, localUpdatedAt: new Date().toISOString() }); notePanel.webview.postMessage({ type: 'saved' }); }
          }
        }
      }
      if (msg.type === 'jumpToFile') {
        const fp2 = (msg.noteFolderPath || getFolderPath()); if (!fp2 || !msg.file) return;
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(`${fp2}/${msg.file}`));
          const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
          const sl = Math.max(0, (msg.lineStart || msg.line || 1) - 1);
          const el = Math.max(0, (msg.lineEnd || msg.lineStart || msg.line || 1) - 1);
          const elt = doc.lineAt(Math.min(el, doc.lineCount - 1));
          const range = new vscode.Range(sl, 0, elt.lineNumber, elt.text.length);
          editor.selection = new vscode.Selection(range.start, range.end);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch { vscode.window.showErrorMessage(`Could not open file: ${msg.file}`); }
      }
      if (msg.type === 'deleteAnnotation') {
        try {
          await apiDelete(secrets, `/annotations/${msg.annotationId}`);
          const res = await apiGet(secrets, `/notes/${id}`);
          const fn: NoteItem = res.data.data;
          updateNoteInCache(fn);
          notePanel.webview.html = noteEditorHtml(fn, projectName, bg, text);
        } catch { vscode.window.showErrorMessage('Failed to delete annotation.'); }
      }
      if (msg.type === 'saveAnnotation') {
        try {
          await apiPatch(secrets, `/annotations/${msg.annotationId}`, { comment: msg.comment, status: msg.status });
          notePanel.webview.postMessage({ type: 'annotationSaved', annotationId: msg.annotationId });
        } catch { /* offline */ }
      }
      if (msg.type === 'exportToNotion') {
        const note = readLocalNote(context, id);
        if (!note) { vscode.window.showErrorMessage('Note not found.'); return; }
        await sendToNotion(secrets, context.globalState, note, (dest, ts, pageId, pageUrl) => {
          const latest = readLocalNote(context, id);
          if (latest) {
            if (dest === 'notion' && pageId) {
              latest.exports = { ...latest.exports, notion: { ts, pageId, pageUrl: pageUrl || '' } };
            } else {
              latest.exports = { ...latest.exports, [dest]: ts };
            }
            writeLocalNote(context, latest);
            notePanel.webview.html = noteEditorHtml(latest, projectName, bg, text);
            if (panel) { const fp2 = getFolderPath(); if (fp2) { const pn2 = fp2.split(/[\/\\]/).filter(Boolean).pop() ?? 'Project'; panel.webview.html = notesListHtml(pn2, readLocalNotesGrouped(context, fp2), getSubfolderOptions(context, fp2), 'local'); } }
          }
        });
      }
      if (msg.type === 'exportToObsidian') {
        const note = readLocalNote(context, id);
        if (!note) { vscode.window.showErrorMessage('Note not found.'); return; }
        await sendToObsidian(secrets, context.globalState, note, (dest, ts) => {
          const latest = readLocalNote(context, id);
          if (latest) {
            latest.exports = { ...latest.exports, [dest]: ts };
            writeLocalNote(context, latest);
            notePanel.webview.html = noteEditorHtml(latest, projectName, bg, text);
            if (panel) { const fp2 = getFolderPath(); if (fp2) { const pn2 = fp2.split(/[\/\\]/).filter(Boolean).pop() ?? 'Project'; panel.webview.html = notesListHtml(pn2, readLocalNotesGrouped(context, fp2), getSubfolderOptions(context, fp2), 'local'); } }
          }
        });
      }
      if (msg.type === 'sendToTodoist') {
        const note = readLocalNote(context, id);
        if (!note) { vscode.window.showErrorMessage('Note not found.'); return; }
        const fp2 = getFolderPath();
        const pn2 = fp2?.split(/[\/\\]/).filter(Boolean).pop() ?? 'Project';

        const onReminded: OnRemindedCallback = (provider, record) => {
          const latest = readLocalNote(context, id);
          if (latest) {
            latest.reminders = {
              ...latest.reminders,
              [provider === 'todoist' ? 'todoist' : 'googleTasks']: record,
            };
            writeLocalNote(context, latest);
            // Update button temporarily
            notePanel.webview.postMessage({ type: 'taskReminded', provider, due: record.due, recurrence: record.recurrence });
            // Add chip to export history bar without full re-render
            const chipLabel = record.recurrence ? record.recurrence : record.due.slice(0, 10);
            const chipText  = provider === 'todoist' ? `\u23f0 Todoist \u2014 ${chipLabel}` : `\u23f0 Google Tasks \u2014 ${chipLabel}`;
            const chipTitle = provider === 'todoist'
              ? `Reminded via Todoist on ${new Date(record.ts).toLocaleString()}`
              : `Added to Google Tasks on ${new Date(record.ts).toLocaleString()}`;
            notePanel.webview.postMessage({ type: 'addTaskChip', provider, chipText, chipTitle });
            if (panel && fp2) { panel.webview.html = notesListHtml(pn2, readLocalNotesGrouped(context, fp2), getSubfolderOptions(context, fp2), 'local'); }
          }
        };

        // Check if a reminder already exists on this note
        const todoistR  = note.reminders?.todoist;
        const googleR   = note.reminders?.googleTasks;
        const hasExistingReminder = !!(todoistR || googleR);

        if (hasExistingReminder) {
          // Determine which provider's reminder to manage
          // If both exist, ask which to manage
          let existingProvider: 'todoist' | 'googleTasks';
          let existingRecord: typeof todoistR | typeof googleR;

          if (todoistR && googleR) {
            const pick = await vscode.window.showQuickPick(
              [
                { label: `⏰ Todoist — ${todoistR.recurrence ?? todoistR.due.slice(0, 10)}`, value: 'todoist' as const },
                { label: `⏰ Google Tasks — ${googleR.due.slice(0, 10)}`,                    value: 'googleTasks' as const },
              ],
              { title: 'Which reminder do you want to manage?', ignoreFocusOut: true },
            );
            if (!pick) { return; }
            existingProvider = pick.value;
            existingRecord = existingProvider === 'todoist' ? todoistR : googleR;
          } else if (todoistR) {
            existingProvider = 'todoist';
            existingRecord = todoistR;
          } else {
            existingProvider = 'googleTasks';
            existingRecord = googleR!;
          }

          const result = await manageExistingReminder(secrets, {
            provider:    existingProvider,
            taskId:      existingRecord!.taskId,
            taskListId:  (existingRecord as typeof googleR)?.taskListId,
            due:         existingRecord!.due,
            recurrence:  (existingRecord as typeof todoistR)?.recurrence,
          }, note.title);

          if (!result) { return; }

          if (result.action === 'cleared') {
            const latest = readLocalNote(context, id);
            if (latest) {
              if (existingProvider === 'todoist') { delete latest.reminders?.todoist; }
              else                                { delete latest.reminders?.googleTasks; }
              if (!latest.reminders?.todoist && !latest.reminders?.googleTasks) { delete latest.reminders; }
              writeLocalNote(context, latest);
              notePanel.webview.html = noteEditorHtml(latest, projectName, bg, text);
              if (panel && fp2) { panel.webview.html = notesListHtml(pn2, readLocalNotesGrouped(context, fp2), getSubfolderOptions(context, fp2), 'local'); }
            }
          } else if (result.action === 'updated') {
            onReminded(existingProvider, result.record);
            notePanel.webview.html = noteEditorHtml(readLocalNote(context, id) ?? note, projectName, bg, text);
          } else if (result.action === 'new') {
            await sendToTaskProvider(secrets, context.globalState, note, onReminded);
          }
        } else {
          await sendToTaskProvider(secrets, context.globalState, note, onReminded);
        }
      }
    }, null, context.subscriptions);
  }

  // ── Sidebar provider ──────────────────────────────────────────────────────────
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      panel = webviewView;
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      };
      iconUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png')).toString();

      async function render() {
        // Always force local-only mode — cloud sync is disabled
        await context.globalState.update('notevs.syncEnabled', false);
        await context.globalState.update('notevs.firstRunComplete', true);
        const folderPath = getFolderPath();
        if (!folderPath) { webviewView.webview.html = noFolderHtml(); return; }
        const groups = readLocalNotesGrouped(context, folderPath);
        const projectName = folderPath.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project';
        webviewView.webview.html = notesListHtml(projectName, groups, getSubfolderOptions(context, folderPath), 'local');
      }

      async function showNotesList() {
        await render();
      }

      webviewView.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case 'getStarted': { await context.globalState.update('notevs.firstRunComplete', true); await context.globalState.update('notevs.syncEnabled', false); await render(); break; }
          case 'enableSync': { await context.globalState.update('notevs.firstRunComplete', true); await context.globalState.update('notevs.syncEnabled', true); webviewView.webview.html = loginHtml(iconUri); break; }
          case 'keepSync': { await context.globalState.update('notevs.firstRunComplete', true); await context.globalState.update('notevs.syncEnabled', true); await render(); break; }
          case 'goLocalOnly': { await context.globalState.update('notevs.firstRunComplete', true); await context.globalState.update('notevs.syncEnabled', false); await clearTokens(secrets); await render(); break; }
          case 'toggleSync': {
            if (msg.enabled) { await context.globalState.update('notevs.syncEnabled', true); webviewView.webview.html = loginHtml(iconUri); }
            else {
              const ok = await vscode.window.showWarningMessage('Disable sync? Your notes will stay on this device.', { modal: true }, 'Disable sync');
              if (ok === 'Disable sync') { await context.globalState.update('notevs.syncEnabled', false); await clearTokens(secrets); await render(); }
              else { const config = vscode.workspace.getConfiguration('notevs'); const lsAt = context.globalState.get<string | null>('notevs.lastSyncAt') ?? null; webviewView.webview.html = settingsHtml(config.get('autoShow', true), config.get('noteBgColor', '#1e1e1e'), true, null, lsAt, false, false, '', false); }
            }
            break;
          }
          case 'syncNow': {
            await render();
            break;
          }
          case 'startLogin': await startLoginFlow(secrets, () => render()); break;
          case 'showList': await render(); break;
          case 'chooseFolder': {
            const workspacePath = getFolderPath(); if (!workspacePath) break;
            const wsLabel = workspacePath.split(/[\/\\]/).filter(Boolean).pop() ?? workspacePath;
            const folderItems = [
              { label: `$(folder-opened) ${wsLabel}`, description: 'workspace root', folderPath: workspacePath },
              ...msg.subfolders.map((s: {label: string; folderPath: string}) => ({ label: `$(folder) ${s.label}`, description: s.folderPath.replace(workspacePath + '/', ''), folderPath: s.folderPath })),
            ];
            const picked = await vscode.window.showQuickPick(folderItems, { title: 'Create note in…', placeHolder: 'Choose a folder for the new note', ignoreFocusOut: true });
            if (picked) { webviewView.webview.postMessage({ type: 'showNewNoteInput', folderPath: picked.folderPath }); }
            break;
          }
          case 'openFolder': vscode.commands.executeCommand('vscode.openFolder'); break;
          case 'newNote': {
            const folderPath = getFolderPath(); if (!folderPath) { vscode.window.showWarningMessage('Open a folder first.'); break; }
            const targetFolder: string = msg.targetFolder || folderPath;
            const projectName = folderPath.split(/[\/\\]/).filter(Boolean).pop() ?? 'Project';
            const title = msg.title || 'Untitled';
            const syncEnabled2 = context.globalState.get<boolean>('notevs.syncEnabled') ?? false;
            if (!syncEnabled2) {
              const now = new Date().toISOString();
              const newNote: NoteItem = { id: randomUUID(), localId: randomUUID(), title, content: '', editorMode: 'wysiwyg', pinned: false, tags: [], priority: 'none', status: 'open', createdAt: now, updatedAt: now, folderPath: targetFolder, deletedAt: null, syncedAt: null };
              writeLocalNote(context, newNote);
              webviewView.webview.html = notesListHtml(projectName, readLocalNotesGrouped(context, folderPath), getSubfolderOptions(context, folderPath), 'local');
              await openNote(newNote.id);
            } else {
              try {
                const res = await apiPost(secrets, '/notes', { folderPath, title, content: '', editorMode: 'wysiwyg' });
                const newNote: NoteItem = res.data.data;
                if (memCache) { memCache.notes.unshift(newNote); context.globalState.update(cacheKey(), memCache); } else { await saveCache([newNote]); }
                webviewView.webview.html = notesListHtml(projectName, readLocalNotesGrouped(context, folderPath), getSubfolderOptions(context, folderPath), 'local');
                await openNote(newNote.id);
              } catch { vscode.window.showErrorMessage('Failed to create note.'); }
            }
            break;
          }
          case 'openNote': await openNote(msg.id); break;
          case 'openNoteFromHost': await openNote(msg.id); break;
          case 'jumpToFile': {
            const folderPath = (msg.noteFolderPath || getFolderPath()); if (!folderPath || !msg.file) break;
            try {
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(`${folderPath}/${msg.file}`));
              const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
              const startLine = Math.max(0, (msg.lineStart || msg.line || 1) - 1);
              const endLine = Math.max(0, (msg.lineEnd || msg.lineStart || msg.line || 1) - 1);
              const endLineText = doc.lineAt(Math.min(endLine, doc.lineCount - 1));
              const range = new vscode.Range(startLine, 0, endLineText.lineNumber, endLineText.text.length);
              editor.selection = new vscode.Selection(range.start, range.end); editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            } catch { vscode.window.showErrorMessage(`Could not open file: ${msg.file}`); }
            break;
          }
          case 'saveNote': break;
          case 'deleteNote': {
            const ok = await vscode.window.showWarningMessage('Delete this note? This cannot be undone.', { modal: true }, 'Delete');
            if (ok === 'Delete') {
              const notePanel = openNotePanels.get(msg.id); if (notePanel) { notePanel.dispose(); }
              const syncEnabledDel = context.globalState.get<boolean>('notevs.syncEnabled') ?? false;
              if (!syncEnabledDel) {
                deleteLocalNote(context, msg.id);
                const folderPathDel = getFolderPath();
                const activeEdDel = vscode.window.activeTextEditor; if (activeEdDel) { refreshAnnotations(activeEdDel); }
                if (folderPathDel) { const pnDel = folderPathDel.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project'; webviewView.webview.html = notesListHtml(pnDel, readLocalNotesGrouped(context, folderPathDel), getSubfolderOptions(context, folderPathDel), 'local'); }
              } else {
                if (memCache) { memCache.notes = memCache.notes.filter(n => n.id !== msg.id); context.globalState.update(cacheKey(), memCache); }
                try { await apiDelete(secrets, `/notes/${msg.id}`); } catch { /* ignore */ }
                await render();
              }
            }
            break;
          }
          case 'openSettings': {
            const config = vscode.workspace.getConfiguration('notevs');
            const syncEnabledSettings = context.globalState.get<boolean>('notevs.syncEnabled') ?? false;
            const lastSyncAtSettings = context.globalState.get<string | null>('notevs.lastSyncAt') ?? null;
            let syncUserEmailSettings: string | null = null;
            if (syncEnabledSettings) { try { const u = await secrets.get('user'); syncUserEmailSettings = u ? JSON.parse(u)?.email ?? null : null; } catch { /* no user stored */ } }
            const notionConnectedSettings = await hasNotionToken(secrets);
            const obsStatus = await getObsidianStatus(secrets, context.globalState);
            const todoistConn = await hasTodoistToken(secrets);
            const googleConn = await isGoogleTasksConnected(secrets);
            webviewView.webview.html = settingsHtml(config.get('autoShow', true), config.get('noteBgColor', '#1e1e1e'), syncEnabledSettings, syncUserEmailSettings, lastSyncAtSettings, notionConnectedSettings, obsStatus.apiKey, obsStatus.vaultPath, config.get('notionAutoSync', false), todoistConn, googleConn);
            break;
          }
          case 'saveNotionToken': {
            if (msg.token) { await secrets.store('notionToken', msg.token); }
            const cfgN1 = vscode.workspace.getConfiguration('notevs');
            const obsN1 = await getObsidianStatus(secrets, context.globalState);
            webviewView.webview.html = settingsHtml(cfgN1.get('autoShow', true), cfgN1.get('noteBgColor', '#1e1e1e'), false, null, null, true, obsN1.apiKey, obsN1.vaultPath, cfgN1.get('notionAutoSync', false));
            vscode.window.showInformationMessage('Notion token saved.');
            break;
          }
          case 'clearNotionToken': {
            await clearNotionToken(secrets, context.globalState);
            const cfgN2 = vscode.workspace.getConfiguration('notevs');
            const obsN2 = await getObsidianStatus(secrets, context.globalState);
            webviewView.webview.html = settingsHtml(cfgN2.get('autoShow', true), cfgN2.get('noteBgColor', '#1e1e1e'), false, null, null, false, obsN2.apiKey, obsN2.vaultPath, cfgN2.get('notionAutoSync', false));
            vscode.window.showInformationMessage('Notion disconnected.');
            break;
          }
          case 'changeNotionPage': {
            await resetNotionPage(context.globalState);
            vscode.window.showInformationMessage('Notion parent page cleared. It will be picked on next export.');
            break;
          }
          case 'saveObsidianApiKey': {
            if (msg.key) { await secrets.store('obsidianApiKey', msg.key); }
            const cfgO1 = vscode.workspace.getConfiguration('notevs');
            const vpO1 = context.globalState.get<string>('notevs.obsidianVaultPath', '');
            webviewView.webview.html = settingsHtml(cfgO1.get('autoShow', true), cfgO1.get('noteBgColor', '#1e1e1e'), false, null, null, await hasNotionToken(secrets), true, vpO1, cfgO1.get('notionAutoSync', false));
            vscode.window.showInformationMessage('Obsidian API key saved.');
            break;
          }
          case 'clearObsidianApiKey': {
            await clearObsidianApiKey(secrets);
            const cfgO2 = vscode.workspace.getConfiguration('notevs');
            const vpO2 = context.globalState.get<string>('notevs.obsidianVaultPath', '');
            webviewView.webview.html = settingsHtml(cfgO2.get('autoShow', true), cfgO2.get('noteBgColor', '#1e1e1e'), false, null, null, await hasNotionToken(secrets), false, vpO2, cfgO2.get('notionAutoSync', false));
            vscode.window.showInformationMessage('Obsidian API key cleared.');
            break;
          }
          case 'browseObsidianVault': {
            const picked = await vscode.window.showOpenDialog({
              canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
              title: 'Select your Obsidian vault folder', openLabel: 'Use this vault',
            });
            if (picked && picked.length > 0) {
              await context.globalState.update('notevs.obsidianVaultPath', picked[0].fsPath);
              const cfgO3 = vscode.workspace.getConfiguration('notevs');
              webviewView.webview.html = settingsHtml(cfgO3.get('autoShow', true), cfgO3.get('noteBgColor', '#1e1e1e'), false, null, null, await hasNotionToken(secrets), !!(await secrets.get('obsidianApiKey')), picked[0].fsPath, cfgO3.get('notionAutoSync', false));
              vscode.window.showInformationMessage(`Obsidian vault set to: ${picked[0].fsPath}`);
            }
            break;
          }
          case 'clearObsidianVaultPath': {
            await clearObsidianVaultPath(context.globalState);
            const cfgO4 = vscode.workspace.getConfiguration('notevs');
            const todoistConn4 = await hasTodoistToken(secrets);
            const googleConn4 = await isGoogleTasksConnected(secrets);
            webviewView.webview.html = settingsHtml(cfgO4.get('autoShow', true), cfgO4.get('noteBgColor', '#1e1e1e'), false, null, null, await hasNotionToken(secrets), !!(await secrets.get('obsidianApiKey')), '', cfgO4.get('notionAutoSync', false), todoistConn4, googleConn4);
            vscode.window.showInformationMessage('Obsidian vault path cleared.');
            break;
          }
          case 'saveTodoistToken': {
            if (msg.token) { await secrets.store('todoistToken', msg.token.trim()); }
            const cfgT1 = vscode.workspace.getConfiguration('notevs');
            const obsT1 = await getObsidianStatus(secrets, context.globalState);
            const googleT1 = await isGoogleTasksConnected(secrets);
            webviewView.webview.html = settingsHtml(cfgT1.get('autoShow', true), cfgT1.get('noteBgColor', '#1e1e1e'), false, null, null, await hasNotionToken(secrets), obsT1.apiKey, obsT1.vaultPath, cfgT1.get('notionAutoSync', false), true, googleT1);
            vscode.window.showInformationMessage('Todoist token saved.');
            break;
          }
          case 'clearTodoistToken': {
            await clearTodoistToken(secrets);
            await clearTaskProviderPreference(context.globalState);
            const cfgT2 = vscode.workspace.getConfiguration('notevs');
            const obsT2 = await getObsidianStatus(secrets, context.globalState);
            const googleT2 = await isGoogleTasksConnected(secrets);
            webviewView.webview.html = settingsHtml(cfgT2.get('autoShow', true), cfgT2.get('noteBgColor', '#1e1e1e'), false, null, null, await hasNotionToken(secrets), obsT2.apiKey, obsT2.vaultPath, cfgT2.get('notionAutoSync', false), false, googleT2);
            vscode.window.showInformationMessage('Todoist disconnected.');
            break;
          }
          case 'connectGoogleTasks': {
            const ok = await connectGoogleTasks(secrets);
            if (ok) {
              const cfgG1 = vscode.workspace.getConfiguration('notevs');
              const obsG1 = await getObsidianStatus(secrets, context.globalState);
              const todoistG1 = await hasTodoistToken(secrets);
              webviewView.webview.html = settingsHtml(cfgG1.get('autoShow', true), cfgG1.get('noteBgColor', '#1e1e1e'), false, null, null, await hasNotionToken(secrets), obsG1.apiKey, obsG1.vaultPath, cfgG1.get('notionAutoSync', false), todoistG1, true);
            }
            break;
          }
          case 'disconnectGoogleTasks': {
            await disconnectGoogleTasks(secrets);
            await clearTaskProviderPreference(context.globalState);
            const cfgG2 = vscode.workspace.getConfiguration('notevs');
            const obsG2 = await getObsidianStatus(secrets, context.globalState);
            const todoistG2 = await hasTodoistToken(secrets);
            webviewView.webview.html = settingsHtml(cfgG2.get('autoShow', true), cfgG2.get('noteBgColor', '#1e1e1e'), false, null, null, await hasNotionToken(secrets), obsG2.apiKey, obsG2.vaultPath, cfgG2.get('notionAutoSync', false), todoistG2, false);
            vscode.window.showInformationMessage('Google Tasks disconnected.');
            break;
          }
          case 'openExternal': {
            if (msg.url) { vscode.env.openExternal(vscode.Uri.parse(msg.url)); }
            break;
          }
          case 'setSetting': {
            const config = vscode.workspace.getConfiguration('notevs');
            if (msg.key === 'autoShow') { await config.update('autoShow', msg.value, vscode.ConfigurationTarget.Global); }
            if (msg.key === 'noteBgColor') { await config.update('noteBgColor', msg.value, vscode.ConfigurationTarget.Global); await config.update('noteTextColor', msg.textColor, vscode.ConfigurationTarget.Global); }
            if (msg.key === 'notionAutoSync') { await config.update('notionAutoSync', msg.value, vscode.ConfigurationTarget.Global); }
            break;
          }
          case 'logout': await clearTokens(secrets); webviewView.webview.html = loginHtml(iconUri); break;
        }
      });

      render();
    },
  };

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('notevs.notesView', provider));

  // ── Annotation decorations ────────────────────────────────────────────────────
  const annotationDecoration = vscode.window.createTextEditorDecorationType({
    borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: 'rgba(108,142,245,0.7)',
    backgroundColor: 'rgba(108,142,245,0.06)', isWholeLine: true,
    overviewRulerColor: 'rgba(108,142,245,0.6)', overviewRulerLane: vscode.OverviewRulerLane.Right,
    // gutterIconPath removed — logo should not appear on annotation highlights
  });

  interface FlatAnnotation {
    noteId: string; noteTitle: string; noteContent: string; editorMode: string;
    priority: string; status: string; lineStart: number; lineEnd: number; comment: string;
  }
  const annotationCache = new Map<string, FlatAnnotation[]>();

  async function refreshAnnotations(editor: vscode.TextEditor) {
    const folderPath = getFolderPath(); if (!folderPath) { return; }
    const relPath = editor.document.uri.fsPath.replace(folderPath + '/', '').replace(folderPath + '\\', '');
    const syncEnabledRef = context.globalState.get<boolean>('notevs.syncEnabled') ?? false;
    let notes: NoteItem[] = [];
    if (!syncEnabledRef) { notes = readLocalNotesForWorkspace(context, folderPath); }
    else { try { const res = await apiGet(secrets, '/notes', { folderPath }); notes = res.data.data; } catch { return; } }
    const flat: FlatAnnotation[] = [];
    for (const note of notes) {
      if (note.annotations && note.annotations.length > 0) {
        for (const ann of note.annotations) {
          if (ann.filePath === relPath && ann.lineStart != null) {
            flat.push({ noteId: note.id, noteTitle: note.title, noteContent: note.content, editorMode: note.editorMode, priority: note.priority, status: note.status, lineStart: ann.lineStart, lineEnd: ann.lineEnd, comment: ann.comment || '' });
          }
        }
      }
      if (note.filePath === relPath && note.lineStart != null && !(note.annotations && note.annotations.length > 0)) {
        flat.push({ noteId: note.id, noteTitle: note.title, noteContent: note.content, editorMode: note.editorMode, priority: note.priority, status: note.status, lineStart: note.lineStart, lineEnd: note.lineEnd ?? note.lineStart, comment: '' });
      }
    }
    annotationCache.set(relPath, flat);
    const decorations = flat.map(ann => {
      const startLine = Math.max(0, ann.lineStart - 1);
      const endLine = Math.max(0, ann.lineEnd - 1);
      const endLineText = editor.document.lineAt(Math.min(endLine, editor.document.lineCount - 1));
      return { range: new vscode.Range(startLine, 0, endLineText.lineNumber, endLineText.text.length) };
    });
    editor.setDecorations(annotationDecoration, decorations);
  }

  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      provideHover(document, position) {
        const folderPath = getFolderPath(); if (!folderPath) { return; }
        const relPath = document.uri.fsPath.replace(folderPath + '/', '').replace(folderPath + '\\', '');
        const flat = annotationCache.get(relPath) ?? [];
        const hovered = flat.find(ann => { const sl = Math.max(0, ann.lineStart - 1); const el = Math.max(0, ann.lineEnd - 1); return position.line >= sl && position.line <= el; });
        if (!hovered) { return; }
        let preview = '';
        if (hovered.editorMode === 'wysiwyg') { try { preview = JSON.parse(hovered.noteContent)?.ops?.map((op: {insert?: unknown}) => typeof op.insert === 'string' ? op.insert : '').join(''); } catch { preview = hovered.noteContent; } }
        else { preview = hovered.noteContent.replace(/[#*_`]/g, ''); }
        preview = preview.replace(/\n/g, ' ').trim().slice(0, 150);
        const priorityLabel = hovered.priority !== 'none' ? ` \u2022 ${hovered.priority}` : '';
        const statusLabel = hovered.status === 'done' ? ' \u2713 Done' : hovered.status === 'passed' ? ' \u2713 Passed' : ' \u25cf Open';
        const md = new vscode.MarkdownString('', true); md.isTrusted = true;
        md.appendMarkdown(`**\ud83d\udcce ${hovered.noteTitle}**`);
        md.appendMarkdown(`\n\n_${statusLabel}${priorityLabel}_`);
        if (hovered.comment) { md.appendMarkdown(`\n\n${hovered.comment}`); } else if (preview) { md.appendMarkdown(`\n\n${preview}`); }
        const openCmd = vscode.Uri.parse(`command:notevs.openNoteById?${encodeURIComponent(JSON.stringify({ id: hovered.noteId }))}`);
        md.appendMarkdown(`\n\n[Open note \u2192](${openCmd})`);
        const sl = Math.max(0, hovered.lineStart - 1); const el = Math.max(0, hovered.lineEnd - 1);
        const elt = document.lineAt(Math.min(el, document.lineCount - 1));
        return new vscode.Hover(md, new vscode.Range(sl, 0, elt.lineNumber, elt.text.length));
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('notevs.openNoteById', async ({ id }: { id: string }) => { await openNote(id); })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
      provideCodeLenses(document): vscode.CodeLens[] {
        const folderPath = getFolderPath(); if (!folderPath) { return []; }
        const relPath = document.uri.fsPath.replace(folderPath + '/', '').replace(folderPath + '\\', '');
        const flat = annotationCache.get(relPath) ?? [];
        const seen = new Set<string>(); const lenses: vscode.CodeLens[] = [];
        for (const ann of flat) {
          const key = `${ann.noteId}:${ann.lineStart}`; if (seen.has(key)) { continue; } seen.add(key);
          const line = Math.max(0, ann.lineStart - 1);
          lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title: `\ud83d\udcce ${ann.noteTitle}`, command: 'notevs.openNoteById', arguments: [{ id: ann.noteId }], tooltip: 'Open this NoteVs note' }));
        }
        return lenses;
      },
    })
  );

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => { if (editor) { refreshAnnotations(editor); } }));
  if (vscode.window.activeTextEditor) { refreshAnnotations(vscode.window.activeTextEditor); }
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => { const editor = vscode.window.visibleTextEditors.find(e => e.document === doc); if (editor) { refreshAnnotations(editor); } }));

  async function refreshGutterDecorations(editor: vscode.TextEditor) { await refreshAnnotations(editor); }

  const selectionDecoration = vscode.window.createTextEditorDecorationType({
    after: { contentText: '  NoteVs \u2318\u21e7N to annotate', color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 12px', fontStyle: 'italic', fontWeight: '400' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  const annotateStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  annotateStatusBarItem.text = '\ud83d\udcce Annotate selection';
  annotateStatusBarItem.tooltip = 'Add a NoteVs note to the selected code \u2014 or press \u2318\u21e7N';
  annotateStatusBarItem.command = 'notevs.annotateSelectionFromStatusBar';
  annotateStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  context.subscriptions.push(annotateStatusBarItem);

  let savedEditorUri: vscode.Uri | null = null;
  let savedSelection: vscode.Selection | null = null;
  let selectionDecorationTimer: ReturnType<typeof setTimeout> | null = null;

  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => {
    if (selectionDecorationTimer) { clearTimeout(selectionDecorationTimer); }
    const editor = e.textEditor; const selection = editor.selection;
    if (selection.isEmpty) { editor.setDecorations(selectionDecoration, []); annotateStatusBarItem.hide(); return; }
    selectionDecorationTimer = setTimeout(() => {
      if (editor.selection.isEmpty) { editor.setDecorations(selectionDecoration, []); annotateStatusBarItem.hide(); savedSelection = null; savedEditorUri = null; return; }
      savedSelection = new vscode.Selection(editor.selection.start, editor.selection.end);
      savedEditorUri = editor.document.uri;
      const endPos = editor.selection.end; const endLine = editor.document.lineAt(endPos.line);
      editor.setDecorations(selectionDecoration, [{ range: new vscode.Range(endPos.line, endLine.range.end.character, endPos.line, endLine.range.end.character) }]);
      annotateStatusBarItem.show();
    }, 150);
  }));

  context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
    provideCodeActions(document, range) {
      if (range.isEmpty) { return []; }
      const action = new vscode.CodeAction('\ud83d\udcce NoteVs: Annotate this selection', vscode.CodeActionKind.Empty);
      action.command = { command: 'notevs.annotateSelection', title: '\ud83d\udcce NoteVs: Annotate this selection' };
      return [action];
    },
  }, { providedCodeActionKinds: [vscode.CodeActionKind.Empty] }));

  async function runAnnotate(docUri: vscode.Uri, selection: vscode.Selection) {
    const folderPath = getFolderPath(); if (!folderPath) { vscode.window.showWarningMessage('Open a folder first to use NoteVs annotations.'); return; }
    const syncEnabledAnnotate = context.globalState.get<boolean>('notevs.syncEnabled') ?? false;
    // Auth gate removed — annotations work locally without sign-in
    // if (syncEnabledAnnotate) { const { accessToken } = await getTokens(secrets); if (!accessToken) { vscode.window.showErrorMessage('Sign in to NoteVs first.'); return; } }
    const doc = await vscode.workspace.openTextDocument(docUri);
    const codeSnippet = doc.getText(selection);
    const relPath = docUri.fsPath.replace(folderPath + '/', '').replace(folderPath + '\\', '');
    const lineStart = selection.start.line + 1; const lineEnd = selection.end.line + 1;
    const locationLabel = `${relPath}:${lineStart}\u2013${lineEnd}`;
    const syncEnabledAnn = context.globalState.get<boolean>('notevs.syncEnabled') ?? false;
    const existingNotes: NoteItem[] = syncEnabledAnn ? (loadCache()?.notes ?? []) : readLocalNotesForWorkspace(context, folderPath);
    interface AnnotatePickItem extends vscode.QuickPickItem { noteId?: string; }
    const items: AnnotatePickItem[] = [{ label: '$(add) Create new note', description: '', detail: `New note with this annotation attached \u2014 ${locationLabel}`, noteId: undefined }];
    if (existingNotes.length > 0) {
      items.push({ label: 'Add to existing note', kind: vscode.QuickPickItemKind.Separator });
      for (const n of existingNotes) {
        const annCount = (n.annotations?.length ?? 0) + (n.filePath ? 1 : 0);
        const annLabel = annCount > 0 ? `${annCount} annotation${annCount > 1 ? 's' : ''} \u00b7 ` : '';
        const date = new Date(n.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        let preview = '';
        if (n.editorMode === 'markdown') { preview = (n.content || '').replace(/[#*_`\[\]]/g, '').replace(/\n/g, ' ').trim().slice(0, 60); }
        else { try { preview = (JSON.parse(n.content || '').ops || []).map((op: {insert?: unknown}) => typeof op.insert === 'string' ? op.insert : '').join('').replace(/\n/g, ' ').trim().slice(0, 60); } catch { preview = (n.content || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 60); } }
        items.push({ label: `$(note) ${n.title}`, description: `${annLabel}${date}`, detail: preview || 'Empty note', noteId: n.id });
      }
    }
    const picked = await vscode.window.showQuickPick(items, { title: 'Add Annotation', placeHolder: 'Create a new note or add to an existing one\u2026', matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true });
    if (!picked) { return; }
    const pnAnn = folderPath.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project';
    if (!picked.noteId) {
      const title = await vscode.window.showInputBox({ title: 'Add Annotation', step: 1, totalSteps: 2, prompt: `New note for ${locationLabel}`, placeHolder: 'Note title\u2026', ignoreFocusOut: true });
      if (title === undefined) { return; }
      const comment = await vscode.window.showInputBox({ title: 'Add Annotation', step: 2, totalSteps: 2, prompt: 'Add a comment for this annotation (optional)', placeHolder: 'e.g. This needs refactoring\u2026', ignoreFocusOut: true });
      if (comment === undefined) { return; }
      if (!syncEnabledAnn) {
        const now = new Date().toISOString(); const annId = randomUUID();
        const newNote: NoteItem = { id: randomUUID(), localId: randomUUID(), title: title || 'Untitled annotation', content: '', editorMode: 'wysiwyg', pinned: false, tags: [], priority: 'none', status: 'open', createdAt: now, updatedAt: now, folderPath, deletedAt: null, syncedAt: null, annotations: [{ id: annId, noteId: '', filePath: relPath, lineStart, lineEnd, codeSnippet: codeSnippet.slice(0, 500), comment: comment || '', status: 'open', createdAt: now, updatedAt: now }] };
        newNote.annotations![0].noteId = newNote.id;
        writeLocalNote(context, newNote);
        if (panel) { panel.webview.html = notesListHtml(pnAnn, readLocalNotesGrouped(context, folderPath), getSubfolderOptions(context, folderPath), 'local'); }
        const activeEd = vscode.window.activeTextEditor; if (activeEd) { await refreshAnnotations(activeEd); }
        vscode.window.showInformationMessage(`\ud83d\udcce Annotation added to new note \u201c${newNote.title}\u201d`);
      } else {
        try {
          const noteRes = await apiPost(secrets, '/notes', { folderPath, title: title || 'Untitled annotation', content: '', editorMode: 'wysiwyg' });
          const newNote: NoteItem = noteRes.data.data;
          const annRes = await apiPost(secrets, '/annotations', { noteId: newNote.id, filePath: relPath, lineStart, lineEnd, codeSnippet: codeSnippet.slice(0, 500), comment: comment || '', status: 'open' });
          newNote.annotations = [annRes.data.data];
          if (memCache) { memCache.notes.unshift(newNote); context.globalState.update(cacheKey(), memCache); } else { await saveCache([newNote]); }
          if (panel) { panel.webview.html = notesListHtml(pnAnn, readLocalNotesGrouped(context, folderPath), getSubfolderOptions(context, folderPath), 'local'); }
          vscode.window.showInformationMessage(`\ud83d\udcce Annotation added to new note \u201c${newNote.title}\u201d`);
        } catch { vscode.window.showErrorMessage('Failed to create note and annotation.'); return; }
      }
    } else {
      const targetNote = existingNotes.find(n => n.id === picked.noteId)!;
      const comment = await vscode.window.showInputBox({ title: 'Add Annotation', step: 1, totalSteps: 1, prompt: `Adding annotation to \u201c${targetNote.title}\u201d \u2014 ${locationLabel}`, placeHolder: 'Comment (optional)\u2026', ignoreFocusOut: true });
      if (comment === undefined) { return; }
      if (!syncEnabledAnn) {
        const now = new Date().toISOString(); const annId = randomUUID();
        const existing = readLocalNote(context, picked.noteId!);
        if (existing) {
          const updated: NoteItem = { ...existing, updatedAt: now, annotations: [...(existing.annotations ?? []), { id: annId, noteId: picked.noteId!, filePath: relPath, lineStart, lineEnd, codeSnippet: codeSnippet.slice(0, 500), comment: comment || '', status: 'open', createdAt: now, updatedAt: now }] };
          writeLocalNote(context, updated);
          if (panel) { panel.webview.html = notesListHtml(pnAnn, readLocalNotesGrouped(context, folderPath), getSubfolderOptions(context, folderPath), 'local'); }
          const activeEd2 = vscode.window.activeTextEditor; if (activeEd2) { await refreshAnnotations(activeEd2); }
          const existingPanel = openNotePanels.get(picked.noteId!);
          if (existingPanel) { const { bg, text } = getNoteColors(); existingPanel.webview.html = noteEditorHtml(updated, pnAnn, bg, text); }
        }
        vscode.window.showInformationMessage(`\ud83d\udcce Annotation added to \u201c${targetNote.title}\u201d`);
      } else {
        try {
          const annRes = await apiPost(secrets, '/annotations', { noteId: picked.noteId, filePath: relPath, lineStart, lineEnd, codeSnippet: codeSnippet.slice(0, 500), comment: comment || '', status: 'open' });
          const newAnnotation = annRes.data.data;
          if (memCache) { const idx = memCache.notes.findIndex(n => n.id === picked.noteId); if (idx !== -1) { const note = memCache.notes[idx]; memCache.notes[idx] = { ...note, annotations: [...(note.annotations ?? []), newAnnotation], updatedAt: new Date().toISOString() }; context.globalState.update(cacheKey(), memCache); } }
          if (panel) { panel.webview.html = notesListHtml(pnAnn, readLocalNotesGrouped(context, folderPath), getSubfolderOptions(context, folderPath), 'local'); }
          const existingPanel = openNotePanels.get(picked.noteId!);
          if (existingPanel) { try { const freshRes = await apiGet(secrets, `/notes/${picked.noteId}`); const freshNote: NoteItem = freshRes.data.data; updateNoteInCache(freshNote); const { bg, text } = getNoteColors(); existingPanel.webview.html = noteEditorHtml(freshNote, pnAnn, bg, text); } catch { /* stale ok */ } }
          vscode.window.showInformationMessage(`\ud83d\udcce Annotation added to \u201c${targetNote.title}\u201d`);
        } catch { vscode.window.showErrorMessage('Failed to save annotation.'); return; }
      }
    }
    const activeEditor = vscode.window.activeTextEditor; if (activeEditor) { refreshGutterDecorations(activeEditor); }
    savedSelection = null; savedEditorUri = null;
  }

  context.subscriptions.push(vscode.commands.registerCommand('notevs.annotateSelectionFromStatusBar', async () => {
    if (!savedSelection || !savedEditorUri) { vscode.window.showWarningMessage('Select some code first, then click Annotate.'); return; }
    await runAnnotate(savedEditorUri, savedSelection);
  }));

  context.subscriptions.push(vscode.commands.registerTextEditorCommand('notevs.annotateSelection', async (editor) => {
    let selection = editor.selection; let docUri = editor.document.uri;
    if (selection.isEmpty && savedSelection && savedEditorUri) { selection = savedSelection; docUri = savedEditorUri; }
    if (selection.isEmpty) { vscode.window.showWarningMessage('Select some code first, then run Annotate with NoteVs.'); return; }
    await runAnnotate(docUri, selection);
  }));

  // ── Git hook installer ────────────────────────────────────────────────────────
  async function installGitHook(folderPath: string) {
    const fs = require('fs'); const pathMod = require('path');
    const hookDir = pathMod.join(folderPath, '.git', 'hooks'); const hookPath = pathMod.join(hookDir, 'pre-commit');
    if (!fs.existsSync(pathMod.join(folderPath, '.git'))) { return; }
    if (!fs.existsSync(hookDir)) { fs.mkdirSync(hookDir, { recursive: true }); }
    const hookScript = ['#!/bin/sh','# NoteNest pre-commit check \u2014 auto-installed by NoteNest VS Code extension','NOTENEST_PROJECT_CONFIG=".notenest/config.json"','NOTENEST_HOME_CONFIG="$HOME/.notenest/tokens.json"','if [ ! -f "$NOTENEST_PROJECT_CONFIG" ] || [ ! -f "$NOTENEST_HOME_CONFIG" ]; then exit 0; fi','exit 0'].join('\n');
    if (fs.existsSync(hookPath)) { const existing = fs.readFileSync(hookPath, 'utf8'); if (!existing.includes('NoteNest')) { fs.writeFileSync(hookPath, existing.trimEnd() + '\n\n' + hookScript); } } else { fs.writeFileSync(hookPath, hookScript); }
    fs.chmodSync(hookPath, '755');
  }

  async function writeNoteNestConfig(folderPath: string) {
    const fs = require('fs'); const pathMod = require('path'); const os = require('os');
    const { accessToken, refreshToken } = await getTokens(secrets); if (!accessToken) { return; }
    const homeConfigDir = pathMod.join(os.homedir(), '.notenest');
    if (!fs.existsSync(homeConfigDir)) { fs.mkdirSync(homeConfigDir, { recursive: true }); }
    fs.writeFileSync(pathMod.join(homeConfigDir, 'tokens.json'), JSON.stringify({ apiUrl: getApiUrl(), refreshToken: refreshToken || '' }, null, 2), { mode: 0o600 });
    const projectConfigDir = pathMod.join(folderPath, '.notenest');
    if (!fs.existsSync(projectConfigDir)) { fs.mkdirSync(projectConfigDir, { recursive: true }); }
    fs.writeFileSync(pathMod.join(projectConfigDir, 'config.json'), JSON.stringify({ folderPath }, null, 2));
    const gitignorePath = pathMod.join(folderPath, '.gitignore');
    if (fs.existsSync(gitignorePath)) { const gi = fs.readFileSync(gitignorePath, 'utf8'); if (!gi.includes('.notenest')) { fs.appendFileSync(gitignorePath, '\n# NoteNest (local only)\n.notenest/\n'); } }
    else { fs.writeFileSync(gitignorePath, '# NoteNest (local only)\n.notenest/\n'); }
  }

  const currentFolder = getFolderPath();
  if (currentFolder) { writeNoteNestConfig(currentFolder).then(() => installGitHook(currentFolder)).catch(() => {}); }

  // ── MCP Server ────────────────────────────────────────────────────────────────
  const onNoteMutated: OnNoteMutated = () => {
    // Re-render the sidebar immediately when MCP agent creates/saves/deletes a note
    if (panel) {
      const fp = getFolderPath();
      if (fp) {
        const pn = fp.split(/[\/\\]/).filter(Boolean).pop() ?? 'Project';
        panel.webview.html = notesListHtml(pn, readLocalNotesGrouped(context, fp), getSubfolderOptions(context, fp), 'local');
      }
    }
  };
  const mcpServer = startMcpServer(context, onNoteMutated);
  context.subscriptions.push({ dispose: () => mcpServer.close() });

  flushOfflineQueue().catch(() => {});
  context.subscriptions.push(
    vscode.commands.registerCommand('notevs.openNotes', () => vscode.commands.executeCommand('notevs.notesView.focus')),
    vscode.commands.registerCommand('notevs.logout', async () => { await clearTokens(secrets); if (panel) { panel.webview.html = loginHtml(iconUri); } }),
    vscode.commands.registerCommand('notevs.showSettings', async () => {
      // Focus the sidebar first, then render settings
      await vscode.commands.executeCommand('notevs.notesView.focus');
      if (panel) {
        const config = vscode.workspace.getConfiguration('notevs');
        const notionConn = await hasNotionToken(secrets);
        const obsStatus = await getObsidianStatus(secrets, context.globalState);
        const todoistConn = await hasTodoistToken(secrets);
        const googleConn = await isGoogleTasksConnected(secrets);
        panel.webview.html = settingsHtml(config.get('autoShow', true), config.get('noteBgColor', '#1e1e1e'), false, null, null, notionConn, obsStatus.apiKey, obsStatus.vaultPath, config.get('notionAutoSync', false), todoistConn, googleConn);
      }
    }),
  );
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
    const config = vscode.workspace.getConfiguration('projectnotes');
    if (config.get('autoShow', true)) { vscode.commands.executeCommand('projectnotes.notesView.focus'); }
  }));
}

// ── Auth Flow ─────────────────────────────────────────────────────────────────

async function startLoginFlow(secrets: vscode.SecretStorage, onSuccess: () => void) {
  const state = randomBytes(16).toString('hex');
  const apiUrl = getApiUrl();
  try {
    const { data } = await axios.get(`${apiUrl}/auth/extension/login`, { params: { state } });
    if (!data.success) { vscode.window.showErrorMessage('Failed to start login.'); return; }
    await vscode.env.openExternal(vscode.Uri.parse(data.data.url));
    vscode.window.showInformationMessage('Complete sign-in in your browser. Waiting\u2026');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const { data: td } = await axios.get(`${apiUrl}/auth/extension/token`, { params: { state } });
        if (td.success && td.data.ready) {
          await setTokens(secrets, td.data.tokens.accessToken, td.data.tokens.refreshToken);
          await secrets.store('user', JSON.stringify(td.data.user));
          vscode.window.showInformationMessage(`\u2705 Logged in as ${td.data.user.name}`);
          onSuccess(); return;
        }
      } catch { /* keep polling */ }
    }
    vscode.window.showErrorMessage('Login timed out. Please try again.');
  } catch { vscode.window.showErrorMessage('Could not connect to NoteNest API.'); }
}

export function deactivate() {}
