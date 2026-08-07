// Unit tests for the Node-side schema validator. Runs without AE.

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../src/schema.js";
import { validateAeProjectDoc } from "../src/validate.js";

interface TestCase {
  name: string;
  input: unknown;
  expectOk: boolean;
  expectIssuePaths?: string[];
  expectWarningPaths?: string[];
}

const cases: TestCase[] = [
  {
    name: "valid minimal doc",
    input: {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: "now",
      aeVersion: "26.0",
      project: { file: null, bitsPerChannel: 8, timeDisplayType: "0" },
      items: [],
    },
    expectOk: true,
  },
  {
    name: "missing schemaVersion",
    input: { items: [] },
    expectOk: false,
    expectIssuePaths: ["schemaVersion"],
  },
  {
    name: "items not an array",
    input: { schemaVersion: 2, items: "nope" },
    expectOk: false,
    expectIssuePaths: ["items"],
  },
  {
    name: "valid doc with one folder",
    input: {
      schemaVersion: 2,
      items: [
        {
          id: 1,
          name: "folder1",
          type: "FolderItem",
          parentFolderId: null,
          parentFolderName: null,
          label: 0,
          comment: "",
        },
      ],
    },
    expectOk: true,
  },
  {
    name: "duplicate item ids",
    input: {
      schemaVersion: 2,
      items: [
        {
          id: 1,
          name: "a",
          type: "FolderItem",
          parentFolderId: null,
          parentFolderName: null,
          label: 0,
          comment: "",
        },
        {
          id: 1,
          name: "b",
          type: "FolderItem",
          parentFolderId: null,
          parentFolderName: null,
          label: 0,
          comment: "",
        },
      ],
    },
    expectOk: false,
    expectIssuePaths: ["items[1].id"],
  },
  {
    name: "comp missing width",
    input: {
      schemaVersion: 2,
      items: [
        {
          id: 1,
          name: "comp",
          type: "CompItem",
          parentFolderId: null,
          parentFolderName: null,
          label: 0,
          comment: "",
          height: 1080,
          duration: 5,
          frameRate: 30,
        },
      ],
    },
    expectOk: false,
    expectIssuePaths: ["items[0].width"],
  },
  {
    name: "layer sourceId references missing item (warning only)",
    input: {
      schemaVersion: 2,
      items: [
        {
          id: 1,
          name: "comp",
          type: "CompItem",
          parentFolderId: null,
          parentFolderName: null,
          label: 0,
          comment: "",
          width: 1920,
          height: 1080,
          duration: 5,
          frameRate: 30,
          layers: [
            {
              index: 1,
              name: "layer",
              type: "AVLayer",
              enabled: true,
              solo: false,
              shy: false,
              locked: false,
              inPoint: 0,
              outPoint: 5,
              startTime: 0,
              stretch: 100,
              parentIndex: null,
              label: 0,
              sourceId: 9999,
            },
          ],
        },
      ],
    },
    expectOk: true,
    expectWarningPaths: ["items[0].layers[0].sourceId"],
  },
  {
    name: "parentFolderId dangling reference",
    input: {
      schemaVersion: 2,
      items: [
        {
          id: 1,
          name: "a",
          type: "FolderItem",
          parentFolderId: 99,
          parentFolderName: null,
          label: 0,
          comment: "",
        },
      ],
    },
    expectOk: true,
    expectWarningPaths: ["items[0].parentFolderId"],
  },
  {
    name: "parentFolderId points at a non-folder",
    input: {
      schemaVersion: 2,
      items: [
        {
          id: 1,
          name: "c",
          type: "CompItem",
          parentFolderId: null,
          parentFolderName: null,
          label: 0,
          comment: "",
          width: 100,
          height: 100,
          duration: 1,
          frameRate: 30,
        },
        {
          id: 2,
          name: "x",
          type: "FolderItem",
          parentFolderId: 1,
          parentFolderName: null,
          label: 0,
          comment: "",
        },
      ],
    },
    expectOk: true,
    expectWarningPaths: ["items[1].parentFolderId"],
  },
  {
    // Documented policy: refuse documents newer than the runtime schema.
    // Users can force an import with skipValidation.
    name: "newer schema version is a validation error",
    input: { schemaVersion: 99, items: [] },
    expectOk: false,
    expectIssuePaths: ["schemaVersion"],
  },
];

describe("validateAeProjectDoc", () => {
  for (const tc of cases) {
    it(tc.name, () => {
      const result = validateAeProjectDoc(tc.input);
      expect(
        result.ok,
        `ok mismatch — issues: ${JSON.stringify(result.issues)}, warnings: ${JSON.stringify(result.warnings)}`,
      ).toBe(tc.expectOk);
      for (const p of tc.expectIssuePaths ?? []) {
        expect(result.issues.map((i) => i.path)).toContain(p);
      }
      for (const p of tc.expectWarningPaths ?? []) {
        expect(result.warnings.map((w) => w.path)).toContain(p);
      }
    });
  }
});
