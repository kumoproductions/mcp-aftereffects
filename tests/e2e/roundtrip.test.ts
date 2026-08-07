// Round-trip verification: build fixture → export to JSON → clear → import →
// verify structural equality. This is the final integration test for the
// export/import pair.
//
// SESSION-MUTATING: closes the project currently open in After Effects and
// restores it afterwards, so it requires AE_MCP_E2E=1 in addition to AE being
// reachable (same gate as tools.test.ts).
//
// Strategy:
//   1. Back up the user's current project
//   2. Open fresh project, build fixture
//   3. ae_project_export_json → write to runtime/roundtrip.json
//   4. Re-open fresh project (clearFirst semantics)
//   5. ae_project_import_json → read runtime/roundtrip.json
//   6. Compare key structural invariants between the original and the imported
//      project: comp names, per-comp layer counts, sorted per-comp layer names.
//   7. Restore the user's project.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projectExportTool } from "../../src/tools/project-export.js";
import { projectImportTool } from "../../src/tools/project-import.js";
import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import type { SavedProjectState } from "./harness.js";
import {
  E2E_SCRATCH_DIR,
  backupAndOpenTestProject,
  buildFixtureProject,
  printSkipBanner,
  probeAe,
  restoreUserProject,
} from "./harness.js";

const E2E_ENABLED = process.env.AE_MCP_E2E === "1";
// Not the mailbox: the export tool refuses to write there, by design.
const ROUNDTRIP_JSON = path.join(E2E_SCRATCH_DIR, "roundtrip.json");

/** Structural view of a tool handler result, tolerant of the exact ToolResult type. */
function toolOutcome(res: unknown): { structuredContent?: unknown; isError?: boolean } {
  return res as { structuredContent?: unknown; isError?: boolean };
}

interface ProjectShape {
  itemNames: string[];
  compNames: string[];
  compLayerCounts: Record<string, number>;
  compLayerNames: Record<string, string[]>;
}

async function snapshotShape(transport: FileIpcTransport): Promise<ProjectShape> {
  const res = await transport.execute({
    code: `
      var proj = app.project;
      var itemNames = [];
      var compNames = [];
      var compLayerCounts = {};
      var compLayerNames = {};
      for (var i = 1; i <= proj.numItems; i++) {
          var it = proj.item(i);
          itemNames.push(it.name);
          if (it instanceof CompItem) {
              compNames.push(it.name);
              compLayerCounts[it.name] = it.numLayers;
              var names = [];
              for (var li = 1; li <= it.numLayers; li++) names.push(it.layer(li).name);
              compLayerNames[it.name] = names;
          }
      }
      itemNames.sort();
      compNames.sort();
      return {
          itemNames: itemNames,
          compNames: compNames,
          compLayerCounts: compLayerCounts,
          compLayerNames: compLayerNames
      };
    `,
    label: "snapshot_shape",
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error("snapshot failed: " + res.error);
  return res.result as ProjectShape;
}

async function resetToFresh(transport: FileIpcTransport): Promise<void> {
  const res = await transport.execute({
    code: `
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
      app.newProject();
      return { numItems: app.project.numItems };
    `,
    label: "reset_fresh",
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error("reset failed: " + res.error);
}

let ready = false;
let transport: FileIpcTransport | null = null;
let saved: SavedProjectState | null = null;
let beforeShape: ProjectShape | null = null;
let afterShape: ProjectShape | null = null;

describe("e2e roundtrip (export → import)", () => {
  beforeAll(async () => {
    if (!E2E_ENABLED) {
      printSkipBanner("roundtrip", "SKIPPING — AE_MCP_E2E not set", [
        " This suite closes the project currently open in After Effects and",
        " restores it afterwards (session-mutating). Opt in explicitly:",
        "   PowerShell : $env:AE_MCP_E2E = '1'; npm test",
        "   cmd        : set AE_MCP_E2E=1 && npm test",
      ]);
      return;
    }
    const probe = await probeAe("roundtrip");
    if (!probe.ready || !probe.transport) return;
    transport = probe.transport;
    saved = await backupAndOpenTestProject(transport);
    await buildFixtureProject(transport);
    beforeShape = await snapshotShape(transport);
    ready = true;
  });

  afterAll(async () => {
    if (transport && saved) {
      await restoreUserProject(transport, saved);
    }
  });

  it("export: writes the fixture project to runtime/roundtrip.json", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const exportRes = toolOutcome(
      await projectExportTool.handler({ outPath: ROUNDTRIP_JSON, pretty: true }, transport),
    );
    expect(
      exportRes.isError,
      "export failed: " + JSON.stringify(exportRes.structuredContent),
    ).toBeFalsy();
    const exportedBytes = (await fs.stat(ROUNDTRIP_JSON)).size;
    expect(exportedBytes).toBeGreaterThan(0);
  });

  it("reset: fresh project is empty", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    await resetToFresh(transport);
    const emptyShape = await snapshotShape(transport);
    expect(emptyShape.itemNames, "expected empty project after reset").toHaveLength(0);
  });

  it("import: rebuilds the project from runtime/roundtrip.json", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const importRes = toolOutcome(
      await projectImportTool.handler({ inPath: ROUNDTRIP_JSON }, transport),
    );
    expect(
      importRes.isError,
      "import failed: " + JSON.stringify(importRes.structuredContent),
    ).toBeFalsy();
    const sc = importRes.structuredContent as {
      result: { warnings: string[]; itemCount: number; createdCount: number };
    };
    expect(sc.result.createdCount).toBeGreaterThan(0);
    afterShape = await snapshotShape(transport);
  });

  it("roundtrip: all comps present", (ctx) => {
    if (!ready) return ctx.skip();
    expect(afterShape, "import step did not complete").not.toBeNull();
    expect(afterShape?.compNames).toEqual(beforeShape?.compNames);
  });

  it("roundtrip: layer counts per comp match", (ctx) => {
    if (!ready) return ctx.skip();
    expect(afterShape, "import step did not complete").not.toBeNull();
    for (const c of beforeShape?.compNames ?? []) {
      expect(afterShape?.compLayerCounts[c], `layer count for comp '${c}'`).toBe(
        beforeShape?.compLayerCounts[c],
      );
    }
  });

  it("roundtrip: layer names per comp match (sorted)", (ctx) => {
    if (!ready) return ctx.skip();
    expect(afterShape, "import step did not complete").not.toBeNull();
    for (const c of beforeShape?.compNames ?? []) {
      const before = (beforeShape?.compLayerNames[c] ?? []).toSorted();
      const after = (afterShape?.compLayerNames[c] ?? []).toSorted();
      expect(after, `layer names for comp '${c}'`).toEqual(before);
    }
  });
});
