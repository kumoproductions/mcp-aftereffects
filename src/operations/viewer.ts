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
            return {
                ok: true,
                type: String(_v.type),
                maximized: _v.maximized,
                zoom: _opts ? AE.safeGet(function () { return _opts.zoom; }, null) : null,
                exposure: _opts ? AE.safeGet(function () { return _opts.exposure; }, null) : null,
                channels: _opts ? AE.safeGet(function () { return String(_opts.channels); }, null) : null,
                checkerboards: _opts ? AE.safeGet(function () { return _opts.checkerboards; }, null) : null
            };
        `;
  },
});

registerOp({
  name: "viewer.set_options",
  category: "viewer",
  readOnly: true,
  description:
    "Set active-viewer view options: zoom (1 = 100%), exposure (stops), checkerboard, guide/ruler visibility (AE 16.1+ for guides/rulers).",
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
  ],
  toJsx(args) {
    const sets: string[] = [];
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
