/**
 * Fallback transport: `muse exec --json` per turn.
 * Used only when `muse serve` (MSP) fails. The UI must surface this
 * clearly — fallback turns have no live session, no streaming approvals,
 * and no resume. This is a degraded mode, not a silent downgrade.
 */
import { spawn } from 'child_process';

export interface ExecFallbackEvents {
  onText: (text: string) => void;
  onToolCall: (summary: string, filePath?: string) => void;
}

/**
 * Run one turn via `muse exec --json` and stream text/tool-call summaries
 * to the callbacks. Resolves when the process exits successfully.
 * Expects JSONL on stdout: lines shaped like {type:"text",text:"..."} or
 * {type:"toolCall",tool:"...",summary:"...",filePath:"..."} — unknown line
 * shapes are forwarded as plain text so nothing is silently dropped.
 */
export function runExecTurn(executable: string, prompt: string, cwd: string | undefined, events: ExecFallbackEvents): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, ['exec', '--json', prompt], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) {
          continue;
        }
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.type === 'toolCall' || obj.type === 'tool_call') {
            events.onToolCall(String(obj.summary ?? obj.tool ?? 'Tool call'), typeof obj.filePath === 'string' ? obj.filePath : undefined);
          } else if (typeof obj.text === 'string') {
            events.onText(obj.text);
          } else if (typeof obj.delta === 'string') {
            events.onText(obj.delta);
          } else {
            events.onText(line);
          }
        } catch {
          events.onText(line);
        }
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (buffer.trim()) {
        events.onText(buffer.trim());
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`muse exec exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
      }
    });
  });
}
