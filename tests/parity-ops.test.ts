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

describe("layer.create_text box and vertical variants", () => {
  it("creates plain point text by default", () => {
    const op = getOp("layer.create_text");
    const jsx = op!.toJsx({ comp: "Main", text: "hi" });
    expect(jsx).toContain("addText(");
    expect(jsx).toContain("var _box = null");
  });

  it("routes to addBoxText / addVerticalBoxText with version guards", () => {
    const op = getOp("layer.create_text");
    const jsx = op!.toJsx({
      comp: "Main",
      text: "hi",
      boxSize: [400, 200],
      orientation: "vertical",
    });
    expect(jsx).toContain("addVerticalBoxText");
    expect(jsx).toContain("addBoxText");
    expect(jsx).toContain("AE 24.2+");
  });

  it("applies boxPosition after creation", () => {
    const op = getOp("layer.create_text");
    const jsx = op!.toJsx({ comp: "Main", boxSize: [400, 200], boxPosition: [10, 20] });
    expect(jsx).toContain("boxTextPos = [10,20]");
  });
});

describe("text.set_style extended attributes", () => {
  it("maps the AE 24.0 enums by fixed member names", () => {
    const op = getOp("text.set_style");
    const jsx = op!.toJsx({
      comp: "Main",
      layer: 1,
      autoKernType: "optical",
      direction: "rightToLeft",
      leadingType: "japanese",
      lineJoinType: "round",
      digitSet: "arabicRtl",
      baselineDirection: "verticalCrossStream",
      fontBaselineOption: "superscript",
      composerEngine: "universalType",
      lineOrientation: "verticalRtl",
    });
    expect(jsx).toContain("AutoKernType.OPTICAL_KERN");
    expect(jsx).toContain("ParagraphDirection.DIRECTION_RIGHT_TO_LEFT");
    expect(jsx).toContain("LeadingType.JAPANESE_LEADING_TYPE");
    expect(jsx).toContain("LineJoinType.LINE_JOIN_ROUND");
    expect(jsx).toContain("DigitSet.ARABIC_DIGITS_RTL");
    expect(jsx).toContain("BaselineDirection.BASELINE_VERTICAL_CROSS_STREAM");
    expect(jsx).toContain("FontBaselineOption.FONT_FAUXED_SUPERSCRIPT");
    expect(jsx).toContain("ComposerEngine.UNIVERSAL_TYPE_ENGINE");
    expect(jsx).toContain("LineOrientation.VERTICAL_RIGHT_TO_LEFT");
  });

  it("sets the simple paragraph attributes", () => {
    const op = getOp("text.set_style");
    const jsx = op!.toJsx({
      comp: "Main",
      layer: 1,
      kerning: 100,
      ligature: true,
      firstLineIndent: 24,
      spaceBefore: 8,
      hangingRoman: true,
      strokeOverFill: false,
    });
    expect(jsx).toContain("_doc.kerning = 100");
    expect(jsx).toContain("_doc.ligature = true");
    expect(jsx).toContain("_doc.firstLineIndent = 24");
    expect(jsx).toContain("_doc.spaceBefore = 8");
    expect(jsx).toContain("_doc.hangingRoman = true");
    expect(jsx).toContain("_doc.strokeOverFill = false");
  });
});

describe("text.set_style_range", () => {
  it("resolves character ranges and applies styles to the range object", () => {
    const op = getOp("text.set_style_range");
    const jsx = op!.toJsx({ comp: "Main", layer: 1, start: 0, end: 5, fillColor: [1, 0, 0] });
    expect(jsx).toContain("characterRange(_start, _end)");
    expect(jsx).toContain("_range.fillColor = [1,0,0]");
    expect(jsx).toContain("AE 24.3+");
  });

  it("converts paragraph and line addressing through characterRange()", () => {
    const op = getOp("text.set_style_range");
    const jsx = op!.toJsx({
      comp: "Main",
      layer: 1,
      rangeType: "paragraphs",
      start: 1,
      fontSize: 40,
    });
    expect(jsx).toContain("paragraphRange(_start, _end).characterRange()");
    expect(jsx).toContain("composedLineRange(_start, _end).characterRange()");
  });
});

describe("text.measure", () => {
  it("is read-only and reports lines, paragraphs, and baselines", () => {
    const op = getOp("text.measure");
    expect(op!.readOnly).toBe(true);
    const jsx = op!.toJsx({ comp: "Main", layer: 1 });
    expect(jsx).toContain("composedLineCount");
    expect(jsx).toContain("baselineLocs");
    expect(jsx).toContain("paragraphRange(_pi2, _pi2 + 1)");
  });
});

describe("text.set_box 24.6 controls", () => {
  it("maps the box enums by fixed member names", () => {
    const op = getOp("text.set_box");
    const jsx = op!.toJsx({
      comp: "Main",
      layer: 1,
      autoFitPolicy: "heightPreciseBounds",
      verticalAlignment: "center",
      firstBaselineAlignment: "typoAscent",
      insetSpacing: 10,
    });
    expect(jsx).toContain("BoxAutoFitPolicy.HEIGHT_PRECISE_BOUNDS");
    expect(jsx).toContain("BoxVerticalAlignment.CENTER");
    expect(jsx).toContain("BoxFirstBaselineAlignment.TYPO_ASCENT");
    expect(jsx).toContain("_doc.boxInsetSpacing = 10");
  });
});

describe("font inspection ops", () => {
  it("font.info looks up by postScriptName or family and reports design axes", () => {
    const op = getOp("font.info");
    expect(op!.readOnly).toBe(true);
    const jsx = op!.toJsx({ postScriptName: "ArialMT" });
    expect(jsx).toContain("getFontsByPostScriptName");
    expect(jsx).toContain("designAxesData");
    const byFamily = op!.toJsx({ family: "Arial", style: "Bold" });
    expect(byFamily).toContain('getFontsByFamilyNameAndStyleName(_family, "Bold")');
  });

  it("font.check_glyphs guards the AE 25.1 API", () => {
    const op = getOp("font.check_glyphs");
    const jsx = op!.toJsx({ postScriptName: "ArialMT", text: "こんにちは" });
    expect(jsx).toContain("hasGlyphsFor");
    expect(jsx).toContain("AE 25.1+");
  });

  it("font.list_used serializes Project.usedFonts entries", () => {
    const op = getOp("font.list_used");
    const jsx = op!.toJsx({});
    expect(jsx).toContain("usedFonts");
    expect(jsx).toContain("usedAt");
  });
});

describe("variable font ops", () => {
  it("text.set_variable_font builds the design vector from the tag map", () => {
    const op = getOp("text.set_variable_font");
    const jsx = op!.toJsx({ comp: "Main", layer: 1, axes: { wght: 700 } });
    expect(jsx).toContain("postScriptNameForDesignVector");
    expect(jsx).toContain("designAxesData");
    expect(jsx).toContain("no such axis on this font");
  });

  it("text.add_font_axis guards the AE 26.0 API and sets an initial value", () => {
    const op = getOp("text.add_font_axis");
    const jsx = op!.toJsx({ comp: "Main", layer: 1, axisTag: "wght", value: 500 });
    expect(jsx).toContain("addVariableFontAxis");
    expect(jsx).toContain("AE 26.0+");
    expect(jsx).toContain("_axis.setValue(500)");
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
