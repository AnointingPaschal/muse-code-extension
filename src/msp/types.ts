/**
 * Muse Session Protocol (MSP) types — HAND-WRITTEN, NOT GENERATED.
 *
 * The `muse` CLI was NOT available in the build sandbox, so these types
 * could not be generated with `muse schema generate-ts`. They are a small,
 * minimal subset based on the public protocol shape used by community
 * extensions (newline-delimited JSON-RPC over stdio, `muse serve`):
 * initialize / session/* / turn/* / item/* / approval/* / userInput/*.
 *
 * After installing the Muse Code CLI, regenerate the authoritative types:
 *   muse schema generate-ts --out src/msp
 * and replace this file. Some MSP features are marked experimental by Meta
 * and may change between Muse releases — treat this file as a starter,
 * not as a stable contract.
 *
 * This extension never talks to muse.ai — there is no public Muse
 * personal-assistant API. It only talks to the local `muse serve` process.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && ('result' in msg || 'error' in msg);
}

/** Approval modes, mirroring Muse Code's own modes. */
export type ApprovalMode = 'on-request' | 'prompt-unmatched' | 'deny-unmatched' | 'allow-all';

export interface MspSession {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type MspItemKind = 'message' | 'reasoning' | 'toolCall' | 'userShell' | 'subagent' | 'unknown';

export interface MspItem {
  id: string;
  kind: MspItemKind;
  /** Streamed text for message/reasoning items. */
  text?: string;
  /** Tool name for toolCall items, e.g. "write", "edit", "exec". */
  tool?: string;
  /** File path touched by a tool call, when known. */
  filePath?: string;
  /** Human-readable summary of a tool call. */
  summary?: string;
  /** Raw payload, kept for forward compatibility. */
  raw?: Record<string, unknown>;
}

export interface MspApprovalRequest {
  id: string;
  tool?: string;
  summary?: string;
  filePath?: string;
  command?: string;
}

export interface MspUserInputRequest {
  id: string;
  prompt?: string;
  options?: string[];
}
