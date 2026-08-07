import type { z } from "zod";
import { errorResult } from "../errors.js";
import type { ToolEffect } from "../policy.js";
import type { AeTransport, EvalResult } from "../transport/AeTransport.js";
import type { ToolResult } from "./types.js";

export type ToolGroup = "inspect" | "document" | "render" | "operations";

// Deriving the handler's arg type through z.ZodObject (rather than mapping the
// raw shape directly) makes `.optional()` fields optional KEYS, not
// required-keys-of-`T | undefined`. That matches both what the MCP SDK passes
// at runtime and how tests/e2e call handlers directly with partial args.
export type ArgsOf<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

export type ToolSpec<S extends z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  /**
   * Whether AE_MCP_READONLY withholds this tool entirely. Deliberately its own
   * axis rather than a claim about the tool: `ae_render_frame` writes a PNG but
   * never touches the project, so read-only mode keeps it (the agent still
   * needs its eyes), and `ae_do` stays registered because its operations are
   * gated one by one — withholding it would leave `ae_catalog` advertising
   * operations nothing can execute.
   */
  blockedInReadOnly: boolean;
  /** MCP behaviour hint for clients that gate on readOnlyHint/destructiveHint. */
  effect: ToolEffect;
  inputShape: S;
  handler: (args: ArgsOf<S>, transport: AeTransport) => Promise<ToolResult>;
};

/**
 * Typed tool factory. Infers the handler's argument type from `inputShape`
 * so every tool definition stays short and consistent.
 */
export function defineTool<S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

/** Wraps a successful payload into a standard MCP ToolResult. */
export function jsonResult(payload: Record<string, unknown>): ToolResult {
  const envelope = { ok: true, ...payload };
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
    isError: false,
  };
}

/**
 * Our JSX convention is that an operation reports application-level failure by
 * RETURNING `{ ok: false, error }` — the script itself ran fine, so the
 * transport reports success. Every caller must therefore look one level down,
 * or a "comp not found" reads as a successful render.
 */
export function jsxReportedFailure(result: unknown): { error: string } | null {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const r = result as { ok?: unknown; error?: unknown };
  if (r.ok !== false) return null;
  return { error: typeof r.error === "string" ? r.error : "operation reported ok: false" };
}

/**
 * Converts a transport-level EvalResult (the parsed dispatcher response) into
 * an MCP ToolResult, mapping all three failure layers — transport, dispatcher,
 * and the operation's own `{ ok: false }` — onto the unified error envelope.
 */
export function toMcpResult(result: EvalResult): ToolResult {
  if (!result.ok) {
    return errorResult(result.errorCode ?? "TRANSPORT", result.error ?? "unknown failure", {
      stack: result.stack,
      logs: result.logs,
      durationMs: result.durationMs,
    });
  }
  const reported = jsxReportedFailure(result.result);
  if (reported) {
    return errorResult("OPERATION_FAILED", reported.error, {
      details: { result: result.result },
      logs: result.logs,
      durationMs: result.durationMs,
    });
  }
  return jsonResult({
    result: result.result,
    logs: result.logs,
    durationMs: result.durationMs,
  });
}
