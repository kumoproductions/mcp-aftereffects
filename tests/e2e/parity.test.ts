// End-to-end coverage for the 2026 scripting-parity operations — everything
// added or changed while closing the gap against the AE 2024–2026 scripting
// surface. The offline suite (tests/parity-ops.test.ts) asserts on generated
// JSX text; this one asserts that a real After Effects accepts the calls and
// answers with the documented shapes, including the version-probed APIs
// (variable fonts, parametric meshes, per-range text styling).
//
// SESSION-MUTATING: closes the project currently open in After Effects, swaps
// in a disposable fixture, and restores the original afterwards. Requires
// AE_MCP_E2E=1 on top of AE being reachable. Ops introduced for AE versions
// newer than the host self-skip on the version-guard error message instead of
// failing.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodePngSrgb8 } from "../../src/color/png16.js";
import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import type { SavedProjectState } from "./harness.js";
import {
  E2E_SCRATCH_DIR,
  backupAndOpenTestProject,
  openCompInViewer,
  opRunner,
  printSkipBanner,
  probeAe,
  restoreUserProject,
} from "./harness.js";

const E2E_ENABLED = process.env.AE_MCP_E2E === "1";
const COMP = "parity_comp";

let ready = false;
let transport: FileIpcTransport | null = null;
let saved: SavedProjectState | null = null;
let ops: ReturnType<typeof opRunner> | null = null;

const o = () => {
  if (!ops) throw new Error("ops runner not initialized");
  return ops;
};

/** Minimal valid .ase swatch file: one RGB color named "e2e". */
function buildAseFile(): Buffer {
  const name = "e2e";
  // Block payload: nameLen(u16) + UTF-16BE name + NUL + "RGB " + 3×f32 + type(u16)
  const payload = Buffer.alloc(2 + (name.length + 1) * 2 + 4 + 12 + 2);
  let off = 0;
  payload.writeUInt16BE(name.length + 1, off);
  off += 2;
  for (const ch of name) {
    payload.writeUInt16BE(ch.charCodeAt(0), off);
    off += 2;
  }
  payload.writeUInt16BE(0, off);
  off += 2;
  payload.write("RGB ", off, "ascii");
  off += 4;
  payload.writeFloatBE(1.0, off);
  payload.writeFloatBE(0.5, off + 4);
  payload.writeFloatBE(0.25, off + 8);
  off += 12;
  payload.writeUInt16BE(2, off); // global color
  const header = Buffer.alloc(12 + 6);
  header.write("ASEF", 0, "ascii");
  header.writeUInt16BE(1, 4); // version major
  header.writeUInt16BE(0, 6); // version minor
  header.writeUInt32BE(1, 8); // one block
  header.writeUInt16BE(0x0001, 12); // color entry
  header.writeUInt32BE(payload.length, 14);
  return Buffer.concat([header.subarray(0, 18), payload]);
}

beforeAll(async () => {
  if (!E2E_ENABLED) {
    printSkipBanner("parity", "SKIPPING — session-mutating suite (set AE_MCP_E2E=1 to enable)", [
      " This suite closes and replaces the current AE project.",
    ]);
    return;
  }
  const probe = await probeAe("parity");
  if (!probe.ready || !probe.transport) return;
  transport = probe.transport;
  saved = await backupAndOpenTestProject(transport);
  ops = opRunner(transport);
  await o().run("comp.create", {
    name: COMP,
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 10,
  });
  ready = true;
}, 180_000);

afterAll(async () => {
  if (transport && saved) await restoreUserProject(transport, saved);
}, 120_000);

describe("e2e: layer parity", () => {
  it("layer.set_props coerces enum names (incl. the SILHOUETE spelling trap)", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("layer.create_solid", { comp: COMP, name: "enum_solid", color: [1, 0, 0] });
    const res = await o().run<{ layers: Array<{ warnings: string[] }> }>("layer.set_props", {
      comp: COMP,
      layer: "enum_solid",
      props: {
        samplingQuality: "bicubic",
        quality: "draft",
        blendingMode: "silhouetteAlpha",
        motionBlur: true,
      },
    });
    expect(res.layers[0]?.warnings, "every enum name must have resolved").toEqual([]);
  });

  it("layer.set_track_matte accepts a matte by NAME anywhere in the comp", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("layer.create_solid", { comp: COMP, name: "matte_target", color: [0, 1, 0] });
    await o().run("layer.create_solid", { comp: COMP, name: "matte_source", color: [0, 0, 1] });
    // Put another layer between them so the pre-23.0 "directly above" rule
    // would have failed — 23.0 setTrackMatte must not care.
    await o().run("layer.create_null", { comp: COMP, name: "separator" });
    const set = await o().run<{ matte: string }>("layer.set_track_matte", {
      comp: COMP,
      layer: "matte_target",
      matteLayer: "matte_source",
      matteType: "luma",
    });
    expect(set.matte).toBe("matte_source");
    const cleared = await o().run<{ matte: null }>("layer.set_track_matte", {
      comp: COMP,
      layer: "matte_target",
      matteType: "none",
    });
    expect(cleared.matte).toBeNull();
  });

  it("layer.set_parent jump=true uses setParentWithJump", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("layer.create_null", { comp: COMP, name: "jump_parent" });
    await o().run("layer.create_solid", { comp: COMP, name: "jump_child", color: [1, 1, 0] });
    const res = await o().run<{ parent: { name: string } }>("layer.set_parent", {
      comp: COMP,
      layer: "jump_child",
      parentLayer: "jump_parent",
      jump: true,
    });
    expect(res.parent.name).toBe("jump_parent");
  });

  it("layer.scene_edit_detection fails cleanly on a non-video layer", async (ctx) => {
    if (!ready) return ctx.skip();
    // No real edited footage in the fixture — the API contract to verify here
    // is that the call reaches doSceneEditDetection and reports AE's own
    // error, not a version-guard or a crash.
    const err = await o().expectRefusal("layer.scene_edit_detection", {
      comp: COMP,
      layer: "enum_solid",
      mode: "markers",
    });
    expect(err.message).not.toContain("AE 22.3+");
  });

  it("layer guides round-trip: add, list, move, remove", async (ctx) => {
    if (!ready) return ctx.skip();
    const add = await o().run<{ guideIndex: number; numGuides: number }>("layer.add_guide", {
      comp: COMP,
      layer: "enum_solid",
      orientation: "vertical",
      position: 200,
    });
    expect(add.numGuides).toBeGreaterThan(0);
    const list = await o().run<{ guides: Array<{ orientation: string; position: number }> }>(
      "layer.list_guides",
      { comp: COMP, layer: "enum_solid" },
    );
    expect(list.guides[add.guideIndex]?.orientation).toBe("vertical");
    expect(list.guides[add.guideIndex]?.position).toBe(200);
    await o().run("layer.move_guide", {
      comp: COMP,
      layer: "enum_solid",
      guideIndex: add.guideIndex,
      position: 300,
    });
    const moved = await o().run<{ guides: Array<{ position: number }> }>("layer.list_guides", {
      comp: COMP,
      layer: "enum_solid",
    });
    expect(moved.guides[add.guideIndex]?.position).toBe(300);
    const removed = await o().run<{ numGuides: number }>("layer.remove_guide", {
      comp: COMP,
      layer: "enum_solid",
      guideIndex: add.guideIndex,
    });
    expect(removed.numGuides).toBe(add.numGuides - 1);
  });
});

describe("e2e: mask parity", () => {
  it("mask.set_props sets the MaskPropertyGroup attributes", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("layer.create_solid", { comp: COMP, name: "mask_solid", color: [1, 1, 1] });
    const mask = await o().run<{ maskIndex: number }>("mask.add", {
      comp: COMP,
      layer: "mask_solid",
    });
    await o().run("mask.set_path", {
      comp: COMP,
      layer: "mask_solid",
      maskIndex: mask.maskIndex,
      vertices: [
        [0, 0],
        [400, 0],
        [400, 400],
        [0, 400],
      ],
    });
    const res = await o().run<{ warnings: string[] }>("mask.set_props", {
      comp: COMP,
      layer: "mask_solid",
      maskIndex: mask.maskIndex,
      inverted: true,
      rotoBezier: true,
      color: [1, 0, 1],
      motionBlur: "on",
      featherFalloff: "linear",
      locked: false,
    });
    expect(res.warnings).toEqual([]);
  });

  it("mask.set_path accepts variable-width feather points", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await o().run<{ ok: boolean }>("mask.set_path", {
      comp: COMP,
      layer: "mask_solid",
      maskIndex: 1,
      vertices: [
        [0, 0],
        [400, 0],
        [400, 400],
        [0, 400],
      ],
      featherSegLocs: [0, 2],
      featherRelSegLocs: [0.5, 0.5],
      // Radius sign must match the feather type: outer (0) >= 0, inner (1) <= 0.
      featherRadii: [40, -20],
      featherTypes: [0, 1],
    });
    expect(res).toBeTruthy();
  });
});

describe("e2e: marker cue points", () => {
  it("round-trips cue point name, type, params, and frameTarget", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("marker.add_comp", {
      comp: COMP,
      time: 1,
      comment: "cue marker",
      cuePointName: "scene1",
      eventCuePoint: true,
      params: { speaker: "A", take: 3 },
      url: "https://example.com",
      frameTarget: "_blank",
    });
    const list = await o().run<{
      markers: Array<{
        comment: string;
        cuePointName: string;
        eventCuePoint: boolean;
        params: Record<string, string>;
        frameTarget: string;
      }>;
    }>("marker.list", { comp: COMP });
    const m = list.markers.find((x) => x.comment === "cue marker");
    expect(m?.cuePointName).toBe("scene1");
    expect(m?.eventCuePoint).toBe(true);
    expect(m?.params?.speaker).toBe("A");
    expect(m?.params?.take, "params values are stringified").toBe("3");
    expect(m?.frameTarget).toBe("_blank");
  });
});

describe("e2e: text parity", () => {
  it("creates box text and vertical text (24.2 APIs)", async (ctx) => {
    if (!ready) return ctx.skip();
    const box = await o().run<{ boxText: boolean; name: string }>("layer.create_text", {
      comp: COMP,
      text: "box text line one and a longer line two",
      name: "box_text",
      boxSize: [400, 300],
      boxPosition: [50, 50],
    });
    expect(box.boxText).toBe(true);
    const vert = await o().run<{ vertical: boolean }>("layer.create_text", {
      comp: COMP,
      text: "縦書き",
      name: "vert_text",
      orientation: "vertical",
    });
    expect(vert.vertical).toBe(true);
  });

  it("text.set_style applies the 24.0 attribute surface without warnings", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await o().run<{ warnings: string[] }>("text.set_style", {
      comp: COMP,
      layer: "box_text",
      fontSize: 40,
      ligature: true,
      autoKernType: "metric",
      leadingType: "roman",
      firstLineIndent: 12,
      spaceBefore: 6,
      spaceAfter: 6,
      lineJoinType: "round",
      digitSet: "default",
      fontBaselineOption: "normal",
      everyLineComposer: true,
      hangingRoman: false,
      noBreak: false,
      autoHyphenate: false,
      strokeOverFill: false,
    });
    expect(res.warnings).toEqual([]);
  });

  it("text.set_style_range styles a character sub-range (24.3)", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await o().run<{ characterStart: number; characterEnd: number; warnings: string[] }>(
      "text.set_style_range",
      { comp: COMP, layer: "box_text", start: 0, end: 3, fillColor: [1, 0, 0], fauxBold: true },
    );
    expect(res.characterStart).toBe(0);
    expect(res.characterEnd).toBe(3);
    expect(res.warnings).toEqual([]);
    const para = await o().run<{ warnings: string[] }>("text.set_style_range", {
      comp: COMP,
      layer: "box_text",
      rangeType: "paragraphs",
      start: 0,
      fontSize: 44,
    });
    expect(para.warnings).toEqual([]);
  });

  it("text.measure reports composed lines, paragraphs, and baselines", async (ctx) => {
    if (!ready) return ctx.skip();
    const m = await o().run<{
      composedLineCount: number;
      paragraphCount: number;
      baselineLocs: number[];
      lines: Array<{ characterStart: number; characterEnd: number; text: string }>;
      boxOverflow: boolean | null;
    }>("text.measure", { comp: COMP, layer: "box_text" });
    expect(m.composedLineCount).toBeGreaterThan(0);
    expect(m.paragraphCount).toBeGreaterThan(0);
    expect(m.lines.length).toBe(m.composedLineCount);
    expect(m.baselineLocs?.length).toBeGreaterThan(0);
  });

  it("text.set_box drives the 24.6 auto-fit and alignment controls", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await o().run<{ warnings: string[]; boxOverflow: boolean | null }>("text.set_box", {
      comp: COMP,
      layer: "box_text",
      boxSize: [420, 320],
      autoFitPolicy: "heightPreciseBounds",
      verticalAlignment: "top",
      firstBaselineAlignment: "capHeight",
      insetSpacing: 8,
    });
    expect(res.warnings).toEqual([]);
  });

  it("text.add_animator creates a named animator with a range selector", async (ctx) => {
    if (!ready) return ctx.skip();
    const anim = await o().run<{ animator: string }>("text.add_animator", {
      comp: COMP,
      layer: "box_text",
      name: "parity_anim",
      properties: { "ADBE Text Opacity": 50 },
    });
    expect(anim.animator).toBe("parity_anim");
  });
});

describe("e2e: fonts", () => {
  it("font.info returns the full FontObject for an installed font", async (ctx) => {
    if (!ready) return ctx.skip();
    const list = await o().run<{ fonts: Array<{ postScriptName: string }> }>("font.list", {
      limit: 1,
    });
    const ps = list.fonts[0]?.postScriptName;
    expect(ps).toBeTruthy();
    const info = await o().run<{
      fonts: Array<{ postScriptName: string; location: string | null; hasDesignAxes: boolean }>;
    }>("font.info", { postScriptName: ps });
    expect(info.fonts.length).toBeGreaterThan(0);
    expect(info.fonts[0]?.postScriptName).toBe(ps);
  });

  it("font.check_glyphs distinguishes covered from uncovered characters", async (ctx) => {
    if (!ready) return ctx.skip();
    const latin = await o().run<{ hasGlyphs: boolean }>("font.check_glyphs", {
      postScriptName: "ArialMT",
      text: "abc",
    });
    expect(latin.hasGlyphs).toBe(true);
    const cjk = await o().run<{ hasGlyphs: boolean }>("font.check_glyphs", {
      postScriptName: "ArialMT",
      text: "こんにちは",
    });
    expect(cjk.hasGlyphs, "Arial has no kana glyphs").toBe(false);
  });

  it("font.list_used sees the fixture's text layers (24.5)", async (ctx) => {
    if (!ready) return ctx.skip();
    const used = await o().run<{ count: number; fonts: Array<{ postScriptName: string }> }>(
      "font.list_used",
      {},
    );
    expect(used.count).toBeGreaterThan(0);
  });

  it("text.set_variable_font moves along a variable font's axes", async (ctx) => {
    if (!ready) return ctx.skip();
    // Bahnschrift ships with every Windows 10+; on other hosts find any
    // variable font, otherwise skip (nothing to test against).
    const candidates = await o().run<{ fonts: Array<{ postScriptName: string | null }> }>(
      "font.list",
      { familyContains: "Bahnschrift", limit: 1 },
    );
    const ps = candidates.fonts[0]?.postScriptName;
    if (!ps) return ctx.skip();
    const info = await o().run<{ fonts: Array<{ hasDesignAxes: boolean }> }>("font.info", {
      postScriptName: ps,
    });
    if (!info.fonts[0]?.hasDesignAxes) return ctx.skip();
    await o().run("layer.create_text", { comp: COMP, text: "variable", name: "var_text" });
    await o().run("text.set_style", { comp: COMP, layer: "var_text", font: ps });
    const res = await o().run<{ postScriptName: string; warnings: string[] }>(
      "text.set_variable_font",
      { comp: COMP, layer: "var_text", axes: { wght: 700 } },
    );
    expect(res.postScriptName).toBeTruthy();
    expect(res.warnings).toEqual([]);

    // text.add_font_axis (26.0) requires the layer's CURRENT font to be a
    // variable font carrying the axis — which is exactly what var_text now is.
    const axis = await o().run<{ axis: string }>("text.add_font_axis", {
      comp: COMP,
      layer: "var_text",
      axisTag: "wght",
      value: 500,
    });
    expect(axis.axis).toBeTruthy();
  });
});

describe("e2e: render queue parity", () => {
  it("get_settings / set_settings / set_om_settings round-trip", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("render.add_to_queue", { comp: COMP });
    const got = await o().run<{
      renderSettings: Record<string, string>;
      outputModules: Array<{ index: number; settings: Record<string, string> | null }>;
    }>("render.get_settings", {});
    expect(got.renderSettings).toBeTruthy();
    expect(got.outputModules.length).toBeGreaterThan(0);
    // Idempotent write-back: set one existing settable key to its own value.
    const key = Object.keys(got.renderSettings)[0];
    expect(key).toBeTruthy();
    const setRes = await o().run<{ renderSettings: Record<string, string> }>(
      "render.set_settings",
      { settings: { [key as string]: got.renderSettings[key as string] } },
    );
    expect(setRes.renderSettings).toBeTruthy();
    const omSettings = got.outputModules[0]?.settings;
    if (omSettings) {
      const omKey = Object.keys(omSettings)[0];
      const omRes = await o().run<{ settings: Record<string, string> }>("render.set_om_settings", {
        settings: { [omKey as string]: omSettings[omKey as string] },
      });
      expect(omRes.settings).toBeTruthy();
    }
  });

  it("set_output flags, duplicate_item, remove_item", async (ctx) => {
    if (!ready) return ctx.skip();
    const flags = await o().run<{ warnings: string[] }>("render.set_output", {
      render: false,
      skipFrames: 1,
      logType: "errorsAndSettings",
      postRenderAction: "none",
      includeSourceXMP: false,
    });
    expect(flags.warnings).toEqual([]);
    const dup = await o().run<{ numItems: number }>("render.duplicate_item", {});
    expect(dup.numItems).toBe(2);
    const removed = await o().run<{ remaining: number }>("render.remove_item", { queueIndex: 2 });
    expect(removed.remaining).toBe(1);
    await o().run("render.clear_queue", {});
  });
});

describe("e2e: keyframe parity", () => {
  it("set_interpolation applies asymmetric types and temporal flags", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("layer.create_solid", { comp: COMP, name: "kf_solid", color: [0.5, 0.5, 0.5] });
    await o().run("keyframe.add", {
      comp: COMP,
      layer: "kf_solid",
      property: ["Transform", "Opacity"],
      time: 0,
      value: 0,
    });
    await o().run("keyframe.add", {
      comp: COMP,
      layer: "kf_solid",
      property: ["Transform", "Opacity"],
      time: 1,
      value: 100,
    });
    const res = await o().run<{ inType: string; outType: string; warnings: string[] }>(
      "keyframe.set_interpolation",
      {
        comp: COMP,
        layer: "kf_solid",
        property: ["Transform", "Opacity"],
        keyIndex: 1,
        outType: "hold",
        temporalContinuous: false,
      },
    );
    expect(res.outType).toBe("hold");
    expect(res.inType, "unspecified side keeps its previous type").toBe("linear");
    expect(res.warnings).toEqual([]);
  });

  it("set_label reads back the label color (22.6)", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await o().run<{ label: number }>("keyframe.set_label", {
      comp: COMP,
      layer: "kf_solid",
      property: ["Transform", "Opacity"],
      keyIndex: 1,
      label: 9,
    });
    expect(res.label).toBe(9);
  });
});

describe("e2e: effect and property parity", () => {
  it("effect.move reorders the stack", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("layer.create_solid", { comp: COMP, name: "fx_solid", color: [0, 0, 0] });
    await o().run("effect.add", {
      comp: COMP,
      layer: "fx_solid",
      matchName: "ADBE Gaussian Blur 2",
    });
    await o().run("effect.add", { comp: COMP, layer: "fx_solid", matchName: "ADBE Tint" });
    const res = await o().run<{ order: string[] }>("effect.move", {
      comp: COMP,
      layer: "fx_solid",
      effectIndex: 2,
      toIndex: 1,
    });
    expect(res.order[0]).toContain("Tint");
  });

  it("dropdown items: set (17.0.1) then read back (26.0)", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("effect.add", {
      comp: COMP,
      layer: "fx_solid",
      matchName: "ADBE Dropdown Control",
      name: "Color Choice",
    });
    const set = await o().run<{ itemCount: number; propertyParameters: string[] | null }>(
      "effect.set_dropdown_items",
      {
        comp: COMP,
        layer: "fx_solid",
        effect: "Color Choice",
        items: ["Red", "Green", "-", "Blue"],
      },
    );
    expect(set.itemCount).toBe(4);
    const got = await o().run<{ items: string[] | null; value: number; valueText: string | null }>(
      "effect.get_dropdown_items",
      { comp: COMP, layer: "fx_solid", effect: "Color Choice" },
    );
    expect(got.items, "propertyParameters read needs 26.0").toBeTruthy();
    expect(got.items).toContain("Red");
    expect(got.valueText).toBeTruthy();
  });

  it("property.move reorders masks", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("mask.add", { comp: COMP, layer: "mask_solid", name: "second mask" });
    const res = await o().run<{ order: string[] }>("property.move", {
      comp: COMP,
      layer: "mask_solid",
      property: ["Masks", "second mask"],
      toIndex: 1,
    });
    expect(res.order[0]).toBe("second mask");
  });
});

describe("e2e: 3D parity", () => {
  it("comp.list_renderers exposes the runtime friendly-name mapping", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await o().run<{
      renderer: string;
      renderers: string[];
      friendlyNames: Record<string, string>;
    }>("comp.list_renderers", { comp: COMP });
    expect(res.renderers.length).toBeGreaterThan(0);
    expect(res.friendlyNames.advanced3d).toBeTruthy();
    expect(res.renderers).toContain(res.friendlyNames.advanced3d);
  });

  it("comp.set_renderer switches to Advanced 3D and back by friendly name", async (ctx) => {
    if (!ready) return ctx.skip();
    const mapping = await o().run<{ friendlyNames: Record<string, string> }>(
      "comp.list_renderers",
      { comp: COMP },
    );
    const adv = await o().run<{ renderer: string }>("comp.set_renderer", {
      comp: COMP,
      renderer: "advanced3d",
    });
    expect(adv.renderer).toBe(mapping.friendlyNames.advanced3d);
    const back = await o().run<{ renderer: string }>("comp.set_renderer", {
      comp: COMP,
      renderer: "classic3d",
    });
    expect(back.renderer).toBe(mapping.friendlyNames.classic3d);
  });

  it("environment lights and parametric meshes (24.3 / 26.3)", async (ctx) => {
    if (!ready) return ctx.skip();
    const light = await o().run<{ lightType: string }>("layer.create_light", {
      comp: COMP,
      name: "env_light",
      lightType: "environment",
    });
    expect(light.lightType).toBe("environment");
    const mesh = await o().run<{ meshType: string; name: string }>("layer.create_parametric_mesh", {
      comp: COMP,
      name: "parity_cube",
      meshType: "cube",
    });
    expect(mesh.meshType).toBe("cube");
    const found = await o().run<{ matches: Array<{ name: string; type: string }> }>(
      "project.find_layers",
      { comp: COMP, type: "ParametricMeshLayer" },
    );
    expect(found.matches.map((m) => m.name)).toContain("parity_cube");
  });
});

describe("e2e: footage parity", () => {
  it("reload, usages, replace_with_solid/placeholder, list_missing, proxies", async (ctx) => {
    if (!ready) return ctx.skip();
    await fs.mkdir(E2E_SCRATCH_DIR, { recursive: true });
    const pngPath = path.join(E2E_SCRATCH_DIR, "parity_footage.png").replace(/\\/g, "/");
    await fs.writeFile(pngPath, encodePngSrgb8(8, 8, new Float64Array(8 * 8 * 3).fill(0.5)));

    const imported = await o().run<{ id: number }>("project.import_file", {
      path: pngPath,
      name: "parity_png",
    });
    await o().run("layer.create_footage", {
      comp: COMP,
      sourceItemId: imported.id,
      name: "png_layer",
    });

    const reloaded = await o().run<{ name: string }>("footage.reload", { item: "parity_png" });
    expect(reloaded.name).toBe("parity_png");

    const usages = await o().run<{
      usedIn: Array<{ compName: string; layerIndices: number[] }>;
    }>("item.usages", { item: "parity_png" });
    const inComp = usages.usedIn.find((u) => u.compName === COMP);
    expect(inComp).toBeTruthy();
    expect(inComp?.layerIndices.length).toBeGreaterThan(0);

    const proxied = await o().run<{ useProxy: boolean; proxy: string }>("footage.set_proxy", {
      item: "parity_png",
      solidColor: [0, 0, 0],
    });
    expect(proxied.proxy).toBe("solid");
    await o().run("footage.set_proxy", { item: "parity_png" }); // clear

    // replaceWith* renames the item, so address it by id from here on.
    await o().run("footage.replace_with_solid", {
      item: imported.id,
      color: [1, 0, 0],
      name: "now_solid",
    });
    await o().run("footage.replace_with_placeholder", { item: imported.id, name: "now_ph" });
    const missing = await o().run<{ count: number; items: Array<{ name: string }> }>(
      "footage.list_missing",
      {},
    );
    expect(missing.count, "a placeholder counts as missing footage").toBeGreaterThan(0);
  });

  it("project.import_placeholder creates stand-in footage", async (ctx) => {
    if (!ready) return ctx.skip();
    const ph = await o().run<{ id: number; width: number }>("project.import_placeholder", {
      name: "parity_ph",
      width: 1280,
      height: 720,
      frameRate: 24,
      duration: 5,
    });
    expect(ph.width).toBe(1280);
  });
});

describe("e2e: egp / viewer / project / shape", () => {
  it("egp.add_layer registers a media-replacement controller (18.0)", async (ctx) => {
    if (!ready) return ctx.skip();
    // Dedicated footage: png_layer's source was replaced with a placeholder by
    // the footage suite, and placeholders don't qualify for media replacement.
    const pngPath = path.join(E2E_SCRATCH_DIR, "parity_egp.png").replace(/\\/g, "/");
    await fs.writeFile(pngPath, encodePngSrgb8(8, 8, new Float64Array(8 * 8 * 3).fill(0.25)));
    const imported = await o().run<{ id: number }>("project.import_file", {
      path: pngPath,
      name: "egp_png",
    });
    await o().run("layer.create_footage", {
      comp: COMP,
      sourceItemId: imported.id,
      name: "egp_layer",
    });
    await o().run("egp.set_name", { comp: COMP, name: "parity_template" });
    const res = await o().run<{ controllerCount: number | null }>("egp.add_layer", {
      comp: COMP,
      layer: "egp_layer",
      controllerName: "Hero Image",
    });
    expect(res.controllerCount ?? 1).toBeGreaterThan(0);
  });

  it("viewer.set_options drives fastPreview, channels, and guide snap", async (ctx) => {
    if (!ready) return ctx.skip();
    const opened = await openCompInViewer(transport as FileIpcTransport, COMP);
    if (!opened) return ctx.skip();
    const res = await o().run<{ warnings: string[] }>("viewer.set_options", {
      fastPreview: "adaptiveResolution",
      channels: "alpha",
      guidesSnap: true,
    });
    expect(res.warnings).toEqual([]);
    const state = await o().run<{ fastPreview: string | null; channels: string | null }>(
      "viewer.get_state",
      {},
    );
    expect(state.fastPreview).toBeTruthy();
    // Restore a sane view for whatever the user does next.
    await o().run("viewer.set_options", { fastPreview: "off", channels: "rgb" });
  });

  it("project.parse_swatch reads a generated .ase palette", async (ctx) => {
    if (!ready) return ctx.skip();
    const asePath = path.join(E2E_SCRATCH_DIR, "parity_swatch.ase").replace(/\\/g, "/");
    await fs.writeFile(asePath, buildAseFile());
    const res = await o().run<{ swatch: { values?: unknown[] } | null }>("project.parse_swatch", {
      path: asePath,
    });
    expect(res.swatch, "parseSwatchFile returned nothing").toBeTruthy();
  });

  it("project.get_xmp / set_xmp round-trip", async (ctx) => {
    if (!ready) return ctx.skip();
    const got = await o().run<{ length: number; xmp: string }>("project.get_xmp", {});
    expect(got.length).toBeGreaterThan(0);
    // AE re-serializes the packet on write (whitespace, reordered fields), so
    // asserting exact length would test Adobe's serializer, not this op.
    const set = await o().run<{ length: number }>("project.set_xmp", { xmp: got.xmp });
    expect(set.length).toBeGreaterThan(0);
  });

  it("shape.add_wiggle_transform lands with the verified matchNames", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("layer.create_shape", { comp: COMP, name: "wiggle_shape" });
    await o().run("shape.add_group", { comp: COMP, layer: "wiggle_shape" });
    await o().run("shape.add_rect", {
      comp: COMP,
      layer: "wiggle_shape",
      groupIndex: 1,
      size: [100, 100],
    });
    const res = await o().run<{ name: string }>("shape.add_wiggle_transform", {
      comp: COMP,
      layer: "wiggle_shape",
      groupIndex: 1,
      position: [20, 20],
      rotation: 10,
      wigglesPerSecond: 3,
    });
    expect(res.name).toBeTruthy();
  });

  it("project.new discards the fixture last (restore happens in afterAll)", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await o().run<{ numItems: number }>("project.new", { save: false });
    expect(res.numItems).toBe(0);
  });

  it("undo still works after crossing a project boundary (UndoGroup Mismatch regression)", async (ctx) => {
    if (!ready) return ctx.skip();
    // project.new just crossed a project boundary. If any call had left an
    // undo group open across it (the bug class behind AE 26's async
    // "UndoGroup Mismatch" dialog), the undo stack would now be corrupted for
    // the whole session: the batch below would not revert, and the dialog
    // would wedge every later call. A passing revert is the proof the
    // exemption list (undo/redo + project boundaries) is complete.
    await o().run("comp.create", {
      name: "post_boundary",
      width: 100,
      height: 100,
      fps: 30,
      duration: 5,
    });
    await o().run("batch.run", {
      ops: [
        { operation: "layer.create_null", args: { comp: "post_boundary", name: "pb_a" } },
        { operation: "layer.create_null", args: { comp: "post_boundary", name: "pb_b" } },
      ],
    });
    const undone = await o().run<{ undone: number }>("project.undo", { count: 1 });
    expect(undone.undone).toBe(1);
    const after = await o().run<{ layers: unknown[] }>("comp.info", { comp: "post_boundary" });
    expect(after.layers, "one undo must revert the whole batch").toHaveLength(0);
  });
});

// Self-contained: runs after the project boundary above, in the empty project
// project.new left behind. Ops that would permanently pollute the user's AE
// (render templates, memory limits) exercise their guard paths only.
describe("e2e: low-priority parity ops", () => {
  const LP = "lowpri_comp";

  it("project settings round-trip the new display/color fields", async (ctx) => {
    if (!ready) return ctx.skip();
    const got = await o().run<{ feetFramesFilmType: string; displayStartFrame: number }>(
      "project.get_settings",
      {},
    );
    expect(["mm16", "mm35"]).toContain(got.feetFramesFilmType);
    // Write the current values back — exercises the setters without changing anything.
    const set = await o().run<{ warnings: string[] }>("project.set_settings", {
      feetFramesFilmType: got.feetFramesFilmType,
      displayStartFrame: got.displayStartFrame,
      linearizeWorkingSpace: false,
      compensateForSceneReferredProfiles: false,
      footageTimecodeDisplayStartType: "useSourceMedia",
    });
    expect(set.warnings).toEqual([]);
  });

  it("project.set_tool activates the selection tool", async (ctx) => {
    if (!ready) return ctx.skip();
    const set = await o().run<{ tool: string }>("project.set_tool", { tool: "selection" });
    expect(set.tool).toBe("selection");
    const got = await o().run<{ tool: string }>("project.get_tool", {});
    expect(got.tool).toBe("selection");
  });

  it("project.set_multi_frame_rendering accepts the default config", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await o().run<{ enabled: boolean }>("project.set_multi_frame_rendering", {
      enabled: true,
      maxCpuPercent: 90,
    });
    expect(res.enabled).toBe(true);
  });

  it("project.set_default_import_folder points at the scratch dir", async (ctx) => {
    if (!ready) return ctx.skip();
    const res = await o().run<{ set: boolean }>("project.set_default_import_folder", {
      path: E2E_SCRATCH_DIR,
    });
    expect(res.set).toBe(true);
  });

  it("pref.set / get / delete round-trip in an MCP-owned section", async (ctx) => {
    if (!ready) return ctx.skip();
    const SEC = "MCP AE E2E Section";
    await o().run("pref.set", { section: SEC, key: "flag", value: true });
    await o().run("pref.set", { section: SEC, key: "ratio", value: 1.5, type: "float" });
    const flag = await o().run<{ exists: boolean; value: boolean }>("pref.get", {
      section: SEC,
      key: "flag",
      type: "bool",
    });
    expect(flag.exists).toBe(true);
    expect(flag.value).toBe(true);
    const ratio = await o().run<{ value: number }>("pref.get", {
      section: SEC,
      key: "ratio",
      type: "float",
    });
    expect(ratio.value).toBeCloseTo(1.5);
    const del = await o().run<{ deleted: boolean }>("pref.delete", { section: SEC, key: "flag" });
    expect(del.deleted).toBe(true);
    await o().run("pref.delete", { section: SEC, key: "ratio" });
    const gone = await o().run<{ exists: boolean }>("pref.get", {
      section: SEC,
      key: "flag",
      type: "bool",
    });
    expect(gone.exists).toBe(false);
  });

  it("pref.set_setting / get_setting round-trip", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("pref.set_setting", { section: "MCP AE E2E", key: "marker", value: "on" });
    const got = await o().run<{ exists: boolean; value: string }>("pref.get_setting", {
      section: "MCP AE E2E",
      key: "marker",
    });
    expect(got.exists).toBe(true);
    expect(got.value).toBe("on");
  });

  it("font management reads work; writes round-trip current values", async (ctx) => {
    if (!ready) return ctx.skip();
    const dups = await o().run<{ count: number }>("font.list_duplicates", {});
    expect(dups.count).toBeGreaterThanOrEqual(0);
    const lists = await o().run<{ favorites: string[] | null }>("font.get_lists", {});
    if (lists.favorites) {
      const setFav = await o().run<{ favorites: string[] }>("font.set_favorites", {
        families: lists.favorites,
      });
      expect(setFav.favorites).toEqual(lists.favorites);
    }
    const roman = await o().run<{ font: { postScriptName: string } | null }>(
      "font.get_default_for_script",
      { script: "roman" },
    );
    if (roman.font?.postScriptName) {
      const setBack = await o().run<{ font: string }>("font.set_default_for_script", {
        script: "roman",
        postScriptName: roman.font.postScriptName,
      });
      expect(setBack.font).toBe(roman.font.postScriptName);
    }
    const sub = await o().run<{ warnings: string[] }>("font.set_substitution", {
      freezeSync: false,
    });
    expect(sub.warnings).toEqual([]);
  });

  it("text.paste_range copies text+style across layers; reset_style clears overrides", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("comp.create", { name: LP, width: 500, height: 500, fps: 30, duration: 5 });
    await o().run("layer.create_text", { comp: LP, text: "SOURCE", name: "src_text" });
    await o().run("text.set_style", { comp: LP, layer: "src_text", fillColor: [1, 0, 0] });
    await o().run("layer.create_text", { comp: LP, text: "destination", name: "dst_text" });
    const pasted = await o().run<{ text: string }>("text.paste_range", {
      comp: LP,
      layer: "dst_text",
      start: 0,
      end: 4,
      sourceLayer: "src_text",
      sourceStart: 0,
      sourceEnd: 6,
    });
    expect(pasted.text.startsWith("SOURCE")).toBe(true);
    const reset = await o().run<{ warnings: string[] }>("text.reset_style", {
      comp: LP,
      layer: "dst_text",
      scope: "both",
    });
    expect(reset.warnings).toEqual([]);
  });

  it("keyframe.set_selected and property.select stage timeline selection", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("layer.create_solid", { comp: LP, name: "sel_solid", color: [0, 0, 1] });
    for (const [t, v] of [
      [0, 0],
      [1, 100],
    ] as const) {
      await o().run("keyframe.add", {
        comp: LP,
        layer: "sel_solid",
        property: ["Transform", "Opacity"],
        time: t,
        value: v,
      });
    }
    const sel = await o().run<{ touched: number; selectedKeys: number[] }>(
      "keyframe.set_selected",
      {
        comp: LP,
        layer: "sel_solid",
        property: ["Transform", "Opacity"],
        keyIndex: "all",
        selected: true,
      },
    );
    expect(sel.touched).toBe(2);
    expect(sel.selectedKeys).toHaveLength(2);
    const prop = await o().run<{ selected: boolean }>("property.select", {
      comp: LP,
      layer: "sel_solid",
      property: ["Transform", "Opacity"],
    });
    expect(prop.selected).toBe(true);
  });

  it("layer.calculate_transform solves and applies a corner placement", async (ctx) => {
    if (!ready) return ctx.skip();
    await o().run("layer.create_solid", { comp: LP, name: "ct_solid", color: [1, 1, 1] });
    await o().run("layer.set_props", { comp: LP, layer: "ct_solid", props: { threeDLayer: true } });
    const res = await o().run<{
      transform: { scale: number[]; position: number[] };
      applied: boolean;
      warnings: string[];
    }>("layer.calculate_transform", {
      comp: LP,
      layer: "ct_solid",
      topLeft: [0, 0, 0],
      topRight: [500, 0, 0],
      bottomLeft: [0, 500, 0],
      apply: true,
    });
    expect(res.applied).toBe(true);
    expect(res.transform.scale).toBeTruthy();
    expect(res.warnings).toEqual([]);
  });

  it("egp.open_in_panel and render.save_template guard path", async (ctx) => {
    if (!ready) return ctx.skip();
    const egp = await o().run<{ comp: string }>("egp.open_in_panel", { comp: LP });
    expect(egp.comp).toBe(LP);
    // saveAsTemplate would permanently add to the user's template list (no
    // scripting API removes templates), so only the validation path runs here.
    await o().run("render.add_to_queue", { comp: LP });
    const err = await o().expectRefusal("render.save_template", { type: "nope", name: "x" });
    expect(err.message).toContain("render|output");
    const notify = await o().run<{ warnings: string[] }>("render.set_output", {
      queueNotify: false,
    });
    expect(notify.warnings).toEqual([]);
    await o().run("render.clear_queue", {});
  });
});
