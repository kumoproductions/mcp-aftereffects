// Static analysis of everything that ends up inside After Effects. Two passes,
// neither of which touches AE:
//   1. ES3 compatibility of the sources under jsx/
//   2. injection safety of the JSX we generate from TypeScript — no tool
//      argument may reach the generated script without going through jsxVal

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { lintCodegenDir, lintCodegenFile } from "./helpers/lint-codegen.js";
import { lintJsxDir } from "./helpers/lint-jsx.js";

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
});
