// Marker operations — add, update, remove, list comp/layer markers.

import { registerOp, jsxVal, jsxCompPreamble, jsxCompLayerPreamble } from "../registry.js";

/**
 * Resolve the marker property into `_mp`: layer markers when args.layer is
 * given, comp markers otherwise.
 */
function jsxMarkerPreamble(args: Record<string, unknown>): string {
  if (args.layer !== undefined && args.layer !== null) {
    return `
        ${jsxCompLayerPreamble(args)}
        var _mp = _layer.property("Marker");
        if (!_mp) return { ok: false, error: "layer has no Marker property" };
    `;
  }
  return `
        ${jsxCompPreamble(args)}
        var _mp = _comp.markerProperty;
        if (!_mp) return { ok: false, error: "comp has no marker property" };
    `;
}

/** Resolve `_ki` from keyIndex or nearest-to-time. Emits early returns on failure. */
function jsxMarkerKeyLookup(args: Record<string, unknown>): string {
  return `
        var _ki = ${jsxVal(args.keyIndex ?? null)};
        var _t = ${jsxVal(args.time ?? null)};
        if (_ki === null && _t === null) return { ok: false, error: "pass keyIndex or time" };
        if (_mp.numKeys === 0) return { ok: false, error: "no markers" };
        if (_ki === null) {
            _ki = _mp.nearestKeyIndex(_t);
            // nearestKeyIndex has no distance limit: with a single marker at 0s,
            // asking for t=10 returns that marker. These lookups feed destructive
            // ops, so require the hit to land on the requested time (within half
            // a frame) rather than silently retargeting the only marker there is.
            var _tol = 0.5 * (_comp.frameDuration || (1 / 30));
            if (Math.abs(_mp.keyTime(_ki) - _t) > _tol) {
                return { ok: false, error: "no marker at " + _t + "s (nearest is at " + _mp.keyTime(_ki) + "s) — pass keyIndex to target it explicitly" };
            }
        }
        if (_ki < 1 || _ki > _mp.numKeys) return { ok: false, error: "marker index out of range (1-" + _mp.numKeys + ")" };
    `;
}

/**
 * Optional MarkerValue field assignments shared by the add and update ops.
 * Generated code expects `_mv` (the MarkerValue) and `_w` (warnings array).
 */
function jsxMarkerFieldSets(args: Record<string, unknown>): string {
  const sets: string[] = [];
  if (args.label !== undefined) sets.push(`_mv.label = ${jsxVal(args.label)};`);
  if (args.duration !== undefined) sets.push(`_mv.duration = ${jsxVal(args.duration)};`);
  if (args.chapter !== undefined) sets.push(`_mv.chapter = ${jsxVal(args.chapter)};`);
  if (args.url !== undefined) sets.push(`_mv.url = ${jsxVal(args.url)};`);
  if (args.frameTarget !== undefined) sets.push(`_mv.frameTarget = ${jsxVal(args.frameTarget)};`);
  if (args.cuePointName !== undefined)
    sets.push(`_mv.cuePointName = ${jsxVal(args.cuePointName)};`);
  if (args.eventCuePoint !== undefined)
    sets.push(`_mv.eventCuePoint = ${jsxVal(args.eventCuePoint)};`);
  if (args.params !== undefined) {
    sets.push(`
            try {
                var _prm = ${jsxVal(args.params)};
                var _prmStr = {};
                for (var _pk in _prm) { if (_prm.hasOwnProperty(_pk)) _prmStr[_pk] = String(_prm[_pk]); }
                _mv.setParameters(_prmStr);
            } catch (ePrm) { _w.push("params: " + AE.errText(ePrm)); }
        `);
  }
  if (args.protectedRegion !== undefined)
    sets.push(
      `try { _mv.protectedRegion = ${jsxVal(args.protectedRegion)}; } catch (ePr) { _w.push("protectedRegion: " + AE.errText(ePr)); }`,
    );
  return sets.join("\n");
}

/** Marker fields shared by add_comp / add_layer / update. */
const MARKER_FIELD_PARAMS = [
  { name: "label", type: "number", description: "Label color index (0-16)", required: false },
  { name: "duration", type: "number", description: "Marker duration in seconds", required: false },
  { name: "chapter", type: "string", description: "Chapter link text", required: false },
  { name: "url", type: "string", description: "Web link URL", required: false },
  {
    name: "frameTarget",
    type: "string",
    description: "Web link frame target (used with url)",
    required: false,
  },
  {
    name: "cuePointName",
    type: "string",
    description: "Flash Video cue point name",
    required: false,
  },
  {
    name: "eventCuePoint",
    type: "boolean",
    description: "true = event cue point, false = navigation cue point",
    required: false,
  },
  {
    name: "params",
    type: "object",
    description: 'Cue point key/value parameters, e.g. { "speaker": "A" } (values stringified)',
    required: false,
  },
  {
    name: "protectedRegion",
    type: "boolean",
    description: "Protected-region flag (comp markers only)",
    required: false,
  },
] as const;

registerOp({
  name: "marker.add_comp",
  category: "marker",
  description: "Add a marker to a composition at a given time.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    { name: "time", type: "number", description: "Time in seconds", required: true },
    {
      name: "comment",
      type: "string",
      description: "Marker comment text",
      required: false,
      default: "",
    },
    ...MARKER_FIELD_PARAMS,
  ],
  toJsx(args) {
    return `
            ${jsxCompPreamble(args)}
            var _mv = new MarkerValue(${jsxVal(args.comment ?? "")});
            var _w = [];
            ${jsxMarkerFieldSets(args)}
            _comp.markerProperty.setValueAtTime(${jsxVal(args.time)}, _mv);
            return { ok: true, numMarkers: _comp.markerProperty.numKeys, warnings: _w };
        `;
  },
});

registerOp({
  name: "marker.add_layer",
  category: "marker",
  description: "Add a marker to a layer at a given time.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "1-based layer index, or the layer name",
      required: true,
    },
    { name: "time", type: "number", description: "Time in seconds", required: true },
    {
      name: "comment",
      type: "string",
      description: "Marker comment text",
      required: false,
      default: "",
    },
    ...MARKER_FIELD_PARAMS,
  ],
  toJsx(args) {
    return `
            ${jsxCompLayerPreamble(args)}
            var _mv = new MarkerValue(${jsxVal(args.comment ?? "")});
            var _w = [];
            ${jsxMarkerFieldSets(args)}
            _layer.property("Marker").setValueAtTime(${jsxVal(args.time)}, _mv);
            return { ok: true, numMarkers: _layer.property("Marker").numKeys, warnings: _w };
        `;
  },
});

registerOp({
  name: "marker.remove",
  category: "marker",
  description:
    "Remove a marker from a comp (default) or a layer (pass layer). Target by keyIndex or nearest time.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "Layer index or name — omit for comp markers",
      required: false,
    },
    { name: "keyIndex", type: "number", description: "1-based marker index", required: false },
    {
      name: "time",
      type: "number",
      description: "Remove the marker nearest to this time (used when keyIndex omitted)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxMarkerPreamble(args)}
            ${jsxMarkerKeyLookup(args)}
            var _removedTime = _mp.keyTime(_ki);
            _mp.removeKey(_ki);
            return { ok: true, removedTime: _removedTime, numMarkers: _mp.numKeys };
        `;
  },
});

registerOp({
  name: "marker.update",
  category: "marker",
  description:
    "Update fields of an existing marker on a comp (default) or a layer (pass layer). Target by keyIndex or nearest time. Only the passed fields change.",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "Layer index or name — omit for comp markers",
      required: false,
    },
    { name: "keyIndex", type: "number", description: "1-based marker index", required: false },
    {
      name: "time",
      type: "number",
      description: "Update the marker nearest to this time (used when keyIndex omitted)",
      required: false,
    },
    { name: "comment", type: "string", description: "New comment", required: false },
    ...MARKER_FIELD_PARAMS,
  ],
  toJsx(args) {
    const commentSet = args.comment !== undefined ? `_mv.comment = ${jsxVal(args.comment)};` : "";
    return `
            ${jsxMarkerPreamble(args)}
            ${jsxMarkerKeyLookup(args)}
            var _mv = _mp.keyValue(_ki);
            var _w = [];
            ${commentSet}
            ${jsxMarkerFieldSets(args)}
            _mp.setValueAtKey(_ki, _mv);
            return { ok: true, keyIndex: _ki, time: _mp.keyTime(_ki), warnings: _w };
        `;
  },
});

registerOp({
  name: "marker.list",
  category: "marker",
  readOnly: true,
  description: "List all markers on a comp (default) or a layer (pass layer).",
  params: [
    { name: "comp", type: "any", description: "Comp name or id", required: true },
    {
      name: "layer",
      type: "any",
      description: "Layer index or name — omit for comp markers",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            ${jsxMarkerPreamble(args)}
            var _markers = [];
            for (var _mi = 1; _mi <= _mp.numKeys; _mi++) {
                var _v = _mp.keyValue(_mi);
                _markers.push({
                    index: _mi,
                    time: _mp.keyTime(_mi),
                    comment: AE.safeGet(function () { return _v.comment; }, ""),
                    duration: AE.safeGet(function () { return _v.duration; }, 0),
                    label: AE.safeGet(function () { return _v.label; }, 0),
                    chapter: AE.safeGet(function () { return _v.chapter; }, ""),
                    url: AE.safeGet(function () { return _v.url; }, ""),
                    frameTarget: AE.safeGet(function () { return _v.frameTarget; }, ""),
                    cuePointName: AE.safeGet(function () { return _v.cuePointName; }, ""),
                    eventCuePoint: AE.safeGet(function () { return _v.eventCuePoint; }, false),
                    params: AE.safeGet(function () { return _v.getParameters(); }, {}),
                    protectedRegion: AE.safeGet(function () { return _v.protectedRegion; }, false)
                });
            }
            return { ok: true, count: _markers.length, markers: _markers };
        `;
  },
});
