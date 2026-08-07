// Offline stdio-level test: builds and spawns the real server binary
// (node dist/index.js) and talks MCP to it. Every path exercised here is
// resolved inside the Node process — After Effects is never contacted.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { McpTestClient } from "./harness.js";

const EXPECTED_TOOLS = [
  "ae_catalog",
  "ae_comp_info",
  "ae_context",
  "ae_do",
  "ae_layer_info",
  "ae_project_export_json",
  "ae_project_import_json",
  "ae_project_info",
  "ae_render_frame",
  "ae_save_project",
  "ae_version_info",
];

describe("mcp server over stdio (offline)", () => {
  const client = new McpTestClient();

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.close();
  });

  it("tools/list returns exactly the 11 ae_* tools", async () => {
    const res = await client.listTools();
    const names = res.tools.map((t) => t.name).toSorted();
    expect(names).toEqual(EXPECTED_TOOLS.toSorted());
  });

  it("ae_catalog without args lists categories including layer and keyframe", async () => {
    const payload = await client.call<{
      categories: Array<{ category: string; operationCount: number; operations: string[] }>;
      totalOperations: number;
    }>("ae_catalog");
    const categories = payload.categories.map((c) => c.category);
    expect(categories).toContain("layer");
    expect(categories).toContain("keyframe");
    expect(payload.totalOperations).toBeGreaterThan(0);
  });

  it("ae_catalog with an unknown category returns a coded error", async () => {
    const text = await client.callExpectError("ae_catalog", { category: "nonexistent" });
    expect(text).toContain("[UNKNOWN_CATEGORY]");
    expect(text).toContain("nonexistent");
  });

  it("ae_do with an unknown operation returns a coded error without touching AE", async () => {
    const text = await client.callExpectError("ae_do", { operation: "definitely.not.real" });
    expect(text).toContain("[UNKNOWN_OPERATION]");
    expect(text).toContain("definitely.not.real");
  });

  it("ae_do suggests the closest operation name for a typo", async () => {
    const text = await client.callExpectError("ae_do", { operation: "keyframe.ad" });
    expect(text).toContain("[UNKNOWN_OPERATION]");
    expect(text).toContain("keyframe.add");
  });

  it("ae_do rejects a missing required argument before contacting AE", async () => {
    // No `time`: this used to be embedded as `null` and only failed inside AE.
    const text = await client.callExpectError("ae_do", {
      operation: "keyframe.add",
      args: { comp: "Main", layer: 1, property: ["Transform", "Position"], value: [0, 0] },
    });
    expect(text).toContain("[INVALID_ARGS]");
    expect(text).toContain("time");
  });

  it("annotates readers, writers, and destructive tools distinctly", async () => {
    const res = (await client.listTools()) as {
      tools: Array<{ name: string; annotations?: Record<string, unknown> }>;
    };
    const byName = new Map(res.tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(byName.get("ae_project_info")).toMatchObject({ readOnlyHint: true });
    // ae_do used to carry no annotation at all, which clients tend to read as
    // "safe"; its real effect is whatever operation it dispatches.
    expect(byName.get("ae_do")).toMatchObject({ destructiveHint: true });
    expect(byName.get("ae_project_import_json")).toMatchObject({ destructiveHint: true });
    expect(byName.get("ae_render_frame")).toMatchObject({ destructiveHint: false });
  });

  it("ae_do rejects a misspelled argument key instead of silently dropping it", async () => {
    const text = await client.callExpectError("ae_do", {
      operation: "keyframe.add",
      args: {
        comp: "Main",
        lyaer: 1,
        property: ["Transform", "Position"],
        time: 0,
        value: [0, 0],
      },
    });
    expect(text).toContain("[INVALID_ARGS]");
    expect(text).toContain("did you mean 'layer'");
  });
});

describe("mcp server with AE_MCP_READONLY=1 (offline)", () => {
  const client = new McpTestClient();

  beforeAll(async () => {
    await client.connect({ AE_MCP_READONLY: "1" });
  });

  afterAll(async () => {
    await client.close();
  });

  it("withholds the project-mutating tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("ae_save_project");
    expect(names).not.toContain("ae_project_import_json");
    // Kept: reading, exporting, rendering, and ae_do for the read-only ops.
    expect(names).toContain("ae_project_info");
    expect(names).toContain("ae_render_frame");
    expect(names).toContain("ae_do");
  });

  it("advertises only operations it will actually run", async () => {
    const payload = await client.call<{
      categories: Array<{ category: string; operations: string[] }>;
      policy: string;
    }>("ae_catalog");
    const operations = payload.categories.flatMap((c) => c.operations);
    expect(operations).toContain("property.get");
    expect(operations).not.toContain("layer.create_solid");
    expect(operations).not.toContain("eval.run");
    expect(payload.policy).toContain("readonly=ON");
  });

  it("refuses a mutating operation with FORBIDDEN", async () => {
    const text = await client.callExpectError("ae_do", {
      operation: "layer.create_solid",
      args: { comp: "Main" },
    });
    expect(text).toContain("[FORBIDDEN]");
    expect(text).toContain("AE_MCP_READONLY");
  });
});
