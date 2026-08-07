// Transform operations — set position, scale, rotation, opacity, anchor point.

import { registerOp, jsxVal, jsxCompPreamble } from "../registry.js";

registerOp({
  name: "transform.set",
  category: "transform",
  description:
    "Set transform properties on one or more layers. layer can be index, name, 'selected', or 'all'. For keyframes use keyframe.add.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "Layer index (number), name (string), 'selected', or 'all'",
      required: true,
    },
    { name: "position", type: "array", description: "[x,y] or [x,y,z]", required: false },
    {
      name: "scale",
      type: "array",
      description: "[sx,sy] or [sx,sy,sz] in percent",
      required: false,
    },
    { name: "rotation", type: "number", description: "Rotation in degrees", required: false },
    { name: "opacity", type: "number", description: "Opacity 0-100", required: false },
    { name: "anchorPoint", type: "array", description: "[x,y] or [x,y,z]", required: false },
    { name: "threeDLayer", type: "boolean", description: "Enable/disable 3D", required: false },
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.threeDLayer !== undefined)
      sets.push(
        `try { _l.threeDLayer = ${jsxVal(args.threeDLayer)}; } catch(e) { _w.push("3D: " + e); }`,
      );
    if (args.position !== undefined)
      sets.push(
        `try { _xf.position.setValue(${jsxVal(args.position)}); } catch(e) { _w.push("position: " + e); }`,
      );
    if (args.scale !== undefined)
      sets.push(
        `try { _xf.scale.setValue(${jsxVal(args.scale)}); } catch(e) { _w.push("scale: " + e); }`,
      );
    if (args.rotation !== undefined)
      sets.push(
        `try { _xf.rotation.setValue(${jsxVal(args.rotation)}); } catch(e) { _w.push("rotation: " + e); }`,
      );
    if (args.opacity !== undefined)
      sets.push(
        `try { _xf.opacity.setValue(${jsxVal(args.opacity)}); } catch(e) { _w.push("opacity: " + e); }`,
      );
    if (args.anchorPoint !== undefined)
      sets.push(
        `try { _xf.anchorPoint.setValue(${jsxVal(args.anchorPoint)}); } catch(e) { _w.push("anchorPoint: " + e); }`,
      );
    return `
            ${jsxCompPreamble(args)}
            var _layers = AE.resolveLayers(_comp, ${jsxVal(args.layer)});
            if (_layers.length === 0) return { ok: false, error: "no layers matched" };
            var _results = [];
            for (var _li = 0; _li < _layers.length; _li++) {
                var _l = _layers[_li];
                var _xf = _l.transform;
                var _w = [];
                ${sets.join("\n")}
                _results.push({ name: _l.name, warnings: _w });
            }
            return { ok: true, count: _results.length, layers: _results };
        `;
  },
});
