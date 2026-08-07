import { describe, expect, it } from "vitest";

import { getOp, jsxVal } from "../src/registry.js";
// Importing the operation registry for its registration side effects.
import "../src/operations/index.js";

describe("jsxVal", () => {
  it("JSON-encodes primitives, arrays, and objects", () => {
    expect(jsxVal("hi")).toBe('"hi"');
    expect(jsxVal(42)).toBe("42");
    expect(jsxVal([1, 2, 3])).toBe("[1,2,3]");
    expect(jsxVal({ a: 1 })).toBe('{"a":1}');
    expect(jsxVal(null)).toBe("null");
    expect(jsxVal(true)).toBe("true");
  });

  it("normalizes undefined to null instead of throwing", () => {
    // JSON.stringify(undefined) returns the value undefined, so the old
    // .replace-based jsxVal threw. Omitted optional args must be embeddable.
    expect(() => jsxVal(undefined)).not.toThrow();
    expect(jsxVal(undefined)).toBe("null");
  });

  it("escapes U+2028 / U+2029 so ExtendScript's ES3 parser doesn't see line terminators", () => {
    expect(jsxVal("a b")).toBe('"a\\u2028b"');
    expect(jsxVal("a b")).toBe('"a\\u2029b"');
    // A comp name with a paragraph separator must not break out of the literal.
    expect(jsxVal("Main ")).not.toContain(" ");
  });
});

describe("operation registry codegen with omitted optional args", () => {
  // These ops document optional params (width/height, time) whose default
  // path splices the arg via jsxVal. Omitting them must generate ES3 without
  // throwing (regression: jsxVal(undefined) used to throw a TypeError).
  it("layer.create_solid generates when width/height are omitted", () => {
    const op = getOp("layer.create_solid");
    expect(op).toBeTruthy();
    const jsx = op!.toJsx({ comp: "Main" });
    expect(jsx).toContain("null || _comp.width");
    expect(jsx).toContain("null || _comp.height");
  });

  it("property.get generates when time is omitted", () => {
    const op = getOp("property.get");
    expect(op).toBeTruthy();
    expect(() =>
      op!.toJsx({ comp: "Main", layer: 1, property: ["Transform", "Position"] }),
    ).not.toThrow();
  });
});
