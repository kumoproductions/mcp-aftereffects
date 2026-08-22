import { z } from "zod";

import { LAYER_FULL_FN } from "../operations/snippets.js";
import { jsxVal } from "../registry.js";
import { defineTool, toMcpResult } from "./define-tool.js";

export const layerInfoTool = defineTool({
  name: "ae_layer_info",
  title: "Layer info",
  description:
    "Full layer info: transform, effects, masks, text, shape contents, keyframes " +
    "(incl. interpolation names and bezier ease speed/influence). " +
    "layerIndex accepts one index, an ARRAY of indices, or 'all' — auditing a whole comp is one call. " +
    "detail:'summary' drops properties still at their default value (unkeyed, no expression) — " +
    "start there for audits; the full tree is often 100KB+ per comp. " +
    "Set includeProperties=false to skip the property tree walk entirely.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    compNameOrId: z
      .union([z.string(), z.number()])
      .describe("Composition name (exact match) or numeric item id."),
    layerIndex: z
      .union([
        z.number().int().positive(),
        z.array(z.number().int().positive()).min(1),
        z.literal("all"),
      ])
      .describe(
        "1-based layer index — or an array of indices, or 'all' for every layer in the comp, " +
          "returned together in one round trip.",
      ),
    includeProperties: z
      .boolean()
      .optional()
      .describe("Include the full property tree (Transform/Effects/Masks/Text). Default true."),
    detail: z
      .enum(["full", "summary"])
      .optional()
      .describe(
        "'summary' omits properties still at their default value (no keyframes, no expression, " +
          "never touched) — typically 5-10x smaller. Group skeletons are kept, so effects/masks " +
          "still show. Default 'full'.",
      ),
  },
  handler: async (args, transport) => {
    const multi = typeof args.layerIndex !== "number";
    const detailJsx = jsxVal(args.detail ?? "full");
    const code = multi
      ? `
        ${LAYER_FULL_FN}
        var _arg = ${jsxVal(args.compNameOrId)};
        var _incl = ${jsxVal(args.includeProperties !== false)};
        var _detail = ${detailJsx};
        var comp = AE.findCompByNameOrId(_arg);
        if (!comp) return { ok: false, found: false, error: "no comp matching " + String(_arg) };
        var _spec = ${jsxVal(args.layerIndex)};
        var _idxs = [];
        if (_spec === "all") {
            for (var _ai = 1; _ai <= comp.numLayers; _ai++) _idxs.push(_ai);
        } else {
            _idxs = _spec;
        }
        var _layers = [];
        var _misses = 0;
        for (var _li = 0; _li < _idxs.length; _li++) {
            var _idx = _idxs[_li];
            if (_idx < 1 || _idx > comp.numLayers) {
                _misses++;
                _layers.push({ ok: false, found: false, index: _idx, error: "layer index " + _idx + " out of range 1.." + comp.numLayers });
            } else {
                _layers.push(_layerFull(comp.layer(_idx), _incl, _detail));
            }
        }
        return { ok: _misses === 0, compName: comp.name, count: _layers.length, missing: _misses, layers: _layers };
    `
      : `
        ${LAYER_FULL_FN}
        var _arg = ${jsxVal(args.compNameOrId)};
        var _idx = ${jsxVal(args.layerIndex)};
        var _incl = ${jsxVal(args.includeProperties !== false)};
        var _detail = ${detailJsx};
        var comp = AE.findCompByNameOrId(_arg);
        if (!comp) return { ok: false, found: false, error: "no comp matching " + String(_arg) };
        if (_idx < 1 || _idx > comp.numLayers) return { ok: false, found: false, error: "layer index " + _idx + " out of range 1.." + comp.numLayers };
        return _layerFull(comp.layer(_idx), _incl, _detail);
    `;
    const result = await transport.execute({ code, label: "layer_info" });
    return toMcpResult(result);
  },
});
