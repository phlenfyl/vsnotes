# Changelog

All notable changes to NoteNest will be documented here.

## [0.0.4] - 2026-05-09

### Changed
- Default API URL switched to `http://localhost:3001` (dev backend) for local development
- `notenest.apiUrl` setting default updated to match

## [0.0.3] - 2026-05-01

### Added
- **Code annotations** — select any lines in a file and attach a note to them (Cmd/Ctrl+Shift+N or right-click → Annotate Selection)
- **Multi-annotation support** — a single note can now hold multiple code annotations, each with its own file/line range, status, code snippet preview, and freetext comment
- **Gutter decorations** — annotated lines show a blue left-border highlight in the editor; overview ruler marks too
- **Hover tooltips** — hovering over an annotated line shows the note title, status, priority, and a preview with an "Open note →" command link
- **Annotation status bar item** — when code is selected a status bar button appears to annotate it without going to the command palette
- **CodeAction provider** — "NoteNest: Annotate this selection" appears in the light-bulb / quick-fix menu for any selection
- **Per-note editor tabs** — notes open in a `ViewColumn.Beside` panel instead of replacing the sidebar, so you can edit code and notes side by side
- **Notes cache** — notes are cached in `globalState` per workspace folder; sidebar renders immediately from cache while a fresh fetch runs in the background
- **Offline queue** — edits made while offline are queued and flushed on reconnect, with a conflict-resolution prompt when the server version is newer
- **Git pre-commit hook** — automatically installed into `.git/hooks/pre-commit`; blocks commits when any note with status `open` exists (configurable per-note by changing status to Done/Passed)
- **Settings panel** — toggle auto-show and pick from 12 editor background colour swatches
- **No-folder state** — graceful UI when no workspace folder is open, with an Open Folder button
- **Priority system** — notes have Emergency / Urgent / Important / Medium / Low / None priority; highest-priority note opens automatically on project load
- **Status system** — notes have Open / Done / Passed status; shown as coloured badges in the list
- **Pin notes** — pinned notes shown with a pin icon in the list
- **Tags** — comma-separated tags shown as badges; searchable
- **Search / filter** — live search bar filters note list by title and preview
- **Inline new-note input** — click + or Cmd/Ctrl+N to reveal an inline title input in the list; Enter creates the note and opens the editor
- **Google OAuth through extension** — Sign In with Google works inside the extension login flow; redirect param survives the OAuth round-trip

### Changed
- Extension renamed from ProjectNotes → **NoteNest**
- Sidebar now opens notes as separate editor tabs (not inline in the sidebar)
- Note editor supports both WYSIWYG (Quill) and Markdown modes, switchable per-note
- Word count + char count shown in the editor footer

## [0.0.2] - 2026-03-15

### Added
- Per-project note scoping (notes tied to workspace folder path)
- Tag support
- Pin notes
- Priority and status fields
- Markdown editor mode alongside WYSIWYG
- Auto-save (1 s debounce) + Cmd/Ctrl+S manual save
- Back button returns to notes list from editor

### Fixed
- Token refresh on 401 now retries the original request correctly

## [0.0.1] - 2026-03-01

### Added
- Initial release
- Multiple notes per project
- Cloud sync via NoteNest account
- Auto-save as you type
- 12 custom background colours for the note editor
- Sign in via browser (no password typed in VS Code)
