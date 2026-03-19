import * as vscode from 'vscode';
import axios from 'axios';
import { randomBytes } from 'crypto';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApiUrl(): string {
  return vscode.workspace.getConfiguration('notenest').get('apiUrl', 'https://vsnotes-backend.onrender.com');
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

interface NoteItem {
  id: string; title: string; content: string;
  updatedAt: string; pinned: boolean; tags: string[]; editorMode: string;
  priority: string; status: string;
  filePath?: string; lineStart?: number; lineEnd?: number; codeSnippet?: string;
}

const PRIORITY_ORDER: Record<string, number> = {
  emergency: 5, urgent: 4, important: 3, medium: 2, low: 1, none: 0,
};
const PRIORITY_BADGE: Record<string, string> = {
  emergency: '🚨', urgent: '🔴', important: '🟠', medium: '🟡', low: '🟢',
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
  <style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:24px 20px;margin:0;display:flex;flex-direction:column;align-items:center;text-align:center;box-sizing:border-box}
    p{font-size:13px;color:var(--vscode-descriptionForeground);margin-bottom:20px;line-height:1.5;max-width:220px}
    button{width:100%;padding:8px 16px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:13px}
    button:hover{background:var(--vscode-button-hoverBackground)}
  </style></head><body>
  <img src="${iconUri}" width="120" height="120" style="margin-bottom:16px"/>
  <p>Sign in to keep per-project notes that sync across all your machines.</p>
  <button id="b">Sign in / Sign up</button>
  <script>
    const vscode=acquireVsCodeApi();
    document.getElementById('b').addEventListener('click',()=>vscode.postMessage({type:'startLogin'}));
  </script></body></html>`;
}

// ── HTML: Settings ────────────────────────────────────────────────────────────

function settingsHtml(autoShow: boolean, noteBgColor: string): string {
  const swatches = BG_COLORS.map(c => `
    <div class="swatch${c.bg === noteBgColor ? ' active' : ''}" data-bg="${c.bg}" data-text="${c.text}"
      style="background:${c.bg};border-color:${c.bg === noteBgColor ? '#6c8ef5' : 'transparent'}" title="${c.label}">
      ${c.bg === noteBgColor ? '<span class="check">✓</span>' : ''}
    </div>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <style>
    *{box-sizing:border-box}
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:16px;margin:0}
    h2{font-size:14px;margin-bottom:16px}
    .label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--vscode-descriptionForeground);margin:16px 0 8px}
    .row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
    .back{background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;font-size:12px;padding:0;margin-bottom:14px}
    .swatches{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
    .swatch{width:100%;aspect-ratio:1;border-radius:6px;cursor:pointer;border:2px solid transparent;position:relative;display:flex;align-items:center;justify-content:center;transition:transform 0.1s}
    .swatch:hover{transform:scale(1.08)}
    .check{font-size:14px;color:#6c8ef5;font-weight:bold;text-shadow:0 0 4px rgba(0,0,0,0.5)}
    .logout{margin-top:20px;width:100%;padding:7px;background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-errorForeground);border:1px solid var(--vscode-inputValidation-errorBorder);border-radius:4px;cursor:pointer;font-size:12px}
  </style></head><body>
  <button class="back" id="bk">← Back</button>
  <h2>Settings</h2>
  <div class="row"><label>Auto-show on project open</label><input type="checkbox" id="as" ${autoShow ? 'checked' : ''}/></div>
  <div class="label">Note background colour</div>
  <div class="swatches">${swatches}</div>
  <button class="logout" id="lo">Log out</button>
  <script>
    const vscode=acquireVsCodeApi();
    document.getElementById('bk').addEventListener('click',()=>vscode.postMessage({type:'showList'}));
    document.getElementById('as').addEventListener('change',e=>vscode.postMessage({type:'setSetting',key:'autoShow',value:e.target.checked}));
    document.querySelectorAll('.swatch').forEach(s=>{
      s.addEventListener('click',()=>{
        document.querySelectorAll('.swatch').forEach(x=>{x.classList.remove('active');x.style.borderColor='transparent';x.innerHTML='';});
        s.classList.add('active');s.style.borderColor='#6c8ef5';s.innerHTML='<span class="check">✓</span>';
        vscode.postMessage({type:'setSetting',key:'noteBgColor',value:s.dataset.bg,textColor:s.dataset.text});
      });
    });
    document.getElementById('lo').addEventListener('click',()=>vscode.postMessage({type:'logout'}));
  </script></body></html>`;
}

// ── HTML: Notes List ──────────────────────────────────────────────────────────

function noFolderHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <style>
    *{box-sizing:border-box}
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:24px 16px;margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
    .icon{font-size:36px;margin-bottom:14px;opacity:0.4}
    h3{font-size:13px;font-weight:600;margin:0 0 8px;color:var(--vscode-foreground)}
    p{font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;margin:0 0 20px}
    button{padding:7px 16px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:12px;font-family:var(--vscode-font-family)}
    button:hover{background:var(--vscode-button-hoverBackground)}
  </style></head><body>
  <div class="icon">📂</div>
  <h3>No folder open</h3>
  <p>Open a project folder to start writing notes for it. Each folder gets its own set of notes.</p>
  <button id="openBtn">Open Folder</button>
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
      ? `<span class="priority-badge p-${n.priority}" title="${PRIORITY_LABEL[n.priority]}">${PRIORITY_BADGE[n.priority]}</span>`
      : '';
    const statusBadge = n.status === 'done' ? '<span class="status-badge done">✓ done</span>'
      : n.status === 'passed' ? '<span class="status-badge passed">✓ passed</span>' : '';
    const fileBadge = n.filePath
      ? `<span class="file-badge" data-id="${n.id}" data-file="${n.filePath}" data-line="${n.lineStart ?? 1}" data-line-start="${n.lineStart ?? 1}" data-line-end="${n.lineEnd ?? n.lineStart ?? 1}" title="Jump to ${n.filePath}:${n.lineStart}\u2013${n.lineEnd}">📎 ${n.filePath.split('/').pop()}:${n.lineStart}–${n.lineEnd}</span>`
      : '';
    return `<div class="note-row" data-id="${n.id}">
      <div class="note-main">
        <div class="note-header">
          ${priorityBadge}
          ${n.pinned ? '<span class="pin">📌</span>' : ''}
          <span class="note-title">${safeTitle}</span>
          ${statusBadge}
          <span class="note-date">${date}</span>
        </div>
        ${fileBadge ? `<div class="file-row">${fileBadge}</div>` : ''}
        <div class="note-preview">${preview || '<span class="dim">Empty note</span>'}</div>
        ${tagBadges ? `<div class="tags">${tagBadges}</div>` : ''}
      </div>
      <button class="del-btn" data-id="${n.id}" title="Delete">✕</button>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <style>
    *{box-sizing:border-box}
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:0;margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden}
    .toolbar{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    .project-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px}
    .toolbar-right{display:flex;align-items:center;gap:2px}
    .icon-btn{background:none;border:none;cursor:pointer;color:var(--vscode-foreground);opacity:0.65;font-size:15px;padding:3px 6px;border-radius:3px;line-height:1}
    .icon-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}
    .search-bar{padding:5px 10px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    .search-bar input{width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);border-radius:3px;padding:4px 8px;font-size:12px;outline:none;font-family:var(--vscode-font-family)}
    .search-bar input:focus{border-color:var(--vscode-focusBorder)}
    .offline-banner{padding:6px 10px;background:var(--vscode-inputValidation-warningBackground);font-size:11px;flex-shrink:0}
    .notes-list{flex:1;overflow-y:auto;padding:4px 0}
    .note-row{display:flex;align-items:center;padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--vscode-panel-border);gap:6px}
    .note-row:hover{background:var(--vscode-list-hoverBackground)}
    .note-row.hidden{display:none}
    .note-main{flex:1;min-width:0}
    .note-header{display:flex;align-items:baseline;gap:4px;margin-bottom:2px}
    .pin{font-size:10px;flex-shrink:0}
    .note-title{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
    .note-date{font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;flex-shrink:0}
    .note-preview{font-size:11px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tags{display:flex;gap:3px;margin-top:3px;flex-wrap:wrap}
    .tag{font-size:10px;padding:1px 5px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
    .dim{opacity:0.4;font-style:italic}
    .del-btn{background:none;border:none;cursor:pointer;color:var(--vscode-errorForeground);opacity:0;font-size:11px;padding:2px 4px;border-radius:2px;flex-shrink:0}
    .note-row:hover .del-btn{opacity:0.5}.del-btn:hover{opacity:1 !important;background:var(--vscode-inputValidation-errorBackground)}
    .empty{padding:40px 20px;text-align:center;font-size:13px;color:var(--vscode-descriptionForeground);line-height:1.8}
    .status-badge{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;flex-shrink:0}
    .status-badge.done{background:rgba(63,185,80,0.15);color:#3fb950;border:1px solid rgba(63,185,80,0.3)}
    .status-badge.passed{background:rgba(108,142,245,0.15);color:#6c8ef5;border:1px solid rgba(108,142,245,0.3)}
    .file-row{margin-bottom:2px}
    .file-badge{font-size:10px;color:var(--vscode-textLink-foreground);cursor:pointer;opacity:0.8}
    .file-badge:hover{opacity:1;text-decoration:underline}
  </style></head><body>
  <div class="toolbar">
    <span class="project-name" title="${projectName}">${projectName}</span>
    <div class="toolbar-right">
      <button class="icon-btn" id="newBtn" title="New note (Cmd/Ctrl+N)">+</button>
      <button class="icon-btn" id="settingsBtn" title="Settings">⚙</button>
    </div>
  </div>
  <div class="search-bar">
    <input id="search" placeholder="Search notes…" autocomplete="off"/>
  </div>
  ${offline ? '<div class="offline-banner">⚠ Offline — changes won\'t save</div>' : ''}
  <div class="notes-list" id="list">
    ${items}
    ${notes.length === 0 ? '<div class="empty">No notes yet.<br/>Press <strong>+</strong> to create one.</div>' : ''}
  </div>
  <script>
    const vscode=acquireVsCodeApi();
    document.getElementById('newBtn').addEventListener('click',()=>vscode.postMessage({type:'newNote'}));
    document.getElementById('settingsBtn').addEventListener('click',()=>vscode.postMessage({type:'openSettings'}));
    document.querySelectorAll('.note-row').forEach(row=>{
      row.addEventListener('click',e=>{
        if(e.target.classList.contains('del-btn'))return;
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
    // File badge click — jump to file location and highlight the annotated range
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
      if((e.metaKey||e.ctrlKey)&&e.key==='n'){e.preventDefault();vscode.postMessage({type:'newNote'});}
    });
  </script></body></html>`;
}

// ── HTML: Note Editor ─────────────────────────────────────────────────────────

function noteEditorHtml(note: NoteItem, projectName: string, bgColor: string, textColor: string): string {
  const safeTitle = (note.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tagsJson = JSON.stringify(note.tags || []);
  const isMarkdown = note.editorMode === 'markdown';
  const safeContent = (note.content || '').replace(/`/g, '\\`').replace(/\\/g, '\\\\');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <!-- Quill WYSIWYG -->
  <link rel="stylesheet" href="https://cdn.quilljs.com/1.3.7/quill.snow.css"/>
  <script src="https://cdn.quilljs.com/1.3.7/quill.min.js"><\/script>
  <!-- Marked for Markdown preview -->
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
  <style>
    *{box-sizing:border-box}
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:0;margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden}

    /* Toolbar */
    .toolbar{display:flex;align-items:center;padding:5px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;gap:5px}
    .back-btn{background:none;border:none;cursor:pointer;color:var(--vscode-textLink-foreground);font-size:11px;padding:0;white-space:nowrap;flex-shrink:0}
    .title-input{flex:1;background:transparent;border:none;color:var(--vscode-foreground);font-size:12px;font-weight:600;outline:none;min-width:0;font-family:var(--vscode-font-family)}
    .title-input::placeholder{color:var(--vscode-input-placeholderForeground)}
    .status{font-size:10px;color:#4caf50;white-space:nowrap;flex-shrink:0;min-width:40px;text-align:right}

    /* Meta bar: tags + pin + mode toggle */
    .meta-bar{display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;flex-wrap:wrap}
    .pin-btn{background:none;border:none;cursor:pointer;font-size:13px;padding:0;opacity:0.5;line-height:1}
    .pin-btn.active{opacity:1}
    .tags-input{flex:1;background:transparent;border:none;color:var(--vscode-descriptionForeground);font-size:11px;outline:none;font-family:var(--vscode-font-family);min-width:80px}
    .tags-input::placeholder{color:var(--vscode-input-placeholderForeground);font-style:italic}
    .mode-toggle{display:flex;gap:2px;flex-shrink:0}
    .mode-btn{background:none;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-size:10px;padding:2px 6px;border-radius:3px;cursor:pointer}
    .mode-btn.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
    .priority-select{background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);font-size:10px;padding:2px 4px;border-radius:3px;cursor:pointer;font-family:var(--vscode-font-family);flex-shrink:0}
    .status-select{background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);font-size:10px;padding:2px 4px;border-radius:3px;cursor:pointer;font-family:var(--vscode-font-family);flex-shrink:0}
    .status-select.open{border-color:rgba(239,68,68,0.5);color:#f87171}
    .status-select.done{border-color:rgba(63,185,80,0.5);color:#3fb950}
    .status-select.passed{border-color:rgba(108,142,245,0.5);color:#6c8ef5}

    /* Word count */
    .word-count{padding:3px 8px;font-size:10px;color:var(--vscode-descriptionForeground);flex-shrink:0;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background)}

    /* Editor area */
    .editor-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;background:${bgColor};color:${textColor}}

    /* WYSIWYG Quill overrides */
    .ql-toolbar{background:#fff1;border:none!important;border-bottom:1px solid rgba(128,128,128,0.2)!important;flex-shrink:0;padding:4px!important}
    .ql-toolbar .ql-stroke{stroke:${textColor}!important}
    .ql-toolbar .ql-fill{fill:${textColor}!important}
    .ql-toolbar .ql-picker-label{color:${textColor}!important}
    .ql-toolbar button:hover .ql-stroke,.ql-toolbar button.ql-active .ql-stroke{stroke:#6c8ef5!important}
    .ql-container{flex:1;font-size:13px;border:none!important;overflow:auto}
    .ql-editor{color:${textColor};min-height:200px;line-height:1.7;padding:12px}
    .ql-editor.ql-blank::before{color:${textColor};opacity:0.35;font-style:italic}

    /* Markdown area */
    .md-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;background:${bgColor}}
    .md-panes{flex:1;display:flex;overflow:hidden}
    textarea.md-edit{flex:1;background:${bgColor};color:${textColor};border:none;resize:none;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;line-height:1.7;padding:12px;outline:none}
    textarea.md-edit::placeholder{color:${textColor};opacity:0.35}
    .md-preview{flex:1;overflow-y:auto;padding:12px;color:${textColor};font-size:13px;line-height:1.7;border-left:1px solid rgba(128,128,128,0.2)}
    .md-preview h1,.md-preview h2,.md-preview h3{margin-top:0.8em;margin-bottom:0.3em}
    .md-preview code{background:rgba(128,128,128,0.15);padding:1px 4px;border-radius:3px;font-size:12px}
    .md-preview pre{background:rgba(128,128,128,0.15);padding:8px;border-radius:4px;overflow-x:auto}
    .md-preview a{color:#6c8ef5}
    .md-tabs{display:flex;border-bottom:1px solid rgba(128,128,128,0.2);background:${bgColor};flex-shrink:0}
    .md-tab{flex:1;text-align:center;padding:5px;font-size:11px;cursor:pointer;color:${textColor};opacity:0.5;border:none;background:none}
    .md-tab.active{opacity:1;border-bottom:2px solid #6c8ef5}
  </style></head><body>

  <!-- Toolbar -->
  <div class="toolbar">
    <button class="back-btn" id="backBtn">← ${projectName}</button>
    <input class="title-input" id="titleInput" value="${safeTitle}" placeholder="Note title…"/>
    <span class="status" id="status"></span>
  </div>

  <!-- Meta bar -->
  <div class="meta-bar">
    <button class="pin-btn${note.pinned ? ' active' : ''}" id="pinBtn" title="${note.pinned ? 'Unpin' : 'Pin note'}">📌</button>
    <select class="priority-select" id="prioritySelect" title="Priority">
      <option value="none"${(note.priority||'none')==='none'?' selected':''}>— Priority</option>
      <option value="low"${note.priority==='low'?' selected':''}>🟢 Low</option>
      <option value="medium"${note.priority==='medium'?' selected':''}>🟡 Medium</option>
      <option value="important"${note.priority==='important'?' selected':''}>🟠 Important</option>
      <option value="urgent"${note.priority==='urgent'?' selected':''}>🔴 Urgent</option>
      <option value="emergency"${note.priority==='emergency'?' selected':''}>🚨 Emergency</option>
    </select>
    <select class="status-select ${note.status||'open'}" id="statusSelect" title="Status">
      <option value="open"${(note.status||'open')==='open'?' selected':''}>⬤ Open</option>
      <option value="done"${note.status==='done'?' selected':''}>✓ Done</option>
      <option value="passed"${note.status==='passed'?' selected':''}>✓ Passed</option>
    </select>
    <input class="tags-input" id="tagsInput" value="${note.tags.join(', ')}" placeholder="Tags: idea, bug, todo…"/>
    <div class="mode-toggle">
      <button class="mode-btn${!isMarkdown ? ' active' : ''}" id="modeWysiwyg">WYSIWYG</button>
      <button class="mode-btn${isMarkdown ? ' active' : ''}" id="modeMd">Markdown</button>
    </div>
  </div>

  <!-- Code annotation banner -->
  ${note.filePath ? `
  <div style="padding:6px 10px;background:rgba(108,142,245,0.08);border-bottom:1px solid rgba(108,142,245,0.2);font-size:11px;color:var(--vscode-textLink-foreground);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
    <span id="annotationBanner" style="cursor:pointer" title="Click to jump to this location">📎 ${note.filePath}:${note.lineStart}–${note.lineEnd}</span>
    <span style="opacity:0.6;font-family:var(--vscode-editor-font-family,monospace);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%">${(note.codeSnippet||'').replace(/</g,'&lt;').slice(0,80)}</span>
  </div>` : ''}
  <!-- Word count -->
  <div class="word-count" id="wordCount">0 words · 0 chars</div>

  <!-- WYSIWYG editor -->
  <div class="editor-wrap" id="wysiwygWrap" style="display:${isMarkdown ? 'none' : 'flex'}">
    <div id="quillEditor"></div>
  </div>

  <!-- Markdown editor -->
  <div class="md-wrap" id="mdWrap" style="display:${isMarkdown ? 'flex' : 'none'};flex-direction:column">
    <div class="md-tabs">
      <button class="md-tab active" id="tabEdit">Edit</button>
      <button class="md-tab" id="tabPreview">Preview</button>
    </div>
    <div class="md-panes">
      <textarea class="md-edit" id="mdEdit" placeholder="Write Markdown…"></textarea>
      <div class="md-preview" id="mdPreview" style="display:none"></div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const noteId = "${note.id}";
    let mode = "${note.editorMode || 'wysiwyg'}";
    let pinned = ${note.pinned};
    let saveTimer = null;

    // ── Quill init ──────────────────────────────────────────────────────────
    const quill = new Quill('#quillEditor', {
      theme: 'snow',
      placeholder: 'Start writing…',
      modules: {
        toolbar: [
          ['bold','italic','underline','strike'],
          ['blockquote','code-block'],
          [{'list':'ordered'},{'list':'bullet'}],
          [{'header':[1,2,3,false]}],
          ['link'],
          ['clean']
        ]
      }
    });

    // Load initial content
    const rawContent = \`${safeContent}\`;
    if (mode === 'wysiwyg') {
      try { quill.setContents(JSON.parse(rawContent)); } catch { quill.setText(rawContent); }
    } else {
      document.getElementById('mdEdit').value = rawContent;
      updateMdPreview();
    }

    // ── Word count ──────────────────────────────────────────────────────────
    function updateWordCount(text) {
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      const chars = text.length;
      document.getElementById('wordCount').textContent = words + ' words · ' + chars + ' chars';
    }

    quill.on('text-change', () => {
      updateWordCount(quill.getText());
      scheduleSave();
    });
    document.getElementById('mdEdit').addEventListener('input', e => {
      updateWordCount(e.target.value);
      updateMdPreview();
      scheduleSave();
    });

    // init word count
    updateWordCount(mode === 'wysiwyg' ? quill.getText() : document.getElementById('mdEdit').value);

    // ── Markdown preview ────────────────────────────────────────────────────
    function updateMdPreview() {
      const src = document.getElementById('mdEdit').value;
      document.getElementById('mdPreview').innerHTML = marked.parse(src);
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

    // ── Mode toggle ─────────────────────────────────────────────────────────
    function switchMode(newMode) {
      if (newMode === mode) return;
      mode = newMode;
      document.getElementById('modeWysiwyg').classList.toggle('active', mode === 'wysiwyg');
      document.getElementById('modeMd').classList.toggle('active', mode === 'markdown');
      document.getElementById('wysiwygWrap').style.display = mode === 'wysiwyg' ? 'flex' : 'none';
      document.getElementById('mdWrap').style.display = mode === 'markdown' ? 'flex' : 'none';
      // Convert content between modes (best effort)
      if (mode === 'markdown') {
        const text = quill.getText();
        document.getElementById('mdEdit').value = text;
        updateMdPreview();
      } else {
        const md = document.getElementById('mdEdit').value;
        quill.setText(md);
      }
      scheduleSave();
    }
    document.getElementById('modeWysiwyg').addEventListener('click', () => switchMode('wysiwyg'));
    document.getElementById('modeMd').addEventListener('click', () => switchMode('markdown'));

    // ── Pin ─────────────────────────────────────────────────────────────────
    document.getElementById('pinBtn').addEventListener('click', () => {
      pinned = !pinned;
      document.getElementById('pinBtn').classList.toggle('active', pinned);
      document.getElementById('pinBtn').title = pinned ? 'Unpin' : 'Pin note';
      scheduleSave();
    });

    // ── Tags ────────────────────────────────────────────────────────────────
    document.getElementById('tagsInput').addEventListener('input', scheduleSave);

    // ── Save ────────────────────────────────────────────────────────────────
    function getContent() {
      if (mode === 'wysiwyg') return JSON.stringify(quill.getContents());
      return document.getElementById('mdEdit').value;
    }
    function getTags() {
      return document.getElementById('tagsInput').value
        .split(',').map(t => t.trim()).filter(Boolean);
    }
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(doSave, 900);
    }
    function doSave() {
      vscode.postMessage({
        type: 'saveNote',
        id: noteId,
        title: document.getElementById('titleInput').value,
        content: getContent(),
        editorMode: mode,
        pinned: pinned,
        tags: getTags(),
        priority: document.getElementById('prioritySelect').value,
        status: document.getElementById('statusSelect').value,
      });
    }

    document.getElementById('titleInput').addEventListener('input', scheduleSave);
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); clearTimeout(saveTimer); doSave(); }
    });

    // Status select colour update
    const statusSel = document.getElementById('statusSelect');
    statusSel.addEventListener('change', function() {
      statusSel.className = 'status-select ' + statusSel.value;
      scheduleSave();
    });

    // Annotation banner click — jump to file and highlight the exact range
    const annotBanner = document.getElementById('annotationBanner');
    if (annotBanner) {
      annotBanner.addEventListener('click', () => {
        vscode.postMessage({
          type: 'jumpToFile',
          file: '${note.filePath || ''}',
          line: ${note.lineStart || 1},
          lineStart: ${note.lineStart || 1},
          lineEnd: ${note.lineEnd || note.lineStart || 1},
        });
      });
    }

    // Auto-select Untitled
    const titleEl = document.getElementById('titleInput');
    if (titleEl.value === 'Untitled') { titleEl.focus(); titleEl.select(); }

    // ── Back ────────────────────────────────────────────────────────────────
    document.getElementById('backBtn').addEventListener('click', () => {
      clearTimeout(saveTimer);
      vscode.postMessage({
        type: 'saveNote',
        id: noteId,
        title: titleEl.value,
        content: getContent(),
        editorMode: mode,
        pinned: pinned,
        tags: getTags(),
        priority: document.getElementById('prioritySelect').value,
        status: document.getElementById('statusSelect').value,
        thenShowList: true,
      });
    });

    // ── Listen for messages from extension host ────────────────────────────────
    window.addEventListener('message', e => {
      if (e.data.type === 'saved') {
        const s = document.getElementById('status');
        s.textContent = '✓ Saved';
        setTimeout(() => { s.textContent = ''; }, 2000);
      }
      // Opened from hover popup — navigate directly to this note
      if (e.data.type === 'openNoteFromHost') {
        vscode.postMessage({ type: 'openNote', id: e.data.id });
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

  function getNoteColors(): { bg: string; text: string } {
    const config = vscode.workspace.getConfiguration('notenest');
    return {
      bg: config.get('noteBgColor', '#1e1e1e'),
      text: config.get('noteTextColor', '#d4d4d4'),
    };
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
        // On startup: open the highest-priority note directly (or most recent if none prioritised)
        const folderPath = getFolderPath();
        if (folderPath) {
          try {
            const res = await apiGet(secrets, '/notes', { folderPath });
            const notes: NoteItem[] = res.data.data;
            const top = topPriorityNote(notes);
            if (top) {
              await openNote(top.id); return;
            }
          } catch { /* fall through to list */ }
        }
        await showNotesList();
      }

      async function showNotesList() {
        const folderPath = getFolderPath();
        const projectName = folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? 'No project';
        currentNoteId = null;
        if (!folderPath) { webviewView.webview.html = noFolderHtml(); return; }
        try {
          const res = await apiGet(secrets, '/notes', { folderPath });
          webviewView.webview.html = notesListHtml(projectName, res.data.data);
        } catch (e: unknown) {
          const err = e as { message?: string };
          if (err.message === 'NOT_AUTHENTICATED') { webviewView.webview.html = loginHtml(iconUri); }
          else { webviewView.webview.html = notesListHtml(projectName, [], true); }
        }
      }

      async function openNote(id: string) {
        const folderPath = getFolderPath();
        const projectName = folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? 'No project';
        currentNoteId = id;
        try {
          const res = await apiGet(secrets, `/notes/${id}`);
          const { bg, text } = getNoteColors();
          webviewView.webview.html = noteEditorHtml(res.data.data, projectName, bg, text);
        } catch { await showNotesList(); }
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
            if (!folderPath) {
              vscode.window.showWarningMessage('Open a folder first — NoteNest needs a project folder to save notes to.');
              break;
            }
            const projectName = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? 'Project';
            const title = await vscode.window.showInputBox({
              prompt: 'Note name', placeHolder: 'e.g. Ideas, TODO, Meeting Notes…', value: '',
            });
            if (title === undefined) { break; }
            try {
              const res = await apiPost(secrets, '/notes', { folderPath, title: title || 'Untitled', content: '', editorMode: 'wysiwyg' });
              currentNoteId = res.data.data.id;
              const { bg, text } = getNoteColors();
              webviewView.webview.html = noteEditorHtml(res.data.data, projectName, bg, text);
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
              // Select the full range from start line col 0 to end of end line
              const endLineText = doc.lineAt(Math.min(endLine, doc.lineCount - 1));
              const range = new vscode.Range(startLine, 0, endLineText.lineNumber, endLineText.text.length);
              editor.selection = new vscode.Selection(range.start, range.end);
              editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            } catch { vscode.window.showErrorMessage(`Could not open file: ${msg.file}`); }
            break;
          }

          case 'saveNote': {
            const folderPath = getFolderPath();
            const projectName = folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? 'Project';
            try {
              await apiPatch(secrets, `/notes/${msg.id}`, {
                title: msg.title,
                content: msg.content,
                editorMode: msg.editorMode,
                pinned: msg.pinned,
                tags: msg.tags,
                priority: msg.priority,
                status: msg.status,
              });
              if (msg.thenShowList) {
                await showNotesList();
              } else if (currentNoteId === msg.id) {
                // Send saved confirmation back to webview
                webviewView.webview.postMessage({ type: 'saved' });
              }
            } catch (e: unknown) {
              const err = e as { message?: string };
              if (err.message === 'NOT_AUTHENTICATED') { webviewView.webview.html = loginHtml(iconUri); }
              // else offline — ignore
            }
            break;
          }

          case 'deleteNote': {
            const ok = await vscode.window.showWarningMessage(
              'Delete this note? This cannot be undone.', { modal: true }, 'Delete');
            if (ok === 'Delete') {
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

      render();
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('notenest.notesView', provider)
  );

  // ── Annotation highlight decoration — persistent coloured highlight on annotated lines
  const annotationDecoration = vscode.window.createTextEditorDecorationType({
    // Subtle blue-left-border highlight, like a git blame marker
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

  // Cache: file relPath -> notes with annotations for that file
  const annotationCache = new Map<string, NoteItem[]>();

  async function refreshAnnotations(editor: vscode.TextEditor) {
    const folderPath = getFolderPath();
    if (!folderPath) { return; }
    const relPath = editor.document.uri.fsPath
      .replace(folderPath + '/', '')
      .replace(folderPath + '\\', '');
    try {
      const res = await apiGet(secrets, '/notes', { folderPath });
      const notes: NoteItem[] = res.data.data;
      const annotated = notes.filter(n => n.filePath === relPath && n.lineStart != null);
      // Update cache for hover provider
      annotationCache.set(relPath, annotated);
      // Apply highlight decorations covering the full annotated range
      const decorations = annotated.map(n => {
        const startLine = Math.max(0, (n.lineStart ?? 1) - 1);
        const endLine = Math.max(0, (n.lineEnd ?? n.lineStart ?? 1) - 1);
        const endLineText = editor.document.lineAt(Math.min(endLine, editor.document.lineCount - 1));
        return { range: new vscode.Range(startLine, 0, endLineText.lineNumber, endLineText.text.length) };
      });
      editor.setDecorations(annotationDecoration, decorations);
    } catch { /* offline or not authed */ }
  }

  // ── Hover provider — shows note popup when hovering annotated lines ─────────
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
          const notes = annotationCache.get(relPath) ?? [];
          // Find a note whose range covers the hovered line
          const hovered = notes.find(n => {
            const startLine = Math.max(0, (n.lineStart ?? 1) - 1);
            const endLine = Math.max(0, (n.lineEnd ?? n.lineStart ?? 1) - 1);
            return position.line >= startLine && position.line <= endLine;
          });
          if (!hovered) { return; }

          // Extract plain text preview
          let preview = '';
          if (hovered.editorMode === 'wysiwyg') {
            try { preview = JSON.parse(hovered.content)?.ops?.map((op: {insert?: unknown}) => typeof op.insert === 'string' ? op.insert : '').join(''); }
            catch { preview = hovered.content; }
          } else {
            preview = hovered.content.replace(/[#*_`]/g, '');
          }
          preview = preview.replace(/\n/g, ' ').trim().slice(0, 150);

          const priorityLabel = hovered.priority !== 'none' ? ` \u2022 ${hovered.priority}` : '';
          const statusLabel = hovered.status === 'done' ? ' ✓ Done' : hovered.status === 'passed' ? ' ✓ Passed' : ' ● Open';

          const md = new vscode.MarkdownString('', true);
          md.isTrusted = true;
          md.supportHtml = true;
          md.appendMarkdown(`**📎 ${hovered.title}**`);
          md.appendMarkdown(`\n\n_${statusLabel}${priorityLabel}_`);
          if (preview) { md.appendMarkdown(`\n\n${preview}`); }
          // Clickable command link to open the note
          const openCmd = vscode.Uri.parse(
            `command:notenest.openNoteById?${encodeURIComponent(JSON.stringify({ id: hovered.id }))}`
          );
          md.appendMarkdown(`\n\n[Open note →](${openCmd})`);

          const startLine = Math.max(0, (hovered.lineStart ?? 1) - 1);
          const endLine = Math.max(0, (hovered.lineEnd ?? hovered.lineStart ?? 1) - 1);
          const endLineText = document.lineAt(Math.min(endLine, document.lineCount - 1));
          return new vscode.Hover(md, new vscode.Range(startLine, 0, endLineText.lineNumber, endLineText.text.length));
        },
      }
    )
  );

  // ── openNoteById command — called from hover popup "Open note" link ───────
  // Opens the note directly in the sidebar — works regardless of which view is active.
  context.subscriptions.push(
    vscode.commands.registerCommand('notenest.openNoteById', async ({ id }: { id: string }) => {
      // Focus the NoteNest sidebar panel first
      await vscode.commands.executeCommand('notenest.notesView.focus');
      // Fetch the note and render it directly — don’t go through webview messaging
      const folderPath = getFolderPath();
      const projectName = folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? 'Project';
      try {
        const res = await apiGet(secrets, `/notes/${id}`);
        const { bg, text } = getNoteColors();
        if (panel) {
          currentNoteId = id;
          panel.webview.html = noteEditorHtml(res.data.data, projectName, bg, text);
        }
      } catch {
        vscode.window.showErrorMessage('Could not open note.');
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) { refreshAnnotations(editor); }
    })
  );
  if (vscode.window.activeTextEditor) {
    refreshAnnotations(vscode.window.activeTextEditor);
  }

  // Also refresh when documents are saved (notes may have changed)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
      if (editor) { refreshAnnotations(editor); }
    })
  );

  // Expose refreshAnnotations so runAnnotate can call it after saving
  async function refreshGutterDecorations(editor: vscode.TextEditor) {
    await refreshAnnotations(editor);
  }

  // ── Inline selection decoration — shows shortcut hint at end of selected line
  const selectionDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '  NoteNest ⌘⇧N to annotate',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      margin: '0 0 0 12px',
      fontStyle: 'italic',
      fontWeight: '400',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  // ── Status bar button — clickable, appears instantly on selection ─────────
  const annotateStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 1000
  );
  annotateStatusBarItem.text = '📎 Annotate selection';
  annotateStatusBarItem.tooltip = 'Add a NoteNest note to the selected code — or press ⌘⇧N';
  annotateStatusBarItem.command = 'notenest.annotateSelectionFromStatusBar';
  annotateStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  context.subscriptions.push(annotateStatusBarItem);

  // Saved selection snapshot — captured before status bar click clears it
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

      // Debounce slightly so it doesn't flash while dragging to select
      selectionDecorationTimer = setTimeout(() => {
        if (editor.selection.isEmpty) {
          editor.setDecorations(selectionDecoration, []);
          annotateStatusBarItem.hide();
          savedSelection = null;
          savedEditorUri = null;
          return;
        }
        // ✓ Snapshot the selection NOW before any click can clear it
        savedSelection = new vscode.Selection(editor.selection.start, editor.selection.end);
        savedEditorUri = editor.document.uri;
        // Show inline decoration at end of selected line
        const endPos = editor.selection.end;
        const endLine = editor.document.lineAt(endPos.line);
        const decorationRange = new vscode.Range(
          endPos.line, endLine.range.end.character,
          endPos.line, endLine.range.end.character
        );
        editor.setDecorations(selectionDecoration, [{ range: decorationRange }]);
        // Show clickable status bar button
        annotateStatusBarItem.show();
      }, 150);
    })
  );

  // ── CodeAction provider — also shows in lightbulb for keyboard users ────────
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      {
        provideCodeActions(document, range) {
          if (range.isEmpty) { return []; }
          const action = new vscode.CodeAction(
            '📎 NoteNest: Annotate this selection',
            vscode.CodeActionKind.Empty
          );
          action.command = {
            command: 'notenest.annotateSelection',
            title: '📎 NoteNest: Annotate this selection',
          };
          return [action];
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.Empty] }
    )
  );

  // ── Shared annotate logic ─────────────────────────────────────────────────
  async function runAnnotate(docUri: vscode.Uri, selection: vscode.Selection) {
    const folderPath = getFolderPath();
    if (!folderPath) {
      vscode.window.showWarningMessage('Open a folder first to use NoteNest annotations.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(docUri);
    const codeSnippet = doc.getText(selection);
    const relPath = docUri.fsPath
      .replace(folderPath + '/', '')
      .replace(folderPath + '\\', '');
    const lineStart = selection.start.line + 1;
    const lineEnd = selection.end.line + 1;

    const title = await vscode.window.showInputBox({
      prompt: `Annotate ${relPath}:${lineStart}–${lineEnd}`,
      placeHolder: 'Note title…',
    });
    if (title === undefined) { return; }

    const content = await vscode.window.showInputBox({
      prompt: 'Note content (optional)',
      placeHolder: 'What do you want to remember about this code?',
    });
    if (content === undefined) { return; }

    try {
      const { accessToken } = await getTokens(secrets);
      if (!accessToken) { vscode.window.showErrorMessage('Sign in to NoteNest first.'); return; }
      await apiPost(secrets, '/notes', {
        folderPath,
        title: title || 'Untitled annotation',
        content: content || '',
        editorMode: 'markdown',
        filePath: relPath,
        lineStart,
        lineEnd,
        codeSnippet: codeSnippet.slice(0, 500),
      });
      vscode.window.showInformationMessage(`📎 Annotation saved for ${relPath}:${lineStart}`);
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) { refreshGutterDecorations(activeEditor); }
      if (panel) { await vscode.commands.executeCommand('notenest.notesView.focus'); }
      // Clear the saved snapshot
      savedSelection = null;
      savedEditorUri = null;
    } catch { vscode.window.showErrorMessage('Failed to save annotation.'); }
  }

  // ── Status bar command — uses saved snapshot (selection already gone by click time) ─
  context.subscriptions.push(
    vscode.commands.registerCommand('notenest.annotateSelectionFromStatusBar', async () => {
      if (!savedSelection || !savedEditorUri) {
        vscode.window.showWarningMessage('Select some code first, then click Annotate.');
        return;
      }
      await runAnnotate(savedEditorUri, savedSelection);
    })
  );

  // ── Annotate selection command (keyboard shortcut / right-click) ────────────
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand('notenest.annotateSelection', async (editor) => {
      // Use live selection (keyboard / right-click); fall back to snapshot if empty
      let selection = editor.selection;
      let docUri = editor.document.uri;
      if (selection.isEmpty && savedSelection && savedEditorUri) {
        selection = savedSelection;
        docUri = savedEditorUri;
      }
      if (selection.isEmpty) {
        vscode.window.showWarningMessage('Select some code first, then run Annotate with NoteNest.');
        return;
      }
      await runAnnotate(docUri, selection);
    })
  );

  // ── Git hook installer ─────────────────────────────────────────────────────
  async function installGitHook(folderPath: string) {
    const fs = require('fs');
    const pathMod = require('path');
    const hookDir = pathMod.join(folderPath, '.git', 'hooks');
    const hookPath = pathMod.join(hookDir, 'pre-commit');

    // Only install if .git exists
    if (!fs.existsSync(pathMod.join(folderPath, '.git'))) { return; }
    if (!fs.existsSync(hookDir)) { fs.mkdirSync(hookDir, { recursive: true }); }

    const hookScript = [
      '#!/bin/sh',
      '# NoteNest pre-commit check — auto-installed by NoteNest VS Code extension',
      '# Safe to remove if you uninstall NoteNest. Does nothing if config not found.',
      '# Tokens are stored in ~/.notenest/tokens.json (never in this project).',
      'NOTENEST_PROJECT_CONFIG=".notenest/config.json"',
      'NOTENEST_HOME_CONFIG="$HOME/.notenest/tokens.json"',
      '# Skip if either config is missing',
      'if [ ! -f "$NOTENEST_PROJECT_CONFIG" ] || [ ! -f "$NOTENEST_HOME_CONFIG" ]; then exit 0; fi',
      'FOLDER=$(pwd)',
      '# Read API url and refresh token from home config (no tokens in project)',
      'API=$(node -e "try{const c=require(process.env.HOME+\'/.notenest/tokens.json\');process.stdout.write(c.apiUrl||\'https://vsnotes-backend.onrender.com\');}catch(e){process.stdout.write(\'https://vsnotes-backend.onrender.com\')}" 2>/dev/null)',
      'REFRESH_TOKEN=$(node -e "try{const c=require(process.env.HOME+\'/.notenest/tokens.json\');process.stdout.write(c.refreshToken||\'\');}catch(e){}" 2>/dev/null)',
      'if [ -z "$REFRESH_TOKEN" ]; then exit 0; fi',
      '# Get a fresh access token using the refresh token',
      'TOKEN=$(REFRESH_TOKEN="$REFRESH_TOKEN" API="$API" node -e "',
      'const https=require(\'https\');',
      'const body=JSON.stringify({refreshToken:process.env.REFRESH_TOKEN});',
      'const url=new URL(process.env.API+\'/auth/refresh\');',
      'const opts={hostname:url.hostname,port:url.port||443,path:url.pathname,method:\'POST\',headers:{\'Content-Type\':\'application/json\',\'Content-Length\':\'\'+Buffer.byteLength(body)}};',
      'const req=https.request(opts,res=>{let d=\'\';res.on(\'data\',c=>d+=c);res.on(\'end\',()=>{try{const r=JSON.parse(d);process.stdout.write(r.data&&r.data.accessToken?r.data.accessToken:\'\');}catch(e){}});});',
      'req.on(\'error\',()=>{});req.write(body);req.end();',
      '" 2>/dev/null)',
      'if [ -z "$TOKEN" ]; then exit 0; fi',
      '# Check for blocking notes',
      'ENCODED_FOLDER=$(node -e "process.stdout.write(encodeURIComponent(\'$FOLDER\'))" 2>/dev/null)',
      'RESULT=$(curl -sf -H "Authorization: Bearer $TOKEN" "$API/notes/blocking?folderPath=$ENCODED_FOLDER" 2>/dev/null)',
      'if [ $? -ne 0 ]; then exit 0; fi',
      'BLOCKED=$(node -e "try{const r=JSON.parse(process.argv[1]);if(r.blocked){console.log(\'BLOCKED\');r.data.forEach(n=>console.log(\'  • \'+n.title+(n.priority!==\'none\'?\' [\'+n.priority+\']\':\'\')));}}catch(e){}" "$RESULT" 2>/dev/null)',
      'if echo "$BLOCKED" | grep -q "BLOCKED"; then',
      '  echo ""',
      '  echo "❌ NoteNest: Open notes are blocking this commit:"',
      '  echo "$BLOCKED" | grep -v "BLOCKED"',
      '  echo ""',
      '  echo "Mark them as done in VS Code (NoteNest sidebar → change status to Done) then try again."',
      '  echo ""',
      '  exit 1',
      'fi',
      'exit 0',
    ].join('\n');

    if (fs.existsSync(hookPath)) {
      const existing = fs.readFileSync(hookPath, 'utf8');
      if (existing.includes('NoteNest pre-commit check')) {
        // Already installed — replace it with the latest version
        const withoutOld = existing.replace(/\n*# NoteNest pre-commit check[\s\S]*?exit 0\s*$/, '').trimEnd();
        fs.writeFileSync(hookPath, withoutOld ? withoutOld + '\n\n' + hookScript : hookScript);
      } else {
        // Append to existing hook
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

    // ── 1. Store tokens in ~/.notenest/tokens.json (home dir, NOT in project) ──
    // This keeps credentials completely away from project linters and scanners.
    const homeConfigDir = pathMod.join(os.homedir(), '.notenest');
    const homeConfigPath = pathMod.join(homeConfigDir, 'tokens.json');
    if (!fs.existsSync(homeConfigDir)) { fs.mkdirSync(homeConfigDir, { recursive: true }); }
    fs.writeFileSync(homeConfigPath, JSON.stringify({
      apiUrl: getApiUrl(),
      refreshToken: refreshToken || '',
    }, null, 2), { mode: 0o600 }); // 600 = owner read/write only

    // ── 2. Write a minimal project-level marker (no tokens, no URL) ──────────
    // This just tells the hook that NoteNest is active for this project.
    const projectConfigDir = pathMod.join(folderPath, '.notenest');
    const projectConfigPath = pathMod.join(projectConfigDir, 'config.json');
    if (!fs.existsSync(projectConfigDir)) { fs.mkdirSync(projectConfigDir, { recursive: true }); }
    fs.writeFileSync(projectConfigPath, JSON.stringify({ folderPath }, null, 2));

    // ── 3. Ensure .notenest/ is gitignored ────────────────────────────────────
    const gitignorePath = pathMod.join(folderPath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gi = fs.readFileSync(gitignorePath, 'utf8');
      if (!gi.includes('.notenest')) {
        fs.appendFileSync(gitignorePath, '\n# NoteNest (local only, not for version control)\n.notenest/\n');
      }
    } else {
      fs.writeFileSync(gitignorePath, '# NoteNest (local only, not for version control)\n.notenest/\n');
    }
  }

  // Install hook and write config when a folder is open
  const currentFolder = getFolderPath();
  if (currentFolder) {
    writeNoteNestConfig(currentFolder).then(() => installGitHook(currentFolder)).catch(() => {});
  }
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
    vscode.window.showInformationMessage('Complete sign-in in your browser. Waiting…');
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const { data: td } = await axios.get(`${apiUrl}/auth/extension/token`, { params: { state } });
        if (td.success && td.data.ready) {
          await setTokens(secrets, td.data.tokens.accessToken, td.data.tokens.refreshToken);
          await secrets.store('user', JSON.stringify(td.data.user));
          vscode.window.showInformationMessage(`✅ Logged in as ${td.data.user.name}`);
          onSuccess(); return;
        }
      } catch { /* keep polling */ }
    }
    vscode.window.showErrorMessage('Login timed out. Please try again.');
  } catch { vscode.window.showErrorMessage('Could not connect to NoteNest API.'); }
}

export function deactivate() {}
