import { z } from "zod";

import { errorResult } from "../errors.js";
import { summarizeParams, suggestName, validateOpArgs } from "../opschema.js";
import { denyOperation, denyUnregisteredOperation } from "../policy.js";
import { AMBIENT_CONTEXT_JSX, getOp, listOps } from "../registry.js";
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
    "in eval.run code — the wrapper already did. " +
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

    // Generate JSX from the operation's toJsx, then append ambient context gathering.
    const userJsx = op.toJsx(validated.value);
    const wrappedCode = `
        var _opResult = (function() {
            ${userJsx}
        })();
        ${AMBIENT_CONTEXT_JSX}
        return { result: _opResult, context: _ctx };
    `;

    const result = await transport.execute({
      code: wrappedCode,
      label: op.name,
      timeoutMs: doArgs.timeoutMs ?? 60_000,
    });

    if (!result.ok) {
      return errorResult(result.errorCode ?? "TRANSPORT", result.error ?? "unknown failure", {
        details: { operation: op.name },
        stack: result.stack,
        logs: result.logs,
        durationMs: result.durationMs,
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
