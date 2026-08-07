// batch.run codegen. Two properties matter: children go through the same
// validation and policy gate as a top-level ae_do call (batching must not be a
// smuggling route), and the batch reports how many of them failed rather than
// always returning ok.

import { afterEach, describe, expect, it } from "vitest";

import { getOp } from "../src/registry.js";
import "../src/operations/index.js";

afterEach(() => {
  delete process.env.AE_MCP_READONLY;
  delete process.env.AE_MCP_ALLOW_CATEGORIES;
});

const batch = () => getOp("batch.run")!;

describe("batch.run codegen", () => {
  it("aggregates child failures into its own ok flag", () => {
    const jsx = batch().toJsx({
      ops: [{ operation: "layer.create_null", args: { comp: "Main" } }],
    });
    expect(jsx).toContain("var _failed = 0;");
    expect(jsx).toContain("ok: _failed === 0");
    expect(jsx).toContain("failed: _failed");
  });

  it("rejects an unknown child without generating a call for it", () => {
    const jsx = batch().toJsx({ ops: [{ operation: "nope.nope", args: {} }] });
    expect(jsx).toContain("unknown operation: nope.nope");
    expect(jsx).toContain("_failed++");
  });

  it("rejects a child with invalid arguments at codegen time", () => {
    const jsx = batch().toJsx({
      ops: [
        // `time` missing — this used to be embedded as null and only blow up
        // inside AE, halfway through a batch that had already mutated things.
        {
          operation: "keyframe.add",
          args: { comp: "Main", layer: 1, property: ["Transform", "Position"], value: [0, 0] },
        },
      ],
    });
    expect(jsx).toContain("invalid arguments for 'keyframe.add'");
    expect(jsx).toContain("time");
    expect(jsx).not.toContain("setValueAtTime");
  });

  it("rejects a child the policy forbids", () => {
    process.env.AE_MCP_READONLY = "1";
    const jsx = batch().toJsx({
      ops: [{ operation: "layer.create_null", args: { comp: "Main" } }],
    });
    expect(jsx).toContain("AE_MCP_READONLY");
    expect(jsx).not.toContain("addNull");
  });

  it("keeps read-only children usable in read-only mode", () => {
    process.env.AE_MCP_READONLY = "1";
    const jsx = batch().toJsx({
      ops: [{ operation: "project.find_layers", args: { namePattern: "bg" } }],
    });
    expect(jsx).not.toContain("AE_MCP_READONLY");
    expect(jsx).toContain("matches.push");
  });

  it("keeps result slots aligned with input order when a child is rejected", () => {
    const jsx = batch().toJsx({
      ops: [
        { operation: "nope.one", args: {} },
        { operation: "layer.create_null", args: { comp: "Main" } },
        { operation: "nope.two", args: {} },
      ],
    });
    // Three pushes into _results, one per input entry.
    expect(jsx.match(/_results\.push/g)?.length).toBeGreaterThanOrEqual(3);
    expect(jsx).toContain("index: 0");
    expect(jsx).toContain("index: 2");
  });

  it("stops the remaining children when stopOnError is set", () => {
    const jsx = batch().toJsx({
      ops: [
        { operation: "nope.one", args: {} },
        { operation: "layer.create_null", args: { comp: "Main" } },
      ],
      stopOnError: true,
    });
    expect(jsx).toContain("_stopped = true;");
  });

  it("refuses a non-array ops argument", () => {
    expect(batch().toJsx({ ops: "not-an-array" })).toContain("ops must be an array");
  });
});
