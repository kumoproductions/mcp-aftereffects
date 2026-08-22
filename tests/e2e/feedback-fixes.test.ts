// End-to-end coverage for the 2026-08 user-feedback fixes:
//   - item types no longer collapse to "Folder" (ExtendScript parses chained
//     ternaries LEFT-associatively — the serializers now avoid chains)
//   - eval.run errors map the reported line back to the caller's code
//   - ae_layer_info detail:'summary' + keyframe ease/interp names
//   - render queue output directories are created before rendering
//   - render.set_output unknown-template warnings carry the available list
//   - AE.setEase / AE.rect eval helpers
//   - ae_render_frame `times` renders several frames in one call
//
// SESSION-MUTATING: swaps the open project for a disposable one and restores
// it afterwards. Requires AE_MCP_E2E=1 on top of AE being reachable.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import "../../src/operations/index.js"; // side-effect import: fills the operation registry
// eval.run only enters the registry when AE_MCP_ENABLE_EVAL=1 is set at import
// time; register it directly (same pattern as policy.test.ts) — the line-number
// test below flips the env var around its one call.
import "../../src/operations/eval.js";
import { contextTool } from "../../src/tools/context.js";
import { doTool } from "../../src/tools/do.js";
import { layerInfoTool } from "../../src/tools/layer-info.js";
import { projectInfoTool } from "../../src/tools/project-info.js";
import { renderFrameTool } from "../../src/tools/render-frame.js";
import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import type { SavedProjectState } from "./harness.js";
import {
  backupAndOpenTestProject,
  E2E_SCRATCH_DIR,
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

function extractError(res: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  hint?: string;
} {
  const r = res as { structuredContent?: { error?: unknown }; isError?: boolean };
  if (!r.isError) throw new Error("expected an error result, got: " + JSON.stringify(r));
  return r.structuredContent?.error as ReturnType<typeof extractError>;
}

let ready = false;
let transport: FileIpcTransport | null = null;
let saved: SavedProjectState | null = null;

describe("e2e feedback fixes", () => {
  beforeAll(async () => {
    if (!E2E_ENABLED) {
      printSkipBanner("feedback-fixes", "SKIPPING — AE_MCP_E2E not set", [
        " This suite closes the project currently open in After Effects and",
        " restores it afterwards (session-mutating). Opt in explicitly:",
        "   PowerShell : $env:AE_MCP_E2E = '1'; npm test",
      ]);
      return;
    }
    const probe = await probeAe("feedback-fixes");
    if (!probe.ready || !probe.transport) return;
    transport = probe.transport;
    saved = await backupAndOpenTestProject(transport);
    // Minimal mixed-type fixture: a folder, a comp, and a solid (whose source
    // is a FootageItem inside the auto-created "Solids" folder).
    const res = await transport.execute({
      code: `
        app.project.items.addFolder("fx_folder");
        var comp = app.project.items.addComp("fx_comp", 1920, 1080, 1, 2, 30);
        comp.layers.addSolid([1, 0, 0], "fx_solid", 1920, 1080, 1);
        return { ok: true };
      `,
      label: "fx_fixture",
    });
    if (!res.ok) throw new Error("fixture setup failed: " + res.error);
    ready = true;
  }, 120_000);

  afterAll(async () => {
    if (transport && saved) {
      await restoreUserProject(transport, saved);
    }
  });

  it("ae_context / ae_project_info report real item types, not all-Folder", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const ctxData = extractStructured<{
      result: { items: Array<{ name: string; type: string }> };
    }>(await contextTool.handler({}, transport));
    const byName = new Map(ctxData.result.items.map((i) => [i.name, i.type]));
    expect(byName.get("fx_comp")).toBe("CompItem");
    expect(byName.get("fx_folder")).toBe("FolderItem");
    expect(byName.get("fx_solid")).toBe("FootageItem");

    const projData = extractStructured<{
      result: { items: Array<{ name: string; type: string }> };
    }>(await projectInfoTool.handler({}, transport));
    const types = new Map(projData.result.items.map((i) => [i.name, i.type]));
    expect(types.get("fx_comp")).toBe("CompItem");
    expect(types.get("fx_folder")).toBe("FolderItem");
    expect(types.get("fx_solid")).toBe("FootageItem");
  });

  it("eval.run errors carry userCodeLine and a code excerpt", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    // eval.run is policy-gated; enable it for this test only.
    const prevEval = process.env.AE_MCP_ENABLE_EVAL;
    process.env.AE_MCP_ENABLE_EVAL = "1";
    try {
      const res = await doTool.handler(
        {
          operation: "eval.run",
          args: { code: "var a = 1;\nvar b = 2;\nnull.foo;\nreturn { ok: true };" },
        },
        transport,
      );
      const err = extractError(res);
      expect(err.code).toBe("JSX_THROW");
      expect(err.details?.userCodeLine, "line 3 holds the null deref").toBe(3);
      expect(String(err.details?.codeExcerpt)).toContain("null.foo");
      expect(String(err.hint)).toContain("userCodeLine");
    } finally {
      if (prevEval === undefined) delete process.env.AE_MCP_ENABLE_EVAL;
      else process.env.AE_MCP_ENABLE_EVAL = prevEval;
    }
  });

  it("AE.setEase applies ease; layer_info reports interp names + ease and summary drops defaults", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const setup = await transport.execute({
      code: `
        var comp = AE.findCompByNameOrId("fx_comp");
        var op = comp.layer(1).property("Transform").property("Opacity");
        op.setValueAtTime(0, 0);
        op.setValueAtTime(1, 100);
        AE.setEase(op, 2, 75, 33);
        var pos = comp.layer(1).property("Transform").property("Position");
        pos.setValueAtTime(0, [100, 100]);
        pos.setValueAtTime(1, [500, 500]);
        AE.setEase(pos, 1, 33, 90);
        return { ok: true, opKeys: op.numKeys, posKeys: pos.numKeys };
      `,
      label: "fx_ease",
    });
    expect(setup.ok, String(setup.error)).toBe(true);

    interface PropSpec {
      name: string;
      keyframes?: Array<{
        inInterpName?: string | null;
        outInterpName?: string | null;
        inEase?: Array<{ speed: number; influence: number }>;
        outEase?: Array<{ speed: number; influence: number }>;
      }>;
    }
    interface LayerPayload {
      result: {
        transformGroup: { properties: PropSpec[] } | null;
      };
    }
    const summaryRes = await layerInfoTool.handler(
      { compNameOrId: "fx_comp", layerIndex: 1, detail: "summary" },
      transport,
    );
    const summary = extractStructured<LayerPayload>(summaryRes);
    const sProps = summary.result.transformGroup?.properties ?? [];
    const sNames = sProps.map((p) => p.name);
    expect(sNames, "keyed Opacity must survive summary").toContain("Opacity");
    expect(sNames, "default Rotation must be dropped in summary").not.toContain("Rotation");

    const opacity = sProps.find((p) => p.name === "Opacity");
    const key2 = opacity?.keyframes?.[1];
    expect(key2?.inInterpName).toBe("bezier");
    expect(key2?.inEase?.[0]?.influence).toBeCloseTo(75, 3);
    // Spatial property: exactly ONE ease per key regardless of dimensions.
    const position = sProps.find((p) => p.name === "Position");
    expect(position?.keyframes?.[0]?.outEase).toHaveLength(1);
    expect(position?.keyframes?.[0]?.outEase?.[0]?.influence).toBeCloseTo(90, 3);

    const fullRes = await layerInfoTool.handler(
      { compNameOrId: "fx_comp", layerIndex: 1 },
      transport,
    );
    const full = extractStructured<LayerPayload>(fullRes);
    const fNames = (full.result.transformGroup?.properties ?? []).map((p) => p.name);
    expect(fNames, "full detail keeps default props").toContain("Rotation");
    const fullSize = JSON.stringify(full).length;
    const summarySize = JSON.stringify(summary).length;
    expect(
      summarySize,
      `summary (${summarySize}B) should be smaller than full (${fullSize}B)`,
    ).toBeLessThan(fullSize);
  });

  it("AE.rect builds a styled group in one call", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const res = await transport.execute({
      code: `
        var comp = AE.findCompByNameOrId("fx_comp");
        var shapeLayer = comp.layers.addShape();
        shapeLayer.name = "fx_shapes";
        var grp = AE.rect(shapeLayer, [200, 100], [0, 0], {
            name: "card", roundness: 8, fill: [0.2, 0.4, 0.9], stroke: [1, 1, 1], strokeWidth: 3
        });
        var inner = grp.property("Contents");
        var kinds = [];
        for (var i = 1; i <= inner.numProperties; i++) kinds.push(inner.property(i).matchName);
        return { ok: true, groupName: grp.name, kinds: kinds };
      `,
      label: "fx_rect",
    });
    expect(res.ok, String(res.error)).toBe(true);
    const r = res.result as { groupName: string; kinds: string[] };
    expect(r.groupName).toBe("card");
    expect(r.kinds).toContain("ADBE Vector Shape - Rect");
    expect(r.kinds).toContain("ADBE Vector Graphic - Fill");
    expect(r.kinds).toContain("ADBE Vector Graphic - Stroke");
  });

  it("render queue: output directory is created, unknown template warns with the available list", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const stamp = Date.now();
    const outDir = path.join(E2E_SCRATCH_DIR, `rq_dir_${stamp}`, "nested").replace(/\\/g, "/");
    const outPath = `${outDir}/out.avi`;

    extractStructured(
      await doTool.handler(
        { operation: "render.add_to_queue", args: { comp: "fx_comp", outputPath: outPath } },
        transport,
      ),
    );
    const setOut = extractStructured<{
      result: { warnings: string[] };
    }>(
      await doTool.handler(
        {
          operation: "render.set_output",
          args: {
            timeSpanStart: 0,
            timeSpanDuration: 1 / 30,
            outputTemplate: "definitely-not-a-template",
          },
        },
        transport,
      ),
    );
    expect(setOut.result.warnings.length).toBeGreaterThan(0);
    expect(setOut.result.warnings[0]).toContain("available:");

    const start = extractStructured<{ result: { ok: boolean; rendered: number } }>(
      await doTool.handler({ operation: "render.start", args: {}, timeoutMs: 180_000 }, transport),
    );
    expect(start.result.ok).toBe(true);
    // The render only succeeds if the directory existed by then; assert both.
    const entries = await fs.readdir(outDir);
    expect(entries.length, "rendered output should exist in the auto-created dir").toBeGreaterThan(
      0,
    );
    extractStructured(await doTool.handler({ operation: "render.clear_queue" }, transport));
  });

  it("ae_render_frame times: renders several frames in one call", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const stamp = Date.now();
    const base = path.join(E2E_SCRATCH_DIR, `frames_${stamp}`, "multi.png").replace(/\\/g, "/");
    const res = await renderFrameTool.handler(
      { compNameOrId: "fx_comp", times: [0, 0.5, 1], outPath: base },
      transport,
    );
    const data = extractStructured<{
      result: { frames: Array<{ ok: boolean; writtenTo?: string; time?: number }> };
    }>(res);
    expect(data.result.frames).toHaveLength(3);
    for (const [i, frame] of data.result.frames.entries()) {
      expect(frame.ok, `frame ${i} failed`).toBe(true);
      expect(frame.writtenTo).toContain(`multi_${i}.png`);
      const stat = await fs.stat(frame.writtenTo as string);
      expect(stat.size).toBeGreaterThan(0);
    }
    // `time` and `times` together must be rejected before reaching AE.
    const both = await renderFrameTool.handler(
      { compNameOrId: "fx_comp", time: 0, times: [0], outPath: base },
      transport,
    );
    expect(extractError(both).code).toBe("INVALID_ARGS");
  });
});
