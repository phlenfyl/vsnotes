/**
 * agentProcess.ts
 * Fully automates the local Rasa agent server — zero terminal commands.
 * The moment both credentials (Groq API key, Rasa license) are saved in
 * Settings → Agent, this:
 *   1. extracts the bundled agent project (resources/rasa-agent-template)
 *      to a per-user managed folder in global storage, if not there yet
 *   2. creates a Python venv there, if not there yet
 *   3. pip-installs rasa-pro into it, if not done yet (marked by a sentinel
 *      file so this only runs once, not on every restart)
 *   4. runs `python -m rasa run` with the credentials injected as env vars
 *
 * `notevs.agentRepoPath` is an optional override (point it at a folder
 * with your own agent.yml/skills/etc. — e.g. the standalone
 * rasa-notevs-agent dev repo — instead of the bundled/managed copy).
 * Leave it empty for the fully-automatic path described above.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';

const INITIAL_RESTART_DELAY_MS = 3000;
const MAX_RESTART_DELAY_MS = 30000;
const MIN_HEALTHY_UPTIME_MS = 10000; // below this, a crash counts toward backoff growth
// Bumped to v2 on the switch to the Maestro/skills-architecture dev build
// (rasa-pro==3.19.0.dev5, pinned in requirements.txt) — existing users'
// venvs already have the marker from the classic-engine 3.18.1 install, so
// the version bump alone wouldn't trigger a reinstall without also
// changing this filename.
const DEPS_INSTALLED_MARKER = '.deps_installed_v2';

function getAgentRepoPathOverride(): string {
  return vscode.workspace.getConfiguration('notevs').get<string>('agentRepoPath', '').trim();
}

// GUI-launched VS Code often has a minimal PATH that's missing Homebrew
// (/opt/homebrew/bin) or pyenv shims — append the common install locations
// so a compatible interpreter can still be found even if it's not on the
// PATH the extension host inherited.
const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', path.join(process.env.HOME ?? '', '.pyenv', 'shims')];

function pathWithExtras(): string {
  return [process.env.PATH ?? '', ...EXTRA_PATH_DIRS].join(path.delimiter);
}

// rasa-pro supports Python 3.10-3.13 only (not yet 3.14+). A plain
// `python3` can resolve to whatever's newest on the system (e.g. Homebrew
// defaults to the latest release), which pip then silently rejects with
// "No matching distribution found" — so find a compatible interpreter
// explicitly rather than assuming `python3` is it.
function findCompatiblePython(output: vscode.OutputChannel): string | undefined {
  const env = { ...process.env, PATH: pathWithExtras() };
  const candidates = process.platform === 'win32'
    ? ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python']
    : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], { env, encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) { continue; }
    const version = result.stdout.trim();
    if (COMPATIBLE_VERSIONS.includes(version)) {
      output.appendLine(`[NoteVs Agent] Using ${candidate} (Python ${version})`);
      return candidate;
    }
  }
  return undefined;
}

const COMPATIBLE_VERSIONS = ['3.10', '3.11', '3.12', '3.13'];

function isCompatibleInterpreter(pythonPath: string): boolean {
  const result = spawnSync(pythonPath, ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], { encoding: 'utf8' });
  return result.status === 0 && COMPATIBLE_VERSIONS.includes((result.stdout ?? '').trim());
}

// Hashes everything that actually affects `rasa train`'s output so a stale
// trained model can be detected and retrained automatically instead of
// silently serving out-of-date behavior forever (the failure mode before
// this: editing a skill did nothing until someone noticed responses were
// wrong and manually deleted models/). Watched paths match the Maestro
// (calm_v2) project layout — agent.yml, integrations.yml, skills/*/skill.md
// + memory.yml + tools.py, and the shared tools/ folder — not classic
// CALM's domain.yml/config.yml/data/, which this project no longer has
// (see classic-engine-backup/ in the template for the retired equivalents).
function computeTrainingSourceHash(repoPath: string): string {
  const hash = createHash('sha256');
  const files: string[] = [];
  for (const name of ['agent.yml', 'integrations.yml', 'memory.yml']) {
    const p = path.join(repoPath, name);
    if (fs.existsSync(p)) { files.push(p); }
  }
  for (const dirName of ['skills', 'tools']) {
    const dir = path.join(repoPath, dirName);
    if (!fs.existsSync(dir)) { continue; }
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.name === '__pycache__') { continue; }
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full); } else { files.push(full); }
      }
    };
    walk(dir);
  }
  for (const f of files.sort()) {
    hash.update(f);
    hash.update(fs.readFileSync(f));
  }
  return hash.digest('hex');
}

function venvPython(repoPath: string): string {
  return process.platform === 'win32'
    ? path.join(repoPath, '.venv', 'Scripts', 'python.exe')
    : path.join(repoPath, '.venv', 'bin', 'python');
}

// `rasa run` binds this by default when no --port is passed. Kept as the
// *preferred* port (tried first, for back-compat with anyone who's set
// notevs.agentUrl expecting 5005) — no longer the only port: see
// findFreePort below. Each VS Code window runs its own isolated `rasa run`
// (globalStorage/the managed repo folder is shared, but the running
// *process* is not), so with more than one window open they can't all
// bind 5005 at once.
const PREFERRED_AGENT_PORT = 5005;
const MAX_PORT_ATTEMPTS = 30;

function portListenerPids(port: number): string[] {
  if (process.platform === 'win32') { return []; } // lsof isn't available; leave EADDRINUSE to surface as-is
  const lsof = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  return (lsof.stdout ?? '').split('\n').map(s => s.trim()).filter(Boolean);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Matching on the spawned command path doesn't work: venvs' bin/python is a
// symlink chain (.venv/bin/python -> python3.12 -> the real Homebrew
// Python.framework binary), and `ps -o command=` reports that fully-resolved
// target, not the path we invoked — so a straight string comparison against
// venvPython(repoPath) never matches, silently skipping every real orphan.
// The process's *cwd* isn't affected by that resolution (we set it via
// spawn's `cwd` option, unrelated to which binary got exec'd) and lsof
// reports it exactly, so match on that instead.
function processCwd(pid: string): string | undefined {
  const result = spawnSync('lsof', ['-p', pid, '-a', '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
  const line = (result.stdout ?? '').split('\n').find(l => l.startsWith('n'));
  return line?.slice(1);
}

// VS Code doesn't guarantee dispose() runs before a new extension host
// activates a fresh AgentProcessManager for the *same* window (e.g. mid-
// update, or a fast reload racing a slow asyncio/Sanic shutdown) — when
// that happens the old `rasa run` child is orphaned: still bound to
// PREFERRED_AGENT_PORT, but with no surviving `child` reference (that was
// a closure var in the old host) for anyone to kill. Only clean up a
// process whose own cwd resolves to *this* repoPath — i.e. verifiably a
// leftover from this same managed folder, not some other window's live
// instance or an unrelated dev server — then the caller can retry the
// preferred port instead of immediately falling back further.
async function killIfOwnOrphan(port: number, repoPath: string, output: vscode.OutputChannel): Promise<void> {
  const pids = portListenerPids(port);
  if (pids.length === 0) { return; }
  const ownPids = pids.filter((pid) => processCwd(pid) === repoPath);
  if (ownPids.length === 0) { return; }
  output.appendLine(`[NoteVs Agent] Port ${port} is held by leftover NoteVs Agent process(es) from a previous session of this window (PID ${ownPids.join(', ')}) — stopping ${ownPids.length > 1 ? 'them' : 'it'}.`);
  for (const pid of ownPids) {
    try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
  }
  for (let i = 0; i < 20; i++) {
    if (portListenerPids(port).length === 0) { return; }
    await sleep(100);
  }
  for (const pid of ownPids) {
    try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
  }
  await sleep(200);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '127.0.0.1');
  });
}

// Finds a free port for this window's own `rasa run`, preferring
// PREFERRED_AGENT_PORT (cleaning up a same-window orphan there first, so a
// simple reload keeps using the same port instead of creeping upward every
// time) and falling back to the next free port when something else — a
// different window's already-running agent, most commonly — legitimately
// holds it. There's a small bind race between this check and rasa's own
// bind moments later, same as any "find a free port" approach; acceptable
// here since a collision just means the next restart tries again.
async function findFreePort(repoPath: string, output: vscode.OutputChannel): Promise<number> {
  await killIfOwnOrphan(PREFERRED_AGENT_PORT, repoPath, output);
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
    const candidate = PREFERRED_AGENT_PORT + offset;
    if (await isPortFree(candidate)) { return candidate; }
  }
  throw new Error(`No free port found in ${PREFERRED_AGENT_PORT}-${PREFERRED_AGENT_PORT + MAX_PORT_ATTEMPTS - 1}`);
}

export type AgentPhase =
  | 'missing_credentials'
  | 'extracting'
  | 'creating_venv'
  | 'installing'
  | 'training'
  | 'starting'
  | 'running'
  | 'crashed'
  | 'error';

export interface AgentStatus {
  phase: AgentPhase;
  message?: string;
}

export interface AgentProcessManager {
  disposables: vscode.Disposable[];
  onStatusChange: vscode.Event<AgentStatus>;
  getStatus: () => AgentStatus;
  // The actual port this window's own `rasa run` ended up bound to (see
  // findFreePort) — undefined until it's actually running. agentPanel.ts
  // prefers this over the static notevs.agentUrl setting so each window
  // talks to its own agent instance, not whichever port the setting
  // happens to name.
  getPort: () => number | undefined;
}

function runToCompletion(command: string, args: string[], cwd: string, output: vscode.OutputChannel, env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    output.appendLine(`[NoteVs Agent] $ ${command} ${args.join(' ')}`);
    const proc = spawn(command, args, { cwd, env: env ?? process.env });
    proc.stdout?.on('data', (chunk: Buffer) => output.append(chunk.toString()));
    proc.stderr?.on('data', (chunk: Buffer) => output.append(chunk.toString()));
    proc.on('error', (err) => { output.appendLine(`[NoteVs Agent] Failed to run ${command}: ${err.message}`); resolve(1); });
    proc.on('exit', (code) => resolve(code ?? 1));
  });
}

export function registerAgentProcessManager(
  context: vscode.ExtensionContext,
  mcpPort: number,
  getFolderPath: () => string | null,
): AgentProcessManager {
  const output = vscode.window.createOutputChannel('NoteVs Agent');
  const managedRepoPath = path.join(context.globalStorageUri.fsPath, 'rasa-agent');
  const templatePath = path.join(context.extensionUri.fsPath, 'resources', 'rasa-agent-template');

  const statusEmitter = new vscode.EventEmitter<AgentStatus>();
  let status: AgentStatus = { phase: 'missing_credentials' };
  function setStatus(next: AgentStatus) {
    status = next;
    statusEmitter.fire(status);
  }

  let child: ChildProcess | undefined;
  let resolvedPort: number | undefined;
  let disposed = false;
  let starting = false; // guards against overlapping setup/start pipelines
  let restartDelay = INITIAL_RESTART_DELAY_MS;
  let restartTimer: NodeJS.Timeout | undefined;

  function stopChild() {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
    if (child && !child.killed) { child.kill(); }
    child = undefined;
    resolvedPort = undefined;
  }

  function scheduleRestart() {
    if (disposed) { return; }
    if (restartTimer) { return; }
    output.appendLine(`[NoteVs Agent] Restarting in ${Math.round(restartDelay / 1000)}s...`);
    restartTimer = setTimeout(() => { restartTimer = undefined; void startPipeline(); }, restartDelay);
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY_MS);
  }

  // Classic-CALM-only files/dirs that used to be part of the bundled
  // template and no longer are, now that the template is a Maestro
  // (calm_v2) project. cpSync only adds/overwrites — it never deletes — so
  // an already-extracted managed folder from before the Maestro switch
  // would otherwise keep these forever, sitting alongside agent.yml/
  // skills/. The real `rasa init --engine maestro` scaffold's AGENTS.md is
  // explicit that a calm_v2 project must not have domain.yml/config.yml/
  // data/ present, so stale copies here risk rasa mis-detecting the
  // project type, not just harmless clutter.
  const RETIRED_CLASSIC_PATHS = ['domain.yml', 'config.yml', 'endpoints.yml', 'credentials.yml', 'data'];

  function ensureExtracted(repoPath: string): void {
    // Always re-sync (cheap — a handful of small YAML/MD files) rather than
    // only copying once, so a template update (new/changed flows, config)
    // actually reaches an already-extracted managed folder instead of
    // silently going stale, same class of bug as the venv-version issue.
    // .venv and models/ aren't part of the template, so this never touches
    // the expensive parts.
    const isFirstExtract = !fs.existsSync(path.join(repoPath, 'agent.yml'));
    if (isFirstExtract) {
      output.appendLine(`[NoteVs Agent] Setting up agent files in ${repoPath}`);
      setStatus({ phase: 'extracting', message: 'Setting up agent files…' });
    }
    fs.mkdirSync(repoPath, { recursive: true });
    for (const name of RETIRED_CLASSIC_PATHS) {
      const p = path.join(repoPath, name);
      if (fs.existsSync(p)) {
        output.appendLine(`[NoteVs Agent] Removing retired classic-engine file: ${name}`);
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
    fs.cpSync(templatePath, repoPath, { recursive: true });
  }

  async function ensureVenv(repoPath: string): Promise<boolean> {
    if (fs.existsSync(venvPython(repoPath))) {
      if (isCompatibleInterpreter(venvPython(repoPath))) { return true; }
      output.appendLine('[NoteVs Agent] Existing .venv uses an incompatible Python version — recreating it.');
      fs.rmSync(path.join(repoPath, '.venv'), { recursive: true, force: true });
    }
    setStatus({ phase: 'creating_venv', message: 'Creating Python virtual environment…' });
    const pythonCmd = findCompatiblePython(output);
    if (!pythonCmd) {
      const message = 'No compatible Python found (need 3.10-3.13). Install one, e.g. "brew install python@3.12", then this restarts automatically.';
      output.appendLine(`[NoteVs Agent] ${message}`);
      setStatus({ phase: 'error', message });
      return false;
    }
    output.appendLine('[NoteVs Agent] Creating Python virtual environment...');
    const code = await runToCompletion(pythonCmd, ['-m', 'venv', '.venv'], repoPath, output);
    if (code !== 0) {
      const message = 'Could not create a Python virtual environment — see the NoteVs Agent output channel for details.';
      output.appendLine(`[NoteVs Agent] ${message}`);
      setStatus({ phase: 'error', message });
      return false;
    }
    return true;
  }

  async function ensureDeps(repoPath: string): Promise<boolean> {
    const marker = path.join(repoPath, '.venv', DEPS_INSTALLED_MARKER);
    if (fs.existsSync(marker)) { return true; }
    output.appendLine('[NoteVs Agent] Installing rasa-pro — this can take several minutes the first time...');
    setStatus({ phase: 'installing', message: 'Installing the agent (first time only, a few minutes)…' });
    const code = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'NoteVs: setting up the local agent (first time only)…' },
      // --pre is required: requirements.txt pins a .devN pre-release
      // (rasa-pro==3.19.0.dev5, the Maestro build), and pip excludes
      // pre-releases by default even when a version is pinned exactly.
      () => runToCompletion(venvPython(repoPath), ['-m', 'pip', 'install', '--pre', '-r', 'requirements.txt'], repoPath, output),
    );
    if (code !== 0) {
      const message = 'Installing the agent failed — see the NoteVs Agent output channel for details.';
      output.appendLine(`[NoteVs Agent] ${message}`);
      setStatus({ phase: 'error', message });
      return false;
    }
    fs.writeFileSync(marker, new Date().toISOString());
    output.appendLine('[NoteVs Agent] Install complete.');
    return true;
  }

  async function ensureTrained(repoPath: string, groqApiKey: string, rasaLicense: string): Promise<boolean> {
    const modelsDir = path.join(repoPath, 'models');
    const hashMarker = path.join(modelsDir, '.source_hash');
    const hasModel = fs.existsSync(modelsDir) && fs.readdirSync(modelsDir).some(f => f.endsWith('.tar.gz'));
    const currentHash = computeTrainingSourceHash(repoPath);
    const isStale = !fs.existsSync(hashMarker) || fs.readFileSync(hashMarker, 'utf8').trim() !== currentHash;
    if (hasModel && !isStale) { return true; }
    if (hasModel && isStale) {
      output.appendLine('[NoteVs Agent] Flows/domain/config changed since the last trained model — retraining.');
      fs.rmSync(modelsDir, { recursive: true, force: true });
    }
    output.appendLine('[NoteVs Agent] Training the agent (classic rasa-pro needs a trained model before it can run) — this can take a few minutes the first time...');
    setStatus({ phase: 'training', message: 'Training the agent (first time only, a few minutes)…' });
    // rasa train validates flows/license before doing anything, so it needs
    // the same RASA_LICENSE/GROQ_API_KEY env vars the final `rasa run` gets —
    // runToCompletion doesn't inject those by default.
    const trainEnv = { ...process.env, GROQ_API_KEY: groqApiKey, RASA_LICENSE: rasaLicense, RASA_PRO_LICENSE: rasaLicense };
    const code = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'NoteVs: training the local agent (first time only)…' },
      () => runToCompletion(venvPython(repoPath), ['-m', 'rasa', 'train'], repoPath, output, trainEnv),
    );
    if (code !== 0) {
      const message = 'Training the agent failed — see the NoteVs Agent output channel for details.';
      output.appendLine(`[NoteVs Agent] ${message}`);
      setStatus({ phase: 'error', message });
      return false;
    }
    fs.writeFileSync(hashMarker, currentHash);
    output.appendLine('[NoteVs Agent] Training complete.');
    return true;
  }

  async function startPipeline(): Promise<void> {
    if (disposed || starting) { return; }
    starting = true;
    try {
      const groqApiKey = await context.secrets.get('groqApiKey');
      const rasaLicense = await context.secrets.get('rasaLicense');
      if (!groqApiKey || !rasaLicense) {
        output.appendLine('[NoteVs Agent] Add your Groq API key and Rasa license in Settings → Agent to enable auto-start.');
        setStatus({ phase: 'missing_credentials' });
        return;
      }

      const override = getAgentRepoPathOverride();
      const repoPath = override || managedRepoPath;

      if (override) {
        if (!fs.existsSync(path.join(override, 'agent.yml'))) {
          const message = `notevs.agentRepoPath is set to ${override} but no agent.yml was found there.`;
          output.appendLine(`[NoteVs Agent] ${message}`);
          setStatus({ phase: 'error', message });
          return;
        }
      } else {
        ensureExtracted(repoPath);
      }

      if (!(await ensureVenv(repoPath))) { return; }
      if (!(await ensureDeps(repoPath))) { return; }
      if (!(await ensureTrained(repoPath, groqApiKey, rasaLicense))) { return; }

      if (disposed) { return; }
      const agentPort = await findFreePort(repoPath, output);
      resolvedPort = agentPort;
      const folderPath = getFolderPath();
      output.appendLine(`[NoteVs Agent] Starting rasa run in ${repoPath} on port ${agentPort}${folderPath ? ` for ${folderPath}` : ''}`);
      setStatus({ phase: 'starting', message: 'Starting the agent…' });
      const startedAt = Date.now();
      child = spawn(venvPython(repoPath), ['-m', 'rasa', 'run', '--port', String(agentPort)], {
        cwd: repoPath,
        env: {
          ...process.env,
          GROQ_API_KEY: groqApiKey,
          RASA_LICENSE: rasaLicense,
          RASA_PRO_LICENSE: rasaLicense,
          // Tells notevs_tools.py which project this specific window's
          // agent is for, so its tool calls are correct regardless of
          // which VS Code window's mcpServer.ts instance happens to answer
          // on mcpPort (see notevs_tools.py's header comment — the port
          // itself is effectively a shared, single-winner resource across
          // windows, unlike this agent process).
          NOTEVS_FOLDER_PATH: folderPath ?? '',
          NOTEVS_CALL_URL: `http://127.0.0.1:${mcpPort}/call`,
        },
      });
      setStatus({ phase: 'running' });

      // Keep the last few stderr lines around so a crash can report the
      // actual reason instead of just an exit code — a bare "exited
      // unexpectedly" told us nothing when this was actually a missing
      // trained model, a bad license, etc.
      let recentStderr: string[] = [];
      function trackStderr(chunk: Buffer) {
        const lines = chunk.toString().split('\n').map(l => l.trim()).filter(Boolean);
        recentStderr = [...recentStderr, ...lines].slice(-15);
      }
      function lastErrorLine(): string | undefined {
        const withError = [...recentStderr].reverse().find(l => /error/i.test(l));
        return withError ?? recentStderr[recentStderr.length - 1];
      }

      child.stdout?.on('data', (chunk: Buffer) => output.append(chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => { output.append(chunk.toString()); trackStderr(chunk); });

      child.on('exit', (code) => {
        output.appendLine(`[NoteVs Agent] Process exited (code ${code})`);
        if (Date.now() - startedAt > MIN_HEALTHY_UPTIME_MS) { restartDelay = INITIAL_RESTART_DELAY_MS; }
        child = undefined;
        resolvedPort = undefined;
        const reason = lastErrorLine();
        const message = reason
          ? `Agent crashed (code ${code}): ${reason.slice(0, 200)}`
          : `Agent process exited unexpectedly (code ${code}).`;
        setStatus({ phase: 'crashed', message: `${message} Retrying…` });
        scheduleRestart();
      });

      child.on('error', (err) => {
        output.appendLine(`[NoteVs Agent] Failed to start: ${err.message}`);
        child = undefined;
        setStatus({ phase: 'crashed', message: `Failed to start: ${err.message}` });
        scheduleRestart();
      });
    } finally {
      starting = false;
    }
  }

  function restart() {
    restartDelay = INITIAL_RESTART_DELAY_MS;
    stopChild();
    void startPipeline();
  }

  void startPipeline();

  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('notevs.agentRepoPath')) {
      output.appendLine('[NoteVs Agent] agentRepoPath changed, restarting...');
      restart();
    }
  });

  // Once both credentials are saved via Settings → Agent, the whole
  // extract/venv/install/run pipeline kicks off automatically — no reload,
  // no terminal. Clearing either key stops the current process.
  const secretsWatcher = context.secrets.onDidChange((e) => {
    if (e.key === 'groqApiKey' || e.key === 'rasaLicense') { restart(); }
  });

  const configureCommand = vscode.commands.registerCommand('notevs.configureAgentPath', async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
      openLabel: 'Use as agent repo path',
      title: 'Select a folder with your own agent.yml (leave notevs.agentRepoPath empty to use the built-in managed agent instead)',
    });
    if (!picked || picked.length === 0) { return; }
    await vscode.workspace.getConfiguration('notevs').update('agentRepoPath', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`NoteVs Agent path set to ${picked[0].fsPath}. Restarting...`);
  });

  const dispose: vscode.Disposable = {
    dispose: () => { disposed = true; stopChild(); },
  };

  return {
    disposables: [output, statusEmitter, configWatcher, secretsWatcher, configureCommand, dispose],
    onStatusChange: statusEmitter.event,
    getStatus: () => status,
    getPort: () => resolvedPort,
  };
}
