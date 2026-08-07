// Timeline / playback operations — set time, select layers, set active comp.

import { registerOp, jsxVal, jsxCompPreamble } from "../registry.js";

registerOp({
  name: "timeline.set_time",
  category: "timeline",
  description: "Set the current time indicator (CTI) in a composition.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "time", type: "number", description: "Time in seconds", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            _comp.time = ${jsxVal(args.time)};
            return { ok: true, time: _comp.time };
        `;
  },
});

registerOp({
  name: "timeline.set_active_comp",
  category: "timeline",
  description: "Set the active (visible in UI) composition. Opens it in the viewer.",
  params: [{ name: "comp", type: "any", description: "Comp name or id", required: true }],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            _comp.openInViewer();
            return { ok: true, name: _comp.name };
        `;
  },
});

registerOp({
  name: "timeline.select_layers",
  category: "timeline",
  description: "Select (or deselect) layers in a comp by index.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "indices",
      type: "array",
      description: "Array of 1-based layer indices to select",
      required: true,
    },
    {
      name: "deselectOthers",
      type: "boolean",
      description: "Deselect all other layers first (default true)",
      required: false,
      default: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _indices = ${jsxVal(args.indices)};
            if (${jsxVal(args.deselectOthers !== false)}) {
                for (var i = 1; i <= _comp.numLayers; i++) _comp.layer(i).selected = false;
            }
            for (var j = 0; j < _indices.length; j++) {
                if (_indices[j] >= 1 && _indices[j] <= _comp.numLayers) {
                    _comp.layer(_indices[j]).selected = true;
                }
            }
            return { ok: true, selected: _indices.length };
        `;
  },
});
