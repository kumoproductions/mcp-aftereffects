// Capability policy: AE_MCP_READONLY, AE_MCP_ALLOW_CATEGORIES, and the
// per-operation gate they drive. The three enforcement points — tool
// registration, ae_catalog, and ae_do — must agree, or the catalog advertises
// operations that ae_do refuses.

import { afterEach, describe, expect, it } from "vitest";

import {
  allowedCategories,
  denyOperation,
  denyTool,
  evalRunEnabled,
  policySummary,
  readOnlyMode,
} from "../src/policy.js";
import { getOp } from "../src/registry.js";
import { catalogTool } from "../src/tools/catalog.js";
import { doTool } from "../src/tools/do.js";
import { ALL_TOOLS } from "../src/tools/index.js";
import "../src/operations/index.js";
// eval.run only enters the registry when AE_MCP_ENABLE_EVAL=1 is set at import
// time; register it directly so the policy gate itself is what these tests
// exercise, not the conditional import.
import "../src/operations/eval.js";
import { nullTransport } from "./helpers/null-transport.js";

const ENV_KEYS = ["AE_MCP_READONLY", "AE_MCP_ALLOW_CATEGORIES", "AE_MCP_ENABLE_EVAL"] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

function structured(res: { structuredContent?: unknown }): Record<string, unknown> {
  return (res.structuredContent ?? {}) as Record<string, unknown>;
}

describe("default policy", () => {
  it("allows declared operations but not eval.run", () => {
    expect(readOnlyMode()).toBe(false);
    expect(allowedCategories()).toBeNull();
    expect(evalRunEnabled()).toBe(false);
    expect(denyOperation(getOp("layer.create_solid")!)).toBeNull();
    expect(denyOperation(getOp("eval.run")!)).not.toBeNull();
  });
});

describe("AE_MCP_ENABLE_EVAL", () => {
  it("gates eval.run behind the opt-in", () => {
    expect(evalRunEnabled()).toBe(false);
    process.env.AE_MCP_ENABLE_EVAL = "1";
    expect(evalRunEnabled()).toBe(true);
    expect(denyOperation(getOp("eval.run")!)).toBeNull();
  });

  it("keeps eval.run out of ae_catalog until opted in", async () => {
    let res = await catalogTool.handler({}, nullTransport());
    let payload = structured(res) as {
      categories: Array<{ category: string; operations: string[] }>;
    };
    expect(payload.categories.flatMap((c) => c.operations)).not.toContain("eval.run");

    process.env.AE_MCP_ENABLE_EVAL = "1";
    res = await catalogTool.handler({}, nullTransport());
    payload = structured(res) as {
      categories: Array<{ category: string; operations: string[] }>;
    };
    expect(payload.categories.flatMap((c) => c.operations)).toContain("eval.run");
  });

  it("names the switch when eval.run is withheld from the registry entirely", async () => {
    // Without the opt-in, eval.run is never imported, so a plain registry miss
    // would report UNKNOWN_OPERATION with a spelling suggestion — which reads
    // as "this server cannot do that" and hides the opt-in. Verified against a
    // live AE: this is the path a real client actually hits.
    const transport = nullTransport();
    const res = await doTool.handler(
      { operation: "eval.run", args: { code: "return 1;" } },
      transport,
    );
    expect(res.isError).toBe(true);
    const err = structured(res).error as { code: string; hint?: string };
    expect(err.code).toBe("FORBIDDEN");
    expect(err.hint).toContain("AE_MCP_ENABLE_EVAL=1");
    expect(transport.calls).toHaveLength(0);
  });

  it("names the switch for ae_catalog({ category: 'eval' }) too", async () => {
    const res = await catalogTool.handler({ category: "eval" }, nullTransport());
    const err = structured(res).error as { code: string; hint?: string };
    expect(err.code).toBe("FORBIDDEN");
    expect(err.hint).toContain("AE_MCP_ENABLE_EVAL=1");
  });

  it("says so in a batch child as well, rather than 'unknown operation'", () => {
    const jsx = getOp("batch.run")!.toJsx({
      ops: [{ operation: "eval.run", args: { code: "x" } }],
    });
    expect(jsx).toContain("AE_MCP_ENABLE_EVAL=1");
    expect(jsx).not.toContain("unknown operation");
  });

  it("makes ae_do refuse eval.run without the opt-in, before contacting AE", async () => {
    const transport = nullTransport();
    const res = await doTool.handler(
      { operation: "eval.run", args: { code: "return 1;" } },
      transport,
    );
    expect(res.isError).toBe(true);
    expect((structured(res).error as { code: string }).code).toBe("FORBIDDEN");
    expect(transport.calls).toHaveLength(0);
  });
});

describe("AE_MCP_READONLY", () => {
  it("blocks mutating operations and keeps read-only ones", () => {
    process.env.AE_MCP_READONLY = "1";
    expect(denyOperation(getOp("layer.create_solid")!)).not.toBeNull();
    expect(denyOperation(getOp("project.clear")!)).not.toBeNull();
    expect(denyOperation(getOp("property.get")!)).toBeNull();
    expect(denyOperation(getOp("project.find_layers")!)).toBeNull();
  });

  it("disables eval.run even when AE_MCP_ENABLE_EVAL=1 is set", () => {
    process.env.AE_MCP_READONLY = "1";
    process.env.AE_MCP_ENABLE_EVAL = "1";
    expect(evalRunEnabled()).toBe(false);
  });

  it("withholds project-mutating tools but keeps rendering (the agent's eyes)", () => {
    process.env.AE_MCP_READONLY = "1";
    const withheld = ALL_TOOLS.filter((t) => denyTool(t.name, t.blockedInReadOnly) !== null).map(
      (t) => t.name,
    );
    expect(withheld.toSorted()).toEqual(["ae_project_import_json", "ae_save_project"]);
    const kept = ALL_TOOLS.filter((t) => denyTool(t.name, t.blockedInReadOnly) === null).map(
      (t) => t.name,
    );
    expect(kept).toContain("ae_render_frame");
    expect(kept).toContain("ae_project_export_json");
    // ae_do survives so the read-only operations stay reachable; each call is
    // gated by denyOperation instead.
    expect(kept).toContain("ae_do");
  });

  it("hides mutating operations from ae_catalog", async () => {
    process.env.AE_MCP_READONLY = "1";
    const res = await catalogTool.handler({}, nullTransport());
    const payload = structured(res) as {
      categories: Array<{ category: string; operations: string[] }>;
    };
    const all = payload.categories.flatMap((c) => c.operations);
    expect(all).toContain("property.get");
    expect(all).not.toContain("layer.create_solid");
    expect(all).not.toContain("eval.run");
  });

  it("makes ae_do refuse a mutating operation without contacting AE", async () => {
    process.env.AE_MCP_READONLY = "1";
    const transport = nullTransport();
    const res = await doTool.handler(
      { operation: "layer.create_solid", args: { comp: "Main" } },
      transport,
    );
    expect(res.isError).toBe(true);
    expect((structured(res).error as { code: string }).code).toBe("FORBIDDEN");
    expect(transport.calls).toHaveLength(0);
  });
});

describe("AE_MCP_ALLOW_CATEGORIES", () => {
  it("restricts operations to the listed categories", () => {
    process.env.AE_MCP_ALLOW_CATEGORIES = "keyframe, property";
    expect(denyOperation(getOp("keyframe.add")!)).toBeNull();
    expect(denyOperation(getOp("property.get")!)).toBeNull();
    expect(denyOperation(getOp("layer.create_solid")!)).not.toBeNull();
    expect(denyOperation(getOp("eval.run")!)).not.toBeNull();
  });

  it("reports a category that exists but is entirely blocked as FORBIDDEN", async () => {
    process.env.AE_MCP_ALLOW_CATEGORIES = "keyframe";
    const res = await catalogTool.handler({ category: "layer" }, nullTransport());
    expect(res.isError).toBe(true);
    expect((structured(res).error as { code: string }).code).toBe("FORBIDDEN");
  });

  it("still reports a genuinely unknown category as UNKNOWN_CATEGORY", async () => {
    const res = await catalogTool.handler({ category: "nope" }, nullTransport());
    expect((structured(res).error as { code: string }).code).toBe("UNKNOWN_CATEGORY");
  });
});

describe("policySummary", () => {
  it("describes the active configuration", () => {
    expect(policySummary()).toContain("readonly=off");
    process.env.AE_MCP_READONLY = "1";
    process.env.AE_MCP_ALLOW_CATEGORIES = "keyframe";
    expect(policySummary()).toContain("readonly=ON");
    expect(policySummary()).toContain("categories=keyframe");
    expect(policySummary()).toContain("eval.run=disabled");
  });
});
