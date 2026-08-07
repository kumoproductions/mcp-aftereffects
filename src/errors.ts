// Unified error envelope.
//
// Failures reach the model from four different layers — the Node transport,
// the dispatcher, the ExtendScript we generated, and the operation's own
// `{ ok: false }` return — and used to arrive in four different shapes. Every
// tool now reports failure as:
//
//   { ok: false, error: { code, message, retryable, ... } }
//
// so the model can branch on `code` instead of pattern-matching prose: retry
// (TIMEOUT), fix the arguments (INVALID_ARGS), pick another operation
// (UNKNOWN_OPERATION), or stop and tell the user (AE_NOT_FOUND, FORBIDDEN).

import type { ToolResult } from "./tools/types.js";

export type AeErrorCode =
  /** After Effects could not be located on this machine. */
  | "AE_NOT_FOUND"
  /** AE never wrote a response before the deadline. */
  | "TIMEOUT"
  /** Node-side failure: spawn, filesystem, JSON write. */
  | "TRANSPORT"
  /** dispatcher.jsx failed before it could run our code. */
  | "DISPATCHER"
  /** The generated ExtendScript threw inside AE. */
  | "JSX_THROW"
  /** The operation ran to completion and reported `{ ok: false }`. */
  | "OPERATION_FAILED"
  /** No operation with that name (or it is filtered out by policy). */
  | "UNKNOWN_OPERATION"
  /** No such operation category. */
  | "UNKNOWN_CATEGORY"
  /** Arguments failed the operation's parameter schema. */
  | "INVALID_ARGS"
  /** A project JSON document failed schema validation. */
  | "VALIDATION"
  /** Blocked by AE_MCP_READONLY / AE_MCP_ALLOW_CATEGORIES / missing AE_MCP_ENABLE_EVAL. */
  | "FORBIDDEN"
  /** Node-side read/write of a path the caller supplied. */
  | "IO";

/**
 * Codes where retrying the identical call can plausibly succeed. Everything
 * else needs the model (or the user) to change something first.
 */
const RETRYABLE = new Set<AeErrorCode>(["TIMEOUT", "TRANSPORT"]);

export function isRetryable(code: AeErrorCode): boolean {
  return RETRYABLE.has(code);
}

export interface AeErrorExtra {
  /** Machine-readable specifics: offending args, valid alternatives, issues. */
  details?: Record<string, unknown>;
  /** ExtendScript stack, when AE gave us one. */
  stack?: string | null;
  /** Breadcrumbs pushed via `log()` before the failure. */
  logs?: string[];
  durationMs?: number;
  /** Human-facing next step, when there is a concrete one. */
  hint?: string;
}

export interface AeErrorEnvelope {
  ok: false;
  error: {
    code: AeErrorCode;
    message: string;
    retryable: boolean;
  } & AeErrorExtra;
}

export function errorEnvelope(
  code: AeErrorCode,
  message: string,
  extra: AeErrorExtra = {},
): AeErrorEnvelope {
  const error: AeErrorEnvelope["error"] = {
    code,
    message,
    retryable: isRetryable(code),
  };
  if (extra.hint !== undefined) error.hint = extra.hint;
  if (extra.details !== undefined) error.details = extra.details;
  if (extra.stack !== undefined && extra.stack !== null) error.stack = extra.stack;
  if (extra.logs !== undefined && extra.logs.length > 0) error.logs = extra.logs;
  if (extra.durationMs !== undefined) error.durationMs = extra.durationMs;
  return { ok: false, error };
}

/** Build a complete MCP ToolResult for a failure. */
export function errorResult(
  code: AeErrorCode,
  message: string,
  extra: AeErrorExtra = {},
): ToolResult {
  const envelope = errorEnvelope(code, message, extra);
  const lines = [`[${code}] ${message}`];
  if (envelope.error.hint) lines.push(`hint: ${envelope.error.hint}`);
  if (envelope.error.details) lines.push(JSON.stringify(envelope.error.details, null, 2));
  if (envelope.error.stack) lines.push(envelope.error.stack);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    isError: true,
  };
}
