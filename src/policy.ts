// Capability policy — what this server is allowed to do to the project.
//
//   AE_MCP_READONLY=1          — nothing may modify the AE project
//   AE_MCP_ALLOW_CATEGORIES=…  — comma-separated operation-category allowlist
//   AE_MCP_ENABLE_EVAL=1       — opt in to `eval.run` (arbitrary ExtendScript)
//
// `eval.run` is opt-in because it is code execution with the full authority
// of the After Effects process (file I/O, system.callSystem, Socket); a
// server that only ever runs declared operations should not carry that
// silently. Read-only mode wins over the opt-in. Note the inverse is not a
// sandbox: with eval off, `command.execute` still drives arbitrary menu
// commands and every write operation stays available — AE_MCP_READONLY is
// the "don't touch my project" switch.
//
// Denials happen in three places that must agree: tool registration (the tool
// never appears), `ae_catalog` (the operation is never advertised), and
// `ae_do` / `batch.run` (the operation is refused even if the model guessed
// its name).

import type { Operation } from "./registry.js";

/**
 * How a tool is presented to MCP clients that gate on behaviour hints.
 * Orthogonal to `blockedInReadOnly`: `ae_render_frame` writes a PNG (so it is not
 * a pure read) but never touches the project (so read-only mode allows it).
 */
export type ToolEffect = "read" | "write" | "destructive";

export interface Denial {
  message: string;
  hint?: string;
}

export function evalRunEnabled(): boolean {
  if (readOnlyMode()) return false;
  return process.env.AE_MCP_ENABLE_EVAL === "1";
}

export function readOnlyMode(): boolean {
  return process.env.AE_MCP_READONLY === "1";
}

/** Parsed AE_MCP_ALLOW_CATEGORIES, or null when no allowlist is configured. */
export function allowedCategories(): Set<string> | null {
  const raw = process.env.AE_MCP_ALLOW_CATEGORIES?.trim();
  if (!raw) return null;
  const categories = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return categories.length > 0 ? new Set(categories) : null;
}

/** Non-null when this operation must be refused under the current policy. */
export function denyOperation(op: Operation): Denial | null {
  if (readOnlyMode() && !op.readOnly) {
    return {
      message: `operation '${op.name}' modifies the project and AE_MCP_READONLY=1 is set`,
      hint: "Unset AE_MCP_READONLY to allow mutations, or use a read-only operation (ae_catalog lists only those while read-only mode is on).",
    };
  }
  const allowed = allowedCategories();
  if (allowed && !allowed.has(op.category)) {
    return {
      message: `operation category '${op.category}' is not in AE_MCP_ALLOW_CATEGORIES`,
      hint: `Allowed categories: ${Array.from(allowed).sort().join(", ")}`,
    };
  }
  if (op.category === "eval" && !evalRunEnabled()) return EVAL_DENIAL;
  return null;
}

const EVAL_DENIAL: Denial = {
  message: "eval.run is disabled on this server",
  hint: "Set AE_MCP_ENABLE_EVAL=1 (and unset AE_MCP_READONLY) to allow arbitrary ExtendScript, or use a dedicated operation from ae_catalog.",
};

/**
 * Denial for an operation that is not in the registry *because* the config
 * withheld it, rather than because the name is wrong.
 *
 * `eval.run` is only imported when the opt-in is set, so a plain registry miss
 * would report UNKNOWN_OPERATION with a spelling suggestion — which reads as
 * "no such feature" and hides the fact that there is a switch. Callers check
 * this before falling back to the unknown-name path.
 */
export function denyUnregisteredOperation(name: string): Denial | null {
  return name === "eval.run" && !evalRunEnabled() ? EVAL_DENIAL : null;
}

/** Same idea at category granularity, for `ae_catalog({ category })`. */
export function denyUnregisteredCategory(category: string): Denial | null {
  return category === "eval" && !evalRunEnabled() ? EVAL_DENIAL : null;
}

/** Non-null when this tool must not be registered under the current policy. */
export function denyTool(name: string, blockedInReadOnly: boolean): Denial | null {
  if (readOnlyMode() && blockedInReadOnly) {
    return {
      message: `tool '${name}' modifies the project and AE_MCP_READONLY=1 is set`,
      hint: "Unset AE_MCP_READONLY to allow mutations.",
    };
  }
  return null;
}

/** One-line description of the active policy, for the startup banner. */
export function policySummary(): string {
  const parts: string[] = [];
  parts.push(readOnlyMode() ? "readonly=ON (no project mutations)" : "readonly=off");
  const allowed = allowedCategories();
  parts.push(allowed ? `categories=${Array.from(allowed).sort().join("|")}` : "categories=all");
  parts.push(evalRunEnabled() ? "eval.run=ENABLED" : "eval.run=disabled");
  return parts.join(", ");
}
