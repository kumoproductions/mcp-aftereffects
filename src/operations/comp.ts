// Composition operations — create, set properties, delete.

import { registerOp, jsxVal, jsxCompPreamble } from "../registry.js";

registerOp({
  name: "comp.create",
  category: "comp",
  description: "Create a new composition.",
  params: [
    { name: "name", type: "string", description: "Composition name", required: true },
    { name: "width", type: "number", description: "Width in px", required: true },
    { name: "height", type: "number", description: "Height in px", required: true },
    { name: "fps", type: "number", description: "Frame rate", required: true },
    { name: "duration", type: "number", description: "Duration in seconds", required: true },
    { name: "bgColor", type: "array", description: "[r,g,b] 0-1", required: false },
  ],
  toJsx(args) {
    return `
            var _comp = app.project.items.addComp(${jsxVal(args.name)}, ${jsxVal(args.width)}, ${jsxVal(args.height)}, 1, ${jsxVal(args.duration)}, ${jsxVal(args.fps)});
            ${args.bgColor ? `_comp.bgColor = ${jsxVal(args.bgColor)};` : ""}
            return { ok: true, id: _comp.id, name: _comp.name };
        `;
  },
});

registerOp({
  name: "comp.set_label",
  category: "comp",
  description: "Set label color on comps. Can target by name, id, or pattern (e.g. 'review_id_*').",
  params: [
    {
      name: "comp",
      type: "any",
      description: "Comp name/id, or pattern with '*' wildcard",
      required: true,
    },
    {
      name: "label",
      type: "number",
      description:
        "Label index (0=None, 1=Red, 2=Yellow, 3=Aqua, 4=Pink, 5=Lavender, 6=Peach, 7=Sea Foam, 8=Blue, 9=Green, 10=Purple, 11=Orange, 12=Brown, 13=Fuchsia, 14=Cyan, 15=Sandstone, 16=Dark Green)",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            var _comps = AE.findComps(${jsxVal(args.comp)});
            var _updated = 0;
            for (var ci = 0; ci < _comps.length; ci++) {
                _comps[ci].label = ${jsxVal(args.label)};
                _updated++;
            }
            return { ok: true, updated: _updated };
        `;
  },
});

registerOp({
  name: "comp.set_props",
  category: "comp",
  description:
    "Set composition properties (bgColor, workAreaStart, workAreaDuration, shutterAngle, motionBlur, etc.).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "props", type: "object", description: "Object with keys to set", required: true },
  ],
  toJsx(args) {
    const props = (args.props ?? {}) as Record<string, unknown>;
    const lines: string[] = [];
    for (const [k, v] of Object.entries(props)) {
      lines.push(
        `try { _comp[${jsxVal(k)}] = ${jsxVal(v)}; } catch (e) { _w.push(${jsxVal(k)} + ": " + AE.errText(e)); }`,
      );
    }
    return `
            ${jsxCompPreamble(args)}
            var _w = [];
            ${lines.join("\n")}
            return { ok: true, name: _comp.name, warnings: _w };
        `;
  },
});

registerOp({
  name: "comp.set_work_area",
  category: "comp",
  description: "Set the work area start and duration on a composition.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "start", type: "number", description: "Work area start in seconds", required: true },
    {
      name: "duration",
      type: "number",
      description: "Work area duration in seconds",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            _comp.workAreaStart = ${jsxVal(args.start)};
            _comp.workAreaDuration = ${jsxVal(args.duration)};
            return { ok: true, workAreaStart: _comp.workAreaStart, workAreaDuration: _comp.workAreaDuration };
        `;
  },
});

registerOp({
  name: "comp.add_guide",
  category: "comp",
  description: "Add a horizontal or vertical guide line to a comp (AE 16.1+).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "orientation",
      type: "string",
      description: "horizontal|vertical",
      required: true,
    },
    {
      name: "position",
      type: "number",
      description: "Position in px (y for horizontal, x for vertical)",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            if (typeof _comp.addGuide !== "function") return { ok: false, error: "guides need AE 16.1+" };
            var _orient = ${jsxVal(args.orientation)} === "vertical" ? 1 : 0;
            var _idx = _comp.addGuide(_orient, ${jsxVal(args.position)});
            return { ok: true, guideIndex: _idx, numGuides: _comp.guides.length };
        `;
  },
});

registerOp({
  name: "comp.remove_guide",
  category: "comp",
  description: "Remove a guide from a comp by its 0-based index (see comp.list_guides).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "guideIndex", type: "number", description: "0-based guide index", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            if (typeof _comp.removeGuide !== "function") return { ok: false, error: "guides need AE 16.1+" };
            if (${jsxVal(args.guideIndex)} < 0 || ${jsxVal(args.guideIndex)} >= _comp.guides.length) {
                return { ok: false, error: "guide index out of range (comp has " + _comp.guides.length + " guides)" };
            }
            _comp.removeGuide(${jsxVal(args.guideIndex)});
            return { ok: true, numGuides: _comp.guides.length };
        `;
  },
});

registerOp({
  name: "comp.set_guide",
  category: "comp",
  description:
    "Move an existing guide to a new position (Item.setGuide). Orientation cannot be changed after creation — remove and re-add instead.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "guideIndex", type: "number", description: "0-based guide index", required: true },
    {
      name: "position",
      type: "number",
      description: "New position in px (y for horizontal, x for vertical)",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            if (typeof _comp.setGuide !== "function") return { ok: false, error: "guides need AE 16.1+" };
            if (${jsxVal(args.guideIndex)} < 0 || ${jsxVal(args.guideIndex)} >= _comp.guides.length) {
                return { ok: false, error: "guide index out of range (comp has " + _comp.guides.length + " guides)" };
            }
            _comp.setGuide(${jsxVal(args.position)}, ${jsxVal(args.guideIndex)});
            return { ok: true, guideIndex: ${jsxVal(args.guideIndex)}, position: ${jsxVal(args.position)} };
        `;
  },
});

registerOp({
  name: "comp.list_guides",
  category: "comp",
  readOnly: true,
  description: "List all guides on a comp with orientation and position (AE 16.1+).",
  params: [{ name: "comp", type: "any", description: "Comp name or id", required: true }],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _guides = [];
            try {
                for (var _gi = 0; _gi < _comp.guides.length; _gi++) {
                    var _g = _comp.guides[_gi];
                    _guides.push({
                        index: _gi,
                        orientation: _g.orientationType === 1 ? "vertical" : "horizontal",
                        position: _g.position
                    });
                }
            } catch (eG) { return { ok: false, error: "guides need AE 16.1+: " + AE.errText(eG) }; }
            return { ok: true, count: _guides.length, guides: _guides };
        `;
  },
});

registerOp({
  name: "comp.delete",
  category: "comp",
  description: "Delete a composition from the project.",
  params: [{ name: "comp", type: "any", description: "Comp name or id", required: true }],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _name = _comp.name;
            _comp.remove();
            return { ok: true, removed: _name };
        `;
  },
});
