import { instanceLabel, listInstances } from "../transport/instances.js";
import { defineTool, toMcpResult } from "./define-tool.js";

const CODE = `
    var proj = app.project;
    var ai = proj.activeItem;
    // The resident agent (pull path) marks the instance that answered; null
    // means this call came in through the push path (AfterFX.exe -r).
    var agent = AE.safeGet(function () { return $.global.AE_MCP_AGENT || null; }, null);
    var ctx = {
        project: {
            file: proj.file ? proj.file.fsName.replace(/\\\\/g, "/") : null,
            dirty: proj.dirty,
            numItems: proj.numItems,
            bitsPerChannel: proj.bitsPerChannel
        },
        instance: agent ? {
            id: agent.state.id,
            idSource: agent.state.idSource,
            served: agent.state.served
        } : null,
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
            "AE.resolveLayers(comp, target) — index | name | { id: n } | 'selected' | 'all' | array of those",
            "AE.snapshotKeys(prop) / AE.applyKeys(prop, keys) / AE.removeAllKeys(prop)",
            "AE.setEase(prop, keyIndex, inInf, outInf, inSpeed?, outSpeed?) — dims/spatial handled",
            "AE.writeValue(prop, value, time?) / AE.readValue(prop, time?) — separated-dimension safe, __kind values accepted",
            "AE.offsetValue(prop, delta) — shift a value or every keyframe",
            "AE.applyKeySpecs(prop, [{time, value, interp?}], {replace, interp, spatialTangents}) — keyframe.apply's engine",
            "AE.moveAnchor(layer, [x, y]) — anchor move with position compensation",
            "AE.layerRect(layer, time) / AE.pointInRect(rect, preset) — anchor presets on rendered bounds",
            "AE.shapeGroupBounds(group, {time, includeStroke}) / AE.shapeLayerBounds(layer, opts)",
            "AE.walkShapeContents(contents, fn) / AE.recolorContents(contents, opts) / AE.canonicalGroup(group, precision)",
            "AE.geometryShape('ellipse'|'rect', center, size, roundness) — a Shape for masks/paths",
            "AE.propertyAtPath(root, path) — null instead of throwing",
            "AE.ownerLayer(prop) — the layer a property belongs to",
            "AE.bakeKeysAtTime(root, time) — freeze every animated property below root",
            "AE.layerIdSnapshot(comp) / AE.layersSince(comp, snap) — which layers a command created",
            "AE.withSelection(comp, layers, fn) — run a menu command on exactly these layers, selection restored",
            "AE.rect(shapeLayerOrGroup, [w,h], [x,y], {name, roundness, fill:[r,g,b], stroke, strokeWidth}) — group+path+style in one call",
            "AE.ellipse(shapeLayerOrGroup, [w,h], [x,y], {name, fill, stroke, strokeWidth})",
            "AE.ensureParentDir(path) — mkdir -p for an output file, returns the File",
            "AE.effectBitDepth(matchName) — processing depth { bpc: 32|16|8|null, reason } of an Adobe (ADBE) effect, measured and cached; plug-in effects need effect.bit_depth (reads their PiPL)",
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
            "render queue output folders are auto-created on render.add_to_queue / render.set_output / render.start",
            "many keys at once: keyframe.apply takes the whole list with per-key easing; its 'hold' only holds the OUT side, so a fade that ends in a hold key still fades",
            "Position separated into X/Y (Separate Dimensions, or layers from 'Create Shapes from Vector Layer'): every write op and AE.writeValue route to the followers automatically",
            "imported Illustrator layers: layer.convert_to_shapes (strips ' Outlines', can remove the source layer/footage); then shape.group_bounds / layer.split_groups to work per part",
            "layer targets accept arrays everywhere they accept 'all' — [\\"A\\", \\"B\\", { id: 12 }] is one call",
            "verifying motion: ae_render_frame times + contactSheet tiles the frames into one labelled PNG; analyze reports edge bands / content bounds; comp.sample reads values at several times",
            "32bpc projects: effect.add refuses an effect that processes at 16/8bpc (it would clip values above 1.0) — pick effects from project.list_effects { category or search, bitDepth: true } with bpc 32; allowLowBitDepth: true only when the user accepts the clamping. eval.run bypasses this check — look effects up with effect.bit_depth first",
            "several After Effects instances (AfterFX.exe -m): each MCP server addresses ONE, chosen by AE_MCP_INSTANCE (instance id or open project file name); the response's instances[] lists what is live — if the project you need is open elsewhere, say so instead of editing the wrong one"
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
    if (!result.ok) return toMcpResult(result);
    // Node-side view of the instance landscape: which AE instances have a
    // live agent, and how THIS server reaches its one. The JSX above can only
    // describe the instance that answered.
    const [instances, target] = await Promise.all([
      listInstances(),
      transport.describeTarget ? transport.describeTarget() : Promise.resolve(null),
    ]);
    const base =
      result.result !== null && typeof result.result === "object" && !Array.isArray(result.result)
        ? (result.result as Record<string, unknown>)
        : { value: result.result };
    const merged = {
      ...base,
      transport:
        target === null
          ? null
          : target.mode === "pull"
            ? { mode: "pull", instance: target.instance.id }
            : target.mode === "push"
              ? { mode: "push" }
              : { mode: "error", message: target.message },
      instances: instances.map((i) => ({
        label: instanceLabel(i),
        id: i.id,
        alive: i.alive,
        busy: i.heartbeat?.busy ?? false,
        project: i.heartbeat?.project ?? null,
        aeVersion: i.heartbeat?.aeVersion ?? null,
        lastSeenMsAgo: i.ageMs,
      })),
    };
    return toMcpResult({ ...result, result: merged });
  },
});
