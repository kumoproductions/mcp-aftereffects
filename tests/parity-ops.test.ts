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

describe("mask.set_props extended attributes", () => {
  it("sets MaskPropertyGroup attributes and maps the enums", () => {
    const op = getOp("mask.set_props");
    const jsx = op!.toJsx({
      comp: "Main",
      layer: 1,
      maskIndex: 1,
      inverted: true,
      rotoBezier: true,
      motionBlur: "on",
      featherFalloff: "linear",
    });
    expect(jsx).toContain("_mask.inverted = true");
    expect(jsx).toContain("_mask.rotoBezier = true");
    expect(jsx).toContain("MaskMotionBlur.ON");
    expect(jsx).toContain("MaskFeatherFalloff.FFO_LINEAR");
  });

  it("emits no attribute sets when only classic params are passed", () => {
    const op = getOp("mask.set_props");
    const jsx = op!.toJsx({ comp: "Main", layer: 1, maskIndex: 1, opacity: 50 });
    expect(jsx).not.toContain("_mask.inverted");
    expect(jsx).toContain("ADBE Mask Opacity");
  });
});

describe("mask.set_path variable-width feather", () => {
  it("requires the three point arrays to agree and pads the optional ones", () => {
    const op = getOp("mask.set_path");
    const jsx = op!.toJsx({
      comp: "Main",
      layer: 1,
      maskIndex: 1,
      vertices: [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      featherSegLocs: [0, 1],
      featherRelSegLocs: [0.5, 0.5],
      featherRadii: [20, -10],
    });
    expect(jsx).toContain("featherSegLocs");
    expect(jsx).toContain("must all be present with the same length");
    expect(jsx).toContain("_padded(");
  });

  it("emits no feather code when unused", () => {
    const op = getOp("mask.set_path");
    const jsx = op!.toJsx({ comp: "Main", layer: 1, maskIndex: 1, vertices: [[0, 0]] });
    expect(jsx).not.toContain("featherSegLocs");
  });
});

describe("marker cue point fields", () => {
  it("marker.add_comp writes cue point name, type, and parameters", () => {
    const op = getOp("marker.add_comp");
    const jsx = op!.toJsx({
      comp: "Main",
      time: 1,
      comment: "cue",
      cuePointName: "scene1",
      eventCuePoint: true,
      params: { speaker: "A" },
    });
    expect(jsx).toContain('_mv.cuePointName = "scene1"');
    expect(jsx).toContain("_mv.eventCuePoint = true");
    expect(jsx).toContain("setParameters");
  });

  it("marker.update accepts frameTarget alongside url", () => {
    const op = getOp("marker.update");
    const jsx = op!.toJsx({
      comp: "Main",
      keyIndex: 1,
      url: "https://example.com",
      frameTarget: "_blank",
    });
    expect(jsx).toContain('_mv.frameTarget = "_blank"');
  });

  it("marker.list surfaces the cue point fields", () => {
    const op = getOp("marker.list");
    const jsx = op!.toJsx({ comp: "Main" });
    expect(jsx).toContain("cuePointName");
    expect(jsx).toContain("getParameters");
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
