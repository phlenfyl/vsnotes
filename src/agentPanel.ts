/**
 * agentPanel.ts
 * Standalone WebviewPanel for the NoteVs agent chat (Rasa Heroes submission).
 * Opens beside the editor, same pattern as the note-detail panel in
 * extension.ts (openNotePanels: singleton-per-key map + .reveal() check).
 * This is a *singleton* panel — there's only ever one agent chat.
 *
 * Talks to two local-only processes, nothing else:
 *   - the local Rasa server (notevs.agentUrl, default http://localhost:5005)
 *   - the NoteVs MCP server (localhost:37492/health) purely to distinguish
 *     "Rasa is down" from "NoteVs/VS Code side is down" in the status pill —
 *     the agent itself reaches NoteVs via Rasa's own mcp_servers: config,
 *     not through this panel.
 *
 * Status shown to the user is a merge of two things: agentProcessManager's
 * setup/launch pipeline phase (extracting/creating_venv/installing/
 * starting/running/crashed/error — see agentProcess.ts) for "what's the
 * background process doing right now", and an HTTP poll of the Rasa server
 * itself for "is it actually answering requests yet" once the process has
 * been launched. Without both, a user has no way to tell "still installing"
 * apart from "installed but crashed" apart from "just hasn't finished
 * booting yet" — they'd all just look like a static "offline" pill.
 *
 * TO VERIFY (see rasa-notevs-agent/README.md "Open questions"): the actual
 * new-engine chat endpoint/port/response shape. This targets classic Rasa's
 * documented REST channel (POST {agentUrl}/webhooks/rest/webhook, body
 * {sender, message}, response an array of {text, buttons?, image?, custom?})
 * as the best available reference — confirm before relying on it.
 */

import * as vscode from 'vscode';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { agentChatHtml } from './agentPanelHtml';
import { MCP_PORT } from './mcpServer';
import type { AgentProcessManager } from './agentProcess';

interface RasaBotMessage {
  text?: string;
  image?: string;
  buttons?: Array<{ title: string; payload: string }>;
  custom?: unknown;
}

interface TranscriptEntry {
  role: 'user' | 'bot';
  text: string;
  at: string;
}

function getAgentUrl(): string {
  return vscode.workspace.getConfiguration('notevs').get<string>('agentUrl', 'http://localhost:5005');
}

// .notevsagent/ lives in the project root (not global storage) so it's
// visible/inspectable next to the code it's about, same spirit as
// .notevs/ for note export — but chat history is local scratch, not
// something to share or sync, so it's force-gitignored via its own
// .gitignore rather than relying on the user remembering to add one.
function ensureHistoryDir(folderPath: string): string {
  const dir = path.join(folderPath, '.notevsagent', 'history');
  fs.mkdirSync(dir, { recursive: true });
  const gitignorePath = path.join(folderPath, '.notevsagent', '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf8');
  }
  return dir;
}

function transcriptToMarkdown(entries: TranscriptEntry[]): string {
  if (!entries.length) { return '_(empty conversation)_\n'; }
  return entries.map((e) => {
    const label = e.role === 'user' ? '**You**' : '**NoteVs Agent**';
    return `${label} _(${e.at})_\n\n${e.text}\n`;
  }).join('\n---\n\n');
}

async function checkRasaStatus(): Promise<boolean> {
  try {
    // TO VERIFY: classic Rasa's bare `GET /` returns 200 with
    // "Hello from Rasa: <version>" as a liveness probe with no --enable-api
    // required. Confirm the new engine still answers on the same route.
    const { status } = await axios.get(getAgentUrl(), { timeout: 4000, validateStatus: () => true });
    return status >= 200 && status < 500;
  } catch { return false; }
}

async function checkNoteVsStatus(): Promise<boolean> {
  try {
    const { data } = await axios.get(`http://127.0.0.1:${MCP_PORT}/health`, { timeout: 3000 });
    return data?.ok === true;
  } catch { return false; }
}

// qwen/qwen3.6-27b (see rasa-notevs-agent/integrations.yml) is a reasoning
// model that sometimes emits its full <think>...</think> trace as the
// literal response text instead of just the final answer — confirmed
// live. Stripped here, at the one place every bot message passes through
// on its way out of Rasa, rather than relying on a provider-side
// reasoning_format flag this schema may not actually pass through.
function stripThinkTags(text: string): string {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // A truncated/unclosed <think> (e.g. cut off by a token limit) would
  // otherwise leak everything from that point on — strip to the end
  // rather than show a half-finished reasoning trace.
  cleaned = cleaned.replace(/<think>[\s\S]*$/i, '');
  return cleaned.replace(/^\s+/, '');
}

async function sendToRasa(senderId: string, text: string): Promise<RasaBotMessage[]> {
  const { data } = await axios.post(
    `${getAgentUrl().replace(/\/$/, '')}/webhooks/rest/webhook`,
    { sender: senderId, message: text },
    { timeout: 60000 },
  );
  const messages = Array.isArray(data) ? data as RasaBotMessage[] : [];
  return messages.map((m) => (m.text ? { ...m, text: stripThinkTags(m.text) } : m));
}

export function registerAgentChatCommand(
  context: vscode.ExtensionContext,
  getFolderPath: () => string | null,
  agentProcessManager: AgentProcessManager,
): vscode.Disposable {
  let agentPanel: vscode.WebviewPanel | undefined;
  // A fresh sender_id per chat "session" (initial open, or after New Chat)
  // is what makes New Chat a genuinely separate conversation to Rasa —
  // reusing one fixed id forever would mean Rasa's own session_expiration
  // is the only thing separating "old" from "new", which doesn't line up
  // with the user clicking a button to say "start over now".
  let senderId: string = randomUUID();
  let transcript: TranscriptEntry[] = [];
  // The history file this live transcript writes through to, once it has
  // one — set on the first persisted message of a brand-new chat, or
  // immediately on resuming a past one. Keeping it stable (rather than
  // stamping a fresh file per save) is what makes continuing a past chat
  // update that same .md/.json in place instead of forking a duplicate.
  let currentHistoryFile: string | undefined;

  function recordUserMessage(text: string) {
    transcript.push({ role: 'user', text, at: new Date().toISOString() });
  }
  function recordBotMessages(messages: RasaBotMessage[]) {
    const at = new Date().toISOString();
    for (const m of messages) {
      if (m.text) { transcript.push({ role: 'bot', text: m.text, at }); }
    }
  }

  // Maestro (calm_v2) gap confirmed empirically on 2026-08-17: the first
  // message of a brand-new session is entirely consumed by the automatic
  // `default_session_start__main` turn — it produces the canned greeting
  // and never routes the message's actual text to a skill at all. Message
  // #2+ in the same session routes correctly. Workaround: silently send a
  // one-off throwaway message the moment the agent comes online, before
  // the user has typed anything, so their real first message is already
  // turn 2 by the time it's sent. sessionPrimed resets on failure so a
  // flaky first attempt (agent reports running slightly before it's
  // actually accepting requests) retries on the next status poll instead
  // of leaving the session cold for the rest of the panel's lifetime.
  let sessionPrimed = false;
  let primingPromise: Promise<void> | null = null;
  // Self-scheduling rather than piggybacking on postStatus()'s poll
  // cadence — postStatus only re-runs on specific events (webview ready,
  // an agentProcessManager phase change, after a chat turn), not on a
  // steady interval, so if Rasa becomes reachable in between those it
  // could otherwise go unprimed for the rest of the panel's lifetime.
  // Returns a shared in-flight promise rather than firing-and-forgetting,
  // so handleUserText can await it (bounded — see there) instead of
  // racing a real user message against the priming request and
  // potentially eating the same swallowed-first-turn bug itself.
  function primeSessionWhenReady(): Promise<void> {
    if (sessionPrimed) { return Promise.resolve(); }
    if (primingPromise) { return primingPromise; }
    primingPromise = (async () => {
      while (agentPanel && !sessionPrimed) {
        if (await checkRasaStatus()) {
          try {
            const messages = await sendToRasa(senderId, 'hello');
            sessionPrimed = true;
            // Surface the swallowed-turn's own greeting instead of just
            // discarding it — it's a real reply from the agent (rephrased
            // per its persona), so showing it as the first bubble the user
            // sees is more honest than silently eating it, and confirms
            // the agent is actually alive before they've typed a word.
            // Shown once per actual rasa run/train cycle (sessionPrimed
            // resets on restart below), not once per panel open/close.
            if (agentPanel && messages.length) {
              agentPanel.webview.postMessage({ type: 'botMessages', messages });
              recordBotMessages(messages);
              persistTranscript();
            }
          } catch {
            // transient — fall through to the retry delay below
          }
        }
        if (!sessionPrimed) { await new Promise((resolve) => setTimeout(resolve, 3000)); }
      }
      primingPromise = null;
    })();
    return primingPromise;
  }

  let lastPhase: string | undefined;

  async function postStatus() {
    if (!agentPanel) { return; }
    const pipeline = agentProcessManager.getStatus();
    // 'starting' means agentProcess.ts is about to spawn a fresh `rasa
    // run` (first launch, or restart after a retrain/crash) — its
    // in-memory session tracker is gone, so the swallowed-first-turn bug
    // will hit again on the next real message. Re-prime (and re-show the
    // greeting) for the new run instead of assuming last run's priming
    // still counts.
    if (pipeline.phase === 'starting' && lastPhase !== 'starting') { sessionPrimed = false; }
    lastPhase = pipeline.phase;
    // Only worth polling the actual HTTP endpoint once the process manager
    // believes it has a running process — otherwise we already know why
    // it's not up (still installing, missing credentials, crashed, etc.)
    // and a failed poll would just be redundant noise.
    const [rasaUp, notevsUp] = pipeline.phase === 'running'
      ? await Promise.all([checkRasaStatus(), checkNoteVsStatus()])
      : [false, await checkNoteVsStatus()];
    agentPanel.webview.postMessage({ type: 'status', phase: pipeline.phase, message: pipeline.message, rasaUp, notevsUp });
  }

  async function handleUserText(text: string) {
    if (!agentPanel) { return; }
    agentPanel.webview.postMessage({ type: 'thinking', value: true });
    // Bounded wait, not indefinite: if the agent still isn't reachable
    // after 8s (still installing, crashed, etc.) fall through and let the
    // real send below fail/succeed on its own via the normal error path,
    // rather than hanging the whole chat on a session that may never prime.
    await Promise.race([primeSessionWhenReady(), new Promise((resolve) => setTimeout(resolve, 8000))]);
    recordUserMessage(text);
    try {
      const messages = await sendToRasa(senderId, text);
      if (messages.length) {
        agentPanel.webview.postMessage({ type: 'botMessages', messages });
        recordBotMessages(messages);
      } else {
        // The HTTP request succeeded (200) but Rasa returned no messages —
        // this is what a failed turn looks like from the REST channel's
        // side (e.g. an LLM error or Groq rate limit killed the turn
        // server-side; confirmed live via calm_v2.turn.failed in the
        // Output channel while the webhook itself still returned 200).
        // Silence here reads as the extension being broken, not the LLM
        // call — say so plainly instead of leaving the user guessing.
        agentPanel.webview.postMessage({
          type: 'botMessages',
          messages: [{ text: "Didn't get a reply back — the agent hit an error or rate limit processing that. Check the NoteVs Agent output channel for details, or just try again." }],
        });
      }
    } catch (err: unknown) {
      agentPanel.webview.postMessage({
        type: 'botMessages',
        messages: [{ text: `Couldn't reach the NoteVs agent — is the local Rasa server running? (${err instanceof Error ? err.message : String(err)})` }],
      });
    } finally {
      agentPanel.webview.postMessage({ type: 'thinking', value: false });
      persistTranscript();
      postStatus();
    }
  }

  // Writes the current transcript to .notevsagent/history/<stamp>.{md,json}
  // in the project root, without clearing it — a no-op if there's no open
  // folder (nowhere sensible to write) or nothing said yet. .md is for a
  // human reading the file directly (grep/editor); .json is the structured
  // copy the panel's own History dropdown reads back so it can re-render
  // the conversation as real chat bubbles instead of parsing markdown.
  // Writes through to currentHistoryFile every time rather than stamping a
  // new file per save, so continuing a resumed past chat keeps updating
  // that same file instead of forking a duplicate on every turn.
  function persistTranscript() {
    if (!transcript.length) { return; }
    const folderPath = getFolderPath();
    if (!folderPath) { return; }
    try {
      const dir = ensureHistoryDir(folderPath);
      if (!currentHistoryFile) {
        currentHistoryFile = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      }
      const base = currentHistoryFile.replace(/\.json$/, '');
      fs.writeFileSync(path.join(dir, `${base}.md`), transcriptToMarkdown(transcript), 'utf8');
      fs.writeFileSync(
        path.join(dir, `${base}.json`),
        JSON.stringify({ savedAt: new Date().toISOString(), senderId, entries: transcript }, null, 2),
        'utf8',
      );
    } catch (err) {
      // Best-effort — losing a history file isn't worth blocking the chat
      // over, but worth a trace for anyone debugging it later.
      console.error('[NoteVs Agent] Failed to persist chat history:', err);
    }
  }

  interface HistoryListItem { file: string; label: string; savedAt: string }

  function listHistoryEntries(): HistoryListItem[] {
    const folderPath = getFolderPath();
    if (!folderPath) { return []; }
    const dir = path.join(folderPath, '.notevsagent', 'history');
    if (!fs.existsSync(dir)) { return []; }
    const items: HistoryListItem[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) { continue; }
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { savedAt?: string; entries?: TranscriptEntry[] };
        const savedAt = parsed.savedAt ?? new Date(0).toISOString();
        const firstUser = parsed.entries?.find((e) => e.role === 'user')?.text ?? '(empty conversation)';
        const label = firstUser.length > 60 ? `${firstUser.slice(0, 60)}…` : firstUser;
        items.push({ file, label, savedAt });
      } catch { /* skip a corrupt entry rather than fail the whole list */ }
    }
    return items.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  function readHistoryEntry(file: string): { entries: TranscriptEntry[]; senderId?: string } | undefined {
    const folderPath = getFolderPath();
    if (!folderPath) { return undefined; }
    // Reject anything that isn't a bare filename we generated ourselves —
    // this value arrives via a webview postMessage, and even though this
    // panel's own script is the only thing that should send it, treat it
    // as untrusted input rather than trusting the source.
    if (!/^[\w.:-]+\.json$/.test(file)) { return undefined; }
    const filePath = path.join(folderPath, '.notevsagent', 'history', file);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { entries?: TranscriptEntry[]; senderId?: string };
      if (!parsed.entries) { return undefined; }
      return { entries: parsed.entries, senderId: parsed.senderId };
    } catch {
      return undefined;
    }
  }

  // Switches the live chat to a saved one so the user can keep talking in
  // it — not a read-only preview. Reuses the saved senderId when we have
  // one so the underlying Rasa tracker (server-side memory) picks up where
  // it left off instead of starting a cold session under a fresh id; older
  // history files saved before senderId was recorded fall back to a new
  // session (transcript still resumes, the agent just won't remember it).
  function resumeHistoryEntry(file: string) {
    if (!agentPanel) { return; }
    const result = readHistoryEntry(file);
    if (!result) { return; }
    persistTranscript();
    transcript = result.entries;
    currentHistoryFile = file;
    if (result.senderId) {
      senderId = result.senderId;
      sessionPrimed = true;
    } else {
      senderId = randomUUID();
      sessionPrimed = false;
      void primeSessionWhenReady();
    }
    agentPanel.webview.postMessage({ type: 'restoreTranscript', entries: transcript });
  }

  function startNewChat() {
    if (!agentPanel) { return; }
    persistTranscript();
    transcript = [];
    currentHistoryFile = undefined;
    senderId = randomUUID();
    sessionPrimed = false;
    agentPanel.webview.postMessage({ type: 'clearChat' });
    void primeSessionWhenReady();
  }

  // Fires regardless of whether the panel is currently open — postStatus()
  // itself no-ops if it isn't, so this is cheap to leave subscribed for the
  // extension's whole lifetime.
  const statusSub = agentProcessManager.onStatusChange(() => { postStatus(); void primeSessionWhenReady(); });

  // Without this, the pill only refreshes on the discrete events above
  // (panel open, a process-manager phase change, or after a chat turn) —
  // agentProcessManager's phase flips to 'running' the moment `rasa run`
  // is spawned, well before Rasa has actually finished loading the model
  // and started accepting requests, and nothing re-checks after that
  // until one of those events happens to fire again. Confirmed live: the
  // Output channel showed "Rasa server is up and running" while the pill
  // still said "Starting…" until the user sent a message. Poll while the
  // panel's open so the pill catches up on its own.
  const statusPollTimer = setInterval(() => { void postStatus(); }, 3000);

  const newChatCommand = vscode.commands.registerCommand('notevs.newAgentChat', () => { startNewChat(); });

  // The Command Palette / editor-title entry point just brings the panel
  // forward — the actual history browsing happens in-panel via the History
  // button, same UI whether you got there by clicking it directly or via
  // this command, rather than a second, different (QuickPick-based) flow.
  const viewHistoryCommand = vscode.commands.registerCommand('notevs.viewAgentHistory', () => {
    void vscode.commands.executeCommand('notevs.openAgentChat');
  });

  const openCommand = vscode.commands.registerCommand('notevs.openAgentChat', () => {
    if (agentPanel) { agentPanel.reveal(vscode.ViewColumn.Beside); return; }

    const folderPath = getFolderPath();
    const projectName = folderPath?.split(/[\/\\]/).filter(Boolean).pop() ?? 'No project';

    agentPanel = vscode.window.createWebviewPanel(
      'notevs.agentChat', 'NoteVs Agent',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    agentPanel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    agentPanel.webview.html = agentChatHtml(projectName);

    // Closing the panel does NOT end the Rasa session or archive it — the
    // underlying conversation (senderId) is still alive server-side, so
    // wiping the display on close while leaving the session running was
    // the actual bug (agent remembered everything, UI showed nothing).
    // Only startNewChat() (the explicit "New Chat" action) archives and
    // resets. A closed/reopened panel just gets its live transcript
    // replayed back in below.
    agentPanel.onDidDispose(() => { agentPanel = undefined; }, null, context.subscriptions);
    void primeSessionWhenReady();

    agentPanel.webview.onDidReceiveMessage(async (msg: { type: string; text?: string; file?: string }) => {
      if (msg.type === 'ready') {
        postStatus();
        if (transcript.length && agentPanel) {
          agentPanel.webview.postMessage({ type: 'restoreTranscript', entries: transcript });
        }
        return;
      }
      if (msg.type === 'checkStatus') { postStatus(); return; }
      if (msg.type === 'sendMessage' && msg.text) { await handleUserText(msg.text); return; }
      // Confirmation button clicks are re-sent as a normal message — Rasa's
      // REST channel button payloads (e.g. "/confirm") are meant to be
      // round-tripped back exactly like user-typed text.
      if (msg.type === 'buttonClick' && msg.text) { await handleUserText(msg.text); return; }
      if (msg.type === 'newChat') { startNewChat(); return; }
      if (msg.type === 'requestHistoryList') {
        agentPanel?.webview.postMessage({ type: 'historyList', items: listHistoryEntries() });
        return;
      }
      if (msg.type === 'openHistoryEntry' && msg.file) {
        resumeHistoryEntry(msg.file);
        return;
      }
    });
  });

  const statusPollDisposable = { dispose: () => clearInterval(statusPollTimer) };

  return vscode.Disposable.from(openCommand, newChatCommand, viewHistoryCommand, statusSub, statusPollDisposable);
}
