// Operation Registry — maps operation names to JSX code generators.
// Each operation has metadata (category, description, param schema) and a
// `toJsx(args)` function that returns the JSX code string to execute.
//
// The registry is the single source of truth for ae_catalog and ae_do.
// Adding a new operation = adding one entry to this map.

export type ParamType = "string" | "number" | "boolean" | "array" | "object" | "any";

export interface OperationParam {
  name: string;
  type: ParamType;
  description: string;
  required?: boolean;
  default?: unknown;
  /**
   * Accept an explicit `null` for this parameter. Off by default: everywhere
   * else a `null` is an omitted argument that would otherwise be embedded into
   * the generated ExtendScript as a silent wrong value. Set it only where
   * `null` carries meaning (e.g. unparenting a layer).
   */
  nullable?: boolean;
}

export interface Operation {
  name: string;
  category: string;
  description: string;
  params: OperationParam[];
  /**
   * True when the operation cannot modify the AE project. Drives
   * AE_MCP_READONLY: read-only operations stay available there, everything
   * else is filtered out of `ae_catalog` and rejected by `ae_do`. Default
   * (undefined) means "mutates" — new operations are opted into safety, not
   * out of it.
   */
  readOnly?: boolean;
  /**
   * Whether this call may run inside the dispatcher's automatic undo group.
   * Omitted means yes, which is right for everything that MUTATES the project.
   * Return false for anything that drives the undo stack itself — Undo and Redo
   * are the whole list. AE resolves them against the group that is still open,
   * so `app.executeCommand(16)` between beginUndoGroup and endUndoGroup reverts
   * nothing the caller asked for and leaves the stack describing a step that
   * never happened. Those requests run bare instead (see EvalRequest.undoGroup).
   */
  undoGroup?(args: Record<string, unknown>): boolean;
  /** Generate the JSX code body (function body, ends with `return ...;`). */
  toJsx(args: Record<string, unknown>): string;
}

const operations = new Map<string, Operation>();

export function registerOp(op: Operation): void {
  operations.set(op.name, op);
}

export function getOp(name: string): Operation | undefined {
  return operations.get(name);
}

export function listOps(category?: string): Operation[] {
  const all = Array.from(operations.values());
  if (!category) return all;
  return all.filter((op) => op.category === category);
}

/** True when `op` may run inside the dispatcher's automatic undo group. */
export function wantsUndoGroup(op: Operation, args: Record<string, unknown>): boolean {
  return op.undoGroup ? op.undoGroup(args) : true;
}

export function listCategories(): string[] {
  const cats = new Set<string>();
  for (const op of operations.values()) cats.add(op.category);
  return Array.from(cats).sort();
}

// --- Helpers for JSX generation ---

/**
 * Safely embed a value as a JSX literal (JSON-stringified). Two subtleties:
 *  - `undefined` (a common value for an omitted optional arg) is normalized to
 *    `null` first: JSON.stringify(undefined) returns the *value* undefined, not
 *    a string, so calling .replace on it would throw. `null` embeds as a falsy
 *    literal, keeping patterns like `${jsxVal(args.w)} || _comp.width` working.
 *  - U+2028/U+2029 are legal raw inside JSON strings but are line terminators
 *    in ExtendScript's pre-ES2019 grammar — escape them or the generated
 *    script fails to parse.
 */
export function jsxVal(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Build the standard comp lookup preamble (defines `_comp`). */
export function jsxCompPreamble(args: Record<string, unknown>): string {
  return `
        var _comp = AE.findCompByNameOrId(${jsxVal(args.comp)});
        if (!_comp) return { ok: false, error: "no comp matching " + ${jsxVal(String(args.comp))} };
    `;
}

/**
 * Build the standard comp + layer lookup preamble (defines `_comp` and
 * `_layer`). Resolution goes through AE.findLayerInComp, which accepts a
 * 1-based index (range-checked — CompItem.layer() throws on out-of-range), a
 * layer name, or `{ id: n }` for a stable Layer.id reference (AE 22.0+).
 */
export function jsxCompLayerPreamble(args: Record<string, unknown>): string {
  return `
        ${jsxCompPreamble(args)}
        var _layerArg = ${jsxVal(args.layer)};
        var _layer = AE.findLayerInComp(_comp, _layerArg);
        if (!_layer) {
            var _layerDesc = (_layerArg !== null && typeof _layerArg === "object") ? ("id " + _layerArg.id) : _layerArg;
            return { ok: false, error: "no layer matching " + _layerDesc + " (comp has " + _comp.numLayers + " layers)" };
        }
    `;
}

/** Build property lookup from a path array. */
export function jsxPropertyLookup(pathArg: string = "_propPath"): string {
  return `
        var _node = _layer;
        for (var _pi = 0; _pi < ${pathArg}.length; _pi++) {
            var _next = null;
            try { _next = _node.property(${pathArg}[_pi]); } catch (e) {}
            if (!_next) return { ok: false, error: "property segment '" + ${pathArg}[_pi] + "' not found at depth " + _pi };
            _node = _next;
        }
    `;
}

/** Ambient context JSX snippet — appended to every ae_do response. */
export const AMBIENT_CONTEXT_JSX = `
    var _ctx = {};
    try {
        var _ai = app.project.activeItem;
        _ctx.project = { numItems: app.project.numItems, dirty: app.project.dirty, file: app.project.file ? app.project.file.fsName.replace(/\\\\/g,"/") : null };
        if (_ai && _ai instanceof CompItem) {
            _ctx.activeComp = { id: _ai.id, name: _ai.name, width: _ai.width, height: _ai.height, fps: _ai.frameRate, duration: _ai.duration, numLayers: _ai.numLayers };
            var _sel = [];
            for (var _si = 1; _si <= _ai.numLayers; _si++) {
                if (_ai.layer(_si).selected) _sel.push({ index: _si, name: _ai.layer(_si).name });
            }
            _ctx.selectedLayers = _sel;
        } else {
            _ctx.activeComp = null;
            _ctx.selectedLayers = [];
        }
    } catch (eCtx) { _ctx.error = AE.errText(eCtx); }
`;
