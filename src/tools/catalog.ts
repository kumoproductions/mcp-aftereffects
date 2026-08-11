import { z } from "zod";

import { errorResult } from "../errors.js";
import { denyOperation, denyUnregisteredCategory, policySummary, readOnlyMode } from "../policy.js";
import { listOps, type Operation } from "../registry.js";
import { defineTool, jsonResult } from "./define-tool.js";

/**
 * Operations the current policy allows. The catalog must never advertise
 * something `ae_do` will refuse — a model that plans against a filtered-out
 * operation wastes a round trip and, worse, may conclude the server is broken
 * rather than restricted.
 */
function visibleOps(category?: string): Operation[] {
  return listOps(category).filter((op) => denyOperation(op) === null);
}

function visibleCategories(): string[] {
  const categories = new Set<string>();
  for (const op of visibleOps()) categories.add(op.category);
  return Array.from(categories).sort();
}

export const catalogTool = defineTool({
  name: "ae_catalog",
  title: "Operation catalog",
  description:
    "Discover available atomic operations for ae_do. Without args: all categories with their " +
    "operation names. With a category: detailed params per operation. Only operations this " +
    "server will actually execute are listed.",
  group: "operations",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    category: z
      .string()
      .optional()
      .describe(
        "Filter by category. Omit to list all categories with operation counts, then drill into a specific category.",
      ),
  },
  handler: async (args, _transport) => {
    if (!args.category) {
      const summary = visibleCategories().map((c) => ({
        category: c,
        operationCount: visibleOps(c).length,
        operations: visibleOps(c).map((op) => op.name),
      }));
      return jsonResult({
        categories: summary,
        totalOperations: visibleOps().length,
        policy: policySummary(),
        undo: "every ae_do call runs in ONE automatic undo group — a single Ctrl+Z / project.undo reverts the whole call (batch.run included); never open an undo group yourself. undo/redo itself (project.undo, command.execute 16/2035) is the exception: it runs outside the group, so call it alone, never inside batch.run",
        ...(readOnlyMode()
          ? {
              note: "AE_MCP_READONLY=1 — only operations that cannot modify the project are listed.",
            }
          : {}),
      });
    }
    const ops = visibleOps(args.category);
    if (ops.length === 0) {
      const available = visibleCategories();
      const withheld = denyUnregisteredCategory(args.category);
      if (withheld) {
        return errorResult("FORBIDDEN", withheld.message, {
          details: { category: args.category, availableCategories: available },
          hint: withheld.hint,
        });
      }
      const hiddenByPolicy = listOps(args.category).length > 0;
      return errorResult(
        hiddenByPolicy ? "FORBIDDEN" : "UNKNOWN_CATEGORY",
        hiddenByPolicy
          ? `category '${args.category}' exists but every operation in it is blocked by the current policy (${policySummary()})`
          : `no operations in category '${args.category}'`,
        {
          details: { category: args.category, availableCategories: available },
          hint: `Available categories: ${available.join(", ")}`,
        },
      );
    }
    const details = ops.map((op) => ({
      name: op.name,
      description: op.description,
      readOnly: op.readOnly === true,
      params: op.params.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required ?? false,
        description: p.description,
        ...(p.nullable ? { nullable: true } : {}),
        ...(p.default !== undefined ? { default: p.default } : {}),
      })),
    }));
    return jsonResult({ category: args.category, operations: details });
  },
});
