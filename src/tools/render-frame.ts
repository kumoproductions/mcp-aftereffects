import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

import { measureCaptureTransfer, calibrationKey } from "../color/calibration.js";
import { decodePng, encodePngSrgb8 } from "../color/png16.js";
import { readFileSettled } from "../color/settled-read.js";
import { profileForWorkingSpace, sceneLinearToDisplaySrgb } from "../color/transform.js";
import { rejectedOutputPath } from "../config.js";
import { errorResult } from "../errors.js";
import { readOnlyMode } from "../policy.js";
import { RENDER_FRAME_FN } from "../operations/snippets.js";
import { jsxVal } from "../registry.js";
import type { AeTransport } from "../transport/AeTransport.js";
import { defineTool, toMcpResult } from "./define-tool.js";

interface RenderFramePayload {
  ok: boolean;
  error?: string;
  writtenTo?: string;
  time?: number;
  compName?: string;
  size?: [number, number];
  workingSpace?: string;
  bitsPerChannel?: number;
  projectFile?: string | null;
  captureKind?: "ocio" | "direct";
  method?: string;
  colorPipeline?: string;
  colorWarning?: string;
}

export const renderFrameTool = defineTool({
  name: "ae_render_frame",
  title: "Render frame",
  description:
    "Render a single frame to PNG. Use to visually verify edits. " +
    "The agent's 'eyes' — pair with mutations for a visual feedback loop. " +
    "Headless and deterministic. In color-managed projects (workingSpace != None) the capture applies AE's own " +
    "display transform via a transient OCIO Display Transform adjustment layer, and the PNG comes back " +
    "viewer-accurate and sRGB-tagged. Where that layer cannot be used — read-only mode, an AE without the " +
    "OCIO effect, or a failed capture calibration — the result falls back to a pure-math ACES conversion or " +
    "to raw values with an explicit colorWarning; check colorPipeline / colorWarning on the response.",
  group: "render",
  // Survives read-only mode: it writes a PNG, and the visual verification loop
  // is the whole point of an audit session. Note this is NOT a
  // never-touches-the-project tool. In a color-managed project the capture
  // path adds a transient adjustment layer, and the calibration probe builds a
  // scratch comp — both removed before the call returns, both leaving the
  // project dirty and one undo step consumed. Read-only mode is exactly where
  // that must not happen, so both are gated on !readOnlyMode() below and the
  // call degrades to the pure-math path instead.
  blockedInReadOnly: false,
  effect: "write",
  inputShape: {
    compNameOrId: z
      .union([z.string(), z.number()])
      .describe("Composition name or numeric item id."),
    time: z.number().nonnegative().describe("Time in seconds to render."),
    outPath: z
      .string()
      .describe("Absolute path to write the PNG. Parent directory is created if missing."),
    useDisplayStartTime: z
      .boolean()
      .optional()
      .describe("If true, `time` is interpreted relative to comp.displayStartTime. Default false."),
    colorManaged: z
      .enum(["auto", "off"])
      .optional()
      .describe(
        "'auto' (default): detect the working space and return a viewer-accurate, 8-bit sRGB-tagged PNG. " +
          "'off': raw legacy output (16-bit, untagged, working-space values — dark/wrong-looking in " +
          "color-managed projects).",
      ),
  },
  handler: async (args, transport) => {
    const rejection = rejectedOutputPath(args.outPath);
    if (rejection !== null) {
      return errorResult("IO", rejection, {
        details: { outPath: path.resolve(args.outPath) },
        hint: "Render to a path outside the mailbox.",
      });
    }
    const abs = path.resolve(args.outPath).replace(/\\/g, "/");
    return nativeFlow(args, abs, transport);
  },
});

async function nativeFlow(
  args: {
    compNameOrId: string | number;
    time: number;
    useDisplayStartTime?: boolean;
    colorManaged?: "auto" | "off";
  },
  abs: string,
  transport: AeTransport,
) {
  // Color-managed projects: instead of reimplementing the view transform,
  // make AE apply its own — drop a transient adjustment layer carrying an
  // "OCIO Display Transform" effect on top of the comp and capture that.
  // Verified bit-near (mean 0.04/255) against a viewer-referenced capture;
  // the only artifact is the linear capture scale, which the calibration
  // pass restores. An adjustment layer (not a wrapper comp) so the viewer
  // keeps showing the same comp. Mutating (one undo group, self-cleaning),
  // so read-only mode falls back to the pure-math conversion below.
  const tryOcio = args.colorManaged !== "off" && !readOnlyMode();
  const code = `
        ${RENDER_FRAME_FN}
        var _arg = ${jsxVal(args.compNameOrId)};
        var comp = AE.findCompByNameOrId(_arg);
        if (!comp) return { ok: false, error: "no comp matching " + String(_arg) };
        var _ws = AE.safeGet(function () { return app.project.workingSpace; }, "None");
        var _t = ${jsxVal(args.time)};
        if (${jsxVal(!!args.useDisplayStartTime)}) _t = _t + comp.displayStartTime;
        var _useOcio = ${jsxVal(tryOcio)} && _ws !== "None" && _ws !== "";
        var _res = null;
        if (_useOcio) {
            var _adj = null;
            var _adjSrc = null;
            try {
                _adj = comp.layers.addSolid([1, 1, 1], "__mcp_ocio__", comp.width, comp.height, comp.pixelAspect);
                _adjSrc = _adj.source;
                _adj.adjustmentLayer = true;
                try { if (_adj.outPoint < _t + comp.frameDuration) _adj.outPoint = _t + comp.frameDuration; } catch (eOp) { }
                var _fxOk = false;
                try {
                    _adj.property("Effects").addProperty("ADBE OCIO Display Transform");
                    _fxOk = true;
                } catch (eFx) { /* pre-OCIO AE or ICC color engine */ }
                if (_fxOk) {
                    _res = _renderFrame(comp, _t, ${jsxVal(abs)}, false);
                    _res.captureKind = "ocio";
                }
            } catch (eTmp) { /* fall through to direct capture */ }
            if (_adj) { try { _adj.remove(); } catch (eRm) { } }
            if (_adjSrc) { try { _adjSrc.remove(); } catch (eRs) { } }
        }
        if (_res === null) {
            _res = _renderFrame(comp, _t, ${jsxVal(abs)}, false);
            _res.captureKind = "direct";
        }
        if (_res.ok) {
            _res.compName = comp.name;
            _res.workingSpace = _ws;
            _res.bitsPerChannel = AE.safeGet(function () { return app.project.bitsPerChannel; }, 8);
            _res.projectFile = app.project.file ? app.project.file.fsName.replace(/\\\\/g, "/") : null;
        }
        return _res;
    `;
  const result = await transport.execute({ code, label: "render_frame", timeoutMs: 120_000 });
  if (!result.ok) return toMcpResult(result);
  const payload = result.result as RenderFramePayload;
  if (!payload || payload.ok !== true || args.colorManaged === "off") {
    return toMcpResult(result);
  }

  payload.method = "native";
  const workingSpace = payload.workingSpace ?? "None";
  try {
    if (workingSpace === "None" || workingSpace === "") {
      // Values are already display-referred; the only fix needed is an
      // explicit color tag so viewers stop guessing at the 16-bit file.
      const img = decodePng(await readFileSettled(abs));
      await fs.writeFile(abs, encodePngSrgb8(img.width, img.height, img.rgb));
      payload.colorPipeline = "untagged 16-bit → 8-bit sRGB-tagged (values unchanged)";
      return toMcpResult(result);
    }

    const calib = await measureCaptureTransfer(
      transport,
      calibrationKey(payload.projectFile ?? null, workingSpace, payload.bitsPerChannel ?? 8),
      !readOnlyMode(),
    );
    const calibFailed = "error" in calib || calib.kind === "unknown";
    const gain = !calibFailed && calib.kind === "linear" ? 1 / calib.scale : 1;

    if (payload.captureKind === "ocio") {
      if (calibFailed) {
        payload.colorWarning =
          `AE applied its display transform, but the capture scale could not be measured (${"error" in calib ? calib.error : "non-linear transfer"}) — ` +
          "the file is uniformly dark by that unknown scale. Verify colors against the AE viewer manually.";
        return toMcpResult(result);
      }
      const img = decodePng(await readFileSettled(abs));
      for (let i = 0; i < img.rgb.length; i++) img.rgb[i] *= gain;
      await fs.writeFile(abs, encodePngSrgb8(img.width, img.height, img.rgb));
      payload.colorPipeline =
        "AE OCIO display transform (viewer-exact, any working space)" +
        (gain !== 1 ? ` + capture scale 1/${gain.toFixed(2)} restored` : "");
      return toMcpResult(result);
    }

    // Direct capture of a color-managed project (read-only mode, or an AE
    // without the OCIO effect): pure-math fallback for the working spaces we
    // know, verified within ~1.7/255 of the viewer on ACES/ACEScg.
    const profile = profileForWorkingSpace(workingSpace);
    if (profile === null) {
      payload.colorWarning =
        `working space '${workingSpace}' has no built-in conversion — the file contains raw working-space ` +
        "values and will not match the viewer. Verify colors against the AE viewer manually if they matter here.";
      return toMcpResult(result);
    }
    if (calibFailed) {
      payload.colorWarning =
        `could not characterize this AE version's capture transfer (${"error" in calib ? calib.error : "non-linear transfer"}) — ` +
        "the file contains raw working-space values. Verify colors against the AE viewer manually if they matter here.";
      return toMcpResult(result);
    }
    const img = decodePng(await readFileSettled(abs));
    for (let i = 0; i < img.rgb.length; i++) img.rgb[i] *= gain;
    sceneLinearToDisplaySrgb(img.rgb, profile.toRec709);
    await fs.writeFile(abs, encodePngSrgb8(img.width, img.height, img.rgb));
    payload.colorPipeline =
      `${profile.note}` + (gain !== 1 ? ` (capture scale 1/${gain.toFixed(2)} restored)` : "");
    return toMcpResult(result);
  } catch (err) {
    payload.colorWarning = `color post-processing failed, file left as raw capture: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return toMcpResult(result);
  }
}
