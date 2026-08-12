// Font operations — enumerate and inspect fonts via app.fonts (AE 24.0+),
// including variable-font design axes and glyph coverage.

import { registerOp, jsxVal } from "../registry.js";

/**
 * Serialize one FontObject into a JSON-safe summary. Enum-valued members go
 * through getEnumAsString when the host has it (AE 24.0+), raw otherwise.
 * Expects the font in `_font`; emits into `_info`.
 */
const FONT_INFO_JSX = `
    function _fontInfo(_font) {
        function _enumStr(v) {
            try { if (typeof getEnumAsString === "function") return getEnumAsString(v); } catch (eEs) {}
            try { return String(v); } catch (eS) { return null; }
        }
        var _info = {
            postScriptName: AE.safeGet(function () { return _font.postScriptName; }, null),
            fullName: AE.safeGet(function () { return _font.fullName; }, null),
            familyName: AE.safeGet(function () { return _font.familyName; }, null),
            styleName: AE.safeGet(function () { return _font.styleName; }, null),
            nativeFamilyName: AE.safeGet(function () { return _font.nativeFamilyName; }, null),
            nativeFullName: AE.safeGet(function () { return _font.nativeFullName; }, null),
            nativeStyleName: AE.safeGet(function () { return _font.nativeStyleName; }, null),
            familyPrefix: AE.safeGet(function () { return _font.familyPrefix; }, null),
            isFromAdobeFonts: AE.safeGet(function () { return _font.isFromAdobeFonts; }, null),
            isSubstitute: AE.safeGet(function () { return _font.isSubstitute; }, null),
            location: AE.safeGet(function () { return _font.location; }, null),
            version: AE.safeGet(function () { return _font.version; }, null),
            technology: AE.safeGet(function () { return _enumStr(_font.technology); }, null),
            fontType: AE.safeGet(function () { return _enumStr(_font.type); }, null),
            hasDesignAxes: AE.safeGet(function () { return _font.hasDesignAxes; }, false),
            designAxesData: null,
            designVector: null
        };
        try {
            if (_info.hasDesignAxes) {
                _info.designAxesData = AE.valueToJson(_font.designAxesData);
                _info.designVector = AE.valueToJson(_font.designVector);
            }
        } catch (eAx) {}
        return _info;
    }
`;

registerOp({
  name: "font.list",
  category: "font",
  readOnly: true,
  description:
    "List installed fonts with postScriptName/family/style (app.fonts, AE 24.0+). Use postScriptName with text.set_style. Filter with familyContains.",
  params: [
    {
      name: "familyContains",
      type: "string",
      description: "Case-insensitive substring match on family name",
      required: false,
    },
    { name: "limit", type: "number", description: "Max results (default 200)", required: false },
  ],
  toJsx(args) {
    return `
            if (!app.fonts || !app.fonts.allFonts) return { ok: false, error: "app.fonts needs AE 24.0+" };
            var _needle = ${jsxVal(args.familyContains ?? null)};
            if (_needle !== null) _needle = _needle.toLowerCase();
            var _limit = ${jsxVal(args.limit ?? 200)};
            var _families = app.fonts.allFonts;
            var _out = [];
            var _total = 0;
            for (var _i = 0; _i < _families.length; _i++) {
                var _entry = _families[_i];
                // Documented as grouped (one array per family), but tolerate a
                // flat list of font objects too: guessing wrong would return
                // "ok, zero fonts installed" rather than an error, and
                // project.replace_font already treats a sibling API as flat.
                var _group = (_entry && typeof _entry.length === "number" && typeof _entry.postScriptName === "undefined") ? _entry : [_entry];
                for (var _j = 0; _j < _group.length; _j++) {
                    var _font = _group[_j];
                    var _fam = AE.safeGet(function () { return _font.familyName; }, "");
                    if (_needle !== null && _fam.toLowerCase().indexOf(_needle) === -1) continue;
                    _total++;
                    if (_out.length < _limit) {
                        _out.push({
                            postScriptName: AE.safeGet(function () { return _font.postScriptName; }, null),
                            familyName: _fam,
                            styleName: AE.safeGet(function () { return _font.styleName; }, null)
                        });
                    }
                }
            }
            return { ok: true, total: _total, returned: _out.length, fonts: _out };
        `;
  },
});

registerOp({
  name: "font.list_missing",
  category: "font",
  readOnly: true,
  description:
    "List fonts that are missing or substituted in the current project (app.fonts, AE 24.0+). Pair with project.replace_font to fix.",
  params: [],
  toJsx() {
    return `
            if (!app.fonts) return { ok: false, error: "app.fonts needs AE 24.0+" };
            var _missing = [];
            try {
                var _list = app.fonts.missingOrSubstitutedFonts;
                for (var _i = 0; _i < _list.length; _i++) {
                    var _font = _list[_i];
                    _missing.push({
                        postScriptName: AE.safeGet(function () { return _font.postScriptName; }, null),
                        familyName: AE.safeGet(function () { return _font.familyName; }, null),
                        styleName: AE.safeGet(function () { return _font.styleName; }, null)
                    });
                }
            } catch (eM) { return { ok: false, error: "missingOrSubstitutedFonts failed: " + AE.errText(eM) }; }
            return { ok: true, count: _missing.length, fonts: _missing };
        `;
  },
});

registerOp({
  name: "font.info",
  category: "font",
  readOnly: true,
  description:
    "Full FontObject details for a font (AE 24.0+): names, location, Adobe Fonts / substitute flags, and variable-font design axes (designAxesData/designVector). Look up by postScriptName, or by family (+ optional style).",
  params: [
    {
      name: "postScriptName",
      type: "string",
      description: "PostScript name (preferred lookup)",
      required: false,
    },
    {
      name: "family",
      type: "string",
      description: "Family name (used when postScriptName omitted)",
      required: false,
    },
    {
      name: "style",
      type: "string",
      description: "Style name for family lookup (default 'Regular')",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            if (!app.fonts) return { ok: false, error: "app.fonts needs AE 24.0+" };
            ${FONT_INFO_JSX}
            var _ps = ${jsxVal(args.postScriptName ?? null)};
            var _family = ${jsxVal(args.family ?? null)};
            var _list = null;
            try {
                if (_ps !== null) _list = app.fonts.getFontsByPostScriptName(_ps);
                else if (_family !== null) _list = app.fonts.getFontsByFamilyNameAndStyleName(_family, ${jsxVal(args.style ?? "Regular")});
                else return { ok: false, error: "pass postScriptName or family" };
            } catch (eLk) { return { ok: false, error: "font lookup failed: " + AE.errText(eLk) }; }
            if (!_list || _list.length === 0) return { ok: false, error: "no font matching " + (_ps !== null ? _ps : _family) };
            var _out = [];
            for (var _i = 0; _i < _list.length; _i++) _out.push(_fontInfo(_list[_i]));
            return { ok: true, count: _out.length, fonts: _out };
        `;
  },
});

registerOp({
  name: "font.check_glyphs",
  category: "font",
  readOnly: true,
  description:
    "Check whether a font has glyphs for every character of a string (FontObject.hasGlyphsFor, AE 25.1+). Essential before setting CJK or symbol text on a Latin-only font.",
  params: [
    { name: "postScriptName", type: "string", description: "Font PostScript name", required: true },
    { name: "text", type: "string", description: "Characters to check", required: true },
  ],
  toJsx(args) {
    return `
            if (!app.fonts) return { ok: false, error: "app.fonts needs AE 24.0+" };
            var _list = null;
            try { _list = app.fonts.getFontsByPostScriptName(${jsxVal(args.postScriptName)}); } catch (eLk) { return { ok: false, error: "font lookup failed: " + AE.errText(eLk) }; }
            if (!_list || _list.length === 0) return { ok: false, error: "no font matching " + ${jsxVal(args.postScriptName)} };
            var _font = _list[0];
            if (typeof _font.hasGlyphsFor !== "function") return { ok: false, error: "hasGlyphsFor needs AE 25.1+" };
            var _has = _font.hasGlyphsFor(${jsxVal(args.text)});
            return { ok: true, font: ${jsxVal(args.postScriptName)}, hasGlyphs: _has };
        `;
  },
});

registerOp({
  name: "font.list_used",
  category: "font",
  readOnly: true,
  description:
    "List every font used in the project with its usage references (Project.usedFonts, AE 24.5+). The reverse of font.list_missing: answers 'which fonts does this project depend on'.",
  params: [],
  toJsx() {
    return `
            var _used = null;
            try { _used = app.project.usedFonts; } catch (eU) { return { ok: false, error: "Project.usedFonts needs AE 24.5+: " + AE.errText(eU) }; }
            if (_used === undefined || _used === null) return { ok: false, error: "Project.usedFonts needs AE 24.5+" };
            var _out = [];
            for (var _i = 0; _i < _used.length; _i++) {
                var _entry = _used[_i];
                var _font = _entry.font;
                _out.push({
                    postScriptName: AE.safeGet(function () { return _font.postScriptName; }, null),
                    familyName: AE.safeGet(function () { return _font.familyName; }, null),
                    styleName: AE.safeGet(function () { return _font.styleName; }, null),
                    isSubstitute: AE.safeGet(function () { return _font.isSubstitute; }, null),
                    usedAt: AE.safeGet(function () { return AE.valueToJson(_entry.usedAt); }, null)
                });
            }
            return { ok: true, count: _out.length, fonts: _out };
        `;
  },
});

registerOp({
  name: "font.list_duplicates",
  category: "font",
  readOnly: true,
  description:
    "List groups of installed fonts that share a PostScript name (FontsObject.fontsDuplicateByPostScriptName, AE 24.6+) — the usual cause of 'wrong font picked' surprises.",
  params: [],
  toJsx() {
    return `
            if (!app.fonts) return { ok: false, error: "app.fonts needs AE 24.0+" };
            var _groups = null;
            try { _groups = app.fonts.fontsDuplicateByPostScriptName; } catch (eDp) { return { ok: false, error: "fontsDuplicateByPostScriptName needs AE 24.6+: " + AE.errText(eDp) }; }
            if (!_groups) return { ok: false, error: "fontsDuplicateByPostScriptName needs AE 24.6+" };
            var _out = [];
            for (var _i = 0; _i < _groups.length; _i++) {
                var _grp = _groups[_i];
                var _fonts = [];
                var _list = (_grp && typeof _grp.length === "number") ? _grp : [_grp];
                for (var _j = 0; _j < _list.length; _j++) {
                    var _font = _list[_j];
                    _fonts.push({
                        postScriptName: AE.safeGet(function () { return _font.postScriptName; }, null),
                        familyName: AE.safeGet(function () { return _font.familyName; }, null),
                        styleName: AE.safeGet(function () { return _font.styleName; }, null),
                        location: AE.safeGet(function () { return _font.location; }, null)
                    });
                }
                _out.push(_fonts);
            }
            return { ok: true, count: _out.length, groups: _out };
        `;
  },
});

registerOp({
  name: "font.get_lists",
  category: "font",
  readOnly: true,
  description:
    "Read the Character panel's Favorites and most-recently-used font family lists (AE 24.6+).",
  params: [],
  toJsx() {
    return `
            if (!app.fonts) return { ok: false, error: "app.fonts needs AE 24.0+" };
            var _fav = null;
            var _mru = null;
            try { _fav = AE.valueToJson(app.fonts.favoriteFontFamilyList); } catch (eF) {}
            try { _mru = AE.valueToJson(app.fonts.mruFontFamilyList); } catch (eM) {}
            if (_fav === null && _mru === null) return { ok: false, error: "font lists need AE 24.6+" };
            return { ok: true, favorites: _fav, recent: _mru };
        `;
  },
});

registerOp({
  name: "font.set_favorites",
  category: "font",
  description:
    "Replace the Character panel's Favorites font family list (FontsObject.favoriteFontFamilyList, AE 24.6+).",
  params: [
    {
      name: "families",
      type: "array",
      description: "Font family names, in display order",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            if (!app.fonts) return { ok: false, error: "app.fonts needs AE 24.0+" };
            try { app.fonts.favoriteFontFamilyList = ${jsxVal(args.families)}; } catch (eF) { return { ok: false, error: "favoriteFontFamilyList write needs AE 24.6+: " + AE.errText(eF) }; }
            return { ok: true, favorites: AE.valueToJson(app.fonts.favoriteFontFamilyList) };
        `;
  },
});

registerOp({
  name: "font.set_substitution",
  category: "font",
  description:
    "Configure automatic replacement of substituted (missing) fonts (AE 24.6+): matchPolicy postScriptName|ctfiEqual|disabled, and freezeSync to stop Adobe Fonts auto-sync on project open.",
  params: [
    {
      name: "matchPolicy",
      type: "string",
      description: "postScriptName|ctfiEqual|disabled",
      required: false,
    },
    {
      name: "freezeSync",
      type: "boolean",
      description: "Suppress Adobe Fonts auto-sync of substituted fonts",
      required: false,
    },
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.matchPolicy !== undefined)
      sets.push(`
        try {
            var _mpMap = { "postScriptName": SubstitutedFontReplacementMatchPolicy.POSTSCRIPT_NAME, "ctfiEqual": SubstitutedFontReplacementMatchPolicy.CTFI_EQUAL, "disabled": SubstitutedFontReplacementMatchPolicy.DISABLED };
            if (_mpMap.hasOwnProperty(${jsxVal(args.matchPolicy)})) { app.fonts.substitutedFontReplacementMatchPolicy = _mpMap[${jsxVal(args.matchPolicy)}]; }
            else { _w.push("matchPolicy: pass postScriptName|ctfiEqual|disabled"); }
        } catch (e) { _w.push("matchPolicy (AE 24.6+): " + AE.errText(e)); }`);
    if (args.freezeSync !== undefined)
      sets.push(
        `try { app.fonts.freezeSyncSubstitutedFonts = ${jsxVal(args.freezeSync)}; } catch (e) { _w.push("freezeSync (AE 24.6+): " + AE.errText(e)); }`,
      );
    return `
            if (!app.fonts) return { ok: false, error: "app.fonts needs AE 24.0+" };
            var _w = [];
            ${sets.join("\n")}
            return { ok: true, warnings: _w };
        `;
  },
});

/** Friendly script name -> CTScript member, probe-built. Defines _scripts. */
const CT_SCRIPT_MAP_JSX = `
    var _scripts = {};
    function _addScript(name, member) {
        try { if (CTScript[member] !== undefined) _scripts[name] = CTScript[member]; } catch (eCs) {}
    }
    _addScript("roman", "CT_ROMAN_SCRIPT"); _addScript("japanese", "CT_JAPANESE_SCRIPT");
    _addScript("arabic", "CT_ARABIC_SCRIPT"); _addScript("cyrillic", "CT_CYRILLIC_SCRIPT");
    _addScript("greek", "CT_GREEK_SCRIPT"); _addScript("hebrew", "CT_HEBREW_SCRIPT");
    _addScript("thai", "CT_THAI_SCRIPT"); _addScript("devanagari", "CT_DEVANAGARI_SCRIPT");
`;

registerOp({
  name: "font.get_default_for_script",
  category: "font",
  readOnly: true,
  description:
    "Read the default font for a writing script (FontsObject.getDefaultFontForCTScript, AE 25.1+): roman|japanese|arabic|cyrillic|greek|hebrew|thai|devanagari, or a raw CTScript member name like CT_HANGUL_SCRIPT.",
  params: [
    {
      name: "script",
      type: "string",
      description: "Writing script (see description)",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            if (!app.fonts || typeof app.fonts.getDefaultFontForCTScript !== "function") return { ok: false, error: "getDefaultFontForCTScript needs AE 25.1+" };
            ${CT_SCRIPT_MAP_JSX}
            var _arg = ${jsxVal(args.script)};
            var _script = _scripts.hasOwnProperty(_arg) ? _scripts[_arg] : null;
            if (_script === null) { try { if (CTScript[_arg] !== undefined) _script = CTScript[_arg]; } catch (eRw) {} }
            if (_script === null) return { ok: false, error: "unknown script '" + _arg + "'" };
            var _font = null;
            try { _font = app.fonts.getDefaultFontForCTScript(_script); } catch (eG) { return { ok: false, error: "getDefaultFontForCTScript failed: " + AE.errText(eG) }; }
            if (!_font) return { ok: true, script: _arg, font: null };
            return { ok: true, script: _arg, font: { postScriptName: AE.safeGet(function () { return _font.postScriptName; }, null), familyName: AE.safeGet(function () { return _font.familyName; }, null), styleName: AE.safeGet(function () { return _font.styleName; }, null) } };
        `;
  },
});

registerOp({
  name: "font.set_default_for_script",
  category: "font",
  description:
    "Set the default font AE uses for a writing script (FontsObject.setDefaultFontForCTScript, AE 25.1+). Script names as in font.get_default_for_script; font by PostScript name.",
  params: [
    { name: "script", type: "string", description: "Writing script", required: true },
    { name: "postScriptName", type: "string", description: "Font PostScript name", required: true },
  ],
  toJsx(args) {
    return `
            if (!app.fonts || typeof app.fonts.setDefaultFontForCTScript !== "function") return { ok: false, error: "setDefaultFontForCTScript needs AE 25.1+" };
            ${CT_SCRIPT_MAP_JSX}
            var _arg = ${jsxVal(args.script)};
            var _script = _scripts.hasOwnProperty(_arg) ? _scripts[_arg] : null;
            if (_script === null) { try { if (CTScript[_arg] !== undefined) _script = CTScript[_arg]; } catch (eRw) {} }
            if (_script === null) return { ok: false, error: "unknown script '" + _arg + "'" };
            var _list = null;
            try { _list = app.fonts.getFontsByPostScriptName(${jsxVal(args.postScriptName)}); } catch (eLk) {}
            if (!_list || _list.length === 0) return { ok: false, error: "no font matching " + ${jsxVal(args.postScriptName)} };
            try { app.fonts.setDefaultFontForCTScript(_script, _list[0]); } catch (eS) { return { ok: false, error: "setDefaultFontForCTScript failed: " + AE.errText(eS) }; }
            return { ok: true, script: _arg, font: ${jsxVal(args.postScriptName)} };
        `;
  },
});
