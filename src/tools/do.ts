import { z } from "zod";

import { errorResult } from "../errors.js";
import { summarizeParams, suggestName, validateOpArgs } from "../opschema.js";
import { denyOperation, denyUnregisteredOperation } from "../policy.js";
import {
  AMBIENT_CONTEXT_JSX,
  denyAppConfig,
  getOp,
  listOps,
  wantsDialogSuppression,
  wantsUndoGroup,
} from "../registry.js";
import { defineTool, jsonResult, jsxReportedFailure } from "./define-tool.js";

export const doTool = defineTool({
  name: "ae_do",
  title: "Execute operation",
  description:
    "Execute an atomic operation by name (from ae_catalog). " +
    "Arguments are validated against the operation's declared parameters before anything reaches AE. " +
    "Have more than one operation to run? Wrap them in ONE batch.run instead of several ae_do calls — " +
    "read/verify steps (comp.info, layer.info, render.frame) can ride in the same batch. " +
    "Every call is automatically wrapped in ONE undo group: a single Ctrl+Z (or project.undo) reverts " +
    "the entire call, and a batch.run counts as one call. Never call app.beginUndoGroup/endUndoGroup " +
    "in eval.run code — the wrapper already did. The exception is undo/redo itself (project.undo, " +
    "command.execute id 16/2035): those run outside the group and cannot ride inside a batch.run. " +
    "Response includes ambient context (active comp, selected layers, project state) at zero extra round trips. " +
    "Example: ae_do({ operation: 'keyframe.add', args: { comp: 'Main', layer: 1, " +
    "property: ['Transform','Position'], time: 2, value: [960,540] } })",
  group: "operations",
  // NOT withheld in read-only mode: ae_do is the only way to reach the
  // read-only operations, and withholding it would leave ae_catalog listing
  // operations nothing can execute. Gating happens per operation below, via
  // denyOperation(). The destructive annotation still reflects the worst case
  // rather than leaving clients to guess from an absent hint.
  blockedInReadOnly: false,
  effect: "destructive",
  inputShape: {
    operation: z
      .string()
      .describe("Operation name from ae_catalog (e.g. 'layer.create_solid', 'keyframe.add')."),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Arguments for the operation. Validated against ae_catalog's declared params: missing required args, wrong types, and unknown keys are rejected before AE is contacted. Omit for zero-param operations.",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Per-call timeout in milliseconds (default 60000). Raise for long operations like render.start or big batch.run calls.",
      ),
  },
  handler: async (doArgs, transport) => {
    const op = getOp(doArgs.operation);
    if (!op) {
      // Withheld by configuration, not misspelled — say which switch, or the
      // model reads "unknown operation" as "this server cannot do that".
      const withheld = denyUnregisteredOperation(doArgs.operation);
      if (withheld) {
        return errorResult("FORBIDDEN", withheld.message, {
          details: { operation: doArgs.operation },
          hint: withheld.hint,
        });
      }
      const suggestion = suggestName(
        doArgs.operation,
        listOps().map((o) => o.name),
      );
      return errorResult("UNKNOWN_OPERATION", `unknown operation '${doArgs.operation}'`, {
        details: { operation: doArgs.operation, suggestion },
        hint: suggestion
          ? `Did you mean '${suggestion}'? Use ae_catalog to list operations.`
          : "Use ae_catalog to discover available operations.",
      });
    }

    const denial = denyOperation(op);
    if (denial) {
      return errorResult("FORBIDDEN", denial.message, {
        details: { operation: op.name, category: op.category },
        hint: denial.hint,
      });
    }

    // Validate BEFORE codegen. Without this the declared params were pure
    // documentation: a missing required arg became `null` in the generated
    // ExtendScript and a misspelled key was dropped on the floor — both only
    // observable after a full round trip to AE, if at all.
    const validated = validateOpArgs(op, doArgs.args);
    if (!validated.ok) {
      return errorResult(
        "INVALID_ARGS",
        `invalid arguments for '${op.name}': ` +
          validated.issues.map((i) => `${i.path} — ${i.message}`).join("; "),
        {
          details: {
            operation: op.name,
            issues: validated.issues,
            expected: summarizeParams(op.params),
          },
          hint: `ae_catalog({ category: '${op.category}' }) returns the full parameter reference.`,
        },
      );
    }

    // App-configuration ops require explicit user consent. The schema above
    // already demands the confirm param exist; this catches confirm: false,
    // which type-checks but does not consent.
    const consent = denyAppConfig(op, validated.value);
    if (consent) {
      return errorResult("FORBIDDEN", consent, {
        details: { operation: op.name, category: op.category },
        hint: "Ask the user first if they have not explicitly requested this change.",
      });
    }

    // Generate JSX from the operation's toJsx, then append ambient context gathering.
    const userJsx = op.toJsx(validated.value);
    const wrappedCode = `
        var _opResult = (function() {
            ${userJsx}
        })();
        ${AMBIENT_CONTEXT_JSX}
        return { result: _opResult, context: _ctx };
    `;
    // Lines of wrapper ABOVE the operation code, for mapping the dispatcher's
    // reported error line back to it. Measured, not hardcoded, so an edit to
    // the template above cannot silently desync the arithmetic.
    const wrapperLinesAboveUserJsx = countLines(wrappedCode.slice(0, wrappedCode.indexOf(userJsx)));

    const result = await transport.execute({
      code: wrappedCode,
      label: op.name,
      // Undo/Redo opt out (Operation.undoGroup): they must reach AE with no
      // group open, or they resolve against this call's own group instead of
      // the previous call the caller means to revert.
      undoGroup: wantsUndoGroup(op, validated.value),
      // Undo/Redo also opt out of dialog suppression (Operation.suppressDialogs)
      // — the suppression scope would swallow the undo the same way a group
      // does. Project boundary ops keep suppression despite running ungrouped.
      suppressDialogs: wantsDialogSuppression(op, validated.value),
      timeoutMs: doArgs.timeoutMs ?? 60_000,
    });

    if (!result.ok) {
      return errorResult(result.errorCode ?? "TRANSPORT", result.error ?? "unknown failure", {
        details: {
          operation: op.name,
          ...jsxErrorLocation(result.line, wrappedCode, wrapperLinesAboveUserJsx, op.name),
        },
        stack: result.stack,
        logs: result.logs,
        durationMs: result.durationMs,
        ...(typeof result.line === "number" && op.name === "eval.run"
          ? {
              hint:
                "The '(line N)' in the message counts lines of the ASSEMBLED script, not your code — " +
                "details.userCodeLine is the 1-based line in the code you passed, and details.codeExcerpt " +
                "shows the failing spot.",
            }
          : {}),
      });
    }

    const { result: opResult, context } = result.result as { result: unknown; context: unknown };

    // Operations report application-level failure by RETURNING
    // `{ ok: false, error }` — the script ran fine, so the transport reports
    // success. batch.run rides the same path: it aggregates its children's
    // failures into its own `ok`, so "8 of 10 sub-operations failed" can no
    // longer reach the model as a successful call.
    const reported = jsxReportedFailure(opResult);
    if (reported) {
      return errorResult("OPERATION_FAILED", `${op.name}: ${reported.error}`, {
        details: { operation: op.name, result: opResult, context },
        logs: result.logs,
        durationMs: result.durationMs,
        ...(isBatchShaped(opResult)
          ? {
              hint: "Inspect details.result.results — each entry matches the input order and carries its own error.",
            }
          : {}),
      });
    }

    return jsonResult({
      result: opResult,
      context,
      logs: result.logs,
      durationMs: result.durationMs,
    });
  },
});

/** True for a batch.run-style result carrying a per-child `results` array. */
function isBatchShaped(opResult: unknown): boolean {
  if (opResult === null || typeof opResult !== "object") return false;
  return Array.isArray((opResult as { results?: unknown }).results);
}

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

/**
 * new Function's synthesized `function anonymous(...) {` header occupies
 * line 1 of the compiled body, so ExtendScript reports the wrapped code's
 * line N as N+1. Verified empirically on AE 26.3 (ExtendScript 4.5.6).
 */
const NEW_FUNCTION_HEADER_LINES = 1;

/**
 * Map the dispatcher's error line back to the code the caller can actually
 * see. Returns `errorLine` (raw, as reported), `userCodeLine` (1-based line
 * in the operation's own JSX — for eval.run, the caller's script), and
 * `codeExcerpt` (the failing line ±2 of the assembled script). Empty when the
 * dispatcher predates the field or the script failed before compiling.
 */
function jsxErrorLocation(
  line: number | null | undefined,
  wrappedCode: string,
  wrapperLinesAboveUserJsx: number,
  opName: string,
): Record<string, unknown> {
  if (typeof line !== "number" || !Number.isFinite(line)) return {};
  const wrappedLine = line - NEW_FUNCTION_HEADER_LINES; // 1-based into wrappedCode
  const out: Record<string, unknown> = { errorLine: line };
  const userLine = wrappedLine - wrapperLinesAboveUserJsx;
  // Only eval.run's code is something the caller wrote line-by-line; for other
  // operations the excerpt is the useful part and a "user line" would mislead.
  if (opName === "eval.run" && userLine >= 1) out.userCodeLine = userLine;
  const lines = wrappedCode.split("\n");
  if (wrappedLine >= 1 && wrappedLine <= lines.length) {
    const from = Math.max(1, wrappedLine - 2);
    const to = Math.min(lines.length, wrappedLine + 2);
    const excerpt: string[] = [];
    for (let n = from; n <= to; n++) {
      excerpt.push(
        `${n === wrappedLine ? ">" : " "} ${n - wrapperLinesAboveUserJsx}| ${lines[n - 1]}`,
      );
    }
    out.codeExcerpt = excerpt.join("\n");
  }
  return out;
}
