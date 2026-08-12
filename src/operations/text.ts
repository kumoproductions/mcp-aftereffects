// Text layer operations — set content, style (whole-document and per-range),
// box geometry, measurement, animators.

import type { OperationParam } from "../registry.js";
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

// --- Shared styling surface -------------------------------------------------
// text.set_style and text.set_style_range accept the same attributes; the
// range op just points them at a CharacterRange instead of the TextDocument
// (CharacterRange mirrors the TextDocument styling surface, AE 24.3+).

/** One guarded attribute assignment against `target`. */
function jsxDocSet(target: string, attr: string, value: unknown, note = ""): string {
  return `try { ${target}.${attr} = ${jsxVal(value)}; } catch(e) { _w.push("${attr}${note}: "+AE.errText(e)); }`;
}

/** One guarded enum-mapped assignment against `target`. */
function jsxDocEnumSet(
  target: string,
  attr: string,
  enumName: string,
  map: Record<string, string>,
  value: unknown,
  note = "",
): string {
  const entries = Object.entries(map)
    .map(([k, m]) => `"${k}": ${enumName}.${m}`)
    .join(", ");
  return `
        try {
            var _em_${attr} = { ${entries} };
            if (_em_${attr}.hasOwnProperty(${jsxVal(value)})) { ${target}.${attr} = _em_${attr}[${jsxVal(value)}]; }
            else { _w.push("${attr}: unknown value " + ${jsxVal(value)}); }
        } catch(e) { _w.push("${attr}${note}: "+AE.errText(e)); }`;
}

const AE24 = " (AE 24.0+)";

/** Style params shared by text.set_style and text.set_style_range. */
const TEXT_STYLE_PARAMS: OperationParam[] = [
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
  { name: "leading", type: "number", description: "Leading (line spacing) in px", required: false },
  { name: "applyFill", type: "boolean", description: "Enable fill", required: false },
  { name: "applyStroke", type: "boolean", description: "Enable stroke", required: false },
  {
    name: "strokeOverFill",
    type: "boolean",
    description: "Render stroke over fill",
    required: false,
  },
  {
    name: "justification",
    type: "string",
    description: "left|center|right|fullLeft|fullCenter|fullRight|fullLastLineFull",
    required: false,
  },
  { name: "baselineShift", type: "number", description: "Baseline shift in px", required: false },
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
  {
    name: "kerning",
    type: "number",
    description: "Manual kerning amount (AE 24.0+)",
    required: false,
  },
  {
    name: "autoKernType",
    type: "string",
    description: "none|metric|optical (AE 24.0+)",
    required: false,
  },
  {
    name: "ligature",
    type: "boolean",
    description: "Enable ligatures (AE 24.0+)",
    required: false,
  },
  {
    name: "noBreak",
    type: "boolean",
    description: "Prevent line breaks (AE 24.0+)",
    required: false,
  },
  {
    name: "autoHyphenate",
    type: "boolean",
    description: "Paragraph auto-hyphenation (AE 24.0+)",
    required: false,
  },
  {
    name: "everyLineComposer",
    type: "boolean",
    description: "true=Every-Line Composer, false=Single-Line (AE 24.0+)",
    required: false,
  },
  {
    name: "hangingRoman",
    type: "boolean",
    description: "Roman hanging punctuation (burasagari, AE 24.0+)",
    required: false,
  },
  {
    name: "firstLineIndent",
    type: "number",
    description: "Paragraph first-line indent in px (AE 24.0+)",
    required: false,
  },
  {
    name: "startIndent",
    type: "number",
    description: "Paragraph start indent in px (AE 24.0+)",
    required: false,
  },
  {
    name: "endIndent",
    type: "number",
    description: "Paragraph end indent in px (AE 24.0+)",
    required: false,
  },
  {
    name: "spaceBefore",
    type: "number",
    description: "Paragraph space before in px (AE 24.0+)",
    required: false,
  },
  {
    name: "spaceAfter",
    type: "number",
    description: "Paragraph space after in px (AE 24.0+)",
    required: false,
  },
  {
    name: "fontBaselineOption",
    type: "string",
    description: "normal|superscript|subscript (AE 24.0+)",
    required: false,
  },
  {
    name: "baselineDirection",
    type: "string",
    description: "withStream|verticalRotated|verticalCrossStream (tate-chu-yoko, AE 24.0+)",
    required: false,
  },
  {
    name: "direction",
    type: "string",
    description: "leftToRight|rightToLeft paragraph direction (AE 24.0+)",
    required: false,
  },
  {
    name: "leadingType",
    type: "string",
    description: "roman|japanese leading model (AE 24.0+)",
    required: false,
  },
  {
    name: "lineJoinType",
    type: "string",
    description: "miter|round|bevel stroke joins (AE 24.0+)",
    required: false,
  },
  {
    name: "digitSet",
    type: "string",
    description: "default|arabic|hindi|farsi|arabicRtl (AE 24.0+)",
    required: false,
  },
  {
    name: "composerEngine",
    type: "string",
    description: "latinCjk|universalType (AE 24.0+; universalType needed for RTL)",
    required: false,
  },
  {
    name: "lineOrientation",
    type: "string",
    description: "horizontal|verticalRtl|verticalLtr (whole document only, AE 24.2+)",
    required: false,
  },
];

/**
 * Generate the guarded style assignments for every style arg present, against
 * `target` (`_doc` for the whole document, `_range` for a CharacterRange).
 * Expects `_w` (warnings array) in scope.
 */
function jsxTextStyleSets(args: Record<string, unknown>, target: string): string {
  const sets: string[] = [];
  const simple: Array<[string, string]> = [
    ["font", ""],
    ["fontSize", ""],
    ["fillColor", ""],
    ["strokeColor", ""],
    ["strokeWidth", ""],
    ["tracking", ""],
    ["leading", ""],
    ["applyFill", ""],
    ["applyStroke", ""],
    ["strokeOverFill", ""],
    ["baselineShift", ""],
    ["autoLeading", ""],
    ["fauxBold", AE24],
    ["fauxItalic", AE24],
    ["horizontalScale", AE24],
    ["verticalScale", AE24],
    ["tsume", AE24],
    ["kerning", AE24],
    ["ligature", AE24],
    ["noBreak", AE24],
    ["autoHyphenate", AE24],
    ["everyLineComposer", AE24],
    ["hangingRoman", AE24],
    ["firstLineIndent", AE24],
    ["startIndent", AE24],
    ["endIndent", AE24],
    ["spaceBefore", AE24],
    ["spaceAfter", AE24],
  ];
  for (const [attr, note] of simple) {
    if (args[attr] !== undefined) sets.push(jsxDocSet(target, attr, args[attr], note));
  }
  if (args.justification !== undefined)
    sets.push(
      jsxDocEnumSet(
        target,
        "justification",
        "ParagraphJustification",
        {
          left: "LEFT_JUSTIFY",
          center: "CENTER_JUSTIFY",
          right: "RIGHT_JUSTIFY",
          fullLeft: "FULL_JUSTIFY_LASTLINE_LEFT",
          fullCenter: "FULL_JUSTIFY_LASTLINE_CENTER",
          fullRight: "FULL_JUSTIFY_LASTLINE_RIGHT",
          fullLastLineFull: "FULL_JUSTIFY_LASTLINE_FULL",
        },
        args.justification,
      ),
    );
  // allCaps/smallCaps are read-only views of fontCapsOption — one property, so
  // resolve both flags into a single assignment (all-caps wins when both set).
  if (args.allCaps !== undefined || args.smallCaps !== undefined) {
    const caps = args.allCaps
      ? "FONT_ALL_CAPS"
      : args.smallCaps
        ? "FONT_SMALL_CAPS"
        : "FONT_NORMAL_CAPS";
    sets.push(
      `try { ${target}.fontCapsOption = FontCapsOption.${caps}; } catch(e) { _w.push("allCaps/smallCaps${AE24}: "+AE.errText(e)); }`,
    );
  }
  if (args.autoKernType !== undefined)
    sets.push(
      jsxDocEnumSet(
        target,
        "autoKernType",
        "AutoKernType",
        { none: "NO_AUTO_KERN", metric: "METRIC_KERN", optical: "OPTICAL_KERN" },
        args.autoKernType,
        AE24,
      ),
    );
  if (args.fontBaselineOption !== undefined)
    sets.push(
      jsxDocEnumSet(
        target,
        "fontBaselineOption",
        "FontBaselineOption",
        {
          normal: "FONT_NORMAL_BASELINE",
          superscript: "FONT_FAUXED_SUPERSCRIPT",
          subscript: "FONT_FAUXED_SUBSCRIPT",
        },
        args.fontBaselineOption,
        AE24,
      ),
    );
  if (args.baselineDirection !== undefined)
    sets.push(
      jsxDocEnumSet(
        target,
        "baselineDirection",
        "BaselineDirection",
        {
          withStream: "BASELINE_WITH_STREAM",
          verticalRotated: "BASELINE_VERTICAL_ROTATED",
          verticalCrossStream: "BASELINE_VERTICAL_CROSS_STREAM",
        },
        args.baselineDirection,
        AE24,
      ),
    );
  if (args.direction !== undefined)
    sets.push(
      jsxDocEnumSet(
        target,
        "direction",
        "ParagraphDirection",
        { leftToRight: "DIRECTION_LEFT_TO_RIGHT", rightToLeft: "DIRECTION_RIGHT_TO_LEFT" },
        args.direction,
        AE24,
      ),
    );
  if (args.leadingType !== undefined)
    sets.push(
      jsxDocEnumSet(
        target,
        "leadingType",
        "LeadingType",
        { roman: "ROMAN_LEADING_TYPE", japanese: "JAPANESE_LEADING_TYPE" },
        args.leadingType,
        AE24,
      ),
    );
  if (args.lineJoinType !== undefined)
    sets.push(
      jsxDocEnumSet(
        target,
        "lineJoinType",
        "LineJoinType",
        { miter: "LINE_JOIN_MITER", round: "LINE_JOIN_ROUND", bevel: "LINE_JOIN_BEVEL" },
        args.lineJoinType,
        AE24,
      ),
    );
  if (args.digitSet !== undefined)
    sets.push(
      jsxDocEnumSet(
        target,
        "digitSet",
        "DigitSet",
        {
          default: "DEFAULT_DIGITS",
          arabic: "ARABIC_DIGITS",
          hindi: "HINDI_DIGITS",
          farsi: "FARSI_DIGITS",
          arabicRtl: "ARABIC_DIGITS_RTL",
        },
        args.digitSet,
        AE24,
      ),
    );
  if (args.composerEngine !== undefined)
    sets.push(
      jsxDocEnumSet(
        target,
        "composerEngine",
        "ComposerEngine",
        { latinCjk: "LATIN_CJK_ENGINE", universalType: "UNIVERSAL_TYPE_ENGINE" },
        args.composerEngine,
        AE24,
      ),
    );
  if (args.lineOrientation !== undefined)
    sets.push(
      jsxDocEnumSet(
        target,
        "lineOrientation",
        "LineOrientation",
        {
          horizontal: "HORIZONTAL",
          verticalRtl: "VERTICAL_RIGHT_TO_LEFT",
          verticalLtr: "VERTICAL_LEFT_TO_RIGHT",
        },
        args.lineOrientation,
        " (AE 24.2+)",
      ),
    );
  return sets.join("\n");
}

registerOp({
  name: "text.set_style",
  category: "text",
  description:
    "Set text styling on the whole document: font, fontSize, colors, tracking, leading, justification, caps, kerning, ligatures, paragraph indents/spacing, RTL direction, vertical baselines, digit set, and more. For a sub-range use text.set_style_range.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    ...TEXT_STYLE_PARAMS,
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            if (!(_layer instanceof TextLayer)) return { ok: false, error: "not a TextLayer" };
            var _src = _layer.property("Source Text");
            var _doc = _src.value;
            var _w = [];
            ${jsxTextStyleSets(args, "_doc")}
            _src.setValue(_doc);
            return { ok: true, warnings: _w };
        `;
  },
});

registerOp({
  name: "text.set_style_range",
  category: "text",
  description:
    "Style a SUB-RANGE of a text layer (AE 24.3+): same attributes as text.set_style, applied to characters, paragraphs, or composed lines. Whole-document-only attributes (lineOrientation) are rejected by AE with a warning.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "rangeType",
      type: "string",
      description: "characters|paragraphs|lines (default characters)",
      required: false,
      default: "characters",
    },
    {
      name: "start",
      type: "number",
      description: "0-based start index (character, paragraph, or composed line)",
      required: true,
    },
    {
      name: "end",
      type: "number",
      description:
        "Exclusive end index. Default: characters → end of text; paragraphs/lines → start+1",
      required: false,
    },
    ...TEXT_STYLE_PARAMS,
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            if (!(_layer instanceof TextLayer)) return { ok: false, error: "not a TextLayer" };
            var _src = _layer.property("Source Text");
            var _doc = _src.value;
            if (typeof _doc.characterRange !== "function") return { ok: false, error: "text ranges need AE 24.3+" };
            var _rt = ${jsxVal(args.rangeType ?? "characters")};
            var _start = ${jsxVal(args.start)};
            var _end = ${jsxVal(args.end ?? null)};
            var _range = null;
            try {
                if (_rt === "characters") {
                    if (_end === null) _end = _doc.text.length;
                    _range = _doc.characterRange(_start, _end);
                } else if (_rt === "paragraphs") {
                    if (_end === null) _end = _start + 1;
                    _range = _doc.paragraphRange(_start, _end).characterRange();
                } else if (_rt === "lines") {
                    if (_end === null) _end = _start + 1;
                    _range = _doc.composedLineRange(_start, _end).characterRange();
                } else {
                    return { ok: false, error: "rangeType must be characters|paragraphs|lines" };
                }
            } catch (eRg) { return { ok: false, error: "range lookup failed: " + AE.errText(eRg) }; }
            if (!_range) return { ok: false, error: "range lookup returned nothing" };
            if (_range.isRangeValid === false) return { ok: false, error: "range is not valid for this text" };
            var _cs = AE.safeGet(function () { return _range.characterStart; }, null);
            var _ce = AE.safeGet(function () { return _range.characterEnd; }, null);
            var _w = [];
            ${jsxTextStyleSets(args, "_range")}
            _src.setValue(_doc);
            return { ok: true, characterStart: _cs, characterEnd: _ce, warnings: _w };
        `;
  },
});

registerOp({
  name: "text.measure",
  category: "text",
  readOnly: true,
  description:
    "Measure a text layer's composed layout: line/paragraph counts and character spans, per-line baselines (baselineLocs), box overflow. Range data needs AE 24.3+; missing fields come back null.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            if (!(_layer instanceof TextLayer)) return { ok: false, error: "not a TextLayer" };
            var _doc = _layer.property("Source Text").value;
            var _out = { ok: true };
            _out.text = _doc.text;
            _out.boxText = AE.safeGet(function () { return _doc.boxText; }, false);
            _out.fontFamily = AE.safeGet(function () { return _doc.fontFamily; }, null);
            _out.fontStyle = AE.safeGet(function () { return _doc.fontStyle; }, null);
            _out.fontLocation = AE.safeGet(function () { return _doc.fontLocation; }, null);
            _out.composedLineCount = AE.safeGet(function () { return _doc.composedLineCount; }, null);
            _out.paragraphCount = AE.safeGet(function () { return _doc.paragraphCount; }, null);
            _out.baselineLocs = AE.safeGet(function () { return AE.valueToJson(_doc.baselineLocs); }, null);
            if (_out.boxText) {
                _out.boxTextSize = AE.safeGet(function () { return AE.valueToJson(_doc.boxTextSize); }, null);
                _out.boxTextPos = AE.safeGet(function () { return AE.valueToJson(_doc.boxTextPos); }, null);
                _out.boxOverflow = AE.safeGet(function () { return _doc.boxOverflow; }, null);
            }
            var _lines = [];
            try {
                var _n = _doc.composedLineCount;
                for (var _li2 = 0; _li2 < _n; _li2++) {
                    var _cr = _doc.composedLineRange(_li2, _li2 + 1);
                    var _lcs = _cr.characterStart;
                    var _lce = _cr.characterEnd;
                    _lines.push({ index: _li2, characterStart: _lcs, characterEnd: _lce, text: _doc.text.substring(_lcs, _lce) });
                }
            } catch (eLn) {}
            _out.lines = _lines;
            var _paras = [];
            try {
                var _np = _doc.paragraphCount;
                for (var _pi2 = 0; _pi2 < _np; _pi2++) {
                    var _pr = _doc.paragraphRange(_pi2, _pi2 + 1);
                    _paras.push({ index: _pi2, characterStart: _pr.characterStart, characterEnd: _pr.characterEnd });
                }
            } catch (ePa) {}
            _out.paragraphs = _paras;
            return _out;
        `;
  },
});

registerOp({
  name: "text.set_box",
  category: "text",
  description:
    "Resize, reposition, or configure the box of a paragraph (box) text layer, including the AE 24.6 auto-fit and alignment controls. Point<->box conversion is NOT scriptable in AE — create the layer as box text from the start (layer.create_text with boxSize).",
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
    {
      name: "autoFitPolicy",
      type: "string",
      description: "none|heightCursor|heightPreciseBounds|heightBaseline (AE 24.6+)",
      required: false,
    },
    {
      name: "verticalAlignment",
      type: "string",
      description: "top|center|bottom|justify (AE 24.6+)",
      required: false,
    },
    {
      name: "firstBaselineAlignment",
      type: "string",
      description:
        "ascent|capHeight|emBox|leading|xHeight|legacyMetric|minimumValueAsian|minimumValueRoman|typoAscent (AE 24.6+)",
      required: false,
    },
    {
      name: "firstBaselineAlignmentMinimum",
      type: "number",
      description: "Manual minimum offset of the first composed line (AE 24.6+)",
      required: false,
    },
    {
      name: "insetSpacing",
      type: "number",
      description: "Inset spacing between box bounds and text, px (AE 24.6+)",
      required: false,
    },
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.boxSize !== undefined)
      sets.push(
        `try { _doc.boxTextSize = ${jsxVal(args.boxSize)}; } catch (eBs) { _w.push("boxTextSize: " + AE.errText(eBs)); }`,
      );
    if (args.boxPosition !== undefined)
      sets.push(
        `try { _doc.boxTextPos = ${jsxVal(args.boxPosition)}; } catch (eBp) { _w.push("boxTextPos (AE 14.0+): " + AE.errText(eBp)); }`,
      );
    const AE246 = " (AE 24.6+)";
    if (args.autoFitPolicy !== undefined)
      sets.push(
        jsxDocEnumSet(
          "_doc",
          "boxAutoFitPolicy",
          "BoxAutoFitPolicy",
          {
            none: "NONE",
            heightCursor: "HEIGHT_CURSOR",
            heightPreciseBounds: "HEIGHT_PRECISE_BOUNDS",
            heightBaseline: "HEIGHT_BASELINE",
          },
          args.autoFitPolicy,
          AE246,
        ),
      );
    if (args.verticalAlignment !== undefined)
      sets.push(
        jsxDocEnumSet(
          "_doc",
          "boxVerticalAlignment",
          "BoxVerticalAlignment",
          { top: "TOP", center: "CENTER", bottom: "BOTTOM", justify: "JUSTIFY" },
          args.verticalAlignment,
          AE246,
        ),
      );
    if (args.firstBaselineAlignment !== undefined)
      sets.push(
        jsxDocEnumSet(
          "_doc",
          "boxFirstBaselineAlignment",
          "BoxFirstBaselineAlignment",
          {
            ascent: "ASCENT",
            capHeight: "CAP_HEIGHT",
            emBox: "EM_BOX",
            leading: "LEADING",
            xHeight: "X_HEIGHT",
            legacyMetric: "LEGACY_METRIC",
            minimumValueAsian: "MINIMUM_VALUE_ASIAN",
            minimumValueRoman: "MINIMUM_VALUE_ROMAN",
            typoAscent: "TYPO_ASCENT",
          },
          args.firstBaselineAlignment,
          AE246,
        ),
      );
    if (args.firstBaselineAlignmentMinimum !== undefined)
      sets.push(
        jsxDocSet(
          "_doc",
          "boxFirstBaselineAlignmentMinimum",
          args.firstBaselineAlignmentMinimum,
          AE246,
        ),
      );
    if (args.insetSpacing !== undefined)
      sets.push(jsxDocSet("_doc", "boxInsetSpacing", args.insetSpacing, AE246));
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
            return { ok: true, boxText: _out.boxText, boxTextSize: [_out.boxTextSize[0], _out.boxTextSize[1]], boxOverflow: AE.safeGet(function () { return _out.boxOverflow; }, null), warnings: _w };
        `;
  },
});

registerOp({
  name: "text.set_variable_font",
  category: "text",
  description:
    'Set variable-font design axes on a text layer (AE 24.0+). axes maps axis tags to values, e.g. { "wght": 700, "wdth": 85 }. Unspecified axes keep their current values. Discover a font\'s axes with font.info (designAxesData).',
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "axes",
      type: "object",
      description: 'Axis tag -> value map, e.g. { "wght": 700 }',
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            if (!(_layer instanceof TextLayer)) return { ok: false, error: "not a TextLayer" };
            var _src = _layer.property("Source Text");
            var _doc = _src.value;
            var _fo = null;
            try { _fo = _doc.fontObject; } catch (eFo) {}
            if (!_fo) return { ok: false, error: "TextDocument.fontObject needs AE 24.0+" };
            if (!_fo.hasDesignAxes) return { ok: false, error: "font '" + _fo.postScriptName + "' is not a variable font" };
            var _axes = ${jsxVal(args.axes)};
            var _data = _fo.designAxesData;
            var _vec = [];
            try {
                var _cur = _fo.designVector;
                for (var _i = 0; _i < _data.length; _i++) _vec.push(_cur[_i]);
            } catch (eCv) {
                for (var _i2 = 0; _i2 < _data.length; _i2++) _vec.push(_data[_i2].min);
            }
            var _w = [];
            var _known = {};
            for (var _di = 0; _di < _data.length; _di++) {
                var _ax = _data[_di];
                _known[_ax.tag] = true;
                if (_axes.hasOwnProperty(_ax.tag)) {
                    var _v = _axes[_ax.tag];
                    if (typeof _v !== "number") { _w.push(_ax.tag + ": value must be a number"); continue; }
                    if (_v < _ax.min || _v > _ax.max) _w.push(_ax.tag + ": " + _v + " outside [" + _ax.min + ", " + _ax.max + "] — AE may clamp");
                    _vec[_di] = _v;
                }
            }
            for (var _tag in _axes) {
                if (_axes.hasOwnProperty(_tag) && _known[_tag] !== true) _w.push(_tag + ": no such axis on this font");
            }
            var _ps = null;
            try { _ps = _fo.postScriptNameForDesignVector(_vec); } catch (ePs) { return { ok: false, error: "postScriptNameForDesignVector failed: " + AE.errText(ePs) }; }
            _doc.font = _ps;
            _src.setValue(_doc);
            return { ok: true, postScriptName: _ps, vector: AE.valueToJson(_vec), warnings: _w };
        `;
  },
});

registerOp({
  name: "text.add_font_axis",
  category: "text",
  description:
    "Add a variable-font axis property to a text animator (PropertyGroup.addVariableFontAxis, AE 26.0+) so the axis can be animated/keyframed. Targets an existing animator by 1-based index or name, or creates a new one.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    {
      name: "axisTag",
      type: "string",
      description: "Four-character axis tag, e.g. 'wght'",
      required: true,
    },
    {
      name: "animator",
      type: "any",
      description: "Existing animator (1-based index or name). Omit to create a new animator.",
      required: false,
    },
    { name: "value", type: "number", description: "Initial axis value", required: false },
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            if (!(_layer instanceof TextLayer)) return { ok: false, error: "not a TextLayer" };
            var _animators = _layer.property("ADBE Text Properties").property("ADBE Text Animators");
            if (!_animators) return { ok: false, error: "no Animators group on layer" };
            var _animArg = ${jsxVal(args.animator ?? null)};
            var _anim = null;
            if (_animArg === null) {
                _anim = _animators.addProperty("ADBE Text Animator");
            } else {
                try { _anim = _animators.property(_animArg); } catch (eA) {}
                if (!_anim) return { ok: false, error: "no animator matching " + _animArg };
            }
            var _animProps = _anim.property("ADBE Text Animator Properties");
            if (typeof _animProps.addVariableFontAxis !== "function") return { ok: false, error: "addVariableFontAxis needs AE 26.0+" };
            var _axis = null;
            try { _axis = _animProps.addVariableFontAxis(${jsxVal(args.axisTag)}); } catch (eAx) { return { ok: false, error: "addVariableFontAxis failed: " + AE.errText(eAx) }; }
            var _w = [];
            ${
              args.value !== undefined
                ? `try { _axis.setValue(${jsxVal(args.value)}); } catch (eV) { _w.push("value: " + AE.errText(eV)); }`
                : ""
            }
            return { ok: true, animator: _anim.name, axis: AE.safeGet(function () { return _axis.name; }, ${jsxVal(args.axisTag)}), warnings: _w };
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
        `try { _sel.property("ADBE Text Percent Start").setValue(${jsxVal(args.rangeStart)}); } catch (eRs) { _w.push("rangeStart: " + AE.errText(eRs)); }`,
      );
    if (args.rangeEnd !== undefined)
      rangeSets.push(
        `try { _sel.property("ADBE Text Percent End").setValue(${jsxVal(args.rangeEnd)}); } catch (eRe) { _w.push("rangeEnd: " + AE.errText(eRe)); }`,
      );
    if (args.rangeOffset !== undefined)
      rangeSets.push(
        `try { _sel.property("ADBE Text Percent Offset").setValue(${jsxVal(args.rangeOffset)}); } catch (eRo) { _w.push("rangeOffset: " + AE.errText(eRo)); }`,
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
                } catch (eAp) { _w.push(_k + ": " + AE.errText(eAp)); }
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
                } catch (eSel) { _w.push("selector: " + AE.errText(eSel)); }
            }
            return { ok: true, animator: _anim.name, animatorIndex: _anim.propertyIndex, addedProperties: _added, selector: _selName, warnings: _w };
        `;
  },
});
