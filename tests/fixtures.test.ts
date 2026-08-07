// Validate the hand-crafted fixture JSON documents under fixtures/. This
// catches typos in the fixtures without needing AE.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateAeProjectDoc } from "../src/validate.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));
const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

describe("fixtures", () => {
  it("finds at least one fixture document", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const f of files) {
    it(`${f} parses and validates`, () => {
      const raw = readFileSync(path.join(FIXTURES_DIR, f), "utf8");
      const doc: unknown = JSON.parse(raw); // a parse error fails the test with its message
      const result = validateAeProjectDoc(doc);
      expect(result.issues).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});
