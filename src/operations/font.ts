// Font operations — enumerate installed fonts via app.fonts (AE 24.0+).

import { registerOp, jsxVal } from "../registry.js";

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
