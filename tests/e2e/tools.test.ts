// End-to-end tool tests. SESSION-MUTATING: closes the project currently open
// in After Effects, swaps in a disposable fixture project, and restores the
// original afterwards (dirty/unsaved projects are Save-As'd to runtime/
// first — see harness.backupAndOpenTestProject). Because that touches the
// user's AE session, this suite requires an explicit opt-in via
// AE_MCP_E2E=1 in addition to AE being reachable.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compInfoTool } from "../../src/tools/comp-info.js";
import { layerInfoTool } from "../../src/tools/layer-info.js";
import { projectInfoTool } from "../../src/tools/project-info.js";
import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import type { SavedProjectState } from "./harness.js";
import {
  backupAndOpenTestProject,
  buildFixtureProject,
  printSkipBanner,
  probeAe,
  restoreUserProject,
} from "./harness.js";

const E2E_ENABLED = process.env.AE_MCP_E2E === "1";

function extractStructured<T>(res: unknown): T {
  const r = res as { structuredContent?: unknown; isError?: boolean };
  if (r.isError) throw new Error("tool returned error: " + JSON.stringify(r.structuredContent));
  return r.structuredContent as T;
}

let ready = false;
let transport: FileIpcTransport | null = null;
let saved: SavedProjectState | null = null;

describe("e2e tools", () => {
  beforeAll(async () => {
    if (!E2E_ENABLED) {
      printSkipBanner("tools", "SKIPPING — AE_MCP_E2E not set", [
        " This suite closes the project currently open in After Effects and",
        " restores it afterwards (session-mutating). Opt in explicitly:",
        "   PowerShell : $env:AE_MCP_E2E = '1'; npm test",
        "   cmd        : set AE_MCP_E2E=1 && npm test",
      ]);
      return;
    }
    const probe = await probeAe("tools");
    if (!probe.ready || !probe.transport) return;
    transport = probe.transport;
    saved = await backupAndOpenTestProject(transport);
    await buildFixtureProject(transport);
    ready = true;
  });

  afterAll(async () => {
    if (transport && saved) {
      await restoreUserProject(transport, saved);
    }
  });

  it("ae_project_info: lists fixture items", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const info = await projectInfoTool.handler({}, transport);
    const data = extractStructured<{ result: { items: Array<{ name: string; type: string }> } }>(
      info,
    );
    const names = data.result.items.map((i) => i.name);
    expect(names, "items should include test_comp").toContain("test_comp");
    expect(names, "items should include red_solid").toContain("red_solid");
    expect(names, "items should include blue_solid").toContain("blue_solid");
    expect(names, "items should include test_folder").toContain("test_folder");
  });

  it("ae_comp_info: returns layer list for test_comp", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const info = await compInfoTool.handler({ nameOrId: "test_comp" }, transport);
    const data = extractStructured<{
      result: { found: boolean; layers: Array<{ name: string; type: string }>; width: number };
    }>(info);
    expect(data.result.found, "comp should be found").toBe(true);
    expect(data.result.width).toBe(1920);
    const layerNames = data.result.layers.map((l) => l.name);
    expect(layerNames, "red_layer missing").toContain("red_layer");
    expect(layerNames, "blue_layer missing").toContain("blue_layer");
    expect(layerNames, "text layer missing").toContain("Hello mcp-aftereffects");
  });

  it("ae_layer_info: returns transform keyframes", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    // Layers added in order: red, blue, text. But `layers.add` inserts at top,
    // so final stacking (top to bottom, index 1-based): text(1), blue(2), red(3).
    const info = await layerInfoTool.handler(
      { compNameOrId: "test_comp", layerIndex: 3 },
      transport,
    );
    const data = extractStructured<{
      result: {
        name: string;
        transformGroup: {
          properties: Array<{
            name: string;
            matchName: string;
            keyframes?: Array<{ time: number }>;
          }>;
        };
      };
    }>(info);
    expect(data.result.name, "expected red_layer at index 3").toBe("red_layer");
    const byMatch: Record<string, { keyframes?: Array<{ time: number }> }> = {};
    for (const p of data.result.transformGroup.properties) byMatch[p.matchName] = p;
    const pos = byMatch["ADBE Position"];
    expect(pos, "Position property missing (looked up by matchName ADBE Position)").toBeTruthy();
    expect((pos?.keyframes ?? []).length, "expected >=2 position keyframes").toBeGreaterThanOrEqual(
      2,
    );
  });

  it("transport escape hatch: eval-style execute with log breadcrumbs", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const res = await transport.execute({
      code: `
        log("active item: " + (app.project.activeItem ? app.project.activeItem.name : "none"));
        return { numItems: app.project.numItems };
      `,
      label: "e2e_eval",
    });
    expect(res.ok, `expected ok, got: ${res.error}`).toBe(true);
    expect(res.logs, "one log expected").toHaveLength(1);
    const r = res.result as { numItems: number };
    expect(r.numItems, "fixture should have >= 4 items").toBeGreaterThanOrEqual(4);
  });
});
