# NoteNest Extension — UI Changes & Screen Design Plan

**Document type:** UI Design & Screen Specification  
**Status:** Approved for implementation  
**Version:** 1.0  
**Last updated:** 2026-05-09  

---

## 1. Overview

This document specifies every UI change required to support the local-first architecture. It covers new screens, modified screens, unchanged screens, and the design rationale for each decision. All designs maintain the existing NoteNest visual language: VS Code CSS variables for theming, codicons for icons, the established toolbar/card layout, and the same font sizes and spacing.

---

## 2. Design Principles (Existing — Preserved)

The extension already follows these conventions consistently. All new screens must follow them too:

| Convention | Detail |
|---|---|
| Background | `var(--vscode-sideBar-background)` |
| Text | `var(--vscode-foreground)` |
| Muted text | `var(--vscode-descriptionForeground)` |
| Primary button | `var(--vscode-button-background)` / `var(--vscode-button-foreground)` |
| Secondary button | `var(--vscode-button-secondaryBackground)` / `var(--vscode-button-secondaryForeground)` |
| Links | `var(--vscode-textLink-foreground)` |
| Borders | `var(--vscode-panel-border)` |
| Focus ring | `var(--vscode-focusBorder)` |
| Icons | `@vscode/codicons` library (already loaded via CDN in all screens) |
| Font | `var(--vscode-font-family)` |
| Toolbar height | 38px (10px top/bottom padding + 18px content) |
| Body padding | 16–24px |

---

## 3. Screen Inventory

| Screen | Status | HTML Function |
|---|---|---|
| Welcome / Onboarding | **NEW** | `welcomeHtml()` |
| Welcome — Existing User Variant | **NEW** | `welcomeHtml(existingUser: true)` |
| Notes List | **MODIFIED** — add sync status bar | `notesListHtml()` |
| Settings | **MODIFIED** — add Cloud Sync section | `settingsHtml()` |
| Login / Auth | **UNCHANGED** | `loginHtml()` |
| No Folder Open | **UNCHANGED** | `noFolderHtml()` |
| Note Editor | **UNCHANGED** | `noteEditorHtml()` |

---

## 4. New Screen: Welcome / Onboarding

### 4.1 Purpose

Shown on first open only (when `notenest.firstRunComplete === false`). Replaces the login screen as the entry point. Sets the tone: local by default, cloud optional.

### 4.2 Layout

Follows the same centred-column layout as `loginHtml()`: icon → title → description → actions.

```
┌─────────────────────────────┐
│                             │
│                             │
│         [📎 ICON]           │  96×96px, same as loginHtml
│                             │
│         NoteNest            │  font-size: 20px, font-weight: 600
│                             │
│   Project notes and code    │  font-size: 13px, muted colour
│   annotations, right        │  max-width: 240px, line-height: 1.6
│   inside VS Code.           │
│   No account needed.        │
│                             │
│  ┌─────────────────────┐    │
│  │  ▶  Get Started     │    │  PRIMARY button (.btn)
│  └─────────────────────┘    │  full-width, vscode-button-background
│                             │
│  ┌─────────────────────┐    │
│  │  ☁  Enable Cloud   │    │  SECONDARY button (.btn-secondary)
│  │     Sync            │    │  full-width, vscode-button-secondaryBackground
│  └─────────────────────┘    │
│                             │
│  Sync lets you view notes   │  font-size: 11px, muted, max-width: 200px
│  on the web and across      │  line-height: 1.5, text-align: center
│  machines. Requires a       │
│  free account.              │
│                             │
└─────────────────────────────┘
```

### 4.3 Button Behaviour

| Button | Action |
|---|---|
| Get Started | `vscode.postMessage({ type: 'getStarted' })` → sets `firstRunComplete = true`, navigates to notes list in local mode |
| Enable Cloud Sync | `vscode.postMessage({ type: 'enableSync' })` → sets `firstRunComplete = true`, `syncEnabled = true`, shows `loginHtml()` |

### 4.4 Existing User Variant

Shown when `firstRunComplete` is not set **AND** `context.secrets` already contains an `accessToken` (i.e. user had the old cloud-only version installed). Different copy, same layout:

```
┌─────────────────────────────┐
│                             │
│         [📎 ICON]           │
│                             │
│         Welcome back        │  h1 — different copy
│                             │
│   NoteNest now works        │  p — explains the change
│   offline by default.       │
│   Your existing notes are   │
│   still synced. Choose      │
│   how you'd like to work.   │
│                             │
│  ┌─────────────────────┐    │
│  │  ☁  Keep Cloud Sync │    │  PRIMARY — sets firstRunComplete,
│  └─────────────────────┘    │  keeps syncEnabled=true, goes to notes list
│                             │
│  ┌─────────────────────┐    │
│  │  💻  Switch to      │    │  SECONDARY — sets firstRunComplete,
│  │      Local Only     │    │  disables sync, clears tokens,
│  └─────────────────────┘    │  pulls notes locally
│                             │
└─────────────────────────────┘
```

### 4.5 CSS Classes

All new classes extend existing patterns — no new design tokens needed:

```css
/* Already exists — reuse exactly */
.btn { /* primary button */ }
.icon-container { /* icon wrapper */ }

/* New — follows same pattern as .btn */
.btn-secondary {
  width: 100%;
  padding: 10px 16px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transition: background 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;   /* gap between primary and secondary */
}
.btn-secondary:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

/* New — informational sub-copy below buttons */
.sync-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  text-align: center;
  max-width: 200px;
  line-height: 1.5;
  margin-top: 16px;
}
```

---

## 5. Modified Screen: Notes List

### 5.1 What Changes

One new element is added between the search bar and the notes list: a **sync status bar**. Everything else — toolbar, search, note rows, new-note input, empty state — is completely unchanged.

### 5.2 Sync Status Bar (Local Mode)

```
┌─────────────────────────────────────────────┐
│ BETTERSTRUCK                       [+]  [⚙] │  ← UNCHANGED toolbar
├─────────────────────────────────────────────┤
│  Search notes…                              │  ← UNCHANGED search bar
├─────────────────────────────────────────────┤
│ ○ Local only  ·  Enable cloud sync →        │  ← NEW sync status bar
├─────────────────────────────────────────────┤
│  ┌───────────────────────────────────────┐  │
│  │ 📌 jbjggug                    May 9   │  │  ← UNCHANGED note rows
│  │   just noting                         │  │
│  │   🔗 1 annotation                     │  │
│  └───────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐  │
│  │   Another note                May 8   │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 5.3 Sync Status Bar (Sync Mode — Connected)

```
├─────────────────────────────────────────────┤
│ ● Synced  ·  Last sync: 2 min ago           │  sync on, all good
├─────────────────────────────────────────────┤
```

### 5.4 Sync Status Bar (Sync Mode — Pending)

```
├─────────────────────────────────────────────┤
│ ↻ Syncing…                                  │  sync in progress
├─────────────────────────────────────────────┤
```

### 5.5 Sync Status Bar (Sync Mode — Error)

```
├─────────────────────────────────────────────┤
│ ⚠ Sync failed  ·  Retry →                  │  error, clickable retry
├─────────────────────────────────────────────┤
```

### 5.6 Sync Status Bar Styling

The bar occupies the same slot as the existing `.offline-banner`. It replaces it — the offline banner is retired and the sync status bar handles all states:

```css
.sync-status-bar {
  padding: 5px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 11px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  cursor: default;
}

/* Local mode — neutral, muted */
.sync-status-bar.local {
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

/* Synced — subtle green tint */
.sync-status-bar.synced {
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

/* Syncing — neutral */
.sync-status-bar.syncing {
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

/* Error — warning colours (same as existing .offline-banner) */
.sync-status-bar.error {
  background: var(--vscode-inputValidation-warningBackground);
  color: var(--vscode-inputValidation-warningForeground);
}

.sync-status-link {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
  text-decoration: none;
}
.sync-status-link:hover {
  text-decoration: underline;
}
```

### 5.7 `notesListHtml()` Signature Change

```typescript
// Before
function notesListHtml(projectName: string, notes: NoteItem[], offline?: boolean): string

// After
function notesListHtml(
  projectName: string,
  notes: NoteItem[],
  syncStatus: 'local' | 'syncing' | 'synced' | 'error',
  lastSyncAt?: string | null,
  syncError?: string | null
): string
```

The `offline?: boolean` parameter is removed. `syncStatus: 'local'` covers that case.

---

## 6. Modified Screen: Settings

### 6.1 What Changes

A new **Cloud Sync** section is inserted between the auto-show row and the colour picker. The logout button becomes conditional (only shown when sync is enabled).

### 6.2 Full Layout — Local Mode (sync off)

```
┌─────────────────────────────┐
│ ← Back                      │  ← UNCHANGED back button
│                             │
│ Settings                    │  ← UNCHANGED h2
│                             │
│ ─────────────────────────── │
│ Auto-show on project open   │  ← UNCHANGED
│                         [✓] │
│                             │
│ CLOUD SYNC                  │  ← NEW section label (.label class)
│ ─────────────────────────── │
│ Sync to web & across        │  ← NEW row
│ machines               [ ○] │  toggle OFF state
│                             │
│ Notes stay on this device   │  ← NEW hint text (.setting-hint)
│ until sync is enabled.      │  font-size: 11px, muted
│                             │
│ NOTE BACKGROUND COLOUR      │  ← UNCHANGED
│ ─────────────────────────── │
│ [■][■][■][■]                │
│ [■][■][■][■]                │
│ [■][■][■][■]                │
│                             │
│   (no logout button)        │  ← HIDDEN when sync is off
└─────────────────────────────┘
```

### 6.3 Full Layout — Sync Mode (sync on, authenticated)

```
┌─────────────────────────────┐
│ ← Back                      │
│                             │
│ Settings                    │
│                             │
│ ─────────────────────────── │
│ Auto-show on project open   │
│                         [✓] │
│                             │
│ CLOUD SYNC                  │
│ ─────────────────────────── │
│ Sync to web & across        │
│ machines               [●] │  toggle ON state
│                             │
│ ✓ Connected · user@x.com    │  ← NEW status line, muted green
│   Last sync: 5 min ago      │  ← NEW last sync line
│                             │
│   [ Sync Now ]              │  ← NEW secondary button
│                             │
│ NOTE BACKGROUND COLOUR      │
│ ─────────────────────────── │
│ [■][■][■][■]                │
│ [■][■][■][■]                │
│ [■][■][■][■]                │
│                             │
│ ─────────────────────────── │
│ [ ⇤  Sign out of NoteNest ] │  ← UNCHANGED logout button
│                             │  (shown only when sync on)
└─────────────────────────────┘
```

### 6.4 Toggle Behaviour

| Action | Result |
|---|---|
| Toggle OFF → ON | Fires `startLogin` flow (existing). On success, `syncEnabled = true`, triggers first sync |
| Toggle ON → OFF | Shows confirmation: "Disable sync? Your notes will stay on this device." → on confirm: clears tokens, sets `syncEnabled = false` |

### 6.5 `settingsHtml()` Signature Change

```typescript
// Before
function settingsHtml(autoShow: boolean, noteBgColor: string): string

// After
function settingsHtml(
  autoShow: boolean,
  noteBgColor: string,
  syncEnabled: boolean,
  syncUserEmail?: string | null,
  lastSyncAt?: string | null
): string
```

### 6.6 New CSS for Settings

```css
/* Follows existing .row pattern */
.setting-hint {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin: -6px 0 12px;
  line-height: 1.5;
}

.sync-connected {
  font-size: 11px;
  color: #3fb950;   /* same green as .status-badge.done */
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.sync-last {
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 10px;
}

.sync-now-btn {
  padding: 5px 12px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  margin-bottom: 16px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sync-now-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}
```

---

## 7. Unchanged Screens

The following screens require **zero changes**. Their HTML functions remain identical:

### 7.1 Login Screen (`loginHtml`)

Shown only when sync is enabled and no token exists. Copy may be reviewed later but structure is unchanged.

```
┌─────────────────────────────┐
│         [📎 ICON]           │
│                             │
│         NoteNest            │
│                             │
│  Your private project       │
│  notepad, synced across     │
│  all your devices.          │
│                             │
│  [ ⬛  Sign in / Sign up ]  │
└─────────────────────────────┘
```

### 7.2 No Folder Screen (`noFolderHtml`)

Shown in local mode when no workspace folder is open. Unchanged.

```
┌─────────────────────────────┐
│                             │
│       [📁 folder icon]      │
│                             │
│   No project folder open    │
│                             │
│  Open a folder to start     │
│  managing your project-     │
│  specific notes.            │
│                             │
│     [ 📁 Open Folder ]      │
└─────────────────────────────┘
```

### 7.3 Note Editor (`noteEditorHtml`)

The full note editor panel. Completely unchanged — local and sync modes both render the same editor.

---

## 8. Message Type Reference

All communication between the webview HTML and the extension host uses `vscode.postMessage()`. New types added:

| Message Type | Direction | Payload | Handler Action |
|---|---|---|---|
| `getStarted` | webview → host | `{}` | Set `firstRunComplete = true`, render notes list in local mode |
| `enableSync` | webview → host | `{}` | Set `firstRunComplete = true`, `syncEnabled = true`, show `loginHtml()` |
| `keepSync` | webview → host | `{}` | Set `firstRunComplete = true`, existing auth verified, render notes list in sync mode |
| `goLocalOnly` | webview → host | `{}` | Set `firstRunComplete = true`, `syncEnabled = false`, clear tokens, pull notes locally, render notes list |
| `toggleSync` | webview → host | `{ enabled: boolean }` | If true: start login flow. If false: show confirmation then disable |
| `syncNow` | webview → host | `{}` | Trigger manual sync — push all unsynced local notes to backend |
| `disconnectSync` | webview → host | `{}` | Clear tokens, set `syncEnabled = false`, notify user |

Existing message types (`startLogin`, `showList`, `openNote`, `newNote`, `deleteNote`, `openSettings`, `setSetting`, `logout`, `jumpToFile`, `saveNote`, `deleteAnnotation`, `saveAnnotation`, `openFolder`) are **unchanged**.

---

## 9. Render Decision Tree (Updated `render()` Logic)

```
render() called
       │
       ▼
  firstRunComplete?
  ┌────┴────┐
 NO        YES
  │         │
  ▼         ▼
Check    syncEnabled?
existing  ┌────┴────┐
token?   NO        YES
  │       │         │
  ▼       ▼         ▼
 token  noFolder? getTokens()
exists?    │         │
  │       NO  YES  token?   no token?
  ▼       │    │     │         │
Show     show  show  ▼         ▼
welcome  list  noFo  show     loginHtml()
(return  (local ldr  list
-ing      mode) Html (sync
user)            ()   mode)
  │
  ▼
welcomeHtml(existingUser: true)
```

In code terms:

```typescript
async function render() {
  const firstRunComplete = context.globalState.get<boolean>('notenest.firstRunComplete') ?? false;
  const syncEnabled = context.globalState.get<boolean>('notenest.syncEnabled') ?? false;

  if (!firstRunComplete) {
    // Check if returning user (had old version)
    const { accessToken } = await getTokens(secrets);
    webviewView.webview.html = welcomeHtml(iconUri, !!accessToken);
    return;
  }

  if (!syncEnabled) {
    // Local mode — no auth needed
    const folderPath = getFolderPath();
    if (!folderPath) { webviewView.webview.html = noFolderHtml(); return; }
    const notes = await readLocalNotes(folderPath);  // reads from globalStorageUri
    webviewView.webview.html = notesListHtml(projectName, notes, 'local');
    return;
  }

  // Sync mode — existing auth flow
  const { accessToken } = await getTokens(secrets);
  if (!accessToken && !(await refreshAccessToken(secrets))) {
    webviewView.webview.html = loginHtml(iconUri); return;
  }
  // ... existing API fetch and notesListHtml render
}
```

---

## 10. Accessibility

All new UI elements follow the same patterns already established:

- All buttons have visible focus outlines (`var(--vscode-focusBorder)`)
- All icon-only elements include `title` attributes for tooltip text
- Toggle inputs use native `<input type="checkbox">` with associated `<label>` — same as existing auto-show toggle
- Colour contrast: muted text (`var(--vscode-descriptionForeground)`) is used only for supplementary information, never for primary actions
- Keyboard navigation: all interactive elements are reachable by Tab and activated by Enter/Space

---

*End of document.*
