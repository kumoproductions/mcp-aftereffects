// Effect operations — add, remove, set property.

import { registerOp, jsxVal, jsxCompLayerPreamble } from "../registry.js";

registerOp({
  name: "effect.add",
  category: "effect",
  description:
    "Add an effect to a layer by matchName. Use ae_do project.list_effects (or effect.list_on_layer on a reference layer) to find matchNames.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "matchName",
      type: "string",
      description: "Effect matchName (e.g. 'ADBE Gaussian Blur 2')",
      required: true,
    },
    {
      name: "name",
      type: "string",
      description: "Custom display name for the effect",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _fx = _layer.property("Effects").addProperty(${jsxVal(args.matchName)});
            ${args.name ? `_fx.name = ${jsxVal(args.name)};` : ""}
            return { ok: true, effectIndex: _fx.propertyIndex, name: _fx.name, matchName: _fx.matchName };
        `;
  },
});

registerOp({
  name: "effect.remove",
  category: "effect",
  description: "Remove an effect by its 1-based index within the layer's Effects group.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "effectIndex", type: "number", description: "1-based effect index", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _fxRoot = _layer.property("Effects");
            if (${jsxVal(args.effectIndex)} < 1 || ${jsxVal(args.effectIndex)} > _fxRoot.numProperties) return { ok: false, error: "effect index out of range" };
            var _name = _fxRoot.property(${jsxVal(args.effectIndex)}).name;
            _fxRoot.property(${jsxVal(args.effectIndex)}).remove();
            return { ok: true, removed: _name };
        `;
  },
});

registerOp({
  name: "effect.list_on_layer",
  category: "effect",
  readOnly: true,
  description:
    "List all effects currently applied to a layer with their matchNames and properties.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _fx = _layer.property("Effects");
            var _list = [];
            for (var i = 1; i <= _fx.numProperties; i++) {
                var _e = _fx.property(i);
                var _props = [];
                for (var j = 1; j <= _e.numProperties; j++) {
                    var _p = _e.property(j);
                    _props.push({ index: j, name: _p.name, matchName: _p.matchName });
                }
                _list.push({ index: i, name: _e.name, matchName: _e.matchName, enabled: _e.enabled, properties: _props });
            }
            return { ok: true, effects: _list, count: _list.length };
        `;
  },
});

registerOp({
  name: "effect.set_property",
  category: "effect",
  description:
    "Set a property value on an effect. Property path is relative to the effect (e.g. ['Blurriness'] for Gaussian Blur).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "effectIndex", type: "number", description: "1-based effect index", required: true },
    {
      name: "property",
      type: "array",
      description: "Property path within the effect",
      required: true,
    },
    { name: "value", type: "any", description: "Value to set", required: true },
    {
      name: "time",
      type: "number",
      description: "If set, creates a keyframe at this time",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _fxRoot = _layer.property("Effects");
            var _fx = _fxRoot.property(${jsxVal(args.effectIndex)});
            if (!_fx) return { ok: false, error: "no effect at index " + ${jsxVal(args.effectIndex)} };
            var _propPath = ${jsxVal(args.property)};
            var _node = _fx;
            for (var _pi = 0; _pi < _propPath.length; _pi++) {
                var _next = null;
                try { _next = _node.property(_propPath[_pi]); } catch (e) {}
                if (!_next) return { ok: false, error: "effect property '" + _propPath[_pi] + "' not found" };
                _node = _next;
            }
            var _time = ${jsxVal(args.time ?? null)};
            if (_time !== null) {
                _node.setValueAtTime(_time, ${jsxVal(args.value)});
            } else {
                _node.setValue(${jsxVal(args.value)});
            }
            return { ok: true, name: _node.name, matchName: _node.matchName };
        `;
  },
});
