// Advanced layer operations — track matte, blend mode, split, copy.

import { registerOp, jsxVal, jsxCompLayerPreamble } from "../registry.js";

registerOp({
  name: "layer.bounds",
  category: "layer",
  readOnly: true,
  description:
    "Measure a layer's rendered bounds via sourceRectAtTime — essential for aligning/fitting text and shape layers. Returns layer-space rect and, when the host supports it, comp-space corners.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "time",
      type: "number",
      description: "Time in seconds (default: current comp time)",
      required: false,
    },
    {
      name: "includeExtents",
      type: "boolean",
      description: "Include pixel extents beyond the layer edges (default false)",
      required: false,
      default: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            if (typeof _layer.sourceRectAtTime !== "function") return { ok: false, error: "layer has no sourceRectAtTime (camera/light?)" };
            var _t = ${jsxVal(args.time ?? null)};
            if (_t === null) _t = _comp.time;
            var _r = _layer.sourceRectAtTime(_t, ${jsxVal(args.includeExtents ?? false)});
            var _out = { ok: true, time: _t, layerSpace: { top: _r.top, left: _r.left, width: _r.width, height: _r.height } };
            // Comp-space corners via sourcePointToComp (AE 13.2+; meaningful for
            // text layers — reflects the first character at the current comp
            // time). The function evaluates at the current time, so nudge and restore.
            try {
                if (typeof _layer.sourcePointToComp === "function") {
                    var _prevT = _comp.time;
                    // finally, not a trailing assignment: sourcePointToComp is
                    // documented for text layers and can throw on others, and
                    // this op is readOnly — leaving the playhead moved would be
                    // a visible edit made by a read-only call.
                    try {
                        _comp.time = _t;
                        _out.compSpace = {
                            topLeft: AE.valueToJson(_layer.sourcePointToComp([_r.left, _r.top])),
                            topRight: AE.valueToJson(_layer.sourcePointToComp([_r.left + _r.width, _r.top])),
                            bottomLeft: AE.valueToJson(_layer.sourcePointToComp([_r.left, _r.top + _r.height])),
                            bottomRight: AE.valueToJson(_layer.sourcePointToComp([_r.left + _r.width, _r.top + _r.height]))
                        };
                    } finally {
                        _comp.time = _prevT;
                    }
                }
            } catch (eSp) {}
            return _out;
        `;
  },
});

registerOp({
  name: "layer.convert_point",
  category: "layer",
  readOnly: true,
  description:
    "Convert a point between layer source space and comp space (sourcePointToComp / compPointToSource, AE 13.2+; designed for text layers — evaluates at the first character at the given time).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "direction",
      type: "string",
      description: "sourceToComp|compToSource",
      required: true,
    },
    { name: "point", type: "array", description: "[x, y] point to convert", required: true },
    {
      name: "time",
      type: "number",
      description: "Evaluate at this time (default: current comp time)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _toComp = ${jsxVal(args.direction)} === "sourceToComp";
            var _fn = _toComp ? _layer.sourcePointToComp : _layer.compPointToSource;
            if (typeof _fn !== "function") return { ok: false, error: "point conversion unavailable on this layer (text layers, AE 13.2+)" };
            var _t = ${jsxVal(args.time ?? null)};
            var _prevT = _comp.time;
            if (_t !== null) _comp.time = _t;
            var _res;
            try {
                _res = _toComp ? _layer.sourcePointToComp(${jsxVal(args.point)}) : _layer.compPointToSource(${jsxVal(args.point)});
            } catch (eCv) {
                _comp.time = _prevT;
                return { ok: false, error: "conversion failed: " + AE.errText(eCv) };
            }
            if (_t !== null) _comp.time = _prevT;
            return { ok: true, point: AE.valueToJson(_res) };
        `;
  },
});

registerOp({
  name: "layer.apply_preset",
  category: "layer",
  description:
    "Apply an animation preset (.ffx file) to a layer — applies effects/keyframes in one call.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "path",
      type: "string",
      description: "Absolute path to the .ffx preset",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _f = new File(${jsxVal(args.path)});
            if (!_f.exists) return { ok: false, error: "preset file not found: " + ${jsxVal(args.path)} };
            // applyPreset can target the comp's selected layers (e.g. presets that
            // create layers), so pin the selection to the target layer first —
            // then put the user's selection back. "selected" is a real
            // addressing mode elsewhere in this registry and is reported in the
            // ambient context, so leaving it rewritten would silently retarget
            // later operations in the same batch. Layer references, not
            // indices: a preset may insert layers and shift every index.
            var _prevSel = [];
            for (var _si = 1; _si <= _comp.numLayers; _si++) {
                var _sl = _comp.layer(_si);
                if (_sl.selected) _prevSel.push(_sl);
                _sl.selected = false;
            }
            _layer.selected = true;
            try {
                _layer.applyPreset(_f);
            } finally {
                for (var _di = 1; _di <= _comp.numLayers; _di++) {
                    try { _comp.layer(_di).selected = false; } catch (eDs) {}
                }
                for (var _ri = 0; _ri < _prevSel.length; _ri++) {
                    try { _prevSel[_ri].selected = true; } catch (eRs) {}
                }
            }
            var _fx = 0;
            try { _fx = _layer.property("Effects").numProperties; } catch (eFx) {}
            return { ok: true, applied: _f.displayName, numEffects: _fx };
        `;
  },
});

registerOp({
  name: "layer.replace_source",
  category: "layer",
  description:
    "Replace a layer's source with another project item (footage or comp), keeping keyframes/effects. Set fixExpressions=false to skip expression rewriting.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "item",
      type: "any",
      description: "New source: project item id (number) or name (string)",
      required: true,
    },
    {
      name: "fixExpressions",
      type: "boolean",
      description: "Rewrite expressions that reference the old source (default true)",
      required: false,
      default: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            if (!(_layer instanceof AVLayer)) return { ok: false, error: "layer has no source (not an AVLayer)" };
            var _item = AE.findItem(${jsxVal(args.item)});
            if (!_item) return { ok: false, error: "no project item matching " + ${jsxVal(String(args.item))} };
            if (_item instanceof FolderItem) return { ok: false, error: "item is a folder, not footage/comp" };
            _layer.replaceSource(_item, ${jsxVal(args.fixExpressions !== false)});
            return { ok: true, layer: _layer.name, source: _item.name };
        `;
  },
});

registerOp({
  name: "layer.set_track_matte",
  category: "layer",
  description:
    "Set (or remove) a track matte on a layer. Uses AVLayer.setTrackMatte (AE 23.0+): the matte can be ANY layer in the comp — it does not need to sit directly above the target.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based index (or name) of the layer to apply matte TO",
      required: true,
    },
    {
      name: "matteLayer",
      type: "any",
      description: "Matte source layer: 1-based index or name. Ignored when matteType is 'none'.",
      required: false,
    },
    {
      name: "matteType",
      type: "string",
      description: "alpha|alphaInverted|luma|lumaInverted|none",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _matteMap = {
                "alpha": TrackMatteType.ALPHA,
                "alphaInverted": TrackMatteType.ALPHA_INVERTED,
                "luma": TrackMatteType.LUMA,
                "lumaInverted": TrackMatteType.LUMA_INVERTED,
                "none": TrackMatteType.NO_TRACK_MATTE
            };
            var _type = _matteMap[${jsxVal(args.matteType)}];
            if (!_type && ${jsxVal(args.matteType)} !== "none") return { ok: false, error: "unknown matteType" };
            if (${jsxVal(args.matteType)} === "none") {
                _layer.removeTrackMatte();
                return { ok: true, layer: _layer.name, matte: null };
            }
            var _matte = AE.findLayerInComp(_comp, ${jsxVal(args.matteLayer)});
            if (!_matte) return { ok: false, error: "no matte layer matching " + ${jsxVal(String(args.matteLayer))} };
            if (_matte === _layer) return { ok: false, error: "a layer cannot be its own track matte" };
            _layer.setTrackMatte(_matte, _type);
            return { ok: true, layer: _layer.name, matte: _matte.name };
        `;
  },
});

registerOp({
  name: "layer.set_blend_mode",
  category: "layer",
  description: "Set blending mode on a layer.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "mode",
      type: "string",
      description:
        "normal|add|multiply|screen|overlay|softLight|hardLight|difference|exclusion|colorDodge|colorBurn|darken|lighten|stencilAlpha|stencilLuma|silhouetteAlpha|silhouetteLuma",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _modeMap = {
                "normal": BlendingMode.NORMAL, "add": BlendingMode.ADD,
                "multiply": BlendingMode.MULTIPLY, "screen": BlendingMode.SCREEN,
                "overlay": BlendingMode.OVERLAY, "softLight": BlendingMode.SOFT_LIGHT,
                "hardLight": BlendingMode.HARD_LIGHT, "difference": BlendingMode.DIFFERENCE,
                "exclusion": BlendingMode.EXCLUSION, "colorDodge": BlendingMode.COLOR_DODGE,
                "colorBurn": BlendingMode.COLOR_BURN, "darken": BlendingMode.DARKEN,
                "lighten": BlendingMode.LIGHTEN, "stencilAlpha": BlendingMode.STENCIL_ALPHA,
                "stencilLuma": BlendingMode.STENCIL_LUMA,
                "silhouetteAlpha": BlendingMode.SILHOUETTE_ALPHA,
                "silhouetteLuma": BlendingMode.SILHOUETTE_LUMA
            };
            var _mode = _modeMap[${jsxVal(args.mode)}];
            if (!_mode) return { ok: false, error: "unknown blend mode: " + ${jsxVal(args.mode)} };
            _layer.blendingMode = _mode;
            return { ok: true, layer: _layer.name, mode: ${jsxVal(args.mode)} };
        `;
  },
});

registerOp({
  name: "layer.split",
  category: "layer",
  description: "Split a layer at a given time. Creates a new layer that starts at the split time.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "time", type: "number", description: "Time in seconds to split at", required: true },
  ],
  toJsx(args) {
    // Layer.splitLayer() does not exist in the AE scripting DOM; emulate the
    // Edit > Split Layer command via duplicate + trim. duplicate() inserts the
    // copy directly above the original, so the later half ends up on top —
    // matching the native command's behavior.
    return `
            ${jsxCompLayerPreamble(args)}
            var _t = ${jsxVal(args.time)};
            if (typeof _t !== "number") return { ok: false, error: "time must be a number" };
            if (_t <= _layer.inPoint || _t >= _layer.outPoint) {
                return { ok: false, error: "split time " + _t + " is outside the layer's span (" + _layer.inPoint + ", " + _layer.outPoint + ")" };
            }
            var _dup = _layer.duplicate();
            _layer.outPoint = _t;
            _dup.inPoint = _t;
            return { ok: true, originalIndex: _layer.index, newIndex: _dup.index, splitTime: _t };
        `;
  },
});

registerOp({
  name: "layer.copy_to_comp",
  category: "layer",
  description: "Copy a layer from one comp to another.",
  params: [
    { name: "comp", type: "any", description: "Source comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index (or name) in source comp",
      required: true,
    },
    { name: "targetComp", type: "any", description: "Target comp name or id", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _target = AE.findCompByNameOrId(${jsxVal(args.targetComp)});
            if (!_target) return { ok: false, error: "target comp not found" };
            var _before = _target.numLayers;
            _layer.copyToComp(_target);
            if (_target.numLayers !== _before + 1) {
                return { ok: false, error: "copyToComp did not add a layer to " + _target.name };
            }
            var _newLayer = _target.layer(1);
            return { ok: true, copied: _layer.name, targetComp: _target.name, newIndex: _newLayer.index, newName: _newLayer.name };
        `;
  },
});
