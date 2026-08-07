import { z } from "zod";

import { COMP_INFO_FN } from "../operations/snippets.js";
import { jsxVal } from "../registry.js";
import { defineTool, toMcpResult } from "./define-tool.js";

export const compInfoTool = defineTool({
  name: "ae_comp_info",
  title: "Comp info",
  description:
    "Detailed comp info: size, fps, duration, work area, motion blur, layer summaries. " +
    "Pass a comp name or item id — or an ARRAY of them to fetch several comps in one call.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {
    nameOrId: z
      .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])).min(1)])
      .describe(
        "Composition name (exact match) or numeric item id — or an array of either to batch " +
          "several comps into one round trip. If you don't know any, call ae_project_info first.",
      ),
  },
  handler: async (args, transport) => {
    const targets = Array.isArray(args.nameOrId) ? args.nameOrId : null;
    const code = targets
      ? `
        ${COMP_INFO_FN}
        var _targets = ${jsxVal(targets)};
        var _comps = [];
        var _misses = 0;
        for (var _ti = 0; _ti < _targets.length; _ti++) {
            var _c = AE.findCompByNameOrId(_targets[_ti]);
            if (_c) {
                _comps.push(_compInfo(_c));
            } else {
                _misses++;
                _comps.push({ ok: false, found: false, error: "no comp matching " + String(_targets[_ti]) });
            }
        }
        return { ok: _misses === 0, count: _comps.length, missing: _misses, comps: _comps };
    `
      : `
        ${COMP_INFO_FN}
        var _arg = ${jsxVal(args.nameOrId)};
        var _c = AE.findCompByNameOrId(_arg);
        if (!_c) return { ok: false, found: false, error: "no comp matching " + String(_arg) };
        return _compInfo(_c);
    `;
    const result = await transport.execute({ code, label: "comp_info" });
    return toMcpResult(result);
  },
});
