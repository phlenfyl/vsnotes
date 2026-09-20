# Changelog

All notable changes to NoteVs will be documented here.

## [0.21.1] - 2026-09-20

### Fixed
- **Agent stopped responding for Groq users — "model not found"** — the pinned Groq model (`qwen/qwen3.6-27b`) was quietly discontinued upstream. Re-pinned to its successor (`qwen/qwen3.8-27b`), confirmed live against a real conversation

## [0.21.0] - 2026-09-04

### Changed
- **The agent no longer needs a "warm-up" message before it can help you** — every new or resumed chat used to silently send a throwaway message first so the agent's own startup-greeting step wouldn't swallow your real one (see 0.20.1/0.20.2). That workaround is gone: the agent's greeting step is now configured to get straight out of the way, so your very first message in any chat is answered for real immediately, no warm-up needed and nothing to wait for
- **First-ever chat still gets a friendly hello** — the very first time you ever open the agent panel, it shows a one-time "Hi! How can I help you today?" before you type anything. Every chat after that — new or resumed — skips straight to answering

## [0.20.2] - 2026-09-02

### Fixed
- **New chat sometimes showed no greeting at all** — the greeting step introduced in 0.20.1 could silently come back empty if the LLM provider rate-limited that one request (confirmed live), leaving the chat looking like nothing happened even though it had actually finished successfully and your next message would work fine. Now falls back to a plain "Hi! How can I help you today?" instead of showing nothing

## [0.20.1] - 2026-09-02

### Fixed
- **Agent sometimes just echoed your first message back instead of answering it** — a brand-new (or resumed) chat's very first message could race against the agent's own startup-greeting step and get swallowed by it instead of reaching the real skill that would look up your notes. The input now stays disabled — with the same "thinking" indicator as a normal send — for the moment it takes the agent to greet you at the start of every chat, so your first real message is never in that race to begin with. Reopening/resuming a past chat is covered too, silently (no extra greeting bubble spliced into old history)

## [0.20.0] - 2026-09-02

### Added
- **Choose your own LLM provider for the agent** — Settings → Agent now has a provider dropdown (Groq, OpenAI, or Anthropic) instead of being locked to Groq. Pick one, add its API key, and the agent trains/runs against it automatically. Voice input works with a Groq or OpenAI key (Anthropic doesn't offer speech APIs — chat still works fine without one, or add a Groq/OpenAI key just for voice)

## [0.19.0] - 2026-09-02

### Fixed
- **Voice input crashed with an RtAudio "sample rate" error on many microphones** — recording forced every device to 16kHz regardless of what it actually supports; confirmed live that some devices' drivers reject that outright (16kHz wasn't even in the affected device's supported list). Recording now uses whatever sample rate the device itself reports supporting

### Added
- **Voice input now works on more than one machine** — until now, voice only worked on the specific platform the extension happened to be built on (macOS Apple Silicon), because the bundled native audio module was only ever built for that one platform; every other platform silently got "can't access the microphone." Now bundles prebuilt binaries for macOS (Intel and Apple Silicon), Windows (x64), and Linux (x64 and ARM64), and picks the right one automatically. Still unsupported: Windows on ARM (no upstream prebuild exists) and 32-bit Linux/Windows

## [0.18.0] - 2026-08-28

### Added
- **Agent project memory** — the bundled agent now declares real, framework-level shared state (`memory.yml`) for which project a conversation is scoped to, on top of the existing internal plumbing that already made this correct. This doesn't change any user-visible behavior by itself; it makes that state inspectable via Rasa's own debugging tools and available for more precise agent behavior going forward, following Rasa's own recent "Mantle" engine update (the successor to the "Maestro" engine NoteVs's agent already runs on)

## [0.17.1] - 2026-08-18

### Fixed
- **Agent chat crashed on startup with "address already in use"** — the bundled agent config (`integrations.yml`) had both `channels.rest` and `channels.inspector` enabled; `inspector` is meant only for the separate interactive `rasa inspect` debug command, but with it also enabled, `rasa run` started a second listener on the same port right after the REST channel's own listener had already bound it, crashing every time. `inspector` is now off — NoteVs never used Rasa's own voice channel anyway (voice goes through Groq from the extension host, see `voice.ts`)
- **Agent chat showed notes from a different project when multiple VS Code windows were open** — the agent's note-lookup tool calls didn't say which project they were for, so they silently resolved to whichever window's local NoteVs server happened to be reachable, not necessarily the window you were chatting in. Every tool call now explicitly states which project it's for
- **Multiple open windows could crash-loop fighting over the same port** — each window now runs its own isolated local agent process and MCP server, each finding its own free port automatically instead of colliding on a fixed one

## [0.15.0] - 2026-06-20

### Added
- **Export notes to `.notevs/`** — new Export / Import button (the `|→` icon in the sidebar toolbar) lets you export all notes for a project into a `.notevs/` folder at the repo root. Each note is written as a clean, human-readable `.md` file containing only the note text (no frontmatter). All metadata (title, status, priority, tags, reminders, Notion/Obsidian export state, Google Tasks / Todoist links, annotations) is stored separately in a single `notes.json` index file that points to each `.md` file
- **Monorepo-aware export structure** — in a monorepo, `.notevs/` mirrors the sub-package layout: notes scoped to `packages/api` land in `.notevs/packages/api/`, notes scoped to `packages/web` in `.notevs/packages/web/`, and root-level notes in `.notevs/root/`. Single repos export flat into `.notevs/root/`
- **Import notes from `.notevs/`** — triggered from the same Export / Import dropdown. NoteVs reads `notes.json`, validates it belongs to the current workspace, then restores every note including all integration state (Notion badge, Todoist/Google Tasks reminder badges, annotations) silently — no manual re-linking needed. Skips notes that already exist; updates content for notes whose `.md` file was edited externally since the last export
- **Export / Import dropdown** — the toolbar now uses a single `|→` button that opens a two-item dropdown (Export notes / Import notes) instead of two separate icons, keeping the toolbar uncluttered
- **Backward-compatible import** — the importer also handles v1 exports (the old format that embedded YAML frontmatter directly in the `.md` files), so older exports still work
- **Plain-text `.md` files** — note content is extracted from Quill delta JSON and written as plain text so the exported files are genuinely editable in any editor. On import, plain text is wrapped back into a Quill delta automatically

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
