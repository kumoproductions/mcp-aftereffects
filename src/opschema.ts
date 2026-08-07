// Argument validation for registry operations.
//
// `ae_do` accepts a free-form `args` object — the MCP input schema cannot
// describe 77 different operations. That used to mean the parameter metadata
// `ae_catalog` advertises was never enforced: a missing required arg became
// `null` in the generated ExtendScript (see `jsxVal`), and a misspelled key was
// silently dropped. Both failures only surfaced after a full round trip to AE,
// as a cryptic ES3 error or — worse — a quietly wrong mutation.
//
// This module turns the same `OperationParam[]` the catalog publishes into a
// real gate. The declarations stay the single source of truth; validation is
// derived, so an operation can never advertise a schema it doesn't enforce.

import type { Operation, OperationParam, ParamType } from "./registry.js";

export interface ArgIssue {
  path: string;
  message: string;
}

export type ValidateOpArgsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: ArgIssue[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeMatches(type: ParamType, v: unknown): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return isPlainObject(v);
    case "any":
      return true;
  }
}

/** Human-readable type of a received value, for the error message. */
export function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number" && !Number.isFinite(v)) return "non-finite number";
  return typeof v;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  const curr: number[] = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Nearest declared name for a key the caller got wrong, or null when nothing
 * is close enough to be worth suggesting. The threshold scales with name
 * length so short names don't collect nonsense suggestions.
 */
export function suggestName(key: string, candidates: readonly string[]): string | null {
  const lowered = key.toLowerCase();
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = levenshtein(lowered, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best === null) return null;
  const budget = Math.max(1, Math.floor(Math.max(key.length, best.length) * 0.4));
  return bestDistance <= budget ? best : null;
}

/** Compact `name: type (required)` summary, attached to every INVALID_ARGS error. */
export function summarizeParams(params: readonly OperationParam[]): string[] {
  return params.map(
    (p) =>
      `${p.name}: ${p.type} (${p.required ? "required" : "optional"}${p.nullable ? ", nullable" : ""})`,
  );
}

/**
 * Validate `raw` against an operation's declared parameters.
 *
 * Checks, in order: the args container is an object, every required parameter
 * is present, every present value matches its declared type, and no unknown
 * keys were passed. Defaults are deliberately NOT filled in here — `toJsx` is
 * the single place an operation applies them.
 */
export function validateOpArgs(op: Operation, raw: unknown): ValidateOpArgsResult {
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      issues: [{ path: "args", message: `must be an object, got ${describeValue(raw)}` }],
    };
  }

  const issues: ArgIssue[] = [];
  const declared = op.params;
  const declaredNames = declared.map((p) => p.name);

  for (const param of declared) {
    const value = raw[param.name];
    if (value === undefined) {
      if (param.required) {
        issues.push({
          path: param.name,
          message: `missing required parameter (${param.type}) — ${param.description}`,
        });
      }
      continue;
    }
    if (value === null) {
      // `null` is a distinct signal in a few ops (unparenting, clearing a
      // value); everywhere else it is an omitted-argument mistake and must not
      // be silently embedded into the generated ExtendScript.
      if (!param.nullable && param.type !== "any") {
        issues.push({
          path: param.name,
          message: `must be ${param.type}, got null — omit the key instead of passing null`,
        });
      }
      continue;
    }
    if (!typeMatches(param.type, value)) {
      issues.push({
        path: param.name,
        message: `must be ${param.type}, got ${describeValue(value)}`,
      });
    }
  }

  for (const key of Object.keys(raw)) {
    if (declaredNames.includes(key)) continue;
    if (raw[key] === undefined) continue;
    const suggestion = suggestName(key, declaredNames);
    issues.push({
      path: key,
      message: suggestion
        ? `unknown parameter — did you mean '${suggestion}'?`
        : `unknown parameter (this operation accepts: ${declaredNames.join(", ") || "no parameters"})`,
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: raw };
}
