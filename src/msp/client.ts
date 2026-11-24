/**
 * Minimal typed MSP client: spawns `muse serve` once and talks
 * newline-delimited JSON-RPC over stdio.
 *
 * No VS Code dependency — this is plain Node, so it can be tested with a
 * fake `muse serve` process (see test/fake-muse-serve.mjs).
 *
 * Credential policy: this client never reads, stores, or sends
 * ~/.config/muse/auth.json, API keys, or tokens. Auth belongs to the
 * user's own `muse login`; the CLI owns its credentials.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { NdjsonParser, encodeFrame } from './framing';
import { isResponse, type JsonRpcId, type JsonRpcMessage, type MspApprovalRequest, type MspItem, type MspSession, type MspUserInputRequest } from './types';

export interface MspClientEvents {
  /** A streamed item started / updated / completed. */
  item: (item: MspItem, phase: 'started' | 'delta' | 'completed') => void;
  approval: (req: MspApprovalRequest) => void;
  userInput: (req: MspUserInputRequest) => void;
  /** The serve process exited or errored. */
  exit: (code: number | null, error?: Error) => void;
  /** A raw protocol error surfaced by the server. */
  protocolError: (error: Error) => void;
}

export interface MspClientOptions {
  executable: string;
  extraArgs?: string[];
  cwd?: string;
}

/** Parse a loosely-shaped MSP item payload into our typed shape. */
export function normalizeItem(raw: unknown): MspItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const item = (r.item ?? r) as Record<string, unknown>;
  const kindRaw = String(item.kind ?? item.type ?? 'unknown');
  const kind = (['message', 'reasoning', 'toolCall', 'userShell', 'subagent'].includes(kindRaw) ? kindRaw : 'unknown') as MspItem['kind'];
  return {
    id: String(item.id ?? ''),
    kind,
    text: typeof item.text === 'string' ? item.text : typeof item.delta === 'string' ? item.delta : undefined,
    tool: typeof item.tool === 'string' ? item.tool : typeof item.toolName === 'string' ? item.toolName : undefined,
    filePath: typeof item.filePath === 'string' ? item.filePath : typeof item.path === 'string' ? item.path : undefined,
    summary: typeof item.summary === 'string' ? item.summary : typeof item.description === 'string' ? item.description : undefined,
    raw: item as Record<string, unknown>,
  };
}

export class MspClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private parser = new NdjsonParser();
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private started = false;

  constructor(private opts: MspClientOptions) {
    super();
  }

  on<K extends keyof MspClientEvents>(event: K, listener: MspClientEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof MspClientEvents>(event: K, ...args: Parameters<MspClientEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /** Spawn `muse serve` and run the initialize handshake. Throws on failure. */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const args = ['serve', ...(this.opts.extraArgs ?? [])];
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(this.opts.executable, args, { cwd: this.opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      throw new Error(`Could not start \`${this.opts.executable} serve\`: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.proc = proc;
    proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    proc.stderr.on('data', (chunk: Buffer) => {
      // stderr is diagnostics, not protocol — surface it as a protocol error
      // only if it looks like a fatal failure; otherwise ignore it.
      const text = chunk.toString('utf8').trim();
      if (text) {
        this.emit('protocolError', new Error(`muse serve stderr: ${text}`));
      }
    });
    proc.on('error', (err) => {
      this.failAll(err);
      this.emit('exit', null, err);
    });
    proc.on('exit', (code) => {
      this.failAll(new Error(`muse serve exited with code ${code}`));
      this.emit('exit', code);
    });

    // initialize handshake — schema version is best-effort; the server validates it.
    await this.request('initialize', { client: 'muse-code-chat-vscode', version: '0.1.0' });
    this.started = true;
  }

  private onData(chunk: string): void {
    let messages: JsonRpcMessage[];
    try {
      messages = this.parser.push(chunk);
    } catch (err) {
      this.emit('protocolError', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const msg of messages) {
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    const params = (msg.params ?? {}) as Record<string, unknown>;
    switch (msg.method) {
      case 'item/started':
        this.emit('item', normalizeItem(params), 'started');
        break;
      case 'item/delta':
        this.emit('item', normalizeItem(params), 'delta');
        break;
      case 'item/completed':
        this.emit('item', normalizeItem(params), 'completed');
        break;
      case 'approval/request':
        this.emit('approval', {
          id: String(params.id ?? params.requestId ?? ''),
          tool: typeof params.tool === 'string' ? params.tool : undefined,
          summary: typeof params.summary === 'string' ? params.summary : typeof params.description === 'string' ? params.description : undefined,
          filePath: typeof params.filePath === 'string' ? params.filePath : undefined,
          command: typeof params.command === 'string' ? params.command : undefined,
        });
        break;
      case 'userInput/request':
        this.emit('userInput', {
          id: String(params.id ?? params.requestId ?? ''),
          prompt: typeof params.prompt === 'string' ? params.prompt : undefined,
          options: Array.isArray(params.options) ? (params.options as string[]) : undefined,
        });
        break;
      default:
        // Unknown server-initiated notification — ignore; the protocol is
        // experimental and may gain new methods between releases.
        break;
    }
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error('muse serve is not running'));
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.proc.stdin.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
    return promise;
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (!this.proc || !this.proc.stdin.writable) {
      return;
    }
    this.proc.stdin.write(encodeFrame({ jsonrpc: '2.0', method, params } as JsonRpcMessage));
  }

  async listSessions(): Promise<MspSession[]> {
    const result = (await this.request('session/list', {})) as Record<string, unknown> | undefined;
    const sessions = (result?.sessions ?? result ?? []) as Array<Record<string, unknown>>;
    return (Array.isArray(sessions) ? sessions : []).map((s) => ({
      id: String(s.id ?? ''),
      title: typeof s.title === 'string' ? s.title : undefined,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : undefined,
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : undefined,
    }));
  }

  async startSession(): Promise<MspSession> {
    const result = (await this.request('session/start', {})) as Record<string, unknown>;
    const session = (result?.session ?? result ?? {}) as Record<string, unknown>;
    return { id: String(session.id ?? ''), title: typeof session.title === 'string' ? session.title : undefined };
  }

  async resumeSession(sessionId: string): Promise<MspSession> {
    const result = (await this.request('session/resume', { sessionId })) as Record<string, unknown>;
    const session = (result?.session ?? result ?? {}) as Record<string, unknown>;
    return { id: String(session.id ?? sessionId), title: typeof session.title === 'string' ? session.title : undefined };
  }

  /** Send a turn (one user prompt). Streaming arrives via `item` events. */
  async sendTurn(sessionId: string, prompt: string, context?: Record<string, unknown>): Promise<void> {
    await this.request('turn/send', { sessionId, prompt, ...(context ?? {}) });
  }

  async cancelTurn(sessionId: string): Promise<void> {
    await this.request('turn/cancel', { sessionId });
  }

  approve(id: string, approved: boolean): void {
    this.notify('approval/decide', { id, approved });
  }

  answerUserInput(id: string, answer: string): void {
    this.notify('userInput/answer', { id, answer });
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  dispose(): void {
    try {
      this.proc?.kill();
    } catch {
      // already gone
    }
    this.proc = null;
    this.started = false;
    this.failAll(new Error('Muse Session Protocol client disposed'));
  }
}
