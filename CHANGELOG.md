# Changelog

All notable changes to NoteVs will be documented here.

## [0.9.0] - 2026-06-09

### Added
- **MCP sidebar live refresh** — notes created, updated, or deleted by AI agents now appear in the sidebar immediately without needing to manually create a note to trigger a refresh
- **`notevs_export_to_notion` MCP tool** — agents can now export any note to Notion directly (creates a new page or updates the existing one); requires Notion token to be configured in Settings → Integrations → Exporting
- **`notevs_export_to_obsidian` MCP tool** — agents can now save any note to the Obsidian vault (uses the Local REST API if configured, falls back to direct vault folder write); requires Obsidian to be set up in Settings → Integrations → Exporting
- **`notevs_set_reminder` MCP tool** — agents can now create task reminders for notes in Todoist or Google Tasks headlessly, using the stored tokens from Settings → Integrations → Tasks; accepts `id`, `dueDate` (YYYY-MM-DD), optional `dueTime` (HH:MM), and optional `provider` (`todoist` or `google`)

## [0.8.0] - 2026-05-30

### Added
- **Windsurf and Antigravity MCP support** — NoteVs now auto-registers in `~/.codeium/windsurf/mcp_config.json` and `~/.gemini/antigravity/mcp_config.json` on activation, alongside the existing Claude Code, Cursor, and VS Code Copilot registrations

### Fixed
- **Notes created by AI agents now appear in the sidebar** — path normalization via `fs.realpathSync` ensures notes written by Claude Code / Cursor (using `process.cwd()`) and notes read by VS Code (using `workspaceFolders[0].uri.fsPath`) always resolve to the same key, fixing the blank sidebar bug on macOS

## [0.6.0] - 2026-05-30

### Added
- **MCP auto-registration** — on activation, NoteVs now automatically registers itself as an MCP server in `~/.claude.json`, `~/.cursor/mcp.json`, and `~/.vscode/mcp.json`; no manual setup required for Claude Code or Cursor users

## [0.5.0] - 2026-05-30

### Changed
- **Activity bar icon** — replaced the full-color NoteNest logo with a clean monochrome SVG (spiral-bound notepad + pencil). VS Code now masks it correctly with the theme foreground color so it renders consistently alongside all other activity bar icons
- **Annotations are now collapsible** — each annotation in the note editor is collapsed by default, showing a one-line summary (file/line link + comment preview). Click the row to expand/collapse. Saves significant vertical space when a note has multiple annotations
- **Cloud sync section hidden in Settings** — the sync toggle and related UI are commented out until the feature is production-ready; Settings now only shows auto-show and background colour options
- **"Back" button no longer underlines on hover** — subtle opacity change instead

### Fixed
- **Annotation gutter decorations now clear immediately on note deletion** — previously the blue line highlights would persist in the editor after a note was deleted until the next file switch
- **Extension no longer shows login/welcome screen on startup** — stale `syncEnabled: true` state from previous sessions no longer causes the sign-in page to appear; the extension always boots directly into the notes list
- **NoteNest logo removed from annotation gutter** — the extension logo no longer appeared as a gutter icon next to annotated lines
- **"Sign in to NoteVs first" error removed** — annotating code no longer requires authentication; works fully in local-only mode
- **"Enable cloud sync" link removed from notes list bar** — the clickable link that appeared next to "Local only" no longer shows; the bar is display-only until sync is ready

## [0.2.0] - 2026-05-30

### Added
- **MCP server** — NoteVs now exposes a local MCP server on `localhost:37491` when the extension is active
- **MCP bridge** — bundled `dist/mcp-bridge.cjs` allows Claude Code, Cursor, and other agents to talk to your notes via stdio
- **Auto-registration** — on first activation, NoteVs automatically registers itself in `~/.claude.json`, `~/.cursor/mcp.json`, and `~/.vscode/mcp.json` — no manual setup required
- **7 MCP tools** — `notevs_list_notes`, `notevs_get_note`, `notevs_create_note`, `notevs_save_note`, `notevs_delete_note`, `notevs_add_annotation`, `notevs_search_notes`
- **Per-repo scoping** — MCP tools are automatically scoped to the repo the agent is running in (uses `process.cwd()`), independent of which folder VS Code has open

## [0.1.0] - 2026-05-25

### Added
- Initial Marketplace release

## [0.0.5] - 2026-05-22

### Changed
- **Renamed from NoteNest to NoteVs** — all extension IDs, commands, config keys, and UI text updated (`notenest.*` → `notevs.*`)

### Added
- **Local-first architecture** — extension now works fully offline with no account required
- **Welcome screen** — new onboarding screen replaces login as the entry point for new users; returning users see a migration screen
- **Local storage layer** — notes stored as individual JSON files in `context.globalStorageUri/notes/`; `meta.json` index tracks all notes per folder
- **Sync status bar** — slim bar below search showing local / syncing / synced / error states with "Enable cloud sync →" link
- **Cloud sync toggle in Settings** — enable/disable sync at any time; logout button now conditional (only shown when sync is on)
- **Local mode for all operations** — create, edit, delete notes, add annotations, view gutter decorations and hover tooltips — all work without an account
- **Coloured note cards** — each card in the notes list has a distinct accent colour (8-colour cycling palette)

## [0.0.4] - 2026-05-09

### Changed
- Default API URL switched to production Railway backend

## [0.0.3] - 2026-05-01

### Added
- **Code annotations** — select any lines in a file and attach a note to them (Cmd/Ctrl+Shift+N or right-click → Annotate Selection)
- **Multi-annotation support** — a single note can hold multiple code annotations
- **Gutter decorations** — annotated lines show a blue left-border highlight; overview ruler marks
- **Hover tooltips** — hovering over an annotated line shows the note title, status, priority, and preview
- **Annotation status bar item** — status bar button appears on selection
- **CodeAction provider** — "NoteVs: Annotate this selection" in the light-bulb menu
- **Per-note editor tabs** — notes open in `ViewColumn.Beside`
- **Notes cache** — sidebar renders from cache immediately while fresh fetch runs in background
- **Offline queue** — edits queued offline and flushed on reconnect with conflict resolution
- **Git pre-commit hook** — blocks commits when open-status notes exist
- **Settings panel** — auto-show toggle and 12 editor background colour swatches
- **Priority system** — Emergency / Urgent / Important / Medium / Low / None
- **Status system** — Open / Done / Passed
- **Pin notes**, **Tags**, **Search / filter**, **Inline new-note input**

## [0.0.2] - 2026-03-15

### Added
- Per-project note scoping, tag support, pin notes, priority and status fields
- Markdown editor mode alongside WYSIWYG
- Auto-save + Cmd/Ctrl+S manual save

## [0.0.1] - 2026-03-01

### Added
- Initial release — multiple notes per project, cloud sync, auto-save, 12 background colours, browser-based sign in
