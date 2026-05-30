# NoteVs

Project notes and code annotations, right inside VS Code. Works fully offline — no account needed.

## Features

- 📝 **Multiple notes per project** — each folder gets its own isolated notes list
- 💻 **Local-first** — works completely offline, no account or internet required
- 🔗 **Code annotations** — select any lines in a file and attach a note to them (Cmd+Shift+N)
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

Annotated lines show a blue gutter highlight. Hover over them to see the note preview. Annotations are collapsible inside the note editor — click any annotation row to expand or collapse it.

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
