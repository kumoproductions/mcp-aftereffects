// mcp-aftereffects shared JSX helpers — included by dispatcher.jsx so every tool call
// has these in scope. Keep this file ES3-compatible: var only, no arrow
// functions, no Array.prototype.map/filter, no template strings.

var AE = AE || {};

// ---------- Talking about exceptions ----------

/**
 * Render a caught exception as text. Use this instead of `"failed: " + e`,
 * always — the concatenation is not the harmless shorthand it looks like.
 * ExtendScript cannot coerce an Error to a primitive, so `+ e` throws on its
 * own ("Object of type Error found where a Number, Array, or Property is
 * needed") from inside the handler that was supposed to report the original
 * failure: the real error is swallowed and a bogus one takes its place. In a
 * generated operation that turns a recoverable warning into a failed call; in
 * the dispatcher it used to escape as far as AE's modal error dialog.
 *
 * dispatcher.jsx carries its own copy of this so it can still report failures
 * when an #include has not taken. Keep the two in step.
 */
AE.errText = function (e) {
    try {
        if (e === null || e === undefined) return "unknown error";
        if (typeof e === "string") return e;
        var msg = (e.message === undefined || e.message === null) ? "" : String(e.message);
        if (msg.length === 0) msg = "error";
        if (e.line !== undefined && e.line !== null) msg += " (line " + String(e.line) + ")";
        return msg;
    } catch (eFmt) {
        return "unformattable error";
    }
};

// ---------- Project item lookup ----------

AE.findItemById = function (id) {
    var proj = app.project;
    for (var i = 1; i <= proj.numItems; i++) {
        if (proj.item(i).id === id) return proj.item(i);
    }
    return null;
};

// Find any project item by numeric id or exact name (first match wins).
AE.findItem = function (idOrName) {
    if (typeof idOrName === "number") return AE.findItemById(idOrName);
    var proj = app.project;
    var name = String(idOrName);
    for (var i = 1; i <= proj.numItems; i++) {
        if (proj.item(i).name === name) return proj.item(i);
    }
    return null;
};

// Find a FolderItem by id or name. null/undefined resolves to the root folder.
AE.findFolder = function (idOrName) {
    if (idOrName === null || idOrName === undefined) return app.project.rootFolder;
    var it = AE.findItem(idOrName);
    return (it && it instanceof FolderItem) ? it : null;
};

AE.findCompByNameOrId = function (nameOrId) {
    var proj = app.project;
    if (typeof nameOrId === "number") {
        var byId = AE.findItemById(nameOrId);
        if (byId && byId instanceof CompItem) return byId;
        // fall through: treat number as 1-based index
        if (nameOrId >= 1 && nameOrId <= proj.numItems && proj.item(nameOrId) instanceof CompItem) {
            return proj.item(nameOrId);
        }
        return null;
    }
    for (var i = 1; i <= proj.numItems; i++) {
        var it = proj.item(i);
        if (it instanceof CompItem && it.name === nameOrId) return it;
    }
    return null;
};

// ---------- Comp/Layer pattern matching ----------

// Find comps by name, id, or glob pattern ('*' = all, 'review_id_*' = prefix match).
AE.findComps = function (nameOrIdOrPattern) {
    var proj = app.project;
    if (typeof nameOrIdOrPattern === "number") {
        var c = AE.findItemById(nameOrIdOrPattern);
        return (c && c instanceof CompItem) ? [c] : [];
    }
    var pat = String(nameOrIdOrPattern);
    var results = [];
    var isGlob = pat.indexOf("*") !== -1;
    for (var i = 1; i <= proj.numItems; i++) {
        var item = proj.item(i);
        if (!(item instanceof CompItem)) continue;
        if (isGlob) {
            // Simple glob: 'abc*' = startsWith, '*abc' = endsWith, '*' = all
            if (pat === "*") { results.push(item); continue; }
            var parts = pat.split("*");
            var match = true;
            var pos = 0;
            for (var p = 0; p < parts.length; p++) {
                if (parts[p].length === 0) continue;
                if (p === parts.length - 1) {
                    // Pattern does not end with '*': the final segment must
                    // end exactly at the end of the name.
                    var tailStart = item.name.length - parts[p].length;
                    if (tailStart < pos || item.name.substring(tailStart) !== parts[p]) { match = false; }
                    break;
                }
                var idx = item.name.indexOf(parts[p], pos);
                if (idx === -1) { match = false; break; }
                if (p === 0 && idx !== 0) { match = false; break; }
                pos = idx + parts[p].length;
            }
            if (match) results.push(item);
        } else {
            if (item.name === pat) results.push(item);
        }
    }
    return results;
};

// Find a layer by stable id (Layer.id, AE 22.0+). Uses app.project.layerByID
// (a Project method, not CompItem) when available, checking the hit belongs to
// this comp; falls back to a scan so pre-22 hosts degrade gracefully.
AE.findLayerById = function (comp, id) {
    try {
        if (typeof app.project.layerByID === "function") {
            var byId = app.project.layerByID(id);
            if (byId) {
                return (byId.containingComp && byId.containingComp.id === comp.id) ? byId : null;
            }
        }
    } catch (eById) { /* fall through to scan */ }
    for (var i = 1; i <= comp.numLayers; i++) {
        try { if (comp.layer(i).id === id) return comp.layer(i); } catch (eScan) {}
    }
    return null;
};

// Find a layer in a comp by index (number), name (string), or { id: n }
// (stable Layer.id reference that survives reordering and renaming).
AE.findLayerInComp = function (comp, indexOrName) {
    if (indexOrName !== null && typeof indexOrName === "object" && typeof indexOrName.id === "number") {
        return AE.findLayerById(comp, indexOrName.id);
    }
    if (typeof indexOrName === "number") {
        if (indexOrName >= 1 && indexOrName <= comp.numLayers) return comp.layer(indexOrName);
        return null;
    }
    var name = String(indexOrName);
    for (var i = 1; i <= comp.numLayers; i++) {
        if (comp.layer(i).name === name) return comp.layer(i);
    }
    return null;
};

// Resolve layer target: number=index, "selected"=selected layers array, string=name match,
// { id: n }=stable Layer.id. Always returns an array of layers.
AE.resolveLayers = function (comp, target) {
    if (target !== null && typeof target === "object" && typeof target.id === "number") {
        var byId = AE.findLayerById(comp, target.id);
        return byId ? [byId] : [];
    }
    if (typeof target === "number") {
        if (target >= 1 && target <= comp.numLayers) return [comp.layer(target)];
        return [];
    }
    var s = String(target);
    if (s === "selected") {
        var sel = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            if (comp.layer(i).selected) sel.push(comp.layer(i));
        }
        return sel;
    }
    if (s === "all") {
        var all = [];
        for (var i2 = 1; i2 <= comp.numLayers; i2++) all.push(comp.layer(i2));
        return all;
    }
    // By name
    for (var i3 = 1; i3 <= comp.numLayers; i3++) {
        if (comp.layer(i3).name === s) return [comp.layer(i3)];
    }
    return [];
};

// ---------- Enum-valued layer attributes ----------
// JSON can't carry ExtendScript enum objects, so layer.set_props accepts
// well-known string names and translates them here. A value that is not a
// string, or a key/name this table doesn't know, passes through untouched —
// the plain assignment then succeeds on its own or reports its own error.
// Built lazily; each enum family guarded so one missing global (old AE)
// doesn't take the whole table down. Entries whose enum member resolved to
// undefined are dropped — assigning undefined would throw a misleading error.
AE._layerEnumMaps = null;
AE.coerceLayerPropValue = function (key, val) {
    if (typeof val !== "string") return val;
    if (AE._layerEnumMaps === null) {
        var maps = {};
        try {
            maps.autoOrient = {
                off: AutoOrientType.NO_AUTO_ORIENT,
                alongPath: AutoOrientType.ALONG_PATH,
                cameraOrPointOfInterest: AutoOrientType.CAMERA_OR_POINT_OF_INTEREST,
                charactersTowardCamera: AutoOrientType.CHARACTERS_TOWARD_CAMERA
            };
        } catch (eAo) {}
        try {
            maps.quality = {
                best: LayerQuality.BEST,
                draft: LayerQuality.DRAFT,
                wireframe: LayerQuality.WIREFRAME
            };
        } catch (eQ) {}
        try {
            maps.samplingQuality = {
                bilinear: LayerSamplingQuality.BILINEAR,
                bicubic: LayerSamplingQuality.BICUBIC
            };
        } catch (eSq) {}
        try {
            maps.frameBlendingType = {
                off: FrameBlendingType.NO_FRAME_BLEND,
                frameMix: FrameBlendingType.FRAME_MIX,
                pixelMotion: FrameBlendingType.PIXEL_MOTION
            };
        } catch (eFb) {}
        try {
            maps.blendingMode = {
                normal: BlendingMode.NORMAL, dissolve: BlendingMode.DISSOLVE,
                dancingDissolve: BlendingMode.DANCING_DISSOLVE,
                darken: BlendingMode.DARKEN, multiply: BlendingMode.MULTIPLY,
                colorBurn: BlendingMode.COLOR_BURN, classicColorBurn: BlendingMode.CLASSIC_COLOR_BURN,
                linearBurn: BlendingMode.LINEAR_BURN, darkerColor: BlendingMode.DARKER_COLOR,
                add: BlendingMode.ADD, lighten: BlendingMode.LIGHTEN,
                screen: BlendingMode.SCREEN, colorDodge: BlendingMode.COLOR_DODGE,
                classicColorDodge: BlendingMode.CLASSIC_COLOR_DODGE,
                linearDodge: BlendingMode.LINEAR_DODGE, lighterColor: BlendingMode.LIGHTER_COLOR,
                overlay: BlendingMode.OVERLAY, softLight: BlendingMode.SOFT_LIGHT,
                hardLight: BlendingMode.HARD_LIGHT, linearLight: BlendingMode.LINEAR_LIGHT,
                vividLight: BlendingMode.VIVID_LIGHT, pinLight: BlendingMode.PIN_LIGHT,
                hardMix: BlendingMode.HARD_MIX, difference: BlendingMode.DIFFERENCE,
                classicDifference: BlendingMode.CLASSIC_DIFFERENCE, exclusion: BlendingMode.EXCLUSION,
                subtract: BlendingMode.SUBTRACT, divide: BlendingMode.DIVIDE,
                hue: BlendingMode.HUE, saturation: BlendingMode.SATURATION,
                color: BlendingMode.COLOR, luminosity: BlendingMode.LUMINOSITY,
                stencilAlpha: BlendingMode.STENCIL_ALPHA, stencilLuma: BlendingMode.STENCIL_LUMA,
                alphaAdd: BlendingMode.ALPHA_ADD, luminescentPremul: BlendingMode.LUMINESCENT_PREMUL
            };
            // The API spells it SILHOUETE_* (one T) — an Adobe typo old enough
            // to be contractual. Probe both spellings, keep whichever exists.
            var silA = BlendingMode.SILHOUETE_ALPHA;
            if (silA === undefined) silA = BlendingMode.SILHOUETTE_ALPHA;
            var silL = BlendingMode.SILHOUETE_LUMA;
            if (silL === undefined) silL = BlendingMode.SILHOUETTE_LUMA;
            maps.blendingMode.silhouetteAlpha = silA;
            maps.blendingMode.silhouetteLuma = silL;
        } catch (eBm) {}
        try {
            maps.lightType = {
                spot: LightType.SPOT,
                parallel: LightType.PARALLEL,
                point: LightType.POINT,
                ambient: LightType.AMBIENT
            };
        } catch (eLt) {}
        // ENVIRONMENT is 24.3+ — probed separately so a build without it keeps
        // the four classic light types even if the member access throws.
        try {
            if (maps.lightType && LightType.ENVIRONMENT !== undefined) {
                maps.lightType.environment = LightType.ENVIRONMENT;
            }
        } catch (eEnv) {}
        // Drop entries whose enum member is missing on this AE build.
        for (var mk in maps) {
            if (!maps.hasOwnProperty(mk)) continue;
            for (var vk in maps[mk]) {
                if (maps[mk].hasOwnProperty(vk) && maps[mk][vk] === undefined) delete maps[mk][vk];
            }
        }
        AE._layerEnumMaps = maps;
    }
    var map = AE._layerEnumMaps.hasOwnProperty(key) ? AE._layerEnumMaps[key] : null;
    if (map !== null && map.hasOwnProperty(val)) return map[val];
    return val;
};

// ---------- Basic serialization ----------

// Canonical item type label. An if/else chain, NOT a chained ternary:
// ExtendScript parses `a ? b : c ? d : e` LEFT-associatively — as
// `(a ? b : c) ? d : e` — so a ternary chain here would label every
// item with the last branch. (Verified on AE 26.3 / ExtendScript 4.5.6.)
AE.itemTypeName = function (item) {
    if (item instanceof CompItem) return "CompItem";
    if (item instanceof FolderItem) return "FolderItem";
    if (item instanceof FootageItem) return "FootageItem";
    return "UnknownItem";
};

AE.serializeItemSummary = function (item) {
    var type = AE.itemTypeName(item);
    var out = {
        id: item.id,
        name: item.name,
        type: type,
        parentFolderId: item.parentFolder ? item.parentFolder.id : null,
        parentFolderName: item.parentFolder ? item.parentFolder.name : null,
        label: item.label,
        comment: item.comment
    };
    if (item instanceof CompItem) {
        out.width = item.width;
        out.height = item.height;
        out.frameRate = item.frameRate;
        out.duration = item.duration;
        out.layerCount = item.numLayers;
        out.bgColor = [item.bgColor[0], item.bgColor[1], item.bgColor[2]];
    }
    if (item instanceof FootageItem) {
        out.width = item.width;
        out.height = item.height;
        out.duration = item.duration;
        var src = item.mainSource;
        if (src instanceof SolidSource) {
            out.sourceKind = "solid";
            out.color = [src.color[0], src.color[1], src.color[2]];
        } else if (src instanceof FileSource) {
            out.sourceKind = "file";
            out.file = src.file ? src.file.fsName.replace(/\\/g, "/") : null;
            out.missingFootagePath = (src.missingFootagePath && src.missingFootagePath.length > 0) ? src.missingFootagePath : null;
        } else if (src instanceof PlaceholderSource) {
            out.sourceKind = "placeholder";
        } else {
            out.sourceKind = "unknown";
        }
    }
    return out;
};

AE.serializeLayerSummary = function (layer) {
    var type = "Layer";
    if (layer instanceof AVLayer) type = "AVLayer";
    if (layer instanceof ShapeLayer) type = "ShapeLayer";
    if (layer instanceof TextLayer) type = "TextLayer";
    if (layer instanceof CameraLayer) type = "CameraLayer";
    if (layer instanceof LightLayer) type = "LightLayer";
    // AE 24.4+ / 26.3+ layer classes. ThreeDModelLayer subclasses AVLayer;
    // ParametricMeshLayer does NOT (verified on 26.3), so both need their own
    // probe-guarded checks rather than relying on the chain above.
    try { if (typeof ThreeDModelLayer !== "undefined" && layer instanceof ThreeDModelLayer) type = "ThreeDModelLayer"; } catch (e3d) {}
    try { if (typeof ParametricMeshLayer !== "undefined" && layer instanceof ParametricMeshLayer) type = "ParametricMeshLayer"; } catch (ePm) {}
    var out = {
        index: layer.index,
        // Stable layer id (AE 22.0+) — survives reordering/renaming. null on older hosts.
        id: AE.safeGet(function () { return layer.id; }, null),
        name: layer.name,
        type: type,
        enabled: layer.enabled,
        solo: layer.solo,
        shy: layer.shy,
        locked: layer.locked,
        inPoint: layer.inPoint,
        outPoint: layer.outPoint,
        startTime: layer.startTime,
        stretch: layer.stretch,
        parentIndex: layer.parent ? layer.parent.index : null,
        label: layer.label
    };
    if (layer instanceof AVLayer) {
        out.width = layer.width;
        out.height = layer.height;
        out.hasVideo = layer.hasVideo;
        out.hasAudio = layer.hasAudio;
        out.threeDLayer = layer.threeDLayer;
        out.sourceId = (layer.source && layer.source.id) ? layer.source.id : null;
        out.sourceName = layer.source ? layer.source.name : null;
    }
    if (layer instanceof TextLayer) {
        try {
            var doc = layer.property("Source Text").value;
            out.text = doc.text;
            out.fontSize = doc.fontSize;
            out.font = doc.font;
            out.fillColor = [doc.fillColor[0], doc.fillColor[1], doc.fillColor[2]];
        } catch (eT) {
            out.text = null;
        }
    }
    return out;
};

// ---------- Transform snapshot (values at time 0) ----------

AE.serializeTransform = function (layer) {
    var xf = layer.transform;
    function v(name) {
        try {
            var p = xf.property(name);
            if (!p) return null;
            var val = p.value;
            if (val && val.length !== undefined) {
                var arr = [];
                for (var i = 0; i < val.length; i++) arr.push(val[i]);
                return arr;
            }
            return val;
        } catch (e) { return null; }
    }
    return {
        anchorPoint: v("Anchor Point"),
        position: v("Position"),
        scale: v("Scale"),
        rotation: v("Rotation"),
        opacity: v("Opacity")
    };
};

// ---------- Property tree walker (for export) ----------
// Walks a PropertyGroup (or indexed group) and serializes every leaf Property
// with its current value and keyframes. Skips properties that can't be
// serialized (BridgeTalk, byte arrays, etc.) by falling back to null.

AE.PROPERTY_VALUE_TYPE_NAMES = {};
(function buildPvtNames() {
    try {
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.NO_VALUE] = "NO_VALUE";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.ThreeD_SPATIAL] = "ThreeD_SPATIAL";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.ThreeD] = "ThreeD";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.TwoD_SPATIAL] = "TwoD_SPATIAL";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.TwoD] = "TwoD";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.OneD] = "OneD";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.COLOR] = "COLOR";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.CUSTOM_VALUE] = "CUSTOM_VALUE";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.MARKER] = "MARKER";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.LAYER_INDEX] = "LAYER_INDEX";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.MASK_INDEX] = "MASK_INDEX";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.SHAPE] = "SHAPE";
        AE.PROPERTY_VALUE_TYPE_NAMES[PropertyValueType.TEXT_DOCUMENT] = "TEXT_DOCUMENT";
    } catch (e) { /* older AE: some enum members might be absent */ }
})();

AE.KEY_INTERP_NAMES = {};
(function buildKitNames() {
    try {
        AE.KEY_INTERP_NAMES[KeyframeInterpolationType.LINEAR] = "linear";
        AE.KEY_INTERP_NAMES[KeyframeInterpolationType.BEZIER] = "bezier";
        AE.KEY_INTERP_NAMES[KeyframeInterpolationType.HOLD] = "hold";
    } catch (e) { /* older AE */ }
})();

// Safely call a getter that may throw or return undefined. Returns the fallback on any failure.
AE.safeGet = function (fn, fallback) {
    try { var v = fn(); return (v === undefined) ? fallback : v; } catch (e) { return fallback; }
};

AE.valueToJson = function (val, _depth) {
    if (val === null || val === undefined) return null;
    var t = typeof val;
    if (t === "number" || t === "boolean" || t === "string") return val;
    if (val instanceof Array) {
        var arr = [];
        for (var i = 0; i < val.length; i++) arr.push(AE.valueToJson(val[i], (_depth || 0) + 1));
        return arr;
    }
    // TextDocument special-case — check before generic array-like because
    // TextDocument does not expose a length property.
    if (val.text !== undefined && typeof val.text === "string" && val.fontSize !== undefined) {
        return {
            __kind: "TextDocument",
            text: val.text,
            font: AE.safeGet(function () { return val.font; }, null),
            fontFamily: AE.safeGet(function () { return val.fontFamily; }, null),
            fontStyle: AE.safeGet(function () { return val.fontStyle; }, null),
            fontSize: val.fontSize,
            fillColor: AE.safeGet(function () { return val.fillColor ? [val.fillColor[0], val.fillColor[1], val.fillColor[2]] : null; }, null),
            strokeColor: AE.safeGet(function () { return val.strokeColor ? [val.strokeColor[0], val.strokeColor[1], val.strokeColor[2]] : null; }, null),
            strokeWidth: AE.safeGet(function () { return val.strokeWidth; }, 0),
            justification: AE.safeGet(function () { return String(val.justification); }, null),
            tracking: AE.safeGet(function () { return val.tracking; }, 0),
            leading: AE.safeGet(function () { return val.leading; }, 0),
            baselineShift: AE.safeGet(function () { return val.baselineShift; }, 0),
            applyFill: AE.safeGet(function () { return val.applyFill; }, true),
            applyStroke: AE.safeGet(function () { return val.applyStroke; }, false),
            boxText: AE.safeGet(function () { return val.boxText; }, false),
            boxTextSize: AE.safeGet(function () { return val.boxText && val.boxTextSize ? [val.boxTextSize[0], val.boxTextSize[1]] : null; }, null),
            boxTextPos: AE.safeGet(function () { return val.boxText && val.boxTextPos ? [val.boxTextPos[0], val.boxTextPos[1]] : null; }, null)
        };
    }
    // Shape object (masks / shape layer paths)
    if (val.vertices !== undefined) {
        return {
            __kind: "Shape",
            closed: val.closed,
            vertices: AE.valueToJson(val.vertices),
            inTangents: AE.valueToJson(val.inTangents),
            outTangents: AE.valueToJson(val.outTangents)
        };
    }
    // MarkerValue — from marker keyframes (comp.markerProperty or layer.marker)
    if (val.comment !== undefined && val.chapter !== undefined) {
        return {
            __kind: "MarkerValue",
            comment: AE.safeGet(function () { return val.comment; }, ""),
            chapter: AE.safeGet(function () { return val.chapter; }, ""),
            url: AE.safeGet(function () { return val.url; }, ""),
            frameTarget: AE.safeGet(function () { return val.frameTarget; }, ""),
            cuePointName: AE.safeGet(function () { return val.cuePointName; }, ""),
            duration: AE.safeGet(function () { return val.duration; }, 0),
            label: AE.safeGet(function () { return val.label; }, 0),
            protectedRegion: AE.safeGet(function () { return val.protectedRegion; }, false)
        };
    }
    // Array-like (color tuples, position tuples). Check AFTER the typed
    // objects above so we don't accidentally treat them as arrays.
    if (val.length !== undefined && typeof val.length === "number") {
        var out = [];
        for (var j = 0; j < val.length; j++) out.push(AE.valueToJson(val[j], (_depth || 0) + 1));
        return out;
    }
    // Generic object (swatch data, usedFonts usage records, design-axis
    // entries). Depth-capped and function-skipping: AE host objects reachable
    // from here can fan out into the whole project graph, and their methods
    // enumerate in for..in.
    var d = typeof _depth === "number" ? _depth : 0;
    if (d < 4) {
        var objOut = {};
        var got = false;
        var kept = 0;
        for (var k in val) {
            if (kept >= 64) break;
            var v2;
            try { v2 = val[k]; } catch (eK) { continue; }
            if (typeof v2 === "function") continue;
            var enc = AE.valueToJson(v2, d + 1);
            if (enc === null && v2 !== null && v2 !== undefined) continue;
            objOut[k] = enc;
            got = true;
            kept++;
        }
        if (got) return objOut;
    }
    return null;
};

AE.serializeProperty = function (prop) {
    var out = {
        name: prop.name,
        matchName: prop.matchName,
        propertyValueType: AE.PROPERTY_VALUE_TYPE_NAMES[prop.propertyValueType] || prop.propertyValueType
    };
    // Avoid touching NO_VALUE groups and properties marked as not-yet-created
    if (prop.propertyValueType === PropertyValueType.NO_VALUE) {
        return out;
    }
    try {
        out.value = AE.valueToJson(prop.value);
    } catch (e) {
        out.value = null;
    }
    if (prop.canSetExpression && prop.expressionEnabled && prop.expression && prop.expression.length > 0) {
        out.expression = prop.expression;
    }
    if (prop.numKeys && prop.numKeys > 0) {
        var keys = [];
        for (var k = 1; k <= prop.numKeys; k++) {
            var keyVal;
            try { keyVal = AE.valueToJson(prop.keyValue(k)); } catch (eKv) { keyVal = null; }
            var inInterp = null, outInterp = null;
            try { inInterp = prop.keyInInterpolationType(k); } catch (eI) {}
            try { outInterp = prop.keyOutInterpolationType(k); } catch (eO) {}
            var entry = {
                time: prop.keyTime(k),
                value: keyVal,
                inInterp: inInterp,
                outInterp: outInterp,
                inInterpName: AE.safeGet(function () { return AE.KEY_INTERP_NAMES[inInterp]; }, null),
                outInterpName: AE.safeGet(function () { return AE.KEY_INTERP_NAMES[outInterp]; }, null)
            };
            // Temporal ease (speed/influence) — only meaningful on bezier keys,
            // and only there does the extra bulk pay for itself (easing audits).
            try {
                if (inInterp === KeyframeInterpolationType.BEZIER || outInterp === KeyframeInterpolationType.BEZIER) {
                    entry.inEase = AE._serializeEase(prop.keyInTemporalEase(k));
                    entry.outEase = AE._serializeEase(prop.keyOutTemporalEase(k));
                }
            } catch (eEz) { /* pre-ease host or non-temporal property */ }
            keys.push(entry);
        }
        out.keyframes = keys;
    }
    return out;
};

/** KeyframeEase[] → [{speed, influence}, ...] (one per eased dimension). */
AE._serializeEase = function (eases) {
    if (!eases) return null;
    var arr = [];
    for (var i = 0; i < eases.length; i++) {
        arr.push({ speed: eases[i].speed, influence: eases[i].influence });
    }
    return arr;
};

/** [{speed, influence}, ...] → KeyframeEase[] (inverse of _serializeEase). */
AE._deserializeEase = function (specs) {
    var arr = [];
    for (var i = 0; i < specs.length; i++) {
        arr.push(new KeyframeEase(specs[i].speed, specs[i].influence));
    }
    return arr;
};

// opts.onlyModified: skip leaf properties still at their default value (no
// keyframes, no expression, isModified false). Group skeletons are kept so
// the EXISTENCE of an effect/mask still shows even when all its params are
// default. When reading isModified throws, the property is kept — hiding
// data is the worse failure.
AE.serializePropertyGroup = function (group, depth, maxDepth, opts) {
    if (depth === undefined) depth = 0;
    if (maxDepth === undefined) maxDepth = 6;
    var out = {
        name: group.name,
        matchName: group.matchName,
        properties: [],
        groups: []
    };
    if (depth >= maxDepth) return out;
    for (var i = 1; i <= group.numProperties; i++) {
        var child;
        try { child = group.property(i); } catch (e) { continue; }
        if (!child) continue;
        if (child.propertyType === PropertyType.PROPERTY) {
            if (opts && opts.onlyModified && !AE._propertyMatters(child)) continue;
            out.properties.push(AE.serializeProperty(child));
        } else if (child.propertyType === PropertyType.NAMED_GROUP || child.propertyType === PropertyType.INDEXED_GROUP) {
            out.groups.push(AE.serializePropertyGroup(child, depth + 1, maxDepth, opts));
        }
    }
    return out;
};

/** True when a leaf property carries information: modified, keyed, or expressed. */
AE._propertyMatters = function (prop) {
    try { if (prop.isModified === true) return true; } catch (eIm) { return true; }
    try { if (prop.numKeys && prop.numKeys > 0) return true; } catch (eNk) {}
    try {
        if (prop.canSetExpression && prop.expressionEnabled && prop.expression && prop.expression.length > 0) return true;
    } catch (eEx) {}
    return false;
};

/** True when a serialized group tree holds no leaf properties at any depth. */
AE.propertyGroupIsEmpty = function (g) {
    if (!g) return true;
    if (g.properties && g.properties.length > 0) return false;
    if (g.groups) {
        for (var i = 0; i < g.groups.length; i++) {
            if (!AE.propertyGroupIsEmpty(g.groups[i])) return false;
        }
    }
    return true;
};

// ---------- Layer full serialization ----------

// opts.includeProperties=false skips the property tree entirely.
// opts.detail="summary" keeps the tree but drops leaves still at their default
// value (AE._propertyMatters) — the answer to 150KB-per-comp audits. Trees
// that exist on every layer (Transform, Material Options, Audio) collapse to
// null when nothing in them was touched; Effects/Masks/Text/Contents keep
// their skeleton so their existence still shows.
AE.serializeLayerFull = function (layer, opts) {
    opts = opts || {};
    var out = AE.serializeLayerSummary(layer);
    // Parent by index for simple remapping on import.
    out.parent = layer.parent ? { index: layer.parent.index, name: layer.parent.name } : null;
    var summary = opts.detail === "summary";
    var walkOpts = summary ? { onlyModified: true } : null;
    function collapse(g) { return (summary && AE.propertyGroupIsEmpty(g)) ? null : g; }
    // Property tree (Transform + Effects + Masks + Text + Contents + Material Options + Audio)
    if (opts.includeProperties !== false) {
        try { out.transformGroup = collapse(AE.serializePropertyGroup(layer.property("Transform"), 0, 4, walkOpts)); } catch (eT) { out.transformGroup = null; }
        try {
            var effects = layer.property("Effects");
            out.effectsGroup = (effects && effects.numProperties > 0) ? AE.serializePropertyGroup(effects, 0, 6, walkOpts) : null;
        } catch (eE) { out.effectsGroup = null; }
        try {
            var masks = layer.property("Masks");
            out.masksGroup = (masks && masks.numProperties > 0) ? AE.serializePropertyGroup(masks, 0, 5, walkOpts) : null;
        } catch (eM) { out.masksGroup = null; }
        if (layer instanceof TextLayer) {
            try { out.textGroup = AE.serializePropertyGroup(layer.property("Text"), 0, 4, walkOpts); } catch (eTx) { out.textGroup = null; }
        }
        if (layer instanceof ShapeLayer) {
            // Shape layers have a Contents group that holds the shape vector
            // graphics. Walk deeper because shape groups nest several levels.
            try { out.contentsGroup = AE.serializePropertyGroup(layer.property("Contents"), 0, 10, walkOpts); } catch (eCt) { out.contentsGroup = null; }
        }
        // Material options (3D layers)
        if (layer instanceof AVLayer && layer.threeDLayer) {
            try {
                var mat = layer.property("Material Options");
                out.materialOptionsGroup = mat ? collapse(AE.serializePropertyGroup(mat, 0, 3, walkOpts)) : null;
            } catch (eMo) { out.materialOptionsGroup = null; }
        }
        // Audio (if layer has audio)
        if (layer instanceof AVLayer && layer.hasAudio) {
            try {
                var au = layer.property("Audio");
                out.audioGroup = au ? collapse(AE.serializePropertyGroup(au, 0, 3, walkOpts)) : null;
            } catch (eAu) { out.audioGroup = null; }
        }
        // Time Remap (AVLayer only, must be enabled)
        if (layer instanceof AVLayer) {
            try {
                out.timeRemapEnabled = !!layer.timeRemapEnabled;
                if (layer.timeRemapEnabled) {
                    var tr = layer.property("Time Remap");
                    out.timeRemapProperty = tr ? AE.serializeProperty(tr) : null;
                }
            } catch (eTr) { /* ignore */ }
        }
        // Layer markers — layer.marker is a NamedGroup with keyframed MarkerValues
        try {
            var marker = layer.property("Marker");
            if (marker && marker.numKeys > 0) {
                out.markers = AE.serializeProperty(marker);
            }
        } catch (eMk) { /* ignore */ }
    }
    return out;
};

// ---------- Keyframe snapshot / rebuild ----------
// Captures every scriptable attribute of a property's keyframes so they can be
// re-created after retiming (shift/scale) or on another property (copy).
// Interpolation, temporal ease, and spatial tangents are restored best-effort.

AE.snapshotKeys = function (prop) {
    var keys = [];
    for (var k = 1; k <= prop.numKeys; k++) {
        var key = { time: prop.keyTime(k), value: prop.keyValue(k) };
        try { key.inInterp = prop.keyInInterpolationType(k); } catch (e1) {}
        try { key.outInterp = prop.keyOutInterpolationType(k); } catch (e2) {}
        try { key.inEase = prop.keyInTemporalEase(k); } catch (e3) {}
        try { key.outEase = prop.keyOutTemporalEase(k); } catch (e4) {}
        try { key.temporalContinuous = prop.keyTemporalContinuous(k); } catch (e5) {}
        try { key.temporalAutoBezier = prop.keyTemporalAutoBezier(k); } catch (e6) {}
        try {
            if (prop.isSpatial) {
                key.inSpatialTangent = prop.keyInSpatialTangent(k);
                key.outSpatialTangent = prop.keyOutSpatialTangent(k);
                key.spatialContinuous = prop.keySpatialContinuous(k);
                key.spatialAutoBezier = prop.keySpatialAutoBezier(k);
                key.roving = prop.keyRoving(k);
            }
        } catch (e7) {}
        keys.push(key);
    }
    return keys;
};

AE.removeAllKeys = function (prop) {
    var removed = 0;
    while (prop.numKeys > 0) { prop.removeKey(prop.numKeys); removed++; }
    return removed;
};

// Re-create keys from a snapshot whose times the caller may have remapped.
// Two passes: values first, then interpolation attributes — writing bezier
// data while neighbours are still being inserted shifts the handles.
AE.applyKeys = function (prop, keys) {
    var i, key, ki;
    // addKey on a time that already carries a key returns the existing index
    // rather than adding one, so keys.length overstates the result whenever
    // two snapshot times collide or land on an existing key. Report what the
    // property actually gained.
    var before = prop.numKeys;
    for (i = 0; i < keys.length; i++) {
        key = keys[i];
        ki = prop.addKey(key.time);
        try { prop.setValueAtKey(ki, key.value); } catch (eV) {}
    }
    for (i = 0; i < keys.length; i++) {
        key = keys[i];
        ki = prop.nearestKeyIndex(key.time);
        // Ease before interpolation type: setting ease flips the key to
        // BEZIER, so a HOLD/LINEAR snapshot must be re-asserted afterwards.
        try { if (key.inEase && key.outEase) prop.setTemporalEaseAtKey(ki, key.inEase, key.outEase); } catch (eE) {}
        try { if (key.inInterp !== undefined && key.outInterp !== undefined) prop.setInterpolationTypeAtKey(ki, key.inInterp, key.outInterp); } catch (eI) {}
        try { if (key.temporalContinuous !== undefined) prop.setTemporalContinuousAtKey(ki, key.temporalContinuous); } catch (eC) {}
        try { if (key.temporalAutoBezier !== undefined) prop.setTemporalAutoBezierAtKey(ki, key.temporalAutoBezier); } catch (eB) {}
        try {
            if (key.inSpatialTangent !== undefined) {
                prop.setSpatialTangentsAtKey(ki, key.inSpatialTangent, key.outSpatialTangent);
                prop.setSpatialContinuousAtKey(ki, key.spatialContinuous);
                prop.setSpatialAutoBezierAtKey(ki, key.spatialAutoBezier);
                prop.setRovingAtKey(ki, key.roving);
            }
        } catch (eS) {}
    }
    return keys.length;
};

// ---------- Keyframe easing shorthand ----------

// Set temporal ease on one key and flip it to bezier. Handles the dimension
// bookkeeping that setTemporalEaseAtKey demands: spatial properties
// (Position/Anchor Point) take exactly ONE KeyframeEase regardless of value
// dimensions; everything else takes one per dimension. Same contract as the
// keyframe.set_easing operation — this is its eval.run twin.
// Speeds default to 0 (ease-style handles). Influence range is 0.1–100.
AE.setEase = function (prop, keyIndex, inInfluence, outInfluence, inSpeed, outSpeed) {
    if (inSpeed === undefined) inSpeed = 0;
    if (outSpeed === undefined) outSpeed = 0;
    var dims = 1;
    var spatial = false;
    try {
        var pvt = prop.propertyValueType;
        if (pvt === PropertyValueType.TwoD_SPATIAL || pvt === PropertyValueType.ThreeD_SPATIAL) spatial = true;
    } catch (ePvt) {}
    if (!spatial) {
        try { var v = prop.keyValue(keyIndex); if (v && v.length) dims = v.length; } catch (eV) {}
    }
    var inArr = [], outArr = [];
    for (var d = 0; d < dims; d++) {
        inArr.push(new KeyframeEase(inSpeed, inInfluence));
        outArr.push(new KeyframeEase(outSpeed, outInfluence));
    }
    prop.setTemporalEaseAtKey(keyIndex, inArr, outArr);
    prop.setInterpolationTypeAtKey(keyIndex, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
    return keyIndex;
};

// ---------- Shape construction shorthand ----------

/** Resolve a ShapeLayer, a vector group, or a Contents group to the Contents to add into. */
AE._vectorContents = function (parent) {
    if (parent && parent.matchName === "ADBE Vector Group") return parent.property("Contents");
    if (parent && (parent.matchName === "ADBE Vectors Group" || parent.matchName === "ADBE Root Vectors Group")) return parent;
    return parent.property("Contents"); // shape layer
};

/** Append fill/stroke from opts ({fill, fillOpacity, stroke, strokeWidth}) to a Contents group. */
AE._applyShapeStyle = function (contents, opts) {
    if (opts.fill) {
        var fill = contents.addProperty("ADBE Vector Graphic - Fill");
        fill.property("ADBE Vector Fill Color").setValue(opts.fill);
        if (opts.fillOpacity !== undefined) fill.property("ADBE Vector Fill Opacity").setValue(opts.fillOpacity);
    }
    if (opts.stroke) {
        var st = contents.addProperty("ADBE Vector Graphic - Stroke");
        st.property("ADBE Vector Stroke Color").setValue(opts.stroke);
        if (opts.strokeWidth !== undefined) st.property("ADBE Vector Stroke Width").setValue(opts.strokeWidth);
    }
};

// One call = one styled primitive: a new vector group holding the path plus
// optional fill/stroke. `parent` is a ShapeLayer or a vector group. Returns
// the created group. opts: { name, roundness (rect only), fill: [r,g,b(,a)],
// fillOpacity, stroke: [r,g,b(,a)], strokeWidth }. Colors are 0–1.
AE.rect = function (parent, size, position, opts) {
    opts = opts || {};
    var contents = AE._vectorContents(parent);
    var grp = contents.addProperty("ADBE Vector Group");
    if (opts.name) grp.name = opts.name;
    var inner = grp.property("Contents");
    var shp = inner.addProperty("ADBE Vector Shape - Rect");
    shp.property("ADBE Vector Rect Size").setValue(size);
    if (position) shp.property("ADBE Vector Rect Position").setValue(position);
    if (opts.roundness) shp.property("ADBE Vector Rect Roundness").setValue(opts.roundness);
    AE._applyShapeStyle(inner, opts);
    return grp;
};

AE.ellipse = function (parent, size, position, opts) {
    opts = opts || {};
    var contents = AE._vectorContents(parent);
    var grp = contents.addProperty("ADBE Vector Group");
    if (opts.name) grp.name = opts.name;
    var inner = grp.property("Contents");
    var shp = inner.addProperty("ADBE Vector Shape - Ellipse");
    shp.property("ADBE Vector Ellipse Size").setValue(size);
    if (position) shp.property("ADBE Vector Ellipse Position").setValue(position);
    AE._applyShapeStyle(inner, opts);
    return grp;
};

// ---------- Filesystem ----------

// Create the parent directory chain for a file path (string or File) and
// return the File. AE's own render pipeline does NOT create output folders —
// rq.render() dies with "Directory does not exist" — so every code path that
// points an output module at a file goes through this first.
AE.ensureParentDir = function (pathOrFile) {
    var f = (pathOrFile instanceof File) ? pathOrFile : new File(pathOrFile);
    function mk(folder) {
        if (!folder || folder.exists) return;
        mk(folder.parent);
        folder.create();
    }
    try { mk(f.parent); } catch (eMk) { /* creation failures surface at write time */ }
    return f;
};

// ---------- Composition marker serialization ----------

AE.serializeCompMarkers = function (comp) {
    try {
        var mp = comp.markerProperty;
        if (!mp || mp.numKeys === 0) return null;
        return AE.serializeProperty(mp);
    } catch (e) { return null; }
};
