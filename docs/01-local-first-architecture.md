# NoteNest Extension — Local-First Architecture Plan

**Document type:** Architecture & Strategy  
**Status:** Approved for implementation  
**Version:** 1.0  
**Last updated:** 2026-05-09  

---

## 1. Executive Summary

NoteNest currently operates in a cloud-first mode: every note, annotation, and interaction requires an authenticated API session before anything is shown to the user. This document specifies the architectural shift to a **local-first model**, where the extension works entirely on the user's machine by default and cloud sync is an explicit, user-controlled opt-in.

This change removes the login gate for new users, makes the extension useful without an internet connection, and positions NoteNest as a credible alternative to purely-local tools like Code Annotation and NoteStack — while retaining the unique advantage of optional web access via cloud sync.

---

## 2. Problem Statement

### 2.1 Current Pain Points

| Pain Point | Impact |
|---|---|
| New users must create an account before seeing any value | High drop-off at first open |
| Extension is completely unusable without internet | Blocks users on poor or no connectivity |
| All data lives on the server; local cache is secondary | Data loss risk if backend goes down |
| Competitor extensions (Code Annotation, NoteStack) require zero sign-in | NoteNest feels heavyweight by comparison |
| Cloud-first forces trust before demonstrating value | Friction before adoption |

### 2.2 What Users Actually Need

Developers who install a VS Code extension want to start using it immediately. The cloud sync feature is valuable — but it should be discovered after the tool proves its worth locally, not demanded as a prerequisite.

---

## 3. Architecture Overview

### 3.1 Local-First Principle

> The local device is the primary source of truth. The cloud is an optional, user-controlled mirror.

All notes, annotations, and settings are stored on the user's machine in VS Code's `globalStorageUri` directory. The backend API is called only when the user explicitly enables cloud sync.

### 3.2 Storage Layers

```
┌─────────────────────────────────────────────────────────────────┐
│                        NoteNest Extension                       │
│                                                                 │
│  ┌───────────────────────────────┐   ┌─────────────────────┐   │
│  │       LOCAL STORAGE           │   │    CLOUD STORAGE     │   │
│  │  (always active, no account)  │   │  (opt-in, requires   │   │
│  │                               │   │     account)         │   │
│  │  context.globalStorageUri     │   │                      │   │
│  │  ├── notes/                   │   │  Railway backend     │   │
│  │  │   ├── {uuid}.json          │   │  PostgreSQL via      │   │
│  │  │   └── {uuid}.json          │   │  Prisma              │   │
│  │  ├── annotations/             │   │                      │   │
│  │  │   └── {noteId}.json        │   │  notenest-backend    │   │
│  │  └── meta.json                │   │  .up.railway.app     │   │
│  │      (index + settings)       │   │                      │   │
│  └───────────────────────────────┘   └─────────────────────┘   │
│                     ▲                          ▲                │
│                     │                          │                │
│              Always reads/writes          Only when             │
│              from here first              syncEnabled=true      │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Storage Technology Decision

| Option | Pros | Cons | Decision |
|---|---|---|---|
| `context.globalState` (current) | Already in use, VS Code manages it | All data in one SQLite key — degrades at scale, hard to inspect | **Migrate away** for note content |
| `context.globalStorageUri` + JSON files | One file per note, inspectable, portable, no size limits per-note | Requires manual directory/file management | **Use this** for notes and annotations |
| `context.globalState` for metadata | Lightweight, fast for small data | — | **Keep for** flags, settings, index |

**Decision:** Notes and annotations are stored as individual JSON files under `globalStorageUri`. The `globalState` keys are retained only for small metadata: `firstRunComplete`, `syncEnabled`, `offlineQueue`, and the notes index.

### 3.4 File Structure on Disk

```
~/Library/Application Support/Code/User/globalStorage/
└── {publisher}.notenest/
    ├── notes/
    │   ├── {uuid-1}.json          ← full note object
    │   ├── {uuid-2}.json
    │   └── {uuid-3}.json
    ├── annotations/
    │   └── {noteId}.json          ← array of annotations for that note
    └── meta.json                  ← { version, noteIndex: [{id, title, updatedAt, folderPath}] }
```

Each note JSON file schema:

```json
{
  "id": "uuid-v4",
  "title": "Fix the state machine",
  "content": "...",
  "editorMode": "wysiwyg",
  "pinned": false,
  "tags": ["refactor", "backend"],
  "priority": "urgent",
  "status": "open",
  "folderPath": "/Users/meshe/Repos/vsnotes",
  "createdAt": "2026-05-09T10:00:00.000Z",
  "updatedAt": "2026-05-09T14:30:00.000Z",
  "deletedAt": null,
  "syncedAt": null,
  "localId": "uuid-v4"
}
```

New fields vs. current schema:
- `deletedAt` — soft delete timestamp for sync reconciliation (null = not deleted)
- `syncedAt` — when this version was last successfully pushed to the cloud (null = never synced)
- `localId` — client-generated UUID that persists even after a server ID is assigned

---

## 4. State Machine: Extension Modes

```
┌─────────────────────────────────────────────────────────────────┐
│                      Extension States                           │
│                                                                 │
│  ┌──────────────┐    user clicks       ┌──────────────────┐    │
│  │  FIRST RUN   │ ─── "Get Started" ──▶│   LOCAL MODE     │    │
│  │              │                      │  (default, always│    │
│  │  welcomeHtml │ ─── "Enable Sync" ──▶│  works offline)  │    │
│  └──────────────┘         │            └──────────┬───────┘    │
│                           │                       │            │
│                           ▼              user enables sync     │
│                   ┌──────────────┐                │            │
│                   │  AUTH FLOW   │◀───────────────┘            │
│                   │  (loginHtml) │                             │
│                   └──────┬───────┘                             │
│                          │ auth success                        │
│                          ▼                                     │
│                   ┌──────────────┐    user disables sync       │
│                   │  SYNC MODE   │ ──────────────────────────▶ │
│                   │  (cloud on)  │         LOCAL MODE          │
│                   └──────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

### 4.1 GlobalState Flags

| Key | Type | Default | Purpose |
|---|---|---|---|
| `notenest.firstRunComplete` | boolean | `false` | Has the user dismissed the welcome screen |
| `notenest.syncEnabled` | boolean | `false` | Is cloud sync currently active |
| `notenest.syncedUserId` | string \| null | `null` | User ID from backend (for sync reconciliation) |
| `notenest.lastSyncAt` | string \| null | `null` | ISO timestamp of last successful full sync |

---

## 5. Data Flow by Mode

### 5.1 Local Mode (syncEnabled = false)

```
User creates a note
        │
        ▼
Generate UUID client-side (crypto.randomUUID())
        │
        ▼
Write {uuid}.json to globalStorageUri/notes/
        │
        ▼
Update meta.json index
        │
        ▼
Re-render sidebar from local files
        │
        No API call made at any point.
```

### 5.2 Sync Mode (syncEnabled = true, authenticated)

```
User creates/edits a note
        │
        ▼
Write to local first (identical to local mode)
        │
        ▼
Attempt POST/PATCH to backend API
    ├── SUCCESS → mark note.syncedAt = now
    │             update local file with serverId
    └── FAILURE → add to offlineQueue in globalState
                  show retry indicator
                  retry on next sync trigger or reconnect
```

### 5.3 First Sync (user enables sync for the first time)

```
User toggles sync ON in Settings
        │
        ▼
Show loginHtml (existing auth flow — unchanged)
        │
        ▼
Auth success → accessToken stored in context.secrets
        │
        ▼
Read all local notes from globalStorageUri/notes/
where syncedAt === null
        │
        ▼
POST /notes/bulk { notes: [...] }
        │
        ▼
Backend returns { created: [...], conflicts: [...] }
        │
        ├── No conflicts → mark all notes syncedAt = now
        │
        └── Conflicts exist → show conflict resolution prompt
                              (reuse existing warning message pattern)
```

---

## 6. Conflict Resolution Strategy

Since NoteNest is single-user (no collaboration), resolution is straightforward:

| Scenario | Resolution |
|---|---|
| Local note, no server copy | Push to server — local wins |
| Server note, no local copy | Pull to local — server wins |
| Both present, identical content | No conflict — mark synced |
| Both modified, different `updatedAt` | Last-write-wins by `updatedAt` |
| Both modified, same `updatedAt` (clock skew) | Local wins |
| Deleted locally, exists on server | Soft delete propagates upstream |
| Deleted on server, exists locally | Pull deletion — show one-time notification |

This extends the existing `flushOfflineQueue()` logic already in the extension.

---

## 7. Backend Changes Required

The extension can ship in local-only mode before any backend changes. The following are required only when sync is enabled:

| Change | Endpoint | Priority |
|---|---|---|
| Bulk note upload for first sync | `POST /notes/bulk` | Required for first-sync |
| Soft delete support | Add `deletedAt` field to Note model | Required for sync correctness |
| `localId` field on notes | Add `localId` to Note schema | Required to map local↔server records |
| Delta sync | `GET /notes?updatedAfter=ISO` | Required for efficient ongoing sync |
| Bulk annotation upload | `POST /annotations/bulk` | Required for first-sync |

---

## 8. Migration: Existing Authenticated Users

```
Existing user opens updated extension
        │
        ▼
Check: does context.secrets contain accessToken?
        │
    YES │                        NO │
        ▼                           ▼
Show migration variant        Show standard
of welcome screen:            welcome screen
"Welcome back. Your notes     (new user flow)
 are synced. Continue with
 sync or go local-only?"
        │
  ┌─────┴──────┐
  │            │
  ▼            ▼
Keep sync   Switch to local
(set sync   Pull all notes
= true,     to local files,
skip auth)  disable sync,
            clear tokens
```

---

## 9. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| User loses notes if VS Code is uninstalled | Medium | High | Warn in UI that uninstalling without sync enabled means data loss |
| Clock skew causes wrong LWW winner | Low | Medium | Use server timestamp as tiebreaker when available |
| `meta.json` index becomes stale | Low | Low | Rebuild index by scanning notes/ directory on startup if checksum fails |
| Large note count degrades file I/O | Low | Low | Cap at 500 notes locally; recommend enabling sync beyond that |
| Extension update wipes `globalStorageUri` | Very Low | High | VS Code guarantees `globalStorageUri` persists across extension updates per official API docs |

---

## 10. Success Criteria

- [ ] New user installs and creates a note without any account
- [ ] All features work in local mode (notes, annotations, gutter, CodeLens, hover)
- [ ] Sync can be enabled and disabled without data loss
- [ ] First sync correctly uploads all local notes to the backend
- [ ] Conflict resolution handles all common scenarios without data loss
- [ ] Existing authenticated users migrate gracefully
- [ ] No regression in any existing functionality

---

*End of document.*
