// Static analysis of everything that ends up inside After Effects. Two passes,
// neither of which touches AE:
//   1. ES3 compatibility of the sources under jsx/
//   2. injection safety of the JSX we generate from TypeScript — no tool
//      argument may reach the generated script without going through jsxVal

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { lintCodegenDir, lintCodegenFile } from "./helpers/lint-codegen.js";
import { findTernaryChains, lintJsxDir } from "./helpers/lint-jsx.js";

const JSX_DIR = fileURLToPath(new URL("../jsx/", import.meta.url));
// Whole of src/, not just operations + tools: the `jsx*` encoder helpers the
// lint trusts by name live in registry.ts, and trusting them is only sound
// while their own bodies are scanned too.
const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

describe("jsx/ ES3 lint", () => {
  it("has zero error-severity findings", () => {
    const findings = lintJsxDir(JSX_DIR);
    const errors = findings.filter((f) => f.severity === "error");
    const report = errors
      .map((f) => `${f.file}:${f.line} [${f.rule}] ${f.description}\n    > ${f.text}`)
      .join("\n");
    expect(errors.length, report).toBe(0);
  });
});

describe("generated-JSX injection lint", () => {
  it("nothing under src/ interpolates a tool argument raw", () => {
    const findings = lintCodegenDir(SRC_DIR);
    const report = findings.map((f) => `${f.file}:${f.line}\n    > ${f.text}`).join("\n");
    expect(findings.length, report).toBe(0);
  });

  it("nothing under src/ renders a caught exception by coercion", () => {
    // Covered by the same pass; asserted separately because it is a different
    // failure mode — not injection, but a handler that throws while handling.
    const findings = lintCodegenDir(SRC_DIR).filter((f) => f.message.includes("coercion"));
    const report = findings.map((f) => `${f.file}:${f.line}\n    > ${f.text}`).join("\n");
    expect(findings.length, report).toBe(0);
  });

  it("catches the injection pattern it exists to catch", () => {
    // Guard against the lint silently degrading into a no-op: a fixture with a
    // known-bad interpolation must still be reported.
    const fixture = fileURLToPath(new URL("./fixtures/bad-codegen.fixture.ts", import.meta.url));
    const findings = lintCodegenFile(fixture);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.some((f) => f.text.includes("layers.addSolid"))).toBe(true);
    // The ternary-test exemption must not extend to the emitted branch.
    expect(findings.some((f) => f.text.includes("_layer.name ="))).toBe(true);
    // …and it must still exempt the test itself, or every conditional
    // fragment in src/operations would be a false positive.
    expect(findings.every((f) => !f.text.includes("jsxVal(args."))).toBe(true);
  });

  it("catches both shapes of rendering an exception by coercion", () => {
    const fixture = fileURLToPath(new URL("./fixtures/bad-codegen.fixture.ts", import.meta.url));
    const findings = lintCodegenFile(fixture).filter((f) => f.message.includes("coercion"));
    expect(findings.some((f) => f.text.includes('"name: " + e'))).toBe(true);
    expect(findings.some((f) => f.text.includes("String(eRm)"))).toBe(true);
    // `_w.push`, `_layer`, `AE.errText` and the like must not be swept up: the
    // rule keys off catch-parameter names, not "starts with e".
    expect(findings.length).toBe(2);
  });

  it("catches a chained ternary in generated JSX, and only the unparenthesized form", () => {
    // ExtendScript parses ?: left-associatively — the chain that labelled
    // every ae_context item "Folder". The parenthesized twin is correct and
    // must stay clean.
    const fixture = fileURLToPath(new URL("./fixtures/bad-codegen.fixture.ts", import.meta.url));
    const findings = lintCodegenFile(fixture).filter((f) =>
      f.message.includes("LEFT-associatively"),
    );
    expect(findings.length).toBe(1);
    expect(findings[0].text).toContain('? "Comp" :');
    expect(findings[0].text).not.toContain("((it instanceof FolderItem)");
  });
});

describe("findTernaryChains", () => {
  const chains = (code: string) => findTernaryChains(code).length;

  it("flags the left-associativity trap", () => {
    expect(chains("var t = a ? 1 : b ? 2 : 3;")).toBeGreaterThan(0);
    expect(chains("x = a ? 1 : b ? 2 : c ? 3 : 4;")).toBeGreaterThan(0);
    // Chain inside an object literal value (the shipped ae_context shape).
    expect(chains("var o = { type: a ? 1 : b ? 2 : 3 };")).toBeGreaterThan(0);
    // Chain as a call argument.
    expect(chains("f(a ? 1 : b ? 2 : 3);")).toBeGreaterThan(0);
    // Unparenthesized conditional in the THEN branch is just as ambiguous.
    expect(chains("var t = a ? b ? 1 : 2 : 3;")).toBeGreaterThan(0);
    // Multi-line chains must not escape.
    expect(chains("var t = a ? 1 :\n    b ? 2 : 3;")).toBeGreaterThan(0);
  });

  it("stays quiet on correct forms", () => {
    expect(chains("var t = a ? 1 : 2;")).toBe(0);
    // Parenthesized nesting is the sanctioned fix.
    expect(chains("var t = a ? 1 : (b ? 2 : 3);")).toBe(0);
    expect(chains("var t = a ? (b ? 1 : 2) : 3;")).toBe(0);
    // Independent ternaries: statement-, argument-, and property-separated.
    expect(chains("var t = a ? 1 : 2; var u = b ? 3 : 4;")).toBe(0);
    expect(chains("f(a ? 1 : 2, b ? 3 : 4);")).toBe(0);
    expect(chains("var o = { x: a ? 1 : 2, y: b ? 3 : 4 };")).toBe(0);
    expect(chains("var o = {\n  x: a ? 1 : 2,\n  y: b ? 3 : 4\n};")).toBe(0);
    // Ternary inside a function call inside a branch.
    expect(chains("var t = a ? f(b ? 1 : 2) : 3;")).toBe(0);
  });
});
