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

interface RenderedFrame {
  ok: boolean;
  error?: string;
  writtenTo?: string;
  time?: number;
  size?: [number, number];
  captureKind?: "ocio" | "direct";
}

interface RenderFramePayload {
  ok: boolean;
  error?: string;
  frames?: RenderedFrame[];
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
    "Render one or more frames to PNG. Use to visually verify edits. " +
    "The agent's 'eyes' — pair with mutations for a visual feedback loop. " +
    "Headless and deterministic. Pass `time` for one frame, or `times` for several in ONE call " +
    "(motion checks): files land at <outPath stem>_<index>.png and are listed in `frames`. " +
    "In color-managed projects (workingSpace != None) the capture applies AE's own " +
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
    time: z
      .number()
      .nonnegative()
      .optional()
      .describe("Time in seconds to render. Give exactly one of `time` or `times`."),
    times: z
      .array(z.number().nonnegative())
      .min(1)
      .max(32)
      .optional()
      .describe(
        "Several times in seconds, rendered in ONE call. Files are written as " +
          "<outPath stem>_<index><ext> and reported in `frames` (index-aligned).",
      ),
    outPath: z
      .string()
      .describe(
        "Absolute path to write the PNG. Parent directory is created if missing. " +
          "With `times`, used as the naming stem for every frame.",
      ),
    useDisplayStartTime: z
      .boolean()
      .optional()
      .describe("If true, times are interpreted relative to comp.displayStartTime. Default false."),
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
    if ((args.time === undefined) === (args.times === undefined)) {
      return errorResult("INVALID_ARGS", "give exactly one of `time` or `times`", {
        hint: "`time: 1.5` renders one frame; `times: [0, 1, 2]` renders several in one call.",
      });
    }
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

/** Per-frame output paths: the single path as-is, or stem_<index><ext> for `times`. */
function framePaths(abs: string, count: number, multi: boolean): string[] {
  if (!multi) return [abs];
  const ext = path.extname(abs) || ".png";
  const stem = abs.slice(0, abs.length - (path.extname(abs).length || 0));
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(`${stem}_${i}${ext}`);
  return out;
}

async function nativeFlow(
  args: {
    compNameOrId: string | number;
    time?: number;
    times?: number[];
    useDisplayStartTime?: boolean;
    colorManaged?: "auto" | "off";
  },
  abs: string,
  transport: AeTransport,
) {
  const multi = args.times !== undefined;
  const times = args.times ?? [args.time as number];
  const paths = framePaths(abs, times.length, multi);
  // Color-managed projects: instead of reimplementing the view transform,
  // make AE apply its own — drop a transient adjustment layer carrying an
  // "OCIO Display Transform" effect on top of the comp and capture that.
  // Verified bit-near (mean 0.04/255) against a viewer-referenced capture;
  // the only artifact is the linear capture scale, which the calibration
  // pass restores. An adjustment layer (not a wrapper comp) so the viewer
  // keeps showing the same comp — and ONE layer serves every requested
  // frame, which is why `times` is cheaper than repeated single calls.
  // Mutating (one undo group, self-cleaning), so read-only mode falls back
  // to the pure-math conversion below.
  const tryOcio = args.colorManaged !== "off" && !readOnlyMode();
  const code = `
        ${RENDER_FRAME_FN}
        var _arg = ${jsxVal(args.compNameOrId)};
        var comp = AE.findCompByNameOrId(_arg);
        if (!comp) return { ok: false, error: "no comp matching " + String(_arg) };
        var _ws = AE.safeGet(function () { return app.project.workingSpace; }, "None");
        var _times = ${jsxVal(times)};
        var _paths = ${jsxVal(paths)};
        var _useDst = ${jsxVal(!!args.useDisplayStartTime)};
        var _useOcio = ${jsxVal(tryOcio)} && _ws !== "None" && _ws !== "";
        var _frames = [];
        function _renderAll(kind) {
            for (var _fi = 0; _fi < _times.length; _fi++) {
                var _r = _renderFrame(comp, _times[_fi], _paths[_fi], _useDst);
                _r.captureKind = kind;
                _frames.push(_r);
            }
        }
        if (_useOcio) {
            var _adj = null;
            var _adjSrc = null;
            try {
                _adj = comp.layers.addSolid([1, 1, 1], "__mcp_ocio__", comp.width, comp.height, comp.pixelAspect);
                _adjSrc = _adj.source;
                _adj.adjustmentLayer = true;
                try {
                    var _maxT = _times[0];
                    for (var _mi = 1; _mi < _times.length; _mi++) { if (_times[_mi] > _maxT) _maxT = _times[_mi]; }
                    if (_useDst) _maxT = _maxT + comp.displayStartTime;
                    if (_adj.outPoint < _maxT + comp.frameDuration) _adj.outPoint = _maxT + comp.frameDuration;
                } catch (eOp) { }
                var _fxOk = false;
                try {
                    _adj.property("Effects").addProperty("ADBE OCIO Display Transform");
                    _fxOk = true;
                } catch (eFx) { /* pre-OCIO AE or ICC color engine */ }
                if (_fxOk) _renderAll("ocio");
            } catch (eTmp) { /* fall through to direct capture */ }
            if (_adj) { try { _adj.remove(); } catch (eRm) { } }
            if (_adjSrc) { try { _adjSrc.remove(); } catch (eRs) { } }
        }
        if (_frames.length === 0) _renderAll("direct");
        var _allOk = true;
        var _firstError = null;
        for (var _ci = 0; _ci < _frames.length; _ci++) {
            if (!_frames[_ci].ok) { _allOk = false; if (_firstError === null) _firstError = _frames[_ci].error; }
        }
        var _out = { ok: _allOk, frames: _frames, captureKind: _frames.length > 0 ? _frames[0].captureKind : null };
        if (!_allOk) _out.error = _firstError;
        if (_allOk) {
            _out.compName = comp.name;
            _out.workingSpace = _ws;
            _out.bitsPerChannel = AE.safeGet(function () { return app.project.bitsPerChannel; }, 8);
            _out.projectFile = app.project.file ? app.project.file.fsName.replace(/\\\\/g, "/") : null;
        }
        return _out;
    `;
  const result = await transport.execute({
    code,
    label: "render_frame",
    timeoutMs: 120_000 + (times.length - 1) * 30_000,
  });
  if (!result.ok) return toMcpResult(result);
  const payload = result.result as RenderFramePayload;
  const frames = payload?.frames ?? [];
  // Single-frame calls keep the pre-`times` response shape (top-level
  // writtenTo/time/size); multi-frame calls report through `frames`.
  if (payload && payload.ok === true && !multi && frames.length === 1) {
    payload.writtenTo = frames[0].writtenTo;
    payload.time = frames[0].time;
    payload.size = frames[0].size;
    delete payload.frames;
  }
  if (!payload || payload.ok !== true || args.colorManaged === "off") {
    return toMcpResult(result);
  }

  payload.method = "native";
  const written: string[] = (multi ? frames.map((f) => f.writtenTo) : [payload.writtenTo]).filter(
    (p): p is string => typeof p === "string",
  );
  const workingSpace = payload.workingSpace ?? "None";
  try {
    if (workingSpace === "None" || workingSpace === "") {
      // Values are already display-referred; the only fix needed is an
      // explicit color tag so viewers stop guessing at the 16-bit file.
      for (const file of written) {
        const img = decodePng(await readFileSettled(file));
        await fs.writeFile(file, encodePngSrgb8(img.width, img.height, img.rgb));
      }
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
      for (const file of written) {
        const img = decodePng(await readFileSettled(file));
        for (let i = 0; i < img.rgb.length; i++) img.rgb[i] *= gain;
        await fs.writeFile(file, encodePngSrgb8(img.width, img.height, img.rgb));
      }
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
    for (const file of written) {
      const img = decodePng(await readFileSettled(file));
      for (let i = 0; i < img.rgb.length; i++) img.rgb[i] *= gain;
      sceneLinearToDisplaySrgb(img.rgb, profile.toRec709);
      await fs.writeFile(file, encodePngSrgb8(img.width, img.height, img.rgb));
    }
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
