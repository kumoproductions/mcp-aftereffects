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
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _mask = _layer.property("Masks").property(${jsxVal(args.maskIndex)});
            if (!_mask) return { ok: false, error: "no mask at index " + ${jsxVal(args.maskIndex)} };
            var _shape = new Shape();
            _shape.vertices = ${jsxVal(args.vertices)};
            _shape.closed = ${jsxVal(args.closed !== false)};
            ${args.inTangents ? `_shape.inTangents = ${jsxVal(args.inTangents)};` : ""}
            ${args.outTangents ? `_shape.outTangents = ${jsxVal(args.outTangents)};` : ""}
            _mask.property("ADBE Mask Shape").setValue(_shape);
            return { ok: true, maskIndex: ${jsxVal(args.maskIndex)} };
        `;
  },
});

registerOp({
  name: "mask.set_props",
  category: "mask",
  description: "Set mask properties: mode, feather, opacity, expansion.",
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
    return `
            ${jsxCompLayerPreamble(args)}
            var _mask = _layer.property("Masks").property(${jsxVal(args.maskIndex)});
            if (!_mask) return { ok: false, error: "no mask at index " + ${jsxVal(args.maskIndex)} };
            ${sets.join("\n")}
            return { ok: true, maskIndex: ${jsxVal(args.maskIndex)} };
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
