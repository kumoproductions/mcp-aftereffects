// Essential Graphics / Motion Graphics Template operations.

import {
  registerOp,
  jsxVal,
  jsxCompPreamble,
  jsxCompLayerPreamble,
  jsxPropertyLookup,
} from "../registry.js";

registerOp({
  name: "egp.set_name",
  category: "egp",
  description: "Set the Motion Graphics Template name of a comp (Essential Graphics panel title).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "name", type: "string", description: "Template name", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            _comp.motionGraphicsTemplateName = ${jsxVal(args.name)};
            return { ok: true, name: _comp.motionGraphicsTemplateName };
        `;
  },
});

registerOp({
  name: "egp.add_property",
  category: "egp",
  description:
    "Expose a layer property in the Essential Graphics panel of a comp (Property.addToMotionGraphicsTemplateAs). The comp becomes the template master.",
  params: [
    {
      name: "comp",
      type: "any",
      description: "Comp name or id (holds the property)",
      required: true,
    },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
    {
      name: "controllerName",
      type: "string",
      description: "Display name in the Essential Graphics panel (default: property name)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            var _can = false;
            try { _can = _node.canAddToMotionGraphicsTemplate(_comp); } catch (eCan) {
                return { ok: false, error: "canAddToMotionGraphicsTemplate unavailable (needs AE 15.0+)" };
            }
            if (!_can) return { ok: false, error: "property '" + _node.name + "' cannot be added to the template (unsupported type or already added)" };
            var _ctrlName = ${jsxVal(args.controllerName ?? null)};
            var _added = false;
            var _namedAs = false;
            if (_ctrlName !== null && typeof _node.addToMotionGraphicsTemplateAs === "function") {
                _added = _node.addToMotionGraphicsTemplateAs(_comp, _ctrlName);
                _namedAs = _added === true;
            } else {
                _added = _node.addToMotionGraphicsTemplate(_comp);
            }
            // Without addToMotionGraphicsTemplateAs the property still gets
            // added, just under its default name. Reporting the requested
            // controller name back would claim a rename that never happened.
            var _res = { ok: _added === true, property: _node.name, controller: _namedAs ? _ctrlName : null };
            if (_ctrlName !== null && !_namedAs) _res.warning = "controllerName ignored (addToMotionGraphicsTemplateAs needs AE 16.1+) — added under its default name";
            return _res;
        `;
  },
});

registerOp({
  name: "egp.list_controllers",
  category: "egp",
  readOnly: true,
  description:
    "List the Essential Graphics controllers exposed on a comp (AE 16.1+ for controller names).",
  params: [{ name: "comp", type: "any", description: "Comp name or id", required: true }],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _count = 0;
            try { _count = _comp.motionGraphicsTemplateControllerCount; } catch (eC) {
                return { ok: false, error: "motionGraphicsTemplateControllerCount needs AE 16.1+" };
            }
            var _controllers = [];
            for (var _i = 0; _i < _count; _i++) {
                var _name = null;
                try { _name = _comp.getMotionGraphicsTemplateControllerName(_i); } catch (eN) {}
                _controllers.push({ index: _i, name: _name });
            }
            return { ok: true, templateName: AE.safeGet(function () { return _comp.motionGraphicsTemplateName; }, null), count: _count, controllers: _controllers };
        `;
  },
});

registerOp({
  name: "egp.export_mogrt",
  category: "egp",
  description:
    "Export a comp as a Motion Graphics Template (.mogrt) file for Premiere Pro (CompItem.exportAsMotionGraphicsTemplate).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "path",
      type: "string",
      description:
        "Absolute destination FOLDER (the filename comes from the template name). Omit to save into the user's Motion Graphics Templates folder. Save the project first — a dirty project triggers a save prompt.",
      required: false,
    },
    {
      name: "overwrite",
      type: "boolean",
      description: "Overwrite an existing file without asking (default true)",
      required: false,
      default: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            if (typeof _comp.exportAsMotionGraphicsTemplate !== "function") {
                return { ok: false, error: "exportAsMotionGraphicsTemplate needs AE 15.0+" };
            }
            var _path = ${jsxVal(args.path ?? null)};
            var _res = false;
            if (_path !== null) {
                _res = _comp.exportAsMotionGraphicsTemplate(${jsxVal(args.overwrite !== false)}, _path);
            } else {
                _res = _comp.exportAsMotionGraphicsTemplate(${jsxVal(args.overwrite !== false)});
            }
            return { ok: _res === true, templateName: AE.safeGet(function () { return _comp.motionGraphicsTemplateName; }, null), path: _path };
        `;
  },
});

registerOp({
  name: "egp.set_alternate_source",
  category: "egp",
  description:
    "Set a Media Replacement alternate source on an Essential Properties source (Property.setAlternateSource, AE 18.0+). Works on layers of a template comp opened from Essential Graphics.",
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
      description: "Property path to the media-replacement essential property",
      required: true,
    },
    {
      name: "item",
      type: "any",
      description: "Replacement source: project item id (number) or name (string)",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            var _item = AE.findItem(${jsxVal(args.item)});
            if (!_item) return { ok: false, error: "no project item matching " + ${jsxVal(String(args.item))} };
            if (_item instanceof FolderItem) return { ok: false, error: "item is a folder, not footage/comp" };
            // canSetAlternateSource is a property read, not a call: on an AE
            // that predates it the read yields undefined rather than throwing,
            // so a bare falsy test would blame the property instead of the host
            // version. Separate "API missing" from "API says no".
            var _can;
            try { _can = _node.canSetAlternateSource; } catch (eCan) { _can = undefined; }
            if (typeof _can === "undefined" || typeof _node.setAlternateSource !== "function") {
                return { ok: false, error: "setAlternateSource needs AE 18.0+ — this host does not expose it" };
            }
            if (!_can) return { ok: false, error: "property '" + _node.name + "' cannot take an alternate source" };
            _node.setAlternateSource(_item);
            return { ok: true, property: _node.name, source: _item.name };
        `;
  },
});

registerOp({
  name: "egp.add_layer",
  category: "egp",
  description:
    "Expose a whole LAYER in a comp's Essential Graphics panel as a Media Replacement controller (AVLayer.addToMotionGraphicsTemplate, AE 18.0+). For single properties use egp.add_property.",
  params: [
    { name: "comp", type: "any", description: "Comp containing the layer", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "masterComp",
      type: "any",
      description: "Template master comp (default: same as comp)",
      required: false,
    },
    {
      name: "controllerName",
      type: "string",
      description: "Display name in the Essential Graphics panel (default: layer name)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _masterArg = ${jsxVal(args.masterComp ?? null)};
            var _master = _masterArg === null ? _comp : AE.findCompByNameOrId(_masterArg);
            if (!_master) return { ok: false, error: "no master comp matching " + String(_masterArg) };
            if (typeof _layer.addToMotionGraphicsTemplate !== "function") {
                return { ok: false, error: "addToMotionGraphicsTemplate needs AE 18.0+" };
            }
            var _can = false;
            try { _can = _layer.canAddToMotionGraphicsTemplate(_master); } catch (eCan) {}
            if (!_can) return { ok: false, error: "layer '" + _layer.name + "' cannot be added to the Essential Graphics panel of '" + _master.name + "' — only AVLayers with footage/comp sources qualify for media replacement" };
            var _name = ${jsxVal(args.controllerName ?? null)};
            try {
                if (_name !== null && typeof _layer.addToMotionGraphicsTemplateAs === "function") {
                    _layer.addToMotionGraphicsTemplateAs(_master, _name);
                } else {
                    _layer.addToMotionGraphicsTemplate(_master);
                }
            } catch (eAdd) { return { ok: false, error: "addToMotionGraphicsTemplate failed: " + AE.errText(eAdd) }; }
            var _count = null;
            try { _count = _master.motionGraphicsTemplateControllerCount; } catch (eCnt) {}
            return { ok: true, layer: _layer.name, masterComp: _master.name, controllerCount: _count };
        `;
  },
});
