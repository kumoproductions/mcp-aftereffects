import { defineTool, toMcpResult } from "./define-tool.js";

const CODE = `
    var proj = app.project;
    var ai = proj.activeItem;
    var ctx = {
        project: {
            file: proj.file ? proj.file.fsName.replace(/\\\\/g, "/") : null,
            dirty: proj.dirty,
            numItems: proj.numItems,
            bitsPerChannel: proj.bitsPerChannel
        },
        activeComp: null,
        selectedLayers: [],
        helpers: [
            "AE.findCompByNameOrId(nameOrId)",
            "AE.findComps(nameOrIdOrPattern) — '*' glob supported",
            "AE.findItemById(id)",
            "AE.findItem(idOrName) — any project item",
            "AE.findFolder(idOrName) — null/undefined = root folder",
            "AE.findLayerInComp(comp, indexOrNameOrIdRef) — accepts { id: n } (stable Layer.id, AE 22+)",
            "AE.findLayerById(comp, id)",
            "AE.resolveLayers(comp, target) — index | name | { id: n } | 'selected' | 'all'",
            "AE.snapshotKeys(prop) / AE.applyKeys(prop, keys) / AE.removeAllKeys(prop)",
            "AE.setEase(prop, keyIndex, inInf, outInf, inSpeed?, outSpeed?) — dims/spatial handled",
            "AE.rect(shapeLayerOrGroup, [w,h], [x,y], {name, roundness, fill:[r,g,b], stroke, strokeWidth}) — group+path+style in one call",
            "AE.ellipse(shapeLayerOrGroup, [w,h], [x,y], {name, fill, stroke, strokeWidth})",
            "AE.ensureParentDir(path) — mkdir -p for an output file, returns the File",
            "AE.itemTypeName(item) — 'CompItem' | 'FootageItem' | 'FolderItem' | 'UnknownItem'",
            "AE.serializeItemSummary(item)",
            "AE.serializeLayerSummary(layer)",
            "AE.serializeLayerFull(layer, opts) — opts.detail:'summary' drops default-value props",
            "AE.serializeTransform(layer)",
            "AE.serializePropertyGroup(group, depth, maxDepth, opts)",
            "AE.serializeCompMarkers(comp)",
            "AE.exportProject()",
            "AE.importProject(doc, opts)",
            "AE.safeGet(fn, fallback)",
            "AE.valueToJson(val)"
        ],
        es3Rules: [
            "var only (no let/const)",
            "function() {} only (no arrow =>)",
            "string concat only (no template literals)",
            "for(var i=0;i<n;i++) only (no for-of, no forEach/map/filter)",
            "indexOf !== -1 (no includes/startsWith/endsWith)",
            "NEVER chain ternaries: a ? b : c ? d : e parses LEFT-associative in ExtendScript — parenthesize or use if/else",
            "log('msg') to push breadcrumbs",
            "return <JSON-serializable> at end"
        ],
        tips: [
            "reparenting a layer that has keyframes: use layer.set_parent with jump:true (no transform compensation) — plain parent assignment rewrites values and corrupts keys",
            "easing: keyframe.set_easing (op) or AE.setEase (eval) — both handle the spatial=1/per-dimension KeyframeEase bookkeeping",
            "auditing a comp: ae_layer_info layerIndex:'all' with detail:'summary' skips default-value properties and includes key ease (speed/influence)",
            "render queue output folders are auto-created on render.add_to_queue / render.set_output / render.start"
        ],
        undoContract: [
            "every ae_do / eval.run call is auto-wrapped in ONE undo group",
            "one Ctrl+Z (or project.undo) reverts the entire call; batch.run = one call = one undo step",
            "NEVER call app.beginUndoGroup/endUndoGroup in eval.run code — an unbalanced group corrupts undo for the session",
            "undo/redo itself runs OUTSIDE the group: use project.undo (or command.execute 16/2035) as its own call — never inside batch.run, and never via eval.run",
            "ae_save_project and files written to disk (rendered PNGs, exported JSON) are NOT undoable"
        ]
    };
    if (ai && ai instanceof CompItem) {
        ctx.activeComp = {
            id: ai.id,
            name: ai.name,
            width: ai.width,
            height: ai.height,
            fps: ai.frameRate,
            duration: ai.duration,
            numLayers: ai.numLayers,
            bgColor: [ai.bgColor[0], ai.bgColor[1], ai.bgColor[2]]
        };
        var sel = [];
        for (var si = 1; si <= ai.numLayers; si++) {
            if (ai.layer(si).selected) sel.push({ index: si, name: ai.layer(si).name });
        }
        ctx.selectedLayers = sel;
    }
    // Item summary (compact). Type via AE.itemTypeName — the inline ternary
    // chain this used to be labelled EVERY item "Folder": ExtendScript parses
    // a ? b : c ? d : e left-associatively.
    var items = [];
    for (var i = 1; i <= Math.min(proj.numItems, 50); i++) {
        var it = proj.item(i);
        items.push({
            id: it.id,
            name: it.name,
            type: AE.itemTypeName(it)
        });
    }
    ctx.items = items;
    if (proj.numItems > 50) ctx.itemsTruncated = true;
    return ctx;
`;

export const contextTool = defineTool({
  name: "ae_context",
  title: "Session context",
  description:
    "Ambient context: project state, active comp, selected layers, item list, " +
    "AE.* helpers, ES3 rules, and the undo contract (every call = one auto undo group). " +
    "Call at session start; then rely on ae_do response context.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {},
  handler: async (_args, transport) => {
    const result = await transport.execute({ code: CODE, label: "context" });
    return toMcpResult(result);
  },
});
