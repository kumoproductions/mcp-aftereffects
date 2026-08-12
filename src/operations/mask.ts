// Mask operations — add, set path, set properties.

import { registerOp, jsxVal, jsxCompLayerPreamble } from "../registry.js";

registerOp({
  name: "mask.add",
  category: "mask",
  description: "Add a new mask to a layer. Returns the mask index.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "name", type: "string", description: "Mask name", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _masks = _layer.property("Masks");
            var _mask = _masks.addProperty("ADBE Mask Atom");
            ${args.name ? `_mask.name = ${jsxVal(args.name)};` : ""}
            return { ok: true, maskIndex: _mask.propertyIndex, name: _mask.name };
        `;
  },
});

registerOp({
  name: "mask.set_path",
  category: "mask",
  description:
    "Set a mask's shape path from vertices. Vertices are [x,y] pairs relative to the layer.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "maskIndex", type: "number", description: "1-based mask index", required: true },
    { name: "vertices", type: "array", description: "Array of [x,y] points", required: true },
    {
      name: "inTangents",
      type: "array",
      description: "Array of [x,y] in-tangent offsets (same length as vertices)",
      required: false,
    },
    {
      name: "outTangents",
      type: "array",
      description: "Array of [x,y] out-tangent offsets",
      required: false,
    },
    {
      name: "closed",
      type: "boolean",
      description: "Close the path (default true)",
      required: false,
      default: true,
    },
    {
      name: "featherSegLocs",
      type: "array",
      description: "Variable-width feather: 0-based segment index per feather point",
      required: false,
    },
    {
      name: "featherRelSegLocs",
      type: "array",
      description: "Variable-width feather: relative position (0-1) on the segment, per point",
      required: false,
    },
    {
      name: "featherRadii",
      type: "array",
      description: "Variable-width feather: radius in px per point (negative = inner feather)",
      required: false,
    },
    {
      name: "featherInterps",
      type: "array",
      description: "Variable-width feather: 0=smooth, 1=hold, per point (default all 0)",
      required: false,
    },
    {
      name: "featherTensions",
      type: "array",
      description: "Variable-width feather: tension 0-1 per point (default all 0)",
      required: false,
    },
    {
      name: "featherTypes",
      type: "array",
      description: "Variable-width feather: 0=outer, 1=inner, per point (default all 0)",
      required: false,
    },
    {
      name: "featherRelCornerAngles",
      type: "array",
      description: "Variable-width feather: relative corner angle % per point (default all 0)",
      required: false,
    },
  ],
  toJsx(args) {
    // The three feather-point arrays travel together; AE rejects a Shape whose
    // feather arrays disagree in length, so pad the optional ones to match.
    // Hoisted out of the main template: the lint's template scanner cannot see
    // through raw braces inside a `${…}` interpolation.
    const featherJsx =
      args.featherSegLocs === undefined
        ? ""
        : `
            var _fSeg = ${jsxVal(args.featherSegLocs)};
            var _fRel = ${jsxVal(args.featherRelSegLocs)};
            var _fRad = ${jsxVal(args.featherRadii)};
            if (!_fRel || !_fRad || _fSeg.length !== _fRel.length || _fSeg.length !== _fRad.length) {
                return { ok: false, error: "featherSegLocs, featherRelSegLocs and featherRadii must all be present with the same length" };
            }
            function _padded(arr, n) {
                var out = [];
                for (var _fi = 0; _fi < n; _fi++) out.push(arr && _fi < arr.length ? arr[_fi] : 0);
                return out;
            }
            _shape.featherSegLocs = _fSeg;
            _shape.featherRelSegLocs = _fRel;
            _shape.featherRadii = _fRad;
            _shape.featherInterps = _padded(${jsxVal(args.featherInterps)}, _fSeg.length);
            _shape.featherTensions = _padded(${jsxVal(args.featherTensions)}, _fSeg.length);
            _shape.featherTypes = _padded(${jsxVal(args.featherTypes)}, _fSeg.length);
            _shape.featherRelCornerAngles = _padded(${jsxVal(args.featherRelCornerAngles)}, _fSeg.length);
        `;
    return `
            ${jsxCompLayerPreamble(args)}
            var _mask = _layer.property("Masks").property(${jsxVal(args.maskIndex)});
            if (!_mask) return { ok: false, error: "no mask at index " + ${jsxVal(args.maskIndex)} };
            var _shape = new Shape();
            _shape.vertices = ${jsxVal(args.vertices)};
            _shape.closed = ${jsxVal(args.closed !== false)};
            ${args.inTangents ? `_shape.inTangents = ${jsxVal(args.inTangents)};` : ""}
            ${args.outTangents ? `_shape.outTangents = ${jsxVal(args.outTangents)};` : ""}
            ${featherJsx}
            _mask.property("ADBE Mask Shape").setValue(_shape);
            return { ok: true, maskIndex: ${jsxVal(args.maskIndex)} };
        `;
  },
});

registerOp({
  name: "mask.set_props",
  category: "mask",
  description:
    "Set mask properties: mode, feather, opacity, expansion, inverted, locked, color, rotoBezier, motionBlur, featherFalloff.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "maskIndex", type: "number", description: "1-based mask index", required: true },
    {
      name: "mode",
      type: "string",
      description: "Add|Subtract|Intersect|Lighten|Darken|Difference|None",
      required: false,
    },
    { name: "feather", type: "array", description: "[x,y] feather in px", required: false },
    { name: "opacity", type: "number", description: "Mask opacity 0-100", required: false },
    { name: "expansion", type: "number", description: "Mask expansion in px", required: false },
    { name: "inverted", type: "boolean", description: "Invert the mask", required: false },
    {
      name: "locked",
      type: "boolean",
      description: "Lock the mask against UI editing",
      required: false,
    },
    {
      name: "color",
      type: "array",
      description: "[r,g,b] 0-1 mask outline color in the UI",
      required: false,
    },
    {
      name: "rotoBezier",
      type: "boolean",
      description: "Treat the path as a RotoBezier (tangents auto-computed)",
      required: false,
    },
    {
      name: "motionBlur",
      type: "string",
      description: "sameAsLayer|on|off (per-mask motion blur)",
      required: false,
    },
    {
      name: "featherFalloff",
      type: "string",
      description: "smooth|linear (feather falloff)",
      required: false,
    },
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.mode !== undefined) {
      sets.push(`
                var _modeMap = { "Add": MaskMode.ADD, "Subtract": MaskMode.SUBTRACT, "Intersect": MaskMode.INTERSECT, "Lighten": MaskMode.LIGHTEN, "Darken": MaskMode.DARKEN, "Difference": MaskMode.DIFFERENCE, "None": MaskMode.NONE };
                if (_modeMap[${jsxVal(args.mode)}]) _mask.maskMode = _modeMap[${jsxVal(args.mode)}];
            `);
    }
    if (args.feather !== undefined)
      sets.push(
        `try { _mask.property("ADBE Mask Feather").setValue(${jsxVal(args.feather)}); } catch(e) {}`,
      );
    if (args.opacity !== undefined)
      sets.push(
        `try { _mask.property("ADBE Mask Opacity").setValue(${jsxVal(args.opacity)}); } catch(e) {}`,
      );
    if (args.expansion !== undefined)
      sets.push(
        `try { _mask.property("ADBE Mask Offset").setValue(${jsxVal(args.expansion)}); } catch(e) {}`,
      );
    // MaskPropertyGroup attributes (not child properties). Each set is
    // reported on failure instead of silently swallowed — these have no
    // second observable channel the caller could check.
    if (args.inverted !== undefined)
      sets.push(
        `try { _mask.inverted = ${jsxVal(args.inverted)}; } catch(e) { _w.push("inverted: " + AE.errText(e)); }`,
      );
    if (args.locked !== undefined)
      sets.push(
        `try { _mask.locked = ${jsxVal(args.locked)}; } catch(e) { _w.push("locked: " + AE.errText(e)); }`,
      );
    if (args.color !== undefined)
      sets.push(
        `try { _mask.color = ${jsxVal(args.color)}; } catch(e) { _w.push("color: " + AE.errText(e)); }`,
      );
    if (args.rotoBezier !== undefined)
      sets.push(
        `try { _mask.rotoBezier = ${jsxVal(args.rotoBezier)}; } catch(e) { _w.push("rotoBezier: " + AE.errText(e)); }`,
      );
    if (args.motionBlur !== undefined) {
      sets.push(`
                var _mbMap = { "sameAsLayer": MaskMotionBlur.SAME_AS_LAYER, "on": MaskMotionBlur.ON, "off": MaskMotionBlur.OFF };
                if (_mbMap.hasOwnProperty(${jsxVal(args.motionBlur)})) {
                    try { _mask.maskMotionBlur = _mbMap[${jsxVal(args.motionBlur)}]; } catch(e) { _w.push("motionBlur: " + AE.errText(e)); }
                } else { _w.push("motionBlur: unknown value " + ${jsxVal(args.motionBlur)}); }
            `);
    }
    if (args.featherFalloff !== undefined) {
      sets.push(`
                var _ffMap = { "smooth": MaskFeatherFalloff.FFO_SMOOTH, "linear": MaskFeatherFalloff.FFO_LINEAR };
                if (_ffMap.hasOwnProperty(${jsxVal(args.featherFalloff)})) {
                    try { _mask.maskFeatherFalloff = _ffMap[${jsxVal(args.featherFalloff)}]; } catch(e) { _w.push("featherFalloff: " + AE.errText(e)); }
                } else { _w.push("featherFalloff: unknown value " + ${jsxVal(args.featherFalloff)}); }
            `);
    }
    return `
            ${jsxCompLayerPreamble(args)}
            var _mask = _layer.property("Masks").property(${jsxVal(args.maskIndex)});
            if (!_mask) return { ok: false, error: "no mask at index " + ${jsxVal(args.maskIndex)} };
            var _w = [];
            ${sets.join("\n")}
            return { ok: true, maskIndex: ${jsxVal(args.maskIndex)}, warnings: _w };
        `;
  },
});

registerOp({
  name: "mask.remove",
  category: "mask",
  description: "Remove a mask from a layer by its 1-based index.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "maskIndex", type: "number", description: "1-based mask index", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _masks = _layer.property("Masks");
            if (!_masks) return { ok: false, error: "layer has no Masks group" };
            // PropertyGroup.property(index) throws on out-of-range rather than
            // returning null, so range-check first — otherwise the caller gets
            // a raw ExtendScript error instead of this message.
            if (${jsxVal(args.maskIndex)} < 1 || ${jsxVal(args.maskIndex)} > _masks.numProperties) {
                return { ok: false, error: "no mask at index " + ${jsxVal(args.maskIndex)} + " (layer has " + _masks.numProperties + ")" };
            }
            var _mask = _masks.property(${jsxVal(args.maskIndex)});
            if (!_mask) return { ok: false, error: "no mask at index " + ${jsxVal(args.maskIndex)} };
            var _name = _mask.name;
            _mask.remove();
            return { ok: true, removed: _name, remaining: _masks.numProperties };
        `;
  },
});
