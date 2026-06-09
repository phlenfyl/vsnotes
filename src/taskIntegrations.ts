import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import axios from 'axios';

// ── Google OAuth credentials (Desktop app — client_secret is public for this flow) ──
const GOOGLE_CLIENT_ID     = 'REDACTED_CLIENT_ID.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = 'REDACTED_CLIENT_SECRET';
const GOOGLE_TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL      = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TASKS_SCOPE   = 'https://www.googleapis.com/auth/tasks';
const GOOGLE_TASKS_API     = 'https://tasks.googleapis.com/tasks/v1';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TaskNoteItem {
  id: string;
  title: string;
  content: string;
  editorMode: string;
  priority: string;
}

export interface TaskReminderRecord {
  ts: string;
  due: string;
  taskId?: string;
  taskListId?: string; // Google Tasks — needed for update/delete
  recurrence?: string;
}

/** Callback fired on success so the caller can persist the reminder record. */
export type OnRemindedCallback = (
  provider: 'todoist' | 'googleTasks',
  record: TaskReminderRecord,
) => void;

// ── Shared helpers ────────────────────────────────────────────────────────────

export function extractTaskPlainText(note: TaskNoteItem): string {
  let text = '';
  if (note.editorMode === 'markdown') {
    text = note.content || '';
  } else {
    try {
      const delta = JSON.parse(note.content);
      if (delta && Array.isArray(delta.ops)) {
        text = delta.ops
          .map((op: { insert?: unknown }) => (typeof op.insert === 'string' ? op.insert : ''))
          .join('')
          .trim();
      }
    } catch {
      text = note.content || '';
    }
  }
  return text.slice(0, 250);
}

// ── Due date + time picker ────────────────────────────────────────────────────

interface DuePick {
  date: string;   // YYYY-MM-DD
  time: string | null;  // HH:MM or null
  dueString: string | null; // Todoist natural language string (recurrence), or null
}

const TIME_SLOTS = [
  '07:00', '08:00', '09:00', '10:00', '11:00', '12:00',
  '13:00', '14:00', '15:00', '16:00', '17:00', '18:00',
  '19:00', '20:00', '21:00',
];

async function pickDueDateTime(forProvider: 'todoist' | 'googleTasks'): Promise<DuePick | null> {
  const today = new Date();
  const fmt   = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return d; };
  const daysUntilSat = (6 - today.getDay() + 7) % 7 || 7;
  const daysUntilMon = (1 - today.getDay() + 7) % 7 || 7;

  // ── Step 1: Date ─────────────────────────────────────────────────────────────
  // For Todoist we also offer recurrence options as date shortcuts
  const dateItems: Array<{ label: string; detail?: string; value: string }> = [
    { label: 'Today',        detail: fmt(today),                 value: fmt(today) },
    { label: 'Tomorrow',     detail: fmt(addDays(1)),             value: fmt(addDays(1)) },
    { label: 'This weekend', detail: fmt(addDays(daysUntilSat)), value: fmt(addDays(daysUntilSat)) },
    { label: 'Next week',    detail: fmt(addDays(daysUntilMon)), value: fmt(addDays(daysUntilMon)) },
  ];

  if (forProvider === 'todoist') {
    dateItems.push(
      { label: '$(sync) Every day',      detail: 'Recurring — repeats daily',         value: '__rec_every day' },
      { label: '$(sync) Every weekday',  detail: 'Recurring — Mon–Fri',               value: '__rec_every weekday' },
      { label: '$(sync) Every week',     detail: `Recurring — weekly on ${today.toLocaleDateString(undefined, { weekday: 'long' })}`, value: `__rec_every ${today.toLocaleDateString(undefined, { weekday: 'long' }).toLowerCase()}` },
      { label: '$(sync) Every month',    detail: 'Recurring — same day each month',   value: '__rec_every month' },
      { label: '$(sync) Custom repeat…', detail: 'Enter a custom Todoist schedule',   value: '__rec_custom' },
    );
  }

  dateItems.push({ label: 'Pick a date…', detail: 'Enter a date manually (YYYY-MM-DD)', value: '__pick__' });

  const datePicked = await vscode.window.showQuickPick(dateItems, {
    title: forProvider === 'todoist' ? 'When? (Step 1 of 2)' : 'When is this due? (Step 1 of 2)',
    placeHolder: 'Select a date',
    ignoreFocusOut: true,
  });
  if (!datePicked) { return null; }

  // Handle Todoist recurring shortcuts
  if (datePicked.value.startsWith('__rec_')) {
    let dueString = datePicked.value.slice(6); // strip '__rec_'
    if (dueString === 'custom') {
      const entered = await vscode.window.showInputBox({
        title: 'Custom recurrence',
        prompt: 'Enter a Todoist schedule string, e.g. "every 2 weeks" or "every Monday and Friday"',
        placeHolder: 'every Monday',
        ignoreFocusOut: true,
        validateInput: v => v.trim().length > 2 ? undefined : 'Please enter a schedule',
      });
      if (!entered) { return null; }
      dueString = entered.trim();
    }
    return { date: fmt(today), time: null, dueString };
  }

  let date = datePicked.value;
  if (date === '__pick__') {
    const entered = await vscode.window.showInputBox({
      title: 'Enter a date',
      prompt: 'Format: YYYY-MM-DD',
      placeHolder: fmt(today),
      ignoreFocusOut: true,
      validateInput: v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? undefined : 'Please use YYYY-MM-DD format',
    });
    if (!entered) { return null; }
    date = entered;
  }

  // ── Step 2: Time ─────────────────────────────────────────────────────────────
  const timeItems: Array<{ label: string; detail?: string; value: string }> = [
    { label: 'No specific time', detail: 'Just a date', value: '__none__' },
    ...TIME_SLOTS.map(t => {
      const [h, m] = t.split(':').map(Number);
      const suffix = h < 12 ? 'AM' : 'PM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return { label: `${h12}:${m.toString().padStart(2, '0')} ${suffix}`, value: t };
    }),
    { label: 'Custom time…', detail: 'Enter HH:MM', value: '__pick__' },
  ];

  const googleNote = forProvider === 'googleTasks'
    ? '  ⓘ Google Tasks ignores time — only the date will be used'
    : undefined;

  const timePicked = await vscode.window.showQuickPick(timeItems, {
    title: forProvider === 'todoist' ? 'What time? (Step 2 of 2)' : 'What time? (Step 2 of 2)',
    placeHolder: googleNote ?? 'Select a time (optional)',
    ignoreFocusOut: true,
  });
  if (!timePicked) { return null; }

  let time: string | null = null;
  if (timePicked.value === '__none__') {
    time = null;
  } else if (timePicked.value === '__pick__') {
    const entered = await vscode.window.showInputBox({
      title: 'Enter a time',
      prompt: 'Format: HH:MM (24-hour)',
      placeHolder: '09:00',
      ignoreFocusOut: true,
      validateInput: v => /^\d{2}:\d{2}$/.test(v) ? undefined : 'Please use HH:MM format',
    });
    if (!entered) { return null; }
    time = entered;
  } else {
    time = timePicked.value;
  }

  return { date, time, dueString: null };
}

// ── Task provider routing ─────────────────────────────────────────────────────

export async function sendToTaskProvider(
  secrets: vscode.SecretStorage,
  globalState: vscode.Memento,
  note: TaskNoteItem,
  onReminded?: OnRemindedCallback,
): Promise<void> {
  const hasTodoist = await hasTodoistToken(secrets);
  const hasGoogle  = await isGoogleTasksConnected(secrets);

  if (!hasTodoist && !hasGoogle) {
    const choice = await vscode.window.showInformationMessage(
      'No task service connected. Go to Settings \u2192 Integrations \u2192 Tasks to connect Todoist or Google Tasks.',
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      vscode.commands.executeCommand('notevs.showSettings');
    }
    return;
  }

  if (hasTodoist && !hasGoogle) {
    await sendToTodoist(secrets, note, onReminded);
    return;
  }

  if (!hasTodoist && hasGoogle) {
    await sendToGoogleTasks(secrets, note, onReminded);
    return;
  }

  // Both configured — check saved preference first
  const saved = globalState.get<string>('notevs.taskProvider', '');
  if (saved === 'todoist') { await sendToTodoist(secrets, note, onReminded); return; }
  if (saved === 'google')  { await sendToGoogleTasks(secrets, note, onReminded); return; }

  // No preference — ask
  const providerPick = await vscode.window.showQuickPick(
    [
      { label: '$(list-ordered) Todoist',   description: 'Send to your Todoist inbox', value: 'todoist' },
      { label: '$(checklist) Google Tasks', description: 'Send to your Google Tasks',  value: 'google'  },
    ],
    { title: 'Where do you want to set this reminder?', ignoreFocusOut: true },
  );
  if (!providerPick) { return; }

  const rememberPick = await vscode.window.showQuickPick(
    [
      { label: '$(check) Yes, remember this choice', value: 'yes' },
      { label: '$(close) No, keep asking me',        value: 'no'  },
    ],
    { title: `Use ${providerPick.value === 'todoist' ? 'Todoist' : 'Google Tasks'} as default?`, ignoreFocusOut: true },
  );
  if (rememberPick?.value === 'yes') {
    await globalState.update('notevs.taskProvider', providerPick.value);
  }

  if (providerPick.value === 'todoist') {
    await sendToTodoist(secrets, note, onReminded);
  } else {
    await sendToGoogleTasks(secrets, note, onReminded);
  }
}

export async function clearTaskProviderPreference(globalState: vscode.Memento): Promise<void> {
  await globalState.update('notevs.taskProvider', '');
}

// ── Todoist ───────────────────────────────────────────────────────────────────

const TODOIST_API = 'https://api.todoist.com/api/v1';

function mapPriority(priority: string): number {
  switch (priority) {
    case 'emergency': return 1;
    case 'urgent':    return 1;
    case 'important': return 2;
    case 'medium':    return 3;
    default:          return 4;
  }
}

export async function hasTodoistToken(secrets: vscode.SecretStorage): Promise<boolean> {
  return !!(await secrets.get('todoistToken'));
}

export async function clearTodoistToken(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete('todoistToken');
}

export async function sendToTodoist(
  secrets: vscode.SecretStorage,
  note: TaskNoteItem,
  onReminded?: OnRemindedCallback,
): Promise<void> {
  // 1. Token
  let token = await secrets.get('todoistToken');
  if (!token) {
    const entered = await vscode.window.showInputBox({
      title: 'Connect Todoist',
      prompt: 'Get your token at: app.todoist.com/app/settings/integrations/developer',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'Paste your Todoist API token\u2026',
      validateInput: v => (v && v.trim().length > 10) ? undefined : 'Token looks too short',
    });
    if (!entered) { return; }
    await secrets.store('todoistToken', entered.trim());
    token = entered.trim();
    vscode.window.showInformationMessage('Todoist token saved.');
  }

  // 2. Date + time picker (includes recurrence options)
  const due = await pickDueDateTime('todoist');
  if (!due) { return; }

  // 3. Build payload
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: Record<string, any> = {
    content:     note.title || 'Untitled',
    description: extractTaskPlainText(note),
    priority:    mapPriority(note.priority),
  };

  if (due.dueString) {
    // Recurring — use due_string (Todoist natural language)
    payload.due_string = due.dueString;
  } else if (due.time) {
    // Date + time — use due_datetime in ISO format
    payload.due_datetime = `${due.date}T${due.time}:00`;
  } else {
    // Date only
    payload.due_date = due.date;
  }

  // 4. POST
  let taskId: string;
  try {
    const { data } = await axios.post(`${TODOIST_API}/tasks`, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    taskId = data.id;
  } catch (e: unknown) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      await secrets.delete('todoistToken');
      vscode.window.showErrorMessage('Invalid Todoist token \u2014 cleared. Click \u201cRemind me\u201d again to re-enter it.');
    } else if (status === 429) {
      vscode.window.showErrorMessage('Todoist rate limit hit. Try again in a moment.');
    } else if ((e as { code?: string })?.code === 'ENOTFOUND' || (e as { code?: string })?.code === 'ECONNREFUSED') {
      vscode.window.showErrorMessage('No internet connection. Task not sent.');
    } else {
      vscode.window.showErrorMessage(`Failed to create Todoist task. (${status ?? 'network error'})`);
    }
    return;
  }

  // 5. Callback — persist the reminder record
  const dueLabel = due.dueString ?? (due.time ? `${due.date} at ${due.time}` : due.date);
  onReminded?.('todoist', {
    ts:         new Date().toISOString(),
    due:        due.time ? `${due.date}T${due.time}` : due.date,
    taskId,
    recurrence: due.dueString ?? undefined,
  });

  // 6. Toast
  const taskUrl = `https://app.todoist.com/app/task/${taskId}`;
  const choice = await vscode.window.showInformationMessage(
    `\u2713 Reminder set in Todoist \u2014 ${dueLabel}`,
    'Open in Todoist \u2192',
  );
  if (choice === 'Open in Todoist \u2192') {
    vscode.env.openExternal(vscode.Uri.parse(taskUrl));
  }
}

// ── Google Tasks ──────────────────────────────────────────────────────────────

export async function isGoogleTasksConnected(secrets: vscode.SecretStorage): Promise<boolean> {
  return !!(await secrets.get('googleTasksAccessToken'));
}

export async function disconnectGoogleTasks(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete('googleTasksAccessToken');
  await secrets.delete('googleTasksRefreshToken');
  await secrets.delete('googleTasksExpiry');
}

async function ensureGoogleToken(secrets: vscode.SecretStorage): Promise<string | null> {
  const accessToken  = await secrets.get('googleTasksAccessToken');
  const refreshToken = await secrets.get('googleTasksRefreshToken');
  const expiryStr    = await secrets.get('googleTasksExpiry');

  if (!accessToken || !refreshToken) { return null; }

  const expiry = expiryStr ? new Date(expiryStr).getTime() : 0;
  if (Date.now() < expiry - 60_000) { return accessToken; }

  try {
    const { data } = await axios.post(GOOGLE_TOKEN_URL, new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });

    const newToken  = data.access_token as string;
    const expiresIn = (data.expires_in as number) ?? 3600;
    const newExpiry = new Date(Date.now() + expiresIn * 1000).toISOString();

    await secrets.store('googleTasksAccessToken', newToken);
    await secrets.store('googleTasksExpiry', newExpiry);
    return newToken;
  } catch {
    await disconnectGoogleTasks(secrets);
    return null;
  }
}

export async function connectGoogleTasks(secrets: vscode.SecretStorage): Promise<boolean> {
  return new Promise((resolve) => {
    let server: http.Server | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let listenPort = 0;

    const state = crypto.randomBytes(16).toString('hex');

    const cleanup = () => {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      if (server) { try { server.close(); } catch { /* ignore */ } server = null; }
    };

    server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404); res.end(); return;
      }

      const url      = new URL(req.url, 'http://127.0.0.1');
      const code     = url.searchParams.get('code');
      const retState = url.searchParams.get('state');

      const html = (msg: string) => `<!DOCTYPE html><html><head><meta charset="UTF-8"/><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1e1e1e;color:#d4d4d4;font-size:16px;text-align:center}</style></head><body><p>${msg}</p></body></html>`;

      if (!code || retState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(html('Auth failed. Please close this tab and try again.'));
        cleanup();
        vscode.window.showErrorMessage('Google Tasks: auth failed or was cancelled.');
        resolve(false);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html('\u2713 Google Tasks connected! You can close this tab and return to VS Code.'));

      cleanup(); // listenPort already captured before this runs

      try {
        const { data } = await axios.post(GOOGLE_TOKEN_URL, new URLSearchParams({
          code,
          client_id:     GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri:  `http://127.0.0.1:${listenPort}/callback`,
          grant_type:    'authorization_code',
        }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });

        const expiresIn = (data.expires_in as number) ?? 3600;
        const expiry    = new Date(Date.now() + expiresIn * 1000).toISOString();

        await secrets.store('googleTasksAccessToken', data.access_token as string);
        await secrets.store('googleTasksRefreshToken', data.refresh_token as string);
        await secrets.store('googleTasksExpiry', expiry);

        vscode.window.showInformationMessage('\u2713 Google Tasks connected!');
        resolve(true);
      } catch {
        vscode.window.showErrorMessage('Google Tasks: failed to exchange auth code. Please try again.');
        resolve(false);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = (server as http.Server).address() as { port: number } | null;
      listenPort = addr?.port ?? 0;
      if (!listenPort) { cleanup(); resolve(false); return; }

      const redirectUri = `http://127.0.0.1:${listenPort}/callback`;
      const authUrl = `${GOOGLE_AUTH_URL}?${new URLSearchParams({
        client_id:     GOOGLE_CLIENT_ID,
        redirect_uri:  redirectUri,
        response_type: 'code',
        scope:         GOOGLE_TASKS_SCOPE,
        access_type:   'offline',
        prompt:        'consent',
        state,
      }).toString()}`;

      vscode.env.openExternal(vscode.Uri.parse(authUrl));
      vscode.window.showInformationMessage('Complete Google sign-in in your browser\u2026');

      timeoutId = setTimeout(() => {
        cleanup();
        vscode.window.showErrorMessage('Google Tasks: auth timed out. Please try again.');
        resolve(false);
      }, 90_000);
    });

    server.on('error', () => {
      cleanup();
      vscode.window.showErrorMessage('Google Tasks: could not start auth server. Please try again.');
      resolve(false);
    });
  });
}

export async function sendToGoogleTasks(
  secrets: vscode.SecretStorage,
  note: TaskNoteItem,
  onReminded?: OnRemindedCallback,
): Promise<void> {
  // 1. Auth
  let token = await ensureGoogleToken(secrets);
  if (!token) {
    const ok = await connectGoogleTasks(secrets);
    if (!ok) { return; }
    token = await ensureGoogleToken(secrets);
    if (!token) { vscode.window.showErrorMessage('Google Tasks: could not get access token.'); return; }
  }

  // 2. Date + time picker (with Google-specific time caveat in placeholder)
  const due = await pickDueDateTime('googleTasks');
  if (!due) { return; }

  // 3. Task list
  let taskListId: string;
  try {
    const { data } = await axios.get(`${GOOGLE_TASKS_API}/users/@me/lists`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    const lists: Array<{ id: string; title: string }> = data.items ?? [];

    if (lists.length === 0) {
      vscode.window.showErrorMessage('No task lists found in your Google Tasks account.');
      return;
    } else if (lists.length === 1) {
      taskListId = lists[0].id;
    } else {
      const picked = await vscode.window.showQuickPick(
        lists.map(l => ({ label: l.title, value: l.id })),
        { title: 'Which task list?', placeHolder: 'Choose a Google Tasks list', ignoreFocusOut: true },
      );
      if (!picked) { return; }
      taskListId = picked.value;
    }
  } catch (e: unknown) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 401) {
      await disconnectGoogleTasks(secrets);
      vscode.window.showErrorMessage('Google Tasks: session expired. Please reconnect in Settings.');
    } else {
      vscode.window.showErrorMessage('Google Tasks: could not fetch task lists. Check your internet connection.');
    }
    return;
  }

  // 4. Create task — Google Tasks API only honours the date portion of `due`
  let createdTaskId = '';
  try {
    const { data: created } = await axios.post(
      `${GOOGLE_TASKS_API}/lists/${encodeURIComponent(taskListId)}/tasks`,
      {
        title:  note.title || 'Untitled',
        notes:  extractTaskPlainText(note),
        status: 'needsAction',
        due:    `${due.date}T00:00:00.000Z`,
      },
      {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      },
    );
    createdTaskId = created.id as string;
  } catch (e: unknown) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 401) {
      await disconnectGoogleTasks(secrets);
      vscode.window.showErrorMessage('Google Tasks: session expired. Please reconnect in Settings.');
    } else if (status === 429) {
      vscode.window.showErrorMessage('Google Tasks: rate limit hit. Try again in a moment.');
    } else if ((e as { code?: string })?.code === 'ENOTFOUND') {
      vscode.window.showErrorMessage('No internet connection. Task not sent.');
    } else {
      vscode.window.showErrorMessage(`Failed to create Google Task. (${status ?? 'network error'})`);
    }
    return;
  }

  // 5. Callback — store taskId and taskListId for future update/delete
  onReminded?.('googleTasks', {
    ts:         new Date().toISOString(),
    due:        due.date,
    taskId:     createdTaskId,
    taskListId,
  });

  vscode.window.showInformationMessage(`\u2713 Added to Google Tasks for ${due.date}${due.time ? ` (time not supported by Google Tasks API)` : ''}`);
}

// ── Task management (update / delete existing reminders) ──────────────────────

export interface ExistingReminder {
  provider: 'todoist' | 'googleTasks';
  taskId?: string;
  taskListId?: string;
  due: string;
  recurrence?: string;
}

/**
 * Show a management QuickPick for an already-set reminder.
 * Options: Open, Update due date, Remove reminder, Set another.
 * Returns 'cleared' if the reminder should be removed from the note,
 *         'updated' + new record if the date was changed,
 *         'new' if user wants to set an additional reminder,
 *         null if cancelled.
 */
export async function manageExistingReminder(
  secrets: vscode.SecretStorage,
  reminder: ExistingReminder,
  noteTitle: string,
): Promise<
  | { action: 'cleared' }
  | { action: 'updated'; record: TaskReminderRecord }
  | { action: 'new' }
  | null
> {
  const providerLabel = reminder.provider === 'todoist' ? 'Todoist' : 'Google Tasks';
  const dueLabel = reminder.recurrence ? reminder.recurrence : reminder.due.slice(0, 10);

  const items: Array<{ label: string; detail?: string; value: string }> = [];

  // Open in browser (Todoist only — we have the URL)
  if (reminder.provider === 'todoist' && reminder.taskId) {
    items.push({ label: `$(link-external) Open in ${providerLabel}`, detail: `View task: “${noteTitle}”`, value: 'open' });
  }

  items.push(
    { label: `$(calendar) Update due date`, detail: `Currently: ${dueLabel}`, value: 'update' },
    { label: `$(trash) Remove reminder`, detail: `Delete this task from ${providerLabel}`, value: 'delete' },
    { label: `$(add) Set another reminder`, detail: 'Create an additional task', value: 'new' },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: `⏰ ${providerLabel} reminder — ${dueLabel}`,
    placeHolder: 'What would you like to do?',
    ignoreFocusOut: true,
  });
  if (!picked) { return null; }

  if (picked.value === 'open' && reminder.provider === 'todoist' && reminder.taskId) {
    vscode.env.openExternal(vscode.Uri.parse(`https://app.todoist.com/app/task/${reminder.taskId}`));
    return null;
  }

  if (picked.value === 'new') {
    return { action: 'new' };
  }

  if (picked.value === 'delete') {
    await deleteReminder(secrets, reminder);
    return { action: 'cleared' };
  }

  if (picked.value === 'update') {
    const newRecord = await updateReminderDue(secrets, reminder);
    if (!newRecord) { return null; }
    return { action: 'updated', record: newRecord };
  }

  return null;
}

async function deleteReminder(
  secrets: vscode.SecretStorage,
  reminder: ExistingReminder,
): Promise<void> {
  if (!reminder.taskId) {
    vscode.window.showWarningMessage('No task ID stored — cannot delete. The reminder record will be cleared locally.');
    return;
  }

  if (reminder.provider === 'todoist') {
    const token = await secrets.get('todoistToken');
    if (!token) { vscode.window.showErrorMessage('Todoist not connected.'); return; }
    try {
      await axios.delete(`${TODOIST_API}/tasks/${reminder.taskId}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404) { /* already gone — clear locally */ }
      else if (status === 401) { await secrets.delete('todoistToken'); vscode.window.showErrorMessage('Todoist token invalid — cleared.'); return; }
      else { vscode.window.showErrorMessage(`Failed to delete Todoist task. (${status ?? 'network error'})`); return; }
    }
    vscode.window.showInformationMessage('Todoist task deleted.');
  } else {
    // Google Tasks — need taskListId
    if (!reminder.taskListId) { vscode.window.showWarningMessage('Task list ID not stored — clearing reminder locally only.'); return; }
    const token = await ensureGoogleToken(secrets);
    if (!token) { vscode.window.showErrorMessage('Google Tasks: not connected.'); return; }
    try {
      await axios.delete(
        `${GOOGLE_TASKS_API}/lists/${encodeURIComponent(reminder.taskListId)}/tasks/${encodeURIComponent(reminder.taskId)}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 },
      );
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404) { /* already gone */ }
      else { vscode.window.showErrorMessage(`Failed to delete Google Task. (${status ?? 'network error'})`); return; }
    }
    vscode.window.showInformationMessage('Google Task deleted.');
  }
}

async function updateReminderDue(
  secrets: vscode.SecretStorage,
  reminder: ExistingReminder,
): Promise<TaskReminderRecord | null> {
  const due = await pickDueDateTime(reminder.provider);
  if (!due) { return null; }

  if (!reminder.taskId) {
    vscode.window.showWarningMessage('No task ID stored — cannot update on service. Reminder date updated locally only.');
    return {
      ts:         new Date().toISOString(),
      due:        due.time ? `${due.date}T${due.time}` : due.date,
      taskId:     reminder.taskId,
      taskListId: reminder.taskListId,
      recurrence: due.dueString ?? undefined,
    };
  }

  if (reminder.provider === 'todoist') {
    const token = await secrets.get('todoistToken');
    if (!token) { vscode.window.showErrorMessage('Todoist not connected.'); return null; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: Record<string, any> = {};
    if (due.dueString)     { payload.due_string   = due.dueString; }
    else if (due.time)     { payload.due_datetime = `${due.date}T${due.time}:00`; }
    else                   { payload.due_date     = due.date; }

    try {
      await axios.post(`${TODOIST_API}/tasks/${reminder.taskId}`, payload, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      });
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      vscode.window.showErrorMessage(`Failed to update Todoist task. (${status ?? 'network error'})`);
      return null;
    }
    vscode.window.showInformationMessage(`\u2713 Todoist task updated.`);
    return {
      ts:         new Date().toISOString(),
      due:        due.time ? `${due.date}T${due.time}` : due.date,
      taskId:     reminder.taskId,
      recurrence: due.dueString ?? undefined,
    };
  } else {
    // Google Tasks
    if (!reminder.taskListId) { vscode.window.showWarningMessage('Task list ID not stored — updating locally only.'); }
    else {
      const token = await ensureGoogleToken(secrets);
      if (!token) { vscode.window.showErrorMessage('Google Tasks: not connected.'); return null; }
      try {
        await axios.patch(
          `${GOOGLE_TASKS_API}/lists/${encodeURIComponent(reminder.taskListId)}/tasks/${encodeURIComponent(reminder.taskId)}`,
          { due: `${due.date}T00:00:00.000Z` },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 },
        );
      } catch (e: unknown) {
        const status = (e as { response?: { status?: number } })?.response?.status;
        vscode.window.showErrorMessage(`Failed to update Google Task. (${status ?? 'network error'})`);
        return null;
      }
      vscode.window.showInformationMessage(`\u2713 Google Task updated to ${due.date}.`);
    }
    return {
      ts:         new Date().toISOString(),
      due:        due.date,
      taskId:     reminder.taskId,
      taskListId: reminder.taskListId,
    };
  }
}
