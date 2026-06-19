# NoteVs

Project notes and code annotations, right inside VS Code. Works fully offline — no account needed.

## Features

- 📝 **Multiple notes per project** — each folder gets its own isolated notes list
- 💻 **Local-first** — works completely offline, no account or internet required
- 🔗 **Code annotations** — select any lines in a file and attach a note to them (Cmd+Shift+N)
- 📦 **Export & Import** — back up your notes to a `.notevs/` folder in your repo; restore them anytime with full fidelity
- 🤖 **AI agent support** — Claude Code and Cursor can create, read, and annotate notes via MCP (auto-registered on install)
- 🎨 **Custom backgrounds** — 12 background colours for your note editor
- ⚡ **Auto-save** — notes save as you type
- 🔒 **Project-scoped** — notes in Project A never appear in Project B, even across multiple VS Code windows

## Getting Started

1. Click the **NoteVs icon** in the Activity Bar (left sidebar)
2. Open any project folder — your notes list for that project appears automatically
3. Press **+** to create a note and start writing

## Code Annotations

Select any lines in a file, then:
- Press **Cmd+Shift+N** (Mac) / **Ctrl+Shift+N** (Windows/Linux)
- Or right-click → **NoteVs: Annotate Selection**
- Or click the **📎 Annotate selection** status bar button

![Add Annotation picker — create a new note or attach to an existing one](screenshot/Screenshot%202026-06-20%20at%2000.43.38.png)

Annotated lines show a blue gutter highlight. Hover over them to see the note preview.

![Hover tooltip showing note title and preview over an annotated line](screenshot/Screenshot%202026-06-20%20at%2000.44.28.png)

Annotations are collapsible inside the note editor — click any annotation row to expand or collapse it.

![Note editor showing a code annotation with file and line link](screenshot/Screenshot%202026-06-20%20at%2000.44.40.png)

![Note editor in Markdown mode with annotation panel](screenshot/Screenshot%202026-06-20%20at%2000.44.52.png)

## Export & Import

Click the **`|→`** button in the sidebar toolbar to open the Export / Import menu.

### Exporting

Exporting creates a `.notevs/` folder at your repo root:

```
your-project/
  .notevs/
    notes.json          ← all note metadata + links to .md files
    root/
      my-note-abc123.md ← plain text, freely editable
    packages/api/
      other-note.md
```

- Each `.md` file contains **only the note text** — clean, no frontmatter, editable in any editor
- `notes.json` holds all metadata: title, status, priority, tags, Notion/Obsidian export state, Todoist/Google Tasks reminders, and annotations
- In a **monorepo**, notes are grouped into sub-folders matching your package structure (e.g. `.notevs/packages/api/`). Single repos use `.notevs/root/`
- Commit `.notevs/` to git so your notes travel with the repo

### Importing

Importing reads `.notevs/` from your current workspace root and restores all notes:

- **Full fidelity** — Notion export badges, Todoist/Google Tasks reminder badges, and code annotations all come back automatically, no re-linking needed
- **Idempotent** — notes that already exist are skipped; only new ones are added
- **External edits** — if you edited a `.md` file outside NoteVs, re-importing picks up the updated content
- **Workspace validation** — NoteVs checks that the export belongs to the current project before importing; warns you if it came from a different repo
- **Monorepo aware** — `folderPath` on each note is remapped automatically if the workspace has moved

### Use cases

- **Backup** — export before wiping your machine; import on the new one
- **Team sharing** — commit `.notevs/` so teammates can import project notes
- **Editing outside VS Code** — open the `.md` files in any editor, write freely, then re-import to sync the changes back into NoteVs

## AI Agent Support (MCP)

NoteVs includes a local MCP server that lets Claude Code, Cursor, and other AI agents read and write your project notes directly.

### Auto-registration

When NoteVs activates, it automatically registers itself with Claude Code, Cursor, and VS Code Copilot agent mode. Just **restart your agent** after installing NoteVs and the tools will be available — no manual setup needed.

### Manual setup (if auto-registration didn't work)

First, find the path to the MCP bridge. In your terminal:

**Mac/Linux:**
```bash
ls ~/.vscode/extensions/meshemugles1.notevs-*/dist/mcp-bridge.cjs
```

**Windows:**
```powershell
dir "$env:USERPROFILE\.vscode\extensions\meshemugles1.notevs-*\dist\mcp-bridge.cjs"
```

Then register it with your agent:

**Claude Code:**
```bash
claude mcp add-json notevs '{
  "type": "stdio",
  "command": "node",
  "args": ["BRIDGE_PATH"]
}' -s user
```

**Cursor** — add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "notevs": {
      "command": "node",
      "args": ["BRIDGE_PATH"]
    }
  }
}
```

**VS Code Copilot** — add to `~/.vscode/mcp.json`:
```json
{
  "mcpServers": {
    "notevs": {
      "command": "node",
      "args": ["BRIDGE_PATH"]
    }
  }
}
```

Replace `BRIDGE_PATH` with the path from the `ls` / `dir` command above.

> **Note:** VS Code must be open with NoteVs active for the MCP tools to work. The bridge talks to the extension over `localhost:37491`.

### Available tools

Once registered, you can talk to your notes naturally:

- _"List my notes for this project"_
- _"Create a note called 'Auth bug', priority urgent, tag backend"_
- _"Search my notes for anything about the login flow"_
- _"Add an annotation to src/auth.ts lines 45–52"_
- _"Mark the 'Fix race condition' note as done"_
- _"Export the 'Sprint plan' note to Notion"_
- _"Save the 'API design' note to my Obsidian vault"_
- _"Set a reminder for the 'Fix login bug' note for tomorrow at 09:00"_

#### Full tool reference

| Tool | What it does |
|---|---|
| `notevs_list_notes` | List all notes for the current project folder |
| `notevs_get_note` | Get full content + annotations for a note by id |
| `notevs_create_note` | Create a new note (title, content, tags, priority, status) |
| `notevs_save_note` | Update an existing note's fields |
| `notevs_delete_note` | Permanently delete a note |
| `notevs_add_annotation` | Attach a code annotation to a note (file + line range) |
| `notevs_search_notes` | Search notes by keyword |
| `notevs_export_to_notion` | Export a note to Notion (creates or updates page) |
| `notevs_export_to_obsidian` | Save a note to Obsidian vault as Markdown |
| `notevs_set_reminder` | Create a task in Todoist or Google Tasks for a note |

**Requirements for export/reminder tools:**
- `notevs_export_to_notion` — Notion token must be saved in Settings → Integrations → Exporting
- `notevs_export_to_obsidian` — Obsidian Local REST API key or vault folder must be configured in Settings → Integrations → Exporting
- `notevs_set_reminder` — Todoist API token or Google Tasks must be connected in Settings → Integrations → Tasks

Notes are always scoped to the repo the agent is running in.

## Settings

| Setting | Description | Default |
|---|---|---|
| `notevs.apiUrl` | Backend API URL (for cloud sync) | Hosted URL |
| `notevs.autoShow` | Show panel when opening a project | `true` |
| `notevs.noteBgColor` | Note editor background colour | `#1e1e1e` |
| `notevs.noteTextColor` | Note editor text colour | `#d4d4d4` |

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+N` / `Ctrl+Shift+N` | Annotate selected code |
| `Cmd+S` / `Ctrl+S` | Save note immediately |
| `Cmd+N` / `Ctrl+N` | New note (when sidebar is focused) |
