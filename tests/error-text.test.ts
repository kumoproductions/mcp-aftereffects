// The one function that is allowed to turn a caught exception into text, and
// the dispatcher's private copy of it.
//
// Why it exists at all: in ExtendScript `"failed: " + e` throws. The engine
// cannot coerce an Error to a primitive, so the concatenation raises "Object
// of type Error found where a Number, Array, or Property is needed" from
// inside the handler that was reporting the original failure. The real error
// is lost, the replacement escapes, and in the dispatcher it reaches AE's
// modal error dialog — which blocks scripting for the rest of the session, so
// every later call fails as a busy-lock timeout that says nothing about why.
//
// Both copies are extracted from the real sources and exercised against the
// same table: the contract is that neither ever throws, whatever it is handed,
// and that the two stay in step.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HELPERS_PATH = fileURLToPath(new URL("../jsx/helpers.jsx", import.meta.url));
const DISPATCHER_PATH = fileURLToPath(new URL("../jsx/dispatcher.jsx", import.meta.url));

/** Source text of the function introduced by `header`, up to its closing brace. */
function extractFunction(src: string, header: string): string {
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`not found in source: ${header}`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated: ${header}`);
}

type Formatter = (e: unknown) => string;

function loadErrText(): Formatter {
  const body = extractFunction(readFileSync(HELPERS_PATH, "utf8"), "AE.errText = function (e) {");
  return new Function(`var AE = {}; ${body}; return AE.errText;`)() as Formatter;
}

function loadDescribeError(): Formatter {
  const body = extractFunction(
    readFileSync(DISPATCHER_PATH, "utf8"),
    "function describeError(e) {",
  );
  return new Function(`${body}; return describeError;`)() as Formatter;
}

const hostile = {
  get message(): string {
    throw new Error("even reading the message fails");
  },
};

const cases: Array<{ name: string; input: unknown; expected: string }> = [
  { name: "an ordinary Error", input: new Error("boom"), expected: "boom" },
  { name: "null", input: null, expected: "unknown error" },
  { name: "undefined", input: undefined, expected: "unknown error" },
  { name: "a thrown string", input: "not an object", expected: "not an object" },
  { name: "an Error with no message", input: new Error(""), expected: "error" },
  { name: "a bare object", input: {}, expected: "error" },
  { name: "an object that throws on read", input: hostile, expected: "unformattable error" },
];

describe.each([
  ["AE.errText (jsx/helpers.jsx)", loadErrText],
  ["describeError (jsx/dispatcher.jsx)", loadDescribeError],
])("%s", (_label, load) => {
  const format = load();

  it.each(cases)("renders $name", ({ input, expected }) => {
    expect(format(input)).toBe(expected);
  });

  it("appends the ExtendScript line number when there is one", () => {
    // `e.line` is ExtendScript's, not Node's — it is what told us the failure
    // was at json2.jsx:24 once the handler stopped throwing over the top of it.
    const err = Object.assign(new Error("boom"), { line: 24 });
    expect(format(err)).toBe("boom (line 24)");
  });

  it("never throws, whatever it is handed", () => {
    for (const input of [...cases.map((c) => c.input), 42, [1, 2], Symbol("s")]) {
      expect(() => format(input)).not.toThrow();
    }
  });
});

describe("the two copies", () => {
  it("agree on every case", () => {
    const errText = loadErrText();
    const describeError = loadDescribeError();
    for (const { input } of cases) {
      expect(describeError(input)).toBe(errText(input));
    }
  });
});
