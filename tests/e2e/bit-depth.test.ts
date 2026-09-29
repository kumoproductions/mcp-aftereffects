// End-to-end coverage for the 32bpc effect guard: AE.effectBitDepth's
// measurement against effects whose depth is known, the project being left
// exactly as found, and effect.add refusing a sub-32bpc effect in a 32bpc
// project.
//
// SESSION-MUTATING: swaps the open project for a disposable one and restores
// it afterwards. Requires AE_MCP_E2E=1 on top of AE being reachable.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import "../../src/operations/index.js"; // side-effect import: fills the operation registry
import { doTool } from "../../src/tools/do.js";
import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import type { SavedProjectState } from "./harness.js";
import {
  backupAndOpenTestProject,
  printSkipBanner,
  probeAe,
  restoreUserProject,
} from "./harness.js";

const E2E_ENABLED = process.env.AE_MCP_E2E === "1";

// Known processing depths (Effects & Presets panel badges, AE 2024–2026).
const FLOAT_FX = "ADBE Gaussian Blur 2";
const SIXTEEN_FX = "ADBE Mosaic";

interface Measured {
  matchName: string;
  bpc: number | null;
  reason: string;
}

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

async function run<T>(operation: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await doTool.handler({ operation, args, timeoutMs: 120_000 }, transport!);
  return extractStructured<{ result: T }>(res).result;
}

async function projectState(): Promise<{ bpc: number; numItems: number }> {
  const res = await transport!.execute({
    code: "return { bpc: app.project.bitsPerChannel, numItems: app.project.numItems };",
    label: "bpc_state",
  });
  if (!res.ok) throw new Error("state read failed: " + res.error);
  return res.result as { bpc: number; numItems: number };
}

async function setBpc(bpc: number): Promise<void> {
  const res = await transport!.execute({
    // An OCIO color-managed project is 32bpc only ("Not supported for OCIO
    // color managed mode"); drop to Adobe color management first.
    code: `
      if (${bpc} !== 32 && typeof app.project.colorManagementSystem !== "undefined") {
          app.project.colorManagementSystem = 0;
      }
      app.project.bitsPerChannel = ${bpc};
      return { ok: true };
    `,
    label: "bpc_set",
  });
  if (!res.ok) throw new Error("bpc set failed: " + res.error);
}

async function effectNames(): Promise<string[]> {
  const info = await run<{ effects: Array<{ matchName: string }> }>("effect.list_on_layer", {
    comp: "bpc_comp",
    layer: 1,
  });
  return info.effects.map((e) => e.matchName);
}

describe("e2e effect bit depth", () => {
  beforeAll(async () => {
    if (!E2E_ENABLED) {
      printSkipBanner("bit-depth", "SKIPPING — AE_MCP_E2E not set", [
        " This suite closes the project currently open in After Effects and",
        " restores it afterwards (session-mutating). Opt in explicitly:",
        "   PowerShell : $env:AE_MCP_E2E = '1'; npm test",
      ]);
      return;
    }
    const probe = await probeAe("bit-depth");
    if (!probe.ready || !probe.transport) return;
    transport = probe.transport;
    saved = await backupAndOpenTestProject(transport);
    const res = await transport.execute({
      code: `
        // Measurements are cached per AE process; start from a clean slate so
        // this run really measures.
        $.global.AE_MCP_BIT_DEPTH_CACHE = {};
        var comp = app.project.items.addComp("bpc_comp", 320, 180, 1, 2, 24);
        comp.layers.addSolid([0.4, 0.5, 0.6], "bpc_solid", 320, 180, 1);
        return { ok: true };
      `,
      label: "bpc_fixture",
    });
    if (!res.ok) throw new Error("fixture setup failed: " + res.error);
    ready = true;
  }, 120_000);

  afterAll(async () => {
    if (transport && saved) {
      await restoreUserProject(transport, saved);
    }
  });

  it("measures known float and 16bpc effects and leaves a 32bpc project untouched", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    await setBpc(32);
    const before = await projectState();
    const res = await run<{ projectBpc: number; effects: Measured[] }>("effect.bit_depth", {
      matchNames: [FLOAT_FX, SIXTEEN_FX],
    });
    expect(res.projectBpc).toBe(32);
    expect(res.effects.map((e) => [e.matchName, e.bpc])).toEqual([
      [FLOAT_FX, 32],
      [SIXTEEN_FX, 16],
    ]);
    expect(await projectState()).toEqual(before);
  });

  it("measures in an 8/16bpc project too, restoring its depth afterwards", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    await setBpc(16);
    // Clear the cache so the probe really has to flip the project to 32bpc.
    await transport.execute({
      code: "$.global.AE_MCP_BIT_DEPTH_CACHE = {}; return 1;",
      label: "bpc_clear",
    });
    const before = await projectState();
    const res = await run<{ projectBpc: number; effects: Measured[] }>("effect.bit_depth", {
      matchNames: [SIXTEEN_FX, FLOAT_FX],
    });
    expect(res.projectBpc).toBe(16);
    expect(res.effects.map((e) => e.bpc)).toEqual([16, 32]);
    expect(await projectState()).toEqual(before);
  });

  it("effect.add refuses a 16bpc effect in a 32bpc project and adds nothing", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    await setBpc(32);
    const beforeFx = await effectNames();
    const err = extractError(
      await doTool.handler(
        { operation: "effect.add", args: { comp: "bpc_comp", layer: 1, matchName: SIXTEEN_FX } },
        transport,
      ),
    );
    expect(err.code).toBe("OPERATION_FAILED");
    expect(err.message).toContain("16bpc");
    expect(err.hint).toContain("allowLowBitDepth");
    expect(await effectNames()).toEqual(beforeFx);
  });

  it("effect.add with allowLowBitDepth adds it and says so; a float effect adds cleanly", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    await setBpc(32);
    const low = await run<{ ok: boolean; bpc: number; warning?: string }>("effect.add", {
      comp: "bpc_comp",
      layer: 1,
      matchName: SIXTEEN_FX,
      allowLowBitDepth: true,
    });
    expect(low.bpc).toBe(16);
    expect(low.warning).toContain("allowLowBitDepth");
    const float = await run<{ ok: boolean; bpc: number; warning?: string }>("effect.add", {
      comp: "bpc_comp",
      layer: 1,
      matchName: FLOAT_FX,
    });
    expect(float.bpc).toBe(32);
    expect(float.warning).toBeUndefined();
    expect(await effectNames()).toEqual(expect.arrayContaining([SIXTEEN_FX, FLOAT_FX]));
  });

  it("effect.add in a 16bpc project does not measure", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    await setBpc(16);
    const res = await run<{ ok: boolean; bpc?: number }>("effect.add", {
      comp: "bpc_comp",
      layer: 1,
      matchName: SIXTEEN_FX,
    });
    expect(res.ok).toBe(true);
    expect(res.bpc).toBeUndefined();
  });

  it("project.list_effects { search, bitDepth } annotates each match", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const res = await run<{ effects: Array<{ matchName: string; bpc: number | null }> }>(
      "project.list_effects",
      { search: "gaussian blur", bitDepth: true },
    );
    const gb = res.effects.find((e) => e.matchName === FLOAT_FX);
    expect(gb?.bpc).toBe(32);
    const tooMany = extractError(
      await doTool.handler(
        { operation: "project.list_effects", args: { bitDepth: true } },
        transport,
      ),
    );
    expect(tooMany.message).toContain("at most");
  });
});
