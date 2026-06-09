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

export const MCP_PORT = 37491;

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
    if (entry.folderPath !== folderPath) { continue; }
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

// ── HTTP Server ───────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function startMcpServer(context: vscode.ExtensionContext, onNoteMutated?: OnNoteMutated): http.Server {
  const storagePath = context.globalStorageUri.fsPath;

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

      if (req.method === 'POST' && req.url === '/call') {
        const body = await readBody(req);
        const { tool, args } = JSON.parse(body) as { tool: string; args: Record<string, unknown> };

        // ── Resolve folderPath: agent cwd wins over VS Code open folder ──────
        const folderPath = resolveFolderPath(args.folderPath as string | undefined);

        if (!folderPath) {
          send(400, { error: 'Could not determine project folder. Pass folderPath in args or open a folder in VS Code.' });
          return;
        }

        let result: unknown;
        switch (tool) {
          case 'notevs_list_notes':   result = handleListNotes(storagePath, folderPath); break;
          case 'notevs_get_note':     result = handleGetNote(storagePath, args.id as string); break;
          case 'notevs_create_note':  result = handleCreateNote(storagePath, folderPath, args as Parameters<typeof handleCreateNote>[2]); onNoteMutated?.(); break;
          case 'notevs_save_note':    result = handleSaveNote(storagePath, args as Parameters<typeof handleSaveNote>[1]); onNoteMutated?.(); break;
          case 'notevs_delete_note':  result = handleDeleteNote(storagePath, args.id as string); onNoteMutated?.(); break;
          case 'notevs_add_annotation': result = handleAddAnnotation(storagePath, args as Parameters<typeof handleAddAnnotation>[1]); onNoteMutated?.(); break;
          case 'notevs_search_notes': result = handleSearchNotes(storagePath, folderPath, args.query as string); break;
          case 'notevs_export_to_notion':  result = await handleExportToNotion(context.secrets, context.globalState, storagePath, args.id as string); onNoteMutated?.(); break;
          case 'notevs_export_to_obsidian': result = await handleExportToObsidian(context.secrets, context.globalState, storagePath, args.id as string); onNoteMutated?.(); break;
          case 'notevs_set_reminder': result = await handleSetReminder(context.secrets, storagePath, args as Parameters<typeof handleSetReminder>[2]); onNoteMutated?.(); break;
          default: send(400, { error: `Unknown tool: ${tool}` }); return;
        }

        send(200, { result });
        return;
      }

      send(404, { error: 'Not found' });
    } catch (err: unknown) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(MCP_PORT, '127.0.0.1', () => {
    console.log(`[NoteVs MCP] HTTP server running on localhost:${MCP_PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') { console.warn(`[NoteVs MCP] Port ${MCP_PORT} already in use`); }
    else { console.error('[NoteVs MCP] Server error:', err); }
  });

  return server;
}
