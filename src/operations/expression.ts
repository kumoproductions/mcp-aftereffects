// Expression operations — set, remove.

import {
  registerOp,
  jsxVal,
  jsxCompPreamble,
  jsxCompLayerPreamble,
  jsxPropertyLookup,
} from "../registry.js";

registerOp({
  name: "expression.set",
  category: "expression",
  description: "Apply an expression to a property.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
    { name: "expression", type: "string", description: "Expression code string", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            if (!_node.canSetExpression) return { ok: false, error: "property does not support expressions" };
            _node.expression = ${jsxVal(args.expression)};
            _node.expressionEnabled = true;
            return { ok: true, name: _node.name, expressionEnabled: true };
        `;
  },
});

registerOp({
  name: "expression.disable_all",
  category: "expression",
  description:
    "Disable all expressions in a comp (all layers, all properties). Returns a manifest that can be used to re-enable them later via expression.restore_all. Manifest paths use numeric property indices; manifests produced by older versions of this operation (matchName-based paths) are not compatible.",
  params: [{ name: "comp", type: "any", description: "Comp name or id", required: true }],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _manifest = [];
            function _walk(group, path, li) {
                for (var i = 1; i <= group.numProperties; i++) {
                    var p = group.property(i);
                    if (!p) continue;
                    try {
                        if (p.propertyType === PropertyType.PROPERTY && p.expressionEnabled) {
                            _manifest.push({ layer: li, path: path + "/" + p.propertyIndex, expr: p.expression });
                            p.expressionEnabled = false;
                        }
                    } catch(e) {}
                    if (p.numProperties > 0) _walk(p, path + "/" + p.propertyIndex, li);
                }
            }
            for (var li = 1; li <= _comp.numLayers; li++) {
                _walk(_comp.layer(li), "", li);
            }
            return { ok: true, disabled: _manifest.length, manifest: _manifest };
        `;
  },
});

registerOp({
  name: "expression.restore_all",
  category: "expression",
  description:
    "Re-enable expressions from a manifest produced by expression.disable_all. Optionally transform the expressions before restoring (e.g. replace content variable). Only manifests in the current format (numeric property-index paths) are supported; manifests from older versions are not compatible.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "manifest",
      type: "array",
      description: "Manifest array from expression.disable_all",
      required: true,
    },
    {
      name: "replacements",
      type: "object",
      description:
        'Optional string replacements to apply to each expression before restoring, e.g. { "old": "new" }',
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _manifest = ${jsxVal(args.manifest)};
            var _replacements = ${jsxVal(args.replacements ?? null)};
            var _restored = 0;
            var _errors = [];
            for (var i = 0; i < _manifest.length; i++) {
                var entry = _manifest[i];
                try {
                    var _layer = _comp.layer(entry.layer);
                    var parts = entry.path.split("/");
                    var node = _layer;
                    for (var j = 1; j < parts.length; j++) {
                        node = node.property(parseInt(parts[j], 10));
                    }
                    var expr = entry.expr;
                    if (_replacements) {
                        for (var key in _replacements) {
                            if (_replacements.hasOwnProperty(key)) {
                                expr = expr.split(key).join(_replacements[key]);
                            }
                        }
                    }
                    node.expression = expr;
                    node.expressionEnabled = true;
                    _restored++;
                } catch(e) {
                    _errors.push("layer " + entry.layer + " " + entry.path + ": " + AE.errText(e));
                }
            }
            return { ok: true, restored: _restored, errors: _errors };
        `;
  },
});

registerOp({
  name: "expression.remove",
  category: "expression",
  description: "Remove (disable) the expression on a property.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            _node.expression = "";
            _node.expressionEnabled = false;
            return { ok: true, name: _node.name, expressionEnabled: false };
        `;
  },
});
