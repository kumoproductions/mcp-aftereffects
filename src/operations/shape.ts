// Shape layer operations — add groups, paths, fill, stroke.

import { registerOp, jsxVal, jsxCompLayerPreamble } from "../registry.js";

/**
 * Shape-group lookup preamble (defines `_grp` from args.groupIndex).
 * Must follow jsxCompLayerPreamble, which defines `_layer`.
 */
function jsxShapeGroupPreamble(args: Record<string, unknown>): string {
  return `
        var _contents = _layer.property("Contents");
        // Non-shape layers have no Contents, and property(index) throws on
        // out-of-range instead of returning null. Both would surface as a raw
        // ExtendScript error without these checks.
        if (!_contents) return { ok: false, error: "not a shape layer (no Contents group)" };
        if (${jsxVal(args.groupIndex)} < 1 || ${jsxVal(args.groupIndex)} > _contents.numProperties) {
            return { ok: false, error: "no group at index " + ${jsxVal(args.groupIndex)} + " (layer has " + _contents.numProperties + ")" };
        }
        var _grp = _contents.property(${jsxVal(args.groupIndex)});
        if (!_grp) return { ok: false, error: "no group at index " + ${jsxVal(args.groupIndex)} };
    `;
}

registerOp({
  name: "shape.add_group",
  category: "shape",
  description: "Add a Vector Group to a shape layer's Contents.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index or name (must be a shape layer)",
      required: true,
    },
    { name: "name", type: "string", description: "Group name", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _contents = _layer.property("Contents");
            var _grp = _contents.addProperty("ADBE Vector Group");
            ${args.name ? `_grp.name = ${jsxVal(args.name)};` : ""}
            return { ok: true, groupIndex: _grp.propertyIndex, name: _grp.name };
        `;
  },
});

registerOp({
  name: "shape.add_rect",
  category: "shape",
  description: "Add a Rectangle Path to a shape group.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "groupIndex",
      type: "number",
      description: "1-based group index within Contents",
      required: true,
    },
    { name: "size", type: "array", description: "[width, height]", required: true },
    {
      name: "position",
      type: "array",
      description: "[x, y] offset from group center",
      required: false,
      default: [0, 0],
    },
    {
      name: "roundness",
      type: "number",
      description: "Corner roundness in px",
      required: false,
      default: 0,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _rect = _grp.property("Contents").addProperty("ADBE Vector Shape - Rect");
            _rect.property("ADBE Vector Rect Size").setValue(${jsxVal(args.size)});
            _rect.property("ADBE Vector Rect Position").setValue(${jsxVal(args.position ?? [0, 0])});
            _rect.property("ADBE Vector Rect Roundness").setValue(${jsxVal(args.roundness ?? 0)});
            return { ok: true, name: _rect.name };
        `;
  },
});

registerOp({
  name: "shape.add_ellipse",
  category: "shape",
  description: "Add an Ellipse Path to a shape group.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "groupIndex",
      type: "number",
      description: "1-based group index within Contents",
      required: true,
    },
    { name: "size", type: "array", description: "[width, height]", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _el = _grp.property("Contents").addProperty("ADBE Vector Shape - Ellipse");
            _el.property("ADBE Vector Ellipse Size").setValue(${jsxVal(args.size)});
            return { ok: true, name: _el.name };
        `;
  },
});

registerOp({
  name: "shape.add_fill",
  category: "shape",
  description: "Add a Fill to a shape group.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "groupIndex",
      type: "number",
      description: "1-based group index within Contents",
      required: true,
    },
    { name: "color", type: "array", description: "[r,g,b,a] 0-1", required: true },
    {
      name: "opacity",
      type: "number",
      description: "Opacity 0-100",
      required: false,
      default: 100,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _fill = _grp.property("Contents").addProperty("ADBE Vector Graphic - Fill");
            _fill.property("ADBE Vector Fill Color").setValue(${jsxVal(args.color)});
            ${args.opacity !== undefined ? `_fill.property("ADBE Vector Fill Opacity").setValue(${jsxVal(args.opacity)});` : ""}
            return { ok: true, name: _fill.name };
        `;
  },
});

registerOp({
  name: "shape.add_path",
  category: "shape",
  description: "Add a custom bezier Path (vertices + tangents) to a shape group.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "groupIndex",
      type: "number",
      description: "1-based group index within Contents",
      required: true,
    },
    { name: "vertices", type: "array", description: "Array of [x,y] points", required: true },
    {
      name: "inTangents",
      type: "array",
      description: "Array of [x,y] in-tangent offsets",
      required: false,
    },
    {
      name: "outTangents",
      type: "array",
      description: "Array of [x,y] out-tangent offsets",
      required: false,
    },
    {
      name: "closed",
      type: "boolean",
      description: "Close the path (default true)",
      required: false,
      default: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _pathProp = _grp.property("Contents").addProperty("ADBE Vector Shape - Group");
            var _shape = new Shape();
            _shape.vertices = ${jsxVal(args.vertices)};
            _shape.closed = ${jsxVal(args.closed !== false)};
            ${args.inTangents ? `_shape.inTangents = ${jsxVal(args.inTangents)};` : ""}
            ${args.outTangents ? `_shape.outTangents = ${jsxVal(args.outTangents)};` : ""}
            _pathProp.property("ADBE Vector Shape").setValue(_shape);
            return { ok: true, name: _pathProp.name };
        `;
  },
});

registerOp({
  name: "shape.add_trim_paths",
  category: "shape",
  description:
    "Add Trim Paths to a shape group. Essential for shape animation (line draw-on effects).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "groupIndex",
      type: "number",
      description: "1-based group index within Contents",
      required: true,
    },
    { name: "start", type: "number", description: "Start % (0-100)", required: false, default: 0 },
    { name: "end", type: "number", description: "End % (0-100)", required: false, default: 100 },
    {
      name: "offset",
      type: "number",
      description: "Offset in degrees",
      required: false,
      default: 0,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _trim = _grp.property("Contents").addProperty("ADBE Vector Filter - Trim");
            _trim.property("ADBE Vector Trim Start").setValue(${jsxVal(args.start ?? 0)});
            _trim.property("ADBE Vector Trim End").setValue(${jsxVal(args.end ?? 100)});
            _trim.property("ADBE Vector Trim Offset").setValue(${jsxVal(args.offset ?? 0)});
            return { ok: true, name: _trim.name };
        `;
  },
});

registerOp({
  name: "shape.add_merge_paths",
  category: "shape",
  description: "Add Merge Paths to a shape group for combining/subtracting shapes.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "groupIndex",
      type: "number",
      description: "1-based group index within Contents",
      required: true,
    },
    {
      name: "mode",
      type: "string",
      description: "merge|add|subtract|intersect|excludeIntersections",
      required: false,
      default: "merge",
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _merge = _grp.property("Contents").addProperty("ADBE Vector Filter - Merge");
            var _modeMap = { "merge": 1, "add": 2, "subtract": 3, "intersect": 4, "excludeIntersections": 5 };
            var _m = _modeMap[${jsxVal(args.mode ?? "merge")}] || 1;
            _merge.property("ADBE Vector Merge Type").setValue(_m);
            return { ok: true, name: _merge.name, mode: ${jsxVal(args.mode ?? "merge")} };
        `;
  },
});

registerOp({
  name: "shape.add_stroke",
  category: "shape",
  description: "Add a Stroke to a shape group.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "groupIndex",
      type: "number",
      description: "1-based group index within Contents",
      required: true,
    },
    { name: "color", type: "array", description: "[r,g,b,a] 0-1", required: true },
    { name: "width", type: "number", description: "Stroke width", required: false, default: 2 },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _stroke = _grp.property("Contents").addProperty("ADBE Vector Graphic - Stroke");
            _stroke.property("ADBE Vector Stroke Color").setValue(${jsxVal(args.color)});
            _stroke.property("ADBE Vector Stroke Width").setValue(${jsxVal(args.width ?? 2)});
            return { ok: true, name: _stroke.name };
        `;
  },
});

/**
 * Optional-opacity setter fragment for gradient fill/stroke — the opacity
 * matchName differs per graphic and older hosts may lack it, hence try/catch.
 */
function jsxGradientOpacity(varName: string, matchName: string, opacity: unknown): string {
  if (opacity === undefined) return "";
  return `try { ${varName}.property(${jsxVal(matchName)}).setValue(${jsxVal(opacity)}); } catch (eOp) {}`;
}

/** Standard comp/layer/group params shared by every add_* op below. */
function shapeTargetParams() {
  return [
    { name: "comp", type: "any" as const, description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any" as const,
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "groupIndex",
      type: "number" as const,
      description: "1-based group index within Contents",
      required: true,
    },
  ];
}

registerOp({
  name: "shape.add_polystar",
  category: "shape",
  description: "Add a Polystar Path (star or polygon) to a shape group.",
  params: [
    ...shapeTargetParams(),
    {
      name: "starType",
      type: "string",
      description: "star|polygon (default star)",
      required: false,
      default: "star",
    },
    {
      name: "points",
      type: "number",
      description: "Number of points",
      required: false,
      default: 5,
    },
    {
      name: "position",
      type: "array",
      description: "[x, y] offset from group center",
      required: false,
      default: [0, 0],
    },
    { name: "rotation", type: "number", description: "Rotation in degrees", required: false },
    {
      name: "outerRadius",
      type: "number",
      description: "Outer radius in px",
      required: false,
      default: 100,
    },
    {
      name: "innerRadius",
      type: "number",
      description: "Inner radius in px (star type only)",
      required: false,
    },
    {
      name: "outerRoundness",
      type: "number",
      description: "Outer roundness % (0-100)",
      required: false,
    },
    {
      name: "innerRoundness",
      type: "number",
      description: "Inner roundness % (star type only)",
      required: false,
    },
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.rotation !== undefined)
      sets.push(`_star.property("ADBE Vector Star Rotation").setValue(${jsxVal(args.rotation)});`);
    if (args.innerRadius !== undefined)
      sets.push(
        `try { _star.property("ADBE Vector Star Inner Radius").setValue(${jsxVal(args.innerRadius)}); } catch (eIr) {}`,
      );
    if (args.outerRoundness !== undefined)
      sets.push(
        // AE's real matchName is misspelled ("Roundess"), so keep it verbatim.
        `try { _star.property("ADBE Vector Star Outer Roundess").setValue(${jsxVal(args.outerRoundness)}); } catch (eOr) {}`,
      );
    if (args.innerRoundness !== undefined)
      sets.push(
        `try { _star.property("ADBE Vector Star Inner Roundess").setValue(${jsxVal(args.innerRoundness)}); } catch (eIrn) {}`,
      );
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _star = _grp.property("Contents").addProperty("ADBE Vector Shape - Star");
            _star.property("ADBE Vector Star Type").setValue(${jsxVal(args.starType ?? "star")} === "polygon" ? 2 : 1);
            _star.property("ADBE Vector Star Points").setValue(${jsxVal(args.points ?? 5)});
            _star.property("ADBE Vector Star Position").setValue(${jsxVal(args.position ?? [0, 0])});
            _star.property("ADBE Vector Star Outer Radius").setValue(${jsxVal(args.outerRadius ?? 100)});
            ${sets.join("\n")}
            return { ok: true, name: _star.name };
        `;
  },
});

registerOp({
  name: "shape.add_repeater",
  category: "shape",
  description:
    "Add a Repeater to a shape group — duplicates the group's contents with a per-copy transform offset.",
  params: [
    ...shapeTargetParams(),
    {
      name: "copies",
      type: "number",
      description: "Number of copies",
      required: false,
      default: 3,
    },
    {
      name: "offset",
      type: "number",
      description: "Copy offset (fractional copies to skip)",
      required: false,
    },
    {
      name: "position",
      type: "array",
      description: "Per-copy position delta [x, y] (default [100, 0])",
      required: false,
    },
    {
      name: "rotation",
      type: "number",
      description: "Per-copy rotation in degrees",
      required: false,
    },
    {
      name: "scale",
      type: "array",
      description: "Per-copy scale [x, y] % (default [100, 100])",
      required: false,
    },
    {
      name: "startOpacity",
      type: "number",
      description: "Opacity % of first copy",
      required: false,
    },
    { name: "endOpacity", type: "number", description: "Opacity % of last copy", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _rep = _grp.property("Contents").addProperty("ADBE Vector Filter - Repeater");
            _rep.property("ADBE Vector Repeater Copies").setValue(${jsxVal(args.copies ?? 3)});
            ${args.offset !== undefined ? `_rep.property("ADBE Vector Repeater Offset").setValue(${jsxVal(args.offset)});` : ""}
            var _rxf = _rep.property("ADBE Vector Repeater Transform");
            ${args.position !== undefined ? `_rxf.property("ADBE Vector Repeater Position").setValue(${jsxVal(args.position)});` : ""}
            ${args.rotation !== undefined ? `_rxf.property("ADBE Vector Repeater Rotation").setValue(${jsxVal(args.rotation)});` : ""}
            ${args.scale !== undefined ? `_rxf.property("ADBE Vector Repeater Scale").setValue(${jsxVal(args.scale)});` : ""}
            ${args.startOpacity !== undefined ? `_rxf.property("ADBE Vector Repeater Start Opacity").setValue(${jsxVal(args.startOpacity)});` : ""}
            ${args.endOpacity !== undefined ? `_rxf.property("ADBE Vector Repeater End Opacity").setValue(${jsxVal(args.endOpacity)});` : ""}
            return { ok: true, name: _rep.name };
        `;
  },
});

registerOp({
  name: "shape.add_rounded_corners",
  category: "shape",
  description: "Add Rounded Corners to a shape group.",
  params: [
    ...shapeTargetParams(),
    {
      name: "radius",
      type: "number",
      description: "Corner radius in px",
      required: false,
      default: 10,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _rc = _grp.property("Contents").addProperty("ADBE Vector Filter - RC");
            _rc.property("ADBE Vector RoundCorner Radius").setValue(${jsxVal(args.radius ?? 10)});
            return { ok: true, name: _rc.name };
        `;
  },
});

registerOp({
  name: "shape.add_offset_paths",
  category: "shape",
  description: "Add Offset Paths to a shape group (grow/shrink outlines).",
  params: [
    ...shapeTargetParams(),
    {
      name: "amount",
      type: "number",
      description: "Offset in px (positive grows, negative shrinks)",
      required: false,
      default: 10,
    },
    {
      name: "lineJoin",
      type: "string",
      description: "miter|round|bevel (default miter)",
      required: false,
    },
    { name: "miterLimit", type: "number", description: "Miter limit", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _off = _grp.property("Contents").addProperty("ADBE Vector Filter - Offset");
            _off.property("ADBE Vector Offset Amount").setValue(${jsxVal(args.amount ?? 10)});
            var _joinMap = { "miter": 1, "round": 2, "bevel": 3 };
            ${args.lineJoin !== undefined ? `_off.property("ADBE Vector Offset Line Join").setValue(_joinMap[${jsxVal(args.lineJoin)}] || 1);` : ""}
            ${args.miterLimit !== undefined ? `_off.property("ADBE Vector Offset Miter Limit").setValue(${jsxVal(args.miterLimit)});` : ""}
            return { ok: true, name: _off.name };
        `;
  },
});

registerOp({
  name: "shape.add_wiggle_paths",
  category: "shape",
  description: "Add Wiggle Paths (roughen) to a shape group.",
  params: [
    ...shapeTargetParams(),
    {
      name: "size",
      type: "number",
      description: "Wiggle size in px",
      required: false,
      default: 10,
    },
    {
      name: "detail",
      type: "number",
      description: "Detail (segments)",
      required: false,
      default: 10,
    },
    {
      name: "pointType",
      type: "string",
      description: "corner|smooth (default corner)",
      required: false,
    },
    {
      name: "wigglesPerSecond",
      type: "number",
      description: "Temporal frequency (0 = static)",
      required: false,
    },
    { name: "correlation", type: "number", description: "Correlation % (0-100)", required: false },
    { name: "seed", type: "number", description: "Random seed", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _wig = _grp.property("Contents").addProperty("ADBE Vector Filter - Roughen");
            _wig.property("ADBE Vector Roughen Size").setValue(${jsxVal(args.size ?? 10)});
            _wig.property("ADBE Vector Roughen Detail").setValue(${jsxVal(args.detail ?? 10)});
            ${args.pointType !== undefined ? `_wig.property("ADBE Vector Roughen Points").setValue(${jsxVal(args.pointType)} === "smooth" ? 2 : 1);` : ""}
            ${args.wigglesPerSecond !== undefined ? `_wig.property("ADBE Vector Temporal Freq").setValue(${jsxVal(args.wigglesPerSecond)});` : ""}
            ${args.correlation !== undefined ? `_wig.property("ADBE Vector Correlation").setValue(${jsxVal(args.correlation)});` : ""}
            ${args.seed !== undefined ? `_wig.property("ADBE Vector Random Seed").setValue(${jsxVal(args.seed)});` : ""}
            return { ok: true, name: _wig.name };
        `;
  },
});

registerOp({
  name: "shape.add_zigzag",
  category: "shape",
  description: "Add Zig Zag to a shape group.",
  params: [
    ...shapeTargetParams(),
    {
      name: "size",
      type: "number",
      description: "Zig zag size in px",
      required: false,
      default: 10,
    },
    {
      name: "ridgesPerSegment",
      type: "number",
      description: "Ridges per segment",
      required: false,
      default: 10,
    },
    {
      name: "pointType",
      type: "string",
      description: "corner|smooth (default corner)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _zz = _grp.property("Contents").addProperty("ADBE Vector Filter - Zigzag");
            _zz.property("ADBE Vector Zigzag Size").setValue(${jsxVal(args.size ?? 10)});
            _zz.property("ADBE Vector Zigzag Detail").setValue(${jsxVal(args.ridgesPerSegment ?? 10)});
            ${args.pointType !== undefined ? `_zz.property("ADBE Vector Zigzag Points").setValue(${jsxVal(args.pointType)} === "smooth" ? 2 : 1);` : ""}
            return { ok: true, name: _zz.name };
        `;
  },
});

registerOp({
  name: "shape.add_pucker_bloat",
  category: "shape",
  description: "Add Pucker & Bloat to a shape group (negative = pucker, positive = bloat).",
  params: [
    ...shapeTargetParams(),
    {
      name: "amount",
      type: "number",
      description: "Amount % (-100..100)",
      required: false,
      default: 0,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _pb = _grp.property("Contents").addProperty("ADBE Vector Filter - PB");
            _pb.property("ADBE Vector PuckerBloat Amount").setValue(${jsxVal(args.amount ?? 0)});
            return { ok: true, name: _pb.name };
        `;
  },
});

registerOp({
  name: "shape.add_twist",
  category: "shape",
  description: "Add Twist to a shape group.",
  params: [
    ...shapeTargetParams(),
    {
      name: "angle",
      type: "number",
      description: "Twist angle in degrees",
      required: false,
      default: 90,
    },
    { name: "center", type: "array", description: "Twist center [x, y]", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _tw = _grp.property("Contents").addProperty("ADBE Vector Filter - Twist");
            _tw.property("ADBE Vector Twist Angle").setValue(${jsxVal(args.angle ?? 90)});
            ${args.center !== undefined ? `_tw.property("ADBE Vector Twist Center").setValue(${jsxVal(args.center)});` : ""}
            return { ok: true, name: _tw.name };
        `;
  },
});

registerOp({
  name: "shape.add_gradient_fill",
  category: "shape",
  description:
    "Add a Gradient Fill to a shape group. Type and start/end points are scriptable; color stops are NOT scriptable in AE (defaults to white-to-black — edit stops manually or via a preset).",
  params: [
    ...shapeTargetParams(),
    {
      name: "gradientType",
      type: "string",
      description: "linear|radial (default linear)",
      required: false,
      default: "linear",
    },
    { name: "startPoint", type: "array", description: "Gradient start [x, y]", required: false },
    { name: "endPoint", type: "array", description: "Gradient end [x, y]", required: false },
    { name: "opacity", type: "number", description: "Opacity 0-100", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _gf = _grp.property("Contents").addProperty("ADBE Vector Graphic - G-Fill");
            _gf.property("ADBE Vector Grad Type").setValue(${jsxVal(args.gradientType ?? "linear")} === "radial" ? 2 : 1);
            ${args.startPoint !== undefined ? `_gf.property("ADBE Vector Grad Start Pt").setValue(${jsxVal(args.startPoint)});` : ""}
            ${args.endPoint !== undefined ? `_gf.property("ADBE Vector Grad End Pt").setValue(${jsxVal(args.endPoint)});` : ""}
            ${jsxGradientOpacity("_gf", "ADBE Vector Fill Opacity", args.opacity)}
            return { ok: true, name: _gf.name, note: "gradient color stops are not scriptable in AE" };
        `;
  },
});

registerOp({
  name: "shape.add_gradient_stroke",
  category: "shape",
  description:
    "Add a Gradient Stroke to a shape group. Type, points, and width are scriptable; color stops are NOT scriptable in AE.",
  params: [
    ...shapeTargetParams(),
    {
      name: "gradientType",
      type: "string",
      description: "linear|radial (default linear)",
      required: false,
      default: "linear",
    },
    { name: "startPoint", type: "array", description: "Gradient start [x, y]", required: false },
    { name: "endPoint", type: "array", description: "Gradient end [x, y]", required: false },
    { name: "width", type: "number", description: "Stroke width", required: false, default: 2 },
    { name: "opacity", type: "number", description: "Opacity 0-100", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _gs = _grp.property("Contents").addProperty("ADBE Vector Graphic - G-Stroke");
            _gs.property("ADBE Vector Grad Type").setValue(${jsxVal(args.gradientType ?? "linear")} === "radial" ? 2 : 1);
            ${args.startPoint !== undefined ? `_gs.property("ADBE Vector Grad Start Pt").setValue(${jsxVal(args.startPoint)});` : ""}
            ${args.endPoint !== undefined ? `_gs.property("ADBE Vector Grad End Pt").setValue(${jsxVal(args.endPoint)});` : ""}
            _gs.property("ADBE Vector Stroke Width").setValue(${jsxVal(args.width ?? 2)});
            ${jsxGradientOpacity("_gs", "ADBE Vector Stroke Opacity", args.opacity)}
            return { ok: true, name: _gs.name, note: "gradient color stops are not scriptable in AE" };
        `;
  },
});

registerOp({
  name: "shape.add_wiggle_transform",
  category: "shape",
  description:
    "Add Wiggle Transform to a shape group - randomizes position/scale/rotation over time (the transform-space sibling of Wiggle Paths).",
  params: [
    ...shapeTargetParams(),
    {
      name: "wigglesPerSecond",
      type: "number",
      description: "Temporal frequency (default 2)",
      required: false,
      default: 2,
    },
    { name: "correlation", type: "number", description: "Correlation % (0-100)", required: false },
    { name: "position", type: "array", description: "[x,y] wiggle amount in px", required: false },
    { name: "scale", type: "array", description: "[sx,sy] wiggle amount in %", required: false },
    {
      name: "rotation",
      type: "number",
      description: "Rotation wiggle amount in degrees",
      required: false,
    },
    { name: "seed", type: "number", description: "Random seed", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            ${jsxShapeGroupPreamble(args)}
            var _wt = _grp.property("Contents").addProperty("ADBE Vector Filter - Wiggler");
            _wt.property("ADBE Vector Xform Temporal Freq").setValue(${jsxVal(args.wigglesPerSecond ?? 2)});
            ${args.correlation !== undefined ? `_wt.property("ADBE Vector Correlation").setValue(${jsxVal(args.correlation)});` : ""}
            ${args.seed !== undefined ? `_wt.property("ADBE Vector Random Seed").setValue(${jsxVal(args.seed)});` : ""}
            var _wxf = _wt.property("ADBE Vector Wiggler Transform");
            ${args.position !== undefined ? `_wxf.property("ADBE Vector Wiggler Position").setValue(${jsxVal(args.position)});` : ""}
            ${args.scale !== undefined ? `_wxf.property("ADBE Vector Wiggler Scale").setValue(${jsxVal(args.scale)});` : ""}
            ${args.rotation !== undefined ? `_wxf.property("ADBE Vector Wiggler Rotation").setValue(${jsxVal(args.rotation)});` : ""}
            return { ok: true, name: _wt.name };
        `;
  },
});
