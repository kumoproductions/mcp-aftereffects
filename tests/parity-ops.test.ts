// Offline codegen tests for the 2026 scripting-parity work: every op touched
// or added while closing the gap against the AE 2024–2026 scripting surface.
// These assert on generated JSX text only — whether AE accepts the calls is
// covered by the e2e suites.

import { describe, expect, it } from "vitest";

import { getOp } from "../src/registry.js";
// Importing the operation registry for its registration side effects.
import "../src/operations/index.js";

describe("layer.set_track_matte (AE 23.0 semantics)", () => {
  it("resolves the matte layer by name through AE.findLayerInComp", () => {
    const op = getOp("layer.set_track_matte");
    expect(op).toBeTruthy();
    const jsx = op!.toJsx({ comp: "Main", layer: 2, matteLayer: "matte src", matteType: "luma" });
    expect(jsx).toContain('AE.findLayerInComp(_comp, "matte src")');
    expect(jsx).toContain("setTrackMatte");
  });

  it("does not require a matte layer when removing", () => {
    const op = getOp("layer.set_track_matte");
    const jsx = op!.toJsx({ comp: "Main", layer: 2, matteType: "none" });
    expect(jsx).toContain("removeTrackMatte");
    // matteLayer omitted → embedded as null, never dereferenced on this path.
    expect(() => op!.toJsx({ comp: "Main", layer: 2, matteType: "none" })).not.toThrow();
  });
});

describe("project.find_layers type filter", () => {
  it("recognizes the AE 24.4+ / 26.3+ layer classes behind typeof guards", () => {
    const op = getOp("project.find_layers");
    const jsx = op!.toJsx({ type: "ThreeDModelLayer" });
    expect(jsx).toContain('typeof ThreeDModelLayer !== "undefined"');
    expect(jsx).toContain('typeof ParametricMeshLayer !== "undefined"');
    // Subclass checks must run before the AVLayer fallback swallows them.
    expect(jsx.indexOf("ThreeDModelLayer")).toBeLessThan(jsx.indexOf("instanceof AVLayer"));
  });
});

describe("layer.set_props enum coercion", () => {
  it("routes every assignment through AE.coerceLayerPropValue", () => {
    const op = getOp("layer.set_props");
    const jsx = op!.toJsx({
      comp: "Main",
      layer: "all",
      props: { samplingQuality: "bicubic", enabled: false },
    });
    expect(jsx).toContain('AE.coerceLayerPropValue("samplingQuality", "bicubic")');
    expect(jsx).toContain('AE.coerceLayerPropValue("enabled", false)');
  });
});
