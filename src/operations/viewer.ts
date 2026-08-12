// Viewer operations — panel view state (zoom, exposure, channels).
// View state never touches the project, so these stay available in
// read-only mode — the same stance as render.frame.

import { registerOp, jsxVal } from "../registry.js";

registerOp({
  name: "viewer.get_state",
  category: "viewer",
  readOnly: true,
  description: "Read the active viewer's state: type, zoom, exposure, channels.",
  params: [],
  toJsx() {
    return `
            var _v = app.activeViewer;
            if (!_v) return { ok: false, error: "no active viewer" };
            var _view = _v.views[_v.activeViewIndex];
            var _opts = _view ? _view.options : null;
            // Friendly names round-trip into viewer.set_options; unknown enum
            // values fall through as their raw string form.
            function _fpName(v) {
                try {
                    if (v === FastPreviewType.FP_OFF) return "off";
                    if (v === FastPreviewType.FP_ADAPTIVE_RESOLUTION) return "adaptiveResolution";
                    if (v === FastPreviewType.FP_DRAFT) return "draft";
                    if (v === FastPreviewType.FP_FAST_DRAFT) return "fastDraft";
                    if (v === FastPreviewType.FP_WIREFRAME) return "wireframe";
                } catch (eFp) {}
                return (v === undefined || v === null) ? null : String(v);
            }
            return {
                ok: true,
                type: String(_v.type),
                maximized: _v.maximized,
                zoom: _opts ? AE.safeGet(function () { return _opts.zoom; }, null) : null,
                exposure: _opts ? AE.safeGet(function () { return _opts.exposure; }, null) : null,
                channels: _opts ? AE.safeGet(function () { return String(_opts.channels); }, null) : null,
                checkerboards: _opts ? AE.safeGet(function () { return _opts.checkerboards; }, null) : null,
                fastPreview: _opts ? AE.safeGet(function () { return _fpName(_opts.fastPreview); }, null) : null,
                guidesLocked: _opts ? AE.safeGet(function () { return _opts.guidesLocked; }, null) : null,
                guidesSnap: _opts ? AE.safeGet(function () { return _opts.guidesSnap; }, null) : null
            };
        `;
  },
});

registerOp({
  name: "viewer.set_options",
  category: "viewer",
  readOnly: true,
  description:
    "Set active-viewer view options: zoom (1 = 100%), exposure (stops), checkerboard, guide/ruler visibility and lock/snap (AE 16.1+), fast-preview mode, and the displayed channels.",
  params: [
    { name: "zoom", type: "number", description: "Zoom factor (1 = 100%)", required: false },
    { name: "exposure", type: "number", description: "Exposure in stops", required: false },
    {
      name: "checkerboards",
      type: "boolean",
      description: "Show transparency checkerboard",
      required: false,
    },
    {
      name: "guidesVisibility",
      type: "boolean",
      description: "Show guides (AE 16.1+)",
      required: false,
    },
    {
      name: "guidesLocked",
      type: "boolean",
      description: "Lock guides (AE 16.1+)",
      required: false,
    },
    {
      name: "guidesSnap",
      type: "boolean",
      description: "Snap to guides (AE 16.1+)",
      required: false,
    },
    {
      name: "rulers",
      type: "boolean",
      description: "Show rulers (AE 16.1+)",
      required: false,
    },
    {
      name: "maximized",
      type: "boolean",
      description: "Maximize the viewer panel",
      required: false,
    },
    {
      name: "fastPreview",
      type: "string",
      description: "off|adaptiveResolution|draft|fastDraft|wireframe",
      required: false,
    },
    {
      name: "channels",
      type: "string",
      description: "rgb|red|green|blue|alpha|alphaBoundary|alphaOverlay|rgbStraight",
      required: false,
    },
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.fastPreview !== undefined)
      sets.push(`
        try {
            var _fpMap = { "off": FastPreviewType.FP_OFF, "adaptiveResolution": FastPreviewType.FP_ADAPTIVE_RESOLUTION, "draft": FastPreviewType.FP_DRAFT, "fastDraft": FastPreviewType.FP_FAST_DRAFT, "wireframe": FastPreviewType.FP_WIREFRAME };
            if (_fpMap.hasOwnProperty(${jsxVal(args.fastPreview)})) { _opts.fastPreview = _fpMap[${jsxVal(args.fastPreview)}]; }
            else { _w.push("fastPreview: unknown value " + ${jsxVal(args.fastPreview)}); }
        } catch (e) { _w.push("fastPreview: " + AE.errText(e)); }`);
    if (args.channels !== undefined)
      sets.push(`
        try {
            var _chMap = { "rgb": ChannelType.CHANNEL_RGB, "red": ChannelType.CHANNEL_RED, "green": ChannelType.CHANNEL_GREEN, "blue": ChannelType.CHANNEL_BLUE, "alpha": ChannelType.CHANNEL_ALPHA, "alphaBoundary": ChannelType.CHANNEL_ALPHA_BOUNDARY, "alphaOverlay": ChannelType.CHANNEL_ALPHA_OVERLAY, "rgbStraight": ChannelType.CHANNEL_RGB_STRAIGHT };
            if (_chMap.hasOwnProperty(${jsxVal(args.channels)})) { _opts.channels = _chMap[${jsxVal(args.channels)}]; }
            else { _w.push("channels: unknown value " + ${jsxVal(args.channels)}); }
        } catch (e) { _w.push("channels: " + AE.errText(e)); }`);
    if (args.guidesLocked !== undefined)
      sets.push(
        `try { _opts.guidesLocked = ${jsxVal(args.guidesLocked)}; } catch (e) { _w.push("guidesLocked (AE 16.1+): " + AE.errText(e)); }`,
      );
    if (args.guidesSnap !== undefined)
      sets.push(
        `try { _opts.guidesSnap = ${jsxVal(args.guidesSnap)}; } catch (e) { _w.push("guidesSnap (AE 16.1+): " + AE.errText(e)); }`,
      );
    if (args.zoom !== undefined)
      sets.push(
        `try { _opts.zoom = ${jsxVal(args.zoom)}; } catch (e) { _w.push("zoom: " + AE.errText(e)); }`,
      );
    if (args.exposure !== undefined)
      sets.push(
        `try { _opts.exposure = ${jsxVal(args.exposure)}; } catch (e) { _w.push("exposure: " + AE.errText(e)); }`,
      );
    if (args.checkerboards !== undefined)
      sets.push(
        `try { _opts.checkerboards = ${jsxVal(args.checkerboards)}; } catch (e) { _w.push("checkerboards: " + AE.errText(e)); }`,
      );
    if (args.guidesVisibility !== undefined)
      sets.push(
        `try { _opts.guidesVisibility = ${jsxVal(args.guidesVisibility)}; } catch (e) { _w.push("guidesVisibility (AE 16.1+): " + AE.errText(e)); }`,
      );
    if (args.rulers !== undefined)
      sets.push(
        `try { _opts.rulers = ${jsxVal(args.rulers)}; } catch (e) { _w.push("rulers (AE 16.1+): " + AE.errText(e)); }`,
      );
    if (args.maximized !== undefined)
      sets.push(
        `try { _v.maximized = ${jsxVal(args.maximized)}; } catch (e) { _w.push("maximized: " + AE.errText(e)); }`,
      );
    return `
            var _v = app.activeViewer;
            if (!_v) return { ok: false, error: "no active viewer — open a comp first (timeline.set_active_comp)" };
            var _view = _v.views[_v.activeViewIndex];
            if (!_view) return { ok: false, error: "active viewer has no view" };
            var _opts = _view.options;
            var _w = [];
            ${sets.join("\n")}
            return { ok: true, warnings: _w };
        `;
  },
});
