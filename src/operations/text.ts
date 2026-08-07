// Text layer operations — set content, style.

import { registerOp, jsxVal, jsxCompLayerPreamble } from "../registry.js";

registerOp({
  name: "text.set_content",
  category: "text",
  description: "Set the text content of a text layer.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index or name (must be a TextLayer)",
      required: true,
    },
    { name: "text", type: "string", description: "New text string", required: true },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            if (!(_layer instanceof TextLayer)) return { ok: false, error: "layer is not a TextLayer" };
            var _src = _layer.property("Source Text");
            var _doc = _src.value;
            _doc.text = ${jsxVal(args.text)};
            _src.setValue(_doc);
            return { ok: true, text: _doc.text };
        `;
  },
});

registerOp({
  name: "text.set_style",
  category: "text",
  description:
    "Set text styling: font, fontSize, fillColor, strokeColor, tracking, leading, justification, etc.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "font",
      type: "string",
      description: "Font postscript name (e.g. 'Arial-BoldMT')",
      required: false,
    },
    { name: "fontSize", type: "number", description: "Font size in px", required: false },
    { name: "fillColor", type: "array", description: "[r,g,b] 0-1", required: false },
    { name: "strokeColor", type: "array", description: "[r,g,b] 0-1", required: false },
    { name: "strokeWidth", type: "number", description: "Stroke width in px", required: false },
    { name: "tracking", type: "number", description: "Tracking value", required: false },
    {
      name: "leading",
      type: "number",
      description: "Leading (line spacing) in px",
      required: false,
    },
    { name: "applyFill", type: "boolean", description: "Enable fill", required: false },
    { name: "applyStroke", type: "boolean", description: "Enable stroke", required: false },
    {
      name: "justification",
      type: "string",
      description: "left|center|right|fullLeft|fullCenter|fullRight|fullLastLineFull",
      required: false,
    },
    {
      name: "baselineShift",
      type: "number",
      description: "Baseline shift in px",
      required: false,
    },
    { name: "autoLeading", type: "boolean", description: "Use auto leading", required: false },
    {
      name: "allCaps",
      type: "boolean",
      description: "All caps via fontCapsOption (setter needs AE 24.0+)",
      required: false,
    },
    {
      name: "smallCaps",
      type: "boolean",
      description: "Small caps via fontCapsOption (setter needs AE 24.0+)",
      required: false,
    },
    {
      name: "fauxBold",
      type: "boolean",
      description: "Faux bold (setter needs AE 24.0+)",
      required: false,
    },
    {
      name: "fauxItalic",
      type: "boolean",
      description: "Faux italic (setter needs AE 24.0+)",
      required: false,
    },
    {
      name: "horizontalScale",
      type: "number",
      description: "Horizontal scale (1 = 100%, setter needs AE 24.0+)",
      required: false,
    },
    {
      name: "verticalScale",
      type: "number",
      description: "Vertical scale (1 = 100%, setter needs AE 24.0+)",
      required: false,
    },
    {
      name: "tsume",
      type: "number",
      description: "Tsume (normalized 0-1, CJK spacing, setter needs AE 24.0+)",
      required: false,
    },
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.font !== undefined)
      sets.push(`try { _doc.font = ${jsxVal(args.font)}; } catch(e) { _w.push("font: "+e); }`);
    if (args.fontSize !== undefined)
      sets.push(
        `try { _doc.fontSize = ${jsxVal(args.fontSize)}; } catch(e) { _w.push("fontSize: "+e); }`,
      );
    if (args.fillColor !== undefined)
      sets.push(
        `try { _doc.fillColor = ${jsxVal(args.fillColor)}; } catch(e) { _w.push("fillColor: "+e); }`,
      );
    if (args.strokeColor !== undefined)
      sets.push(
        `try { _doc.strokeColor = ${jsxVal(args.strokeColor)}; } catch(e) { _w.push("strokeColor: "+e); }`,
      );
    if (args.strokeWidth !== undefined)
      sets.push(
        `try { _doc.strokeWidth = ${jsxVal(args.strokeWidth)}; } catch(e) { _w.push("strokeWidth: "+e); }`,
      );
    if (args.tracking !== undefined)
      sets.push(
        `try { _doc.tracking = ${jsxVal(args.tracking)}; } catch(e) { _w.push("tracking: "+e); }`,
      );
    if (args.leading !== undefined)
      sets.push(
        `try { _doc.leading = ${jsxVal(args.leading)}; } catch(e) { _w.push("leading: "+e); }`,
      );
    if (args.applyFill !== undefined)
      sets.push(
        `try { _doc.applyFill = ${jsxVal(args.applyFill)}; } catch(e) { _w.push("applyFill: "+e); }`,
      );
    if (args.applyStroke !== undefined)
      sets.push(
        `try { _doc.applyStroke = ${jsxVal(args.applyStroke)}; } catch(e) { _w.push("applyStroke: "+e); }`,
      );
    if (args.justification !== undefined)
      sets.push(`
        try {
            var _justMap = {
                "left": ParagraphJustification.LEFT_JUSTIFY,
                "center": ParagraphJustification.CENTER_JUSTIFY,
                "right": ParagraphJustification.RIGHT_JUSTIFY,
                "fullLeft": ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT,
                "fullCenter": ParagraphJustification.FULL_JUSTIFY_LASTLINE_CENTER,
                "fullRight": ParagraphJustification.FULL_JUSTIFY_LASTLINE_RIGHT,
                "fullLastLineFull": ParagraphJustification.FULL_JUSTIFY_LASTLINE_FULL
            };
            var _just = _justMap[${jsxVal(args.justification)}];
            if (_just === undefined) { _w.push("justification: unknown value"); }
            else { _doc.justification = _just; }
        } catch(e) { _w.push("justification: "+e); }`);
    if (args.baselineShift !== undefined)
      sets.push(
        `try { _doc.baselineShift = ${jsxVal(args.baselineShift)}; } catch(e) { _w.push("baselineShift: "+e); }`,
      );
    if (args.autoLeading !== undefined)
      sets.push(
        `try { _doc.autoLeading = ${jsxVal(args.autoLeading)}; } catch(e) { _w.push("autoLeading: "+e); }`,
      );
    // allCaps/smallCaps are read-only on TextDocument; the writable control is
    // fontCapsOption (FontCapsOption enum, AE 24.0+).
    // Both flags are views of one AE property, so assigning them separately
    // makes the second write clobber the first — {allCaps: true, smallCaps:
    // false} used to end up as normal caps. Resolve them into one assignment,
    // all-caps winning if a caller sets both. The enum member is picked here
    // from a fixed set, never interpolated from the argument.
    if (args.allCaps !== undefined || args.smallCaps !== undefined) {
      const caps = args.allCaps
        ? "FONT_ALL_CAPS"
        : args.smallCaps
          ? "FONT_SMALL_CAPS"
          : "FONT_NORMAL_CAPS";
      sets.push(
        `try { _doc.fontCapsOption = FontCapsOption.${caps}; } catch(e) { _w.push("allCaps/smallCaps (AE 24.0+): "+e); }`,
      );
    }
    if (args.fauxBold !== undefined)
      sets.push(
        `try { _doc.fauxBold = ${jsxVal(args.fauxBold)}; } catch(e) { _w.push("fauxBold (AE 24.0+): "+e); }`,
      );
    if (args.fauxItalic !== undefined)
      sets.push(
        `try { _doc.fauxItalic = ${jsxVal(args.fauxItalic)}; } catch(e) { _w.push("fauxItalic (AE 24.0+): "+e); }`,
      );
    if (args.horizontalScale !== undefined)
      sets.push(
        `try { _doc.horizontalScale = ${jsxVal(args.horizontalScale)}; } catch(e) { _w.push("horizontalScale (AE 24.0+): "+e); }`,
      );
    if (args.verticalScale !== undefined)
      sets.push(
        `try { _doc.verticalScale = ${jsxVal(args.verticalScale)}; } catch(e) { _w.push("verticalScale (AE 24.0+): "+e); }`,
      );
    if (args.tsume !== undefined)
      sets.push(
        `try { _doc.tsume = ${jsxVal(args.tsume)}; } catch(e) { _w.push("tsume (AE 24.0+): "+e); }`,
      );
    return `
            ${jsxCompLayerPreamble(args)}
            if (!(_layer instanceof TextLayer)) return { ok: false, error: "not a TextLayer" };
            var _src = _layer.property("Source Text");
            var _doc = _src.value;
            var _w = [];
            ${sets.join("\n")}
            _src.setValue(_doc);
            return { ok: true, warnings: _w };
        `;
  },
});

registerOp({
  name: "text.set_box",
  category: "text",
  description:
    "Resize or reposition the box of a paragraph (box) text layer. Point<->box conversion is NOT scriptable in AE — create the layer as box text instead (layer.create_text with box options, or a box template).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "boxSize",
      type: "array",
      description: "[width, height] of the text box",
      required: false,
    },
    {
      name: "boxPosition",
      type: "array",
      description: "[x, y] top-left of the box in layer space (AE 14.0+)",
      required: false,
    },
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.boxSize !== undefined)
      sets.push(
        `try { _doc.boxTextSize = ${jsxVal(args.boxSize)}; } catch (eBs) { _w.push("boxTextSize: " + eBs); }`,
      );
    if (args.boxPosition !== undefined)
      sets.push(
        `try { _doc.boxTextPos = ${jsxVal(args.boxPosition)}; } catch (eBp) { _w.push("boxTextPos (AE 14.0+): " + eBp); }`,
      );
    return `
            ${jsxCompLayerPreamble(args)}
            if (!(_layer instanceof TextLayer)) return { ok: false, error: "not a TextLayer" };
            var _src = _layer.property("Source Text");
            var _doc = _src.value;
            if (!_doc.boxText) return { ok: false, error: "layer is point text, not box text — conversion is not scriptable in AE" };
            var _w = [];
            ${sets.join("\n")}
            _src.setValue(_doc);
            var _out = _src.value;
            return { ok: true, boxText: _out.boxText, boxTextSize: [_out.boxTextSize[0], _out.boxTextSize[1]], warnings: _w };
        `;
  },
});

registerOp({
  name: "text.add_animator",
  category: "text",
  description:
    'Add a text animator with animated properties and a selector. properties maps animator matchNames to initial values, e.g. {"ADBE Text Position 3D": [0,-50,0], "ADBE Text Opacity": 0}. Common: Position 3D, Scale 3D, Rotation, Opacity, Fill Color, Tracking Amount, Blur.',
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name (must be a TextLayer)",
      required: true,
    },
    { name: "name", type: "string", description: "Animator name", required: false },
    {
      name: "properties",
      type: "object",
      description: "Map of animator-property matchName to initial value",
      required: true,
    },
    {
      name: "selector",
      type: "string",
      description: "range|wiggly|expression|none (default range)",
      required: false,
      default: "range",
    },
    {
      name: "rangeStart",
      type: "number",
      description: "Range selector start % (0-100)",
      required: false,
    },
    {
      name: "rangeEnd",
      type: "number",
      description: "Range selector end % (0-100)",
      required: false,
    },
    {
      name: "rangeOffset",
      type: "number",
      description: "Range selector offset % (-100..100)",
      required: false,
    },
  ],
  toJsx(args) {
    const renameJsx = args.name ? `try { _anim.name = ${jsxVal(args.name)}; } catch (eN) {}` : "";
    const rangeSets: string[] = [];
    if (args.rangeStart !== undefined)
      rangeSets.push(
        `try { _sel.property("ADBE Text Percent Start").setValue(${jsxVal(args.rangeStart)}); } catch (eRs) { _w.push("rangeStart: " + eRs); }`,
      );
    if (args.rangeEnd !== undefined)
      rangeSets.push(
        `try { _sel.property("ADBE Text Percent End").setValue(${jsxVal(args.rangeEnd)}); } catch (eRe) { _w.push("rangeEnd: " + eRe); }`,
      );
    if (args.rangeOffset !== undefined)
      rangeSets.push(
        `try { _sel.property("ADBE Text Percent Offset").setValue(${jsxVal(args.rangeOffset)}); } catch (eRo) { _w.push("rangeOffset: " + eRo); }`,
      );
    return `
            ${jsxCompLayerPreamble(args)}
            if (!(_layer instanceof TextLayer)) return { ok: false, error: "not a TextLayer" };
            var _animators = _layer.property("ADBE Text Properties").property("ADBE Text Animators");
            if (!_animators) return { ok: false, error: "no Animators group on layer" };
            var _anim = _animators.addProperty("ADBE Text Animator");
            ${renameJsx}
            var _w = [];
            var _props = ${jsxVal(args.properties)};
            var _animProps = _anim.property("ADBE Text Animator Properties");
            var _added = [];
            for (var _k in _props) {
                if (!_props.hasOwnProperty(_k)) continue;
                try {
                    var _ap = _animProps.addProperty(_k);
                    if (_props[_k] !== null) _ap.setValue(_props[_k]);
                    _added.push(_k);
                } catch (eAp) { _w.push(_k + ": " + eAp); }
            }
            var _selType = ${jsxVal(args.selector ?? "range")};
            var _selName = null;
            if (_selType !== "none") {
                try {
                    var _selectors = _anim.property("ADBE Text Selectors");
                    var _selMn = "ADBE Text Selector";
                    if (_selType === "wiggly") _selMn = "ADBE Text Wiggly Selector";
                    else if (_selType === "expression") _selMn = "ADBE Text Expressible Selector";
                    var _sel = _selectors.addProperty(_selMn);
                    _selName = _sel.name;
                    if (_selType === "range") {
                        ${rangeSets.join("\n")}
                    }
                } catch (eSel) { _w.push("selector: " + eSel); }
            }
            return { ok: true, animator: _anim.name, animatorIndex: _anim.propertyIndex, addedProperties: _added, selector: _selName, warnings: _w };
        `;
  },
});
