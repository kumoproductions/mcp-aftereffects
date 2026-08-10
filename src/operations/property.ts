// Generic property operations — set value, get value, for any property path.

import {
  registerOp,
  jsxVal,
  jsxCompPreamble,
  jsxCompLayerPreamble,
  jsxPropertyLookup,
} from "../registry.js";

registerOp({
  name: "property.set",
  category: "property",
  description: "Set any layer property by path. layer can be index, name, 'selected', or 'all'.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "Layer index, name, 'selected', or 'all'",
      required: true,
    },
    {
      name: "property",
      type: "array",
      description: 'Property path, e.g. ["Transform","Position"]',
      required: true,
    },
    { name: "value", type: "any", description: "Value to set", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _layers = AE.resolveLayers(_comp, ${jsxVal(args.layer)});
            if (_layers.length === 0) return { ok: false, error: "no layers matched" };
            var _propPath = ${jsxVal(args.property)};
            var _results = [];
            for (var _li = 0; _li < _layers.length; _li++) {
                var _layer = _layers[_li];
                try {
                    var _node = _layer;
                    for (var _pi = 0; _pi < _propPath.length; _pi++) {
                        _node = _node.property(_propPath[_pi]);
                        if (!_node) throw new Error("not found: " + _propPath[_pi]);
                    }
                    _node.setValue(${jsxVal(args.value)});
                    _results.push({ name: _layer.name, ok: true });
                } catch(e) {
                    _results.push({ name: _layer.name, ok: false, error: AE.errText(e).substring(0, 50) });
                }
            }
            return { ok: true, count: _results.length, layers: _results };
        `;
  },
});

registerOp({
  name: "property.get",
  category: "property",
  readOnly: true,
  description: "Get the current value of any layer property by path.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
    {
      name: "time",
      type: "number",
      description: "If set, get value at this time (for animated properties)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            var _val;
            if (${jsxVal(args.time ?? null)} !== null) {
                _val = _node.valueAtTime(${jsxVal(args.time)}, false);
            } else {
                _val = _node.value;
            }
            return {
                ok: true,
                name: _node.name,
                matchName: _node.matchName,
                value: AE.valueToJson(_val),
                numKeys: _node.numKeys || 0,
                hasExpression: _node.canSetExpression ? _node.expressionEnabled : false
            };
        `;
  },
});

registerOp({
  name: "property.list",
  category: "property",
  readOnly: true,
  description:
    "List child properties/groups at a given path. Useful for discovering what's inside a property group.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "property",
      type: "array",
      description: "Property path to a group. Use [] for the layer root.",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            if (!_node.numProperties) return { ok: false, error: "not a property group (leaf property)" };
            var children = [];
            for (var i = 1; i <= _node.numProperties; i++) {
                var ch = _node.property(i);
                children.push({
                    index: i,
                    name: ch.name,
                    matchName: ch.matchName,
                    isGroup: ch.propertyType !== PropertyType.PROPERTY,
                    numChildren: ch.numProperties || 0
                });
            }
            return { ok: true, path: _propPath, children: children };
        `;
  },
});

registerOp({
  name: "property.add",
  category: "property",
  description:
    'Add a property to an indexed group by matchName (PropertyGroup.addProperty). Unlocks text animators (\'ADBE Text Animator\' on ["Text","Animators"]), layer styles, shape contents, etc. Use property.list to discover group paths.',
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "property",
      type: "array",
      description:
        'Path to the group to add into, e.g. ["Text","Animators"]. Use [] for layer root.',
      required: true,
    },
    {
      name: "matchName",
      type: "string",
      description:
        'Match name (or display name) of the property to add, e.g. "ADBE Text Animator". NOTE: adding to an indexed group re-creates it, invalidating prior property references.',
      required: true,
    },
    { name: "name", type: "string", description: "Rename the new property", required: false },
  ],
  toJsx(args) {
    const renameJsx = args.name
      ? `try { _added.name = ${jsxVal(args.name)}; } catch (eName) {}`
      : "";
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            var _mn = ${jsxVal(args.matchName)};
            var _canAdd = false;
            try { _canAdd = _node.canAddProperty(_mn); } catch (eCan) {
                return { ok: false, error: "not a property group that supports addProperty" };
            }
            if (!_canAdd) return { ok: false, error: "group '" + _node.matchName + "' cannot add '" + _mn + "'" };
            var _added = _node.addProperty(_mn);
            ${renameJsx}
            return { ok: true, name: _added.name, matchName: _added.matchName, propertyIndex: _added.propertyIndex };
        `;
  },
});

registerOp({
  name: "property.remove",
  category: "property",
  description:
    "Remove a property or group by path (Property.remove). Works on members of indexed groups: effects, masks, shape contents, text animators, layer styles.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "property",
      type: "array",
      description: "Path to the property to remove",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            // An empty path leaves _node === _layer, and Layer.remove() would
            // delete the whole layer. property.add accepts [] for the layer
            // root, so a caller has every reason to try it here too.
            if (!_propPath.length) return { ok: false, error: "property path is empty — that would remove the layer itself, not a property" };
            ${jsxPropertyLookup()}
            var _removedName = _node.name;
            try { _node.remove(); } catch (eRm) {
                return { ok: false, error: "cannot remove '" + _removedName + "': " + AE.errText(eRm) };
            }
            return { ok: true, removed: _removedName };
        `;
  },
});

registerOp({
  name: "property.separate_dimensions",
  category: "property",
  description:
    "Separate (or rejoin) the dimensions of a multi-dimensional property such as Position. When separated, animate the followers (e.g. X Position) individually.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "property",
      type: "array",
      description: "Property path (e.g. Position)",
      required: true,
    },
    {
      name: "separated",
      type: "boolean",
      description: "true=separate, false=rejoin",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            if (!_node.isSeparationLeader) return { ok: false, error: "property cannot separate dimensions" };
            _node.dimensionsSeparated = ${jsxVal(!!args.separated)};
            return { ok: true, dimensionsSeparated: _node.dimensionsSeparated };
        `;
  },
});
