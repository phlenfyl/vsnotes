# NoteVs — VS Code Extension

## What this is
A VS Code extension that gives every project folder its own private notepad, synced to the NoteVs backend. Everything lives in a single file: `src/extension.ts`.

## Tech stack
- **Language:** TypeScript
- **Build:** esbuild (bundles to `dist/extension.js`) — NOT tsc
- **Runtime:** VS Code Extension Host (Node.js)
- **HTTP:** axios (bundled in)

## Build command
```bash
npm run build   # esbuild bundle
npm run dev     # watch mode
```
After every change you must rebuild AND reload the extension host:
**Cmd+Shift+P → Developer: Reload Window**

## Critical: esbuild + backtick rule
The build uses esbuild with `--loader:.ts=ts`. **Never put literal backtick characters inside template literal strings** in `extension.ts`. esbuild misparses them and throws a syntax error. Use `String.fromCharCode(96)` or HTML entities (`&#96;`) if you need a backtick inside a template literal.

## File structure
```
src/
  extension.ts     ← ENTIRE extension — HTML generators, commands, providers, all logic
  mcpServer.ts     ← Local HTTP MCP server (localhost:37491); exports OnNoteMutated callback type
  mcpBridge.ts     ← stdio bridge for Claude Code / Cursor
  mcpInstaller.ts  ← Auto-registers MCP bridge in ~/.claude.json, ~/.cursor/mcp.json etc.
  taskIntegrations.ts ← Todoist + Google Tasks OAuth + task creation (UI-driven, used by editor)
  integrations.ts  ← Notion + Obsidian export helpers (used by both editor and MCP server)
dist/
  extension.js     ← Built output (never edit this directly)
  mcp-bridge.cjs   ← Compiled stdio bridge
media/
  icon.png         ← Activity bar icon (no wordmark)
  icon-marketplace.png ← Marketplace listing icon (with NoteVs wordmark)
```

## Architecture: everything is in extension.ts
The file is structured in this order:
1. Helper functions (`getApiUrl`, `getFolderPath`)
2. Auth helpers (`getTokens`, `setTokens`, `refreshAccessToken`, `makeRequest`, `apiGet/Post/Patch/Delete`)
3. Types (`NoteItem` interface, `LocalMeta` interface)
4. Local storage helpers (`readLocalNotes`, `writeLocalNote`, `deleteLocalNote`, etc.)
5. Constants (`PRIORITY_ORDER`, `PRIORITY_LABEL`, `BG_COLORS` etc.)
6. HTML generator functions (`welcomeHtml`, `loginHtml`, `settingsHtml`, `noFolderHtml`, `notesListHtml`, `noteEditorHtml`)
7. `activate()` — registers everything, including the `onNoteMutated` callback passed to `startMcpServer`
8. `startLoginFlow()` — extension OAuth login
9. `deactivate()`

## MCP server (`mcpServer.ts`)
The MCP server runs on `localhost:37491` and exposes 10 tools:

| Tool | Notes |
|---|---|
| `notevs_list_notes` | Scoped to folderPath |
| `notevs_get_note` | By id |
| `notevs_create_note` | Writes to disk + fires `onNoteMutated` |
| `notevs_save_note` | Updates JSON file + fires `onNoteMutated` |
| `notevs_delete_note` | Removes JSON + meta entry + fires `onNoteMutated` |
| `notevs_add_annotation` | Appends annotation + fires `onNoteMutated` |
| `notevs_search_notes` | Keyword search across title/content/tags/annotations |
| `notevs_export_to_notion` | Self-contained Notion HTTP calls (no VS Code UI); uses stored `notionToken` secret |
| `notevs_export_to_obsidian` | REST API then vault-folder fallback; uses stored `obsidianApiKey` secret |
| `notevs_set_reminder` | Todoist or Google Tasks headless POST; uses stored tokens; auto-picks provider if one is connected |

`OnNoteMutated` is a callback type exported from `mcpServer.ts`. `extension.ts` passes a closure that re-renders the sidebar `panel.webview.html` immediately when any mutation tool fires.

## Local-first architecture
NoteVs is local-first. Notes are stored as JSON files on disk in `context.globalStorageUri/notes/`. An index is kept in `meta.json`. Cloud sync is opt-in via the Settings panel.

**GlobalState flags** (all prefixed `notevs.`):
- `notevs.firstRunComplete` — has user dismissed the welcome screen
- `notevs.syncEnabled` — is cloud sync active
- `notevs.lastSyncAt` — ISO timestamp of last sync

**Render decision tree:**
1. `firstRunComplete` false → show `welcomeHtml()`
2. `syncEnabled` false → local mode, read from disk, show `notesListHtml(..., 'local')`
3. `syncEnabled` true → existing auth flow → `showNotesList()`

## VS Code config keys (all prefixed `notevs.`)
- `notevs.apiUrl` — backend URL (default: `http://localhost:3001`)
- `notevs.autoShow` — auto-show on project open
- `notevs.noteBgColor` — note editor background colour
- `notevs.noteTextColor` — note editor text colour

## Registered commands
| Command | How triggered |
|---|---|
| `notevs.openNotes` | Command palette |
| `notevs.logout` | Command palette |
| `notevs.annotateSelection` | Cmd+Shift+N, right-click context menu |
| `notevs.annotateSelectionFromStatusBar` | Status bar button (internal) |
| `notevs.openNoteById` | Hover popup "Open note →" link |
| `notevs.exportNotes` | Command palette / sidebar `|→` dropdown |
| `notevs.importNotes` | Command palette / sidebar `|→` dropdown |

## Auth storage
Tokens are stored in VS Code `SecretStorage` (not localStorage). Keys: `accessToken`, `refreshToken`, `user`.

## NoteVs config files written on folder open (sync mode only)
- **`~/.notenest/tokens.json`** — stores `apiUrl` and `refreshToken`. Chmod 600.
- **`.notenest/config.json`** (project root) — stores only `{ "folderPath": "..." }`. Always gitignored.

## Git pre-commit hook
Written to `.git/hooks/pre-commit` on folder open (sync mode). Blocks commits when open-status notes exist.

## Annotation highlights
When a file is opened, `refreshAnnotations()` fetches all notes for that file (from disk in local mode, from API in sync mode) and applies gutter decorations and populates `annotationCache` for the hover provider.

## Export / Import (`.notevs/` folder)

The export/import system uses a two-file structure per project:

```
.notevs/
  notes.json          ← all metadata (version, workspacePath, isMonorepo, notes[])
  root/
    my-note-abc123.md ← plain text content only, no frontmatter
  packages/api/
    other-note.md
```

**`notes.json`** shape (version 2):
```json
{
  "version": 2,
  "workspacePath": "/abs/path/to/repo",
  "isMonorepo": true,
  "exportedAt": "ISO string",
  "notes": [
    {
      "id", "localId", "title", "status", "priority", "editorMode",
      "pinned", "tags", "folderPath", "createdAt", "updatedAt",
      "exports",     // Notion/Obsidian integration state
      "reminders",   // Todoist/Google Tasks state
      "annotations", // code annotation objects
      "file": "root/my-note-abc123.md"  // relative to .notevs/
    }
  ]
}
```

**Content round-trip:** Quill delta → `deltaToPlainText()` on export → `.md` file. On import: plain text → `plainTextToDelta()` → stored as Quill delta. Markdown-mode notes skip the conversion.

**Import validation:** `notes.json` `workspacePath` is compared against the current workspace root. Mismatches show a warning but allow "Import anyway". `folderPath` on each note is remapped if the workspace has moved.

**v1 legacy import:** The importer also handles the old format (`.md` files with YAML frontmatter + `meta.json`). Falls back to v1 path if `notes.json` is absent but `meta.json` is present.

**Re-import behaviour:** If a note id already exists, content is updated only if the `.md` file has changed (user edited it externally). Integration state (`exports`, `reminders`) is merged, never wiped.

## Note fields
- `status`: `"open"` | `"done"` | `"passed"`
- `priority`: `"none"` | `"low"` | `"medium"` | `"important"` | `"urgent"` | `"emergency"`
- `localId`: client-generated UUID (persists across sync)
- `deletedAt`: soft delete timestamp
- `syncedAt`: when last pushed to cloud

## Backend API URL
Default is `http://localhost:3001` (dev). Production: `https://notenest-backend.up.railway.app`. Configurable via `notevs.apiUrl`.

## Publisher / marketplace
- `publisher` in `package.json` is `YOUR_PUBLISHER_NAME` — replace before publishing
- Run `vsce package` then `vsce publish` to release
