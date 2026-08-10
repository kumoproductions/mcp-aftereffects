// mcp-aftereffects project import — reconstructs items and layers from a JSON
// document produced by AE.exportProject(). Returns a summary including an
// ID remap table (old id -> new id) and a list of warnings for things that
// could not be restored cleanly.
//
// Design:
//   1. Create all FolderItems first (flat pass), then wire up parentFolder.
//   2. Create FootageItems: solids from AE, file references via importFile
//      (fails gracefully if the file is missing).
//   3. Create CompItems.
//   4. For each comp, add its layers in order, remapping source item ids via
//      the remap table, then apply the property trees (transform/effects/
//      masks/text) and keyframes.
//   5. Wire up layer parenting last (since parents must exist).
//
// ES3-compatible. No arrow functions. No map/filter.

AE.importProject = function (doc, opts) {
    opts = opts || {};
    var warnings = [];
    var logs = [];
    function warn(msg) { warnings.push(msg); }
    function note(msg) { logs.push(msg); }

    if (!doc || !doc.items) {
        return { ok: false, error: "invalid document: missing items" };
    }
    if (doc.schemaVersion && doc.schemaVersion > AE.EXPORT_SCHEMA_VERSION) {
        warn("document schemaVersion " + doc.schemaVersion + " newer than runtime " + AE.EXPORT_SCHEMA_VERSION);
    }

    var proj = app.project;

    // Optionally clear the project first.
    if (opts.clearFirst) {
        var toRemove = [];
        for (var ci = 1; ci <= proj.numItems; ci++) toRemove.push(proj.item(ci));
        for (var ri = 0; ri < toRemove.length; ri++) {
            try { toRemove[ri].remove(); } catch (e) { /* some items can't be removed */ }
        }
    }

    // --- Pass 1: folders (flat create, wire parents in pass 5) ---
    var remap = {}; // old item id (string) -> new item
    var items = doc.items;

    var i;
    for (i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.type === "FolderItem") {
            var f = proj.items.addFolder(it.name);
            remap[String(it.id)] = f;
        }
    }

    // --- Pass 2: footage items ---
    // AE has no direct API to create a standalone Solid FootageItem. The
    // idiom is to spin up a throwaway comp, call LayerCollection#addSolid
    // (which creates both the Solid footage and a layer using it), then
    // delete the throwaway comp. The FootageItem persists in the project's
    // Solids folder.
    for (i = 0; i < items.length; i++) {
        var fi = items[i];
        if (fi.type !== "FootageItem") continue;
        if (fi.sourceKind === "solid") {
            try {
                var color = fi.color || [1, 1, 1];
                var w = fi.sourceWidth || fi.width || 100;
                var h = fi.sourceHeight || fi.height || 100;
                var dur = fi.duration || 1;
                var pa = fi.pixelAspect || 1;
                var holder = proj.items.addComp("__mcp_ae_solid_holder__", w, h, pa, Math.max(1, dur), 30);
                var holderLayer = holder.layers.addSolid(color, fi.name, w, h, pa, dur);
                var solidSource = holderLayer.source; // FootageItem
                holder.remove();
                if (solidSource) {
                    remap[String(fi.id)] = solidSource;
                } else {
                    warn("addSolid produced no source for '" + fi.name + "'");
                }
            } catch (eSol) {
                warn("failed to create solid '" + fi.name + "': " + AE.errText(eSol));
            }
        } else if (fi.sourceKind === "file") {
            try {
                if (!fi.file) { warn("file footage '" + fi.name + "' has no path; skipped"); continue; }
                var jsFile = new File(fi.file);
                if (!jsFile.exists) {
                    warn("file footage '" + fi.file + "' not found on disk; creating placeholder");
                    // ItemCollection has no addFootage; use importPlaceholder so
                    // dependent layers still get a source item.
                    var phName = fi.name || String(fi.file);
                    var phW = fi.sourceWidth || fi.width || 1920;
                    var phH = fi.sourceHeight || fi.height || 1080;
                    var phFps = fi.frameRate || 30;
                    var phDur = fi.duration || 10;
                    var ph = proj.importPlaceholder(phName, phW, phH, phFps, phDur);
                    if (fi.name && ph.name !== fi.name) ph.name = fi.name;
                    remap[String(fi.id)] = ph;
                } else {
                    var imp = new ImportOptions(jsFile);
                    var importedItem = proj.importFile(imp);
                    // importedItem may be a FootageItem or a FolderItem for sequence
                    if (fi.name && importedItem.name !== fi.name) importedItem.name = fi.name;
                    remap[String(fi.id)] = importedItem;
                }
            } catch (eF) {
                warn("failed to import file '" + fi.file + "': " + AE.errText(eF));
            }
        } else {
            warn("unsupported sourceKind '" + fi.sourceKind + "' for item '" + fi.name + "'; skipped");
        }
    }

    // --- Pass 3: comps ---
    var compBindings = []; // { compItem, spec } — for pass 4 layer population
    for (i = 0; i < items.length; i++) {
        var ci = items[i];
        if (ci.type !== "CompItem") continue;
        var comp = proj.items.addComp(
            ci.name,
            Math.max(4, ci.width | 0),
            Math.max(4, ci.height | 0),
            ci.pixelAspect || 1,
            Math.max(1 / 60, ci.duration),
            ci.frameRate || 30
        );
        // Apply comp-level props
        try { if (ci.bgColor) comp.bgColor = ci.bgColor; } catch (e1) {}
        try { if (ci.workAreaStart !== undefined) comp.workAreaStart = ci.workAreaStart; } catch (e2) {}
        try { if (ci.workAreaDuration !== undefined) comp.workAreaDuration = ci.workAreaDuration; } catch (e3) {}
        try { if (ci.shutterAngle !== undefined) comp.shutterAngle = ci.shutterAngle; } catch (e4) {}
        try { if (ci.shutterPhase !== undefined) comp.shutterPhase = ci.shutterPhase; } catch (e5) {}
        try { if (ci.motionBlur !== undefined) comp.motionBlur = ci.motionBlur; } catch (e6) {}
        try { if (ci.displayStartTime !== undefined) comp.displayStartTime = ci.displayStartTime; } catch (e7) {}
        try { if (ci.comment) comp.comment = ci.comment; } catch (e8) {}
        // Comp markers
        try {
            if (ci.markers) AE.applyPropertyValue(comp.markerProperty, ci.markers);
        } catch (eCm) { warn("comp markers restore failed for '" + ci.name + "': " + AE.errText(eCm)); }
        remap[String(ci.id)] = comp;
        compBindings.push({ comp: comp, spec: ci });
    }

    // --- Pass 4: layers inside comps ---
    for (var cb = 0; cb < compBindings.length; cb++) {
        var binding = compBindings[cb];
        var compDst = binding.comp;
        var spec = binding.spec;
        if (!spec.layers) continue;
        // Layers were exported in top-to-bottom order (index 1 = top).
        // AE's Layers#add inserts new layers at the top, pushing existing ones
        // down. Adding in *reverse* order produces the original stacking.
        for (var lj = spec.layers.length - 1; lj >= 0; lj--) {
            var lspec = spec.layers[lj];
            var newLayer = null;
            try {
                if (lspec.type === "TextLayer") {
                    newLayer = compDst.layers.addText(lspec.text || "");
                } else if (lspec.type === "ShapeLayer") {
                    newLayer = compDst.layers.addShape();
                } else if (lspec.type === "CameraLayer") {
                    newLayer = compDst.layers.addCamera(lspec.name || "Camera", [compDst.width / 2, compDst.height / 2]);
                } else if (lspec.type === "LightLayer") {
                    newLayer = compDst.layers.addLight(lspec.name || "Light", [compDst.width / 2, compDst.height / 2]);
                } else {
                    // AVLayer: must have a source
                    if (lspec.sourceId != null) {
                        var src = remap[String(lspec.sourceId)];
                        if (!src) {
                            warn("layer '" + lspec.name + "' in comp '" + spec.name + "' references missing source id " + lspec.sourceId);
                            continue;
                        }
                        newLayer = compDst.layers.add(src);
                    } else {
                        warn("AVLayer '" + lspec.name + "' has no sourceId; skipped");
                        continue;
                    }
                }
                if (!newLayer) continue;
                if (lspec.name) newLayer.name = lspec.name;
                if (lspec.enabled !== undefined) newLayer.enabled = lspec.enabled;
                if (lspec.shy !== undefined) newLayer.shy = lspec.shy;
                if (lspec.solo !== undefined) newLayer.solo = lspec.solo;
                if (lspec.locked !== undefined) newLayer.locked = lspec.locked;
                if (lspec.label !== undefined) newLayer.label = lspec.label;
                if (lspec.startTime !== undefined) newLayer.startTime = lspec.startTime;
                if (lspec.inPoint !== undefined) newLayer.inPoint = lspec.inPoint;
                if (lspec.outPoint !== undefined) newLayer.outPoint = lspec.outPoint;
                if (lspec.stretch !== undefined && lspec.stretch !== 100) {
                    try { newLayer.stretch = lspec.stretch; } catch (eSt) {}
                }
                if (lspec.threeDLayer !== undefined && newLayer instanceof AVLayer) {
                    try { newLayer.threeDLayer = lspec.threeDLayer; } catch (e3d) {}
                }
                // Apply transform properties
                if (lspec.transformGroup) {
                    AE.applyPropertyGroup(newLayer.property("Transform"), lspec.transformGroup, warn);
                }
                // Apply effects (create each effect by matchName, then fill values)
                if (lspec.effectsGroup && lspec.effectsGroup.groups) {
                    var fxRoot = newLayer.property("Effects");
                    for (var ei = 0; ei < lspec.effectsGroup.groups.length; ei++) {
                        var effSpec = lspec.effectsGroup.groups[ei];
                        try {
                            var addedEffect = fxRoot.addProperty(effSpec.matchName);
                            if (effSpec.name) addedEffect.name = effSpec.name;
                            AE.applyPropertyGroup(addedEffect, effSpec, warn);
                        } catch (eEff) {
                            warn("could not add effect " + effSpec.matchName + " on layer '" + lspec.name + "': " + AE.errText(eEff));
                        }
                    }
                }
                // Apply masks
                if (lspec.masksGroup && lspec.masksGroup.groups) {
                    var maskRoot = newLayer.property("Masks");
                    for (var mi = 0; mi < lspec.masksGroup.groups.length; mi++) {
                        var mSpec = lspec.masksGroup.groups[mi];
                        try {
                            var addedMask = maskRoot.addProperty("ADBE Mask Atom");
                            if (mSpec.name) addedMask.name = mSpec.name;
                            AE.applyPropertyGroup(addedMask, mSpec, warn);
                        } catch (eMsk) {
                            warn("could not add mask '" + mSpec.name + "' on layer '" + lspec.name + "': " + AE.errText(eMsk));
                        }
                    }
                }
                // Apply text source document / styling
                if (lspec.textGroup && newLayer instanceof TextLayer) {
                    AE.applyPropertyGroup(newLayer.property("Text"), lspec.textGroup, warn);
                }
                // Shape layer contents — recursively recreate shape groups
                if (lspec.contentsGroup && newLayer instanceof ShapeLayer) {
                    try {
                        var contentsRoot = newLayer.property("Contents");
                        AE.importShapeContents(contentsRoot, lspec.contentsGroup, warn);
                    } catch (eShape) {
                        warn("shape contents import failed for '" + lspec.name + "': " + AE.errText(eShape));
                    }
                }
                // Time Remap — must be enabled BEFORE applying keyframes
                if (lspec.timeRemapEnabled && newLayer instanceof AVLayer) {
                    try {
                        newLayer.timeRemapEnabled = true;
                        if (lspec.timeRemapProperty) {
                            AE.applyPropertyValue(newLayer.property("Time Remap"), lspec.timeRemapProperty);
                        }
                    } catch (eTr) {
                        warn("time remap restore failed for '" + lspec.name + "': " + AE.errText(eTr));
                    }
                }
                // Material Options (3D layers)
                if (lspec.materialOptionsGroup && newLayer instanceof AVLayer && newLayer.threeDLayer) {
                    try {
                        AE.applyPropertyGroup(newLayer.property("Material Options"), lspec.materialOptionsGroup, warn);
                    } catch (eMat) { /* ignore */ }
                }
                // Audio
                if (lspec.audioGroup && newLayer instanceof AVLayer) {
                    try {
                        AE.applyPropertyGroup(newLayer.property("Audio"), lspec.audioGroup, warn);
                    } catch (eAud) { /* ignore */ }
                }
                // Layer markers
                if (lspec.markers) {
                    try {
                        AE.applyPropertyValue(newLayer.property("Marker"), lspec.markers);
                    } catch (eLm) { warn("layer markers failed for '" + lspec.name + "': " + AE.errText(eLm)); }
                }
            } catch (eLayer) {
                warn("failed to create layer '" + (lspec.name || "?") + "' in comp '" + spec.name + "': " + AE.errText(eLayer));
            }
        }
    }

    // --- Pass 5: parentFolder assignment (items) ---
    for (i = 0; i < items.length; i++) {
        var spc = items[i];
        if (spc.parentFolderId == null) continue;
        var tgt = remap[String(spc.id)];
        var par = remap[String(spc.parentFolderId)];
        if (tgt && par && par instanceof FolderItem) {
            try { tgt.parentFolder = par; } catch (ePF) { warn("failed to set parentFolder on '" + spc.name + "': " + AE.errText(ePF)); }
        }
    }

    // --- Pass 6: layer parenting (within each comp) ---
    for (cb = 0; cb < compBindings.length; cb++) {
        var b2 = compBindings[cb];
        var compDst2 = b2.comp;
        var spec2 = b2.spec;
        if (!spec2.layers) continue;
        // Layers in the spec are in top-down order (index 1 first). After the
        // reverse-add pass above, the comp contains layers in the same order.
        for (var lk = 0; lk < spec2.layers.length; lk++) {
            var ls = spec2.layers[lk];
            if (ls.parentIndex == null) continue;
            try {
                var child = compDst2.layer(ls.index);
                var parent = compDst2.layer(ls.parentIndex);
                if (child && parent) child.parent = parent;
            } catch (eP) {
                warn("failed to set parent for layer index " + ls.index + " in comp '" + spec2.name + "': " + AE.errText(eP));
            }
        }
    }

    // Build a remap summary that's safe to serialize (just ids, not Item refs)
    var remapOut = {};
    for (var k in remap) {
        if (remap.hasOwnProperty(k) && remap[k]) {
            remapOut[k] = remap[k].id;
        }
    }

    return {
        ok: true,
        itemCount: items.length,
        createdCount: (function () {
            var n = 0;
            for (var kk in remap) { if (remap.hasOwnProperty(kk) && remap[kk]) n++; }
            return n;
        })(),
        remap: remapOut,
        warnings: warnings,
        logs: logs
    };
};

// Recreate the Contents of a Shape layer. Unlike Effects (which use addProperty
// with an effect matchName directly on the Effects group), shape contents use
// a fixed set of matchNames like "ADBE Vector Group", "ADBE Vector Shape - Rect",
// "ADBE Vector Graphic - Stroke", etc. We walk the exported group spec and
// recursively addProperty for each sub-group on the target.
AE.importShapeContents = function (target, spec, warn) {
    if (!target || !spec) return;
    // Leaf properties directly on this group
    if (spec.properties) {
        for (var pi = 0; pi < spec.properties.length; pi++) {
            var ps = spec.properties[pi];
            var prop = null;
            try { prop = target.property(ps.matchName); } catch (e1) {}
            if (!prop) { try { prop = target.property(ps.name); } catch (e2) {} }
            if (!prop) continue;
            try { AE.applyPropertyValue(prop, ps); } catch (eAp) { if (warn) warn("shape property '" + ps.name + "': " + AE.errText(eAp)); }
        }
    }
    // Sub-groups: add them via addProperty with matchName, then recurse
    if (spec.groups) {
        for (var gi = 0; gi < spec.groups.length; gi++) {
            var gs = spec.groups[gi];
            // Try to find an existing subgroup (shapes pre-populate certain
            // groups like "Transform" on Vector Groups). If missing, addProperty.
            var sub = null;
            try { sub = target.property(gs.matchName); } catch (eSub1) {}
            if (!sub) {
                try { sub = target.addProperty(gs.matchName); } catch (eAdd) {
                    if (warn) warn("could not add shape group " + gs.matchName + ": " + AE.errText(eAdd));
                    continue;
                }
            }
            if (sub) {
                if (gs.name && sub.name !== gs.name) { try { sub.name = gs.name; } catch (eNm) {} }
                AE.importShapeContents(sub, gs, warn);
            }
        }
    }
};

// Apply a serialized PropertyGroup (from helpers.serializePropertyGroup) onto
// a live PropertyGroup, matching by matchName where possible and falling back
// to name.
AE.applyPropertyGroup = function (target, spec, warn) {
    if (!target || !spec) return;
    // Leaf properties
    if (spec.properties) {
        for (var i = 0; i < spec.properties.length; i++) {
            var pspec = spec.properties[i];
            var prop = null;
            try { prop = target.property(pspec.matchName); } catch (e1) {}
            if (!prop) {
                try { prop = target.property(pspec.name); } catch (e2) {}
            }
            if (!prop) {
                // Some properties (like Separate Dimensions placeholders) may not exist on all layer types
                continue;
            }
            try { AE.applyPropertyValue(prop, pspec); }
            catch (eAp) { if (warn) warn("failed to apply property '" + pspec.name + "': " + AE.errText(eAp)); }
        }
    }
    // Nested groups — only recurse if the matching subgroup already exists
    // on the target (we don't auto-add, because effects/masks are handled
    // by the import pass before calling applyPropertyGroup).
    if (spec.groups) {
        for (var g = 0; g < spec.groups.length; g++) {
            var gspec = spec.groups[g];
            var sub = null;
            try { sub = target.property(gspec.matchName); } catch (e3) {}
            if (!sub) { try { sub = target.property(gspec.name); } catch (e4) {} }
            if (sub) AE.applyPropertyGroup(sub, gspec, warn);
        }
    }
};

// Convert a serialized value (possibly a __kind tagged object) back to a
// native ExtendScript value suitable for prop.setValue / keyframe apply.
AE.unwrapValue = function (val, existingTemplate) {
    if (val === null || val === undefined) return val;
    if (val.__kind === "TextDocument") {
        // Mutate an existing TextDocument (required because AE rejects
        // vanilla constructed documents in some cases).
        var tmpl = existingTemplate || null;
        if (!tmpl) tmpl = new TextDocument(val.text || "");
        if (val.text !== undefined) { try { tmpl.text = val.text; } catch (e) {} }
        if (val.font) { try { tmpl.font = val.font; } catch (e) {} }
        if (val.fontSize) { try { tmpl.fontSize = val.fontSize; } catch (e) {} }
        if (val.fillColor) { try { tmpl.fillColor = val.fillColor; } catch (e) {} }
        if (val.strokeColor) { try { tmpl.strokeColor = val.strokeColor; } catch (e) {} }
        if (val.strokeWidth !== undefined) { try { tmpl.strokeWidth = val.strokeWidth; } catch (e) {} }
        if (val.tracking !== undefined) { try { tmpl.tracking = val.tracking; } catch (e) {} }
        if (val.leading !== undefined) { try { tmpl.leading = val.leading; } catch (e) {} }
        if (val.baselineShift !== undefined) { try { tmpl.baselineShift = val.baselineShift; } catch (e) {} }
        if (val.applyFill !== undefined) { try { tmpl.applyFill = val.applyFill; } catch (e) {} }
        if (val.applyStroke !== undefined) { try { tmpl.applyStroke = val.applyStroke; } catch (e) {} }
        // Box text restoration only applies if we have size data
        if (val.boxText && val.boxTextSize) {
            try { tmpl.boxTextSize = val.boxTextSize; } catch (e) {}
            if (val.boxTextPos) { try { tmpl.boxTextPos = val.boxTextPos; } catch (e) {} }
        }
        return tmpl;
    }
    if (val.__kind === "Shape") {
        var sh = new Shape();
        sh.closed = !!val.closed;
        if (val.vertices) sh.vertices = val.vertices;
        if (val.inTangents) sh.inTangents = val.inTangents;
        if (val.outTangents) sh.outTangents = val.outTangents;
        return sh;
    }
    if (val.__kind === "MarkerValue") {
        var mv = new MarkerValue(val.comment || "");
        if (val.chapter) { try { mv.chapter = val.chapter; } catch (e) {} }
        if (val.url) { try { mv.url = val.url; } catch (e) {} }
        if (val.frameTarget) { try { mv.frameTarget = val.frameTarget; } catch (e) {} }
        if (val.cuePointName) { try { mv.cuePointName = val.cuePointName; } catch (e) {} }
        if (val.duration !== undefined) { try { mv.duration = val.duration; } catch (e) {} }
        if (val.label !== undefined) { try { mv.label = val.label; } catch (e) {} }
        if (val.protectedRegion !== undefined) { try { mv.protectedRegion = val.protectedRegion; } catch (e) {} }
        return mv;
    }
    return val;
};

AE.applyPropertyValue = function (prop, pspec) {
    var val = pspec.value;
    if (val !== null && val !== undefined) {
        var unwrapped = AE.unwrapValue(val, (val.__kind === "TextDocument") ? AE.safeGet(function () { return prop.value; }, null) : null);
        if (unwrapped !== null && unwrapped !== undefined) {
            try { prop.setValue(unwrapped); } catch (eSv) { /* some props are read-only; swallow */ }
        }
    }
    // Keyframes
    if (pspec.keyframes && pspec.keyframes.length > 0) {
        // Clear existing keys first
        while (prop.numKeys > 0) { try { prop.removeKey(1); } catch (eRk) { break; } }
        var times = [];
        var values = [];
        for (var k = 0; k < pspec.keyframes.length; k++) {
            var kf = pspec.keyframes[k];
            var kv = AE.unwrapValue(kf.value, (kf.value && kf.value.__kind === "TextDocument") ? AE.safeGet(function () { return prop.value; }, null) : null);
            times.push(kf.time);
            values.push(kv);
        }
        // Marker-valued keyframes must be set one at a time — setValuesAtTimes
        // doesn't accept MarkerValue arrays.
        var isMarker = (pspec.keyframes[0].value && pspec.keyframes[0].value.__kind === "MarkerValue");
        if (isMarker) {
            for (var km = 0; km < times.length; km++) {
                try { prop.setValueAtTime(times[km], values[km]); } catch (ePm) { /* ignore */ }
            }
        } else {
            try {
                prop.setValuesAtTimes(times, values);
            } catch (eKf) {
                // Fallback: per-key
                for (var kk = 0; kk < times.length; kk++) {
                    try { prop.setValueAtTime(times[kk], values[kk]); } catch (ePk) {}
                }
            }
        }
        // Apply interpolation types (spatial vs temporal handled by setInterpolationTypeAtKey's two-arg form)
        for (var ki = 0; ki < pspec.keyframes.length; ki++) {
            var kfI = pspec.keyframes[ki];
            if (kfI.inInterp != null && kfI.outInterp != null) {
                try { prop.setInterpolationTypeAtKey(ki + 1, kfI.inInterp, kfI.outInterp); } catch (eI) {}
            }
        }
    }
    // Expression
    if (pspec.expression && prop.canSetExpression) {
        try { prop.expression = pspec.expression; prop.expressionEnabled = true; } catch (eEx) {}
    }
};
