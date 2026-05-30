# Changelog

All notable changes to NoteVs will be documented here.

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
