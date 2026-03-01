import * as vscode from 'vscode';
import axios from 'axios';
import { randomBytes } from 'crypto';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getApiUrl(): string {
  return vscode.workspace.getConfiguration('projectnotes').get('apiUrl', 'http://localhost:3001');
}

function getFolderPath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function getTokens(secrets: vscode.SecretStorage) {
  const access = await secrets.get('accessToken');
  const refresh = await secrets.get('refreshToken');
  return { accessToken: access || null, refreshToken: refresh || null };
}
async function setTokens(secrets: vscode.SecretStorage, access: string, refresh: string) {
  await secrets.store('accessToken', access);
  await secrets.store('refreshToken', refresh);
}
async function clearTokens(secrets: vscode.SecretStorage) {
  await secrets.delete('accessToken');
  await secrets.delete('refreshToken');
  await secrets.delete('user');
}
async function refreshAccessToken(secrets: vscode.SecretStorage): Promise<string | null> {
  const { refreshToken } = await getTokens(secrets);
  if (!refreshToken) { return null; }
  try {
    const { data } = await axios.post(`${getApiUrl()}/auth/refresh`, { refreshToken });
    if (data.success) {
      await setTokens(secrets, data.data.accessToken, data.data.refreshToken);
      return data.data.accessToken;
    }
  } catch { /* expired */ }
  return null;
}

async function makeRequest<T>(secrets: vscode.SecretStorage, fn: (token: string) => Promise<T>): Promise<T> {
  let { accessToken } = await getTokens(secrets);
  if (!accessToken) { accessToken = await refreshAccessToken(secrets); }
  if (!accessToken) { throw new Error('NOT_AUTHENTICATED'); }
  try {
    return await fn(accessToken);
  } catch (e: unknown) {
    if ((e as { response?: { status?: number } })?.response?.status === 401) {
      accessToken = await refreshAccessToken(secrets);
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

interface NoteItem { id: string; title: string; content: string; updatedAt: string; }

// ── Color palette ─────────────────────────────────────────────────────────────

const BG_COLORS: { label: string; bg: string; text: string }[] = [
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

// ── HTML builders ─────────────────────────────────────────────────────────────

function loginHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <style>
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:20px;margin:0}
    h2{margin-bottom:8px;font-size:16px}p{font-size:13px;color:var(--vscode-descriptionForeground);margin-bottom:20px;line-height:1.5}
    button{width:100%;padding:8px 16px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:13px}
    button:hover{background:var(--vscode-button-hoverBackground)}.logo{font-size:32px;margin-bottom:12px}
  </style></head><body>
  <div class="logo">📝</div><h2>ProjectNotes</h2>
  <p>Sign in to keep per-project notes that sync across all your machines.</p>
  <button id="b">Sign in / Sign up</button>
  <script>const vscode=acquireVsCodeApi();document.getElementById('b').addEventListener('click',()=>vscode.postMessage({type:'startLogin'}));</script>
  </body></html>`;
}

function settingsHtml(autoShow: boolean, noteBgColor: string): string {
  const swatches = BG_COLORS.map(c => `
    <div class="swatch ${c.bg === noteBgColor ? 'active' : ''}" data-bg="${c.bg}" data-text="${c.text}"
      style="background:${c.bg};border:2px solid ${c.bg === noteBgColor ? '#6c8ef5' : 'transparent'}" title="${c.label}">
      ${c.bg === noteBgColor ? '<span class="check">✓</span>' : ''}
    </div>`).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <style>
    *{box-sizing:border-box}
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:16px;margin:0}
    h2{font-size:14px;margin-bottom:16px}
    .section-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--vscode-descriptionForeground);margin:16px 0 8px}
    .row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
    label{font-size:13px}
    .back{background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;font-size:12px;padding:0;margin-bottom:14px}
    .swatches{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
    .swatch{width:100%;aspect-ratio:1;border-radius:6px;cursor:pointer;position:relative;display:flex;align-items:center;justify-content:center;transition:transform 0.1s}
    .swatch:hover{transform:scale(1.08)}
    .swatch.active{border-color:#6c8ef5 !important}
    .check{font-size:14px;color:#6c8ef5;font-weight:bold;text-shadow:0 0 4px rgba(0,0,0,0.5)}
    .logout{margin-top:20px;width:100%;padding:7px;background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-errorForeground);border:1px solid var(--vscode-inputValidation-errorBorder);border-radius:4px;cursor:pointer;font-size:12px}
  </style></head><body>
  <button class="back" id="bk">← Back</button>
  <h2>Settings</h2>
  <div class="row"><label>Auto-show on project open</label><input type="checkbox" id="as" ${autoShow ? 'checked' : ''}/></div>
  <div class="section-label">Note background colour</div>
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

function notesListHtml(projectName: string, notes: NoteItem[], offline?: boolean): string {
  const items = notes.map(n => {
    const date = new Date(n.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const safeTitle = n.title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const preview = (n.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, ' ').slice(0, 55);
    return `<div class="note-row" data-id="${n.id}">
      <div class="note-main">
        <div class="note-header"><span class="note-title">${safeTitle}</span><span class="note-date">${date}</span></div>
        <div class="note-preview">${preview || '<span class="dim">Empty note</span>'}</div>
      </div>
      <button class="del-btn" data-id="${n.id}" title="Delete">✕</button>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <style>
    *{box-sizing:border-box}
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:0;margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden}
    .toolbar{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
    .project-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}
    .toolbar-right{display:flex;align-items:center;gap:2px}
    .icon-btn{background:none;border:none;cursor:pointer;color:var(--vscode-foreground);opacity:0.65;font-size:15px;padding:3px 6px;border-radius:3px;line-height:1}
    .icon-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}
    .offline-banner{padding:6px 10px;background:var(--vscode-inputValidation-warningBackground);font-size:11px;flex-shrink:0}
    .notes-list{flex:1;overflow-y:auto;padding:4px 0}
    .note-row{display:flex;align-items:center;padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--vscode-panel-border);gap:6px}
    .note-row:hover{background:var(--vscode-list-hoverBackground)}
    .note-main{flex:1;min-width:0}
    .note-header{display:flex;justify-content:space-between;align-items:baseline;gap:6px;margin-bottom:2px}
    .note-title{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .note-date{font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;flex-shrink:0}
    .note-preview{font-size:11px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .dim{opacity:0.4;font-style:italic}
    .del-btn{background:none;border:none;cursor:pointer;color:var(--vscode-errorForeground);opacity:0;font-size:11px;padding:2px 4px;border-radius:2px;flex-shrink:0}
    .note-row:hover .del-btn{opacity:0.5}.del-btn:hover{opacity:1 !important;background:var(--vscode-inputValidation-errorBackground)}
    .empty{padding:40px 20px;text-align:center;font-size:13px;color:var(--vscode-descriptionForeground);line-height:1.8}
  </style></head><body>
  <div class="toolbar">
    <span class="project-name" title="${projectName}">${projectName}</span>
    <div class="toolbar-right">
      <button class="icon-btn" id="newBtn" title="New note">+</button>
      <button class="icon-btn" id="settingsBtn" title="Settings">⚙</button>
    </div>
  </div>
  ${offline ? '<div class="offline-banner">⚠ Offline — changes won\'t save</div>' : ''}
  <div class="notes-list">
    ${items}
    ${notes.length === 0 ? '<div class="empty">No notes yet.<br/>Press <strong>+</strong> to create one.</div>' : ''}
  </div>
  <script>
    const vscode=acquireVsCodeApi();
    document.getElementById('newBtn').addEventListener('click',()=>vscode.postMessage({type:'newNote'}));
    document.getElementById('settingsBtn').addEventListener('click',()=>vscode.postMessage({type:'openSettings'}));
    document.querySelectorAll('.note-row').forEach(row=>{
      row.addEventListener('click',e=>{if(e.target.classList.contains('del-btn'))return;vscode.postMessage({type:'openNote',id:row.dataset.id});});
    });
    document.querySelectorAll('.del-btn').forEach(btn=>{
      btn.addEventListener('click',e=>{e.stopPropagation();vscode.postMessage({type:'deleteNote',id:btn.dataset.id});});
    });
  </script></body></html>`;
}

function noteEditorHtml(note: NoteItem, projectName: string, bgColor: string, textColor: string, saved?: boolean): string {
  const safeContent = (note.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeTitle = (note.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
  <style>
    *{box-sizing:border-box}
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:0;margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden}
    .toolbar{display:flex;align-items:center;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;gap:6px}
    .back-btn{background:none;border:none;cursor:pointer;color:var(--vscode-textLink-foreground);font-size:12px;padding:0;white-space:nowrap;flex-shrink:0}
    .title-input{flex:1;background:transparent;border:none;color:var(--vscode-foreground);font-size:12px;font-weight:600;outline:none;min-width:0;font-family:var(--vscode-font-family)}
    .title-input::placeholder{color:var(--vscode-input-placeholderForeground)}
    .status{font-size:11px;color:#4caf50;white-space:nowrap;flex-shrink:0;transition:opacity 0.3s}
    textarea{flex:1;width:100%;padding:12px;background:${bgColor};color:${textColor};border:none;resize:none;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,13px);line-height:1.7;outline:none}
    textarea::placeholder{color:${textColor};opacity:0.35}
  </style></head><body>
  <div class="toolbar">
    <button class="back-btn" id="backBtn">← ${projectName}</button>
    <input class="title-input" id="titleInput" value="${safeTitle}" placeholder="Note title…"/>
    <span class="status" id="status" style="opacity:${saved ? 1 : 0}">✓ Saved</span>
  </div>
  <textarea id="noteArea" placeholder="Start writing…">${safeContent}</textarea>
  <script>
    const vscode=acquireVsCodeApi();
    const noteId="${note.id}";
    let saveTimer=null;
    function scheduleSave(){
      clearTimeout(saveTimer);
      saveTimer=setTimeout(doSave,800);
    }
    function doSave(){
      vscode.postMessage({type:'saveNote',id:noteId,title:document.getElementById('titleInput').value,content:document.getElementById('noteArea').value});
    }
    document.getElementById('titleInput').addEventListener('input',scheduleSave);
    document.getElementById('noteArea').addEventListener('input',scheduleSave);
    document.addEventListener('keydown',e=>{
      if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();clearTimeout(saveTimer);doSave();}
    });
    const titleEl=document.getElementById('titleInput');
    if(titleEl.value==='Untitled'){titleEl.focus();titleEl.select();}
    document.getElementById('backBtn').addEventListener('click',()=>{
      clearTimeout(saveTimer);
      vscode.postMessage({type:'saveNote',id:noteId,title:titleEl.value,content:document.getElementById('noteArea').value,thenShowList:true});
    });
  </script></body></html>`;
}

// ── Extension Entry Point ─────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  const secrets = context.secrets;
  let panel: vscode.WebviewView | undefined;
  let currentNoteId: string | null = null;

  function getNoteColors(): { bg: string; text: string } {
    const config = vscode.workspace.getConfiguration('projectnotes');
    return {
      bg: config.get('noteBgColor', '#1e1e1e'),
      text: config.get('noteTextColor', '#d4d4d4'),
    };
  }

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(webviewView) {
      panel = webviewView;
      webviewView.webview.options = { enableScripts: true };

      async function render() {
        const { accessToken } = await getTokens(secrets);
        if (!accessToken && !(await refreshAccessToken(secrets))) {
          webviewView.webview.html = loginHtml(); return;
        }
        await showNotesList();
      }

      async function showNotesList() {
        const folderPath = getFolderPath();
        const projectName = folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? 'No project';
        currentNoteId = null;
        if (!folderPath) { webviewView.webview.html = notesListHtml('No folder open', []); return; }
        try {
          const res = await apiGet(secrets, '/notes', { folderPath });
          webviewView.webview.html = notesListHtml(projectName, res.data.data);
        } catch (e: unknown) {
          const err = e as { message?: string };
          if (err.message === 'NOT_AUTHENTICATED') { webviewView.webview.html = loginHtml(); }
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

          case 'newNote': {
            const folderPath = getFolderPath();
            if (!folderPath) { break; }
            const projectName = folderPath.split(/[\\/]/).filter(Boolean).pop() ?? 'Project';
            const title = await vscode.window.showInputBox({ prompt: 'Note name', placeHolder: 'e.g. Ideas, TODO, Meeting Notes…', value: '' });
            if (title === undefined) { break; }
            try {
              const res = await apiPost(secrets, '/notes', { folderPath, title: title || 'Untitled', content: '' });
              currentNoteId = res.data.data.id;
              const { bg, text } = getNoteColors();
              webviewView.webview.html = noteEditorHtml(res.data.data, projectName, bg, text);
            } catch { vscode.window.showErrorMessage('Failed to create note. Is the server running?'); }
            break;
          }

          case 'openNote': await openNote(msg.id); break;

          case 'saveNote': {
            const folderPath = getFolderPath();
            const projectName = folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? 'Project';
            try {
              const res = await apiPatch(secrets, `/notes/${msg.id}`, { title: msg.title, content: msg.content });
              if (msg.thenShowList) {
                await showNotesList();
              } else if (currentNoteId === msg.id) {
                const { bg, text } = getNoteColors();
                webviewView.webview.html = noteEditorHtml(res.data.data, projectName, bg, text, true);
                setTimeout(() => {
                  if (currentNoteId === msg.id) {
                    webviewView.webview.html = noteEditorHtml(res.data.data, projectName, bg, text, false);
                  }
                }, 2000);
              }
            } catch { /* offline – ignore */ }
            break;
          }

          case 'deleteNote': {
            const ok = await vscode.window.showWarningMessage('Delete this note? This cannot be undone.', { modal: true }, 'Delete');
            if (ok === 'Delete') {
              try { await apiDelete(secrets, `/notes/${msg.id}`); } catch { /* ignore */ }
              await showNotesList();
            }
            break;
          }

          case 'openSettings': {
            const config = vscode.workspace.getConfiguration('projectnotes');
            webviewView.webview.html = settingsHtml(
              config.get('autoShow', true),
              config.get('noteBgColor', '#1e1e1e')
            );
            break;
          }

          case 'setSetting': {
            const config = vscode.workspace.getConfiguration('projectnotes');
            if (msg.key === 'autoShow') { await config.update('autoShow', msg.value, vscode.ConfigurationTarget.Global); }
            if (msg.key === 'noteBgColor') {
              await config.update('noteBgColor', msg.value, vscode.ConfigurationTarget.Global);
              await config.update('noteTextColor', msg.textColor, vscode.ConfigurationTarget.Global);
            }
            break;
          }

          case 'logout':
            await clearTokens(secrets);
            webviewView.webview.html = loginHtml();
            break;
        }
      });

      render();
    },
  };

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('projectnotes.notesView', provider));
  context.subscriptions.push(
    vscode.commands.registerCommand('projectnotes.openNotes', () => vscode.commands.executeCommand('projectnotes.notesView.focus')),
    vscode.commands.registerCommand('projectnotes.logout', async () => {
      await clearTokens(secrets);
      if (panel) { panel.webview.html = loginHtml(); }
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      const config = vscode.workspace.getConfiguration('projectnotes');
      if (config.get('autoShow', true)) { vscode.commands.executeCommand('projectnotes.notesView.focus'); }
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
  } catch { vscode.window.showErrorMessage('Could not connect to ProjectNotes API. Is the server running?'); }
}

export function deactivate() {}
