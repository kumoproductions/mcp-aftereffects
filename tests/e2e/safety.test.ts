// End-to-end safety tests: destructive operations must refuse cleanly rather
// than half-apply.
//
// These are the regressions that offline tests cannot express. Each one used
// to damage the project and then hand back an error — a combination the
// dispatcher does not roll back, so an agent retrying on failure would be
// building on a broken comp. "Refused AND untouched" is the property under
// test, and only a real After Effects can prove the second half.
//
// SESSION-MUTATING: closes the project currently open in After Effects, swaps
// in a disposable fixture, and restores the original afterwards. Requires
// AE_MCP_E2E=1 on top of AE being reachable.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import type { SavedProjectState } from "./harness.js";
import {
  backupAndOpenTestProject,
  buildFixtureProject,
  opRunner,
  printSkipBanner,
  probeAe,
  restoreUserProject,
} from "./harness.js";

const E2E_ENABLED = process.env.AE_MCP_E2E === "1";

/** Position on the fixture's red_layer carries two keys (0s and 2s). */
const RED_POSITION = ["Transform", "Position"];

let ready = false;
let transport: FileIpcTransport | null = null;
let saved: SavedProjectState | null = null;
let ops: ReturnType<typeof opRunner> | null = null;

function o(): ReturnType<typeof opRunner> {
  if (!ops) throw new Error("suite not ready");
  return ops;
}

/**
 * Read project state directly, bypassing the operation registry.
 *
 * Deliberately not ae_do: these assertions are the control, and checking a
 * mutation with the same layer that performed it would let one bug hide
 * another.
 */
async function probe<T>(code: string): Promise<T> {
  const res = await transport!.execute({ code, label: "e2e_safety_probe", timeoutMs: 30_000 });
  if (!res.ok) throw new Error("state probe failed: " + res.error);
  return res.result as T;
}

const keyCountJsx = `
  var c = AE.findCompByNameOrId("test_comp");
  var l = AE.findLayerInComp(c, "red_layer");
  return { numKeys: l.property("Transform").property("Position").numKeys };
`;

describe("e2e safety", () => {
  beforeAll(async () => {
    if (!E2E_ENABLED) {
      printSkipBanner("safety", "SKIPPING — AE_MCP_E2E not set", [
        " This suite closes the project currently open in After Effects and",
        " restores it afterwards (session-mutating). Opt in explicitly:",
        "   PowerShell : $env:AE_MCP_E2E = '1'; npm test",
        "   cmd        : set AE_MCP_E2E=1 && npm test",
      ]);
      return;
    }
    const probeResult = await probeAe("safety");
    if (!probeResult.ready || !probeResult.transport) return;
    transport = probeResult.transport;
    saved = await backupAndOpenTestProject(transport);
    await buildFixtureProject(transport);
    ops = opRunner(transport);
    ready = true;
  }, 180_000);

  afterAll(async () => {
    if (transport && saved) {
      await restoreUserProject(transport, saved);
    }
  });

  it("property.remove refuses an empty path instead of deleting the layer", async (ctx) => {
    if (!ready) return ctx.skip();

    const before = await probe<{ numLayers: number }>(`
      var c = AE.findCompByNameOrId("test_comp");
      return { numLayers: c.numLayers };
    `);

    // property.add documents [] as "the layer root", so a caller has every
    // reason to try the same here — where it would resolve to Layer.remove().
    const err = await o().expectRefusal("property.remove", {
      comp: "test_comp",
      layer: "red_layer",
      property: [],
    });
    expect(err.message).toContain("empty");

    const after = await probe<{ numLayers: number; hasRed: boolean }>(`
      var c = AE.findCompByNameOrId("test_comp");
      return { numLayers: c.numLayers, hasRed: !!AE.findLayerInComp(c, "red_layer") };
    `);
    expect(after.numLayers, "the layer must survive a refused property.remove").toBe(
      before.numLayers,
    );
    expect(after.hasRed).toBe(true);
  });

  it("keyframe.shift refuses a negative result without destroying the keys", async (ctx) => {
    if (!ready) return ctx.skip();

    const before = await probe<{ numKeys: number }>(keyCountJsx);
    expect(before.numKeys, "fixture should have position keys").toBeGreaterThan(0);

    // The old order was removeAllKeys() then rebuild, so a throw inside the
    // rebuild left the property stripped.
    const err = await o().expectRefusal("keyframe.shift", {
      comp: "test_comp",
      layer: "red_layer",
      property: RED_POSITION,
      offset: -100,
    });
    expect(err.message).toMatch(/negative/i);

    const after = await probe<{ numKeys: number }>(keyCountJsx);
    expect(after.numKeys, "a refused shift must leave every key in place").toBe(before.numKeys);
  });

  it("keyframe.shift refuses a scale that would collapse two keys onto one time", async (ctx) => {
    if (!ready) return ctx.skip();

    const before = await probe<{ numKeys: number }>(keyCountJsx);

    const err = await o().expectRefusal("keyframe.shift", {
      comp: "test_comp",
      layer: "red_layer",
      property: RED_POSITION,
      scale: 0.0000001,
    });
    expect(err.message).toMatch(/collapse/i);

    const after = await probe<{ numKeys: number }>(keyCountJsx);
    expect(after.numKeys).toBe(before.numKeys);
  });

  it("keyframe.shift still applies a legitimate offset", async (ctx) => {
    if (!ready) return ctx.skip();

    // The guard must reject only the damaging cases — a normal retime still works.
    const before = await probe<{ numKeys: number; first: number }>(`
      var c = AE.findCompByNameOrId("test_comp");
      var p = AE.findLayerInComp(c, "red_layer").property("Transform").property("Position");
      return { numKeys: p.numKeys, first: p.keyTime(1) };
    `);

    const res = await o().run<{ numKeys: number; firstKeyTime: number }>("keyframe.shift", {
      comp: "test_comp",
      layer: "red_layer",
      property: RED_POSITION,
      offset: 0.5,
    });
    expect(res.numKeys).toBe(before.numKeys);
    expect(res.firstKeyTime).toBeCloseTo(before.first + 0.5, 4);

    await o().run("keyframe.shift", {
      comp: "test_comp",
      layer: "red_layer",
      property: RED_POSITION,
      offset: -0.5,
    });
  });

  it("marker.remove refuses a time that is nowhere near a marker", async (ctx) => {
    if (!ready) return ctx.skip();

    await o().run("marker.add_comp", { comp: "test_comp", time: 0, comment: "e2e marker" });
    const before = await o().run<{ count: number }>("marker.list", { comp: "test_comp" });
    expect(before.count).toBe(1);

    // nearestKeyIndex has no distance limit, so "remove the marker at 3s" used
    // to delete the only marker there was, at 0s.
    const err = await o().expectRefusal("marker.remove", { comp: "test_comp", time: 3 });
    expect(err.message).toMatch(/no marker at/i);

    const after = await o().run<{ count: number }>("marker.list", { comp: "test_comp" });
    expect(after.count, "the distant marker must survive").toBe(before.count);

    // Targeting the real time still works.
    await o().run("marker.remove", { comp: "test_comp", time: 0 });
    const cleared = await o().run<{ count: number }>("marker.list", { comp: "test_comp" });
    expect(cleared.count).toBe(0);
  });

  it("mask.remove reports an out-of-range index instead of a raw ExtendScript error", async (ctx) => {
    if (!ready) return ctx.skip();

    // PropertyGroup.property(index) throws on out-of-range rather than
    // returning null, so the null check alone never fired.
    const err = await o().expectRefusal("mask.remove", {
      comp: "test_comp",
      layer: "red_layer",
      maskIndex: 7,
    });
    expect(err.message).toMatch(/no mask at index 7/i);
  });

  it("shape operations reject a non-shape layer by name", async (ctx) => {
    if (!ready) return ctx.skip();

    const err = await o().expectRefusal("shape.add_repeater", {
      comp: "test_comp",
      layer: "Hello mcp-aftereffects",
      groupIndex: 1,
    });
    expect(err.message).toMatch(/not a shape layer|Contents/i);
  });

  it("text.set_style does not let smallCaps:false cancel allCaps:true", async (ctx) => {
    if (!ready) return ctx.skip();

    const readCaps = `
      var c = AE.findCompByNameOrId("test_comp");
      var l = AE.findLayerInComp(c, "Hello mcp-aftereffects");
      return { caps: String(l.property("Source Text").value.fontCapsOption) };
    `;

    await o().run("text.set_style", {
      comp: "test_comp",
      layer: "Hello mcp-aftereffects",
      allCaps: true,
    });
    const alone = await probe<{ caps: string }>(readCaps);

    await o().run("text.set_style", {
      comp: "test_comp",
      layer: "Hello mcp-aftereffects",
      allCaps: true,
      smallCaps: false,
    });
    const together = await probe<{ caps: string }>(readCaps);

    // Both flags write the same AE property. Sending them together must land
    // on the same result as sending allCaps by itself; it used to be clobbered
    // back to normal caps by the second assignment.
    expect(together.caps).toBe(alone.caps);
  });

  it("layer.bounds leaves the playhead where it found it", async (ctx) => {
    if (!ready) return ctx.skip();

    // Read back what AE actually stored: comp.time snaps to the frame grid, so
    // 1.5 on a 29.97 comp lands at 1.5015…, and comparing against the literal
    // would fail for a reason that has nothing to do with the restore.
    const set = await probe<{ time: number }>(`
      var c = AE.findCompByNameOrId("test_comp");
      c.time = 1.5;
      return { time: c.time };
    `);

    // sourcePointToComp is documented for text layers and can throw on a
    // solid; the restore has to survive that.
    await o()
      .run("layer.bounds", { comp: "test_comp", layer: "red_layer", time: 0 })
      .catch(() => undefined);

    const after = await probe<{ time: number }>(`
      var c = AE.findCompByNameOrId("test_comp");
      return { time: c.time };
    `);
    expect(after.time, "a readOnly op must not move the playhead").toBeCloseTo(set.time, 6);
  });
});
