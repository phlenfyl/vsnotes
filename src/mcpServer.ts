/**
 * mcpServer.ts
 * Local HTTP server inside the NoteVs VS Code extension.
 * folderPath resolution order:
 *   1. args.folderPath (agent passes its cwd — most accurate)
 *   2. vscode.workspace.workspaceFolders[0] (fallback to whatever VS Code has open)
 */

import * as http from 'http';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

export const MCP_PORT = 37492;

/** Callback fired whenever notes are mutated via MCP (create/save/delete/annotate). */
export type OnNoteMutated = () => void;

interface NoteItem {
  id: string; title: string; content: string;
  updatedAt: string; pinned: boolean; tags: string[]; editorMode: string;
  priority: string; status: string;
  filePath?: string; lineStart?: number; lineEnd?: number; codeSnippet?: string;
  annotations?: Annotation[];
  localId?: string; createdAt?: string; folderPath?: string;
  deletedAt?: string | null; syncedAt?: string | null;
}

interface Annotation {
  id: string; noteId: string;
  filePath: string; lineStart: number; lineEnd: number;
  codeSnippet?: string; comment: string; status: string;
  createdAt: string; updatedAt: string;
}

interface LocalMeta {
  version: number;
  noteIndex: Array<{ id: string; title: string; updatedAt: string; folderPath: string }>;
}

// ── Local storage helpers ─────────────────────────────────────────────────────

function getNotesDir(storagePath: string): string { return path.join(storagePath, 'notes'); }
function getMetaPath(storagePath: string): string { return path.join(storagePath, 'meta.json'); }
function ensureLocalDirs(storagePath: string): void { const d = getNotesDir(storagePath); if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); } }

function readLocalMeta(storagePath: string): LocalMeta {
  try { if (fs.existsSync(getMetaPath(storagePath))) { return JSON.parse(fs.readFileSync(getMetaPath(storagePath), 'utf8')) as LocalMeta; } } catch { /* corrupt */ }
  return { version: 1, noteIndex: [] };
}

function writeLocalMeta(storagePath: string, meta: LocalMeta): void {
  fs.writeFileSync(getMetaPath(storagePath), JSON.stringify(meta, null, 2), 'utf8');
}

function readLocalNote(storagePath: string, id: string): NoteItem | null {
  const p = path.join(getNotesDir(storagePath), `${id}.json`);
  try { if (fs.existsSync(p)) { return JSON.parse(fs.readFileSync(p, 'utf8')) as NoteItem; } } catch { /* corrupt */ }
  return null;
}

function writeLocalNote(storagePath: string, note: NoteItem): void {
  ensureLocalDirs(storagePath);
  fs.writeFileSync(path.join(getNotesDir(storagePath), `${note.id}.json`), JSON.stringify(note, null, 2), 'utf8');
  const meta = readLocalMeta(storagePath);
  const entry = { id: note.id, title: note.title, updatedAt: note.updatedAt, folderPath: note.folderPath || '' };
  const idx = meta.noteIndex.findIndex(e => e.id === note.id);
  if (idx !== -1) { meta.noteIndex[idx] = entry; } else { meta.noteIndex.unshift(entry); }
  writeLocalMeta(storagePath, meta);
}

function deleteLocalNoteFromStorage(storagePath: string, id: string): void {
  const p = path.join(getNotesDir(storagePath), `${id}.json`);
  if (fs.existsSync(p)) { fs.unlinkSync(p); }
  const meta = readLocalMeta(storagePath);
  meta.noteIndex = meta.noteIndex.filter(e => e.id !== id);
  writeLocalMeta(storagePath, meta);
}

function readAllNotes(storagePath: string, folderPath: string): NoteItem[] {
  ensureLocalDirs(storagePath);
  const meta = readLocalMeta(storagePath);
  const notes: NoteItem[] = [];
  for (const entry of meta.noteIndex) {
    // Match the sidebar's monorepo behavior (readLocalNotesGrouped in
    // extension.ts): a workspace-root folderPath should also pick up notes
    // scoped to its subfolders, not just an exact match — otherwise a
    // monorepo's subfolder notes are invisible to MCP tools even though the
    // sidebar shows them right there grouped under the same workspace.
    if (entry.folderPath !== folderPath && !entry.folderPath.startsWith(folderPath + '/')) { continue; }
    const note = readLocalNote(storagePath, entry.id);
    if (note && !note.deletedAt) { notes.push(note); }
  }
  return notes.sort((a, b) => {
    if (a.pinned && !b.pinned) { return -1; }
    if (!a.pinned && b.pinned) { return 1; }
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

// ── Tool definitions ──────────────────────────────────────────────────────────

// folderPath is an optional arg on all tools so the agent can pass its cwd
const FOLDER_PATH_PROP = {
  folderPath: { type: 'string', description: 'Absolute path to the project folder. Pass process.cwd() from the agent. Falls back to the folder open in VS Code.' },
};

// ── Notion helpers (self-contained, no VS Code UI) ──────────────────────────

const NOTION_API_VERSION = '2022-06-28';

async function notionRequest(
  method: string,
  urlPath: string,
  token: string,
  body?: unknown,
): Promise<unknown> {
  const { data } = await axios({
    method,
    url: `https://api.notion.com/v1${urlPath}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_API_VERSION,
      'Content-Type': 'application/json',
    },
    data: body,
    timeout: 15000,
  });
  return data;
}

function noteToNotionBlocks(content: string, editorMode: string): unknown[] {
  const lines = (editorMode === 'markdown' ? content : (() => {
    try {
      const delta = JSON.parse(content);
      return (delta.ops ?? []).map((op: { insert?: unknown }) =>
        typeof op.insert === 'string' ? op.insert : '').join('');
    } catch { return content; }
  })()).split('\n').slice(0, 80);
  return lines.map(line => ({
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: line.slice(0, 2000) } }] },
  }));
}

async function exportNoteToNotion(
  secrets: vscode.SecretStorage,
  globalState: vscode.Memento,
  storagePath: string,
  noteId: string,
): Promise<{ pageId: string; pageUrl: string }> {
  const token = await secrets.get('notionToken');
  if (!token) { throw new Error('Notion token not configured. Connect Notion in Settings → Integrations → Exporting first.'); }

  const note = readLocalNote(storagePath, noteId);
  if (!note) { throw new Error(`Note not found: ${noteId}`); }

  // Resolve or pick parent page
  let parentPageId = globalState.get<string>('notevs.notionParentPageId', '');
  if (!parentPageId) {
    // Search for pages the integration can access
    const searchRes = await notionRequest('POST', '/search', token, { filter: { value: 'page', property: 'object' }, page_size: 10 }) as { results: Array<{ id: string; properties?: { title?: { title?: Array<{ plain_text?: string }> } } }> };
    const pages = searchRes.results ?? [];
    if (pages.length === 0) { throw new Error('No Notion pages found. Share at least one page with your NoteVs integration.'); }
    // Use first available page as parent
    parentPageId = pages[0].id;
    await globalState.update('notevs.notionParentPageId', parentPageId);
  }

  const existingPageId = note.exports?.notion?.pageId;

  if (existingPageId) {
    // Update existing page — archive old blocks then append new ones
    try {
      const blocksRes = await notionRequest('GET', `/blocks/${existingPageId}/children`, token) as { results: Array<{ id: string }> };
      for (const block of (blocksRes.results ?? [])) {
        await notionRequest('DELETE', `/blocks/${block.id}`, token).catch(() => {});
      }
    } catch { /* page may not exist any more */ }
    await notionRequest('PATCH', `/pages/${existingPageId}`, token, {
      properties: { title: { title: [{ type: 'text', text: { content: note.title.slice(0, 2000) } }] } },
    });
    await notionRequest('PATCH', `/blocks/${existingPageId}/children`, token, {
      children: noteToNotionBlocks(note.content, note.editorMode),
    });
    const pageUrl = `https://www.notion.so/${existingPageId.replace(/-/g, '')}`;
    const ts = new Date().toISOString();
    note.exports = { ...note.exports, notion: { ts, pageId: existingPageId, pageUrl } };
    writeLocalNote(storagePath, note);
    return { pageId: existingPageId, pageUrl };
  } else {
    // Create new page
    const created = await notionRequest('POST', '/pages', token, {
      parent: { page_id: parentPageId },
      properties: { title: { title: [{ type: 'text', text: { content: note.title.slice(0, 2000) } }] } },
      children: noteToNotionBlocks(note.content, note.editorMode),
    }) as { id: string; url: string };
    const pageUrl = created.url || `https://www.notion.so/${created.id.replace(/-/g, '')}`;
    const ts = new Date().toISOString();
    note.exports = { ...note.exports, notion: { ts, pageId: created.id, pageUrl } };
    writeLocalNote(storagePath, note);
    return { pageId: created.id, pageUrl };
  }
}

// ── Obsidian helpers (self-contained) ─────────────────────────────────────────

async function exportNoteToObsidian(
  secrets: vscode.SecretStorage,
  globalState: vscode.Memento,
  storagePath: string,
  noteId: string,
): Promise<{ filePath: string }> {
  const note = readLocalNote(storagePath, noteId);
  if (!note) { throw new Error(`Note not found: ${noteId}`); }

  // Extract plain text
  let mdContent: string;
  if (note.editorMode === 'markdown') {
    mdContent = note.content || '';
  } else {
    try {
      const delta = JSON.parse(note.content);
      mdContent = (delta.ops ?? []).map((op: { insert?: unknown }) =>
        typeof op.insert === 'string' ? op.insert : '').join('');
    } catch { mdContent = note.content || ''; }
  }

  const safeFilename = note.title.replace(/[/\\?%*:|"<>]/g, '-').trim() || 'untitled';

  // Try REST API first
  const apiKey = await secrets.get('obsidianApiKey');
  if (apiKey) {
    try {
      await axios.put(
        `http://127.0.0.1:27123/vault/${encodeURIComponent(safeFilename)}.md`,
        mdContent,
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'text/markdown' }, timeout: 8000 },
      );
      const ts = new Date().toISOString();
      note.exports = { ...note.exports, obsidian: ts };
      writeLocalNote(storagePath, note);
      return { filePath: `${safeFilename}.md` };
    } catch { /* fall through to vault folder */ }
  }

  // Fall back to direct vault folder write
  const vaultPath = globalState.get<string>('notevs.obsidianVaultPath', '');
  if (!vaultPath) { throw new Error('Obsidian not configured. Connect Obsidian in Settings → Integrations → Exporting first.'); }
  const outPath = path.join(vaultPath, `${safeFilename}.md`);
  fs.writeFileSync(outPath, mdContent, 'utf8');
  const ts = new Date().toISOString();
  note.exports = { ...note.exports, obsidian: ts };
  writeLocalNote(storagePath, note);
  return { filePath: outPath };
}

// ── Task reminder helper (headless, uses stored tokens) ───────────────────────

const TODOIST_API = 'https://api.todoist.com/api/v1';
const GOOGLE_TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

function mapPriorityToTodoist(priority: string): number {
  switch (priority) {
    case 'emergency': return 1;
    case 'urgent':    return 1;
    case 'important': return 2;
    case 'medium':    return 3;
    default:          return 4;
  }
}

async function setNoteReminder(
  secrets: vscode.SecretStorage,
  storagePath: string,
  noteId: string,
  dueDate: string,           // YYYY-MM-DD
  dueTime?: string | null,   // HH:MM optional
  provider?: string | null,  // 'todoist' | 'google' | auto-detect
): Promise<{ provider: string; taskId?: string; taskUrl?: string }> {
  const note = readLocalNote(storagePath, noteId);
  if (!note) { throw new Error(`Note not found: ${noteId}`); }

  // Validate date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new Error('dueDate must be in YYYY-MM-DD format');
  }

  const todoistToken = await secrets.get('todoistToken');
  const googleAccess  = await secrets.get('googleTasksAccessToken');

  const useProvider = (() => {
    if (provider === 'todoist') { return 'todoist'; }
    if (provider === 'google')  { return 'google'; }
    if (todoistToken)  { return 'todoist'; }
    if (googleAccess)  { return 'google'; }
    throw new Error('No task provider connected. Connect Todoist or Google Tasks in Settings → Integrations → Tasks first.');
  })();

  // Extract plain text for task description
  let description = '';
  if (note.editorMode === 'markdown') {
    description = (note.content || '').slice(0, 250);
  } else {
    try {
      const delta = JSON.parse(note.content);
      description = (delta.ops ?? []).map((op: { insert?: unknown }) =>
        typeof op.insert === 'string' ? op.insert : '').join('').slice(0, 250);
    } catch { description = (note.content || '').slice(0, 250); }
  }

  if (useProvider === 'todoist') {
    if (!todoistToken) { throw new Error('Todoist token not found. Connect Todoist in Settings first.'); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: Record<string, any> = {
      content:     note.title || 'Untitled',
      description,
      priority:    mapPriorityToTodoist(note.priority),
    };
    if (dueTime) {
      payload.due_datetime = `${dueDate}T${dueTime}:00`;
    } else {
      payload.due_date = dueDate;
    }
    const { data } = await axios.post(`${TODOIST_API}/tasks`, payload, {
      headers: { Authorization: `Bearer ${todoistToken}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    const taskId: string = data.id;
    const ts = new Date().toISOString();
    note.reminders = { ...note.reminders, todoist: { ts, due: dueTime ? `${dueDate}T${dueTime}` : dueDate, taskId } };
    writeLocalNote(storagePath, note);
    return { provider: 'todoist', taskId, taskUrl: `https://app.todoist.com/app/task/${taskId}` };
  } else {
    // Google Tasks — refresh token if needed
    const refreshToken = await secrets.get('googleTasksRefreshToken');
    const expiryStr    = await secrets.get('googleTasksExpiry');
    let accessToken = googleAccess;
    if (!accessToken || !refreshToken) { throw new Error('Google Tasks not connected. Connect in Settings first.'); }
    const expiry = expiryStr ? new Date(expiryStr).getTime() : 0;
    if (Date.now() >= expiry - 60_000) {
      // Refresh
      const GOOGLE_CLIENT_ID     = 'REDACTED_CLIENT_ID.apps.googleusercontent.com';
      const GOOGLE_CLIENT_SECRET = 'REDACTED_CLIENT_SECRET';
      const { data: refreshData } = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
      );
      accessToken = refreshData.access_token as string;
      const newExpiry = new Date(Date.now() + ((refreshData.expires_in as number) ?? 3600) * 1000).toISOString();
      await secrets.store('googleTasksAccessToken', accessToken);
      await secrets.store('googleTasksExpiry', newExpiry);
    }
    // Fetch first task list
    const { data: listsData } = await axios.get(`${GOOGLE_TASKS_API}/users/@me/lists`, {
      headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000,
    });
    const lists: Array<{ id: string }> = listsData.items ?? [];
    if (!lists.length) { throw new Error('No Google Tasks lists found.'); }
    const taskListId = lists[0].id;
    const { data: created } = await axios.post(
      `${GOOGLE_TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks`,
      { title: note.title || 'Untitled', notes: description, status: 'needsAction', due: `${dueDate}T00:00:00.000Z` },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 10000 },
    );
    const taskId: string = created.id;
    const ts = new Date().toISOString();
    note.reminders = { ...note.reminders, googleTasks: { ts, due: dueDate, taskId, taskListId } };
    writeLocalNote(storagePath, note);
    return { provider: 'google', taskId };
  }
}

export const TOOL_DEFINITIONS = [
  {
    name: 'notevs_list_notes',
    description: 'List all NoteVs notes for the given project folder (or the folder currently open in VS Code).',
    inputSchema: { type: 'object', properties: { ...FOLDER_PATH_PROP }, required: [] },
  },
  {
    name: 'notevs_get_note',
    description: 'Get the full content of a note by its id, including all annotations.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The note id (from notevs_list_notes)' } }, required: ['id'] },
  },
  {
    name: 'notevs_create_note',
    description: 'Create a new NoteVs note in the given project folder.',
    inputSchema: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'Note title' },
        content:  { type: 'string', description: 'Note content (markdown)' },
        tags:     { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        priority: { type: 'string', enum: ['none','low','medium','important','urgent','emergency'] },
        status:   { type: 'string', enum: ['open','done','passed'] },
        ...FOLDER_PATH_PROP,
      },
      required: ['title'],
    },
  },
  {
    name: 'notevs_save_note',
    description: "Update an existing note's title, content, tags, priority, status, or pinned state.",
    inputSchema: {
      type: 'object',
      properties: {
        id:       { type: 'string' },
        title:    { type: 'string' },
        content:  { type: 'string' },
        tags:     { type: 'array', items: { type: 'string' } },
        priority: { type: 'string', enum: ['none','low','medium','important','urgent','emergency'] },
        status:   { type: 'string', enum: ['open','done','passed'] },
        pinned:   { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'notevs_delete_note',
    description: 'Permanently delete a note by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'notevs_add_annotation',
    description: 'Attach a code annotation to an existing note. Links a file + line range to the note.',
    inputSchema: {
      type: 'object',
      properties: {
        noteId:      { type: 'string' },
        filePath:    { type: 'string', description: 'Relative file path within the workspace (e.g. src/index.ts)' },
        lineStart:   { type: 'number' },
        lineEnd:     { type: 'number' },
        codeSnippet: { type: 'string' },
        comment:     { type: 'string' },
      },
      required: ['noteId', 'filePath', 'lineStart', 'lineEnd'],
    },
  },
  {
    name: 'notevs_search_notes',
    description: 'Search notes by keyword across title, content, tags, and annotation comments.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        ...FOLDER_PATH_PROP,
      },
      required: ['query'],
    },
  },
  {
    name: 'notevs_export_to_notion',
    description: 'Export a NoteVs note to Notion. Creates a new page or updates the existing one. Requires Notion to be connected in Settings → Integrations → Exporting.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note id (from notevs_list_notes or notevs_create_note)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'notevs_export_to_obsidian',
    description: 'Export a NoteVs note to the Obsidian vault (via Local REST API or vault folder). Requires Obsidian to be configured in Settings → Integrations → Exporting.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note id (from notevs_list_notes or notevs_create_note)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'notevs_set_reminder',
    description: 'Create a task reminder for a note in Todoist or Google Tasks. Requires at least one task provider to be connected in Settings → Integrations → Tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        id:       { type: 'string', description: 'The note id' },
        dueDate:  { type: 'string', description: 'Due date in YYYY-MM-DD format (e.g. 2026-06-15)' },
        dueTime:  { type: 'string', description: 'Optional due time in HH:MM format (e.g. 09:00). Todoist only — Google Tasks ignores time.' },
        provider: { type: 'string', enum: ['todoist', 'google'], description: 'Which provider to use. Omit to auto-select the connected one (or todoist if both are connected).' },
      },
      required: ['id', 'dueDate'],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

function handleListNotes(storagePath: string, folderPath: string): unknown {
  const notes = readAllNotes(storagePath, folderPath);
  return notes.map(n => ({ id: n.id, title: n.title, tags: n.tags, priority: n.priority, status: n.status, pinned: n.pinned, updatedAt: n.updatedAt, annotationCount: (n.annotations?.length ?? 0) + (n.filePath && !n.annotations?.length ? 1 : 0) }));
}

function handleGetNote(storagePath: string, id: string): unknown {
  const note = readLocalNote(storagePath, id);
  if (!note) { throw new Error(`Note not found: ${id}`); }
  let contentPreview = '';
  if (note.editorMode === 'markdown') { contentPreview = note.content || ''; }
  else { try { contentPreview = (JSON.parse(note.content || '').ops ?? []).map((op: { insert?: unknown }) => typeof op.insert === 'string' ? op.insert : '').join(''); } catch { contentPreview = note.content || ''; } }
  return { id: note.id, title: note.title, content: contentPreview, editorMode: note.editorMode, tags: note.tags, priority: note.priority, status: note.status, pinned: note.pinned, updatedAt: note.updatedAt, createdAt: note.createdAt, annotations: (note.annotations ?? []).map(a => ({ id: a.id, filePath: a.filePath, lineStart: a.lineStart, lineEnd: a.lineEnd, codeSnippet: a.codeSnippet, comment: a.comment, status: a.status })) };
}

function handleCreateNote(storagePath: string, folderPath: string, args: { title: string; content?: string; tags?: string[]; priority?: string; status?: string }): unknown {
  const now = new Date().toISOString();
  const newNote: NoteItem = { id: randomUUID(), localId: randomUUID(), title: args.title, content: args.content || '', editorMode: 'markdown', pinned: false, tags: args.tags ?? [], priority: args.priority ?? 'none', status: args.status ?? 'open', createdAt: now, updatedAt: now, folderPath, deletedAt: null, syncedAt: null };
  writeLocalNote(storagePath, newNote);
  return { id: newNote.id, title: newNote.title, folderPath, status: 'created' };
}

function handleSaveNote(storagePath: string, args: { id: string; title?: string; content?: string; tags?: string[]; priority?: string; status?: string; pinned?: boolean }): unknown {
  const existing = readLocalNote(storagePath, args.id);
  if (!existing) { throw new Error(`Note not found: ${args.id}`); }
  const updated: NoteItem = { ...existing, title: args.title ?? existing.title, content: args.content ?? existing.content, tags: args.tags ?? existing.tags, priority: args.priority ?? existing.priority, status: args.status ?? existing.status, pinned: args.pinned ?? existing.pinned, editorMode: args.content !== undefined ? 'markdown' : existing.editorMode, updatedAt: new Date().toISOString() };
  writeLocalNote(storagePath, updated);
  return { id: updated.id, title: updated.title, status: 'saved' };
}

function handleDeleteNote(storagePath: string, id: string): unknown {
  if (!readLocalNote(storagePath, id)) { throw new Error(`Note not found: ${id}`); }
  deleteLocalNoteFromStorage(storagePath, id);
  return { id, status: 'deleted' };
}

function handleAddAnnotation(storagePath: string, args: { noteId: string; filePath: string; lineStart: number; lineEnd: number; codeSnippet?: string; comment?: string }): unknown {
  const existing = readLocalNote(storagePath, args.noteId);
  if (!existing) { throw new Error(`Note not found: ${args.noteId}`); }
  const now = new Date().toISOString();
  const newAnnotation: Annotation = { id: randomUUID(), noteId: args.noteId, filePath: args.filePath, lineStart: args.lineStart, lineEnd: args.lineEnd, codeSnippet: args.codeSnippet, comment: args.comment || '', status: 'open', createdAt: now, updatedAt: now };
  writeLocalNote(storagePath, { ...existing, annotations: [...(existing.annotations ?? []), newAnnotation], updatedAt: now });
  return { annotationId: newAnnotation.id, noteId: args.noteId, status: 'added' };
}

async function handleExportToNotion(
  secrets: vscode.SecretStorage,
  globalState: vscode.Memento,
  storagePath: string,
  id: string,
): Promise<unknown> {
  const result = await exportNoteToNotion(secrets, globalState, storagePath, id);
  return { id, status: 'exported', destination: 'notion', pageId: result.pageId, pageUrl: result.pageUrl };
}

async function handleExportToObsidian(
  secrets: vscode.SecretStorage,
  globalState: vscode.Memento,
  storagePath: string,
  id: string,
): Promise<unknown> {
  const result = await exportNoteToObsidian(secrets, globalState, storagePath, id);
  return { id, status: 'exported', destination: 'obsidian', filePath: result.filePath };
}

async function handleSetReminder(
  secrets: vscode.SecretStorage,
  storagePath: string,
  args: { id: string; dueDate: string; dueTime?: string; provider?: string },
): Promise<unknown> {
  const result = await setNoteReminder(secrets, storagePath, args.id, args.dueDate, args.dueTime ?? null, args.provider ?? null);
  return { id: args.id, status: 'reminder_set', ...result };
}

function handleSearchNotes(storagePath: string, folderPath: string, query: string): unknown {
  const q = query.toLowerCase().trim();
  return readAllNotes(storagePath, folderPath).filter(n => {
    if (n.title.toLowerCase().includes(q) || n.tags.some(t => t.toLowerCase().includes(q))) { return true; }
    let text = '';
    if (n.editorMode === 'markdown') { text = n.content || ''; }
    else { try { text = (JSON.parse(n.content || '').ops ?? []).map((op: { insert?: unknown }) => typeof op.insert === 'string' ? op.insert : '').join(''); } catch { text = n.content || ''; } }
    return text.toLowerCase().includes(q) || (n.annotations?.some(a => a.comment.toLowerCase().includes(q)) ?? false);
  }).map(n => ({ id: n.id, title: n.title, tags: n.tags, priority: n.priority, status: n.status, updatedAt: n.updatedAt }));
}

// ── Human-readable text for the MCP `content` field ───────────────────────────
// The Rasa flows read `result.content[0].text` verbatim into a response slot
// (see rasa-notevs-agent/data/flows/*.yml) — there's no LLM rephrasing step
// in between, so whatever's returned here is shown to the user exactly as-is.
// `structuredContent` (set separately, always the raw result) is what flows
// use instead when they need to extract a specific field like a note id.
function formatResultText(tool: string, result: unknown): string {
  const list = (r: unknown) => Array.isArray(r) ? r as Array<{ id: string; title: string; priority: string; status: string; tags: string[] }> : [];
  switch (tool) {
    case 'notevs_list_notes':
    case 'notevs_search_notes': {
      const notes = list(result);
      if (notes.length === 0) { return tool === 'notevs_search_notes' ? 'No notes matched that search.' : "You don't have any notes yet."; }
      return notes.map(n => {
        const bits = [n.priority && n.priority !== 'none' ? `priority: ${n.priority}` : null, n.status && n.status !== 'open' ? `status: ${n.status}` : null, n.tags?.length ? `tags: ${n.tags.join(', ')}` : null].filter(Boolean).join(', ');
        return `- "${n.title}" (id: ${n.id})${bits ? ` — ${bits}` : ''}`;
      }).join('\n');
    }
    case 'notevs_get_note': {
      const n = result as { title: string; content: string; id: string; tags?: string[]; annotations?: Array<{ filePath: string; lineStart: number; lineEnd: number; comment: string }> };
      let text = `"${n.title}" (id: ${n.id})\n\n${n.content || '(empty)'}`;
      if (n.annotations?.length) { text += `\n\nAnnotations:\n` + n.annotations.map(a => `- ${a.filePath}:${a.lineStart}-${a.lineEnd} — ${a.comment}`).join('\n'); }
      return text;
    }
    case 'notevs_create_note': {
      const n = result as { title: string; id: string };
      return `Created "${n.title}" (id: ${n.id}).`;
    }
    case 'notevs_save_note': {
      const n = result as { title: string };
      return `Saved "${n.title}".`;
    }
    case 'notevs_delete_note':
      return 'Note deleted.';
    case 'notevs_add_annotation':
      return 'Annotation added.';
    case 'notevs_export_to_notion': {
      const r = result as { pageUrl: string };
      return `Exported to Notion: ${r.pageUrl}`;
    }
    case 'notevs_export_to_obsidian': {
      const r = result as { filePath: string };
      return `Exported to Obsidian: ${r.filePath}`;
    }
    case 'notevs_set_reminder': {
      const r = result as { provider: string; taskUrl?: string };
      return `Reminder created in ${r.provider === 'google' ? 'Google Tasks' : 'Todoist'}.${r.taskUrl ? ` ${r.taskUrl}` : ''}`;
    }
    default:
      return JSON.stringify(result, null, 2);
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export async function startMcpServer(context: vscode.ExtensionContext, onNoteMutated?: OnNoteMutated): Promise<{ server: http.Server; port: number | undefined }> {
  const storagePath = context.globalStorageUri.fsPath;

  // MCP Streamable HTTP transport requires session negotiation: the server
  // hands out a session id on `initialize` (Mcp-Session-Id response header),
  // and the client is expected to echo it back on every subsequent request
  // on this connection. Without this, strict clients (like rasa-pro's MCP
  // client) fail during their internal handshake with an opaque error
  // ("unhandled errors in a TaskGroup") instead of a useful message.
  const mcpSessions = new Set<string>();

  /** Resolve which folder to scope notes to.
   *  Priority: 1) args.folderPath from agent  2) VS Code open folder */
  function resolveFolderPath(argFolderPath?: string): string | null {
    try {
      if (argFolderPath && fs.existsSync(argFolderPath)) { return fs.realpathSync(argFolderPath); }
      const vscodePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return vscodePath ? fs.realpathSync(vscodePath) : null;
    } catch { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null; }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    try {
      if (req.method === 'GET' && req.url === '/health') {
        send(200, { ok: true, folderPath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null });
        return;
      }

      if (req.method === 'GET' && req.url === '/tools') {
        send(200, { tools: TOOL_DEFINITIONS });
        return;
      }

      // ── Shared tool dispatch: used by both the plain /call endpoint (mcpBridge.ts,
      // the stdio MCP bridge for Claude Code/Cursor) and /mcp (JSON-RPC-over-HTTP,
      // for external MCP clients like a Rasa agent that only support http/https
      // MCP server transport, not stdio). ────────────────────────────────────────
      async function callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
        const folderPath = resolveFolderPath(args.folderPath as string | undefined);
        if (!folderPath) {
          throw new Error('Could not determine project folder. Pass folderPath in args or open a folder in VS Code.');
        }
        switch (tool) {
          case 'notevs_list_notes':   return handleListNotes(storagePath, folderPath);
          case 'notevs_get_note':     return handleGetNote(storagePath, args.id as string);
          case 'notevs_create_note':  { const r = handleCreateNote(storagePath, folderPath, args as Parameters<typeof handleCreateNote>[2]); onNoteMutated?.(); return r; }
          case 'notevs_save_note':    { const r = handleSaveNote(storagePath, args as Parameters<typeof handleSaveNote>[1]); onNoteMutated?.(); return r; }
          case 'notevs_delete_note':  { const r = handleDeleteNote(storagePath, args.id as string); onNoteMutated?.(); return r; }
          case 'notevs_add_annotation': { const r = handleAddAnnotation(storagePath, args as Parameters<typeof handleAddAnnotation>[1]); onNoteMutated?.(); return r; }
          case 'notevs_search_notes': return handleSearchNotes(storagePath, folderPath, args.query as string);
          case 'notevs_export_to_notion':  { const r = await handleExportToNotion(context.secrets, context.globalState, storagePath, args.id as string); onNoteMutated?.(); return r; }
          case 'notevs_export_to_obsidian': { const r = await handleExportToObsidian(context.secrets, context.globalState, storagePath, args.id as string); onNoteMutated?.(); return r; }
          case 'notevs_set_reminder': { const r = await handleSetReminder(context.secrets, storagePath, args as Parameters<typeof handleSetReminder>[2]); onNoteMutated?.(); return r; }
          default: throw new Error(`Unknown tool: ${tool}`);
        }
      }

      if (req.method === 'POST' && req.url === '/call') {
        const body = await readBody(req);
        const { tool, args } = JSON.parse(body) as { tool: string; args: Record<string, unknown> };
        try {
          const result = await callTool(tool, args);
          send(200, { result });
        } catch (err: unknown) {
          send(400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // ── /mcp: real MCP JSON-RPC 2.0 over HTTP (Streamable HTTP transport,
      // single request → single JSON response, no SSE). Mirrors the same
      // initialize/tools/list/tools/call methods mcpBridge.ts implements over
      // stdio for Claude Code/Cursor, so any real MCP client (e.g. a Rasa
      // `mcp_servers:` entry with type: http) can use the exact same 10 tools. ──
      if (req.method === 'GET' && req.url === '/mcp') {
        // No server-initiated messages to stream — this transport is
        // request/response only, so there's nothing to open an SSE stream
        // for. 405 tells clients that probe this not to expect one.
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'SSE streaming not supported; use POST' }));
        return;
      }

      if (req.method === 'DELETE' && req.url === '/mcp') {
        const sid = req.headers['mcp-session-id'];
        if (typeof sid === 'string') { mcpSessions.delete(sid); }
        res.writeHead(204); res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/mcp') {
        const body = await readBody(req);
        let rpcId: number | string | null = null;
        try {
          const rpc = JSON.parse(body) as { jsonrpc: '2.0'; id: number | string | null; method: string; params?: unknown };
          rpcId = rpc.id;
          switch (rpc.method) {
            case 'initialize': {
              const sessionId = randomUUID();
              mcpSessions.add(sessionId);
              res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId });
              res.end(JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'notevs-mcp', version: '1.0.0' } } }));
              return;
            }
            case 'notifications/initialized':
              res.writeHead(202); res.end();
              return;
            case 'tools/list':
              send(200, { jsonrpc: '2.0', id: rpcId, result: { tools: TOOL_DEFINITIONS } });
              return;
            case 'tools/call': {
              const { name, arguments: callArgs = {} } = (rpc.params ?? {}) as { name: string; arguments?: Record<string, unknown> };
              try {
                const result = await callTool(name, callArgs);
                // structuredContent (real MCP field, alongside content) lets
                // declarative clients like a Rasa flow's `mapping: output:`
                // pull individual fields (e.g. result.structuredContent.id)
                // instead of only getting the whole result as serialized text.
                // Per the MCP spec, structuredContent must be a JSON *object*
                // — list_notes/search_notes return arrays, which rasa-pro's
                // pydantic-validated client rejects outright, so those get
                // wrapped under an `items` key here (content/text is
                // untouched — it still serializes the raw array).
                const structuredContent = Array.isArray(result) ? { items: result } : result;
                send(200, { jsonrpc: '2.0', id: rpcId, result: { content: [{ type: 'text', text: formatResultText(name, result) }], structuredContent, isError: false } });
              } catch (err: unknown) {
                send(200, { jsonrpc: '2.0', id: rpcId, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
              }
              return;
            }
            case 'ping':
              send(200, { jsonrpc: '2.0', id: rpcId, result: {} });
              return;
            default:
              send(200, { jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: `Method not found: ${rpc.method}` } });
              return;
          }
        } catch (err: unknown) {
          send(200, { jsonrpc: '2.0', id: rpcId, error: { code: -32700, message: err instanceof Error ? err.message : 'Parse error' } });
        }
        return;
      }

      send(404, { error: 'Not found' });
    } catch (err: unknown) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Each VS Code window activates its own copy of this extension and tries
  // to bind the same fixed MCP_PORT — only one ever wins; every other
  // window used to just warn-and-give-up, leaving mcpServer with no live
  // listener at all for that window. Falling back to the next free port
  // instead means every window still gets a working server; the resolved
  // port is threaded through to agentProcess.ts (NOTEVS_CALL_URL) and
  // agentPanel.ts (health check) so each window's agent still calls back
  // into *its own* instance rather than needing to guess a fixed port.
  // MCP_PORT itself is still tried first and is what mcpBridge.ts (the
  // stdio bridge for Claude Code/Cursor) hardcodes — this preserves that
  // for the common single-window case; a losing window falling back here
  // just isn't reachable via that fixed-port bridge from Claude Code
  // simultaneously, no worse than before.
  const MAX_PORT_ATTEMPTS = 30;
  function tryListen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && port < MCP_PORT + MAX_PORT_ATTEMPTS) {
          console.warn(`[NoteVs MCP] Port ${port} already in use, trying ${port + 1}`);
          resolve(tryListen(port + 1));
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        console.log(`[NoteVs MCP] HTTP server running on localhost:${port}`);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }
  const portPromise = tryListen(MCP_PORT).catch((err: NodeJS.ErrnoException) => {
    console.error('[NoteVs MCP] Server error:', err);
    return undefined;
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    // Attempts during the tryListen fallback chain are handled by their own
    // once('error') listeners above; this catches anything after that
    // (e.g. a runtime error once already listening).
    if (err.code !== 'EADDRINUSE') { console.error('[NoteVs MCP] Server error:', err); }
  });

  const port = await portPromise;
  return { server, port };
}
