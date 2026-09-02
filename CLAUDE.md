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
  mcpServer.ts     ← Local HTTP MCP server (localhost:37492); exports OnNoteMutated callback type.
                      /call is the plain REST endpoint; /mcp is the same 10 tools over real
                      MCP JSON-RPC (initialize/tools/list/tools/call), for external MCP
                      clients that only support http/https transport (e.g. Rasa's
                      mcp_servers: config — see ../../rasa-notevs-agent)
  mcpBridge.ts     ← stdio MCP bridge for Claude Code / Cursor
  mcpInstaller.ts  ← Auto-registers MCP bridge in ~/.claude.json, ~/.cursor/mcp.json etc.
  taskIntegrations.ts ← Todoist + Google Tasks OAuth + task creation (UI-driven, used by editor)
  integrations.ts  ← Notion + Obsidian export helpers (used by both editor and MCP server)
  agentPanel.ts    ← WebviewPanel for the NoteVs Agent chat (notevs.openAgentChat); talks to
                      the local Rasa server (notevs.agentUrl) and to /health for status
  agentPanelHtml.ts ← HTML/CSS/JS for the agent chat panel (status pill, thinking state,
                      confirmation cards)
  agentProcess.ts  ← Fully automates the local Rasa server: once groqApiKey + rasaLicense
                      secrets are both set (Settings → Agent), extracts
                      resources/rasa-agent-template into global storage (re-synced every
                      start so template changes never go stale), creates/revalidates a
                      Python 3.10-3.13 venv, pip-installs rasa-pro (once, with --pre since
                      requirements.txt now pins a Maestro dev build), runs `rasa train` if
                      no models/*.tar.gz exists yet OR if agent.yml/integrations.yml/
                      skills//tools content has changed since the last trained model
                      (sha256 hash stored in models/.source_hash — training is otherwise
                      silently skipped forever, which is what let three flow-mapping
                      fixes go unnoticed on the old classic-CALM build until this hash
                      check was added), then runs it — restarts on crash with the real
                      stderr reason surfaced, no manual terminal steps.
                      Each VS Code window spawns its own isolated `rasa run` on its own
                      port (findFreePort: prefers 5005, cleaning up a same-window orphan
                      there first so a plain reload keeps reusing it, then falls back to
                      the next free port when something else — another window's live
                      agent, most likely — legitimately holds it; AgentProcessManager
                      exposes the resolved port via getPort() for agentPanel.ts to send
                      chat requests to, instead of assuming the notevs.agentUrl setting's
                      fixed default). The spawned process's env carries
                      NOTEVS_FOLDER_PATH (this window's own open folder) and
                      NOTEVS_CALL_URL (this window's own resolved MCP server port) — see
                      notevs_tools.py — so a shared global agent process is never needed
                      to get correct per-project results. notevs.agentRepoPath is an
                      optional override.
resources/
  rasa-agent-template/ ← Bundled copy of the rasa-notevs-agent project, on the Maestro
                      (calm_v2) skills architecture as of 2026-08-17 — Rasa renamed this
                      engine "Mantle" shortly after (rasa.com/docs is now mantle.rasa.com;
                      `rasa init --engine maestro` → `--engine mantle`), but it's the same
                      schema on the same rasa-pro==3.19.0.dev5 pin, confirmed by diffing
                      this template against the installed package's own
                      cli/project_templates/maestro/ scaffold — no migration needed, just
                      new optional pieces to adopt (see memory.yml below). Contents:
                      agent.yml,
                      integrations.yml (channels.inspector must stay `enabled: false` —
                      it's for the separate interactive `rasa inspect` debug command
                      only; enabled alongside channels.rest, `rasa run` tries to bind a
                      second listener on the same port right after the REST channel's
                      already bound it and crashes — confirmed live 2026-08-18),
                      memory.yml (project-wide shared state, new 2026-08-28 — currently
                      just `folder_path`, mirrored here by notevs_tools.py's _call() from
                      the NOTEVS_FOLDER_PATH env var on every tool call purely so it's
                      visible in `rasa inspect` and usable by scoped instructions; the env
                      var stays the actual source of truth since seeding memory straight
                      from the incoming request at session start isn't implemented yet in
                      this rasa-pro build — confirmed by reading processor.py's
                      _engine_prefill_commands, a no-op with a "follow-up" TODO comment),
                      skills/*/skill.md, tools/notevs_tools.py
                      (shared @tool wrappers that POST to mcpServer.ts's /call
                      endpoint, forwarding folderPath from the NOTEVS_FOLDER_PATH env var
                      agentProcess.ts sets per window — see mcpServer.ts's port section
                      above for why this matters), requirements.txt (pins
                      rasa-pro==3.19.0.dev5 — Mantle isn't GA yet, this is a dev build,
                      bump the pin as newer .devN builds land). The retired classic-CALM
                      files (domain.yml,
                      config.yml, endpoints.yml, credentials.yml, data/flows/) live in
                      ../../rasa-notevs-agent/classic-engine-backup/ for reference, not
                      bundled here. agentProcess.ts extracts/re-syncs this per-user on
                      every start — computeTrainingSourceHash (agentProcess.ts) must list
                      every top-level file that should trigger a retrain when changed;
                      memory.yml was missed on first add and had to be added there too, so
                      check that list before adding another top-level file here. Keep in
                      sync with the standalone ../../rasa-notevs-agent
                      repo (the Rasa Heroes submission source of truth) when either
                      changes.
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
The MCP server exposes 10 tools, preferring `localhost:37492` but falling
back to the next free port (37493, 37494, ...) when another VS Code window's
NoteVs already holds it — `startMcpServer` resolves and returns the actual
bound port, which `activate()` threads through to both
`registerAgentProcessManager` (as `NOTEVS_CALL_URL` for the spawned rasa
process) and `registerAgentChatCommand` (for the panel's own `/health`
poll), so each window's agent always calls back into *its own* MCP server
instance. (Previously a fixed port: only one window could ever bind it, and
every other window's tool calls got silently answered by that one winner's
own `vscode.workspace.workspaceFolders` — resolved 2026-08-18 alongside the
folderPath fix below, since port fallback alone wasn't sufficient; see
`notevs_tools.py`.)

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
| `notevs.openAgentChat` | Command palette / sidebar chat icon — opens the agent chat WebviewPanel beside the editor |

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
