// mcp-aftereffects project export — walks the entire project and produces a JSON
// document describing folders, comps (with full layer/property trees), solid
// footage, and file footage references. ES3-compatible.

AE.EXPORT_SCHEMA_VERSION = 2;
// v1: basic items + layers + transform/effects/masks/text
// v2: shape layer contents, layer/comp markers, time remap, material options, audio, extended text document fields

AE.exportProject = function () {
    var proj = app.project;
    var doc = {
        schemaVersion: AE.EXPORT_SCHEMA_VERSION,
        exportedAt: new Date().toString(),
        aeVersion: app.version,
        project: {
            file: proj.file ? proj.file.fsName.replace(/\\/g, "/") : null,
            bitsPerChannel: proj.bitsPerChannel,
            timeDisplayType: String(proj.timeDisplayType)
        },
        items: []
    };

    for (var i = 1; i <= proj.numItems; i++) {
        var it = proj.item(i);
        var entry = AE.serializeItemSummary(it);
        if (it instanceof CompItem) {
            entry.workAreaStart = it.workAreaStart;
            entry.workAreaDuration = it.workAreaDuration;
            entry.pixelAspect = it.pixelAspect;
            entry.shutterAngle = it.shutterAngle;
            entry.shutterPhase = it.shutterPhase;
            entry.motionBlur = it.motionBlur;
            entry.displayStartTime = it.displayStartTime;
            entry.layers = [];
            for (var li = 1; li <= it.numLayers; li++) {
                var lay = it.layer(li);
                entry.layers.push(AE.serializeLayerFull(lay, { includeProperties: true }));
            }
            entry.markers = AE.serializeCompMarkers(it);
        }
        if (it instanceof FootageItem) {
            // width/height/duration already in summary; nothing extra needed for solids.
            var src = it.mainSource;
            if (src instanceof SolidSource) {
                entry.sourceWidth = it.width;
                entry.sourceHeight = it.height;
                entry.alphaMode = src.alphaMode;
                try { entry.hasAlpha = src.hasAlpha; } catch (e) {}
            }
        }
        doc.items.push(entry);
    }
    return doc;
};
