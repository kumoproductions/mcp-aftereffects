// Abstract transport for executing ExtendScript (JSX) inside a running AE
// instance. The initial implementation uses file-based IPC + a per-platform
// dispatcher launch (`AfterFX.exe -r` on Windows, `osascript`/DoScript on
// macOS) per call (see FileIpcTransport). A future SocketTransport can slot
// in here without changing any tool code — the tool layer depends only on
// this interface.

import type { AeErrorCode } from "../errors.js";

export interface EvalRequest {
  /** JSX code to execute inside the dispatcher. Convention: `return <JSON-serializable value>;` */
  code: string;
  /**
   * Bulk data for the JSX, delivered as a parsed value in the `payload`
   * variable rather than inlined into `code`. Use this for anything large or
   * caller-supplied — a whole project document, a manifest, a vertex list.
   * Inlining megabytes of JSON into generated source stresses ExtendScript's
   * parser and makes every character an escaping hazard; `payload` never
   * passes through the ES3 tokenizer at all.
   */
  payload?: unknown;
  /** Undo group label shown in AE's Edit menu. */
  label?: string;
  /** Per-call timeout in milliseconds. */
  timeoutMs?: number;
}

export interface EvalResult {
  ok: boolean;
  /** Serialized return value from the JSX code. Always JSON-safe. */
  result: unknown;
  /** Error message if `ok` is false. */
  error: string | null;
  /**
   * Machine-readable failure class when `ok` is false. Lets callers branch on
   * "retry" (TIMEOUT) vs "AE isn't installed" (AE_NOT_FOUND) vs "the script
   * threw" (JSX_THROW) without parsing `error` prose.
   */
  errorCode: AeErrorCode | null;
  /** Optional stack trace from ExtendScript. */
  stack: string | null;
  /** Breadcrumb messages pushed via `log(...)` inside the JSX. */
  logs: string[];
  /** Wall-clock duration in milliseconds for the transport round trip. */
  durationMs: number;
}

export interface AeTransport {
  /** Execute a JSX snippet and return the parsed response. Never throws — errors are surfaced via `ok: false`. */
  execute(req: EvalRequest): Promise<EvalResult>;
  /** Optional hook to release resources (e.g. shut down a socket daemon). */
  close?(): Promise<void>;
}
