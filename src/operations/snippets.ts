// JSX bodies shared between the read/render TOOLS (ae_comp_info,
// ae_layer_info, ae_render_frame) and their operation twins (comp.info,
// layer.info, render.frame). One body, two surfaces — what a batch.run child
// reports can never drift from what the standalone tool reports.
//
// Lives under src/operations/ so the jsx ES3 lint scans these template
// literals like any other generated code. Each snippet only DEFINES a
// function; the call site supplies the lookup preamble. Inside batch.run
// every child runs in its own IIFE, so two children defining the same
// function never collide.

/** Defines `_compInfo(c)` → the ae_comp_info payload for one comp. */
export const COMP_INFO_FN = `
    function _compInfo(c) {
        var _ciLayers = [];
        for (var _ci = 1; _ci <= c.numLayers; _ci++) {
            _ciLayers.push(AE.serializeLayerSummary(c.layer(_ci)));
        }
        var _ciOut = AE.serializeItemSummary(c);
        _ciOut.ok = true;
        _ciOut.found = true;
        _ciOut.workAreaStart = c.workAreaStart;
        _ciOut.workAreaDuration = c.workAreaDuration;
        _ciOut.pixelAspect = c.pixelAspect;
        _ciOut.shutterAngle = c.shutterAngle;
        _ciOut.shutterPhase = c.shutterPhase;
        _ciOut.motionBlur = c.motionBlur;
        _ciOut.layers = _ciLayers;
        return _ciOut;
    }
`;

/** Defines `_layerFull(l, incl, detail)` → the ae_layer_info payload for one layer. */
export const LAYER_FULL_FN = `
    function _layerFull(l, incl, detail) {
        var _lfOut = AE.serializeLayerFull(l, { includeProperties: incl, detail: detail });
        _lfOut.ok = true;
        _lfOut.found = true;
        return _lfOut;
    }
`;

/** Defines `_renderFrame(c, timeSeconds, absOutPath, useDisplayStartTime)`. */
export const RENDER_FRAME_FN = `
    function _renderFrame(c, t0, outAbs, useDst) {
        var _rfT = t0;
        if (useDst) _rfT = _rfT + c.displayStartTime;
        var _rfFile = AE.ensureParentDir(outAbs);
        try {
            c.saveFrameToPng(_rfT, _rfFile);
            return {
                ok: true,
                writtenTo: _rfFile.fsName.replace(/\\\\/g, "/"),
                time: _rfT,
                compName: c.name,
                size: [c.width, c.height]
            };
        } catch (eRf) {
            return { ok: false, error: "saveFrameToPng failed: " + AE.errText(eRf) };
        }
    }
`;
