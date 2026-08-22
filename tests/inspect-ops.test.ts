// The read/render operation twins (comp.info / layer.info / render.frame) and
// the multi-target read tools: what turns a mutate → verify loop, or a
// whole-comp audit, into ONE call instead of N.

import { afterEach, describe, expect, it } from "vitest";

import { denyOperation } from "../src/policy.js";
import { getOp } from "../src/registry.js";
import { compInfoTool } from "../src/tools/comp-info.js";
import { layerInfoTool } from "../src/tools/layer-info.js";
import "../src/operations/index.js";
import { nullTransport } from "./helpers/null-transport.js";

/**
 * render.frame rejects a relative outPath via `path.isAbsolute`, which is
 * platform-dependent: "C:/tmp/check.png" is absolute on Windows and relative
 * everywhere else, so hardcoding it made this suite pass locally and fail on
 * Linux CI for a reason unrelated to what it tests.
 */
const ABS_OUT_PATH = process.platform === "win32" ? "C:/tmp/check.png" : "/tmp/check.png";

afterEach(() => {
  delete process.env.AE_MCP_READONLY;
});

describe("read/render operation twins", () => {
  it("registers comp.info / layer.info / render.frame as read-only operations", () => {
    for (const name of ["comp.info", "layer.info", "render.frame"]) {
      const op = getOp(name);
      expect(op, name).toBeDefined();
      expect(op!.readOnly, name).toBe(true);
    }
  });

  it("survives AE_MCP_READONLY so audit sessions can still batch-verify", () => {
    process.env.AE_MCP_READONLY = "1";
    expect(denyOperation(getOp("comp.info")!)).toBeNull();
    expect(denyOperation(getOp("layer.info")!)).toBeNull();
    expect(denyOperation(getOp("render.frame")!)).toBeNull();
  });

  it("mixes with mutations inside one batch.run", () => {
    const jsx = getOp("batch.run")!.toJsx({
      ops: [
        { operation: "layer.create_null", args: { comp: "Main" } },
        { operation: "render.frame", args: { comp: "Main", time: 0, outPath: ABS_OUT_PATH } },
        { operation: "comp.info", args: { comp: "Main" } },
      ],
    });
    expect(jsx).toContain("addNull");
    expect(jsx).toContain("saveFrameToPng");
    expect(jsx).toContain("_compInfo");
  });

  it("render.frame refuses a relative outPath at codegen time", () => {
    const jsx = getOp("render.frame")!.toJsx({ comp: "Main", time: 0, outPath: "check.png" });
    expect(jsx).toContain("outPath must be absolute");
    expect(jsx).not.toContain("saveFrameToPng");
  });
});

describe("multi-target read tools", () => {
  it("ae_comp_info fetches an array of comps in one IPC call", async () => {
    const transport = nullTransport();
    await compInfoTool.handler({ nameOrId: ["Main", 42] }, transport);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].code).toContain("_targets");
    expect(transport.calls[0].code).toContain("_compInfo");
  });

  it("ae_layer_info fetches every layer with layerIndex: 'all' in one IPC call", async () => {
    const transport = nullTransport();
    await layerInfoTool.handler(
      { compNameOrId: "Main", layerIndex: "all", includeProperties: false },
      transport,
    );
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].code).toContain('_spec === "all"');
    expect(transport.calls[0].code).toContain("_layerFull");
  });

  it("single-target calls keep the scalar payload shape (no wrapper array)", async () => {
    const transport = nullTransport();
    await layerInfoTool.handler({ compNameOrId: "Main", layerIndex: 2 }, transport);
    expect(transport.calls[0].code).not.toContain("_idxs");
    expect(transport.calls[0].code).toContain(
      "return _layerFull(comp.layer(_idx), _incl, _detail);",
    );
  });
});
