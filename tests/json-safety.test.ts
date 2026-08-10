// Two halves of the same seam: what the transport WRITES into the mailbox and
// what the ExtendScript side READS back out of it.
//
// The ES3 side has no parser but `eval`, so json2.jsx guards it. That guard is
// a security control — the dispatcher parses the whole request file with it,
// and a request carries `payload`, which for ae_project_import_json is the
// contents of an arbitrary .json file the caller pointed at. These tests
// exercise the real json2.jsx source, not a copy.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { serializeRequest } from "../src/transport/FileIpcTransport.js";

const JSON2_PATH = fileURLToPath(new URL("../jsx/json2.jsx", import.meta.url));

const LS = "\u2028";
const PS = "\u2029";

/**
 * Load the polyfill the way After Effects would when it has no native JSON:
 * hand the file a local `JSON` binding that is undefined, then take back
 * whatever it installed.
 */
function loadPolyfill(): { parse: (t: string) => unknown; stringify: (v: unknown) => string } {
  const src = readFileSync(JSON2_PATH, "utf8");
  const load = new Function("JSON", `${src}\nreturn JSON;`) as (
    j: undefined,
  ) => ReturnType<typeof loadPolyfill>;
  return load(undefined);
}

/**
 * Characters ExtendScript reserves for operator overloading. It hangs default
 * implementations off Object.prototype under exactly these names, so inside AE
 * `({})["-"]` is a **Function**, not undefined — while in Node it is undefined
 * and the hazard is invisible. Recreating the pollution is the only way this
 * suite can see the bug that made every single tool call fail on AE 26.3.
 *
 * Non-enumerable on purpose: `for (k in obj)` must behave as it does in AE,
 * and vitest's own object walking must not trip over them either.
 */
const ES_OPERATOR_KEYS = ["+", "-", "*", "/", "<", "<=", "==", "==="];

function withExtendScriptOperators<T>(fn: () => T): T {
  for (const key of ES_OPERATOR_KEYS) {
    Object.defineProperty(Object.prototype, key, {
      value: function operatorOverload() {},
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  try {
    return fn();
  } finally {
    for (const key of ES_OPERATOR_KEYS) {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  }
}

describe("json2.jsx stringify under ExtendScript's operator overloads", () => {
  it("serializes ordinary values", () => {
    const json = loadPolyfill();
    expect(json.stringify({ a: 1, b: [true, null, "x"], c: { d: 'q"uote\n' } })).toBe(
      '{"a":1,"b":[true,null,"x"],"c":{"d":"q\\"uote\\n"}}',
    );
  });

  it("serializes a hyphenated request id", () => {
    // The regression that took the package to a 100% failure rate on AE 26.3:
    // `escMap["-"]` resolved to an inherited Function, the truthiness guard
    // passed, and `out +=` died on it. Every id is a UUID, so every response
    // was unserializable — nothing was ever written and every call timed out.
    withExtendScriptOperators(() => {
      const json = loadPolyfill();
      const id = "b81b9e1d-6daa-4c39-9e2f-8a1d0c7f4b22";
      expect(json.stringify({ id, ok: true })).toBe(`{"id":"${id}","ok":true}`);
    });
  });

  it("serializes every overloaded character, in values and in keys", () => {
    withExtendScriptOperators(() => {
      const json = loadPolyfill();
      // Ordinary project data: a comp named like this used to be enough.
      const doc = { "shot-01/comp+bg": "take-2 * 1.5 / final <= v3 == approved" };
      expect(JSON.parse(json.stringify(doc))).toEqual(doc);
    });
  });

  it("still escapes what it is supposed to escape", () => {
    withExtendScriptOperators(() => {
      const json = loadPolyfill();
      const control = String.fromCharCode(1);
      expect(json.stringify(`tab\there\\and${control}`)).toBe('"tab\\there\\\\and\\u0001"');
    });
  });
});

describe("json2.jsx parse guard", () => {
  const json = loadPolyfill();

  it("installs a polyfill when the host has no JSON", () => {
    expect(typeof json.parse).toBe("function");
    expect(typeof json.stringify).toBe("function");
  });

  it("parses ordinary documents", () => {
    expect(json.parse('{"a":1,"b":[true,null,"x"],"c":{"d":-2.5e3}}')).toEqual({
      a: 1,
      b: [true, null, "x"],
      c: { d: -2500 },
    });
  });

  it("refuses a call expression instead of executing it", () => {
    // Without the guard this runs the function — arbitrary code execution
    // inside After Effects from a file the caller merely pointed at.
    expect(() => json.parse('(function(){ throw new Error("EXECUTED"); })()')).toThrow(
      /not valid JSON/,
    );
  });

  it("refuses code smuggled into a value position", () => {
    expect(() => json.parse('{"a": (function(){ return 1; })() }')).toThrow(/not valid JSON/);
    expect(() => json.parse('{"a": globalThis }')).toThrow(/not valid JSON/);
  });

  it("is not fooled by code hidden after a well-formed prefix", () => {
    expect(() => json.parse('{"a":1}, (function(){ return 2; })()')).toThrow(/not valid JSON/);
  });

  it("keeps a string that merely LOOKS like code as data", () => {
    expect(json.parse('{"expr": "(function(){ return 1; })()"}')).toEqual({
      expr: "(function(){ return 1; })()",
    });
  });

  it("parses strings containing raw U+2028 / U+2029 instead of dying on them", () => {
    // Raw separators are legal in JSON but terminate a line in ES3. The guard
    // escapes them before eval sees them.
    const doc = json.parse(`{"name":"a${LS}b","other":"c${PS}d"}`) as Record<string, string>;
    expect(doc.name).toBe(`a${LS}b`);
    expect(doc.other).toBe(`c${PS}d`);
  });
});

describe("transport request serialization", () => {
  it("escapes U+2028 / U+2029 that JSON.stringify would emit raw", () => {
    const text = serializeRequest({ label: "x", payload: { name: `a${LS}b${PS}c` } });
    expect(text).not.toContain(LS);
    expect(text).not.toContain(PS);
    expect(text).toContain("\\u2028");
    expect(text).toContain("\\u2029");
  });

  it("round-trips through the ES3 parser with the value intact", () => {
    const json = loadPolyfill();
    const payload = { name: `layer${LS}name` };
    const parsed = json.parse(serializeRequest({ id: "1", payload })) as {
      payload: { name: string };
    };
    expect(parsed.payload.name).toBe(`layer${LS}name`);
  });

  it("stays plain JSON for everything else", () => {
    const value = { id: "abc", label: "keyframe.add", code: 'var x = "q\\"uote";', payload: null };
    expect(JSON.parse(serializeRequest(value))).toEqual(value);
  });
});
