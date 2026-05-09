# NoteNest — VS Code Extension

## What this is
A VS Code extension that gives every project folder its own private notepad, synced to the NoteNest backend. Everything lives in a single file: `src/extension.ts`.

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
  icon-marketplace.png ← Marketplace listing icon (with NoteNest wordmark)
```

## Architecture: everything is in extension.ts
The file is structured in this order:
1. Helper functions (`getApiUrl`, `getFolderPath`)
2. Auth helpers (`getTokens`, `setTokens`, `refreshAccessToken`, `makeRequest`, `apiGet/Post/Patch/Delete`)
3. Types (`NoteItem` interface)
4. Constants (`PRIORITY_ORDER`, `PRIORITY_LABEL`, `BG_COLORS` etc.)
5. HTML generator functions (`loginHtml`, `settingsHtml`, `noFolderHtml`, `notesListHtml`, `noteEditorHtml`)
6. `activate()` — registers everything
7. `startLoginFlow()` — extension OAuth login
8. `deactivate()`

## VS Code config keys (all prefixed `notenest.`)
- `notenest.apiUrl` — backend URL (default: `https://notenest-backend.up.railway.app`)
- `notenest.autoShow` — auto-show on project open
- `notenest.noteBgColor` — note editor background colour
- `notenest.noteTextColor` — note editor text colour

## Registered commands
| Command | How triggered |
|---|---|
| `notenest.openNotes` | Command palette |
| `notenest.logout` | Command palette |
| `notenest.annotateSelection` | Cmd+Shift+N, right-click context menu |
| `notenest.annotateSelectionFromStatusBar` | Status bar button (internal) |
| `notenest.openNoteById` | Hover popup "Open note →" link |

## Auth storage
Tokens are stored in VS Code `SecretStorage` (not localStorage). Keys: `accessToken`, `refreshToken`, `user`.

## NoteNest config files written on folder open
- **`~/.notenest/tokens.json`** — stores `apiUrl` and `refreshToken`. Chmod 600. **Never in the project folder.**
- **`.notenest/config.json`** (project root) — stores only `{ "folderPath": "..." }`. No tokens. Always gitignored.

## Git pre-commit hook
Written to `.git/hooks/pre-commit` on folder open. It:
1. Reads refresh token from `~/.notenest/tokens.json`
2. Exchanges for a fresh access token via `/auth/refresh`
3. Calls `GET /notes/blocking?folderPath=...`
4. Blocks the commit if any notes have `status: "open"`
5. Prints the blocking note titles in the terminal

Safe for other devs — `.git/hooks/` is never committed.

## Annotation highlights
When a file is opened, `refreshAnnotations()` fetches all notes for that file and:
- Applies a **blue left border + faint background** decoration to all annotated line ranges
- Populates `annotationCache` (Map of relPath → NoteItem[]) for the hover provider
- The `HoverProvider` reads from this cache and shows a popup on hover with an "Open note →" link

## Selection annotation flow
The status bar button click clears the editor selection before the command fires. To work around this:
1. `onDidChangeTextEditorSelection` fires with the selection
2. After 150ms debounce, `savedSelection` and `savedEditorUri` are snapshotted
3. Ghost text hint appears at end of line: `📎 NoteNest — press ⌘⇧N to annotate`
4. Status bar shows `📎 Annotate selection` button
5. When button is clicked, `annotateSelectionFromStatusBar` reads from `savedSelection` (the live selection is already gone)

## Note fields
- `status`: `"open"` | `"done"` | `"passed"` — shown as colour-coded dropdown in editor
- `priority`: `"none"` | `"low"` | `"medium"` | `"important"` | `"urgent"` | `"emergency"`
- `filePath`: relative path to annotated file
- `lineStart`, `lineEnd`: 1-based line numbers
- `codeSnippet`: highlighted text (max 500 chars)

## HTML generation rules
All HTML for the webview is generated as template literal strings in TypeScript. Rules:
- **No backticks inside template literals** (esbuild issue — see above)
- Emoji in HTML must use HTML entities e.g. `&#x1F4DD;` not the emoji character directly, to avoid encoding issues
- All webview scripts use `acquireVsCodeApi()` and `vscode.postMessage({type: '...'})` to communicate back to the extension
- The extension listens with `webviewView.webview.onDidReceiveMessage()`
- The extension sends to the webview with `webviewView.webview.postMessage()`

## Backend API URL
Default is `https://notenest-backend.up.railway.app`. Configurable via `notenest.apiUrl` VS Code setting.

## Publisher / marketplace
- `publisher` in `package.json` is `YOUR_PUBLISHER_NAME` — replace before publishing
- Repository URL is `YOUR_USERNAME` — replace before publishing
- Run `vsce package` then `vsce publish` to release
