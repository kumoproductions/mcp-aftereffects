// Preferences / Settings operations — app.preferences (AE's own prefs file)
// and app.settings (script-scoped settings storage).
//
// CAUTION surface: writing a wrong pref value can degrade the user's AE
// install until they reset preferences. Every write goes through the typed
// savePrefAs* API and reports AE's own error rather than guessing.

import { registerOp, jsxVal } from "../registry.js";

/**
 * Resolve the optional prefType arg into `_pt` (a PREFType member or null for
 * the API default, MACHINE_SPECIFIC). Unknown names fail fast — silently
 * writing into the wrong prefs file would be worse than an error.
 */
function jsxPrefTypePreamble(args: Record<string, unknown>): string {
  return `
        var _ptArg = ${jsxVal(args.prefType ?? null)};
        var _pt = null;
        if (_ptArg !== null) {
            var _ptMap = {};
            try {
                _ptMap.machineSpecific = PREFType.PREF_Type_MACHINE_SPECIFIC;
                _ptMap.machineIndependent = PREFType.PREF_Type_MACHINE_INDEPENDENT;
                _ptMap.machineIndependentRender = PREFType.PREF_Type_MACHINE_INDEPENDENT_RENDER;
                _ptMap.machineIndependentOutput = PREFType.PREF_Type_MACHINE_INDEPENDENT_OUTPUT;
                _ptMap.machineIndependentComposition = PREFType.PREF_Type_MACHINE_INDEPENDENT_COMPOSITION;
                _ptMap.machineSpecificText = PREFType.PREF_Type_MACHINE_SPECIFIC_TEXT;
                _ptMap.machineSpecificPaint = PREFType.PREF_Type_MACHINE_SPECIFIC_PAINT;
            } catch (ePt) {}
            if (!_ptMap.hasOwnProperty(_ptArg)) return { ok: false, error: "unknown prefType '" + _ptArg + "'" };
            _pt = _ptMap[_ptArg];
        }
    `;
}

const PREF_TYPE_PARAM = {
  name: "prefType",
  type: "string",
  description:
    "Preferences file: machineSpecific (default) | machineIndependent | machineIndependentRender | machineIndependentOutput | machineIndependentComposition | machineSpecificText | machineSpecificPaint",
  required: false,
} as const;

registerOp({
  name: "pref.get",
  category: "pref",
  readOnly: true,
  description:
    'Read one After Effects preference (app.preferences.getPrefAs*). Section/key names match the prefs file, e.g. section "Main Pref Section v2", key "Pref_SCOPES_ENABLE_DYNAMIC_PEAK". Returns exists=false instead of failing when the pref is absent.',
  params: [
    { name: "section", type: "string", description: "Preference section name", required: true },
    { name: "key", type: "string", description: "Preference key name", required: true },
    {
      name: "type",
      type: "string",
      description: "string|bool|float|long (default string)",
      required: false,
      default: "string",
    },
    PREF_TYPE_PARAM,
  ],
  toJsx(args) {
    return `
            ${jsxPrefTypePreamble(args)}
            var _sec = ${jsxVal(args.section)};
            var _key = ${jsxVal(args.key)};
            var _has = false;
            try { _has = _pt === null ? app.preferences.havePref(_sec, _key) : app.preferences.havePref(_sec, _key, _pt); } catch (eH) { return { ok: false, error: "havePref failed: " + AE.errText(eH) }; }
            if (!_has) return { ok: true, exists: false, value: null };
            var _type = ${jsxVal(args.type ?? "string")};
            var _val = null;
            try {
                if (_type === "bool") _val = _pt === null ? app.preferences.getPrefAsBool(_sec, _key) : app.preferences.getPrefAsBool(_sec, _key, _pt);
                else if (_type === "float") _val = _pt === null ? app.preferences.getPrefAsFloat(_sec, _key) : app.preferences.getPrefAsFloat(_sec, _key, _pt);
                else if (_type === "long") _val = _pt === null ? app.preferences.getPrefAsLong(_sec, _key) : app.preferences.getPrefAsLong(_sec, _key, _pt);
                else if (_type === "string") _val = _pt === null ? app.preferences.getPrefAsString(_sec, _key) : app.preferences.getPrefAsString(_sec, _key, _pt);
                else return { ok: false, error: "type must be string|bool|float|long" };
            } catch (eG) { return { ok: false, error: "getPrefAs failed: " + AE.errText(eG) }; }
            return { ok: true, exists: true, value: _val };
        `;
  },
});

registerOp({
  name: "pref.set",
  category: "pref",
  appConfig: true,
  description:
    "Write one After Effects preference (app.preferences.savePrefAs*) and flush to disk. A wrong value can misconfigure AE until preferences are reset — read the current value with pref.get first.",
  params: [
    { name: "section", type: "string", description: "Preference section name", required: true },
    { name: "key", type: "string", description: "Preference key name", required: true },
    { name: "value", type: "any", description: "Value to write (matching `type`)", required: true },
    {
      name: "type",
      type: "string",
      description: "string|bool|float|long (default: inferred from the value)",
      required: false,
    },
    PREF_TYPE_PARAM,
    {
      name: "persist",
      type: "boolean",
      description: "Flush prefs to disk immediately (default true)",
      required: false,
      default: true,
    },
  ],
  toJsx(args) {
    // Hoisted: the codegen lint's template scanner cannot see through raw
    // braces inside a `${…}` interpolation.
    const persistJsx =
      args.persist === false ? "" : `try { app.preferences.saveToDisk(); } catch (eD) {}`;
    return `
            ${jsxPrefTypePreamble(args)}
            var _sec = ${jsxVal(args.section)};
            var _key = ${jsxVal(args.key)};
            var _val = ${jsxVal(args.value)};
            var _type = ${jsxVal(args.type ?? null)};
            if (_type === null) {
                if (typeof _val === "boolean") _type = "bool";
                else if (typeof _val === "number") _type = (_val === Math.floor(_val)) ? "long" : "float";
                else _type = "string";
            }
            try {
                if (_type === "bool") { if (_pt === null) app.preferences.savePrefAsBool(_sec, _key, _val); else app.preferences.savePrefAsBool(_sec, _key, _val, _pt); }
                else if (_type === "float") { if (_pt === null) app.preferences.savePrefAsFloat(_sec, _key, _val); else app.preferences.savePrefAsFloat(_sec, _key, _val, _pt); }
                else if (_type === "long") { if (_pt === null) app.preferences.savePrefAsLong(_sec, _key, _val); else app.preferences.savePrefAsLong(_sec, _key, _val, _pt); }
                else if (_type === "string") { if (_pt === null) app.preferences.savePrefAsString(_sec, _key, String(_val)); else app.preferences.savePrefAsString(_sec, _key, String(_val), _pt); }
                else return { ok: false, error: "type must be string|bool|float|long" };
            } catch (eS) { return { ok: false, error: "savePrefAs failed: " + AE.errText(eS) }; }
            ${persistJsx}
            return { ok: true, section: _sec, key: _key, type: _type };
        `;
  },
});

registerOp({
  name: "pref.delete",
  category: "pref",
  appConfig: true,
  description: "Delete one After Effects preference (app.preferences.deletePref).",
  params: [
    { name: "section", type: "string", description: "Preference section name", required: true },
    { name: "key", type: "string", description: "Preference key name", required: true },
    PREF_TYPE_PARAM,
  ],
  toJsx(args) {
    return `
            ${jsxPrefTypePreamble(args)}
            var _sec = ${jsxVal(args.section)};
            var _key = ${jsxVal(args.key)};
            var _has = false;
            try { _has = _pt === null ? app.preferences.havePref(_sec, _key) : app.preferences.havePref(_sec, _key, _pt); } catch (eH) { return { ok: false, error: "havePref failed: " + AE.errText(eH) }; }
            if (!_has) return { ok: true, deleted: false, existed: false };
            try { if (_pt === null) app.preferences.deletePref(_sec, _key); else app.preferences.deletePref(_sec, _key, _pt); } catch (eDel) { return { ok: false, error: "deletePref failed: " + AE.errText(eDel) }; }
            try { app.preferences.saveToDisk(); } catch (eD) {}
            return { ok: true, deleted: true, existed: true };
        `;
  },
});

registerOp({
  name: "pref.get_setting",
  category: "pref",
  readOnly: true,
  description:
    "Read a script-scoped setting (app.settings.getSetting) — the persistent key/value store AE offers to scripts, separate from application preferences.",
  params: [
    { name: "section", type: "string", description: "Settings section name", required: true },
    { name: "key", type: "string", description: "Settings key name", required: true },
  ],
  toJsx(args) {
    return `
            var _sec = ${jsxVal(args.section)};
            var _key = ${jsxVal(args.key)};
            var _has = false;
            try { _has = app.settings.haveSetting(_sec, _key); } catch (eH) { return { ok: false, error: "haveSetting failed: " + AE.errText(eH) }; }
            if (!_has) return { ok: true, exists: false, value: null };
            var _val = null;
            try { _val = app.settings.getSetting(_sec, _key); } catch (eG) { return { ok: false, error: "getSetting failed: " + AE.errText(eG) }; }
            return { ok: true, exists: true, value: _val };
        `;
  },
});

registerOp({
  name: "pref.set_setting",
  category: "pref",
  appConfig: true,
  description:
    "Write a script-scoped setting (app.settings.saveSetting). Values are stored as strings.",
  params: [
    { name: "section", type: "string", description: "Settings section name", required: true },
    { name: "key", type: "string", description: "Settings key name", required: true },
    { name: "value", type: "string", description: "Value to store", required: true },
  ],
  toJsx(args) {
    return `
            try { app.settings.saveSetting(${jsxVal(args.section)}, ${jsxVal(args.key)}, ${jsxVal(args.value)}); } catch (eS) { return { ok: false, error: "saveSetting failed: " + AE.errText(eS) }; }
            return { ok: true };
        `;
  },
});
