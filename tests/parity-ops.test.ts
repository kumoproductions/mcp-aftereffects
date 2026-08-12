// Offline codegen tests for the 2026 scripting-parity work: every op touched
// or added while closing the gap against the AE 2024–2026 scripting surface.
// These assert on generated JSX text only — whether AE accepts the calls is
// covered by the e2e suites.

import { describe, expect, it } from "vitest";

import { getOp, listOps } from "../src/registry.js";
import { doTool } from "../src/tools/do.js";
// Importing the operation registry for its registration side effects.
import "../src/operations/index.js";
import { nullTransport } from "./helpers/null-transport.js";

/** ae_do unwraps `{ result, context }`, so the canned answer must have both. */
const OK_RESPONSE = { result: { result: { ok: true }, context: {} } };

interface DoResponse {
  isError?: boolean;
  structuredContent?: { error?: { code: string; message: string } };
}

describe("layer.set_track_matte (AE 23.0 semantics)", () => {
  it("resolves the matte layer by name through AE.findLayerInComp", () => {
    const op = getOp("layer.set_track_matte");
    expect(op).toBeTruthy();
    const jsx = op!.toJsx({ comp: "Main", layer: 2, matteLayer: "matte src", matteType: "luma" });
    expect(jsx).toContain('var _matteArg = "matte src"');
    expect(jsx).toContain("AE.findLayerInComp(_comp, _matteArg)");
    expect(jsx).toContain("setTrackMatte");
    // A non-none matteType without a matte layer must fail with a clear
    // message instead of a null lookup.
    const missing = op!.toJsx({ comp: "Main", layer: 2, matteType: "luma" });
    expect(missing).toContain("matteLayer is required when matteType is not 'none'");
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

  it("rejects auxiliary feather arrays without the three core ones", () => {
    // featherTypes alone must trip the validation, not be silently dropped.
    const jsx = getOp("mask.set_path")!.toJsx({
      comp: "Main",
      layer: 1,
      maskIndex: 1,
      vertices: [[0, 0]],
      featherTypes: [0, 1],
    });
    expect(jsx).toContain("must all be present with the same length");
    expect(jsx).toContain("!_fSeg");
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

describe("render queue raw settings and per-item control", () => {
  it("render.get_settings reads both levels with a format switch", () => {
    const op = getOp("render.get_settings");
    expect(op!.readOnly).toBe(true);
    // Both enum names appear in every generated script (the switch is a
    // runtime ternary), so assert the embedded format argument that drives it.
    const all = op!.toJsx({ format: "all" });
    expect(all).toContain(
      '"all" === "all" ? GetSettingsFormat.STRING : GetSettingsFormat.STRING_SETTABLE',
    );
    expect(all).toContain("outputModule(_o)");
    const settable = op!.toJsx({});
    expect(settable).toContain(
      '"settable" === "all" ? GetSettingsFormat.STRING : GetSettingsFormat.STRING_SETTABLE',
    );
  });

  it("render.set_settings / set_om_settings pass the map through setSettings", () => {
    const rqi = getOp("render.set_settings")!.toJsx({ settings: { Quality: "Best" } });
    expect(rqi).toContain('setSettings({"Quality":"Best"})');
    const om = getOp("render.set_om_settings")!.toJsx({
      settings: { Format: "QuickTime" },
      outputModuleIndex: 2,
    });
    expect(om).toContain('setSettings({"Format":"QuickTime"})');
    expect(om).toContain("outputModule(2)");
  });

  it("render.remove_item requires an explicit index", () => {
    const op = getOp("render.remove_item");
    expect(op!.params.find((p) => p.name === "queueIndex")?.required).toBe(true);
    expect(op!.toJsx({ queueIndex: 2 })).toContain("_rqi.remove()");
  });

  it("render.set_output maps the new enums and flags", () => {
    const jsx = getOp("render.set_output")!.toJsx({
      render: false,
      skipFrames: 1,
      logType: "errorsAndPerFrameInfo",
      postRenderAction: "importAndReplaceUsage",
      includeSourceXMP: true,
    });
    expect(jsx).toContain("_rqi.render = false");
    expect(jsx).toContain("_rqi.skipFrames = 1");
    expect(jsx).toContain("LogType.ERRORS_AND_PER_FRAME_INFO");
    expect(jsx).toContain("PostRenderAction.IMPORT_AND_REPLACE_USAGE");
    expect(jsx).toContain("_om.includeSourceXMP = true");
  });
});

describe("keyframe interpolation and labels", () => {
  it("keyframe.set_interpolation allows asymmetric in/out and keeps unspecified sides", () => {
    const op = getOp("keyframe.set_interpolation");
    const jsx = op!.toJsx({
      comp: "Main",
      layer: 1,
      property: ["Transform", "Position"],
      keyIndex: 2,
      outType: "hold",
    });
    expect(jsx).toContain("KeyframeInterpolationType.HOLD");
    expect(jsx).toContain("keyInInterpolationType(_ki)");
    expect(jsx).toContain("setInterpolationTypeAtKey");
    expect(jsx).toContain("isInterpolationTypeValid");
  });

  it("keyframe.set_interpolation orders continuity before auto-bezier", () => {
    const jsx = getOp("keyframe.set_interpolation")!.toJsx({
      comp: "Main",
      layer: 1,
      property: ["Transform", "Opacity"],
      keyIndex: 1,
      temporalContinuous: false,
      temporalAutoBezier: true,
    });
    expect(jsx.indexOf("setTemporalContinuousAtKey")).toBeLessThan(
      jsx.indexOf("setTemporalAutoBezierAtKey"),
    );
  });

  it("keyframe.set_label guards the AE 22.6 API", () => {
    const jsx = getOp("keyframe.set_label")!.toJsx({
      comp: "Main",
      layer: 1,
      property: ["Transform", "Position"],
      keyIndex: 1,
      label: 9,
    });
    expect(jsx).toContain("setLabelAtKey(_ki, 9)");
    expect(jsx).toContain("AE 22.6+");
  });
});

describe("effect and property reordering", () => {
  it("effect.move range-checks both indices and reports the new order", () => {
    const jsx = getOp("effect.move")!.toJsx({ comp: "Main", layer: 1, effectIndex: 3, toIndex: 1 });
    expect(jsx).toContain("moveTo(_to)");
    expect(jsx).toContain("effectIndex out of range");
    expect(jsx).toContain("_order.push");
  });

  it("property.move only accepts members of indexed groups", () => {
    const jsx = getOp("property.move")!.toJsx({
      comp: "Main",
      layer: 1,
      property: ["Masks", "Mask 1"],
      toIndex: 2,
    });
    expect(jsx).toContain("PropertyType.INDEXED_GROUP");
    expect(jsx).toContain("moveTo(_to)");
  });
});

describe("dropdown menu control", () => {
  it("effect.set_dropdown_items finds the menu property via isDropdownEffect", () => {
    const jsx = getOp("effect.set_dropdown_items")!.toJsx({
      comp: "Main",
      layer: 1,
      effect: "Color Choice",
      items: ["Red", "Green", "-", "Custom"],
    });
    expect(jsx).toContain("isDropdownEffect");
    expect(jsx).toContain('var _items = ["Red","Green","-","Custom"]');
    expect(jsx).toContain("setPropertyParameters(_items)");
    expect(jsx).toContain("AE 17.0.1+");
  });

  it("effect.get_dropdown_items reads items, value, and valueText", () => {
    const op = getOp("effect.get_dropdown_items");
    expect(op!.readOnly).toBe(true);
    const jsx = op!.toJsx({ comp: "Main", layer: 1, effect: 1 });
    expect(jsx).toContain("propertyParameters");
    expect(jsx).toContain("valueText");
  });
});

describe("3D and layer parity ops", () => {
  it("layer.create_light accepts environment behind a 24.3 probe", () => {
    const jsx = getOp("layer.create_light")!.toJsx({ comp: "Main", lightType: "environment" });
    expect(jsx).toContain("LightType.ENVIRONMENT");
    expect(jsx).toContain("AE 24.3+");
  });

  it("layer.create_parametric_mesh passes (name, meshType) in that order", () => {
    const jsx = getOp("layer.create_parametric_mesh")!.toJsx({
      comp: "Main",
      name: "Cube 1",
      meshType: "cube",
    });
    expect(jsx).toContain('addParametricMesh("Cube 1", _mtMap[_mtArg])');
    expect(jsx).toContain("ParametricMeshType.CUBE");
    expect(jsx).toContain("AE 26.3+");
  });

  it("comp.set_renderer resolves friendly names against both matchName schemes", () => {
    const jsx = getOp("comp.set_renderer")!.toJsx({ comp: "Main", renderer: "advanced3d" });
    expect(jsx).toContain('"ADBE Classic 3d"');
    expect(jsx).toContain('_friendly.advanced3d = "ADBE Calder"');
    expect(jsx).toContain('_friendly.advanced3d = "ADBE Advanced 3d"');
  });

  it("layer.set_parent jump=true routes through setParentWithJump", () => {
    const jump = getOp("layer.set_parent")!.toJsx({
      comp: "Main",
      layer: 2,
      parentLayer: 1,
      jump: true,
    });
    expect(jump).toContain("setParentWithJump");
    const noJump = getOp("layer.set_parent")!.toJsx({ comp: "Main", layer: 2, parentLayer: 1 });
    expect(noJump).not.toContain("setParentWithJump");
  });

  it("layer.scene_edit_detection maps the four modes", () => {
    const jsx = getOp("layer.scene_edit_detection")!.toJsx({
      comp: "Main",
      layer: 1,
      mode: "splitPrecomp",
    });
    expect(jsx).toContain("SceneEditDetectionMode.SPLIT_PRECOMP");
    expect(jsx).toContain("AE 22.3+");
  });
});

describe("footage parity ops", () => {
  it("footage.reload guards non-file sources", () => {
    const jsx = getOp("footage.reload")!.toJsx({ item: "clip.mov" });
    expect(jsx).toContain("_src.reload()");
    expect(jsx).toContain("not file-backed footage");
  });

  it("footage.list_missing reports path and usages", () => {
    const op = getOp("footage.list_missing");
    expect(op!.readOnly).toBe(true);
    const jsx = op!.toJsx({});
    expect(jsx).toContain("footageMissing");
    expect(jsx).toContain("missingFootagePath");
    expect(jsx).toContain("usedIn");
  });

  it("footage.replace_with_solid / placeholder keep dimensions by default", () => {
    const solid = getOp("footage.replace_with_solid")!.toJsx({ item: 1, color: [1, 0, 0] });
    expect(solid).toContain("replaceWithSolid([1,0,0]");
    expect(solid).toContain("_item.width || 1920");
    const ph = getOp("footage.replace_with_placeholder")!.toJsx({ item: 1 });
    expect(ph).toContain("replaceWithPlaceholder(");
  });

  it("footage.interpret maps pulldown phases and guess methods", () => {
    const jsx = getOp("footage.interpret")!.toJsx({
      item: 1,
      guessPulldown: "24Pa",
      removePulldown: "WSSWW",
    });
    expect(jsx).toContain("PulldownMethod.ADVANCE_24P");
    expect(jsx).toContain("PulldownPhase.WSSWW");
  });

  it("footage.set_proxy supports solid and placeholder proxies", () => {
    const solid = getOp("footage.set_proxy")!.toJsx({ item: 1, solidColor: [0, 0, 0] });
    expect(solid).toContain("setProxyWithSolid");
    const ph = getOp("footage.set_proxy")!.toJsx({ item: 1, placeholder: true });
    expect(ph).toContain("setProxyWithPlaceholder");
  });

  it("item.usages walks layers to find referencing indices", () => {
    const op = getOp("item.usages");
    expect(op!.readOnly).toBe(true);
    const jsx = op!.toJsx({ item: "clip.mov" });
    expect(jsx).toContain("usedIn");
    expect(jsx).toContain("layerIndices");
  });

  it("project.import_placeholder passes the five required values", () => {
    const jsx = getOp("project.import_placeholder")!.toJsx({
      name: "PH",
      width: 1920,
      height: 1080,
      frameRate: 24,
      duration: 10,
    });
    expect(jsx).toContain('importPlaceholder("PH", 1920, 1080, 24, 10)');
  });

  it("project.import_file wires rangeStart/rangeEnd into ImportOptions", () => {
    const jsx = getOp("project.import_file")!.toJsx({
      path: "C:/seq/frame_0001.png",
      sequence: true,
      rangeStart: 10,
      rangeEnd: 50,
    });
    expect(jsx).toContain("imp.rangeStart = 10");
    expect(jsx).toContain("imp.rangeEnd = 50");
  });
});

describe("project.new / egp.add_layer / viewer extensions", () => {
  it("project.new refuses to silently discard an unsaveable project when save=true", () => {
    const jsx = getOp("project.new")!.toJsx({ save: true });
    expect(jsx).toContain("app.newProject()");
    expect(jsx).toContain("no file path");
  });

  it("egp.add_layer checks eligibility and supports the As variant", () => {
    const jsx = getOp("egp.add_layer")!.toJsx({
      comp: "Master",
      layer: 1,
      controllerName: "Hero Clip",
    });
    expect(jsx).toContain("canAddToMotionGraphicsTemplate");
    expect(jsx).toContain("addToMotionGraphicsTemplateAs");
    expect(jsx).toContain("AE 18.0+");
  });

  it("viewer.set_options maps fastPreview and channels enums", () => {
    const jsx = getOp("viewer.set_options")!.toJsx({
      fastPreview: "adaptiveResolution",
      channels: "alphaOverlay",
      guidesSnap: true,
    });
    expect(jsx).toContain("FastPreviewType.FP_ADAPTIVE_RESOLUTION");
    expect(jsx).toContain("ChannelType.CHANNEL_ALPHA_OVERLAY");
    expect(jsx).toContain("_opts.guidesSnap = true");
  });
});

describe("small parity ops", () => {
  it("shape.add_wiggle_transform uses the verified Wiggler matchNames", () => {
    const jsx = getOp("shape.add_wiggle_transform")!.toJsx({
      comp: "Main",
      layer: 1,
      position: [20, 20],
      rotation: 15,
    });
    expect(jsx).toContain("ADBE Vector Filter - Wiggler");
    expect(jsx).toContain("ADBE Vector Xform Temporal Freq");
    expect(jsx).toContain("ADBE Vector Wiggler Position");
    expect(jsx).toContain("ADBE Vector Wiggler Rotation");
  });

  it("project.parse_swatch and xmp ops exist with the right mutability", () => {
    expect(getOp("project.parse_swatch")!.readOnly).toBe(true);
    expect(getOp("project.get_xmp")!.readOnly).toBe(true);
    expect(getOp("project.set_xmp")!.readOnly).toBeUndefined();
    expect(getOp("project.parse_swatch")!.toJsx({ path: "C:/x.ase" })).toContain("parseSwatchFile");
  });

  it("layer guide ops guard the 16.1 API and range-check indices", () => {
    const add = getOp("layer.add_guide")!.toJsx({
      comp: "Main",
      layer: 1,
      orientation: "vertical",
      position: 100,
    });
    expect(add).toContain("_layer.addGuide(_orient, 100)");
    const move = getOp("layer.move_guide")!.toJsx({
      comp: "Main",
      layer: 1,
      guideIndex: 0,
      position: 50,
    });
    expect(move).toContain("_layer.setGuide(50, 0)");
    expect(move).toContain("out of range");
    expect(getOp("layer.list_guides")!.readOnly).toBe(true);
  });
});

describe("app-config consent gate", () => {
  const FLAGGED = [
    "pref.set",
    "pref.delete",
    "pref.set_setting",
    "project.set_memory_limits",
    "project.set_multi_frame_rendering",
    "project.set_default_import_folder",
    "project.set_tool",
    "font.set_substitution",
    "font.set_favorites",
    "font.set_default_for_script",
    "render.save_template",
  ];

  it("every app-config op is flagged and carries the injected confirm param", () => {
    for (const name of FLAGGED) {
      const op = getOp(name);
      expect(op?.appConfig, name).toBe(true);
      const confirm = op?.params.find((p) => p.name === "confirm");
      expect(confirm?.required, `${name} confirm param`).toBe(true);
      expect(confirm?.description).toContain("explicitly requested");
    }
    // Reads stay unflagged — consent is about writes.
    for (const name of ["pref.get", "pref.get_setting", "project.get_tool", "font.get_lists"]) {
      expect(getOp(name)?.appConfig, name).toBeUndefined();
    }
    // The flag list above is exhaustive: no other op may carry it silently.
    const actual = listOps()
      .filter((o) => o.appConfig)
      .map((o) => o.name)
      .toSorted();
    expect(actual).toEqual(FLAGGED.toSorted());
  });

  it("ae_do refuses confirm:false with FORBIDDEN and passes confirm:true through", async () => {
    const refused = nullTransport(OK_RESPONSE);
    const res = (await doTool.handler(
      {
        operation: "pref.set_setting",
        args: { section: "S", key: "K", value: "v", confirm: false },
      },
      refused,
    )) as DoResponse;
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.error?.code).toBe("FORBIDDEN");
    expect(res.structuredContent?.error?.message).toContain("explicitly asked");
    expect(refused.calls, "nothing may reach AE without consent").toHaveLength(0);

    const missing = (await doTool.handler(
      { operation: "pref.set_setting", args: { section: "S", key: "K", value: "v" } },
      nullTransport(OK_RESPONSE),
    )) as DoResponse;
    expect(missing.isError, "missing confirm fails schema validation").toBe(true);

    const allowed = nullTransport(OK_RESPONSE);
    const ok = (await doTool.handler(
      {
        operation: "pref.set_setting",
        args: { section: "S", key: "K", value: "v", confirm: true },
      },
      allowed,
    )) as DoResponse;
    expect(ok.isError).toBeFalsy();
    expect(allowed.calls).toHaveLength(1);
  });

  it("batch.run rejects an unconsented app-config child but keeps siblings", () => {
    const jsx = getOp("batch.run")!.toJsx({
      ops: [
        { operation: "layer.create_null", args: { comp: "Main" } },
        {
          operation: "pref.set_setting",
          args: { section: "S", key: "K", value: "v", confirm: false },
        },
      ],
    });
    expect(jsx).toContain("application configuration");
    expect(jsx).not.toContain("saveSetting");
    expect(jsx).toContain("addNull");
  });
});

describe("low-priority parity ops", () => {
  it("project.set_settings maps the remaining display/color enums", () => {
    const jsx = getOp("project.set_settings")!.toJsx({
      linearizeWorkingSpace: true,
      compensateForSceneReferredProfiles: false,
      displayStartFrame: 1,
      feetFramesFilmType: "mm16",
      footageTimecodeDisplayStartType: "useSourceMedia",
    });
    expect(jsx).toContain("linearizeWorkingSpace = true");
    expect(jsx).toContain("FeetFramesFilmType.MM16");
    expect(jsx).toContain("FootageTimecodeDisplayStartType.FTCS_USE_SOURCE_MEDIA");
    expect(jsx).toContain("displayStartFrame = 1");
  });

  it("project.set_tool resolves friendly names via the probe-built table", () => {
    const jsx = getOp("project.set_tool")!.toJsx({ tool: "cameraOrbitCursor" });
    expect(jsx).toContain('_addTool("cameraOrbitCursor", "Tool_CameraOrbitCursor")');
    expect(jsx).toContain("unknown tool");
    expect(getOp("project.get_tool")!.readOnly).toBe(true);
  });

  it("project memory/MFR ops guard their APIs", () => {
    expect(
      getOp("project.set_memory_limits")!.toJsx({ imageCachePercent: 50, maxMemoryPercent: 80 }),
    ).toContain("setMemoryUsageLimits(50, 80)");
    const mfr = getOp("project.set_multi_frame_rendering")!.toJsx({ enabled: true });
    expect(mfr).toContain("setMultiFrameRenderingConfig(true, 90)");
    expect(mfr).toContain("AE 22.0+");
  });

  it("pref ops type the value path and validate prefType", () => {
    const get = getOp("pref.get")!.toJsx({ section: "S", key: "K", type: "bool" });
    expect(get).toContain("getPrefAsBool");
    expect(get).toContain("havePref");
    const set = getOp("pref.set")!.toJsx({
      section: "S",
      key: "K",
      value: 1.5,
      prefType: "machineIndependent",
    });
    expect(set).toContain("PREF_Type_MACHINE_INDEPENDENT");
    expect(set).toContain("saveToDisk");
    const noPersist = getOp("pref.set")!.toJsx({
      section: "S",
      key: "K",
      value: "x",
      persist: false,
    });
    expect(noPersist).not.toContain("saveToDisk");
    expect(getOp("pref.delete")!.toJsx({ section: "S", key: "K" })).toContain("deletePref");
    expect(getOp("pref.get_setting")!.readOnly).toBe(true);
    expect(getOp("pref.set_setting")!.toJsx({ section: "S", key: "K", value: "v" })).toContain(
      "saveSetting",
    );
  });

  it("font management ops guard their 24.6/25.1 APIs", () => {
    expect(getOp("font.list_duplicates")!.toJsx({})).toContain("fontsDuplicateByPostScriptName");
    expect(getOp("font.get_lists")!.toJsx({})).toContain("mruFontFamilyList");
    expect(getOp("font.set_favorites")!.toJsx({ families: ["Inter"] })).toContain(
      'favoriteFontFamilyList = ["Inter"]',
    );
    const sub = getOp("font.set_substitution")!.toJsx({ matchPolicy: "ctfiEqual" });
    expect(sub).toContain("SubstitutedFontReplacementMatchPolicy.CTFI_EQUAL");
    const script = getOp("font.set_default_for_script")!.toJsx({
      script: "japanese",
      postScriptName: "NotoSansJP-Regular",
    });
    expect(script).toContain('_addScript("japanese", "CT_JAPANESE_SCRIPT")');
    expect(script).toContain("setDefaultFontForCTScript");
  });

  it("text.paste_range wires source and target ranges through pasteFrom", () => {
    const jsx = getOp("text.paste_range")!.toJsx({
      comp: "Main",
      layer: "b",
      start: 0,
      sourceLayer: "a",
      sourceStart: 2,
      sourceEnd: 5,
    });
    expect(jsx).toContain("pasteFrom(_src)");
    expect(jsx).toContain("AE 25.1+");
  });

  it("text.reset_style scopes to character, paragraph, or both", () => {
    const op = getOp("text.reset_style")!;
    // Scope dispatch happens at runtime, so both branch bodies are always in
    // the generated code — what varies is the embedded scope value driving
    // the two conditions.
    for (const scope of ["character", "paragraph", "both"]) {
      expect(op.toJsx({ comp: "Main", layer: 1, scope })).toContain(`var _scope = "${scope}"`);
    }
    const jsx = op.toJsx({ comp: "Main", layer: 1, scope: "character" });
    expect(jsx).toContain('if (_scope === "character" || _scope === "both")');
    expect(jsx).toContain('if (_scope === "paragraph" || _scope === "both")');
    expect(jsx).toContain("resetCharStyle");
    expect(jsx).toContain("resetParagraphStyle");
  });

  it("keyframe.set_selected handles single keys and 'all'", () => {
    const jsx = getOp("keyframe.set_selected")!.toJsx({
      comp: "Main",
      layer: 1,
      property: ["Transform", "Position"],
      keyIndex: "all",
      selected: true,
    });
    expect(jsx).toContain("setSelectedAtKey");
    expect(jsx).toContain("selectedKeys");
  });

  it("property.select flips PropertyBase.selected", () => {
    expect(
      getOp("property.select")!.toJsx({ comp: "Main", layer: 1, property: ["Effects"] }),
    ).toContain("_node.selected = true");
  });

  it("render.save_template targets item or output module", () => {
    const rs = getOp("render.save_template")!.toJsx({ type: "render", name: "MCP Draft" });
    expect(rs).toContain('saveAsTemplate("MCP Draft")');
    const om = getOp("render.save_template")!.toJsx({
      type: "output",
      name: "MCP PNG",
      outputModuleIndex: 2,
    });
    expect(om).toContain("outputModule(2)");
  });

  it("layer.calculate_transform is calculation-only, honoring its readOnly flag", () => {
    const op = getOp("layer.calculate_transform")!;
    expect(op.readOnly).toBe(true);
    // No apply path: a readOnly op must never mutate — applying the result is
    // delegated to property.set / layer.set_props.
    expect(op.params.some((p) => p.name === "apply")).toBe(false);
    const jsx = op.toJsx({
      comp: "Main",
      layer: 1,
      topLeft: [0, 0, 0],
      topRight: [100, 0, 0],
      bottomLeft: [0, 100, 0],
    });
    expect(jsx).toContain("calculateTransformFromPoints([0,0,0], [100,0,0], [0,100,0])");
    expect(jsx).not.toContain("setValue");
  });

  it("egp.open_in_panel and render queueNotify exist", () => {
    expect(getOp("egp.open_in_panel")!.toJsx({ comp: "Main" })).toContain(
      "openInEssentialGraphics",
    );
    expect(getOp("render.set_output")!.toJsx({ queueNotify: true })).toContain(
      "rq.queueNotify = true",
    );
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
