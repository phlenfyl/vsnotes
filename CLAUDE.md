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
dist/
  extension.js     ← Built output (never edit this directly)
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
7. `activate()` — registers everything
8. `startLoginFlow()` — extension OAuth login
9. `deactivate()`

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

## Auth storage
Tokens are stored in VS Code `SecretStorage` (not localStorage). Keys: `accessToken`, `refreshToken`, `user`.

## NoteVs config files written on folder open (sync mode only)
- **`~/.notenest/tokens.json`** — stores `apiUrl` and `refreshToken`. Chmod 600.
- **`.notenest/config.json`** (project root) — stores only `{ "folderPath": "..." }`. Always gitignored.

## Git pre-commit hook
Written to `.git/hooks/pre-commit` on folder open (sync mode). Blocks commits when open-status notes exist.

## Annotation highlights
When a file is opened, `refreshAnnotations()` fetches all notes for that file (from disk in local mode, from API in sync mode) and applies gutter decorations and populates `annotationCache` for the hover provider.

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
