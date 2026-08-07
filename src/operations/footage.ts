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
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.guessAlpha)
      sets.push(`try { _src.guessAlphaMode(); } catch (e) { _w.push("guessAlpha: " + e); }`);
    if (args.alphaMode !== undefined)
      sets.push(`
        try {
            var _amMap = { "ignore": AlphaMode.IGNORE, "straight": AlphaMode.STRAIGHT, "premultiplied": AlphaMode.PREMULTIPLIED };
            if (_amMap[${jsxVal(args.alphaMode)}] === undefined) { _w.push("alphaMode: unknown value"); }
            else { _src.alphaMode = _amMap[${jsxVal(args.alphaMode)}]; }
        } catch (e) { _w.push("alphaMode: " + e); }`);
    if (args.premulColor !== undefined)
      sets.push(
        `try { _src.premulColor = ${jsxVal(args.premulColor)}; } catch (e) { _w.push("premulColor: " + e); }`,
      );
    if (args.invertAlpha !== undefined)
      sets.push(
        `try { _src.invertAlpha = ${jsxVal(args.invertAlpha)}; } catch (e) { _w.push("invertAlpha: " + e); }`,
      );
    if (args.conformFrameRate !== undefined)
      sets.push(
        `try { _src.conformFrameRate = ${jsxVal(args.conformFrameRate)}; } catch (e) { _w.push("conformFrameRate: " + e); }`,
      );
    if (args.loop !== undefined)
      sets.push(`try { _src.loop = ${jsxVal(args.loop)}; } catch (e) { _w.push("loop: " + e); }`);
    if (args.fieldSeparation !== undefined)
      sets.push(`
        try {
            var _fsMap = { "off": FieldSeparationType.OFF, "upper": FieldSeparationType.UPPER_FIELD_FIRST, "lower": FieldSeparationType.LOWER_FIELD_FIRST };
            if (_fsMap[${jsxVal(args.fieldSeparation)}] === undefined) { _w.push("fieldSeparation: unknown value"); }
            else { _src.fieldSeparationType = _fsMap[${jsxVal(args.fieldSeparation)}]; }
        } catch (e) { _w.push("fieldSeparation: " + e); }`);
    if (args.highQualityFields !== undefined)
      sets.push(
        `try { _src.highQualityFieldSeparation = ${jsxVal(args.highQualityFields)}; } catch (e) { _w.push("highQualityFields: " + e); }`,
      );
    if (args.pixelAspect !== undefined)
      sets.push(
        `try { _item.pixelAspect = ${jsxVal(args.pixelAspect)}; } catch (e) { _w.push("pixelAspect: " + e); }`,
      );
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
  name: "footage.set_proxy",
  category: "footage",
  description:
    "Set or clear a proxy on any project item (comp or footage). Pass path=null (or omit) to remove the proxy.",
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
  ],
  toJsx(args) {
    return `
            var _item = AE.findItem(${jsxVal(args.item)});
            if (!_item) return { ok: false, error: "no project item matching " + ${jsxVal(String(args.item))} };
            if (_item instanceof FolderItem) return { ok: false, error: "folders cannot have proxies" };
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
