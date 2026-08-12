// Keyframe operations — add, remove, set easing.

import { registerOp, jsxVal, jsxCompLayerPreamble, jsxPropertyLookup } from "../registry.js";

registerOp({
  name: "keyframe.add",
  category: "keyframe",
  description: "Add a keyframe at a specific time with a value.",
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
      description: 'Property path, e.g. ["Transform","Position"]',
      required: true,
    },
    { name: "time", type: "number", description: "Time in seconds", required: true },
    { name: "value", type: "any", description: "Value at this keyframe", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            _node.setValueAtTime(${jsxVal(args.time)}, ${jsxVal(args.value)});
            return { ok: true, numKeys: _node.numKeys, name: _node.name };
        `;
  },
});

registerOp({
  name: "keyframe.remove",
  category: "keyframe",
  description: "Remove a keyframe by its 1-based index.",
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
      name: "keyIndex",
      type: "number",
      description: "1-based keyframe index to remove",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            if (${jsxVal(args.keyIndex)} < 1 || ${jsxVal(args.keyIndex)} > _node.numKeys) return { ok: false, error: "key index out of range" };
            _node.removeKey(${jsxVal(args.keyIndex)});
            return { ok: true, numKeys: _node.numKeys };
        `;
  },
});

registerOp({
  name: "keyframe.set_easing",
  category: "keyframe",
  description:
    "Apply easing to a keyframe. Preset: 'linear', 'ease', 'easeIn', 'easeOut', 'hold'. Or custom bezier with inSpeed/outSpeed/inInfluence/outInfluence.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
    { name: "keyIndex", type: "number", description: "1-based keyframe index", required: true },
    {
      name: "preset",
      type: "string",
      description: "linear|ease|easeIn|easeOut|hold (overrides custom params)",
      required: false,
    },
    { name: "inSpeed", type: "number", description: "Custom in speed", required: false },
    { name: "outSpeed", type: "number", description: "Custom out speed", required: false },
    {
      name: "inInfluence",
      type: "number",
      description: "Custom in influence (0-100)",
      required: false,
      default: 33,
    },
    {
      name: "outInfluence",
      type: "number",
      description: "Custom out influence (0-100)",
      required: false,
      default: 33,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            var _ki = ${jsxVal(args.keyIndex)};
            if (_ki < 1 || _ki > _node.numKeys) return { ok: false, error: "key index out of range" };
            var _preset = ${jsxVal(args.preset ?? null)};
            // setTemporalEaseAtKey requires exactly ONE KeyframeEase for spatial
            // properties (Position/Anchor Point), regardless of value dimensions.
            var _dims = 1;
            var _spatial = false;
            try {
                var _pvt = _node.propertyValueType;
                if (_pvt === PropertyValueType.TwoD_SPATIAL || _pvt === PropertyValueType.ThreeD_SPATIAL) _spatial = true;
            } catch(ePvt) {}
            if (!_spatial) {
                try { var _v = _node.keyValue(_ki); if (_v && _v.length) _dims = _v.length; } catch(e) {}
            }
            function _makeEase(speed, influence) {
                var arr = [];
                for (var d = 0; d < _dims; d++) arr.push(new KeyframeEase(speed, influence));
                return arr;
            }
            if (_preset === "linear") {
                _node.setInterpolationTypeAtKey(_ki, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            } else if (_preset === "hold") {
                _node.setInterpolationTypeAtKey(_ki, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD);
            } else if (_preset === "ease") {
                _node.setTemporalEaseAtKey(_ki, _makeEase(0, 33), _makeEase(0, 33));
                _node.setInterpolationTypeAtKey(_ki, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
            } else if (_preset === "easeIn") {
                _node.setTemporalEaseAtKey(_ki, _makeEase(0, 75), _makeEase(0, 33));
                _node.setInterpolationTypeAtKey(_ki, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
            } else if (_preset === "easeOut") {
                _node.setTemporalEaseAtKey(_ki, _makeEase(0, 33), _makeEase(0, 75));
                _node.setInterpolationTypeAtKey(_ki, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
            } else {
                var _inS = ${jsxVal(args.inSpeed ?? 0)};
                var _outS = ${jsxVal(args.outSpeed ?? 0)};
                var _inI = ${jsxVal(args.inInfluence ?? 33)};
                var _outI = ${jsxVal(args.outInfluence ?? 33)};
                _node.setTemporalEaseAtKey(_ki, _makeEase(_inS, _inI), _makeEase(_outS, _outI));
                _node.setInterpolationTypeAtKey(_ki, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
            }
            return { ok: true, keyIndex: _ki, interpolation: "applied" };
        `;
  },
});

registerOp({
  name: "keyframe.set_batch",
  category: "keyframe",
  description:
    "Set many keyframes on one property in a single call (Property.setValuesAtTimes). times and values must have the same length.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
    { name: "times", type: "array", description: "Times in seconds", required: true },
    {
      name: "values",
      type: "array",
      description: "Values, one per time (same order)",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            var _times = ${jsxVal(args.times)};
            var _values = ${jsxVal(args.values)};
            if (_times.length === 0) return { ok: false, error: "times is empty" };
            if (_times.length !== _values.length) return { ok: false, error: "times (" + _times.length + ") and values (" + _values.length + ") must have the same length" };
            _node.setValuesAtTimes(_times, _values);
            return { ok: true, added: _times.length, numKeys: _node.numKeys };
        `;
  },
});

registerOp({
  name: "keyframe.shift",
  category: "keyframe",
  description:
    "Retime all keyframes on a property: newTime = (time - pivot) * scale + pivot + offset. Preserves interpolation, ease, and spatial tangents best-effort.",
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
      name: "offset",
      type: "number",
      description: "Seconds to shift by (default 0)",
      required: false,
      default: 0,
    },
    {
      name: "scale",
      type: "number",
      description: "Time scale factor around pivot (default 1)",
      required: false,
      default: 1,
    },
    {
      name: "pivot",
      type: "number",
      description: "Pivot time in seconds for scaling (default 0)",
      required: false,
      default: 0,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            if (!_node.numKeys || _node.numKeys === 0) return { ok: false, error: "property has no keyframes" };
            var _offset = ${jsxVal(args.offset ?? 0)};
            var _scale = ${jsxVal(args.scale ?? 1)};
            var _pivot = ${jsxVal(args.pivot ?? 0)};
            if (_scale === 0) return { ok: false, error: "scale must be non-zero" };
            var _keys = AE.snapshotKeys(_node);
            for (var _i = 0; _i < _keys.length; _i++) {
                _keys[_i].time = (_keys[_i].time - _pivot) * _scale + _pivot + _offset;
            }
            // Validate the whole target layout BEFORE removeAllKeys destroys
            // the current one. addKey inside applyKeys can throw (negative
            // time, collapsed times), and a throw after the removal leaves the
            // property stripped and half-rebuilt — an error result handed back
            // on top of a damaged project, which the dispatcher does not roll
            // back.
            var _times = [];
            for (var _v = 0; _v < _keys.length; _v++) {
                var _tv = _keys[_v].time;
                if (!isFinite(_tv)) return { ok: false, error: "shift produces a non-finite key time — check offset/scale/pivot" };
                if (_tv < 0) return { ok: false, error: "shift moves a key to " + _tv + "s; key times cannot be negative" };
                _times.push(_tv);
            }
            _times.sort(function (a, b) { return a - b; });
            for (var _d = 1; _d < _times.length; _d++) {
                if (_times[_d] - _times[_d - 1] < 1e-6) return { ok: false, error: "shift collapses two keys onto " + _times[_d] + "s; use a larger scale, or keyframe.set_batch to author the result directly" };
            }
            AE.removeAllKeys(_node);
            AE.applyKeys(_node, _keys);
            return { ok: true, numKeys: _node.numKeys, firstKeyTime: _node.keyTime(1), lastKeyTime: _node.keyTime(_node.numKeys) };
        `;
  },
});

registerOp({
  name: "keyframe.copy",
  category: "keyframe",
  description:
    "Copy all keyframes from one property to another (same or different layer/comp). Value types must be compatible. Existing target keys are kept.",
  params: [
    { name: "comp", type: "any", description: "Source comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "Source layer (1-based index or name)",
      required: true,
    },
    { name: "property", type: "array", description: "Source property path", required: true },
    {
      name: "targetComp",
      type: "any",
      description: "Target comp (default: same as source)",
      required: false,
    },
    {
      name: "targetLayer",
      type: "any",
      description: "Target layer (1-based index or name)",
      required: true,
    },
    {
      name: "targetProperty",
      type: "array",
      description: "Target property path (default: same as source)",
      required: false,
    },
    {
      name: "timeOffset",
      type: "number",
      description: "Seconds to add to every copied key time (default 0)",
      required: false,
      default: 0,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            if (!_node.numKeys || _node.numKeys === 0) return { ok: false, error: "source property has no keyframes" };
            var _keys = AE.snapshotKeys(_node);
            var _tcArg = ${jsxVal(args.targetComp ?? null)};
            var _tComp = (_tcArg === null) ? _comp : AE.findCompByNameOrId(_tcArg);
            if (!_tComp) return { ok: false, error: "no target comp matching " + _tcArg };
            var _tLayer = AE.findLayerInComp(_tComp, ${jsxVal(args.targetLayer)});
            if (!_tLayer) return { ok: false, error: "no target layer matching " + ${jsxVal(String(args.targetLayer))} };
            var _tPath = ${jsxVal(args.targetProperty ?? null)} || _propPath;
            var _tNode = _tLayer;
            for (var _ti = 0; _ti < _tPath.length; _ti++) {
                var _tNext = null;
                try { _tNext = _tNode.property(_tPath[_ti]); } catch (eTp) {}
                if (!_tNext) return { ok: false, error: "target property segment '" + _tPath[_ti] + "' not found at depth " + _ti };
                _tNode = _tNext;
            }
            var _off = ${jsxVal(args.timeOffset ?? 0)};
            for (var _i = 0; _i < _keys.length; _i++) _keys[_i].time += _off;
            for (var _n = 0; _n < _keys.length; _n++) {
                if (!isFinite(_keys[_n].time) || _keys[_n].time < 0) return { ok: false, error: "timeOffset moves a key to " + _keys[_n].time + "s; key times cannot be negative" };
            }
            // A copied time landing on a key the target already has replaces it
            // rather than adding one, so report what was actually created.
            var _added = AE.applyKeys(_tNode, _keys);
            return { ok: true, copied: _added, sourceKeys: _keys.length, targetNumKeys: _tNode.numKeys };
        `;
  },
});

registerOp({
  name: "keyframe.set_spatial",
  category: "keyframe",
  description:
    "Set spatial tangents / continuity on a keyframe of a spatial property (Position, Anchor Point). Tangents are [x,y] or [x,y,z] offsets.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
    { name: "keyIndex", type: "number", description: "1-based keyframe index", required: true },
    {
      name: "inTangent",
      type: "array",
      description: "Incoming spatial tangent (default: keep current)",
      required: false,
    },
    {
      name: "outTangent",
      type: "array",
      description: "Outgoing spatial tangent (default: keep current)",
      required: false,
    },
    {
      name: "continuous",
      type: "boolean",
      description: "Spatial continuity flag",
      required: false,
    },
    {
      name: "autoBezier",
      type: "boolean",
      description: "Spatial auto-bezier flag",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            if (!_node.isSpatial) return { ok: false, error: "property is not spatial" };
            var _ki = ${jsxVal(args.keyIndex)};
            if (_ki < 1 || _ki > _node.numKeys) return { ok: false, error: "key index out of range" };
            var _inT = ${jsxVal(args.inTangent ?? null)};
            var _outT = ${jsxVal(args.outTangent ?? null)};
            if (_inT !== null || _outT !== null) {
                if (_inT === null) _inT = _node.keyInSpatialTangent(_ki);
                if (_outT === null) _outT = _node.keyOutSpatialTangent(_ki);
                _node.setSpatialTangentsAtKey(_ki, _inT, _outT);
            }
            var _cont = ${jsxVal(args.continuous ?? null)};
            if (_cont !== null) _node.setSpatialContinuousAtKey(_ki, _cont);
            var _autoB = ${jsxVal(args.autoBezier ?? null)};
            if (_autoB !== null) _node.setSpatialAutoBezierAtKey(_ki, _autoB);
            return { ok: true, keyIndex: _ki };
        `;
  },
});

registerOp({
  name: "keyframe.set_roving",
  category: "keyframe",
  description:
    "Set a keyframe to rove across time (smooth speed on a spatial path). First and last keyframes cannot rove.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
    { name: "keyIndex", type: "number", description: "1-based keyframe index", required: true },
    { name: "roving", type: "boolean", description: "true=roving, false=fixed", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            var _ki = ${jsxVal(args.keyIndex)};
            if (_ki < 1 || _ki > _node.numKeys) return { ok: false, error: "key index out of range" };
            if (_ki === 1 || _ki === _node.numKeys) return { ok: false, error: "first and last keyframes cannot rove" };
            _node.setRovingAtKey(_ki, ${jsxVal(!!args.roving)});
            return { ok: true, keyIndex: _ki, roving: _node.keyRoving(_ki) };
        `;
  },
});

registerOp({
  name: "keyframe.set_value",
  category: "keyframe",
  description: "Change the value of an existing keyframe without changing its time.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
    { name: "keyIndex", type: "number", description: "1-based keyframe index", required: true },
    { name: "value", type: "any", description: "New value", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            _node.setValueAtKey(${jsxVal(args.keyIndex)}, ${jsxVal(args.value)});
            return { ok: true, keyIndex: ${jsxVal(args.keyIndex)} };
        `;
  },
});

registerOp({
  name: "keyframe.set_interpolation",
  category: "keyframe",
  description:
    "Set a keyframe's in/out interpolation types directly (linear|bezier|hold — asymmetric combinations allowed, e.g. bezier in / hold out), and the temporal continuous / auto-bezier flags. For speed/influence curves use keyframe.set_easing.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
    { name: "keyIndex", type: "number", description: "1-based keyframe index", required: true },
    {
      name: "inType",
      type: "string",
      description: "linear|bezier|hold (default: keep current)",
      required: false,
    },
    {
      name: "outType",
      type: "string",
      description: "linear|bezier|hold (default: keep current)",
      required: false,
    },
    {
      name: "temporalContinuous",
      type: "boolean",
      description: "Temporal continuity flag",
      required: false,
    },
    {
      name: "temporalAutoBezier",
      type: "boolean",
      description: "Temporal auto-bezier flag (true also enables continuity)",
      required: false,
    },
  ],
  toJsx(args) {
    const flagSets: string[] = [];
    // Continuity before auto-bezier: enabling auto-bezier also enables
    // continuity in AE, so the opposite order would clobber an explicit
    // temporalContinuous: false.
    if (args.temporalContinuous !== undefined)
      flagSets.push(
        `try { _node.setTemporalContinuousAtKey(_ki, ${jsxVal(args.temporalContinuous)}); } catch (eTc) { _w.push("temporalContinuous: " + AE.errText(eTc)); }`,
      );
    if (args.temporalAutoBezier !== undefined)
      flagSets.push(
        `try { _node.setTemporalAutoBezierAtKey(_ki, ${jsxVal(args.temporalAutoBezier)}); } catch (eTb) { _w.push("temporalAutoBezier: " + AE.errText(eTb)); }`,
      );
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            var _ki = ${jsxVal(args.keyIndex)};
            if (_ki < 1 || _ki > _node.numKeys) return { ok: false, error: "key index out of range" };
            var _w = [];
            var _itMap = { "linear": KeyframeInterpolationType.LINEAR, "bezier": KeyframeInterpolationType.BEZIER, "hold": KeyframeInterpolationType.HOLD };
            var _inArg = ${jsxVal(args.inType ?? null)};
            var _outArg = ${jsxVal(args.outType ?? null)};
            if (_inArg !== null || _outArg !== null) {
                if (_inArg !== null && !_itMap.hasOwnProperty(_inArg)) return { ok: false, error: "inType must be linear|bezier|hold" };
                if (_outArg !== null && !_itMap.hasOwnProperty(_outArg)) return { ok: false, error: "outType must be linear|bezier|hold" };
                var _in = _inArg !== null ? _itMap[_inArg] : _node.keyInInterpolationType(_ki);
                var _out = _outArg !== null ? _itMap[_outArg] : _node.keyOutInterpolationType(_ki);
                if (!_node.isInterpolationTypeValid(_in) || !_node.isInterpolationTypeValid(_out)) {
                    return { ok: false, error: "interpolation type not valid for this property" };
                }
                try { _node.setInterpolationTypeAtKey(_ki, _in, _out); } catch (eIt) { return { ok: false, error: "setInterpolationTypeAtKey failed: " + AE.errText(eIt) }; }
            }
            ${flagSets.join("\n")}
            function _itName(v) {
                if (v === KeyframeInterpolationType.LINEAR) return "linear";
                if (v === KeyframeInterpolationType.BEZIER) return "bezier";
                if (v === KeyframeInterpolationType.HOLD) return "hold";
                return null;
            }
            return {
                ok: true,
                keyIndex: _ki,
                inType: _itName(_node.keyInInterpolationType(_ki)),
                outType: _itName(_node.keyOutInterpolationType(_ki)),
                temporalContinuous: AE.safeGet(function () { return _node.keyTemporalContinuous(_ki); }, null),
                temporalAutoBezier: AE.safeGet(function () { return _node.keyTemporalAutoBezier(_ki); }, null),
                warnings: _w
            };
        `;
  },
});

registerOp({
  name: "keyframe.set_label",
  category: "keyframe",
  description: "Set a keyframe's label color (Property.setLabelAtKey, AE 22.6+).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "property", type: "array", description: "Property path", required: true },
    { name: "keyIndex", type: "number", description: "1-based keyframe index", required: true },
    {
      name: "label",
      type: "number",
      description: "Label color index 0-16 (0 = none)",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _propPath = ${jsxVal(args.property)};
            ${jsxPropertyLookup()}
            var _ki = ${jsxVal(args.keyIndex)};
            if (_ki < 1 || _ki > _node.numKeys) return { ok: false, error: "key index out of range" };
            if (typeof _node.setLabelAtKey !== "function") return { ok: false, error: "setLabelAtKey needs AE 22.6+" };
            try { _node.setLabelAtKey(_ki, ${jsxVal(args.label)}); } catch (eLb) { return { ok: false, error: "setLabelAtKey failed: " + AE.errText(eLb) }; }
            return { ok: true, keyIndex: _ki, label: _node.keyLabel(_ki) };
        `;
  },
});
