// Read/verify operations — the operation twins of ae_comp_info, ae_layer_info
// and ae_render_frame. Their reason to exist is batch.run: with reads and
// frame rendering available as children, mutate → render → re-inspect is one
// ae_do call (one IPC round trip, one MCP tool call) instead of three.

import * as path from "node:path";

import { rejectedOutputPath } from "../config.js";
import { jsxCompLayerPreamble, jsxCompPreamble, jsxVal, registerOp } from "../registry.js";
import { COMP_INFO_FN, LAYER_FULL_FN, RENDER_FRAME_FN } from "./snippets.js";

registerOp({
  name: "comp.info",
  category: "comp",
  description:
    "Comp details + per-layer summaries (same payload as ae_comp_info). As a batch.run child, lets the same call verify what a preceding mutation did.",
  params: [{ name: "comp", type: "any", description: "Comp name or id", required: true }],
  readOnly: true,
  toJsx(args) {
    return `
            ${COMP_INFO_FN}
            ${jsxCompPreamble(args)}
            return _compInfo(_comp);
        `;
  },
});

registerOp({
  name: "layer.info",
  category: "layer",
  description:
    "Full layer info incl. property trees and keyframes (same payload as ae_layer_info). Layer by 1-based index or name. includeProperties=false for the cheap summary.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index or layer name",
      required: true,
    },
    {
      name: "includeProperties",
      type: "boolean",
      description: "Walk the full property tree (default true)",
      required: false,
      default: true,
    },
  ],
  readOnly: true,
  toJsx(args) {
    return `
            ${LAYER_FULL_FN}
            ${jsxCompLayerPreamble(args)}
            return _layerFull(_layer, ${jsxVal(args.includeProperties !== false)});
        `;
  },
});

registerOp({
  name: "render.frame",
  category: "render",
  description:
    "Render one frame to PNG (raw saveFrameToPng). As the LAST child of a batch.run, one call mutates and hands back visual proof. outPath must be absolute; raise ae_do's timeoutMs for slow renders. " +
    "CAUTION: in color-managed projects (project.get_settings workingSpace != 'None') this writes raw working-space values that look dark/wrong — use the ae_render_frame TOOL there, which converts to display sRGB.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "time", type: "number", description: "Time in seconds to render", required: true },
    {
      name: "outPath",
      type: "string",
      description: "Absolute path for the PNG (parent directories are created)",
      required: true,
    },
    {
      name: "useDisplayStartTime",
      type: "boolean",
      description: "Interpret `time` relative to comp.displayStartTime (default false)",
      required: false,
    },
  ],
  // Writes a PNG but never touches the project — the same read-only stance as
  // the ae_render_frame tool, so render-verify loops survive AE_MCP_READONLY.
  readOnly: true,
  toJsx(args) {
    const raw = String(args.outPath);
    if (!path.isAbsolute(raw)) {
      return `
            return { ok: false, error: ${jsxVal(`outPath must be absolute, got: ${raw}`)} };
        `;
    }
    // Same guard the ae_render_frame tool applies: never write into the IPC
    // mailbox. Batching must not be a way around a check the tool enforces.
    const rejection = rejectedOutputPath(raw);
    if (rejection !== null) {
      return `
            return { ok: false, error: ${jsxVal(rejection)} };
        `;
    }
    const abs = path.resolve(raw).replace(/\\/g, "/");
    return `
            ${RENDER_FRAME_FN}
            ${jsxCompPreamble(args)}
            return _renderFrame(_comp, ${jsxVal(args.time)}, ${jsxVal(abs)}, ${jsxVal(!!args.useDisplayStartTime)});
        `;
  },
});
