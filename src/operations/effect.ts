// Effect operations — add, remove, set property.

import { knownBitDepth } from "../effects/pipl.js";
import { registerOp, jsxVal, jsxCompLayerPreamble } from "../registry.js";

registerOp({
  name: "effect.add",
  category: "effect",
  description:
    "Add an effect to a layer by matchName. Use ae_do project.list_effects (or effect.list_on_layer on a reference layer) to find matchNames. " +
    "In a 32bpc project the effect's processing depth is measured first (effect.bit_depth) and an effect that would clamp the float " +
    "pipeline to 16/8bpc is REFUSED — pick a 32bpc alternative, or pass allowLowBitDepth: true only when the user accepts the clamping.",
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
    {
      name: "allowLowBitDepth",
      type: "boolean",
      description:
        "Add the effect even though it processes below 32bpc in a 32bpc project (values above 1.0 clip, gradients band). Pass only when the user accepts that.",
      required: false,
      default: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _mn = ${jsxVal(args.matchName)};
            var _depth = null;
            if (app.project.bitsPerChannel === 32) {
                _depth = AE.effectBitDepth(_mn, ${jsxVal(knownBitDepth(args.matchName))});
                if (_depth.bpc !== null && _depth.bpc < 32 && ${jsxVal(args.allowLowBitDepth === true)} !== true) {
                    return {
                        ok: false,
                        error: "'" + _mn + "' processes at " + _depth.bpc + "bpc, but the project is 32bpc: it would clip values above 1.0 and quantize the float pipeline at this point in the stack",
                        hint: "Use a 32bpc effect for the same job (project.list_effects with bitDepth: true measures candidates), or pass allowLowBitDepth: true if the user accepts the clamping.",
                        details: { matchName: _mn, bpc: _depth.bpc, projectBpc: 32 }
                    };
                }
            }
            var _fx = _layer.property("Effects").addProperty(_mn);
            ${args.name ? `_fx.name = ${jsxVal(args.name)};` : ""}
            var _res = { ok: true, effectIndex: _fx.propertyIndex, name: _fx.name, matchName: _fx.matchName };
            if (_depth !== null) {
                _res.bpc = _depth.bpc;
                if (_depth.bpc === null) _res.warning = "could not determine the bit depth of '" + _mn + "' (" + _depth.reason + ") — check it in the Effects & Presets panel before relying on it in this 32bpc project";
                else if (_depth.bpc < 32) _res.warning = "'" + _mn + "' processes at " + _depth.bpc + "bpc in a 32bpc project (added because allowLowBitDepth: true)";
            }
            return _res;
        `;
  },
});

registerOp({
  name: "effect.bit_depth",
  category: "effect",
  description:
    "The bit depth (32 / 16 / 8 bpc) effects process at — the scripting API does not expose it. Plug-in effects (third-party, Cycore CC …) " +
    "are read from their PiPL flags (source: 'pipl'); Adobe's own effects are applied once to a throwaway 32bpc layer and their output " +
    "checked for float precision (source: 'measured'), the project restored afterwards and the result cached for the session. " +
    "bpc: null means unknown (reason says why). Use before choosing effects for a 32bpc project.",
  params: [
    {
      name: "matchNames",
      type: "array",
      description: "Effect matchNames to measure, e.g. ['ADBE Gaussian Blur 2', 'ADBE Mosaic']",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            var _mns = ${jsxVal(args.matchNames)};
            var _known = ${jsxVal(Array.isArray(args.matchNames) ? args.matchNames.map(knownBitDepth) : [])};
            var _out = [];
            for (var _i = 0; _i < _mns.length; _i++) _out.push(AE.effectBitDepth(String(_mns[_i]), _known[_i] || null));
            return { ok: true, projectBpc: app.project.bitsPerChannel, effects: _out };
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
    'Set the menu items of a Dropdown Menu Control effect (Property.setPropertyParameters, AE 17.0.1+) — the key API for MOGRT dropdowns. Item strings must be unique; "-" inserts a separator. AE re-creates the control (references from earlier calls become invalid); this op preserves the effect\'s display name across that re-creation.',
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
            // setPropertyParameters RE-CREATES the control: afterwards _eff and
            // _menu are invalid (any member access throws "Object is invalid")
            // and the display name resets to the default. Capture identity
            // first, re-resolve by index after, and put the caller's name back.
            var _prevName = _eff.name;
            var _effIndex = _eff.propertyIndex;
            try { _menu.setPropertyParameters(_items); } catch (eSp) { return { ok: false, error: "setPropertyParameters failed: " + AE.errText(eSp) }; }
            var _eff2 = null;
            try { _eff2 = _fx.property(_effIndex); } catch (eRf) {}
            // The re-resolved reference can itself be invalid (every member
            // access throws "Object is invalid") — treat that the same as a
            // failed re-resolve so the read-back below skips it too.
            var _eff2Name = null;
            try { _eff2Name = _eff2 !== null ? _eff2.name : null; } catch (eNm) { _eff2 = null; }
            if (_eff2 !== null && _eff2Name !== _prevName) {
                try { _eff2.name = _prevName; } catch (eNm2) {}
            }
            var _read = null;
            if (_eff2 !== null) {
                for (var _mi2 = 1; _mi2 <= _eff2.numProperties; _mi2++) {
                    var _cand2 = _eff2.property(_mi2);
                    var _isDd2 = false;
                    try { _isDd2 = (_cand2.isDropdownEffect === true); } catch (eDd2) {}
                    if (_isDd2) {
                        try { _read = AE.valueToJson(_cand2.propertyParameters); } catch (ePp) {}
                        break;
                    }
                }
            }
            return { ok: true, effect: _prevName, itemCount: _items.length, propertyParameters: _read };
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
