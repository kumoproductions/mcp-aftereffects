// Batch operation — run multiple registry ops in a single IPC call.
// This was the #1 pain point: parallel ae_do calls conflict on file IPC.
// ae_do("batch.run", { ops: [...] }) executes them sequentially in one shot.

import { summarizeParams, validateOpArgs } from "../opschema.js";
import { denyOperation, denyUnregisteredOperation } from "../policy.js";
import { getOp, jsxVal, registerOp } from "../registry.js";

registerOp({
  name: "batch.run",
  category: "batch",
  description:
    "Execute multiple operations in a single IPC call (~400ms total instead of 400ms × N). " +
    "Operations run sequentially inside ONE undo group — a single Ctrl+Z reverts the whole batch, " +
    "however many ops it contained. If one fails, subsequent ops still run unless stopOnError. " +
    "Results array matches input order; the response reports how many failed. " +
    "Mix in read/verify children — comp.info, layer.info, render.frame — to mutate AND verify in " +
    "the same call, e.g. [...mutations, { operation: 'render.frame', args: { … } }].",
  params: [
    {
      name: "ops",
      type: "array",
      description:
        'Array of { operation, args } objects, e.g. [{ "operation": "layer.create_solid", "args": { "comp": "Main", "color": [1,0,0] } }]',
      required: true,
    },
    {
      name: "stopOnError",
      type: "boolean",
      description: "Stop executing remaining ops if one fails (default false)",
      required: false,
    },
  ],
  // The wrapper itself mutates nothing; each child is gated individually below,
  // so a batch of read-only operations stays usable under AE_MCP_READONLY.
  readOnly: true,
  toJsx(args) {
    if (!Array.isArray(args.ops)) {
      return `
                return { ok: false, error: "ops must be an array" };
            `;
    }
    const ops = args.ops as Array<{ operation?: unknown; args?: unknown }>;
    const stopOnError = !!args.stopOnError;

    // Generate JSX for each operation inline. Every child goes through the same
    // policy + argument validation gate as a top-level ae_do call — batching
    // must not be a way to smuggle an unvalidated or forbidden operation past
    // the checks.
    const opBlocks: string[] = [];
    for (let i = 0; i < ops.length; i++) {
      const entry = ops[i];
      const opName =
        entry && typeof entry === "object" && typeof entry.operation === "string"
          ? entry.operation
          : undefined;
      const op = opName !== undefined ? getOp(opName) : undefined;

      if (!op) {
        // Same distinction the top-level ae_do path makes: withheld by
        // configuration reads very differently from misspelled.
        const withheld = opName !== undefined ? denyUnregisteredOperation(opName) : null;
        opBlocks.push(
          rejectBlock(
            i,
            withheld ? denialText(withheld) : `unknown operation: ${String(opName)}`,
            stopOnError,
          ),
        );
        continue;
      }
      const denial = denyOperation(op);
      if (denial) {
        opBlocks.push(rejectBlock(i, denialText(denial), stopOnError));
        continue;
      }
      const validated = validateOpArgs(op, entry.args);
      if (!validated.ok) {
        const detail =
          `invalid arguments for '${op.name}': ` +
          validated.issues.map((issue) => `${issue.path} — ${issue.message}`).join("; ") +
          ` (expects ${summarizeParams(op.params).join(", ") || "no parameters"})`;
        opBlocks.push(rejectBlock(i, detail, stopOnError));
        continue;
      }

      const jsx = op.toJsx(validated.value);
      opBlocks.push(`
                if (!_stopped) {
                    try {
                        var _r${i} = (function() { ${jsx} })();
                        if (_r${i} && _r${i}.ok === false) { _failed++; ${stopOnError ? `_stopped = true;` : ""} }
                        _results.push(_r${i});
                    } catch(e) {
                        _failed++;
                        _results.push({ ok: false, error: String(e) });
                        ${stopOnError ? "_stopped = true;" : ""}
                    }
                } else {
                    _results.push({ skipped: true });
                }
            `);
    }

    return `
            var _results = [];
            var _failed = 0;
            var _stopped = false;
            ${opBlocks.join("\n")}
            return {
                ok: _failed === 0,
                error: _failed === 0 ? null : (_failed + " of " + _results.length + " operations failed"),
                results: _results,
                count: _results.length,
                failed: _failed
            };
        `;
  },
});

/**
 * Flatten a denial into one string. A batch child has no room for a structured
 * error, and this text is all the model ever sees — dropping the hint would
 * leave it knowing it was refused but not what to do about it.
 */
function denialText(denial: { message: string; hint?: string }): string {
  return denial.hint ? `${denial.message} — ${denial.hint}` : denial.message;
}

/**
 * A child rejected before it ever reached AE (unknown, forbidden, or invalid
 * args). It still occupies its slot in `results` so indices keep matching the
 * caller's input order.
 */
function rejectBlock(index: number, message: string, stopOnError: boolean): string {
  return `
                if (!_stopped) {
                    _failed++;
                    _results.push({ ok: false, error: ${jsxVal(message)}, index: ${index} });
                    ${stopOnError ? "_stopped = true;" : ""}
                } else {
                    _results.push({ skipped: true });
                }
            `;
}
