// Layer operations — create, delete, duplicate, set properties.

import { registerOp, jsxVal, jsxCompPreamble, jsxCompLayerPreamble } from "../registry.js";

registerOp({
  name: "layer.create_solid",
  category: "layer",
  description: "Create a solid layer in a composition.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "name", type: "string", description: "Layer name", required: false, default: "Solid" },
    {
      name: "color",
      type: "array",
      description: "[r,g,b] 0-1",
      required: false,
      default: [1, 1, 1],
    },
    {
      name: "width",
      type: "number",
      description: "Width in px (default: comp width)",
      required: false,
    },
    {
      name: "height",
      type: "number",
      description: "Height in px (default: comp height)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _w = ${jsxVal(args.width)} || _comp.width;
            var _h = ${jsxVal(args.height)} || _comp.height;
            var _layer = _comp.layers.addSolid(${jsxVal(args.color ?? [1, 1, 1])}, ${jsxVal(args.name ?? "Solid")}, _w, _h, _comp.pixelAspect, _comp.duration);
            return { ok: true, index: _layer.index, name: _layer.name };
        `;
  },
});

registerOp({
  name: "layer.create_shape",
  category: "layer",
  description: "Create an empty shape layer.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "name", type: "string", description: "Layer name", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _layer = _comp.layers.addShape();
            ${args.name ? `_layer.name = ${jsxVal(args.name)};` : ""}
            return { ok: true, index: _layer.index, name: _layer.name };
        `;
  },
});

registerOp({
  name: "layer.create_text",
  category: "layer",
  description: "Create a text layer.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "text", type: "string", description: "Text content", required: false, default: "" },
    { name: "name", type: "string", description: "Layer name", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _layer = _comp.layers.addText(${jsxVal(args.text ?? "")});
            ${args.name ? `_layer.name = ${jsxVal(args.name)};` : ""}
            return { ok: true, index: _layer.index, name: _layer.name };
        `;
  },
});

registerOp({
  name: "layer.create_null",
  category: "layer",
  description: "Create a null object layer.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "name", type: "string", description: "Layer name", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _layer = _comp.layers.addNull();
            ${args.name ? `_layer.name = ${jsxVal(args.name)};` : ""}
            return { ok: true, index: _layer.index, name: _layer.name };
        `;
  },
});

registerOp({
  name: "layer.create_camera",
  category: "layer",
  description: "Create a camera layer.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "name", type: "string", description: "Layer name", required: false, default: "Camera" },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _layer = _comp.layers.addCamera(${jsxVal(args.name ?? "Camera")}, [_comp.width/2, _comp.height/2]);
            return { ok: true, index: _layer.index, name: _layer.name };
        `;
  },
});

registerOp({
  name: "layer.create_light",
  category: "layer",
  description: "Create a light layer.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "name", type: "string", description: "Layer name", required: false, default: "Light" },
    {
      name: "lightType",
      type: "string",
      description: "spot|parallel|point|ambient",
      required: false,
      default: "spot",
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _layer = _comp.layers.addLight(${jsxVal(args.name ?? "Light")}, [_comp.width/2, _comp.height/2]);
            var _ltMap = {
                "spot": LightType.SPOT,
                "parallel": LightType.PARALLEL,
                "point": LightType.POINT,
                "ambient": LightType.AMBIENT
            };
            var _ltArg = ${jsxVal(args.lightType ?? "spot")};
            var _applied = null;
            if (_ltMap[_ltArg]) {
                try { _layer.lightType = _ltMap[_ltArg]; _applied = _ltArg; } catch (eLt) {}
            }
            return { ok: true, index: _layer.index, name: _layer.name, lightType: _applied };
        `;
  },
});

registerOp({
  name: "layer.delete",
  category: "layer",
  description:
    "Delete layers. comp supports pattern ('review_id_*'). layer supports index, name, 'selected', 'all'.",
  params: [
    {
      name: "comp",
      type: "any",
      description: "Comp name/id/pattern (e.g. 'review_id_*')",
      required: true,
    },
    {
      name: "layer",
      type: "any",
      description: "Layer index, name, 'selected', or 'all'",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            var _comps = AE.findComps(${jsxVal(args.comp)});
            if (_comps.length === 0) return { ok: false, error: "no comps matched" };
            var _removed = 0;
            for (var _ci = 0; _ci < _comps.length; _ci++) {
                var _layers = AE.resolveLayers(_comps[_ci], ${jsxVal(args.layer)});
                for (var _li = _layers.length - 1; _li >= 0; _li--) {
                    try { _layers[_li].remove(); _removed++; } catch(e) {}
                }
            }
            return { ok: true, removed: _removed, comps: _comps.length };
        `;
  },
});

registerOp({
  name: "layer.duplicate",
  category: "layer",
  description: "Duplicate a layer. Returns the new layer's index.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "newName", type: "string", description: "Name for the duplicate", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _dup = _layer.duplicate();
            ${args.newName ? `_dup.name = ${jsxVal(args.newName)};` : ""}
            return { ok: true, index: _dup.index, name: _dup.name };
        `;
  },
});

registerOp({
  name: "layer.set_parent",
  category: "layer",
  description: "Set or clear a layer's parent.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based child layer index, or the layer name",
      required: true,
    },
    {
      name: "parentLayer",
      type: "any",
      description: "1-based parent layer index or name. Pass null or 0 to unparent.",
      required: true,
      nullable: true,
    },
  ],
  toJsx(args) {
    const parentVal =
      args.parentLayer === null || args.parentLayer === 0
        ? "null"
        : `_comp.layer(${jsxVal(args.parentLayer)})`;
    return `
            ${jsxCompLayerPreamble(args)}
            _layer.parent = ${parentVal};
            return { ok: true, parent: _layer.parent ? { index: _layer.parent.index, name: _layer.parent.name } : null };
        `;
  },
});

registerOp({
  name: "layer.move",
  category: "layer",
  description: "Move a layer to a new stacking position (1 = top).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based current layer index, or the layer name",
      required: true,
    },
    { name: "toIndex", type: "number", description: "1-based target index", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            _layer.moveTo(${jsxVal(args.toIndex)});
            return { ok: true, newIndex: _layer.index, name: _layer.name };
        `;
  },
});

registerOp({
  name: "layer.create_footage",
  category: "layer",
  description: "Add an existing project item (footage or comp) as a layer in a composition.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "sourceItemId",
      type: "number",
      description: "Project item id to use as source",
      required: true,
    },
    { name: "name", type: "string", description: "Layer name", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _src = AE.findItemById(${jsxVal(args.sourceItemId)});
            if (!_src) return { ok: false, error: "no item with id " + ${jsxVal(args.sourceItemId)} };
            var _layer = _comp.layers.add(_src);
            ${args.name ? `_layer.name = ${jsxVal(args.name)};` : ""}
            return { ok: true, index: _layer.index, name: _layer.name };
        `;
  },
});

registerOp({
  name: "layer.set_enabled",
  category: "layer",
  description:
    "Enable or disable a layer by name or index. Can target all comps matching a pattern.",
  params: [
    {
      name: "comp",
      type: "any",
      description: "Comp name/id, or '*' for all comps, or 'review_id_*' for pattern match",
      required: true,
    },
    {
      name: "layer",
      type: "any",
      description: "Layer index (number) or name (string)",
      required: true,
    },
    { name: "enabled", type: "boolean", description: "true=visible, false=hidden", required: true },
  ],
  toJsx(args) {
    return `
            var _comps = AE.findComps(${jsxVal(args.comp)});
            var _updated = 0;
            for (var ci = 0; ci < _comps.length; ci++) {
                var _layer = AE.findLayerInComp(_comps[ci], ${jsxVal(args.layer)});
                if (_layer) { _layer.enabled = ${jsxVal(!!args.enabled)}; _updated++; }
            }
            return { ok: true, updated: _updated };
        `;
  },
});

registerOp({
  name: "layer.set_guide",
  category: "layer",
  description: "Set guideLayer on/off for a layer. Can target all comps matching a pattern.",
  params: [
    {
      name: "comp",
      type: "any",
      description: "Comp name/id, or '*' for all comps, or 'review_id_*' for pattern match",
      required: true,
    },
    {
      name: "layer",
      type: "any",
      description: "Layer index (number) or name (string)",
      required: true,
    },
    {
      name: "guide",
      type: "boolean",
      description: "true=guide layer, false=normal",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            var _comps = AE.findComps(${jsxVal(args.comp)});
            var _updated = 0;
            for (var ci = 0; ci < _comps.length; ci++) {
                var _layer = AE.findLayerInComp(_comps[ci], ${jsxVal(args.layer)});
                if (_layer) { _layer.guideLayer = ${jsxVal(!!args.guide)}; _updated++; }
            }
            return { ok: true, updated: _updated };
        `;
  },
});

registerOp({
  name: "layer.set_props",
  category: "layer",
  description: "Set basic layer properties. layer can be index, name, 'selected', or 'all'.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "Layer index, name, 'selected', or 'all'",
      required: true,
    },
    {
      name: "props",
      type: "object",
      description:
        "Object with keys to set, e.g. { name: 'foo', enabled: false, label: 5, threeDLayer: true }",
      required: true,
    },
  ],
  toJsx(args) {
    const props = (args.props ?? {}) as Record<string, unknown>;
    const lines: string[] = [];
    for (const [k, v] of Object.entries(props)) {
      lines.push(
        `try { _l[${jsxVal(k)}] = ${jsxVal(v)}; } catch (e) { _w.push(${jsxVal(k)} + ": " + AE.errText(e)); }`,
      );
    }
    return `
            ${jsxCompPreamble(args)}
            var _layers = AE.resolveLayers(_comp, ${jsxVal(args.layer)});
            if (_layers.length === 0) return { ok: false, error: "no layers matched" };
            var _results = [];
            for (var _li = 0; _li < _layers.length; _li++) {
                var _l = _layers[_li];
                var _w = [];
                ${lines.join("\n")}
                _results.push({ name: _l.name, warnings: _w });
            }
            return { ok: true, count: _results.length, layers: _results };
        `;
  },
});
