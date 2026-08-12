// Footage operations — replace source files, interpret footage, proxies.

import { registerOp, jsxVal } from "../registry.js";

/** Footage-item lookup preamble (defines `_item`, validated as FootageItem). */
function jsxFootagePreamble(args: Record<string, unknown>): string {
  return `
        var _item = AE.findItem(${jsxVal(args.item)});
        if (!_item) return { ok: false, error: "no project item matching " + ${jsxVal(String(args.item))} };
        if (!(_item instanceof FootageItem)) return { ok: false, error: "item '" + _item.name + "' is not a FootageItem" };
    `;
}

registerOp({
  name: "footage.replace",
  category: "footage",
  description:
    "Relink a footage item to a different file (FootageItem.replace). Layers using the item keep keyframes/effects. Pass sequence=true to relink to an image sequence.",
  params: [
    {
      name: "item",
      type: "any",
      description: "Footage item id (number) or name (string)",
      required: true,
    },
    { name: "path", type: "string", description: "Absolute path to the new file", required: true },
    {
      name: "sequence",
      type: "boolean",
      description: "Treat path as the first file of an image sequence (default false)",
      required: false,
      default: false,
    },
    {
      name: "forceAlphabetical",
      type: "boolean",
      description: "Sequence only: force alphabetical order (default false)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxFootagePreamble(args)}
            var _f = new File(${jsxVal(args.path)});
            if (!_f.exists) return { ok: false, error: "file not found: " + ${jsxVal(args.path)} };
            if (${jsxVal(!!args.sequence)}) {
                _item.replaceWithSequence(_f, ${jsxVal(!!args.forceAlphabetical)});
            } else {
                _item.replace(_f);
            }
            return { ok: true, id: _item.id, name: _item.name, file: _item.file ? _item.file.fsName.replace(/\\\\/g, "/") : null };
        `;
  },
});

registerOp({
  name: "footage.interpret",
  category: "footage",
  description:
    "Set footage interpretation: alpha mode, frame rate conform, looping, fields, pixel aspect (FootageItem.mainSource).",
  params: [
    {
      name: "item",
      type: "any",
      description: "Footage item id (number) or name (string)",
      required: true,
    },
    {
      name: "alphaMode",
      type: "string",
      description: "ignore|straight|premultiplied",
      required: false,
    },
    {
      name: "premulColor",
      type: "array",
      description: "[r,g,b] 0-1 matte color for premultiplied alpha",
      required: false,
    },
    {
      name: "invertAlpha",
      type: "boolean",
      description: "Invert the alpha channel",
      required: false,
    },
    {
      name: "guessAlpha",
      type: "boolean",
      description: "Auto-detect the alpha interpretation first",
      required: false,
    },
    {
      name: "conformFrameRate",
      type: "number",
      description: "Conform to this frame rate (0 = native)",
      required: false,
    },
    {
      name: "loop",
      type: "number",
      description: "Number of times to loop the footage",
      required: false,
    },
    {
      name: "fieldSeparation",
      type: "string",
      description: "off|upper|lower",
      required: false,
    },
    {
      name: "highQualityFields",
      type: "boolean",
      description: "High-quality field separation",
      required: false,
    },
    {
      name: "pixelAspect",
      type: "number",
      description: "Pixel aspect ratio (e.g. 1, 0.9091, 1.4587)",
      required: false,
    },
    {
      name: "guessPulldown",
      type: "string",
      description: "Auto-detect pulldown first: '3:2' or '24Pa' (runs guessPulldown)",
      required: false,
    },
    {
      name: "removePulldown",
      type: "string",
      description: "off|WSSWW|SSWWW|SWWWS|WWWSS|WWSSW (needs field separation on)",
      required: false,
    },
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.guessPulldown !== undefined)
      sets.push(`
        try {
            var _gpMap = { "3:2": PulldownMethod.PULLDOWN_3_2, "24Pa": PulldownMethod.ADVANCE_24P };
            if (_gpMap.hasOwnProperty(${jsxVal(args.guessPulldown)})) { _src.guessPulldown(_gpMap[${jsxVal(args.guessPulldown)}]); }
            else { _w.push("guessPulldown: pass '3:2' or '24Pa'"); }
        } catch (e) { _w.push("guessPulldown: " + AE.errText(e)); }`);
    if (args.guessAlpha)
      sets.push(
        `try { _src.guessAlphaMode(); } catch (e) { _w.push("guessAlpha: " + AE.errText(e)); }`,
      );
    if (args.alphaMode !== undefined)
      sets.push(`
        try {
            var _amMap = { "ignore": AlphaMode.IGNORE, "straight": AlphaMode.STRAIGHT, "premultiplied": AlphaMode.PREMULTIPLIED };
            if (_amMap[${jsxVal(args.alphaMode)}] === undefined) { _w.push("alphaMode: unknown value"); }
            else { _src.alphaMode = _amMap[${jsxVal(args.alphaMode)}]; }
        } catch (e) { _w.push("alphaMode: " + AE.errText(e)); }`);
    if (args.premulColor !== undefined)
      sets.push(
        `try { _src.premulColor = ${jsxVal(args.premulColor)}; } catch (e) { _w.push("premulColor: " + AE.errText(e)); }`,
      );
    if (args.invertAlpha !== undefined)
      sets.push(
        `try { _src.invertAlpha = ${jsxVal(args.invertAlpha)}; } catch (e) { _w.push("invertAlpha: " + AE.errText(e)); }`,
      );
    if (args.conformFrameRate !== undefined)
      sets.push(
        `try { _src.conformFrameRate = ${jsxVal(args.conformFrameRate)}; } catch (e) { _w.push("conformFrameRate: " + AE.errText(e)); }`,
      );
    if (args.loop !== undefined)
      sets.push(
        `try { _src.loop = ${jsxVal(args.loop)}; } catch (e) { _w.push("loop: " + AE.errText(e)); }`,
      );
    if (args.fieldSeparation !== undefined)
      sets.push(`
        try {
            var _fsMap = { "off": FieldSeparationType.OFF, "upper": FieldSeparationType.UPPER_FIELD_FIRST, "lower": FieldSeparationType.LOWER_FIELD_FIRST };
            if (_fsMap[${jsxVal(args.fieldSeparation)}] === undefined) { _w.push("fieldSeparation: unknown value"); }
            else { _src.fieldSeparationType = _fsMap[${jsxVal(args.fieldSeparation)}]; }
        } catch (e) { _w.push("fieldSeparation: " + AE.errText(e)); }`);
    if (args.highQualityFields !== undefined)
      sets.push(
        `try { _src.highQualityFieldSeparation = ${jsxVal(args.highQualityFields)}; } catch (e) { _w.push("highQualityFields: " + AE.errText(e)); }`,
      );
    if (args.pixelAspect !== undefined)
      sets.push(
        `try { _item.pixelAspect = ${jsxVal(args.pixelAspect)}; } catch (e) { _w.push("pixelAspect: " + AE.errText(e)); }`,
      );
    if (args.removePulldown !== undefined)
      sets.push(`
        try {
            var _rpMap = { "off": PulldownPhase.OFF, "WSSWW": PulldownPhase.WSSWW, "SSWWW": PulldownPhase.SSWWW, "SWWWS": PulldownPhase.SWWWS, "WWWSS": PulldownPhase.WWWSS, "WWSSW": PulldownPhase.WWSSW };
            if (_rpMap.hasOwnProperty(${jsxVal(args.removePulldown)})) { _src.removePulldown = _rpMap[${jsxVal(args.removePulldown)}]; }
            else { _w.push("removePulldown: unknown phase"); }
        } catch (e) { _w.push("removePulldown (needs field separation on): " + AE.errText(e)); }`);
    return `
            ${jsxFootagePreamble(args)}
            var _src = _item.mainSource;
            var _w = [];
            ${sets.join("\n")}
            return { ok: true, name: _item.name, warnings: _w };
        `;
  },
});

registerOp({
  name: "footage.reload",
  category: "footage",
  description:
    "Reload a footage item from its source file (FileSource.reload) — picks up external edits to the file without relinking.",
  params: [
    {
      name: "item",
      type: "any",
      description: "Footage item id (number) or name (string)",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            ${jsxFootagePreamble(args)}
            var _src = _item.mainSource;
            if (!_src || typeof _src.reload !== "function") return { ok: false, error: "item '" + _item.name + "' is not file-backed footage (solids/placeholders cannot reload)" };
            try { _src.reload(); } catch (eRl) { return { ok: false, error: "reload failed: " + AE.errText(eRl) }; }
            return { ok: true, id: _item.id, name: _item.name, file: _item.file ? _item.file.fsName.replace(/\\\\/g, "/") : null };
        `;
  },
});

registerOp({
  name: "footage.list_missing",
  category: "footage",
  readOnly: true,
  description:
    "List footage items whose source file is missing (footageMissing), with the last-known path. The footage counterpart of font.list_missing.",
  params: [],
  toJsx() {
    return `
            var _missing = [];
            for (var _i = 1; _i <= app.project.numItems; _i++) {
                var _it = app.project.item(_i);
                if (!(_it instanceof FootageItem)) continue;
                var _isMissing = AE.safeGet(function () { return _it.footageMissing; }, false);
                if (!_isMissing) continue;
                _missing.push({
                    id: _it.id,
                    name: _it.name,
                    missingPath: AE.safeGet(function () { return _it.mainSource.missingFootagePath; }, null),
                    usedInComps: AE.safeGet(function () {
                        var _u = [];
                        var _comps = _it.usedIn;
                        for (var _ci = 0; _ci < _comps.length; _ci++) _u.push(_comps[_ci].name);
                        return _u;
                    }, [])
                });
            }
            return { ok: true, count: _missing.length, items: _missing };
        `;
  },
});

registerOp({
  name: "footage.replace_with_solid",
  category: "footage",
  description:
    "Replace a footage item's source with a solid color (FootageItem.replaceWithSolid). Layers using the item keep keyframes/effects.",
  params: [
    {
      name: "item",
      type: "any",
      description: "Footage item id (number) or name (string)",
      required: true,
    },
    { name: "color", type: "array", description: "[r,g,b] 0-1", required: true },
    { name: "name", type: "string", description: "New source name", required: false },
    { name: "width", type: "number", description: "Width in px (default: keep)", required: false },
    {
      name: "height",
      type: "number",
      description: "Height in px (default: keep)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxFootagePreamble(args)}
            var _wd = ${jsxVal(args.width ?? null)};
            var _ht = ${jsxVal(args.height ?? null)};
            if (_wd === null) _wd = _item.width || 1920;
            if (_ht === null) _ht = _item.height || 1080;
            var _nm = ${jsxVal(args.name ?? null)};
            if (_nm === null) _nm = _item.name;
            try { _item.replaceWithSolid(${jsxVal(args.color)}, _nm, _wd, _ht, _item.pixelAspect || 1); } catch (eRs) { return { ok: false, error: "replaceWithSolid failed: " + AE.errText(eRs) }; }
            return { ok: true, id: _item.id, name: _item.name, width: _item.width, height: _item.height };
        `;
  },
});

registerOp({
  name: "footage.replace_with_placeholder",
  category: "footage",
  description:
    "Replace a footage item's source with a placeholder (FootageItem.replaceWithPlaceholder) — e.g. to stand in for footage that will arrive later. Layers keep keyframes/effects.",
  params: [
    {
      name: "item",
      type: "any",
      description: "Footage item id (number) or name (string)",
      required: true,
    },
    { name: "name", type: "string", description: "Placeholder name", required: false },
    { name: "width", type: "number", description: "Width in px (default: keep)", required: false },
    {
      name: "height",
      type: "number",
      description: "Height in px (default: keep)",
      required: false,
    },
    {
      name: "frameRate",
      type: "number",
      description: "Frame rate (default 30)",
      required: false,
      default: 30,
    },
    {
      name: "duration",
      type: "number",
      description: "Duration in seconds (default: keep, or 1)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxFootagePreamble(args)}
            var _wd = ${jsxVal(args.width ?? null)};
            var _ht = ${jsxVal(args.height ?? null)};
            if (_wd === null) _wd = _item.width || 1920;
            if (_ht === null) _ht = _item.height || 1080;
            var _du = ${jsxVal(args.duration ?? null)};
            if (_du === null) _du = _item.duration || 1;
            var _nm = ${jsxVal(args.name ?? null)};
            if (_nm === null) _nm = _item.name;
            try { _item.replaceWithPlaceholder(_nm, _wd, _ht, ${jsxVal(args.frameRate ?? 30)}, _du); } catch (eRp) { return { ok: false, error: "replaceWithPlaceholder failed: " + AE.errText(eRp) }; }
            return { ok: true, id: _item.id, name: _item.name, footageMissing: AE.safeGet(function () { return _item.footageMissing; }, null) };
        `;
  },
});

registerOp({
  name: "footage.set_proxy",
  category: "footage",
  description:
    "Set or clear a proxy on any project item (comp or footage): a file, an image sequence, a solid color, or a placeholder. Omit path/solidColor/placeholder to remove the proxy.",
  params: [
    {
      name: "item",
      type: "any",
      description: "Project item id (number) or name (string)",
      required: true,
    },
    {
      name: "path",
      type: "string",
      description: "Absolute path to the proxy file — omit to remove the proxy",
      required: false,
      nullable: true,
    },
    {
      name: "sequence",
      type: "boolean",
      description: "Treat path as the first file of an image sequence (default false)",
      required: false,
    },
    {
      name: "solidColor",
      type: "array",
      description: "[r,g,b] 0-1 — set a solid proxy instead of a file (setProxyWithSolid)",
      required: false,
    },
    {
      name: "placeholder",
      type: "boolean",
      description: "Set a placeholder proxy sized like the item (setProxyWithPlaceholder)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            var _item = AE.findItem(${jsxVal(args.item)});
            if (!_item) return { ok: false, error: "no project item matching " + ${jsxVal(String(args.item))} };
            if (_item instanceof FolderItem) return { ok: false, error: "folders cannot have proxies" };
            var _solid = ${jsxVal(args.solidColor ?? null)};
            if (_solid !== null) {
                try { _item.setProxyWithSolid(_solid, _item.name + " proxy", _item.width || 1920, _item.height || 1080, _item.pixelAspect || 1); } catch (ePs) { return { ok: false, error: "setProxyWithSolid failed: " + AE.errText(ePs) }; }
                return { ok: true, name: _item.name, useProxy: _item.useProxy, proxy: "solid" };
            }
            if (${jsxVal(args.placeholder === true)}) {
                try { _item.setProxyWithPlaceholder(_item.name + " proxy", _item.width || 1920, _item.height || 1080, _item.frameRate || 30, _item.duration || 1); } catch (ePp) { return { ok: false, error: "setProxyWithPlaceholder failed: " + AE.errText(ePp) }; }
                return { ok: true, name: _item.name, useProxy: _item.useProxy, proxy: "placeholder" };
            }
            var _path = ${jsxVal(args.path ?? null)};
            if (_path === null) {
                _item.setProxyToNone();
                return { ok: true, name: _item.name, proxy: null };
            }
            var _f = new File(_path);
            if (!_f.exists) return { ok: false, error: "proxy file not found: " + _path };
            if (${jsxVal(!!args.sequence)}) {
                _item.setProxyWithSequence(_f, false);
            } else {
                _item.setProxy(_f);
            }
            return { ok: true, name: _item.name, useProxy: _item.useProxy, proxy: _path };
        `;
  },
});
