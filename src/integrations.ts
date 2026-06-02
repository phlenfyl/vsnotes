import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import axios from 'axios';

// ── Types (mirrored from extension.ts to keep this file self-contained) ────────

export interface NoteItem {
  id: string; title: string; content: string;
  updatedAt: string; pinned: boolean; tags: string[]; editorMode: string;
  priority: string; status: string;
  filePath?: string; lineStart?: number; lineEnd?: number; codeSnippet?: string;
  annotations?: unknown[];
  localId?: string; createdAt?: string; folderPath?: string;
  deletedAt?: string | null; syncedAt?: string | null;
}

// ── Content helpers ────────────────────────────────────────────────────────────

/**
 * Extract plain text from a NoteItem.
 * Handles both Quill Delta JSON (wysiwyg mode) and raw Markdown strings.
 */
export function extractPlainText(note: NoteItem): string {
  if (note.editorMode === 'markdown') {
    return note.content || '';
  }
  // Attempt Quill Delta JSON parse
  try {
    const delta = JSON.parse(note.content);
    if (delta && Array.isArray(delta.ops)) {
      return delta.ops
        .map((op: { insert?: unknown }) => (typeof op.insert === 'string' ? op.insert : ''))
        .join('')
        .trim();
    }
  } catch { /* not JSON — fall through */ }
  return note.content || '';
}

/**
 * Sanitise a note title into a safe filesystem filename (no extension).
 */
export function toObsidianFilename(title: string): string {
  return (title || 'Untitled')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'Untitled';
}

/**
 * Convert plain text to Notion paragraph block objects.
 * Each block holds up to 2000 chars (API hard limit per rich_text element).
 */
export function convertToNotionBlocks(text: string): object[] {
  if (!text) { return []; }
  const blocks: object[] = [];
  for (let i = 0; i < text.length; i += 2000) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: text.slice(i, i + 2000) } }],
      },
    });
  }
  return blocks;
}

/**
 * Build the full Obsidian Markdown file content with YAML frontmatter.
 */
export function convertToObsidianMarkdown(note: NoteItem): string {
  const safeTitle = (note.title || 'Untitled').replace(/"/g, '\\"');
  const tagsLine = note.tags && note.tags.length > 0
    ? `tags: [${note.tags.map(t => `"${t.replace(/"/g, '\\"')}"`).join(', ')}]`
    : '';
  const frontmatter = [
    '---',
    `title: "${safeTitle}"`,
    tagsLine,
    `priority: ${note.priority || 'none'}`,
    `status: ${note.status || 'open'}`,
    `created: ${(note.updatedAt || new Date().toISOString()).slice(0, 10)}`,
    `source: NoteNest`,
    '---',
  ].filter(Boolean).join('\n');

  const body = note.editorMode === 'markdown'
    ? (note.content || '')
    : extractPlainText(note);

  return `${frontmatter}\n\n# ${note.title || 'Untitled'}\n\n${body}`;
}

// ── Notion ─────────────────────────────────────────────────────────────────────

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';

function notionHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION,
  };
}

/**
 * Fetch all Notion pages accessible to this integration token.
 * Returns array of { id, title } sorted by title.
 */
async function fetchNotionPages(token: string): Promise<Array<{ id: string; title: string }>> {
  const res = await axios.post(
    `${NOTION_API}/search`,
    { filter: { value: 'page', property: 'object' }, page_size: 100 },
    { headers: notionHeaders(token) }
  );
  const results: Array<{ id: string; properties?: { title?: { title?: Array<{ plain_text?: string }> } } }> =
    res.data?.results ?? [];
  return results
    .map(p => ({
      id: p.id,
      title: p.properties?.title?.title?.[0]?.plain_text || '(untitled page)',
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Full Notion export flow.
 * - Prompts for token if not stored.
 * - Prompts for parent page if not stored.
 * - Creates a new Notion page every time (duplicates are intentional — v1).
 */
export async function sendToNotion(
  secrets: vscode.SecretStorage,
  globalState: vscode.Memento,
  note: NoteItem
): Promise<void> {
  // 1. Get or prompt for token
  let token = await secrets.get('notionToken');
  if (!token) {
    const entered = await vscode.window.showInputBox({
      title: 'Connect Notion',
      prompt: 'Paste your Notion integration token (starts with "secret_" or "ntn_")',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'secret_... or ntn_...',
      validateInput: v => (v && (v.startsWith('secret_') || v.startsWith('ntn_'))) ? undefined : 'Token must start with "secret_" or "ntn_"',
    });
    if (!entered) { return; }
    await secrets.store('notionToken', entered);
    token = entered;
    vscode.window.showInformationMessage('Notion token saved.');
  }

  // 2. Verify token and fetch accessible pages
  let pages: Array<{ id: string; title: string }>;
  try {
    pages = await fetchNotionPages(token);
  } catch (e: unknown) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      await secrets.delete('notionToken');
      vscode.window.showErrorMessage('Notion token is invalid. Cleared — please export again to re-enter it.');
    } else {
      vscode.window.showErrorMessage('Could not reach Notion. Check your internet connection.');
    }
    return;
  }

  if (pages.length === 0) {
    vscode.window.showWarningMessage(
      'No accessible pages found. Share a Notion page with your integration via "..." menu -> Add connections.'
    );
    return;
  }

  // 3. Get or pick parent page
  let parentPageId = globalState.get<string>('notevs.notionParentPageId', '');
  if (!parentPageId) {
    const picked = await vscode.window.showQuickPick(
      pages.map(p => ({ label: p.title, description: p.id, id: p.id })),
      { title: 'Choose a Notion page to export into', ignoreFocusOut: true }
    );
    if (!picked) { return; }
    parentPageId = picked.id;
    await globalState.update('notevs.notionParentPageId', parentPageId);
  }

  // 4. Build blocks from note content
  const plainText = extractPlainText(note);
  const blocks = convertToNotionBlocks(plainText);
  const MAX_BLOCKS = 100;
  const firstBatch = blocks.slice(0, MAX_BLOCKS);

  const payload = {
    parent: { page_id: parentPageId },
    properties: {
      title: {
        title: [{ type: 'text', text: { content: note.title || 'Untitled' } }],
      },
    },
    children: firstBatch,
  };

  // 5. Create the page
  let createdPageId = '';
  let pageUrl = '';
  try {
    const res = await axios.post(`${NOTION_API}/pages`, payload, { headers: notionHeaders(token) });
    createdPageId = res.data?.id ?? '';
    pageUrl = res.data?.url ?? '';
  } catch (e: unknown) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 401) {
      await secrets.delete('notionToken');
      vscode.window.showErrorMessage('Notion token is invalid. Cleared — please export again.');
    } else if (status === 404) {
      await globalState.update('notevs.notionParentPageId', '');
      vscode.window.showErrorMessage('Parent page not found. It may have been deleted or unshared. Please export again to pick a new page.');
    } else if (status === 403) {
      vscode.window.showErrorMessage('Access denied. Share the parent page with your NoteNest integration via "..." -> Add connections.');
    } else {
      vscode.window.showErrorMessage('Failed to create Notion page. Check your internet connection.');
    }
    return;
  }

  // 6. Append remaining blocks for very long notes (>100 blocks = >200,000 chars)
  if (blocks.length > MAX_BLOCKS && createdPageId) {
    const remaining = blocks.slice(MAX_BLOCKS);
    for (let i = 0; i < remaining.length; i += MAX_BLOCKS) {
      try {
        await axios.patch(
          `${NOTION_API}/blocks/${createdPageId}/children`,
          { children: remaining.slice(i, i + MAX_BLOCKS) },
          { headers: notionHeaders(token) }
        );
      } catch { break; }
    }
  }

  // 7. Success toast
  const choice = await vscode.window.showInformationMessage(
    `Exported "${note.title || 'Note'}" to Notion`,
    'Open in Notion'
  );
  if (choice === 'Open in Notion' && pageUrl) {
    vscode.env.openExternal(vscode.Uri.parse(pageUrl));
  }
}

export async function clearNotionToken(
  secrets: vscode.SecretStorage,
  globalState: vscode.Memento
): Promise<void> {
  await secrets.delete('notionToken');
  await globalState.update('notevs.notionParentPageId', '');
}

export async function resetNotionPage(globalState: vscode.Memento): Promise<void> {
  await globalState.update('notevs.notionParentPageId', '');
}

export async function hasNotionToken(secrets: vscode.SecretStorage): Promise<boolean> {
  return !!(await secrets.get('notionToken'));
}

// ── Obsidian ───────────────────────────────────────────────────────────────────

const OBSIDIAN_HTTPS_PORT = 27124;
const OBSIDIAN_HTTP_PORT  = 27123;

async function detectObsidianRestApi(apiKey: string): Promise<string | null> {
  for (const [proto, port] of [['https', OBSIDIAN_HTTPS_PORT], ['http', OBSIDIAN_HTTP_PORT]] as const) {
    const url = `${proto}://127.0.0.1:${port}`;
    try {
      await axios.get(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeout: 1500,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });
      return url;
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status) { return url; }
    }
  }
  return null;
}

async function writeToObsidianApi(
  baseUrl: string,
  apiKey: string,
  filename: string,
  content: string
): Promise<void> {
  const filePath = `NoteNest/${filename}.md`;
  await axios.put(
    `${baseUrl}/vault/${encodeURIComponent(filePath)}`,
    content,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'text/plain',
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 5000,
    }
  );
}

function writeToObsidianFilesystem(vaultPath: string, filename: string, content: string): void {
  const subdir = path.join(vaultPath, 'NoteNest');
  if (!fs.existsSync(subdir)) { fs.mkdirSync(subdir, { recursive: true }); }
  fs.writeFileSync(path.join(subdir, `${filename}.md`), content, 'utf8');
}

export async function sendToObsidian(
  secrets: vscode.SecretStorage,
  globalState: vscode.Memento,
  note: NoteItem
): Promise<void> {
  const apiKey    = await secrets.get('obsidianApiKey') || '';
  const vaultPath = globalState.get<string>('notevs.obsidianVaultPath', '');

  // Nothing configured — guide the user
  if (!apiKey && !vaultPath) {
    const choice = await vscode.window.showInformationMessage(
      'Connect Obsidian to NoteNest',
      { modal: false },
      'Use Local REST API plugin',
      'Use vault folder'
    );
    if (choice === 'Use Local REST API plugin') {
      const entered = await vscode.window.showInputBox({
        title: 'Obsidian — Local REST API key',
        prompt: 'Paste your API key from Obsidian -> Settings -> Local REST API',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'API key...',
      });
      if (!entered) { return; }
      await secrets.store('obsidianApiKey', entered);
      vscode.window.showInformationMessage('Obsidian API key saved. Click the Obsidian button again to export.');
    } else if (choice === 'Use vault folder') {
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
        title: 'Select your Obsidian vault folder',
        openLabel: 'Use this vault',
      });
      if (!picked || picked.length === 0) { return; }
      await globalState.update('notevs.obsidianVaultPath', picked[0].fsPath);
      vscode.window.showInformationMessage('Obsidian vault path saved. Click the Obsidian button again to export.');
    }
    return;
  }

  const content  = convertToObsidianMarkdown(note);
  const filename = toObsidianFilename(note.title);

  // Path A — REST API
  if (apiKey) {
    const baseUrl = await detectObsidianRestApi(apiKey);
    if (baseUrl) {
      try {
        await writeToObsidianApi(baseUrl, apiKey, filename, content);
        vscode.window.showInformationMessage(
          `Saved "${note.title || 'Note'}" to Obsidian (NoteNest/${filename}.md)`
        );
        return;
      } catch {
        if (!vaultPath) {
          vscode.window.showErrorMessage(
            'Obsidian REST API returned an error. Make sure Obsidian is open and the Local REST API plugin is enabled.'
          );
          return;
        }
        vscode.window.showWarningMessage('Obsidian REST API error — falling back to vault folder write.');
      }
    } else if (!vaultPath) {
      vscode.window.showErrorMessage(
        'Obsidian is not reachable. Make sure Obsidian is open with the Local REST API plugin enabled, or configure a vault folder in Settings.'
      );
      return;
    }
  }

  // Path B — Filesystem
  if (vaultPath) {
    if (!fs.existsSync(vaultPath)) {
      vscode.window.showErrorMessage(
        `Vault folder not found: ${vaultPath}\nUpdate it in NoteNest Settings -> Integrations.`
      );
      return;
    }
    try {
      writeToObsidianFilesystem(vaultPath, filename, content);
      vscode.window.showInformationMessage(
        `Saved "${note.title || 'Note'}" to Obsidian vault (NoteNest/${filename}.md)`
      );
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Failed to write to vault: ${(e as Error).message}`);
    }
  }
}

export async function clearObsidianApiKey(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete('obsidianApiKey');
}

export async function clearObsidianVaultPath(globalState: vscode.Memento): Promise<void> {
  await globalState.update('notevs.obsidianVaultPath', '');
}

export async function getObsidianStatus(
  secrets: vscode.SecretStorage,
  globalState: vscode.Memento
): Promise<{ apiKey: boolean; vaultPath: string }> {
  const apiKey = !!(await secrets.get('obsidianApiKey'));
  const vaultPath = globalState.get<string>('notevs.obsidianVaultPath', '');
  return { apiKey, vaultPath };
}
