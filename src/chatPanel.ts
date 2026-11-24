/**
 * Sidebar webview chat panel.
 *
 * The panel never stores credentials and never talks to muse.ai.
 * It talks to the local `muse serve` process (MSP) via MspClient, and
 * falls back to `muse exec --json` only when `muse serve` fails — and
 * says so in the UI.
 *
 * Diff review: file changes reported by tool calls are listed, never
 * silently applied. "Open diff" diffs the file against the content we
 * captured when it was mentioned as @context (when available); otherwise
 * it shows the git diff for that file in a terminal.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MspClient } from './msp/client';
import type { MspItem, MspSession } from './msp/types';
import { runExecTurn } from './msp/execFallback';
import { checkSetup, INSTALL_INSTRUCTIONS } from './museCli';

interface PendingApproval {
  resolve: (approved: boolean) => void;
}

export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'museCodeChat';

  private view: vscode.WebviewView | undefined;
  private client: MspClient | undefined;
  private session: MspSession | undefined;
  private fallbackMode = false;
  private streaming = false;
  private stopRequested = false;
  private pendingApprovals = new Map<string, PendingApproval>();
  private changedFiles = new Set<string>();
  /** Content captured when a file was used as @context, for diff review. */
  private contextSnapshots = new Map<string, string>();
  private messageSeq = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.getHtml();
    view.webview.onDidReceiveMessage((msg: Record<string, unknown>) => {
      void this.handleWebviewMessage(msg);
    });
    void this.ensureClient();
  }

  focus(): void {
    void vscode.commands.executeCommand('museCodeChat.focus');
  }

  async newChat(): Promise<void> {
    this.session = undefined;
    this.changedFiles.clear();
    this.post({ type: 'clear' });
    await this.ensureClient();
  }

  stop(): void {
    this.stopRequested = true;
    this.streaming = false;
    if (this.client && this.session) {
      void this.client.cancelTurn(this.session.id).catch(() => undefined);
    }
    this.post({ type: 'status', status: 'Stopped.' });
  }

  private post(msg: Record<string, unknown>): void {
    void this.view?.webview.postMessage(msg);
  }

  private workspaceFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private getExecutablePath(): string {
    return vscode.workspace.getConfiguration('museCode').get<string>('executablePath', '');
  }

  private getExtraArgs(): string[] {
    return vscode.workspace.getConfiguration('museCode').get<string[]>('extraArgs', []);
  }

  private getApprovalMode(): string {
    return vscode.workspace.getConfiguration('museCode').get<string>('approvalMode', 'on-request');
  }

  /** Ensure a working transport. Posts a setup card when the CLI is missing. */
  async ensureClient(): Promise<boolean> {
    const setup = checkSetup(this.getExecutablePath());
    if (!setup.ok) {
      this.post({ type: 'setup', ok: false, reason: setup.reason, installMacLinux: INSTALL_INSTRUCTIONS.macLinux, installWindows: INSTALL_INSTRUCTIONS.windows });
      return false;
    }
    if (this.client) {
      return true;
    }
    const client = new MspClient({ executable: setup.executable, extraArgs: this.getExtraArgs(), cwd: this.workspaceFolder() });
    client.on('item', (item, phase) => this.onItem(item, phase));
    client.on('approval', (req) => {
      this.post({ type: 'approval', id: req.id, tool: req.tool ?? '', summary: req.summary ?? '', filePath: req.filePath ?? '', command: req.command ?? '' });
    });
    client.on('userInput', (req) => {
      this.post({ type: 'userInput', id: req.id, prompt: req.prompt ?? '', options: req.options ?? [] });
    });
    client.on('exit', (code) => {
      this.post({ type: 'status', status: `Muse Code exited (code ${code}). Falling back to muse exec per turn.` });
      this.fallbackMode = true;
      this.client = undefined;
    });
    client.on('protocolError', (err) => {
      this.post({ type: 'status', status: `Muse Code: ${err.message}` });
    });
    try {
      await client.start();
    } catch (err) {
      this.fallbackMode = true;
      this.post({
        type: 'status',
        status: `Could not start \`muse serve\` (${err instanceof Error ? err.message : String(err)}). Using fallback: \`muse exec --json\` per turn. Sessions and live approvals are unavailable in fallback mode.`,
      });
      this.post({ type: 'fallback', enabled: true });
      return true; // fallback transport is available
    }
    this.client = client;
    this.fallbackMode = false;
    this.post({ type: 'setup', ok: true, reason: '' });
    this.post({ type: 'status', status: 'Connected to Muse Code (muse serve).' });
    await this.refreshSessions();
    return true;
  }

  private async refreshSessions(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      const sessions = await this.client.listSessions();
      this.post({ type: 'sessions', sessions: sessions.map((s) => ({ id: s.id, title: s.title ?? s.id })) });
    } catch {
      // Listing sessions is best-effort; a fresh session still works.
    }
  }

  private onItem(item: MspItem, phase: 'started' | 'delta' | 'completed'): void {
    if (item.kind === 'toolCall') {
      const summary = item.summary ?? `${item.tool ?? 'Tool'}${item.filePath ? ` — ${item.filePath}` : ''}`;
      if (item.filePath) {
        this.changedFiles.add(item.filePath);
        this.post({ type: 'diffs', files: [...this.changedFiles] });
      }
      this.post({ type: 'tool', id: item.id, phase, summary, tool: item.tool ?? '', filePath: item.filePath ?? '' });
      return;
    }
    if (item.text) {
      this.post({ type: 'delta', id: item.id, phase, kind: item.kind, text: item.text });
    }
    if (phase === 'completed') {
      this.streaming = false;
      this.post({ type: 'status', status: 'Ready.' });
    }
  }

  /** Expand @file mentions into file contents; capture snapshots for diff review. */
  private expandMentions(prompt: string): { prompt: string; contextFiles: string[] } {
    const root = this.workspaceFolder();
    const contextFiles: string[] = [];
    const blocks: string[] = [];
    const expanded = prompt.replace(/@([^\s]+)/g, (_match, name: string) => {
      const candidates = root ? [path.join(root, name), path.resolve(name)] : [path.resolve(name)];
      for (const candidate of candidates) {
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            const content = fs.readFileSync(candidate, 'utf8');
            this.contextSnapshots.set(candidate, content);
            contextFiles.push(candidate);
            blocks.push(`--- File: ${candidate} ---\n${content}`);
            return candidate;
          }
        } catch {
          // fall through — leave the mention as-is
        }
      }
      return `@${name}`;
    });
    return { prompt: blocks.length ? `${expanded}\n\nContext files:\n${blocks.join('\n\n')}` : expanded, contextFiles };
  }

  private getSelectionContext(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return '';
    }
    const file = editor.document.fileName;
    const text = editor.document.getText(editor.selection);
    try {
      this.contextSnapshots.set(file, editor.document.getText());
    } catch {
      // ignore
    }
    return `\n\nSelected code from ${file}:\n\`\`\`${editor.document.languageId}\n${text}\n\`\`\``;
  }

  private async handleWebviewMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'send': {
        await this.sendPrompt(String(msg.text ?? ''));
        break;
      }
      case 'stop':
        this.stop();
        break;
      case 'newChat':
        await this.newChat();
        break;
      case 'resume': {
        const id = String(msg.sessionId ?? '');
        if (this.client && id) {
          try {
            this.session = await this.client.resumeSession(id);
            this.post({ type: 'status', status: `Resumed session ${this.session.title ?? id}.` });
          } catch (err) {
            this.post({ type: 'status', status: `Could not resume session: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
        break;
      }
      case 'approve': {
        const id = String(msg.id ?? '');
        this.client?.approve(id, true);
        this.post({ type: 'approvalResolved', id, approved: true });
        break;
      }
      case 'deny': {
        const id = String(msg.id ?? '');
        this.client?.approve(id, false);
        this.post({ type: 'approvalResolved', id, approved: false });
        break;
      }
      case 'answerInput': {
        const id = String(msg.id ?? '');
        this.client?.answerUserInput(id, String(msg.answer ?? ''));
        break;
      }
      case 'openDiff':
        await this.openDiff(String(msg.file ?? ''));
        break;
      case 'openFile': {
        const file = String(msg.file ?? '');
        if (file) {
          void vscode.window.showTextDocument(vscode.Uri.file(file));
        }
        break;
      }
      case 'checkSetup':
        await this.ensureClient();
        break;
      case 'signIn':
        void vscode.commands.executeCommand('museCode.signIn');
        break;
      default:
        break;
    }
  }

  async sendPrompt(rawPrompt: string): Promise<void> {
    const prompt = rawPrompt.trim();
    if (!prompt || this.streaming) {
      return;
    }
    // Local slash commands.
    if (prompt === '/help') {
      this.post({ type: 'message', id: `local-${++this.messageSeq}`, role: 'assistant', text: 'Commands: /help — this list. /new — new chat. /sessions — list sessions. @file — attach a file. !command — ask Muse to run a shell command (needs approval).' });
      return;
    }
    if (prompt === '/new') {
      await this.newChat();
      return;
    }
    if (prompt === '/sessions') {
      await this.refreshSessions();
      return;
    }
    if (prompt.startsWith('!')) {
      this.post({ type: 'status', status: 'Shell commands run through Muse with approval — nothing runs without your say-so.' });
    }

    const ok = await this.ensureClient();
    if (!ok) {
      return;
    }
    const { prompt: expanded } = this.expandMentions(prompt);
    const fullPrompt = expanded + this.getSelectionContext();
    this.streaming = true;
    this.stopRequested = false;
    this.post({ type: 'message', id: `user-${++this.messageSeq}`, role: 'user', text: prompt });
    this.post({ type: 'status', status: this.fallbackMode ? 'Working (fallback: muse exec)…' : 'Working…' });

    if (this.fallbackMode || !this.client) {
      const setup = checkSetup(this.getExecutablePath());
      if (!setup.ok) {
        this.streaming = false;
        return;
      }
      try {
        await runExecTurn(setup.executable, fullPrompt, this.workspaceFolder(), {
          onText: (text) => {
            if (!this.stopRequested) {
              this.post({ type: 'delta', id: `exec-${this.messageSeq}`, phase: 'delta', kind: 'message', text });
            }
          },
          onToolCall: (summary, filePath) => {
            if (filePath) {
              this.changedFiles.add(filePath);
              this.post({ type: 'diffs', files: [...this.changedFiles] });
            }
            this.post({ type: 'tool', id: `exec-tool-${++this.messageSeq}`, phase: 'completed', summary, tool: '', filePath: filePath ?? '' });
          },
        });
      } catch (err) {
        this.post({ type: 'status', status: `Fallback failed: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        this.streaming = false;
        this.post({ type: 'status', status: 'Ready.' });
      }
      return;
    }

    try {
      if (!this.session) {
        this.session = await this.client.startSession();
      }
      await this.client.sendTurn(this.session.id, fullPrompt, { approvalMode: this.getApprovalMode() });
    } catch (err) {
      this.streaming = false;
      this.post({ type: 'status', status: `Muse Code error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async openDiff(file: string): Promise<void> {
    if (!file) {
      return;
    }
    const snapshot = this.contextSnapshots.get(file);
    if (snapshot !== undefined) {
      const tmp = path.join(os.tmpdir(), `muse-code-before-${path.basename(file)}`);
      try {
        fs.writeFileSync(tmp, snapshot, 'utf8');
        const left = vscode.Uri.file(tmp);
        const right = vscode.Uri.file(file);
        await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(file)} (before → now)`);
        return;
      } catch {
        // fall through to git diff
      }
    }
    // No snapshot: show the git diff for this file in a terminal.
    const terminal = vscode.window.createTerminal('Muse Code diff');
    terminal.show();
    terminal.sendText(`git diff -- ${JSON.stringify(file)}`);
  }

  private getHtml(): string {
    // NOTE: the webview script below deliberately avoids template literals
    // and ${} so it cannot clash with this outer template literal.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); margin: 0; padding: 0; display: flex; flex-direction: column; height: 100vh; }
header { padding: 10px 12px; border-bottom: 1px solid var(--vscode-sideBar-border); }
header h1 { font-size: 13px; margin: 0 0 4px 0; }
#status { color: var(--vscode-descriptionForeground); font-size: 12px; }
#fallback { display: none; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); padding: 6px 8px; margin-top: 6px; font-size: 12px; }
#toolbar { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-sideBar-border); flex-wrap: wrap; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); padding: 4px 8px; cursor: pointer; border-radius: 3px; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.danger { background: var(--vscode-inputValidation-errorBackground); }
#sessions { width: 100%; margin-top: 6px; }
#messages { flex: 1; overflow-y: auto; padding: 12px; }
.msg { margin-bottom: 12px; white-space: pre-wrap; word-break: break-word; }
.msg.user { background: var(--vscode-textBlockQuote-background); padding: 8px; border-radius: 4px; }
.msg.assistant { padding: 4px 0; }
.tool { border: 1px solid var(--vscode-sideBar-border); border-radius: 4px; padding: 6px 8px; margin: 6px 0; font-size: 12px; }
.approval { border: 1px solid var(--vscode-inputValidation-warningBorder); background: var(--vscode-inputValidation-warningBackground); padding: 8px; margin: 6px 0; border-radius: 4px; }
#diffs { padding: 0 12px 8px 12px; font-size: 12px; }
#diffs button { margin: 2px 4px 2px 0; }
#setup { padding: 12px; display: none; }
#setup code { display: block; background: var(--vscode-textCodeBlock-background); padding: 6px; margin: 6px 0; white-space: pre-wrap; word-break: break-all; }
#inputArea { border-top: 1px solid var(--vscode-sideBar-border); padding: 10px 12px; }
#input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 8px; font-family: inherit; resize: vertical; min-height: 56px; }
.hint { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 6px; }
#inputRow { display: flex; gap: 6px; margin-top: 8px; }
</style>
</head>
<body>
<header>
<h1>Muse Code Chat <span style="font-weight:normal;color:var(--vscode-descriptionForeground)">(Unofficial)</span></h1>
<div id="status">Starting…</div>
<div id="fallback">Fallback mode: using <code>muse exec --json</code> per turn. Sessions and live approvals are unavailable.</div>
</header>
<div id="toolbar">
<button id="newBtn">New chat</button>
<button id="stopBtn" class="danger">Stop</button>
<select id="sessions" title="Resume a session"><option value="">Resume a session…</option></select>
</div>
<div id="messages"></div>
<div id="diffs"></div>
<div id="setup">
<strong>Muse Code CLI not found.</strong>
<p>This extension needs the Muse Code CLI and your own Muse Code login. It never stores your credentials.</p>
<p>Install (macOS / Linux):</p>
<code>curl -fsSL https://dev.meta.ai/install.sh | bash</code>
<p>Install (Windows PowerShell):</p>
<code>irm https://dev.meta.ai/install.ps1 | iex</code>
<p>Then sign in in a terminal you can see:</p>
<code>muse login</code>
<button id="signInBtn" class="primary">Sign in (muse login)</button>
<button id="retryBtn">Check setup again</button>
</div>
<div id="inputArea">
<textarea id="input" placeholder="Ask Muse Code anything…  @file to attach a file, / for commands, ! to run a shell command (with approval)"></textarea>
<div id="inputRow">
<button id="sendBtn" class="primary">Send</button>
</div>
<div class="hint">Unofficial community project. Not made, endorsed, or supported by Meta. File changes need your approval — nothing is applied silently.</div>
</div>
<script>
(function () {
  var vscode = acquireVsCodeApi();
  var messagesEl = document.getElementById('messages');
  var statusEl = document.getElementById('status');
  var fallbackEl = document.getElementById('fallback');
  var setupEl = document.getElementById('setup');
  var diffsEl = document.getElementById('diffs');
  var sessionsEl = document.getElementById('sessions');
  var inputEl = document.getElementById('input');
  var buffers = {};
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function scroll() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function send() { var t = inputEl.value.trim(); if (!t) return; vscode.postMessage({ type: 'send', text: t }); inputEl.value = ''; }
  document.getElementById('sendBtn').addEventListener('click', send);
  document.getElementById('stopBtn').addEventListener('click', function () { vscode.postMessage({ type: 'stop' }); });
  document.getElementById('newBtn').addEventListener('click', function () { vscode.postMessage({ type: 'newChat' }); });
  document.getElementById('signInBtn').addEventListener('click', function () { vscode.postMessage({ type: 'signIn' }); });
  document.getElementById('retryBtn').addEventListener('click', function () { vscode.postMessage({ type: 'checkSetup' }); });
  sessionsEl.addEventListener('change', function () { if (sessionsEl.value) vscode.postMessage({ type: 'resume', sessionId: sessionsEl.value }); });
  inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg.type === 'status') { statusEl.textContent = msg.status; }
    else if (msg.type === 'setup') { setupEl.style.display = msg.ok ? 'none' : 'block'; if (msg.ok) statusEl.textContent = 'Connected to Muse Code.'; }
    else if (msg.type === 'fallback') { fallbackEl.style.display = msg.enabled ? 'block' : 'none'; }
    else if (msg.type === 'clear') { messagesEl.innerHTML = ''; diffsEl.innerHTML = ''; buffers = {}; }
    else if (msg.type === 'message') { var m = el('div', 'msg ' + msg.role, msg.text); messagesEl.appendChild(m); scroll(); }
    else if (msg.type === 'delta') {
      if (!buffers[msg.id]) { buffers[msg.id] = el('div', 'msg assistant', ''); messagesEl.appendChild(buffers[msg.id]); }
      buffers[msg.id].textContent += msg.text || '';
      if (msg.phase === 'completed') { delete buffers[msg.id]; }
      scroll();
    }
    else if (msg.type === 'tool') { var t = el('div', 'tool', (msg.tool ? msg.tool + ': ' : '') + msg.summary + (msg.filePath ? ' — ' + msg.filePath : '')); messagesEl.appendChild(t); scroll(); }
    else if (msg.type === 'approval') {
      var box = el('div', 'approval'); box.id = 'approval-' + msg.id;
      box.appendChild(el('div', '', 'Approval needed: ' + msg.summary));
      if (msg.filePath) box.appendChild(el('div', '', 'File: ' + msg.filePath));
      if (msg.command) box.appendChild(el('div', '', 'Command: ' + msg.command));
      var ok = el('button', 'primary', 'Approve'); ok.addEventListener('click', function () { vscode.postMessage({ type: 'approve', id: msg.id }); });
      var no = el('button', '', 'Deny'); no.addEventListener('click', function () { vscode.postMessage({ type: 'deny', id: msg.id }); });
      box.appendChild(ok); box.appendChild(no); messagesEl.appendChild(box); scroll();
    }
    else if (msg.type === 'approvalResolved') { var old = document.getElementById('approval-' + msg.id); if (old) old.textContent = msg.approved ? 'Approved.' : 'Denied.'; }
    else if (msg.type === 'userInput') {
      var ans = prompt(msg.prompt || 'Muse Code needs input:');
      if (ans !== null) vscode.postMessage({ type: 'answerInput', id: msg.id, answer: ans });
    }
    else if (msg.type === 'sessions') {
      sessionsEl.innerHTML = '<option value="">Resume a session…</option>';
      msg.sessions.forEach(function (s) { var o = document.createElement('option'); o.value = s.id; o.textContent = s.title || s.id; sessionsEl.appendChild(o); });
    }
    else if (msg.type === 'diffs') {
      diffsEl.innerHTML = '<strong>Changed files (review before you accept):</strong><br>';
      msg.files.forEach(function (f) {
        var b = el('button', '', 'Diff: ' + f); b.addEventListener('click', function () { vscode.postMessage({ type: 'openDiff', file: f }); });
        var o = el('button', '', 'Open'); o.addEventListener('click', function () { vscode.postMessage({ type: 'openFile', file: f }); });
        diffsEl.appendChild(b); diffsEl.appendChild(o); diffsEl.appendChild(document.createElement('br'));
      });
    }
  });
})();
</script>
</body>
</html>`;
  }

  dispose(): void {
    this.client?.dispose();
  }
}
