import * as vscode from 'vscode';
import axios from 'axios';
import { randomBytes } from 'crypto';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApiUrl(): string {
  return vscode.workspace.getConfiguration('notenest').get('apiUrl', 'http://localhost:3001');
}
function getFolderPath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
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
  // Legacy single-annotation fields (kept for backwards compatibility)
  filePath?: string; lineStart?: number; lineEnd?: number; codeSnippet?: string;
  // New: multiple annotations per note
  annotations?: Annotation[];
}

interface NotesCacheEntry {
  notes: NoteItem[];
  cachedAt: string; // ISO timestamp of when we last fetched from server
}

interface OfflineQueueItem {
  id: string;
  patch: {
    title: string; content: string; editorMode: string;
    pinned: boolean; tags: string[]; priority: string; status: string;
  };
  localUpdatedAt: string; // when the offline edit was made
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
  <div class="icon-container"><img src="${iconUri}" alt="NoteNest"/></div>
  <h1>NoteNest</h1>
  <p>Your private project notepad, synced across all your devices.</p>
  <button class="btn" id="b"><i class="codicon codicon-github-inverted"></i> Sign in / Sign up</button>
  <script>
    const vscode=acquireVsCodeApi();
    document.getElementById('b').addEventListener('click',()=>vscode.postMessage({type:'startLogin'}));
  </script></body></html>`;
}

// ── HTML: Settings ────────────────────────────────────────────────────────────

function settingsHtml(autoShow: boolean, noteBgColor: string): string {
  const swatches = BG_COLORS.map(c => `
    <div class="swatch${c.bg === noteBgColor ? ' active' : ''}" data-bg="${c.bg}" data-text="${c.text}"
      style="background:${c.bg};border-color:${c.bg === noteBgColor ? 'var(--vscode-focusBorder)' : 'transparent'}" title="${c.label}">
      ${c.bg === noteBgColor ? '<i class="codicon codicon-check check"></i>' : ''}
    </div>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css"/>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 16px; margin: 0; box-sizing: border-box; }
    h2 { font-size: 14px; font-weight: 600; margin: 0 0 16px; }
    .label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin: 20px 0 10px; }
    .row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .row label { font-size: 13px; }
    .back-btn { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; padding: 0; margin-bottom: 16px; display: flex; align-items: center; gap: 4px; }
    .back-btn:hover { text-decoration: underline; }
    .swatches { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .swatch { width: 100%; aspect-ratio: 1; border-radius: 4px; cursor: pointer; border: 2px solid transparent; position: relative; display: flex; align-items: center; justify-content: center; transition: transform 0.1s, border-color 0.2s; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .swatch:hover { transform: scale(1.05); }
    .swatch.active { border-color: var(--vscode-focusBorder) !important; }
    .check { font-size: 16px; color: var(--vscode-focusBorder); filter: drop-shadow(0 0 2px rgba(0,0,0,0.3)); }
    .logout-btn { margin-top: 32px; width: 100%; padding: 8px; background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; transition: opacity 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .logout-btn:hover { opacity: 0.9; }
  </style></head><body>
  <button class="back-btn" id="bk"><i class="codicon codicon-arrow-left"></i> Back</button>
  <h2>Settings</h2>
  <div class="row"><label>Auto-show on project open</label><input type="checkbox" id="as" ${autoShow ? 'checked' : ''}/></div>
  <div class="label">Note background colour</div>
  <div class="swatches">${swatches}</div>
  <button class="logout-btn" id="lo"><i class="codicon codicon-sign-out"></i> Log out</button>
  <script>
    const vscode=acquireVsCodeApi();
    document.getElementById('bk').addEventListener('click',()=>vscode.postMessage({type:'showList'}));
    document.getElementById('as').addEventListener('change',e=>vscode.postMessage({type:'setSetting',key:'autoShow',value:e.target.checked}));
    document.querySelectorAll('.swatch').forEach(s=>{
      s.addEventListener('click',()=>{
        document.querySelectorAll('.swatch').forEach(x=>{x.classList.remove('active');x.style.borderColor='transparent';x.innerHTML='';});
        s.classList.add('active');s.style.borderColor='var(--vscode-focusBorder)';s.innerHTML='<i class="codicon codicon-check check"></i>';
        vscode.postMessage({type:'setSetting',key:'noteBgColor',value:s.dataset.bg,textColor:s.dataset.text});
      });
    });
    document.getElementById('lo').addEventListener('click',()=>vscode.postMessage({type:'logout'}));
  </script></body></html>`;
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

function notesListHtml(projectName: string, notes: NoteItem[], offline?: boolean): string {
  const items = notes.map(n => {
    const date = new Date(n.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const safeTitle = n.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rawPreview = n.editorMode === 'markdown'
      ? (n.content || '').replace(/[#*_`\[\]]/g, '').replace(/\n/g, ' ')
      : (() => { try { const d = JSON.parse(n.content || ''); return (d.ops||[]).map((op: {insert?: unknown}) => typeof op.insert === 'string' ? op.insert : '').join('').replace(/\n/g, ' '); } catch { return (n.content || '').replace(/<[^>]+>/g, ' '); } })();
    const preview = rawPreview.trim().slice(0, 60).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const tagBadges = n.tags.slice(0, 3).map(t =>
      `<span class="tag">${t.replace(/</g, '&lt;')}</span>`).join('');
    const priorityBadge = n.priority && n.priority !== 'none'
      ? `<span class="priority-indicator p-${n.priority}" title="${PRIORITY_LABEL[n.priority]}"><i class="codicon codicon-circle-filled"></i></span>`
      : '';
    const statusBadge = n.status === 'done' ? '<span class="status-badge done"><i class="codicon codicon-check"></i> done</span>'
      : n.status === 'passed' ? '<span class="status-badge passed"><i class="codicon codicon-pass-filled"></i> passed</span>' : '';
    const annotationCount = (n.annotations?.length ?? 0) || (n.filePath ? 1 : 0);
    const fileBadge = annotationCount > 0
      ? (n.annotations && n.annotations.length > 0
        ? `<span class="file-badge" title="${annotationCount} code annotation(s)"><i class="codicon codicon-link"></i> ${annotationCount} annotation${annotationCount > 1 ? 's' : ''}</span>`
        : `<span class="file-badge" data-id="${n.id}" data-file="${n.filePath}" data-line="${n.lineStart ?? 1}" data-line-start="${n.lineStart ?? 1}" data-line-end="${n.lineEnd ?? n.lineStart ?? 1}" title="Jump to ${n.filePath}:${n.lineStart}\u2013${n.lineEnd}"><i class="codicon codicon-link"></i> ${(n.filePath ?? '').split('/').pop()}:${n.lineStart}\u2013${n.lineEnd}</span>`)
      : '';
    return `<div class="note-row" data-id="${n.id}">
      <div class="note-main">
        <div class="note-header">
          ${priorityBadge}
          ${n.pinned ? '<i class="codicon codicon-pin pin-icon"></i>' : ''}
          <span class="note-title">${safeTitle}</span>
          <span class="note-date">${date}</span>
        </div>
        ${fileBadge ? `<div class="file-row">${fileBadge}</div>` : ''}
        <div class="note-preview">${preview || '<span class="dim">Empty note</span>'}</div>
        <div class="note-footer">
          ${tagBadges ? `<div class="tags">${tagBadges}</div>` : '<div></div>'}
          ${statusBadge}
        </div>
      </div>
      <button class="del-btn" data-id="${n.id}" title="Delete"><i class="codicon codicon-trash"></i></button>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@vscode/codicons@0.0.36/dist/codicon.css"/>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 0; margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; background: var(--vscode-sideBar-background); z-index: 10; }
    .project-name { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
    .toolbar-right { display: flex; align-items: center; gap: 4px; }
    .icon-btn { background: none; border: none; cursor: pointer; color: var(--vscode-foreground); opacity: 0.7; font-size: 16px; padding: 4px; border-radius: 4px; line-height: 1; transition: opacity 0.2s, background 0.2s; }
    .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .search-bar { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
    .search-bar input { width: 100%; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); border-radius: 4px; padding: 6px 10px; font-size: 12px; outline: none; font-family: var(--vscode-font-family); box-sizing: border-box; }
    .search-bar input:focus { border-color: var(--vscode-focusBorder); }
    .new-note-row { display: none; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid var(--vscode-focusBorder); border-radius: 6px; background: var(--vscode-input-background); margin: 0 0 4px 0; }
    .new-note-row.visible { display: flex; }
    .new-note-input { flex: 1; background: transparent; border: none; color: var(--vscode-input-foreground); font-size: 13px; font-weight: 500; outline: none; font-family: var(--vscode-font-family); padding: 2px 4px; }
    .new-note-input::placeholder { color: var(--vscode-input-placeholderForeground); font-style: italic; }
    .new-note-hint { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; opacity: 0.7; }
    .offline-banner { padding: 6px 12px; background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-inputValidation-warningForeground); font-size: 11px; flex-shrink: 0; display: flex; align-items: center; gap: 6px; }
    .notes-list { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 8px; }
    .note-row { display: flex; align-items: flex-start; padding: 10px; cursor: pointer; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-sideBar-background); transition: border-color 0.2s, box-shadow 0.2s, background 0.2s; position: relative; gap: 8px; }
    .note-row:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); box-shadow: 0 2px 8px rgba(0,0,0,0.15); }
    .note-row.hidden { display: none; }
    .note-main { flex: 1; min-width: 0; }
    .note-header { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .pin-icon { font-size: 12px; color: var(--vscode-symbolIcon-propertyForeground); flex-shrink: 0; }
    .note-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; color: var(--vscode-foreground); }
    .note-date { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; flex-shrink: 0; }
    .note-preview { font-size: 12px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.4; margin-bottom: 8px; min-height: 1.4em; }
    .note-footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .tags { display: flex; gap: 4px; flex-wrap: wrap; }
    .tag { font-size: 10px; padding: 1px 6px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border: 1px solid rgba(128,128,128,0.2); }
    .dim { opacity: 0.5; font-style: italic; }
    .del-btn { background: none; border: none; cursor: pointer; color: var(--vscode-errorForeground); opacity: 0; font-size: 14px; padding: 4px; border-radius: 4px; flex-shrink: 0; transition: opacity 0.2s; }
    .note-row:hover .del-btn { opacity: 0.6; }
    .del-btn:hover { opacity: 1 !important; background: var(--vscode-inputValidation-errorBackground); }
    .empty { padding: 60px 20px; text-align:center; font-size: 13px; color: var(--vscode-descriptionForeground); line-height: 1.6; }
    .empty i { font-size: 32px; display: block; margin-bottom: 12px; opacity: 0.3; }
    .status-badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: 600; flex-shrink: 0; display: flex; align-items: center; gap: 4px; }
    .status-badge i { font-size: 10px; }
    .status-badge.done { background: rgba(63,185,80,0.15); color: #3fb950; border: 1px solid rgba(63,185,80,0.3); }
    .status-badge.passed { background: rgba(108,142,245,0.15); color: #6c8ef5; border: 1px solid rgba(108,142,245,0.3); }
    .priority-indicator { font-size: 10px; flex-shrink: 0; display: flex; align-items: center; }
    .priority-indicator.p-emergency { color: #f87171; }
    .priority-indicator.p-urgent { color: #fb923c; }
    .priority-indicator.p-important { color: #fbbf24; }
    .priority-indicator.p-medium { color: #84cc16; }
    .priority-indicator.p-low { color: #22c55e; }
    .file-row { margin-bottom: 6px; }
    .file-badge { font-size: 11px; color: var(--vscode-textLink-foreground); cursor: pointer; opacity: 0.8; display: flex; align-items: center; gap: 4px; }
    .file-badge:hover { opacity: 1; text-decoration: underline; }
    .file-badge i { font-size: 12px; }
  </style></head><body>
  <div class="toolbar">
    <span class="project-name" title="${projectName}">${projectName}</span>
    <div class="toolbar-right">
      <button class="icon-btn" id="newBtn" title="New note (Cmd/Ctrl+N)"><i class="codicon codicon-add"></i></button>
      <button class="icon-btn" id="settingsBtn" title="Settings"><i class="codicon codicon-settings-gear"></i></button>
    </div>
  </div>
  <div class="search-bar">
    <input id="search" placeholder="Search notes\u2026" autocomplete="off"/>
  </div>
  ${offline ? '<div class="offline-banner"><i class="codicon codicon-warning"></i> Offline \u2014 changes won\'t save</div>' : ''}
  <div class="notes-list" id="list">
    <div class="new-note-row" id="newNoteRow">
      <i class="codicon codicon-note" style="font-size:14px;opacity:0.6;flex-shrink:0"></i>
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
    document.getElementById('newBtn').addEventListener('click',()=>{
      newNoteRow.classList.add('visible');
      newNoteInput.value='';
      newNoteInput.focus();
    });
    newNoteInput.addEventListener('keydown',e=>{
      if(e.key==='Enter'){e.preventDefault();const t=newNoteInput.value.trim();if(t){vscode.postMessage({type:'newNote',title:t});}newNoteRow.classList.remove('visible');}
      if(e.key==='Escape'){newNoteRow.classList.remove('visible');}
    });
    newNoteInput.addEventListener('blur',()=>{
      setTimeout(()=>{newNoteRow.classList.remove('visible');},150);
    });
    document.getElementById('settingsBtn').addEventListener('click',()=>vscode.postMessage({type:'openSettings'}));
    document.querySelectorAll('.note-row').forEach(row=>{
      row.addEventListener('click',e=>{
        if(e.target.closest('.del-btn'))return;
        vscode.postMessage({type:'openNote',id:row.dataset.id});
      });
    });
    document.querySelectorAll('.del-btn').forEach(btn=>{
      btn.addEventListener('click',e=>{
        e.stopPropagation();
        vscode.postMessage({type:'deleteNote',id:btn.dataset.id});
      });
    });
    // Search filter
    document.getElementById('search').addEventListener('input',e=>{
      const q=e.target.value.toLowerCase().trim();
      document.querySelectorAll('.note-row').forEach(row=>{
        const title=row.querySelector('.note-title')?.textContent?.toLowerCase()||'';
        const preview=row.querySelector('.note-preview')?.textContent?.toLowerCase()||'';
        row.classList.toggle('hidden',q!==''&&!title.includes(q)&&!preview.includes(q));
      });
    });
    // File badge click — jump to file location
    document.querySelectorAll('.file-badge').forEach(badge=>{
      badge.addEventListener('click',e=>{
        e.stopPropagation();
        vscode.postMessage({
          type:'jumpToFile',
          file:badge.dataset.file,
          line:parseInt(badge.dataset.lineStart||badge.dataset.line||'1'),
          lineStart:parseInt(badge.dataset.lineStart||'1'),
          lineEnd:parseInt(badge.dataset.lineEnd||badge.dataset.lineStart||'1'),
        });
      });
    });
    // Keyboard shortcut Cmd/Ctrl+N
    document.addEventListener('keydown',e=>{
      if((e.metaKey||e.ctrlKey)&&e.key==='n'){e.preventDefault();newNoteRow.classList.add('visible');newNoteInput.value='';newNoteInput.focus();}
    });
  </script></body></html>`;
}

// ── HTML: Note Editor ─────────────────────────────────────────────────────────

function noteEditorHtml(note: NoteItem, projectName: string, bgColor: string, textColor: string): string {
  const safeTitle = (note.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const isMarkdown = note.editorMode === 'markdown';
  const contentJson = JSON.stringify(note.content || '');

  // Build annotations HTML (new multi-annotation system)
  const annotationsHtml = (note.annotations && note.annotations.length > 0)
    ? note.annotations.map(ann => `
  <div class="annotation-block" data-ann-id="${ann.id}">
    <div class="ann-header">
      <span class="ann-file" onclick="vscode.postMessage({type:'jumpToFile',file:'${ann.filePath}',lineStart:${ann.lineStart},lineEnd:${ann.lineEnd},line:${ann.lineStart}})">
        <i class="codicon codicon-link"></i> ${ann.filePath}:${ann.lineStart}\u2013${ann.lineEnd}
      </span>
      <select class="ann-status styled-select ${ann.status}" data-ann-id="${ann.id}" onchange="saveAnnotation('${ann.id}')">
        <option value="open"${ann.status==='open'?' selected':''}>Open</option>
        <option value="done"${ann.status==='done'?' selected':''}>Done</option>
        <option value="closed"${ann.status==='closed'?' selected':''}>Closed</option>
      </select>
      <button class="ann-del-btn" onclick="deleteAnnotation('${ann.id}')" title="Remove annotation"><i class="codicon codicon-trash"></i></button>
    </div>
    ${ann.codeSnippet ? `<pre class="ann-snippet">${ann.codeSnippet.replace(/</g,'&lt;').slice(0,300)}</pre>` : ''}
    <textarea class="ann-comment" data-ann-id="${ann.id}" placeholder="Comment on this code\u2026" oninput="scheduleAnnotationSave('${ann.id}')">${(ann.comment||'').replace(/</g,'&lt;')}</textarea>
  </div>`).join('')
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
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); padding: 0; margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; }
    .toolbar { display: flex; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; gap: 8px; background: var(--vscode-sideBar-background); }
    .back-btn { background: none; border: none; cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 12px; padding: 4px; white-space: nowrap; flex-shrink: 0; display: flex; align-items: center; gap: 4px; border-radius: 4px; }
    .back-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .title-input { flex: 1; background: transparent; border: none; color: var(--vscode-foreground); font-size: 13px; font-weight: 600; outline: none; min-width: 0; font-family: var(--vscode-font-family); padding: 4px; border-radius: 4px; }
    .title-input:focus { background: var(--vscode-input-background); border: 1px solid var(--vscode-focusBorder); }
    .title-input::placeholder { color: var(--vscode-input-placeholderForeground); }
    .status { font-size: 10px; color: #4caf50; white-space: nowrap; flex-shrink: 0; min-width: 40px; text-align: right; font-weight: 600; text-transform: uppercase; }
    .meta-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; flex-wrap: wrap; background: var(--vscode-sideBar-background); }
    .pin-btn { background: none; border: none; cursor: pointer; font-size: 16px; padding: 4px; border-radius: 4px; color: var(--vscode-foreground); opacity: 0.5; transition: opacity 0.2s, color 0.2s; display: flex; align-items: center; }
    .pin-btn.active { opacity: 1; color: var(--vscode-symbolIcon-propertyForeground); }
    .pin-btn:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
    .tags-input { flex: 1; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-foreground); font-size: 11px; outline: none; font-family: var(--vscode-font-family); min-width: 100px; padding: 4px 8px; border-radius: 4px; }
    .tags-input:focus { border-color: var(--vscode-focusBorder); }
    .tags-input::placeholder { color: var(--vscode-input-placeholderForeground); font-style: italic; }
    .mode-toggle { display: flex; gap: 2px; flex-shrink: 0; background: var(--vscode-button-secondaryBackground); padding: 2px; border-radius: 6px; }
    .mode-btn { background: none; border: none; color: var(--vscode-button-secondaryForeground); font-size: 10px; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-weight: 600; transition: background 0.2s; }
    .mode-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .select-wrap { display: flex; gap: 4px; flex-shrink: 0; }
    .styled-select { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-foreground); font-size: 11px; padding: 3px 6px; border-radius: 4px; cursor: pointer; font-family: var(--vscode-font-family); outline: none; }
    .styled-select:focus { border-color: var(--vscode-focusBorder); }
    .status-select.open { color: #f87171; }
    .status-select.done { color: #3fb950; }
    .status-select.passed { color: #6c8ef5; }
    .word-count { padding: 4px 12px; font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); display: flex; justify-content: space-between; align-items: center; }
    .editor-wrap { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: ${bgColor}; color: ${textColor}; }
    .ql-toolbar { background: rgba(128,128,128,0.05) !important; border: none !important; border-bottom: 1px solid var(--vscode-panel-border) !important; flex-shrink: 0; padding: 6px !important; }
    .ql-toolbar .ql-stroke { stroke: ${textColor} !important; opacity: 0.8; }
    .ql-toolbar .ql-fill { fill: ${textColor} !important; opacity: 0.8; }
    .ql-toolbar .ql-picker { color: ${textColor} !important; }
    .ql-toolbar button:hover .ql-stroke, .ql-toolbar button.ql-active .ql-stroke { stroke: var(--vscode-textLink-foreground) !important; opacity: 1; }
    .ql-container { flex: 1; font-size: 13px; border: none !important; overflow: auto; }
    .ql-editor { color: ${textColor}; min-height: 200px; line-height: 1.6; padding: 16px; font-family: var(--vscode-font-family); }
    .ql-editor.ql-blank::before { color: ${textColor}; opacity: 0.35; font-style: italic; }
    .md-wrap { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: ${bgColor}; }
    .md-panes { flex: 1; display: flex; overflow: hidden; }
    textarea.md-edit { flex: 1; background: ${bgColor}; color: ${textColor}; border: none; resize: none; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; line-height: 1.6; padding: 16px; outline: none; }
    textarea.md-edit::placeholder { color: ${textColor}; opacity: 0.35; }
    .md-preview { flex: 1; overflow-y: auto; padding: 16px; color: ${textColor}; font-size: 13px; line-height: 1.6; border-left: 1px solid rgba(128,128,128,0.2); }
    .md-preview h1, .md-preview h2, .md-preview h3 { margin-top: 1em; margin-bottom: 0.5em; color: inherit; }
    .md-preview code { background: rgba(128,128,128,0.15); padding: 2px 4px; border-radius: 4px; font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); }
    .md-preview pre { background: rgba(128,128,128,0.15); padding: 12px; border-radius: 6px; overflow-x: auto; margin: 12px 0; }
    .md-preview pre code { background: none; padding: 0; }
    .md-preview a { color: var(--vscode-textLink-foreground); }
    .md-tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); flex-shrink: 0; padding: 0 8px; }
    .md-tab { padding: 8px 16px; font-size: 11px; font-weight: 600; cursor: pointer; color: var(--vscode-descriptionForeground); border: none; background: none; border-bottom: 2px solid transparent; transition: color 0.2s, border-color 0.2s; }
    .md-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
    /* Legacy single annotation banner */
    .annotation-banner { padding: 8px 12px; background: rgba(108,142,245,0.1); border-bottom: 1px solid var(--vscode-panel-border); font-size: 11px; color: var(--vscode-textLink-foreground); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; gap: 8px; cursor: pointer; }
    .annotation-banner i { font-size: 14px; }
    .code-snippet { opacity: 0.7; font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
    /* New multi-annotation blocks */
    .annotation-block { border-left: 3px solid rgba(108,142,245,0.6); background: rgba(108,142,245,0.05); margin: 0; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
    .ann-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .ann-file { font-size: 11px; color: var(--vscode-textLink-foreground); cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 4px; }
    .ann-file:hover { text-decoration: underline; }
    .ann-status { font-size: 10px; padding: 2px 4px; flex-shrink: 0; }
    .ann-status.open { color: #f87171; }
    .ann-status.done { color: #3fb950; }
    .ann-status.closed { color: var(--vscode-descriptionForeground); }
    .ann-del-btn { background: none; border: none; cursor: pointer; color: var(--vscode-errorForeground); opacity: 0.5; font-size: 12px; padding: 2px; border-radius: 3px; flex-shrink: 0; }
    .ann-del-btn:hover { opacity: 1; background: var(--vscode-inputValidation-errorBackground); }
    .ann-snippet { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; background: rgba(0,0,0,0.15); padding: 4px 6px; border-radius: 3px; margin: 0 0 6px; overflow-x: auto; white-space: pre; color: ${textColor}; opacity: 0.8; max-height: 60px; }
    .ann-comment { width: 100%; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-foreground); font-size: 11px; font-family: var(--vscode-font-family); border-radius: 3px; padding: 4px 6px; outline: none; resize: vertical; min-height: 40px; box-sizing: border-box; }
    .ann-comment:focus { border-color: var(--vscode-focusBorder); }
    .ann-comment::placeholder { font-style: italic; opacity: 0.6; }
  </style></head><body>

  <div class="toolbar">
    <button class="back-btn" id="backBtn"><i class="codicon codicon-arrow-left"></i> Notes</button>
    <input class="title-input" id="titleInput" value="${safeTitle}" placeholder="Note title\u2026"/>
    <span class="status" id="status"></span>
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
    <span id="saveStatus" style="opacity:0.6;font-style:italic">Saved</span>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const noteId = "${note.id}";
    let mode = "${note.editorMode || 'wysiwyg'}";
    let pinned = ${note.pinned};
    let saveTimer = null;
    const annSaveTimers = {};

    const quill = new Quill('#quillEditor', {
      theme: 'snow',
      placeholder: 'Start writing\u2026',
      modules: {
        toolbar: [
          ['bold', 'italic', 'underline', 'strike'],
          ['blockquote', 'code-block'],
          [{ 'list': 'ordered' }, { 'list': 'bullet' }],
          [{ 'header': [1, 2, 3, false] }],
          ['link'],
          ['clean']
        ]
      }
    });

    const rawContent = ${contentJson};
    if (mode === 'wysiwyg') {
      try { quill.setContents(JSON.parse(rawContent)); } catch { quill.setText(rawContent); }
    } else {
      document.getElementById('mdEdit').value = rawContent;
      updateMdPreview();
    }

    function updateWordCount(text) {
      const words = text.trim() ? text.trim().split(/\\s+/).length : 0;
      document.getElementById('wordCount').textContent = words + ' words \u00b7 ' + text.length + ' chars';
    }
    quill.on('text-change', () => { updateWordCount(quill.getText()); scheduleSave(); });
    document.getElementById('mdEdit').addEventListener('input', e => { updateWordCount(e.target.value); updateMdPreview(); scheduleSave(); });
    updateWordCount(mode === 'wysiwyg' ? quill.getText() : document.getElementById('mdEdit').value);

    function updateMdPreview() {
      document.getElementById('mdPreview').innerHTML = marked.parse(document.getElementById('mdEdit').value);
    }
    document.getElementById('tabEdit').addEventListener('click', () => {
      document.getElementById('tabEdit').classList.add('active');
      document.getElementById('tabPreview').classList.remove('active');
      document.getElementById('mdEdit').style.display = '';
      document.getElementById('mdPreview').style.display = 'none';
    });
    document.getElementById('tabPreview').addEventListener('click', () => {
      document.getElementById('tabPreview').classList.add('active');
      document.getElementById('tabEdit').classList.remove('active');
      document.getElementById('mdEdit').style.display = 'none';
      document.getElementById('mdPreview').style.display = '';
      updateMdPreview();
    });

    function switchMode(newMode) {
      if (newMode === mode) return;
      mode = newMode;
      document.getElementById('modeWysiwyg').classList.toggle('active', mode === 'wysiwyg');
      document.getElementById('modeMd').classList.toggle('active', mode === 'markdown');
      document.getElementById('wysiwygWrap').style.display = mode === 'wysiwyg' ? 'flex' : 'none';
      document.getElementById('mdWrap').style.display = mode === 'markdown' ? 'flex' : 'none';
      if (mode === 'markdown') { document.getElementById('mdEdit').value = quill.getText(); updateMdPreview(); }
      else { quill.setText(document.getElementById('mdEdit').value); }
      scheduleSave();
    }
    document.getElementById('modeWysiwyg').addEventListener('click', () => switchMode('wysiwyg'));
    document.getElementById('modeMd').addEventListener('click', () => switchMode('markdown'));

    document.getElementById('pinBtn').addEventListener('click', () => {
      pinned = !pinned;
      document.getElementById('pinBtn').classList.toggle('active', pinned);
      document.getElementById('pinBtn').title = pinned ? 'Unpin' : 'Pin note';
      scheduleSave();
    });

    document.getElementById('prioritySelect').addEventListener('change', scheduleSave);
    document.getElementById('statusSelect').addEventListener('change', e => {
      e.target.className = 'styled-select status-select ' + e.target.value;
      scheduleSave();
    });
    document.getElementById('titleInput').addEventListener('input', scheduleSave);
    document.getElementById('tagsInput').addEventListener('input', scheduleSave);

    document.getElementById('backBtn').addEventListener('click', () => {
      doSave();
      vscode.postMessage({ type: 'showList' });
    });

    // Legacy single annotation banner click
    const legacyBanner = document.getElementById('annotationBanner');
    if (legacyBanner) {
      legacyBanner.addEventListener('click', () => {
        vscode.postMessage({ type: 'jumpToFile', file: "${note.filePath||''}", line: ${note.lineStart||1}, lineStart: ${note.lineStart||1}, lineEnd: ${note.lineEnd||note.lineStart||1} });
      });
    }

    function getContent() {
      return mode === 'wysiwyg' ? JSON.stringify(quill.getContents()) : document.getElementById('mdEdit').value;
    }
    function getTags() {
      return document.getElementById('tagsInput').value.split(',').map(t => t.trim()).filter(Boolean);
    }
    function scheduleSave() {
      document.getElementById('saveStatus').textContent = 'Unsaved\u2026';
      document.getElementById('saveStatus').style.opacity = '1';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(doSave, 1000);
    }
    function doSave() {
      vscode.postMessage({
        type: 'saveNote', id: noteId,
        title: document.getElementById('titleInput').value,
        content: getContent(), editorMode: mode, pinned: pinned,
        tags: getTags(),
        priority: document.getElementById('prioritySelect').value,
        status: document.getElementById('statusSelect').value,
      });
    }

    // Annotation helpers
    function scheduleAnnotationSave(annId) {
      clearTimeout(annSaveTimers[annId]);
      annSaveTimers[annId] = setTimeout(() => saveAnnotation(annId), 1000);
    }
    function saveAnnotation(annId) {
      const comment = document.querySelector('.ann-comment[data-ann-id="' + annId + '"]')?.value || '';
      const status = document.querySelector('.ann-status[data-ann-id="' + annId + '"]')?.value || 'open';
      vscode.postMessage({ type: 'saveAnnotation', annotationId: annId, comment, status });
    }
    function deleteAnnotation(annId) {
      vscode.postMessage({ type: 'deleteAnnotation', annotationId: annId });
    }

    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); clearTimeout(saveTimer); doSave(); }
    });

    const titleEl = document.getElementById('titleInput');
    if (titleEl.value === 'Untitled') { titleEl.focus(); titleEl.select(); }

    window.addEventListener('message', e => {
      if (e.data.type === 'saved') {
        document.getElementById('saveStatus').textContent = 'Saved';
        document.getElementById('saveStatus').style.opacity = '0.6';
        const s = document.getElementById('status');
        s.textContent = '\u2713 Saved';
        setTimeout(() => { s.textContent = ''; }, 2000);
      }
      if (e.data.type === 'annotationSaved') {
        // Visual feedback could be added here
      }
    });
  <\/script></body></html>`;
}

// ── Extension Entry Point ─────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  const secrets = context.secrets;
  let panel: vscode.WebviewView | undefined;
  let currentNoteId: string | null = null;
  let iconUri = '';

  // Track open note panels to avoid duplicates (noteId -> WebviewPanel)
  const openNotePanels = new Map<string, vscode.WebviewPanel>();
  // Track notes currently being opened to prevent duplicate panels during async gap
  const openingNotes = new Set<string>();
  // Shared openNote ref — set by resolveWebviewView so the command registered
  // outside that closure can call it
  let openNoteRef: ((id: string) => Promise<void>) | null = null;

  function getNoteColors(): { bg: string; text: string } {
    const config = vscode.workspace.getConfiguration('notenest');
    return {
      bg: config.get('noteBgColor', '#1e1e1e'),
      text: config.get('noteTextColor', '#d4d4d4'),
    };
  }

  // ── Notes cache ───────────────────────────────────────────────────────────
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
    if (idx !== -1) {
      memCache.notes[idx] = { ...memCache.notes[idx], ...patch, updatedAt: new Date().toISOString() };
    }
    context.globalState.update(cacheKey(), memCache);
  }

  // ── Offline queue ─────────────────────────────────────────────────────────
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
            `"${serverNote.title}" was edited on another machine while you were offline. Which version do you want to keep?`,
            { modal: true },
            'Keep my offline version',
            'Keep server version'
          );
          if (choice === 'Keep server version') {
            updateNoteInCache(serverNote);
            continue;
          }
        }
        await apiPatch(secrets, `/notes/${item.id}`, item.patch);
        updateNoteInCache({ ...serverNote, ...item.patch, updatedAt: new Date().toISOString() });
      } catch {
        remaining.push(item);
      }
    }
    await context.globalState.update(QUEUE_KEY, remaining);
  }

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      panel = webviewView;
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      };
      iconUri = webviewView.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png')).toString();

      async function render() {
        const { accessToken } = await getTokens(secrets);
        if (!accessToken && !(await refreshAccessToken(secrets))) {
          webviewView.webview.html = loginHtml(iconUri); return;
        }
        flushOfflineQueue().catch(() => {});
        // Always show the notes list in the sidebar first
        await showNotesList();
        // Then auto-open the top-priority note as an editor tab (without replacing the sidebar)
        const folderPath = getFolderPath();
        if (folderPath) {
          const cached = loadCache();
          if (cached && cached.notes.length) {
            const top = topPriorityNote(cached.notes);
            if (top) { openNote(top.id); }
          }
        }
      }

      async function showNotesList() {
        const folderPath = getFolderPath();
        const projectName = folderPath?.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project';
        currentNoteId = null;
        if (!folderPath) { webviewView.webview.html = noFolderHtml(); return; }

        const cached = loadCache();
        if (cached) {
          webviewView.webview.html = notesListHtml(projectName, cached.notes, false);
        }

        try {
          const res = await apiGet(secrets, '/notes', { folderPath });
          await saveCache(res.data.data);
          if (currentNoteId === null) {
            webviewView.webview.html = notesListHtml(projectName, res.data.data, false);
          }
        } catch (e: unknown) {
          const err = e as { message?: string };
          if (err.message === 'NOT_AUTHENTICATED') {
            webviewView.webview.html = loginHtml(iconUri);
          } else if (!cached) {
            webviewView.webview.html = notesListHtml(projectName, [], true);
          } else if (currentNoteId === null) {
            webviewView.webview.html = notesListHtml(projectName, cached.notes, true);
          }
        }
      }

      async function openNote(id: string) {
        const folderPath = getFolderPath();
        const projectName = folderPath?.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project';
        const { bg, text } = getNoteColors();

        // If already open, just reveal it
        const existingPanel = openNotePanels.get(id);
        if (existingPanel) { existingPanel.reveal(vscode.ViewColumn.Beside); return; }

        // If already in the process of being opened, don't create a second panel
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
        notePanel.onDidDispose(() => { openNotePanels.delete(id); }, null, context.subscriptions);

        // Render immediately from cache so the panel is never blank
        if (cachedNote) {
          notePanel.webview.html = noteEditorHtml(cachedNote, projectName, bg, text);
        } else {
          notePanel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);font-size:13px;}</style></head><body>Loading note\u2026</body></html>`;
        }

        // Fetch fresh data and update if anything changed
        try {
          const res = await apiGet(secrets, `/notes/${id}`);
          const freshNote: NoteItem = res.data.data;
          updateNoteInCache(freshNote);
          notePanel.title = freshNote.title || 'Note';
          // Always re-render with fresh data (annotations may have changed)
          notePanel.webview.html = noteEditorHtml(freshNote, projectName, bg, text);
        } catch {
          if (!cachedNote) { notePanel.dispose(); }
          // If fetch fails but we have cache, the cached render is already showing — fine
        }

        notePanel.webview.onDidReceiveMessage(async (msg) => {
          if (msg.type === 'saveNote') {
            const patch = { title: msg.title, content: msg.content, editorMode: msg.editorMode, pinned: msg.pinned, tags: msg.tags, priority: msg.priority, status: msg.status };
            patchNoteInCache(msg.id, patch);
            notePanel.title = msg.title || 'Note';
            // Refresh sidebar list so changes reflect there too
            if (panel) {
              const c2 = loadCache(); const fp2 = getFolderPath();
              const pn2 = fp2?.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project';
              if (c2) { panel.webview.html = notesListHtml(pn2, c2.notes, false); }
            }
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
          if (msg.type === 'jumpToFile') {
            const fp2 = getFolderPath(); if (!fp2 || !msg.file) return;
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
        }, null, context.subscriptions);
      }

      webviewView.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {

          case 'startLogin': await startLoginFlow(secrets, () => render()); break;
          case 'showList': await showNotesList(); break;

          case 'openFolder':
            vscode.commands.executeCommand('vscode.openFolder');
            break;

          case 'newNote': {
            const folderPath = getFolderPath();
            if (!folderPath) { vscode.window.showWarningMessage('Open a folder first.'); break; }
            const projectName = folderPath.split(/[\/\\]/).filter(Boolean).pop() ?? 'Project';
            const title = msg.title || 'Untitled';
            try {
              const res = await apiPost(secrets, '/notes', { folderPath, title, content: '', editorMode: 'wysiwyg' });
              const newNote: NoteItem = res.data.data;
              if (memCache) { memCache.notes.unshift(newNote); context.globalState.update(cacheKey(), memCache); }
              else { await saveCache([newNote]); }
              // Refresh sidebar list so the new note appears
              const c2 = loadCache();
              if (c2) { webviewView.webview.html = notesListHtml(projectName, c2.notes, false); }
              // Open the new note as an editor tab
              await openNote(newNote.id);
            } catch { vscode.window.showErrorMessage('Failed to create note.'); }
            break;
          }

          case 'openNote': await openNote(msg.id); break;
          case 'openNoteFromHost': await openNote(msg.id); break;

          case 'jumpToFile': {
            const folderPath = getFolderPath();
            if (!folderPath || !msg.file) break;
            const fileUri = vscode.Uri.file(`${folderPath}/${msg.file}`);
            try {
              const doc = await vscode.workspace.openTextDocument(fileUri);
              const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
              const startLine = Math.max(0, (msg.lineStart || msg.line || 1) - 1);
              const endLine = Math.max(0, (msg.lineEnd || msg.lineStart || msg.line || 1) - 1);
              const endLineText = doc.lineAt(Math.min(endLine, doc.lineCount - 1));
              const range = new vscode.Range(startLine, 0, endLineText.lineNumber, endLineText.text.length);
              editor.selection = new vscode.Selection(range.start, range.end);
              editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            } catch { vscode.window.showErrorMessage(`Could not open file: ${msg.file}`); }
            break;
          }

          // saveNote is handled per-panel inside openNote() — no-op fallback here
          case 'saveNote': break;

          case 'deleteNote': {
            const ok = await vscode.window.showWarningMessage(
              'Delete this note? This cannot be undone.', { modal: true }, 'Delete');
            if (ok === 'Delete') {
              // Close the panel if it's open
              const notePanel = openNotePanels.get(msg.id);
              if (notePanel) { notePanel.dispose(); }
              if (memCache) {
                memCache.notes = memCache.notes.filter(n => n.id !== msg.id);
                context.globalState.update(cacheKey(), memCache);
              }
              try { await apiDelete(secrets, `/notes/${msg.id}`); } catch { /* ignore */ }
              await showNotesList();
            }
            break;
          }

          case 'openSettings': {
            const config = vscode.workspace.getConfiguration('notenest');
            webviewView.webview.html = settingsHtml(
              config.get('autoShow', true),
              config.get('noteBgColor', '#1e1e1e')
            );
            break;
          }

          case 'setSetting': {
            const config = vscode.workspace.getConfiguration('notenest');
            if (msg.key === 'autoShow') { await config.update('autoShow', msg.value, vscode.ConfigurationTarget.Global); }
            if (msg.key === 'noteBgColor') {
              await config.update('noteBgColor', msg.value, vscode.ConfigurationTarget.Global);
              await config.update('noteTextColor', msg.textColor, vscode.ConfigurationTarget.Global);
            }
            break;
          }

          case 'logout':
            await clearTokens(secrets);
            webviewView.webview.html = loginHtml(iconUri);
            break;
        }
      });

      // Expose openNote so the command registered outside this closure can call it
      openNoteRef = openNote;

      render();
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('notenest.notesView', provider)
  );

  // ── Annotation highlight decoration ──────────────────────────────────────────
  const annotationDecoration = vscode.window.createTextEditorDecorationType({
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: 'rgba(108,142,245,0.7)',
    backgroundColor: 'rgba(108,142,245,0.06)',
    isWholeLine: true,
    overviewRulerColor: 'rgba(108,142,245,0.6)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png'),
    gutterIconSize: '60%',
  });

  // annotationCache maps relPath -> flat list of { noteId, noteTitle, noteContent,
  // editorMode, priority, status, lineStart, lineEnd } — one entry per annotation
  interface FlatAnnotation {
    noteId: string;
    noteTitle: string;
    noteContent: string;
    editorMode: string;
    priority: string;
    status: string;
    lineStart: number;
    lineEnd: number;
    comment: string;
  }
  const annotationCache = new Map<string, FlatAnnotation[]>();

  async function refreshAnnotations(editor: vscode.TextEditor) {
    const folderPath = getFolderPath();
    if (!folderPath) { return; }
    const relPath = editor.document.uri.fsPath
      .replace(folderPath + '/', '')
      .replace(folderPath + '\\', '');
    try {
      const res = await apiGet(secrets, '/notes', { folderPath });
      const notes: NoteItem[] = res.data.data;

      // Build a flat list of all annotations for this file from both systems
      const flat: FlatAnnotation[] = [];
      for (const note of notes) {
        // New system: annotations[] array
        if (note.annotations && note.annotations.length > 0) {
          for (const ann of note.annotations) {
            if (ann.filePath === relPath && ann.lineStart != null) {
              flat.push({
                noteId: note.id,
                noteTitle: note.title,
                noteContent: note.content,
                editorMode: note.editorMode,
                priority: note.priority,
                status: note.status,
                lineStart: ann.lineStart,
                lineEnd: ann.lineEnd,
                comment: ann.comment || '',
              });
            }
          }
        }
        // Legacy system: single filePath/lineStart on the note itself
        if (note.filePath === relPath && note.lineStart != null && !(note.annotations && note.annotations.length > 0)) {
          flat.push({
            noteId: note.id,
            noteTitle: note.title,
            noteContent: note.content,
            editorMode: note.editorMode,
            priority: note.priority,
            status: note.status,
            lineStart: note.lineStart,
            lineEnd: note.lineEnd ?? note.lineStart,
            comment: '',
          });
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
    } catch { /* offline or not authed */ }
  }

  // ── Hover provider ────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      {
        provideHover(document, position) {
          const folderPath = getFolderPath();
          if (!folderPath) { return; }
          const relPath = document.uri.fsPath
            .replace(folderPath + '/', '')
            .replace(folderPath + '\\', '');
          const flat = annotationCache.get(relPath) ?? [];
          const hovered = flat.find(ann => {
            const startLine = Math.max(0, ann.lineStart - 1);
            const endLine = Math.max(0, ann.lineEnd - 1);
            return position.line >= startLine && position.line <= endLine;
          });
          if (!hovered) { return; }

          let preview = '';
          if (hovered.editorMode === 'wysiwyg') {
            try { preview = JSON.parse(hovered.noteContent)?.ops?.map((op: {insert?: unknown}) => typeof op.insert === 'string' ? op.insert : '').join(''); }
            catch { preview = hovered.noteContent; }
          } else {
            preview = hovered.noteContent.replace(/[#*_`]/g, '');
          }
          preview = preview.replace(/\n/g, ' ').trim().slice(0, 150);

          const priorityLabel = hovered.priority !== 'none' ? ` \u2022 ${hovered.priority}` : '';
          const statusLabel = hovered.status === 'done' ? ' \u2713 Done' : hovered.status === 'passed' ? ' \u2713 Passed' : ' \u25cf Open';

          const md = new vscode.MarkdownString('', true);
          md.isTrusted = true;
          md.supportHtml = true;
          md.appendMarkdown(`**\ud83d\udcce ${hovered.noteTitle}**`);
          md.appendMarkdown(`\n\n_${statusLabel}${priorityLabel}_`);
          if (hovered.comment) { md.appendMarkdown(`\n\n${hovered.comment}`); }
          else if (preview) { md.appendMarkdown(`\n\n${preview}`); }
          const openCmd = vscode.Uri.parse(
            `command:notenest.openNoteById?${encodeURIComponent(JSON.stringify({ id: hovered.noteId }))}`
          );
          md.appendMarkdown(`\n\n[Open note \u2192](${openCmd})`);

          const startLine = Math.max(0, hovered.lineStart - 1);
          const endLine = Math.max(0, hovered.lineEnd - 1);
          const endLineText = document.lineAt(Math.min(endLine, document.lineCount - 1));
          return new vscode.Hover(md, new vscode.Range(startLine, 0, endLineText.lineNumber, endLineText.text.length));
        },
      }
    )
  );

  // ── openNoteById command ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('notenest.openNoteById', async ({ id }: { id: string }) => {
      // openNoteRef is assigned by resolveWebviewView once the sidebar is initialised
      if (openNoteRef) { await openNoteRef(id); }
    })
  );

  // ── CodeLens provider — clickable note title above each annotated line ─────────
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      {
        provideCodeLenses(document): vscode.CodeLens[] {
          const folderPath = getFolderPath();
          if (!folderPath) { return []; }
          const relPath = document.uri.fsPath
            .replace(folderPath + '/', '')
            .replace(folderPath + '\\', '');
          const flat = annotationCache.get(relPath) ?? [];
          const seen = new Set<string>();
          const lenses: vscode.CodeLens[] = [];
          for (const ann of flat) {
            const key = `${ann.noteId}:${ann.lineStart}`;
            if (seen.has(key)) { continue; }
            seen.add(key);
            const line = Math.max(0, ann.lineStart - 1);
            const range = new vscode.Range(line, 0, line, 0);
            lenses.push(new vscode.CodeLens(range, {
              title: `\ud83d\udcce ${ann.noteTitle}`,
              command: 'notenest.openNoteById',
              arguments: [{ id: ann.noteId }],
              tooltip: 'Open this NoteNest note',
            }));
          }
          return lenses;
        },
      }
    )
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) { refreshAnnotations(editor); }
    })
  );
  if (vscode.window.activeTextEditor) {
    refreshAnnotations(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
      if (editor) { refreshAnnotations(editor); }
    })
  );

  async function refreshGutterDecorations(editor: vscode.TextEditor) {
    await refreshAnnotations(editor);
  }

  // ── Selection decoration ──────────────────────────────────────────────────────
  const selectionDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '  NoteNest \u2318\u21e7N to annotate',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      margin: '0 0 0 12px',
      fontStyle: 'italic',
      fontWeight: '400',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  const annotateStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 1000
  );
  annotateStatusBarItem.text = '\ud83d\udcce Annotate selection';
  annotateStatusBarItem.tooltip = 'Add a NoteNest note to the selected code \u2014 or press \u2318\u21e7N';
  annotateStatusBarItem.command = 'notenest.annotateSelectionFromStatusBar';
  annotateStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  context.subscriptions.push(annotateStatusBarItem);

  let savedEditorUri: vscode.Uri | null = null;
  let savedSelection: vscode.Selection | null = null;
  let selectionDecorationTimer: ReturnType<typeof setTimeout> | null = null;

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (selectionDecorationTimer) { clearTimeout(selectionDecorationTimer); }
      const editor = e.textEditor;
      const selection = editor.selection;
      if (selection.isEmpty) {
        editor.setDecorations(selectionDecoration, []);
        annotateStatusBarItem.hide();
        return;
      }
      selectionDecorationTimer = setTimeout(() => {
        if (editor.selection.isEmpty) {
          editor.setDecorations(selectionDecoration, []);
          annotateStatusBarItem.hide();
          savedSelection = null; savedEditorUri = null;
          return;
        }
        savedSelection = new vscode.Selection(editor.selection.start, editor.selection.end);
        savedEditorUri = editor.document.uri;
        const endPos = editor.selection.end;
        const endLine = editor.document.lineAt(endPos.line);
        const decorationRange = new vscode.Range(endPos.line, endLine.range.end.character, endPos.line, endLine.range.end.character);
        editor.setDecorations(selectionDecoration, [{ range: decorationRange }]);
        annotateStatusBarItem.show();
      }, 150);
    })
  );

  // ── CodeAction provider ───────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      {
        provideCodeActions(document, range) {
          if (range.isEmpty) { return []; }
          const action = new vscode.CodeAction('\ud83d\udcce NoteNest: Annotate this selection', vscode.CodeActionKind.Empty);
          action.command = { command: 'notenest.annotateSelection', title: '\ud83d\udcce NoteNest: Annotate this selection' };
          return [action];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.Empty] }
    )
  );

  // ── Annotate logic ────────────────────────────────────────────────────────────
  async function runAnnotate(docUri: vscode.Uri, selection: vscode.Selection) {
    const folderPath = getFolderPath();
    if (!folderPath) { vscode.window.showWarningMessage('Open a folder first to use NoteNest annotations.'); return; }
    const { accessToken } = await getTokens(secrets);
    if (!accessToken) { vscode.window.showErrorMessage('Sign in to NoteNest first.'); return; }

    const doc = await vscode.workspace.openTextDocument(docUri);
    const codeSnippet = doc.getText(selection);
    const relPath = docUri.fsPath.replace(folderPath + '/', '').replace(folderPath + '\\', '');
    const lineStart = selection.start.line + 1;
    const lineEnd = selection.end.line + 1;
    const locationLabel = `${relPath}:${lineStart}\u2013${lineEnd}`;

    // ── Step 1: pick an existing note or create new ───────────────────────────
    const cached = loadCache();
    const existingNotes = cached?.notes ?? [];

    interface AnnotatePickItem extends vscode.QuickPickItem { noteId?: string; }

    const items: AnnotatePickItem[] = [
      {
        label: '$(add) Create new note',
        description: '',
        detail: `New note with this annotation attached \u2014 ${locationLabel}`,
        noteId: undefined,
      },
    ];

    if (existingNotes.length > 0) {
      items.push({ label: 'Add to existing note', kind: vscode.QuickPickItemKind.Separator });
      for (const n of existingNotes) {
        const annCount = (n.annotations?.length ?? 0) + (n.filePath ? 1 : 0);
        const annLabel = annCount > 0 ? `${annCount} annotation${annCount > 1 ? 's' : ''} \u00b7 ` : '';
        const date = new Date(n.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        let preview = '';
        if (n.editorMode === 'markdown') {
          preview = (n.content || '').replace(/[#*_`\[\]]/g, '').replace(/\n/g, ' ').trim().slice(0, 60);
        } else {
          try { preview = (JSON.parse(n.content || '').ops || []).map((op: {insert?: unknown}) => typeof op.insert === 'string' ? op.insert : '').join('').replace(/\n/g, ' ').trim().slice(0, 60); }
          catch { preview = (n.content || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 60); }
        }
        items.push({
          label: `$(note) ${n.title}`,
          description: `${annLabel}${date}`,
          detail: preview || 'Empty note',
          noteId: n.id,
        });
      }
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Add Annotation',
      placeHolder: 'Create a new note or add to an existing one\u2026',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });
    if (!picked) { return; }

    // ── Step 2a: creating a new note — ask for title then comment ─────────────
    if (!picked.noteId) {
      const title = await vscode.window.showInputBox({
        title: 'Add Annotation',
        step: 1,
        totalSteps: 2,
        prompt: `New note for ${locationLabel}`,
        placeHolder: 'Note title\u2026',
        ignoreFocusOut: true,
      });
      if (title === undefined) { return; }

      const comment = await vscode.window.showInputBox({
        title: 'Add Annotation',
        step: 2,
        totalSteps: 2,
        prompt: 'Add a comment for this annotation (optional)',
        placeHolder: 'e.g. This needs refactoring\u2026',
        ignoreFocusOut: true,
      });
      if (comment === undefined) { return; }

      try {
        // Create the note first
        const noteRes = await apiPost(secrets, '/notes', {
          folderPath,
          title: title || 'Untitled annotation',
          content: '',
          editorMode: 'wysiwyg',
        });
        const newNote: NoteItem = noteRes.data.data;

        // Then attach the annotation to it
        const annRes = await apiPost(secrets, '/annotations', {
          noteId: newNote.id,
          filePath: relPath,
          lineStart,
          lineEnd,
          codeSnippet: codeSnippet.slice(0, 500),
          comment: comment || '',
          status: 'open',
        });
        // Put the annotation on the note object so cache is accurate
        newNote.annotations = [annRes.data.data];

        if (memCache) {
          memCache.notes.unshift(newNote);
          context.globalState.update(cacheKey(), memCache);
        } else {
          await saveCache([newNote]);
        }

        // Refresh sidebar list
        if (panel) {
          const c2 = loadCache(); const fp2 = getFolderPath();
          const pn2 = fp2?.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project';
          if (c2) { panel.webview.html = notesListHtml(pn2, c2.notes, false); }
        }

        vscode.window.showInformationMessage(`\ud83d\udcce Annotation added to new note \u201c${newNote.title}\u201d`);
      } catch { vscode.window.showErrorMessage('Failed to create note and annotation.'); return; }

    // ── Step 2b: adding to existing note — ask for comment only ──────────────
    } else {
      const targetNote = existingNotes.find(n => n.id === picked.noteId)!;

      const comment = await vscode.window.showInputBox({
        title: 'Add Annotation',
        step: 1,
        totalSteps: 1,
        prompt: `Adding annotation to \u201c${targetNote.title}\u201d \u2014 ${locationLabel}`,
        placeHolder: 'Comment (optional)\u2026',
        ignoreFocusOut: true,
      });
      if (comment === undefined) { return; }

      try {
        const annRes = await apiPost(secrets, '/annotations', {
          noteId: picked.noteId,
          filePath: relPath,
          lineStart,
          lineEnd,
          codeSnippet: codeSnippet.slice(0, 500),
          comment: comment || '',
          status: 'open',
        });
        const newAnnotation = annRes.data.data;

        // Update cache: push new annotation onto the note
        if (memCache) {
          const idx = memCache.notes.findIndex(n => n.id === picked.noteId);
          if (idx !== -1) {
            const note = memCache.notes[idx];
            memCache.notes[idx] = {
              ...note,
              annotations: [...(note.annotations ?? []), newAnnotation],
              updatedAt: new Date().toISOString(),
            };
            context.globalState.update(cacheKey(), memCache);
          }
        }

        // Refresh sidebar list
        if (panel) {
          const c2 = loadCache(); const fp2 = getFolderPath();
          const pn2 = fp2?.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project';
          if (c2) { panel.webview.html = notesListHtml(pn2, c2.notes, false); }
        }

        // If that note's editor panel is open, re-render it with fresh data
        const existingPanel = openNotePanels.get(picked.noteId!);
        if (existingPanel) {
          try {
            const freshRes = await apiGet(secrets, `/notes/${picked.noteId}`);
            const freshNote: NoteItem = freshRes.data.data;
            updateNoteInCache(freshNote);
            const { bg, text } = getNoteColors();
            const fp2 = getFolderPath();
            const pn2 = fp2?.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project';
            existingPanel.webview.html = noteEditorHtml(freshNote, pn2, bg, text);
          } catch { /* panel stays stale, not critical */ }
        }

        vscode.window.showInformationMessage(`\ud83d\udcce Annotation added to \u201c${targetNote.title}\u201d`);
      } catch { vscode.window.showErrorMessage('Failed to save annotation.'); return; }
    }

    // ── Common cleanup ────────────────────────────────────────────────────────
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) { refreshGutterDecorations(activeEditor); }
    savedSelection = null;
    savedEditorUri = null;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('notenest.annotateSelectionFromStatusBar', async () => {
      if (!savedSelection || !savedEditorUri) {
        vscode.window.showWarningMessage('Select some code first, then click Annotate.');
        return;
      }
      await runAnnotate(savedEditorUri, savedSelection);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand('notenest.annotateSelection', async (editor) => {
      let selection = editor.selection;
      let docUri = editor.document.uri;
      if (selection.isEmpty && savedSelection && savedEditorUri) {
        selection = savedSelection; docUri = savedEditorUri;
      }
      if (selection.isEmpty) {
        vscode.window.showWarningMessage('Select some code first, then run Annotate with NoteNest.');
        return;
      }
      await runAnnotate(docUri, selection);
    })
  );

  // ── Git hook installer ────────────────────────────────────────────────────────
  async function installGitHook(folderPath: string) {
    const fs = require('fs');
    const pathMod = require('path');
    const hookDir = pathMod.join(folderPath, '.git', 'hooks');
    const hookPath = pathMod.join(hookDir, 'pre-commit');

    if (!fs.existsSync(pathMod.join(folderPath, '.git'))) { return; }
    if (!fs.existsSync(hookDir)) { fs.mkdirSync(hookDir, { recursive: true }); }

    const hookScript = [
      '#!/bin/sh',
      '# NoteNest pre-commit check \u2014 auto-installed by NoteNest VS Code extension',
      '# Safe to remove if you uninstall NoteNest. Does nothing if config not found.',
      'NOTENEST_PROJECT_CONFIG=".notenest/config.json"',
      'NOTENEST_HOME_CONFIG="$HOME/.notenest/tokens.json"',
      'if [ ! -f "$NOTENEST_PROJECT_CONFIG" ] || [ ! -f "$NOTENEST_HOME_CONFIG" ]; then exit 0; fi',
      'FOLDER=$(pwd)',
      'API=$(node -e "try{const c=require(process.env.HOME+\'/.notenest/tokens.json\');process.stdout.write(c.apiUrl||\'https://vsnotes-backend.onrender.com\');}catch(e){process.stdout.write(\'https://vsnotes-backend.onrender.com\')}" 2>/dev/null)',
      'REFRESH_TOKEN=$(node -e "try{const c=require(process.env.HOME+\'/.notenest/tokens.json\');process.stdout.write(c.refreshToken||\'\');}catch(e){}" 2>/dev/null)',
      'if [ -z "$REFRESH_TOKEN" ]; then exit 0; fi',
      'TOKEN=$(REFRESH_TOKEN="$REFRESH_TOKEN" API="$API" node -e "',
      'const https=require(\'https\');',
      'const body=JSON.stringify({refreshToken:process.env.REFRESH_TOKEN});',
      'const url=new URL(process.env.API+\'/auth/refresh\');',
      'const opts={hostname:url.hostname,port:url.port||443,path:url.pathname,method:\'POST\',headers:{\'Content-Type\':\'application/json\',\'Content-Length\':\'\'+Buffer.byteLength(body)}};',
      'const req=https.request(opts,res=>{let d=\'\';res.on(\'data\',c=>d+=c);res.on(\'end\',()=>{try{const r=JSON.parse(d);process.stdout.write(r.data&&r.data.accessToken?r.data.accessToken:\'\');}catch(e){}});});',
      'req.on(\'error\',()=>{});req.write(body);req.end();',
      '" 2>/dev/null)',
      'if [ -z "$TOKEN" ]; then exit 0; fi',
      'ENCODED_FOLDER=$(node -e "process.stdout.write(encodeURIComponent(\'$FOLDER\'))" 2>/dev/null)',
      'RESULT=$(curl -sf -H "Authorization: Bearer $TOKEN" "$API/notes/blocking?folderPath=$ENCODED_FOLDER" 2>/dev/null)',
      'if [ $? -ne 0 ]; then exit 0; fi',
      'BLOCKED=$(node -e "try{const r=JSON.parse(process.argv[1]);if(r.blocked){console.log(\'BLOCKED\');r.data.forEach(n=>console.log(\'  \u2022 \'+n.title+(n.priority!==\'none\'?\' [\'+n.priority+\']\':\'\')));}}catch(e){}" "$RESULT" 2>/dev/null)',
      'if echo "$BLOCKED" | grep -q "BLOCKED"; then',
      '  echo ""',
      '  echo "\u274c NoteNest: Open notes are blocking this commit:"',
      '  echo "$BLOCKED" | grep -v "BLOCKED"',
      '  echo ""',
      '  echo "Mark them as done in VS Code (NoteNest sidebar \u2192 change status to Done) then try again."',
      '  echo ""',
      '  exit 1',
      'fi',
      'exit 0',
    ].join('\n');

    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, 'utf8');
      if (existing.includes('NoteNest pre-commit check')) {
        const withoutOld = existing.replace(/\n*# NoteNest pre-commit check[\s\S]*?exit 0\s*$/, '').trimEnd();
        fs.writeFileSync(hookPath, withoutOld ? withoutOld + '\n\n' + hookScript : hookScript);
      } else {
        fs.writeFileSync(hookPath, existing.trimEnd() + '\n\n' + hookScript);
      }
    } else {
      fs.writeFileSync(hookPath, hookScript);
    }
    fs.chmodSync(hookPath, '755');
  }

  async function writeNoteNestConfig(folderPath: string) {
    const fs = require('fs');
    const pathMod = require('path');
    const os = require('os');
    const { accessToken, refreshToken } = await getTokens(secrets);
    if (!accessToken) { return; }

    const homeConfigDir = pathMod.join(os.homedir(), '.notenest');
    if (!fs.existsSync(homeConfigDir)) { fs.mkdirSync(homeConfigDir, { recursive: true }); }
    fs.writeFileSync(pathMod.join(homeConfigDir, 'tokens.json'), JSON.stringify({
      apiUrl: getApiUrl(),
      refreshToken: refreshToken || '',
    }, null, 2), { mode: 0o600 });

    const projectConfigDir = pathMod.join(folderPath, '.notenest');
    if (!fs.existsSync(projectConfigDir)) { fs.mkdirSync(projectConfigDir, { recursive: true }); }
    fs.writeFileSync(pathMod.join(projectConfigDir, 'config.json'), JSON.stringify({ folderPath }, null, 2));

    const gitignorePath = pathMod.join(folderPath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gi = fs.readFileSync(gitignorePath, 'utf8');
      if (!gi.includes('.notenest')) {
        fs.appendFileSync(gitignorePath, '\n# NoteNest (local only)\n.notenest/\n');
      }
    } else {
      fs.writeFileSync(gitignorePath, '# NoteNest (local only)\n.notenest/\n');
    }
  }

  const currentFolder = getFolderPath();
  if (currentFolder) {
    writeNoteNestConfig(currentFolder).then(() => installGitHook(currentFolder)).catch(() => {});
  }
  flushOfflineQueue().catch(() => {});
  context.subscriptions.push(
    vscode.commands.registerCommand('notenest.openNotes', () =>
      vscode.commands.executeCommand('notenest.notesView.focus')),
    vscode.commands.registerCommand('notenest.logout', async () => {
      await clearTokens(secrets);
      if (panel) { panel.webview.html = loginHtml(iconUri); }
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      const config = vscode.workspace.getConfiguration('projectnotes');
      if (config.get('autoShow', true)) {
        vscode.commands.executeCommand('projectnotes.notesView.focus');
      }
    })
  );
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
