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

registerOp({
  name: "effect.move",
  category: "effect",
  description:
    "Reorder an effect within a layer's effect stack (PropertyBase.moveTo). Effect order changes the render result.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "effectIndex",
      type: "number",
      description: "1-based index of the effect to move",
      required: true,
    },
    {
      name: "toIndex",
      type: "number",
      description: "1-based target position in the stack",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _fx = _layer.property("Effects");
            if (!_fx) return { ok: false, error: "layer has no Effects group" };
            var _from = ${jsxVal(args.effectIndex)};
            var _to = ${jsxVal(args.toIndex)};
            if (_from < 1 || _from > _fx.numProperties) return { ok: false, error: "effectIndex out of range (1-" + _fx.numProperties + ")" };
            if (_to < 1 || _to > _fx.numProperties) return { ok: false, error: "toIndex out of range (1-" + _fx.numProperties + ")" };
            try { _fx.property(_from).moveTo(_to); } catch (eMv) { return { ok: false, error: "moveTo failed: " + AE.errText(eMv) }; }
            var _order = [];
            for (var _i = 1; _i <= _fx.numProperties; _i++) _order.push(_fx.property(_i).name);
            return { ok: true, order: _order };
        `;
  },
});

/**
 * Locate the Menu property of a Dropdown Menu Control effect into `_menu`.
 * Expects `_layer`; effect addressed by 1-based index or name in `_fxArg`.
 */
const DROPDOWN_MENU_LOOKUP_JSX = `
    var _fx = _layer.property("Effects");
    if (!_fx) return { ok: false, error: "layer has no Effects group" };
    var _eff = null;
    try { _eff = _fx.property(_fxArg); } catch (eEf) {}
    if (!_eff) return { ok: false, error: "no effect matching " + _fxArg };
    var _menu = null;
    for (var _mi = 1; _mi <= _eff.numProperties; _mi++) {
        var _cand = _eff.property(_mi);
        var _isDd = false;
        try { _isDd = (_cand.isDropdownEffect === true); } catch (eDd) {}
        if (_isDd) { _menu = _cand; break; }
    }
    if (!_menu) return { ok: false, error: "effect '" + _eff.name + "' has no dropdown menu property — is it a Dropdown Menu Control (ADBE Dropdown Control)? (needs AE 17.0.1+)" };
`;

registerOp({
  name: "effect.set_dropdown_items",
  category: "effect",
  description:
    'Set the menu items of a Dropdown Menu Control effect (Property.setPropertyParameters, AE 17.0.1+) — the key API for MOGRT dropdowns. Item strings must be unique; "-" inserts a separator. NOTE: AE re-creates the control, invalidating prior references to it.',
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "effect",
      type: "any",
      description: "1-based effect index or effect name (a Dropdown Menu Control)",
      required: true,
    },
    {
      name: "items",
      type: "array",
      description: 'Menu item strings, e.g. ["Red", "Green", "-", "Custom"]',
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _fxArg = ${jsxVal(args.effect)};
            ${DROPDOWN_MENU_LOOKUP_JSX}
            var _items = ${jsxVal(args.items)};
            var _newMenu = null;
            try { _newMenu = _menu.setPropertyParameters(_items); } catch (eSp) { return { ok: false, error: "setPropertyParameters failed: " + AE.errText(eSp) }; }
            var _read = null;
            try { _read = AE.valueToJson((_newMenu || _menu).propertyParameters); } catch (ePp) {}
            return { ok: true, effect: _eff.name, itemCount: _items.length, propertyParameters: _read };
        `;
  },
});

registerOp({
  name: "effect.get_dropdown_items",
  category: "effect",
  readOnly: true,
  description:
    "Read a Dropdown Menu Control's items (Property.propertyParameters, AE 26.0+), current 1-based selection, and its text (valueText).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "effect",
      type: "any",
      description: "1-based effect index or effect name (a Dropdown Menu Control)",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _fxArg = ${jsxVal(args.effect)};
            ${DROPDOWN_MENU_LOOKUP_JSX}
            return {
                ok: true,
                effect: _eff.name,
                value: AE.safeGet(function () { return _menu.value; }, null),
                valueText: AE.safeGet(function () { return _menu.valueText; }, null),
                items: AE.safeGet(function () { return AE.valueToJson(_menu.propertyParameters); }, null)
            };
        `;
  },
});
