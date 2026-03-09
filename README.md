# ProjectNotes

Write notes for each VS Code project. They sync to the cloud so they're available across all your machines.

## Features

- 📝 **Multiple notes per project** — create as many notes as you need for each project
- ☁️ **Cloud sync** — notes are saved to your account and available everywhere
- 🎨 **Custom backgrounds** — choose from 12 background colours for your note editor
- ⚡ **Auto-save** — notes save automatically as you type, no manual saving needed
- 🔐 **Secure auth** — sign in once via the browser, stays logged in

## Getting Started

1. Click the **ProjectNotes icon** in the Activity Bar (left sidebar)
2. Click **Sign in / Sign up** and complete login in your browser
3. Open any project folder — your notes list for that project appears
4. Press **+** to create a new note, give it a name, and start writing

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `projectnotes.apiUrl` | Backend API URL | Hosted URL |
| `projectnotes.autoShow` | Show panel when opening a project | `true` |
| `projectnotes.noteBgColor` | Note editor background colour | `#1e1e1e` |
| `projectnotes.noteTextColor` | Note editor text colour | `#d4d4d4` |

## Self-hosting

If you want to run your own backend, clone the [projectnotes-backend](https://github.com/YOUR_USERNAME/projectnotes-backend) repo, deploy it, and set `projectnotes.apiUrl` to your server URL in VS Code settings.
