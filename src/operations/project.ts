// Project-level operations — clear, delete item, find layers, list effects.

import { registerOp, jsxVal, jsxCompPreamble } from "../registry.js";
import { knownBitDepthTable } from "../effects/pipl.js";
import { readOnlyMode } from "../policy.js";
import { UNDO_COMMAND_ID } from "./command.js";

/**
 * Most Adobe effects project.list_effects measures in one call (bitDepth:
 * true). Each renders a throwaway layer twice — ~0.4 s, up to ~1.3 s (AE
 * 26.5) — so this keeps a worst case inside the default 60 s timeout.
 */
const BIT_DEPTH_LIST_LIMIT = 25;

registerOp({
  name: "project.open",
  category: "project",
  description: "Open a .aep project file. Closes the current project without saving.",
  params: [
    { name: "path", type: "string", description: "Absolute path to .aep file", required: true },
    {
      name: "save",
      type: "boolean",
      description: "Save current project before closing (default false)",
      required: false,
    },
  ],
  // Runs OUTSIDE the dispatcher's undo group, same class as undo/redo:
  // replacing the project while a group is open orphans that group — the
  // endUndoGroup after app.open() closes nothing that exists anymore. AE 26
  // flags it with an async "UndoGroup Mismatch" dialog and undo stays broken
  // for the rest of the session. An undo group is meaningless across a
  // project boundary anyway: closing destroys the undo stack it would guard.
  undoGroup: () => false,
  toJsx(args) {
    return `
            if (${jsxVal(!!args.save)} && app.project.file) app.project.save();
            var f = new File(${jsxVal(args.path)});
            if (!f.exists) return { ok: false, error: "file not found: " + ${jsxVal(args.path)} };
            app.open(f);
            return { ok: true, numItems: app.project.numItems, file: app.project.file.fsName.replace(/\\\\/g,"/") };
        `;
  },
});

registerOp({
  name: "project.import_file",
  category: "project",
  description:
    "Import a file (image, video, audio) into the project as footage. Pass sequence=true with the first file of an image sequence to import the whole sequence.",
  params: [
    { name: "path", type: "string", description: "Absolute file path", required: true },
    { name: "name", type: "string", description: "Rename the imported item", required: false },
    {
      name: "sequence",
      type: "boolean",
      description: "Import as image sequence starting at path (default false)",
      required: false,
      default: false,
    },
    {
      name: "forceAlphabetical",
      type: "boolean",
      description: "Sequence only: force alphabetical order (default false)",
      required: false,
    },
    {
      name: "importAs",
      type: "string",
      description:
        "footage|comp|compRetainLayerSizes|project — for layered files like .psd/.ai (default footage)",
      required: false,
    },
    {
      name: "rangeStart",
      type: "number",
      description: "Sequence only: first frame number to import (ImportOptions.rangeStart)",
      required: false,
    },
    {
      name: "rangeEnd",
      type: "number",
      description: "Sequence only: last frame number to import (ImportOptions.rangeEnd)",
      required: false,
    },
  ],
  toJsx(args) {
    const rangeSets: string[] = [];
    if (args.rangeStart !== undefined)
      rangeSets.push(
        `try { imp.rangeStart = ${jsxVal(args.rangeStart)}; } catch (eRs) { return { ok: false, error: "rangeStart not supported on this AE: " + AE.errText(eRs) }; }`,
      );
    if (args.rangeEnd !== undefined)
      rangeSets.push(
        `try { imp.rangeEnd = ${jsxVal(args.rangeEnd)}; } catch (eRe) { return { ok: false, error: "rangeEnd not supported on this AE: " + AE.errText(eRe) }; }`,
      );
    return `
            var f = new File(${jsxVal(args.path)});
            if (!f.exists) return { ok: false, error: "file not found" };
            var imp = new ImportOptions(f);
            if (${jsxVal(!!args.sequence)}) {
                imp.sequence = true;
                imp.forceAlphabetical = ${jsxVal(!!args.forceAlphabetical)};
                ${rangeSets.join("\n")}
            }
            var _importAs = ${jsxVal(args.importAs ?? null)};
            if (_importAs !== null) {
                var _iaMap = { "footage": ImportAsType.FOOTAGE, "comp": ImportAsType.COMP, "compRetainLayerSizes": ImportAsType.COMP_CROPPED_LAYERS, "project": ImportAsType.PROJECT };
                if (_iaMap[_importAs] === undefined) return { ok: false, error: "unknown importAs: " + _importAs };
                if (!imp.canImportAs(_iaMap[_importAs])) return { ok: false, error: "file cannot be imported as " + _importAs };
                imp.importAs = _iaMap[_importAs];
            }
            var item = app.project.importFile(imp);
            ${args.name ? `item.name = ${jsxVal(args.name)};` : ""}
            var _out = { ok: true, id: item.id, name: item.name };
            try { _out.width = item.width; _out.height = item.height; _out.duration = item.duration; } catch (eDim) {}
            return _out;
        `;
  },
});

registerOp({
  name: "project.undo",
  category: "project",
  description:
    "Undo the last action. Equivalent to Ctrl+Z. Each prior ae_do call is ONE undo step (its automatic undo group), so count=1 reverts the whole previous call, batch included.",
  params: [
    {
      name: "count",
      type: "number",
      description: "Number of undos (default 1)",
      required: false,
      default: 1,
    },
  ],
  // Runs OUTSIDE the dispatcher's automatic undo group. Wrapped in one, AE
  // resolves each Undo against the group that is still open: the previous
  // call — the one the caller wants back — is never reverted, and the group
  // this call closes afterwards leaves the stack out of step with the project.
  // Dialog suppression opens the same kind of scope, so it opts out of both.
  undoGroup: () => false,
  suppressDialogs: () => false,
  toJsx(args) {
    // Menu command ID (see command.list / hyperbrew command-ID table): 16 = Undo.
    return `
            var n = ${jsxVal(args.count ?? 1)};
            for (var i = 0; i < n; i++) app.executeCommand(${UNDO_COMMAND_ID});
            return { ok: true, undone: n };
        `;
  },
});

registerOp({
  name: "project.purge",
  category: "project",
  description: "Purge AE memory/disk caches. Use when AE is consuming too much RAM.",
  params: [
    {
      name: "target",
      type: "string",
      description: "all|image|undo (default 'all')",
      required: false,
      default: "all",
    },
  ],
  toJsx(args) {
    return `
            var t = ${jsxVal(args.target ?? "all")};
            if (t === "all") { app.purge(PurgeTarget.ALL_CACHES); }
            else if (t === "image") { app.purge(PurgeTarget.IMAGE_CACHES); }
            else if (t === "undo") { app.purge(PurgeTarget.UNDO_CACHES); }
            else { app.purge(PurgeTarget.ALL_CACHES); }
            return { ok: true, purged: t, memoryInUse: app.memoryInUse };
        `;
  },
});

registerOp({
  name: "project.replace_font",
  category: "project",
  description: "Replace a font throughout the entire project. Useful for font substitution.",
  params: [
    {
      name: "fromFont",
      type: "string",
      description: "Current font postscript name to replace",
      required: true,
    },
    { name: "toFont", type: "string", description: "New font postscript name", required: true },
  ],
  toJsx(args) {
    // app.project.replaceFont (AE 24.5+) takes Font OBJECTS, not PostScript-name
    // strings — resolve via app.fonts.getFontsByPostScriptName first.
    return `
            if (!app.fonts || !app.fonts.getFontsByPostScriptName) {
                return { ok: false, error: "app.fonts.getFontsByPostScriptName is unavailable in this AE version (requires AE 24.0+)" };
            }
            if (!app.project.replaceFont) {
                return { ok: false, error: "app.project.replaceFont is unavailable in this AE version (requires AE 24.5+)" };
            }
            var _fromFonts = app.fonts.getFontsByPostScriptName(${jsxVal(args.fromFont)});
            if (!_fromFonts || _fromFonts.length === 0) {
                return { ok: false, error: "no installed font matches PostScript name " + ${jsxVal(args.fromFont)} };
            }
            var _toFonts = app.fonts.getFontsByPostScriptName(${jsxVal(args.toFont)});
            if (!_toFonts || _toFonts.length === 0) {
                return { ok: false, error: "no installed font matches PostScript name " + ${jsxVal(args.toFont)} };
            }
            try {
                app.project.replaceFont(_fromFonts[0], _toFonts[0]);
                return { ok: true, from: ${jsxVal(args.fromFont)}, to: ${jsxVal(args.toFont)} };
            } catch(e) {
                return { ok: false, error: "replaceFont failed: " + AE.errText(e) };
            }
        `;
  },
});

registerOp({
  name: "project.auto_fix_expressions",
  category: "project",
  description:
    "Find and replace text in all expressions across the project. Useful after renaming layers/comps.",
  params: [
    { name: "oldText", type: "string", description: "Text to find in expressions", required: true },
    { name: "newText", type: "string", description: "Replacement text", required: true },
  ],
  toJsx(args) {
    return `
            app.project.autoFixExpressions(${jsxVal(args.oldText)}, ${jsxVal(args.newText)});
            return { ok: true, replaced: ${jsxVal(args.oldText)}, with: ${jsxVal(args.newText)} };
        `;
  },
});

registerOp({
  name: "project.clear",
  category: "project",
  description: "Remove ALL items from the project. Destructive — use with caution.",
  params: [],
  toJsx() {
    return `
            var proj = app.project;
            var toRemove = [];
            for (var i = 1; i <= proj.numItems; i++) toRemove.push(proj.item(i));
            var removed = 0;
            for (var j = 0; j < toRemove.length; j++) {
                try { toRemove[j].remove(); removed++; } catch (e) {}
            }
            return { ok: true, removed: removed, remaining: proj.numItems };
        `;
  },
});

registerOp({
  name: "project.delete_item",
  category: "project",
  description: "Delete a project item by id.",
  params: [{ name: "itemId", type: "number", description: "Numeric item id", required: true }],
  toJsx(args) {
    return `
            var _target = AE.findItemById(${jsxVal(args.itemId)});
            if (!_target) return { ok: false, error: "no item with id " + ${jsxVal(args.itemId)} };
            var _name = _target.name;
            _target.remove();
            return { ok: true, removed: _name };
        `;
  },
});

registerOp({
  name: "project.find_layers",
  category: "project",
  readOnly: true,
  description: "Search layers by name pattern and/or type across one or all comps.",
  params: [
    {
      name: "comp",
      type: "any",
      description: "Restrict to one comp (name or id). Omit to search all.",
      required: false,
    },
    {
      name: "namePattern",
      type: "string",
      description: "Case-insensitive substring match on layer name",
      required: false,
    },
    {
      name: "type",
      type: "string",
      description:
        "AVLayer|TextLayer|ShapeLayer|CameraLayer|LightLayer|ThreeDModelLayer|ParametricMeshLayer",
      required: false,
    },
    {
      name: "limit",
      type: "number",
      description: "Max results (default 100)",
      required: false,
      default: 100,
    },
  ],
  toJsx(args) {
    return `
            var _namePat = ${jsxVal(((args.namePattern as string) ?? "").toLowerCase())};
            var _type = ${jsxVal(args.type ?? null)};
            var _limit = ${jsxVal(args.limit ?? 100)};
            var _arg = ${args.comp !== undefined ? jsxVal(args.comp) : "null"};
            var comps = [];
            if (_arg !== null) {
                var c = AE.findCompByNameOrId(_arg);
                if (!c) return { ok: false, error: "no comp matching " + String(_arg) };
                comps.push(c);
            } else {
                for (var i = 1; i <= app.project.numItems; i++) {
                    if (app.project.item(i) instanceof CompItem) comps.push(app.project.item(i));
                }
            }
            function typeName(layer) {
                // 3D model / parametric mesh classes only exist on AE 24.4+ /
                // 26.3+ — probe before instanceof, and before the AVLayer
                // fallback (both are AVLayer subclasses).
                try { if (typeof ThreeDModelLayer !== "undefined" && layer instanceof ThreeDModelLayer) return "ThreeDModelLayer"; } catch (e3d) {}
                try { if (typeof ParametricMeshLayer !== "undefined" && layer instanceof ParametricMeshLayer) return "ParametricMeshLayer"; } catch (ePm) {}
                if (layer instanceof TextLayer) return "TextLayer";
                if (layer instanceof ShapeLayer) return "ShapeLayer";
                if (layer instanceof CameraLayer) return "CameraLayer";
                if (layer instanceof LightLayer) return "LightLayer";
                if (layer instanceof AVLayer) return "AVLayer";
                return "Layer";
            }
            var matches = [];
            for (var ci = 0; ci < comps.length; ci++) {
                var comp = comps[ci];
                for (var li = 1; li <= comp.numLayers; li++) {
                    var layer = comp.layer(li);
                    var tn = typeName(layer);
                    if (_type && tn !== _type) continue;
                    if (_namePat && String(layer.name).toLowerCase().indexOf(_namePat) === -1) continue;
                    matches.push({ compId: comp.id, compName: comp.name, index: layer.index, name: layer.name, type: tn });
                    if (matches.length >= _limit) break;
                }
                if (matches.length >= _limit) break;
            }
            return { ok: true, matches: matches, count: matches.length };
        `;
  },
});

registerOp({
  name: "project.list_effects",
  category: "project",
  readOnly: true,
  description:
    "List available effect matchNames in the running AE. Uses app.effects if available, otherwise a curated list. " +
    "Narrow with category / search; bitDepth: true also measures each listed effect's processing depth (see effect.bit_depth) " +
    `— plug-in effects are read from their PiPL instantly, Adobe effects are rendered once (at most ${BIT_DEPTH_LIST_LIMIT} per call), so filter first. In a 32bpc project, choose effects with bpc 32.`,
  params: [
    {
      name: "category",
      type: "string",
      description: "Only effects in this category (case-insensitive, e.g. 'Blur & Sharpen')",
      required: false,
    },
    {
      name: "search",
      type: "string",
      description:
        "Only effects whose displayName or matchName contains this text (case-insensitive)",
      required: false,
    },
    {
      name: "bitDepth",
      type: "boolean",
      description: `Add each listed effect's processing bpc (32/16/8, null = unknown, see bpcReason). At most ${BIT_DEPTH_LIST_LIMIT} effects needing a render measurement per call; results are cached for the session.`,
      required: false,
      default: false,
    },
  ],
  toJsx(args) {
    // Measuring adds and removes a throwaway comp (and may flip the project to
    // 32bpc for the duration) — invisible afterwards, but not "cannot modify".
    if (args.bitDepth === true && readOnlyMode()) {
      return `return { ok: false, error: "bitDepth measures effects on a temporary comp, which AE_MCP_READONLY=1 does not allow" };`;
    }
    return `
            var _cat = ${jsxVal(typeof args.category === "string" ? args.category.toLowerCase() : null)};
            var _q = ${jsxVal(typeof args.search === "string" ? args.search.toLowerCase() : null)};
            var _measure = ${jsxVal(args.bitDepth === true)};
            var _known = ${jsxVal(args.bitDepth === true ? knownBitDepthTable() : {})};
            var list = null;
            try {
                // app.effects builds a fresh array on every access: read it
                // once (indexing it inside the loop took ~13 s for 640 effects).
                var _all = app.effects;
                if (_all && _all.length) {
                    list = [];
                    for (var i = 0; i < _all.length; i++) {
                        var _e = _all[i];
                        if (_cat !== null && String(_e.category).toLowerCase() !== _cat) continue;
                        if (_q !== null && String(_e.displayName).toLowerCase().indexOf(_q) === -1 && String(_e.matchName).toLowerCase().indexOf(_q) === -1) continue;
                        list.push({ displayName: _e.displayName, matchName: _e.matchName, category: _e.category });
                    }
                }
            } catch (e) {}
            if (list && _measure) {
                // Plug-in effects are answered from their PiPL and earlier
                // measurements from the cache; only the rest render.
                var _cache = $.global.AE_MCP_BIT_DEPTH_CACHE || {};
                var _toMeasure = 0;
                for (var m = 0; m < list.length; m++) {
                    var _mn = String(list[m].matchName);
                    if (_mn.indexOf("ADBE ") === 0 && !_known.hasOwnProperty(_mn) && !_cache.hasOwnProperty("mn:" + _mn)) _toMeasure++;
                }
                if (_toMeasure > ${BIT_DEPTH_LIST_LIMIT}) {
                    return { ok: false, error: list.length + " effects match, " + _toMeasure + " of them need measuring — bitDepth measures at most ${BIT_DEPTH_LIST_LIMIT} per call", hint: "Narrow with category or search, or pass the candidates to effect.bit_depth." };
                }
                for (var j = 0; j < list.length; j++) {
                    var _d = AE.effectBitDepth(list[j].matchName, _known.hasOwnProperty(list[j].matchName) ? { bpc: _known[list[j].matchName] } : null);
                    list[j].bpc = _d.bpc;
                    if (_d.bpc === null) list[j].bpcReason = _d.reason;
                }
            }
            if (list) return { source: "app.effects", projectBpc: app.project.bitsPerChannel, effects: list };
            return {
                source: "curated",
                effects: [
                    { displayName: "Fast Box Blur", matchName: "ADBE Box Blur2" },
                    { displayName: "Gaussian Blur", matchName: "ADBE Gaussian Blur 2" },
                    { displayName: "Glow", matchName: "ADBE Glo2" },
                    { displayName: "Drop Shadow", matchName: "ADBE Drop Shadow" },
                    { displayName: "Fill", matchName: "ADBE Fill" },
                    { displayName: "Tint", matchName: "ADBE Tint" },
                    { displayName: "Hue/Saturation", matchName: "ADBE HUE SATURATION" },
                    { displayName: "Levels", matchName: "ADBE Easy Levels2" },
                    { displayName: "Curves", matchName: "ADBE CurvesCustom" },
                    { displayName: "Brightness & Contrast", matchName: "ADBE Brightness & Contrast 2" },
                    { displayName: "Turbulent Noise", matchName: "ADBE Turbulent Noise" },
                    { displayName: "Transform", matchName: "ADBE Geometry2" },
                    { displayName: "Linear Wipe", matchName: "ADBE Linear Wipe" },
                    { displayName: "Radial Wipe", matchName: "ADBE Radial Wipe" }
                ]
            };
        `;
  },
});

registerOp({
  name: "comp.precompose",
  category: "comp",
  description: "Pre-compose selected layers into a new nested composition.",
  params: [
    { name: "comp", type: "any", description: "Source comp name or id", required: true },
    {
      name: "layerIndices",
      type: "array",
      description: "Array of 1-based layer indices to precompose",
      required: true,
    },
    { name: "newName", type: "string", description: "Name for the new comp", required: true },
    {
      name: "moveAll",
      type: "boolean",
      description: "Move all attributes into new comp (default true)",
      required: false,
      default: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _indices = ${jsxVal(args.layerIndices)};
            var newComp = _comp.layers.precompose(_indices, ${jsxVal(args.newName)}, ${jsxVal(args.moveAll !== false)});
            return { ok: true, newCompId: newComp.id, newCompName: newComp.name };
        `;
  },
});

registerOp({
  name: "comp.duplicate",
  category: "comp",
  description: "Duplicate a composition.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id to duplicate", required: true },
    { name: "newName", type: "string", description: "Name for the duplicate", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _dup = _comp.duplicate();
            ${args.newName ? `_dup.name = ${jsxVal(args.newName)};` : ""}
            return { ok: true, newCompId: _dup.id, newCompName: _dup.name };
        `;
  },
});

registerOp({
  name: "project.set_settings",
  category: "project",
  description:
    "Set project-wide settings: color depth, expression engine, working color space, time display.",
  params: [
    {
      name: "bitsPerChannel",
      type: "number",
      description: "Color depth: 8, 16, or 32",
      required: false,
    },
    {
      name: "expressionEngine",
      type: "string",
      description: "'javascript-1.0' or 'extendscript'",
      required: false,
    },
    {
      name: "workingSpace",
      type: "string",
      description:
        "Working color space name (see project.get_settings includeColorProfiles), or '' for None",
      required: false,
    },
    {
      name: "workingGamma",
      type: "number",
      description: "Working gamma: 2.2 or 2.4",
      required: false,
    },
    {
      name: "linearBlending",
      type: "boolean",
      description: "Blend colors using 1.0 gamma",
      required: false,
    },
    { name: "timeDisplayType", type: "string", description: "timecode|frames", required: false },
    {
      name: "framesUseFeetFrames",
      type: "boolean",
      description: "Use feet+frames for frame display",
      required: false,
    },
    {
      name: "framesCountType",
      type: "string",
      description: "start0|start1|timecode",
      required: false,
    },
    {
      name: "transparencyGridThumbnails",
      type: "boolean",
      description: "Show checkerboard in thumbnails",
      required: false,
    },
    {
      name: "gpuAccelType",
      type: "string",
      description: "software|opencl|cuda|metal",
      required: false,
    },
    {
      name: "linearizeWorkingSpace",
      type: "boolean",
      description: "Linearize the working color space (AE 16.0+)",
      required: false,
    },
    {
      name: "compensateForSceneReferredProfiles",
      type: "boolean",
      description: "Compensate for scene-referred profiles (AE 16.0+)",
      required: false,
    },
    {
      name: "displayStartFrame",
      type: "number",
      description: "Frame count starts at 0 or 1 (when counting frames)",
      required: false,
    },
    {
      name: "feetFramesFilmType",
      type: "string",
      description: "mm16|mm35 (film type for feet+frames display)",
      required: false,
    },
    {
      name: "footageTimecodeDisplayStartType",
      type: "string",
      description: "start0|useSourceMedia (footage timecode start)",
      required: false,
    },
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.linearizeWorkingSpace !== undefined)
      sets.push(
        `try { app.project.linearizeWorkingSpace = ${jsxVal(args.linearizeWorkingSpace)}; } catch (e) { _w.push("linearizeWorkingSpace (AE 16.0+): " + AE.errText(e)); }`,
      );
    if (args.compensateForSceneReferredProfiles !== undefined)
      sets.push(
        `try { app.project.compensateForSceneReferredProfiles = ${jsxVal(args.compensateForSceneReferredProfiles)}; } catch (e) { _w.push("compensateForSceneReferredProfiles (AE 16.0+): " + AE.errText(e)); }`,
      );
    if (args.displayStartFrame !== undefined)
      sets.push(
        `try { app.project.displayStartFrame = ${jsxVal(args.displayStartFrame)}; } catch (e) { _w.push("displayStartFrame: " + AE.errText(e)); }`,
      );
    if (args.feetFramesFilmType !== undefined)
      sets.push(`
        try {
            var _ffMap = { "mm16": FeetFramesFilmType.MM16, "mm35": FeetFramesFilmType.MM35 };
            if (_ffMap.hasOwnProperty(${jsxVal(args.feetFramesFilmType)})) { app.project.feetFramesFilmType = _ffMap[${jsxVal(args.feetFramesFilmType)}]; }
            else { _w.push("feetFramesFilmType: pass mm16 or mm35"); }
        } catch (e) { _w.push("feetFramesFilmType: " + AE.errText(e)); }`);
    if (args.footageTimecodeDisplayStartType !== undefined)
      sets.push(`
        try {
            var _ftMap = { "start0": FootageTimecodeDisplayStartType.FTCS_START_0, "useSourceMedia": FootageTimecodeDisplayStartType.FTCS_USE_SOURCE_MEDIA };
            if (_ftMap.hasOwnProperty(${jsxVal(args.footageTimecodeDisplayStartType)})) { app.project.footageTimecodeDisplayStartType = _ftMap[${jsxVal(args.footageTimecodeDisplayStartType)}]; }
            else { _w.push("footageTimecodeDisplayStartType: pass start0 or useSourceMedia"); }
        } catch (e) { _w.push("footageTimecodeDisplayStartType: " + AE.errText(e)); }`);
    if (args.bitsPerChannel !== undefined)
      sets.push(
        `try { app.project.bitsPerChannel = ${jsxVal(args.bitsPerChannel)}; } catch (e) { _w.push("bitsPerChannel: " + AE.errText(e)); }`,
      );
    if (args.expressionEngine !== undefined)
      sets.push(
        `try { app.project.expressionEngine = ${jsxVal(args.expressionEngine)}; } catch (e) { _w.push("expressionEngine: " + AE.errText(e)); }`,
      );
    if (args.workingSpace !== undefined)
      sets.push(
        `try { app.project.workingSpace = ${jsxVal(args.workingSpace)}; } catch (e) { _w.push("workingSpace: " + AE.errText(e)); }`,
      );
    if (args.workingGamma !== undefined)
      sets.push(
        `try { app.project.workingGamma = ${jsxVal(args.workingGamma)}; } catch (e) { _w.push("workingGamma: " + AE.errText(e)); }`,
      );
    if (args.linearBlending !== undefined)
      sets.push(
        `try { app.project.linearBlending = ${jsxVal(args.linearBlending)}; } catch (e) { _w.push("linearBlending: " + AE.errText(e)); }`,
      );
    if (args.timeDisplayType !== undefined)
      sets.push(`
        try {
            app.project.timeDisplayType = ${jsxVal(args.timeDisplayType)} === "frames" ? TimeDisplayType.FRAMES : TimeDisplayType.TIMECODE;
        } catch (e) { _w.push("timeDisplayType: " + AE.errText(e)); }`);
    if (args.framesUseFeetFrames !== undefined)
      sets.push(
        `try { app.project.framesUseFeetFrames = ${jsxVal(args.framesUseFeetFrames)}; } catch (e) { _w.push("framesUseFeetFrames: " + AE.errText(e)); }`,
      );
    if (args.framesCountType !== undefined)
      sets.push(`
        try {
            var _fcMap = { "start0": FramesCountType.FC_START_0, "start1": FramesCountType.FC_START_1, "timecode": FramesCountType.FC_TIMECODE_CONVERSION };
            if (_fcMap[${jsxVal(args.framesCountType)}] === undefined) { _w.push("framesCountType: unknown value"); }
            else { app.project.framesCountType = _fcMap[${jsxVal(args.framesCountType)}]; }
        } catch (e) { _w.push("framesCountType: " + AE.errText(e)); }`);
    if (args.transparencyGridThumbnails !== undefined)
      sets.push(
        `try { app.project.transparencyGridThumbnails = ${jsxVal(args.transparencyGridThumbnails)}; } catch (e) { _w.push("transparencyGridThumbnails: " + AE.errText(e)); }`,
      );
    if (args.gpuAccelType !== undefined)
      sets.push(`
        try {
            var _gpuMap = { "software": GpuAccelType.SOFTWARE, "opencl": GpuAccelType.OPENCL, "cuda": GpuAccelType.CUDA, "metal": GpuAccelType.METAL };
            if (_gpuMap[${jsxVal(args.gpuAccelType)}] === undefined) { _w.push("gpuAccelType: unknown value"); }
            else { app.project.gpuAccelType = _gpuMap[${jsxVal(args.gpuAccelType)}]; }
        } catch (e) { _w.push("gpuAccelType: " + AE.errText(e)); }`);
    return `
            var _w = [];
            ${sets.join("\n")}
            return { ok: true, warnings: _w, bitsPerChannel: app.project.bitsPerChannel };
        `;
  },
});

registerOp({
  name: "project.get_settings",
  category: "project",
  readOnly: true,
  description:
    "Read project-wide settings: color depth, expression engine, working color space, time display. Pass includeColorProfiles=true to list installed color profile names.",
  params: [
    {
      name: "includeColorProfiles",
      type: "boolean",
      description: "Also return installed color profile names (default false)",
      required: false,
      default: false,
    },
  ],
  toJsx(args) {
    return `
            var _p = app.project;
            var _out = {
                ok: true,
                file: _p.file ? _p.file.fsName.replace(/\\\\/g, "/") : null,
                numItems: _p.numItems,
                bitsPerChannel: AE.safeGet(function () { return _p.bitsPerChannel; }, null),
                expressionEngine: AE.safeGet(function () { return _p.expressionEngine; }, null),
                workingSpace: AE.safeGet(function () { return _p.workingSpace; }, null),
                workingGamma: AE.safeGet(function () { return _p.workingGamma; }, null),
                linearBlending: AE.safeGet(function () { return _p.linearBlending; }, null),
                framesUseFeetFrames: AE.safeGet(function () { return _p.framesUseFeetFrames; }, null),
                transparencyGridThumbnails: AE.safeGet(function () { return _p.transparencyGridThumbnails; }, null),
                gpuAccelType: AE.safeGet(function () { return String(_p.gpuAccelType); }, null),
                timeDisplayType: AE.safeGet(function () { return _p.timeDisplayType === TimeDisplayType.FRAMES ? "frames" : "timecode"; }, null),
                linearizeWorkingSpace: AE.safeGet(function () { return _p.linearizeWorkingSpace; }, null),
                compensateForSceneReferredProfiles: AE.safeGet(function () { return _p.compensateForSceneReferredProfiles; }, null),
                displayStartFrame: AE.safeGet(function () { return _p.displayStartFrame; }, null),
                feetFramesFilmType: AE.safeGet(function () { var _ff = _p.feetFramesFilmType; if (_ff === FeetFramesFilmType.MM16) return "mm16"; if (_ff === FeetFramesFilmType.MM35) return "mm35"; return String(_ff); }, null),
                footageTimecodeDisplayStartType: AE.safeGet(function () { var _ft = _p.footageTimecodeDisplayStartType; if (_ft === FootageTimecodeDisplayStartType.FTCS_START_0) return "start0"; if (_ft === FootageTimecodeDisplayStartType.FTCS_USE_SOURCE_MEDIA) return "useSourceMedia"; return String(_ft); }, null)
            };
            if (${jsxVal(!!args.includeColorProfiles)}) {
                try { _out.colorProfiles = _p.listColorProfiles(); } catch (eCp) { _out.colorProfiles = null; }
            }
            return _out;
        `;
  },
});

registerOp({
  name: "project.reduce",
  category: "project",
  description:
    "Reduce the project to only the given comps and everything they use (Project.reduceProject). Removes all other items — save a copy first.",
  params: [
    { name: "comps", type: "array", description: "Comp names or ids to keep", required: true },
  ],
  toJsx(args) {
    return `
            var _targets = ${jsxVal(args.comps)};
            var _items = [];
            for (var _i = 0; _i < _targets.length; _i++) {
                var _c = AE.findCompByNameOrId(_targets[_i]);
                if (!_c) return { ok: false, error: "no comp matching " + _targets[_i] };
                _items.push(_c);
            }
            var _removed = app.project.reduceProject(_items);
            return { ok: true, removed: _removed, kept: _items.length, numItems: app.project.numItems };
        `;
  },
});

registerOp({
  name: "project.remove_unused_footage",
  category: "project",
  description:
    "Remove all footage items that are not used in any comp (Project.removeUnusedFootage).",
  params: [],
  toJsx() {
    return `
            var _removed = app.project.removeUnusedFootage();
            return { ok: true, removed: _removed, numItems: app.project.numItems };
        `;
  },
});

registerOp({
  name: "project.consolidate_footage",
  category: "project",
  description:
    "Merge duplicate footage items into one and update layer references (Project.consolidateFootage).",
  params: [],
  toJsx() {
    return `
            var _consolidated = app.project.consolidateFootage();
            return { ok: true, consolidated: _consolidated, numItems: app.project.numItems };
        `;
  },
});

registerOp({
  name: "project.import_placeholder",
  category: "project",
  description:
    "Create a placeholder footage item (Project.importPlaceholder) to build comps before the real footage exists. Relink later with footage.replace.",
  params: [
    { name: "name", type: "string", description: "Placeholder name", required: true },
    { name: "width", type: "number", description: "Width in px", required: true },
    { name: "height", type: "number", description: "Height in px", required: true },
    { name: "frameRate", type: "number", description: "Frame rate", required: true },
    { name: "duration", type: "number", description: "Duration in seconds", required: true },
  ],
  toJsx(args) {
    return `
            var _item = null;
            try {
                _item = app.project.importPlaceholder(${jsxVal(args.name)}, ${jsxVal(args.width)}, ${jsxVal(args.height)}, ${jsxVal(args.frameRate)}, ${jsxVal(args.duration)});
            } catch (eIp) { return { ok: false, error: "importPlaceholder failed: " + AE.errText(eIp) }; }
            return { ok: true, id: _item.id, name: _item.name, width: _item.width, height: _item.height, duration: _item.duration };
        `;
  },
});

registerOp({
  name: "project.new",
  category: "project",
  description:
    "Create a NEW empty project (app.newProject). Closes the current project — pass save=true to save it first (only works when it has a file path). Destructive to unsaved work.",
  params: [
    {
      name: "save",
      type: "boolean",
      description: "Save the current project before closing (default false; needs a file path)",
      required: false,
      default: false,
    },
  ],
  // Outside the undo group for the same reason as project.open above.
  undoGroup: () => false,
  toJsx(args) {
    // close(DO_NOT_SAVE_CHANGES) BEFORE newProject: calling newProject on a
    // dirty project pops the "Save changes?" modal, which blocks all scripting
    // (beginSuppressDialogs does not cover confirmation dialogs) — the E2E run
    // that discovered this had to be recovered with taskkill.
    return `
            if (${jsxVal(!!args.save)}) {
                if (app.project.file) { app.project.save(); }
                else if (app.project.numItems > 0) { return { ok: false, error: "current project has no file path — save it first (ae_save_project with a path) or pass save=false to discard" }; }
            }
            app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
            var _p = app.newProject();
            if (!_p) return { ok: false, error: "app.newProject returned null" };
            return { ok: true, numItems: _p.numItems };
        `;
  },
});

registerOp({
  name: "project.parse_swatch",
  category: "project",
  readOnly: true,
  description:
    "Parse an Adobe swatch file (.ase) and return its colors (app.parseSwatchFile) - feed brand palettes to fills, solids, and text colors.",
  params: [
    { name: "path", type: "string", description: "Absolute path to the .ase file", required: true },
  ],
  toJsx(args) {
    return `
            var _f = new File(${jsxVal(args.path)});
            if (!_f.exists) return { ok: false, error: "file not found: " + ${jsxVal(args.path)} };
            var _sw = null;
            try { _sw = app.parseSwatchFile(_f); } catch (eSw) { return { ok: false, error: "parseSwatchFile failed: " + AE.errText(eSw) }; }
            return { ok: true, swatch: AE.valueToJson(_sw) };
        `;
  },
});

registerOp({
  name: "project.get_xmp",
  category: "project",
  readOnly: true,
  description: "Read the project's XMP metadata packet (Project.xmpPacket) as an RDF/XML string.",
  params: [],
  toJsx() {
    return `
            var _xmp = null;
            try { _xmp = app.project.xmpPacket; } catch (eX) { return { ok: false, error: "xmpPacket read failed: " + AE.errText(eX) }; }
            return { ok: true, length: _xmp ? _xmp.length : 0, xmp: _xmp };
        `;
  },
});

registerOp({
  name: "project.set_xmp",
  category: "project",
  description:
    "Replace the project's XMP metadata packet (Project.xmpPacket). Pass a complete, well-formed RDF/XML packet - AE does not validate fragments.",
  params: [
    { name: "xmp", type: "string", description: "Complete XMP packet (RDF/XML)", required: true },
  ],
  toJsx(args) {
    return `
            try { app.project.xmpPacket = ${jsxVal(args.xmp)}; } catch (eX) { return { ok: false, error: "xmpPacket write failed: " + AE.errText(eX) }; }
            return { ok: true, length: app.project.xmpPacket.length };
        `;
  },
});

registerOp({
  name: "project.set_default_import_folder",
  category: "project",
  appConfig: true,
  description:
    "Set the folder shown by default in the file import dialog (Project.setDefaultImportFolder).",
  params: [{ name: "path", type: "string", description: "Absolute folder path", required: true }],
  toJsx(args) {
    return `
            var _f = new Folder(${jsxVal(args.path)});
            if (!_f.exists) return { ok: false, error: "folder not found: " + ${jsxVal(args.path)} };
            var _res = false;
            try { _res = app.project.setDefaultImportFolder(_f); } catch (eDf) { return { ok: false, error: "setDefaultImportFolder failed: " + AE.errText(eDf) }; }
            return { ok: true, set: _res, path: _f.fsName.replace(/\\\\/g, "/") };
        `;
  },
});

/** Friendly-name → ToolType member table, built probe-guarded at runtime. */
const TOOL_MAP_JSX = `
    var _tools = {};
    var _missingTools = {};
    function _addTool(name, member) {
        try { if (ToolType[member] !== undefined) { _tools[name] = ToolType[member]; return; } } catch (eT) {}
        _missingTools[name] = member;
    }
    _addTool("selection", "Tool_Arrow"); _addTool("rotate", "Tool_Rotate");
    _addTool("hand", "Tool_Hand"); _addTool("zoom", "Tool_Magnify");
    _addTool("panBehind", "Tool_PanBehind");
    _addTool("rect", "Tool_Rect"); _addTool("roundedRect", "Tool_RoundedRect");
    _addTool("ellipse", "Tool_Oval"); _addTool("polygon", "Tool_Polygon"); _addTool("star", "Tool_Star");
    _addTool("textHorizontal", "Tool_TextH"); _addTool("textVertical", "Tool_TextV");
    _addTool("pen", "Tool_Pen"); _addTool("maskFeather", "Tool_Feather");
    _addTool("brush", "Tool_Paintbrush"); _addTool("cloneStamp", "Tool_CloneStamp"); _addTool("eraser", "Tool_Eraser");
    _addTool("puppetPin", "Tool_Pin"); _addTool("puppetStarch", "Tool_PinStarch");
    _addTool("puppetBend", "Tool_PinBend"); _addTool("puppetAdvanced", "Tool_PinAdvanced"); _addTool("puppetOverlap", "Tool_PinDepth");
    _addTool("cameraUnified", "Tool_CameraMaya"); _addTool("cameraOrbit", "Tool_CameraOrbit");
    _addTool("cameraTrackXY", "Tool_CameraTrackXY"); _addTool("cameraTrackZ", "Tool_CameraTrackZ");
    _addTool("cameraOrbitCursor", "Tool_CameraOrbitCursor"); _addTool("cameraOrbitScene", "Tool_CameraOrbitScene");
    _addTool("cameraOrbitCamera", "Tool_CameraOrbitCamera"); _addTool("cameraPanCursor", "Tool_CameraPanCursor");
    function _toolName(v) {
        for (var _tk in _tools) { if (_tools.hasOwnProperty(_tk) && _tools[_tk] === v) return _tk; }
        try { return String(v); } catch (eTn) { return null; }
    }
`;

registerOp({
  name: "project.get_tool",
  category: "project",
  readOnly: true,
  description: "Read the active tool in the Tools panel (Project.toolType, AE 14.0+).",
  params: [],
  toJsx() {
    return `
            ${TOOL_MAP_JSX}
            var _cur = null;
            try { _cur = app.project.toolType; } catch (eTt) { return { ok: false, error: "toolType needs AE 14.0+: " + AE.errText(eTt) }; }
            return { ok: true, tool: _toolName(_cur) };
        `;
  },
});

registerOp({
  name: "project.set_tool",
  category: "project",
  appConfig: true,
  description:
    "Set the active tool in the Tools panel (Project.toolType, AE 14.0+): selection|rotate|hand|zoom|panBehind|rect|roundedRect|ellipse|polygon|star|textHorizontal|textVertical|pen|maskFeather|brush|cloneStamp|eraser|puppetPin|puppetStarch|puppetBend|puppetAdvanced|puppetOverlap|cameraUnified|cameraOrbit|cameraTrackXY|cameraTrackZ|cameraOrbitCursor|cameraOrbitScene|cameraOrbitCamera|cameraPanCursor.",
  params: [
    { name: "tool", type: "string", description: "Tool name (see description)", required: true },
  ],
  toJsx(args) {
    return `
            ${TOOL_MAP_JSX}
            var _arg = ${jsxVal(args.tool)};
            if (!_tools.hasOwnProperty(_arg)) {
                if (_missingTools.hasOwnProperty(_arg)) return { ok: false, error: "tool '" + _arg + "' (ToolType." + _missingTools[_arg] + ") is not available on this AE" };
                return { ok: false, error: "unknown tool '" + _arg + "'" };
            }
            try { app.project.toolType = _tools[_arg]; } catch (eTt) { return { ok: false, error: "toolType set failed: " + AE.errText(eTt) }; }
            return { ok: true, tool: _toolName(app.project.toolType) };
        `;
  },
});

registerOp({
  name: "project.set_memory_limits",
  category: "project",
  appConfig: true,
  description:
    "Set AE memory usage limits (app.setMemoryUsageLimits): image cache percent and maximum memory percent. Percentages over 100 are allowed (AE interprets them against installed RAM).",
  params: [
    {
      name: "imageCachePercent",
      type: "number",
      description: "Image cache size as % of installed RAM",
      required: true,
    },
    {
      name: "maxMemoryPercent",
      type: "number",
      description: "Maximum AE memory as % of installed RAM",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            try { app.setMemoryUsageLimits(${jsxVal(args.imageCachePercent)}, ${jsxVal(args.maxMemoryPercent)}); } catch (eMl) { return { ok: false, error: "setMemoryUsageLimits failed: " + AE.errText(eMl) }; }
            return { ok: true, memoryInUse: app.memoryInUse };
        `;
  },
});

registerOp({
  name: "project.set_multi_frame_rendering",
  category: "project",
  appConfig: true,
  description:
    "Configure Multi-Frame Rendering (app.setMultiFrameRenderingConfig, AE 22.0+): on/off and the maximum CPU percentage MFR may use.",
  params: [
    { name: "enabled", type: "boolean", description: "Enable MFR", required: true },
    {
      name: "maxCpuPercent",
      type: "number",
      description: "Max CPU % for MFR (1-100, default 90)",
      required: false,
      default: 90,
    },
  ],
  toJsx(args) {
    return `
            if (typeof app.setMultiFrameRenderingConfig !== "function") return { ok: false, error: "setMultiFrameRenderingConfig needs AE 22.0+" };
            try { app.setMultiFrameRenderingConfig(${jsxVal(args.enabled)}, ${jsxVal(args.maxCpuPercent ?? 90)}); } catch (eMf) { return { ok: false, error: "setMultiFrameRenderingConfig failed: " + AE.errText(eMf) }; }
            return { ok: true, enabled: ${jsxVal(args.enabled)}, maxCpuPercent: ${jsxVal(args.maxCpuPercent ?? 90)} };
        `;
  },
});

registerOp({
  name: "project.merge",
  category: "project",
  description:
    "Import another .aep into the current project as a folder (After Effects' own project import): every " +
    "comp, footage item and folder of `path` lands under one new folder with names preserved, and nothing " +
    "already in the project is touched. This is how work done in another instance comes back — save there, " +
    "merge here, then move or swap comps as needed (project.delete_item / item ops). Returns the folder and " +
    "the comps and items it now holds.",
  params: [
    {
      name: "path",
      type: "string",
      description: "Absolute .aep path (saved by the other instance)",
      required: true,
    },
    {
      name: "folderName",
      type: "string",
      description: "Rename the imported folder (default: the .aep's file name)",
      required: false,
    },
    {
      name: "parentFolder",
      type: "any",
      description: "Folder (id or name) to put the imported folder into (default: project root)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            var _f = new File(${jsxVal(args.path)});
            if (!_f.exists) return { ok: false, error: "file not found: " + ${jsxVal(args.path)} };
            var _before = {};
            for (var _bi = 1; _bi <= app.project.numItems; _bi++) _before[app.project.item(_bi).id] = true;
            var _imported = app.project.importFile(new ImportOptions(_f));
            // The import returns the new top-level folder; find it by the item
            // diff regardless, so a build that returns something else still
            // reports the right folder.
            var _folder = (_imported && _imported instanceof FolderItem) ? _imported : null;
            var _items = [];
            var _comps = [];
            for (var _ai = 1; _ai <= app.project.numItems; _ai++) {
                var _it = app.project.item(_ai);
                if (_before[_it.id]) continue;
                if (_folder === null && _it instanceof FolderItem && _it.parentFolder === app.project.rootFolder) _folder = _it;
                _items.push({ id: _it.id, name: _it.name, type: AE.itemTypeName(_it) });
                if (_it instanceof CompItem) {
                    _comps.push({ id: _it.id, name: _it.name, width: _it.width, height: _it.height, duration: _it.duration, fps: _it.frameRate });
                }
            }
            if (_folder === null) return { ok: false, error: "import created no folder (" + _items.length + " new items)", items: _items };
            var _newName = ${jsxVal(args.folderName ?? null)};
            if (_newName) _folder.name = _newName;
            var _parentArg = ${jsxVal(args.parentFolder ?? null)};
            if (_parentArg !== null) {
                var _pf = AE.findFolder(_parentArg);
                if (!_pf) return { ok: false, error: "no folder matching " + _parentArg, folder: { id: _folder.id, name: _folder.name } };
                _folder.parentFolder = _pf;
            }
            return { ok: true, folder: { id: _folder.id, name: _folder.name }, comps: _comps, items: _items };
        `;
  },
});
