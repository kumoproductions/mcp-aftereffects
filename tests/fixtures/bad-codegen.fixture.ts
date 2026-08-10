// Fixture for the generated-JSX lint. NOT part of the build: it exists so the
// lint's own test can prove it still catches the patterns it was written for.
// Every interpolation below is deliberately unsafe.
//
// The `.fixture.ts` suffix keeps it out of src/, so the real lint passes never
// see it and vitest never collects it as a suite.

export function badSolid(args: Record<string, unknown>): string {
  return `
        var _comp = AE.findCompByNameOrId("${args.comp}");
        _comp.layers.addSolid([1, 0, 0], "${args.name}", 100, 100, 1);
        return { ok: true };
    `;
}

/**
 * The ternary-test exemption must not become a hole: `args.name` in the TEST
 * position is fine, the same value in the emitted BRANCH is an injection.
 */
export function badTernaryBranch(args: Record<string, unknown>): string {
  return `
        var _layer = AE.findLayer();
        ${args.name ? `_layer.name = "${args.name}";` : ""}
        return { ok: true };
    `;
}

/**
 * Both shapes of rendering a caught exception by coercion. Each throws inside
 * the handler in real ExtendScript; each must be reported here.
 */
export function badErrorReporting(): string {
  return `
        var _w = [];
        try { _layer.name = "x"; } catch (e) { _w.push("name: " + e); }
        try { _layer.remove(); } catch (eRm) { _w.push(String(eRm)); }
        return { ok: true, warnings: _w };
    `;
}

export function safeSolid(args: Record<string, unknown>, jsxVal: (v: unknown) => string): string {
  return `
        var _comp = AE.findCompByNameOrId(${jsxVal(args.comp)});
        _comp.layers.addSolid([1, 0, 0], ${jsxVal(args.name)}, 100, 100, 1);
        return { ok: true };
    `;
}
