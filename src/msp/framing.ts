/**
 * Pure newline-delimited JSON-RPC framing for MSP (Muse Session Protocol).
 * No VS Code or child-process dependency, so this is unit-testable in plain Node.
 */
import type { JsonRpcMessage } from './types';

/** Encode one JSON-RPC message as a single newline-terminated line. */
export function encodeFrame(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

/** Decode one line. Throws on invalid JSON — callers should surface the error, not swallow it. */
export function decodeFrame(line: string): JsonRpcMessage {
  return JSON.parse(line) as JsonRpcMessage;
}

/**
 * Incremental NDJSON parser: feed arbitrary chunks, get back complete messages.
 * Handles split lines, multiple lines per chunk, and \r\n line endings.
 */
export class NdjsonParser {
  private buffer = '';

  push(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;
    const out: JsonRpcMessage[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      out.push(decodeFrame(line));
    }
    return out;
  }
}
