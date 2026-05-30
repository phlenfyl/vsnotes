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

export const MCP_PORT = 37491;

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

export function startMcpServer(context: vscode.ExtensionContext): http.Server {
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
          case 'notevs_create_note':  result = handleCreateNote(storagePath, folderPath, args as Parameters<typeof handleCreateNote>[2]); break;
          case 'notevs_save_note':    result = handleSaveNote(storagePath, args as Parameters<typeof handleSaveNote>[1]); break;
          case 'notevs_delete_note':  result = handleDeleteNote(storagePath, args.id as string); break;
          case 'notevs_add_annotation': result = handleAddAnnotation(storagePath, args as Parameters<typeof handleAddAnnotation>[1]); break;
          case 'notevs_search_notes': result = handleSearchNotes(storagePath, folderPath, args.query as string); break;
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
