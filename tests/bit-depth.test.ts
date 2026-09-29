// Offline codegen tests for the 32bpc effect guard: effect.add's refusal of
// effects that process below 32bpc, effect.bit_depth, and the bitDepth
// option on project.list_effects. Whether the measurement itself is right is
// covered by tests/e2e/bit-depth.test.ts against a real After Effects.

import { readFileSync } from "node:fs";
import * as vm from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

import { getOp } from "../src/registry.js";
import { doTool } from "../src/tools/do.js";
// Importing the operation registry for its registration side effects.
import "../src/operations/index.js";
import { SAMPLES } from "./fixtures/bit-depth-samples.js";
import { nullTransport } from "./helpers/null-transport.js";

interface DoResponse {
  isError?: boolean;
  structuredContent?: { error?: { code: string; message: string; hint?: string } };
}

describe("effect.add bit-depth guard", () => {
  it("measures the effect only in a 32bpc project and refuses one below 32bpc", () => {
    const jsx = getOp("effect.add")!.toJsx({ comp: "Main", layer: 1, matchName: "ADBE Mosaic" });
    expect(jsx).toContain("app.project.bitsPerChannel === 32");
    expect(jsx).toContain("AE.effectBitDepth(_mn, null)");
    expect(jsx).toContain("_depth.bpc < 32 && false !== true");
    // The measurement must happen BEFORE the effect lands on the layer, so a
    // refusal leaves nothing behind.
    expect(jsx.indexOf("AE.effectBitDepth")).toBeLessThan(jsx.indexOf("addProperty(_mn)"));
  });

  it("allowLowBitDepth: true lets the effect through with a warning", () => {
    const jsx = getOp("effect.add")!.toJsx({
      comp: "Main",
      layer: 1,
      matchName: "ADBE Mosaic",
      allowLowBitDepth: true,
    });
    expect(jsx).toContain("_depth.bpc < 32 && true !== true");
    expect(jsx).toContain("added because allowLowBitDepth: true");
  });

  it("embeds the matchName as a literal, never raw", () => {
    const jsx = getOp("effect.add")!.toJsx({
      comp: "Main",
      layer: 1,
      matchName: 'x"); evil(); ("',
    });
    expect(jsx).toContain('var _mn = "x\\"); evil(); (\\"";');
  });
});

describe("effect.bit_depth", () => {
  it("measures every matchName through AE.effectBitDepth", () => {
    const op = getOp("effect.bit_depth")!;
    expect(op.readOnly).not.toBe(true);
    const jsx = op.toJsx({ matchNames: ["ADBE Gaussian Blur 2", "ADBE Mosaic"] });
    expect(jsx).toContain('["ADBE Gaussian Blur 2","ADBE Mosaic"]');
    expect(jsx).toContain("AE.effectBitDepth(String(_mns[_i]), _known[_i] || null)");
  });

  it("requires matchNames", async () => {
    const res = (await doTool.handler(
      { operation: "effect.bit_depth", args: {} },
      nullTransport(),
    )) as DoResponse;
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error?.code).toBe("INVALID_ARGS");
  });
});

describe("project.list_effects filters and bitDepth", () => {
  const prevReadOnly = process.env.AE_MCP_READONLY;
  afterEach(() => {
    if (prevReadOnly === undefined) delete process.env.AE_MCP_READONLY;
    else process.env.AE_MCP_READONLY = prevReadOnly;
  });

  it("filters case-insensitively and measures only when asked", () => {
    const op = getOp("project.list_effects")!;
    const plain = op.toJsx({ category: "Blur & Sharpen" });
    expect(plain).toContain('var _cat = "blur & sharpen"');
    expect(plain).toContain("var _measure = false");
    const measured = op.toJsx({ search: "Blur", bitDepth: true });
    expect(measured).toContain('var _q = "blur"');
    expect(measured).toContain("var _measure = true");
    expect(measured).toContain("AE.effectBitDepth(list[j].matchName, _known.hasOwnProperty");
  });

  it("runs the curated fallback through the same filters and measurement", () => {
    const jsx = getOp("project.list_effects")!.toJsx({
      category: "Blur & Sharpen",
      bitDepth: true,
    });
    expect(jsx).toContain('_source = "curated"');
    // One filter/measure loop over whichever source was found.
    expect(jsx.match(/_cat !== null/g)).toHaveLength(1);
    expect(jsx).toContain(
      "return { source: _source, projectBpc: app.project.bitsPerChannel, effects: list }",
    );
  });

  it("refuses to measure under AE_MCP_READONLY — the probe adds a temporary comp", () => {
    process.env.AE_MCP_READONLY = "1";
    const op = getOp("project.list_effects")!;
    expect(op.toJsx({ bitDepth: true })).toContain("AE_MCP_READONLY=1 does not allow");
    // Listing alone stays available in read-only mode.
    expect(op.toJsx({})).not.toContain("AE_MCP_READONLY=1 does not allow");
  });
});

describe("ae_do surfaces an operation's own hint", () => {
  it("passes { ok: false, hint } from the JSX result through to the error", async () => {
    const transport = nullTransport({
      result: {
        result: { ok: false, error: "processes at 16bpc", hint: "Use a 32bpc effect" },
        context: {},
      },
    });
    const res = (await doTool.handler(
      { operation: "effect.add", args: { comp: "Main", layer: 1, matchName: "ADBE Mosaic" } },
      transport,
    )) as DoResponse;
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error?.code).toBe("OPERATION_FAILED");
    expect(res.structuredContent?.error?.hint).toBe("Use a 32bpc effect");
  });
});

/** jsx/toolkit.jsx loaded into a sandbox; its bit-depth code is plain ES3. */
function loadToolkit(): Record<string, (...args: unknown[]) => unknown> {
  const ctx = vm.createContext({ AE: {}, $: { global: {} } });
  const src = readFileSync(new URL("../jsx/toolkit.jsx", import.meta.url), "utf8");
  vm.runInContext(src.replace("var AE = AE || {};", ""), ctx);
  return (ctx as { AE: Record<string, (...args: unknown[]) => unknown> }).AE;
}

describe("AE._classifyBitDepthSamples on recorded output", () => {
  const AE = loadToolkit();
  const info = (bpc: number | null, reason: string) => ({ bpc, reason });
  const verdict = (name: string) => {
    const s = SAMPLES[name];
    const nums = (text: string) => text.split(",").map(Number);
    return (AE._classifyBitDepthSamples(nums(s.a), nums(s.b), info) as { bpc: number | null }).bpc;
  };

  it("matches the PiPL truth for bundled plug-ins", () => {
    expect(verdict("CC Light Rays")).toBe(32);
    // 16bpc even though the default settings pass the image through.
    expect(verdict("CC Bender")).toBe(16);
  });

  it("recognizes Adobe's 16bpc and 8bpc effects", () => {
    expect(verdict("ADBE AutoColor")).toBe(16);
    expect(verdict("ADBE Basic 3D")).toBe(8);
  });

  it("stays null when the output carries no information", () => {
    // Threshold is 32bpc per PiPL, but 0 / 0.75 / 1 sit on every grid.
    expect(verdict("CC Threshold")).toBeNull();
    // Fully transparent output.
    expect(verdict("ADBE 3D Glasses2")).toBeNull();
  });

  it("treats values outside 0-1 as float, and an input-independent 8-bit output as unknown", () => {
    const opaque = (v: number) => [v, v, v, 1];
    expect(
      (AE._classifyBitDepthSamples(opaque(1.4), opaque(2.3), info) as { bpc: number }).bpc,
    ).toBe(32);
    // A generator whose gradient lands on dyadic fractions (Gradient Ramp over
    // a power-of-two span) must not be read as 16bpc either.
    const ramp = [...opaque(38912 / 131072), ...opaque(70001 / 131072)];
    expect(
      (AE._classifyBitDepthSamples(ramp, ramp, info) as { bpc: number | null }).bpc,
    ).toBeNull();
    // Alpha is never unpremultiplied: off-grid alpha proves float even when
    // no pixel is opaque (Gaussian Blur's default blur).
    const soft = [0.4, 0.5, 0.6, 0.99871444702148];
    expect((AE._classifyBitDepthSamples(soft, soft, info) as { bpc: number }).bpc).toBe(32);
    const gen = [...opaque(60 / 255), ...opaque(200 / 255)];
    expect((AE._classifyBitDepthSamples(gen, gen, info) as { bpc: number | null }).bpc).toBeNull();
  });
});

describe("AE.effectBitDepth routing", () => {
  it("answers plug-in effects from the PiPL and never renders third-party ones", () => {
    const AE = loadToolkit();
    let measured = 0;
    AE._measureBitDepth = () => {
      measured++;
      return { cacheable: true, info: { bpc: 32 } };
    };
    expect(AE.effectBitDepth("CC Bender", { bpc: 16 })).toMatchObject({ bpc: 16, source: "pipl" });
    expect(AE.effectBitDepth("Universe_Distort_Holomatrix", null)).toMatchObject({ bpc: null });
    expect(AE.effectBitDepth("ADBE Apply Color LUT", null)).toMatchObject({ bpc: null });
    expect(measured).toBe(0);
    AE.effectBitDepth("ADBE Gaussian Blur 2", null);
    AE.effectBitDepth("ADBE Gaussian Blur 2", null);
    expect(measured).toBe(1); // cached
  });
});
