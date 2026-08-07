import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { errorResult } from "../errors.js";
import { validateAeProjectDoc } from "../validate.js";
import { defineTool, jsonResult, toMcpResult } from "./define-tool.js";

export const projectImportTool = defineTool({
  name: "ae_project_import_json",
  title: "Import project JSON",
  description:
    "Rebuild the project from JSON (produced by ae_project_export_json). " +
    "Supports `clearFirst`, `dryRun` (validate-only), `skipValidation`.",
  group: "document",
  blockedInReadOnly: true,
  effect: "destructive",
  inputShape: {
    inPath: z
      .string()
      .optional()
      .describe(
        "Absolute path to a JSON document produced by ae_project_export_json. Mutually exclusive with `json`.",
      ),
    json: z
      .unknown()
      .optional()
      .describe("Inline JSON document (object, not string). Mutually exclusive with `inPath`."),
    clearFirst: z
      .boolean()
      .optional()
      .describe(
        "Remove all existing items from the current project before importing. Default: false (appends).",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "If true, validate the document and return a plan without touching AE. Useful for debugging malformed exports.",
      ),
    skipValidation: z
      .boolean()
      .optional()
      .describe(
        "Skip Node-side schema validation. Only use if you trust the input and want to hand broken data to AE for diagnosis.",
      ),
  },
  handler: async (args, transport) => {
    let doc: unknown;
    if (args.inPath) {
      const abs = path.resolve(args.inPath);
      try {
        doc = JSON.parse(await fs.readFile(abs, "utf8"));
      } catch (err) {
        return errorResult(
          "IO",
          `cannot read project document at ${abs}: ${err instanceof Error ? err.message : String(err)}`,
          { details: { inPath: abs } },
        );
      }
    } else if (args.json !== undefined) {
      doc = args.json;
    } else {
      return errorResult("INVALID_ARGS", "must provide either `inPath` or `json`", {
        hint: "`inPath` takes an absolute path to a document produced by ae_project_export_json; `json` takes the document inline as an object.",
      });
    }

    // Node-side validation: catch malformed docs before hitting AE.
    let warnings: unknown[] = [];
    if (!args.skipValidation) {
      const v = validateAeProjectDoc(doc);
      if (!v.ok) {
        return errorResult(
          "VALIDATION",
          "document failed schema validation:\n" +
            v.issues.map((i) => `  ${i.path || "(root)"}: ${i.message}`).join("\n"),
          {
            details: { issues: v.issues, warnings: v.warnings },
            hint: "Run with dryRun: true to inspect the plan, or skipValidation: true to hand the document to AE as-is for diagnosis.",
          },
        );
      }
      warnings = v.warnings;
    }

    // dryRun short-circuits BEFORE any AE mutation, with or without
    // validation — `skipValidation` must never turn a dry run into a real one.
    if (args.dryRun) {
      const items = (doc as { items?: unknown[] }).items ?? [];
      return jsonResult({
        dryRun: true,
        valid: !args.skipValidation,
        itemCount: items.length,
        warnings,
        summary: summarizePlan(doc),
      });
    }

    // The document travels as `payload`, NOT inlined into the generated source.
    // A real project serializes to megabytes; embedding that as an ExtendScript
    // literal meant handing the ES3 parser a multi-megabyte expression and
    // making every character in every layer name an escaping hazard. As a
    // payload it is parsed once, by JSON.parse, before our code ever runs.
    const code = `
        return AE.importProject(payload.doc, payload.opts);
    `;
    const result = await transport.execute({
      code,
      payload: { doc, opts: { clearFirst: !!args.clearFirst } },
      label: "project_import_json",
      timeoutMs: 600_000,
    });
    return toMcpResult(result);
  },
});

function summarizePlan(doc: unknown): Record<string, number | unknown> {
  const items = (doc as { items?: Array<{ type: string; layers?: unknown[] }> }).items ?? [];
  let folders = 0,
    comps = 0,
    solids = 0,
    files = 0,
    layers = 0;
  for (const it of items) {
    if (it.type === "FolderItem") folders++;
    else if (it.type === "CompItem") {
      comps++;
      if (Array.isArray(it.layers)) layers += it.layers.length;
    } else if (it.type === "FootageItem") {
      const sk = (it as unknown as { sourceKind?: string }).sourceKind;
      if (sk === "solid") solids++;
      else if (sk === "file") files++;
    }
  }
  return { folders, comps, solids, files, layers };
}
