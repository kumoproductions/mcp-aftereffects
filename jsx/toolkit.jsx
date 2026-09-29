// mcp-aftereffects toolkit — higher-level building blocks shared by the
// composite operations (keyframe.apply, layer.set_anchor, comp.resize,
// shape.group_bounds, mask geometry, layer.split_groups, …) and available to
// eval.run. Included by dispatcher.jsx AFTER helpers.jsx and import.jsx: it
// relies on AE.unwrapValue from import.jsx. ES3 only — var, function(), for.

var AE = AE || {};

// ---------- Separated dimensions ----------

// The follower properties that hold the data of a separated property, or
// null when the property is not separated. After "Separate Dimensions" — and
// on layers produced by "Create Shapes from Vector Layer", which can
// arrive separated — the leader (ADBE Position) rejects setValue with an error AE
// never displays; X/Y/Z Position own the values and keys. Every write in this
// file and in the generated operations goes through this check so a caller
// never has to know which shape the property is in.
AE.separationFollowers = function (prop) {
    var sep = false;
    try { sep = prop.dimensionsSeparated === true; } catch (eSep) { return null; }
    if (!sep) return null;
    // A 2D layer's separated Position still reports a 3-component,
    // ThreeD_SPATIAL value and hands out a Z follower — which is HIDDEN, and
    // setValue on it throws ("the property or a parent property is hidden").
    // Only the owning layer's 3D switch says whether Z is live (verified on
    // AE 26.3: neither the value length nor propertyValueType does).
    var n = 3;
    var owner = AE.ownerLayer(prop);
    if (owner && !(owner instanceof CameraLayer) && !(owner instanceof LightLayer)) {
        var is3d = false;
        try { is3d = owner.threeDLayer === true; } catch (e3d) {}
        n = is3d ? 3 : 2;
    }
    var out = [];
    for (var d = 0; d < n; d++) {
        var f = null;
        try { f = prop.getSeparationFollower(d); } catch (eF) {}
        if (f) out.push(f);
    }
    return out.length > 0 ? out : null;
};

// The layer a property belongs to (propertyDepth levels up), or null.
AE.ownerLayer = function (prop) {
    try {
        var depth = prop.propertyDepth;
        if (!depth || depth < 1) return null;
        var root = prop.propertyGroup(depth);
        return (root && root.containingComp) ? root : null;
    } catch (eOwn) { return null; }
};

// Native value for a JSON value: __kind-tagged objects (Shape, TextDocument,
// MarkerValue — the export format) become their ExtendScript twins; plain
// numbers/arrays pass through. `prop` supplies the TextDocument template.
AE.nativeValue = function (prop, value) {
    if (value === null || value === undefined) return value;
    if (typeof value === "object" && typeof value.__kind === "string") {
        var tmpl = null;
        if (value.__kind === "TextDocument") tmpl = AE.safeGet(function () { return prop.value; }, null);
        return AE.unwrapValue(value, tmpl);
    }
    return value;
};

// Component `d` of a value destined for one of `count` followers.
AE._componentFor = function (value, d, count) {
    if (count <= 1) return value;
    if (value && value.length !== undefined) return value[d];
    return value;
};

// Set a property's value — or a key at `time` — separated-dimension safe and
// __kind aware. Returns how many properties were written.
AE.writeValue = function (prop, value, time) {
    var followers = AE.separationFollowers(prop);
    var v = AE.nativeValue(prop, value);
    var targets = followers ? followers : [prop];
    for (var i = 0; i < targets.length; i++) {
        var part = AE._componentFor(v, i, targets.length);
        if (time === undefined || time === null) targets[i].setValue(part);
        else targets[i].setValueAtTime(time, part);
    }
    return { separated: followers !== null, targets: targets.length };
};

// Read a value (at `time` when given, post-expression), separated-safe: the
// followers are gathered back into one array.
AE.readValue = function (prop, time) {
    var followers = AE.separationFollowers(prop);
    var hasTime = (time !== undefined && time !== null);
    if (!followers) return hasTime ? prop.valueAtTime(time, false) : prop.value;
    var out = [];
    for (var i = 0; i < followers.length; i++) {
        out.push(hasTime ? followers[i].valueAtTime(time, false) : followers[i].value);
    }
    return out;
};

// True when the property (or any follower) carries keyframes.
AE.hasKeys = function (prop) {
    var followers = AE.separationFollowers(prop);
    var targets = followers ? followers : [prop];
    for (var i = 0; i < targets.length; i++) {
        try { if (targets[i].numKeys > 0) return true; } catch (eK) {}
    }
    return false;
};

// Add `delta` to a property: every keyframe when animated, the static value
// otherwise. `delta` is an array for multi-dimensional properties (missing
// components count as 0) and a number for scalars. Separated-dimension safe.
// Returns the number of keyframes shifted (0 for a static value).
AE.offsetValue = function (prop, delta) {
    var followers = AE.separationFollowers(prop);
    if (followers) {
        var n = 0;
        for (var d = 0; d < followers.length; d++) {
            var part = (delta && delta.length !== undefined) ? (delta[d] || 0) : delta;
            n += AE._offsetOne(followers[d], part);
        }
        return n;
    }
    return AE._offsetOne(prop, delta);
};

AE._offsetOne = function (prop, delta) {
    var isArr = (delta && delta.length !== undefined);
    function add(v) {
        if (v && v.length !== undefined) {
            var out = [];
            for (var i = 0; i < v.length; i++) {
                var dv = isArr ? (delta[i] || 0) : (i === 0 ? delta : 0);
                out.push(v[i] + dv);
            }
            return out;
        }
        return v + (isArr ? (delta[0] || 0) : delta);
    }
    if (prop.numKeys > 0) {
        for (var k = 1; k <= prop.numKeys; k++) prop.setValueAtKey(k, add(prop.keyValue(k)));
        return prop.numKeys;
    }
    prop.setValue(add(prop.value));
    return 0;
};

// Resolve a property path (array of names/matchNames/indices) below `root`.
// Returns null when any segment is missing instead of throwing.
AE.propertyAtPath = function (root, path) {
    var node = root;
    for (var i = 0; i < path.length; i++) {
        var next = null;
        try { next = node.property(path[i]); } catch (eP) {}
        if (!next) return null;
        node = next;
    }
    return node;
};

// ---------- Keyframe specs ----------

AE._interpEnum = function (name) {
    if (name === "linear") return KeyframeInterpolationType.LINEAR;
    if (name === "bezier") return KeyframeInterpolationType.BEZIER;
    if (name === "hold") return KeyframeInterpolationType.HOLD;
    return null;
};

// Apply one key spec's interpolation to key `ki` of `prop`.
//   interp: linear | ease | easeIn | easeOut | hold | bezier | keep
//   inType / outType: linear | bezier | hold (override one side)
//   inInfluence / outInfluence / inSpeed / outSpeed: custom ease numbers
// Ease is written first, then the interpolation types: setting ease flips
// BOTH sides to BEZIER, so the declared types are re-asserted afterwards.
// That is how easeIn keeps a LINEAR out side (AE's own "Easy Ease In"), and
// why 'hold' touches only the OUT side — an incoming HOLD makes the segment
// before the key evaluate to the previous key's value, which is how a
// linear fade ending in a "hold" key disappears (the trap behind
// keyframe.set_easing's symmetric 'hold' preset).
AE.applyKeyInterp = function (prop, ki, spec, fallback) {
    var name = (spec.interp !== undefined && spec.interp !== null) ? spec.interp : fallback;
    var LIN = KeyframeInterpolationType.LINEAR;
    var BEZ = KeyframeInterpolationType.BEZIER;
    var HOLD = KeyframeInterpolationType.HOLD;
    var inT = null, outT = null, ease = false;
    if (name === "linear") { inT = LIN; outT = LIN; }
    else if (name === "ease" || name === "bezier") { inT = BEZ; outT = BEZ; ease = true; }
    else if (name === "easeIn") { inT = BEZ; outT = LIN; ease = true; }
    else if (name === "easeOut") { inT = LIN; outT = BEZ; ease = true; }
    else if (name === "hold") { outT = HOLD; }
    else if (name !== undefined && name !== null && name !== "keep") {
        throw new Error("unknown interp '" + name + "' (linear|ease|easeIn|easeOut|hold|bezier|keep)");
    }
    if (spec.inType !== undefined && spec.inType !== null) {
        inT = AE._interpEnum(spec.inType);
        if (inT === null) throw new Error("inType must be linear|bezier|hold");
    }
    if (spec.outType !== undefined && spec.outType !== null) {
        outT = AE._interpEnum(spec.outType);
        if (outT === null) throw new Error("outType must be linear|bezier|hold");
    }
    var hasEaseNums = spec.inInfluence !== undefined || spec.outInfluence !== undefined ||
        spec.inSpeed !== undefined || spec.outSpeed !== undefined;
    if (hasEaseNums) ease = true;
    if (ease) {
        AE.setEase(prop, ki,
            spec.inInfluence === undefined ? 33 : spec.inInfluence,
            spec.outInfluence === undefined ? 33 : spec.outInfluence,
            spec.inSpeed === undefined ? 0 : spec.inSpeed,
            spec.outSpeed === undefined ? 0 : spec.outSpeed);
    }
    if (inT !== null || outT !== null) {
        var curIn = prop.keyInInterpolationType(ki);
        var curOut = prop.keyOutInterpolationType(ki);
        prop.setInterpolationTypeAtKey(ki, inT === null ? curIn : inT, outT === null ? curOut : outT);
    }
};

// Write a list of key specs ({ time, value, interp?, … }) to a property in
// one go: all values first, then all interpolation — writing bezier data
// while neighbours are still being inserted shifts the handles. Separated
// dimensions are handled (each follower gets its component).
// opts: { replace: drop existing keys first, interp: fallback interp,
//         spatialTangents: 'linear' zeroes the spatial tangents (straight
//         motion paths) — default leaves AE's auto-bezier }.
AE.applyKeySpecs = function (prop, specs, opts) {
    opts = opts || {};
    var followers = AE.separationFollowers(prop);
    var targets = followers ? followers : [prop];
    var warnings = [];
    var written = 0;
    for (var ti = 0; ti < targets.length; ti++) {
        var tp = targets[ti];
        if (opts.replace) AE.removeAllKeys(tp);
        var i, s;
        for (i = 0; i < specs.length; i++) {
            s = specs[i];
            var v = AE.nativeValue(tp, s.value);
            tp.setValueAtTime(s.time, AE._componentFor(v, ti, targets.length));
            written++;
        }
        for (i = 0; i < specs.length; i++) {
            s = specs[i];
            var ki = tp.nearestKeyIndex(s.time);
            try { AE.applyKeyInterp(tp, ki, s, opts.interp); }
            catch (eI) { warnings.push("key " + (i + 1) + " (t=" + s.time + "): " + AE.errText(eI)); }
        }
        if (opts.spatialTangents === "linear") {
            var spatial = false;
            try { spatial = tp.isSpatial === true; } catch (eSp) {}
            if (spatial) {
                for (i = 0; i < specs.length; i++) {
                    var kj = tp.nearestKeyIndex(specs[i].time);
                    try {
                        var dims = tp.keyValue(kj).length;
                        var zero = [];
                        for (var zd = 0; zd < dims; zd++) zero.push(0);
                        tp.setSpatialTangentsAtKey(kj, zero, zero);
                    } catch (eT) { warnings.push("spatial tangents, key " + (i + 1) + ": " + AE.errText(eT)); }
                }
            }
        }
    }
    return {
        separated: followers !== null,
        targets: targets.length,
        keysWritten: written,
        numKeys: targets[0].numKeys,
        warnings: warnings
    };
};

// Freeze every animated property below `root` at `time`: the value at that
// time becomes the static value and the keys are removed. Time Remap and
// markers are left alone. Returns the number of properties baked.
AE.bakeKeysAtTime = function (root, time) {
    var baked = 0;
    function walk(group) {
        for (var i = 1; i <= group.numProperties; i++) {
            var p = null;
            try { p = group.property(i); } catch (eG) { continue; }
            if (!p) continue;
            if (p.propertyType === PropertyType.PROPERTY) {
                if (p.matchName === "ADBE Time Remapping" || p.matchName === "ADBE Marker") continue;
                var sep = false;
                try { sep = p.dimensionsSeparated === true; } catch (eS) {}
                if (sep) continue; // the followers below carry the keys
                var n = 0;
                try { n = p.numKeys; } catch (eN) { continue; }
                if (!n) continue;
                try {
                    var v = p.valueAtTime(time, true);
                    AE.removeAllKeys(p);
                    p.setValue(v);
                    baked++;
                } catch (eB) { /* a property that cannot be frozen keeps its keys */ }
            } else {
                walk(p);
            }
        }
    }
    walk(root);
    return baked;
};

// ---------- Layer selection scope / new-layer detection ----------

// Run fn() with exactly `layers` selected in `comp`, then restore the user's
// selection. "selected" is an addressing mode elsewhere in the registry and
// is reported in the ambient context, so a menu command must not leave it
// rewritten. Layer references, not indices — commands insert layers.
AE.withSelection = function (comp, layers, fn) {
    var prev = [];
    for (var i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        if (l.selected) prev.push(l);
        l.selected = false;
    }
    for (var j = 0; j < layers.length; j++) layers[j].selected = true;
    try {
        return fn();
    } finally {
        for (var k = 1; k <= comp.numLayers; k++) { try { comp.layer(k).selected = false; } catch (eD) {} }
        for (var m = 0; m < prev.length; m++) { try { prev[m].selected = true; } catch (eR) {} }
    }
};

// Snapshot a comp's layer ids so AE.layersSince can list the layers a
// command, copyToComp or duplicate created — by identity, not by assuming
// where they landed. Pre-22 hosts (no Layer.id) fall back to "the new layers
// are the top numLayers - count", which is right for copyToComp and menu
// commands but not for duplicate().
AE.layerIdSnapshot = function (comp) {
    var ids = {};
    var hasIds = true;
    for (var i = 1; i <= comp.numLayers; i++) {
        var id = null;
        try { id = comp.layer(i).id; } catch (eId) {}
        if (id === null || id === undefined) { hasIds = false; break; }
        ids["k" + id] = true;
    }
    return { ids: ids, count: comp.numLayers, hasIds: hasIds };
};

AE.layersSince = function (comp, snap) {
    var out = [];
    var added = comp.numLayers - snap.count;
    for (var i = 1; i <= comp.numLayers; i++) {
        var l = comp.layer(i);
        if (snap.hasIds) {
            var id = null;
            try { id = l.id; } catch (eId) {}
            if (id !== null && id !== undefined && !snap.ids.hasOwnProperty("k" + id)) out.push(l);
        } else if (i <= added) {
            out.push(l);
        }
    }
    return out;
};

// Put a layer at a 1-based stacking index. Layer.moveTo does not apply to
// layers (see layer.move); reordering is only expressible relative to a
// sibling, and the sibling shifts when the layer vacates its slot.
AE.moveLayerToIndex = function (layer, to) {
    var comp = layer.containingComp;
    var from = layer.index;
    if (to < from) layer.moveBefore(comp.layer(to));
    else if (to > from) layer.moveAfter(comp.layer(to));
    return layer.index;
};

// ---------- Bounds and anchor ----------

// Where the nine anchor presets sit on a rect, as [x, y] fractions.
AE.ANCHOR_PRESETS = {
    center: [0.5, 0.5],
    topLeft: [0, 0], topCenter: [0.5, 0], topRight: [1, 0],
    centerLeft: [0, 0.5], centerRight: [1, 0.5],
    bottomLeft: [0, 1], bottomCenter: [0.5, 1], bottomRight: [1, 1]
};

// A layer's rendered rect in layer space (sourceRectAtTime), falling back to
// the source dimensions for layers without one (cameras/lights have neither).
AE.layerRect = function (layer, time) {
    try {
        if (typeof layer.sourceRectAtTime === "function") {
            var r = layer.sourceRectAtTime(time, false);
            return { left: r.left, top: r.top, width: r.width, height: r.height };
        }
    } catch (eR) {}
    var w = AE.safeGet(function () { return layer.width; }, null);
    var h = AE.safeGet(function () { return layer.height; }, null);
    if (w === null || h === null) return null;
    return { left: 0, top: 0, width: w, height: h };
};

AE.pointInRect = function (rect, preset) {
    var f = AE.ANCHOR_PRESETS.hasOwnProperty(preset) ? AE.ANCHOR_PRESETS[preset] : null;
    if (!f) return null;
    return [rect.left + rect.width * f[0], rect.top + rect.height * f[1]];
};

// Move a layer's anchor point to `target` ([x, y] or [x, y, z] in layer
// space; a null component keeps the current value) WITHOUT moving the layer
// on screen: Position shifts by the anchor delta taken through Scale and
// Rotation. Every Position key is shifted; an animated anchor is refused
// because the compensation would only hold at one instant.
AE.moveAnchor = function (layer, target) {
    var xf = layer.transform;
    var ap = xf.anchorPoint;
    var pos = xf.position;
    if (ap.numKeys > 0) throw new Error("anchor point has keyframes — bake or remove them first");
    var oldA = ap.value;
    var dims = oldA.length;
    var newA = [], delta = [];
    for (var d = 0; d < dims; d++) {
        var t = (target && target[d] !== undefined && target[d] !== null) ? target[d] : oldA[d];
        newA.push(t);
        delta.push(t - oldA[d]);
    }
    var sc = xf.scale.value;
    var s = [];
    for (d = 0; d < dims; d++) s.push(delta[d] * ((sc[d] === undefined ? 100 : sc[d]) / 100));
    var warn = [];
    var is3d = false;
    try { is3d = layer.threeDLayer === true; } catch (e3) {}
    var rotProp = xf.property("ADBE Rotate Z");
    var rotDeg = AE.safeGet(function () { return rotProp.value; }, 0);
    if (is3d) {
        var xr = AE.safeGet(function () { return xf.property("ADBE Rotate X").value; }, 0);
        var yr = AE.safeGet(function () { return xf.property("ADBE Rotate Y").value; }, 0);
        var ori = AE.safeGet(function () { return xf.property("ADBE Orientation").value; }, [0, 0, 0]);
        if (xr !== 0 || yr !== 0 || ori[0] !== 0 || ori[1] !== 0 || ori[2] !== 0) {
            warn.push("3D X/Y rotation or orientation is not compensated — verify the layer did not shift");
        }
    }
    var rad = rotDeg * Math.PI / 180;
    var w = [s[0] * Math.cos(rad) - s[1] * Math.sin(rad), s[0] * Math.sin(rad) + s[1] * Math.cos(rad)];
    if (dims > 2) w.push(s[2]);
    var animatedBasis = false;
    try { animatedBasis = xf.scale.numKeys > 0 || rotProp.numKeys > 0; } catch (eK) {}
    if (animatedBasis) warn.push("scale/rotation are animated — compensation uses their current-time value");
    ap.setValue(newA);
    var shifted = AE.offsetValue(pos, w);
    return { anchorPoint: newA, positionDelta: w, positionKeysShifted: shifted, warnings: warn };
};

// ---------- Shape contents: walking, bounds, recolor, signature ----------

// Visit every property below a Contents group (any depth), render order.
// fn(prop, depth, parentContents).
AE.walkShapeContents = function (contents, fn, depth) {
    if (depth === undefined) depth = 0;
    for (var i = 1; i <= contents.numProperties; i++) {
        var p = null;
        try { p = contents.property(i); } catch (eP) { continue; }
        if (!p) continue;
        fn(p, depth, contents);
        if (p.matchName === "ADBE Vector Group") {
            var inner = null;
            try { inner = p.property("Contents"); } catch (eI) {}
            if (inner) AE.walkShapeContents(inner, fn, depth + 1);
        }
    }
};

AE._propValueAt = function (prop, time) {
    if (time === undefined || time === null) return prop.value;
    return prop.valueAtTime(time, false);
};

// Values a cubic bezier (scalar control points) reaches: endpoints plus the
// interior extrema (roots of the derivative). Exact, so path bounds need no
// sampling.
AE._cubicExtrema = function (a, b, c, d) {
    var out = [a, d];
    var p = b - a, q = c - b, r = d - c;
    var A = p - 2 * q + r, B = 2 * (q - p), C = p;
    var roots = [];
    if (Math.abs(A) < 1e-9) {
        if (Math.abs(B) > 1e-9) roots.push(-C / B);
    } else {
        var disc = B * B - 4 * A * C;
        if (disc >= 0) {
            var sq = Math.sqrt(disc);
            roots.push((-B + sq) / (2 * A));
            roots.push((-B - sq) / (2 * A));
        }
    }
    for (var i = 0; i < roots.length; i++) {
        var t = roots[i];
        if (t <= 0 || t >= 1) continue;
        var mt = 1 - t;
        out.push(mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d);
    }
    return out;
};

// Points that bound a Shape (vertices + bezier extrema), as [x, y] pairs.
AE._pathBoundPoints = function (shape) {
    var pts = [];
    var v = shape.vertices, it = shape.inTangents, ot = shape.outTangents;
    var n = v.length;
    if (n === 0) return pts;
    var segs = shape.closed ? n : n - 1;
    for (var i = 0; i < n; i++) pts.push([v[i][0], v[i][1]]);
    for (var s = 0; s < segs; s++) {
        var a = v[s], b = v[(s + 1) % n];
        var oa = ot[s] || [0, 0], ib = it[(s + 1) % n] || [0, 0];
        if (oa[0] === 0 && oa[1] === 0 && ib[0] === 0 && ib[1] === 0) continue;
        var xs = AE._cubicExtrema(a[0], a[0] + oa[0], b[0] + ib[0], b[0]);
        var ys = AE._cubicExtrema(a[1], a[1] + oa[1], b[1] + ib[1], b[1]);
        for (var xi = 2; xi < xs.length; xi++) pts.push([xs[xi], a[1]]);
        for (var yi = 2; yi < ys.length; yi++) pts.push([a[0], ys[yi]]);
    }
    return pts;
};

// Apply a vector group's Transform (anchor → scale → rotation → position;
// skew is reported, not applied) to layer-space points.
AE._applyVectorTransform = function (pts, xfGroup, time, state) {
    if (!xfGroup) return pts;
    function val(mn, fallback) {
        try { var p = xfGroup.property(mn); return p ? AE._propValueAt(p, time) : fallback; } catch (eV) { return fallback; }
    }
    var anchor = val("ADBE Vector Anchor", [0, 0]);
    var position = val("ADBE Vector Position", [0, 0]);
    var scale = val("ADBE Vector Scale", [100, 100]);
    var rotation = val("ADBE Vector Rotation", 0);
    var skew = val("ADBE Vector Skew", 0);
    if (skew !== 0 && state) state.approximate.push("skew");
    var rad = rotation * Math.PI / 180;
    var cs = Math.cos(rad), sn = Math.sin(rad);
    var out = [];
    for (var i = 0; i < pts.length; i++) {
        var x = (pts[i][0] - anchor[0]) * scale[0] / 100;
        var y = (pts[i][1] - anchor[1]) * scale[1] / 100;
        out.push([x * cs - y * sn + position[0], x * sn + y * cs + position[1]]);
    }
    return out;
};

// Bounding points of everything inside a Contents group, in the coordinate
// space of that group (nested groups are transformed on the way up).
// `state` collects stroke widths and the modifiers whose effect on the
// bounds is not modelled (Trim/Repeater/Offset/…).
AE.contentsBoundPoints = function (contents, time, state) {
    var pts = [];
    function push(list) { for (var i = 0; i < list.length; i++) pts.push(list[i]); }
    for (var i = 1; i <= contents.numProperties; i++) {
        var p = null;
        try { p = contents.property(i); } catch (eP) { continue; }
        if (!p) continue;
        var enabled = true;
        try { enabled = p.enabled !== false; } catch (eE) {}
        if (!enabled) continue;
        var mn = p.matchName;
        try {
            if (mn === "ADBE Vector Shape - Group") {
                push(AE._pathBoundPoints(AE._propValueAt(p.property("ADBE Vector Shape"), time)));
            } else if (mn === "ADBE Vector Shape - Rect") {
                var rs = AE._propValueAt(p.property("ADBE Vector Rect Size"), time);
                var rp = AE._propValueAt(p.property("ADBE Vector Rect Position"), time);
                push([[rp[0] - rs[0] / 2, rp[1] - rs[1] / 2], [rp[0] + rs[0] / 2, rp[1] + rs[1] / 2]]);
            } else if (mn === "ADBE Vector Shape - Ellipse") {
                var es = AE._propValueAt(p.property("ADBE Vector Ellipse Size"), time);
                var ep = AE._propValueAt(p.property("ADBE Vector Ellipse Position"), time);
                push([[ep[0] - es[0] / 2, ep[1] - es[1] / 2], [ep[0] + es[0] / 2, ep[1] + es[1] / 2]]);
            } else if (mn === "ADBE Vector Shape - Star") {
                var sr = AE._propValueAt(p.property("ADBE Vector Star Outer Radius"), time);
                var sp = AE._propValueAt(p.property("ADBE Vector Star Position"), time);
                push([[sp[0] - sr, sp[1] - sr], [sp[0] + sr, sp[1] + sr]]);
                state.approximate.push("star (outer-radius circle)");
            } else if (mn === "ADBE Vector Group") {
                var inner = AE.contentsBoundPoints(p.property("Contents"), time, state);
                push(AE._applyVectorTransform(inner, p.property("ADBE Vector Transform Group"), time, state));
            } else if (mn === "ADBE Vector Graphic - Stroke" || mn === "ADBE Vector Graphic - G-Stroke") {
                var sw = AE._propValueAt(p.property("ADBE Vector Stroke Width"), time);
                if (sw > state.maxStroke) state.maxStroke = sw;
            } else if (mn.indexOf("ADBE Vector Filter") === 0) {
                state.approximate.push(p.name);
            }
        } catch (eB) { state.approximate.push(p.name + " (unreadable)"); }
    }
    return pts;
};

AE._boundsOfPoints = function (pts, pad) {
    if (pts.length === 0) return { empty: true, left: 0, top: 0, width: 0, height: 0, center: [0, 0] };
    var minX = pts[0][0], maxX = pts[0][0], minY = pts[0][1], maxY = pts[0][1];
    for (var i = 1; i < pts.length; i++) {
        if (pts[i][0] < minX) minX = pts[i][0];
        if (pts[i][0] > maxX) maxX = pts[i][0];
        if (pts[i][1] < minY) minY = pts[i][1];
        if (pts[i][1] > maxY) maxY = pts[i][1];
    }
    pad = pad || 0;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    return {
        empty: false,
        left: minX, top: minY, width: maxX - minX, height: maxY - minY,
        center: [(minX + maxX) / 2, (minY + maxY) / 2]
    };
};

// Bounds of one vector group in LAYER space (the group's own transform
// applied), stroke width padded in when opts.includeStroke. Geometry-based:
// exact for paths/rects/ellipses; stars use the outer-radius circle and
// path modifiers (Trim, Repeater, Offset, …) are listed in `approximate`.
AE.shapeGroupBounds = function (group, opts) {
    opts = opts || {};
    var state = { maxStroke: 0, approximate: [] };
    var inner = AE.contentsBoundPoints(group.property("Contents"), opts.time, state);
    var pts = AE._applyVectorTransform(inner, group.property("ADBE Vector Transform Group"), opts.time, state);
    var pad = (opts.includeStroke !== false) ? state.maxStroke / 2 : 0;
    var b = AE._boundsOfPoints(pts, pad);
    b.strokePad = pad;
    b.approximate = state.approximate;
    return b;
};

// Bounds of a whole shape layer's Contents, layer space.
AE.shapeLayerBounds = function (layer, opts) {
    opts = opts || {};
    var state = { maxStroke: 0, approximate: [] };
    var pts = AE.contentsBoundPoints(layer.property("Contents"), opts.time, state);
    var pad = (opts.includeStroke !== false) ? state.maxStroke / 2 : 0;
    var b = AE._boundsOfPoints(pts, pad);
    b.strokePad = pad;
    b.approximate = state.approximate;
    return b;
};

AE._colorClose = function (a, b, tol) {
    for (var i = 0; i < 3; i++) if (Math.abs((a[i] || 0) - (b[i] || 0)) > tol) return false;
    return true;
};

// Replace fill/stroke colors below a Contents group.
// opts: { target: 'fill'|'stroke'|'both', map: [{ from: [r,g,b], to: [r,g,b] }],
//         color: [r,g,b] (recolor everything), tolerance }
// Returns { changed, visited }.
AE.recolorContents = function (contents, opts) {
    opts = opts || {};
    var target = opts.target || "both";
    var tol = (opts.tolerance === undefined) ? 0.01 : opts.tolerance;
    var changed = 0, visited = 0;
    AE.walkShapeContents(contents, function (p) {
        var mn = p.matchName;
        var colorMn = null;
        if (mn === "ADBE Vector Graphic - Fill" && target !== "stroke") colorMn = "ADBE Vector Fill Color";
        if (mn === "ADBE Vector Graphic - Stroke" && target !== "fill") colorMn = "ADBE Vector Stroke Color";
        if (colorMn === null) return;
        var cp = null;
        try { cp = p.property(colorMn); } catch (eC) {}
        if (!cp) return;
        visited++;
        var cur = cp.value;
        var next = null;
        if (opts.color) next = opts.color;
        else if (opts.map) {
            for (var i = 0; i < opts.map.length; i++) {
                if (AE._colorClose(cur, opts.map[i].from, tol)) { next = opts.map[i].to; break; }
            }
        }
        if (next === null) return;
        var full = [next[0], next[1], next[2], (next.length > 3) ? next[3] : 1];
        try { AE.writeValue(cp, full); changed++; } catch (eW) {}
    });
    return { changed: changed, visited: visited };
};

// djb2 over a string, as 8 hex digits.
AE.hashString = function (s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    h = h >>> 0;
    var hex = h.toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return hex;
};

AE._roundJson = function (val, precision) {
    var f = Math.pow(10, precision);
    function walk(v) {
        if (typeof v === "number") return String(Math.round(v * f) / f);
        if (v === null || v === undefined) return "null";
        if (typeof v === "boolean" || typeof v === "string") return String(v);
        if (v instanceof Array || (v.length !== undefined && typeof v.length === "number")) {
            var parts = [];
            for (var i = 0; i < v.length; i++) parts.push(walk(v[i]));
            return "[" + parts.join(",") + "]";
        }
        if (v.vertices !== undefined) {
            return "S" + walk(v.closed) + walk(v.vertices) + walk(v.inTangents) + walk(v.outTangents);
        }
        return "?";
    }
    return walk(val);
};

// Canonical text for a property group: matchNames and rounded values, no
// display names — two groups drawn the same way hash the same even after
// one was renamed. Used for duplicate detection when merging comps.
AE.canonicalGroup = function (group, precision, time) {
    var parts = [];
    function walk(g) {
        for (var i = 1; i <= g.numProperties; i++) {
            var p = null;
            try { p = g.property(i); } catch (eP) { continue; }
            if (!p) continue;
            var enabled = true;
            try { enabled = p.enabled !== false; } catch (eE) {}
            if (p.propertyType === PropertyType.PROPERTY) {
                if (p.propertyValueType === PropertyValueType.NO_VALUE) continue;
                var v = null;
                try { v = AE._propValueAt(p, time); } catch (eV) { continue; }
                parts.push(p.matchName + "=" + AE._roundJson(v, precision));
            } else {
                parts.push("{" + p.matchName + (enabled ? "" : "!"));
                walk(p);
                parts.push("}");
            }
        }
    }
    walk(group);
    return parts.join(";");
};

// ---------- Mask / path geometry ----------

// Bezier circle constant: control-point distance for a quarter arc.
AE.KAPPA = 0.5522847498;

// A closed Shape for an ellipse or (rounded) rectangle. `center` and `size`
// are in the target's own space (layer space for masks). Vertices run
// clockwise in AE's y-down coordinates.
AE.geometryShape = function (kind, center, size, roundness) {
    var cx = center[0], cy = center[1];
    var w = size[0], h = size[1];
    var sh = new Shape();
    var v = [], it = [], ot = [];
    if (kind === "ellipse") {
        var rx = w / 2, ry = h / 2, kx = rx * AE.KAPPA, ky = ry * AE.KAPPA;
        v = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]];
        it = [[-kx, 0], [0, -ky], [kx, 0], [0, ky]];
        ot = [[kx, 0], [0, ky], [-kx, 0], [0, -ky]];
    } else if (kind === "rect") {
        var x0 = cx - w / 2, y0 = cy - h / 2, x1 = cx + w / 2, y1 = cy + h / 2;
        var r = roundness || 0;
        if (r > w / 2) r = w / 2;
        if (r > h / 2) r = h / 2;
        if (r <= 0) {
            v = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
            it = [[0, 0], [0, 0], [0, 0], [0, 0]];
            ot = [[0, 0], [0, 0], [0, 0], [0, 0]];
        } else {
            var k = r * AE.KAPPA;
            v = [[x0 + r, y0], [x1 - r, y0], [x1, y0 + r], [x1, y1 - r], [x1 - r, y1], [x0 + r, y1], [x0, y1 - r], [x0, y0 + r]];
            it = [[-k, 0], [0, 0], [0, -k], [0, 0], [k, 0], [0, 0], [0, k], [0, 0]];
            ot = [[0, 0], [k, 0], [0, 0], [0, k], [0, 0], [-k, 0], [0, 0], [0, -k]];
        }
    } else {
        throw new Error("shape must be ellipse|rect");
    }
    sh.vertices = v;
    sh.inTangents = it;
    sh.outTangents = ot;
    sh.closed = true;
    return sh;
};

// Default mask center for a layer: the source center for footage/solids,
// the origin for shape/text layers (whose layer space is centred on the
// anchor).
AE.defaultMaskCenter = function (layer) {
    if (layer instanceof ShapeLayer || layer instanceof TextLayer) return [0, 0];
    var w = AE.safeGet(function () { return layer.width; }, null);
    var h = AE.safeGet(function () { return layer.height; }, null);
    if (w === null || h === null) return [0, 0];
    return [w / 2, h / 2];
};

// ---------- Rendering ----------

// Apply a render-settings or output-module template by name. Template
// names are LOCALIZED ("Lossless" does not exist on a Japanese AE): exact
// name first, then case-insensitive against the target's own list. Returns
// null on success, or a warning carrying the available names.
AE.applyTemplate = function (target, name, label) {
    try { target.applyTemplate(name); return null; } catch (eT1) {}
    var avail = [];
    try { avail = target.templates; } catch (eT2) {}
    var want = String(name).toLowerCase();
    for (var i = 0; i < avail.length; i++) {
        if (String(avail[i]).toLowerCase() === want) {
            try { target.applyTemplate(avail[i]); return null; } catch (eT3) {}
        }
    }
    return label + ": no template named '" + name + "' — available: " + avail.join(" | ");
};

// ---------- Effect bit depth ----------

// Adobe effects that open a modal dialog the moment they are applied (a file
// picker, or the legacy text effects' font dialog) — found by applying every
// "ADBE" effect on AE 26.5. A probe must never add one: the dialog blocks
// every script until someone closes it.
AE.BIT_DEPTH_PROBE_SKIP = {
    "ADBE Apply Color LUT": true,
    "ADBE Apply Color LUT2": true,
    "ADBE Basic Text": true,
    "ADBE Basic Text2": true,
    "ADBE Numbers": true,
    "ADBE Numbers2": true,
    "ADBE Path Text": true
};

// The bit depth an effect PROCESSES at: { matchName, bpc: 32|16|8|null,
// source: "pipl"|"measured"|null, reason }. bpc null = unknown.
//
// `known` is what Node read from the effect's PiPL resource (src/effects/
// pipl.ts) — { bpc } or null. Plug-in effects are answered from it and never
// rendered: a third-party render can block After Effects indefinitely
// (licensing UI). Only Adobe's own effects ("ADBE …"), which register in code
// and have no PiPL, are measured — see AE._measureBitDepth.
//
// Measurements are cached per matchName for the life of the After Effects
// process ($.global survives between calls).
AE.effectBitDepth = function (matchName, known) {
    matchName = String(matchName);
    if (known && known.bpc) {
        return { matchName: matchName, bpc: known.bpc, source: "pipl", reason: "plug-in PiPL flags" };
    }
    var cache = $.global.AE_MCP_BIT_DEPTH_CACHE;
    if (!cache) { cache = {}; $.global.AE_MCP_BIT_DEPTH_CACHE = cache; }
    var key = "mn:" + matchName;
    if (cache.hasOwnProperty(key)) return cache[key];
    if (matchName.indexOf("ADBE ") !== 0) {
        return { matchName: matchName, bpc: null, source: null, reason: "plug-in effect with no readable PiPL; not rendered (a third-party render can hang on licensing UI)" };
    }
    if (AE.BIT_DEPTH_PROBE_SKIP[matchName] === true) {
        return { matchName: matchName, bpc: null, source: null, reason: "opens a dialog when applied; not measured" };
    }
    var res = AE._measureBitDepth(matchName);
    // Only a real measurement is cached; a failure (an audio effect that
    // refuses a visual layer, a render error) is retried next time.
    if (res.cacheable) cache[key] = res.info;
    return res.info;
};

// Measure by rendering. Nothing in the scripting DOM exposes the depth
// (app.effects has displayName/matchName/category/version only), so:
//
// in a 32bpc project, a throwaway comp feeds the effect a float gradient and
// reads six pixels back through sampleImage — twice, with different
// gradients. An effect that is not float-aware is handed a 16bpc (or 8bpc)
// copy of its input and returns a buffer of that depth, so its output lies on
// a grid: sampleImage at a pixel center with radius 0.5 averages up to four
// pixels, so 16bpc values are multiples of 1/131072 (4 × 32768) and 8bpc
// values of 1/1020 (4 × 255). A float-aware effect leaves values off both
// grids, or outside 0–1. See AE._classifyBitDepthSamples for the verdict.
//
// Validated on AE 26.5 against the 78 bundled plug-in effects (Cycore CC …)
// whose PiPL flags give the true answer: 65 verdicts, all correct, 13 null.
// Across Adobe's own effects: 114 × 32, 45 × 16, 29 × 8, 26 null (mostly
// generators), ~0.4 s each.
//
// Temporarily switches the project to 32bpc when it is not; the comp is
// removed and the depth restored before returning.
AE._measureBitDepth = function (matchName) {
    function info(bpc, reason) {
        return { matchName: matchName, bpc: bpc, source: bpc === null ? null : "measured", reason: reason };
    }
    var proj = app.project;
    var prevBpc = proj.bitsPerChannel;
    var comp = null;
    var inputs = [
        [[0.21, 0.37, 0.53, 1], [0.83, 0.61, 0.29, 1]],
        [[0.67, 0.19, 0.44, 1], [0.13, 0.58, 0.91, 1]]
    ];
    try {
        if (prevBpc !== 32) proj.bitsPerChannel = 32;
        // Odd, non-power-of-two size: a generator's gradient over a 32px
        // span evaluates to dyadic fractions that sit on the 16bpc grid by
        // coincidence (Gradient Ramp read as 16bpc at 32x32). Large enough
        // that the samples stay 25px+ from the layer edge, where a blur pulls
        // in transparency (Gaussian Blur left no opaque pixel at 37x29).
        comp = proj.items.addComp("__mcp_bit_depth_probe", 101, 77, 1, 1 / 24, 24);
        var reader = comp.layers.addText("0");
        var runs = [];
        for (var r = 0; r < inputs.length; r++) {
            // A shape layer, not a solid: a solid would leave a footage item
            // (and possibly a new "Solids" folder) behind in the project.
            var src = comp.layers.addShape();
            src.name = "__probe";
            AE.rect(src, [200, 200], [0, 0], { fill: [0.3141592, 0.3141592, 0.3141592] });
            var ramp = src.property("Effects").addProperty("ADBE Ramp");
            ramp.property(1).setValue([13, 9]);
            ramp.property(2).setValue(inputs[r][0]);
            ramp.property(3).setValue([88, 70]);
            ramp.property(4).setValue(inputs[r][1]);
            try {
                src.property("Effects").addProperty(matchName);
            } catch (eAdd) {
                return { cacheable: false, info: info(null, "could not apply to a layer: " + AE.errText(eAdd)) };
            }
            var st = reader.property("Source Text");
            st.expression =
                "var l = thisComp.layer(\"__probe\"); var r = [];" +
                " var p = [[30.5, 25.5], [50.5, 38.5], [70.5, 30.5], [40.5, 51.5], [62.5, 49.5], [33.5, 44.5]];" +
                " for (var i = 0; i < p.length; i++) r = r.concat(l.sampleImage(p[i], [0.5, 0.5], true, 0));" +
                " r.join(\",\")";
            var raw = String(st.value.text).split(",");
            if (raw.length !== 24) return { cacheable: false, info: info(null, "could not sample the output") };
            var nums = [];
            for (var k = 0; k < raw.length; k++) {
                var x = parseFloat(raw[k]);
                if (isNaN(x)) return { cacheable: false, info: info(null, "could not sample the output") };
                nums.push(x);
            }
            runs.push(nums);
            src.remove();
        }
        return { cacheable: true, info: AE._classifyBitDepthSamples(runs[0], runs[1], info) };
    } catch (e) {
        return { cacheable: false, info: info(null, "measurement failed: " + AE.errText(e)) };
    } finally {
        try { if (comp) comp.remove(); } catch (eC) {}
        try { if (proj.bitsPerChannel !== prevBpc) proj.bitsPerChannel = prevBpc; } catch (eB) {}
    }
};

// Verdict from two runs of RGBA samples taken with different inputs.
//   - any value outside 0–1, or off both grids    → 32 (float-aware)
//   - output follows the input, and its informative
//     values all sit on the 16bpc / the 8bpc grid → 16 / 8
//   - otherwise                                   → null (inconclusive)
// Values on BOTH grids (0, 0.25, 0.5, 1) are skipped as uninformative. The
// color of a partly transparent pixel comes back unpremultiplied, which
// divides it off any grid, so only its alpha counts (Gaussian Blur's default
// 25px blur leaves alpha at 0.9987 everywhere — itself off-grid, i.e. float). An output that ignores the input (a generator)
// only ever proves float: its default colors are 8-bit values and its
// geometry can land on dyadic fractions, so a grid match there is no proof
// of a low-depth render — and refusing a 32bpc effect is the costly mistake.
AE._classifyBitDepthSamples = function (a, b, info) {
    function onGrid(x, k) { var v = x * k; return Math.abs(v - Math.round(v)) < 1e-3; }
    var dependsOnInput = false;
    for (var i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) dependsOnInput = true;
    var n8 = 0, n16 = 0, off = 0;
    var runs = [a, b];
    for (var r = 0; r < runs.length; r++) {
        var s = runs[r];
        for (var p = 0; p + 3 < s.length; p += 4) {
            // Alpha is never unpremultiplied, so it is always evidence; the
            // color channels only where the pixel is opaque.
            for (var c = (s[p + 3] === 1 ? 0 : 3); c < 4; c++) {
                var x = s[p + c];
                if (x > 1 + 1e-6 || x < -1e-6) return info(32, "output outside 0-1");
                var g8 = onGrid(x, 1020), g16 = onGrid(x, 131072);
                if (g8 && g16) continue;
                if (!g8 && !g16) off++;
                else if (g8) n8++;
                else n16++;
            }
        }
    }
    if (off > 0) return info(32, "float output");
    if ((n16 > 0) !== (n8 > 0)) {
        if (!dependsOnInput) return info(null, "output ignores the input and sits on a low-depth grid - inconclusive");
        return n16 > 0 ? info(16, "output on the 16bpc grid") : info(8, "output on the 8bpc grid");
    }
    return info(null, "no informative output (flat, transparent or mixed) - inconclusive");
};
