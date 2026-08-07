// Synthetic roundtrip test: builds an in-memory export document mirroring
// what helpers.jsx would produce on a small project, then runs it through
// the Node-side validator. Verifies the schema types and validator match the
// JSX output contract, without any AE.

import { describe, expect, it } from "vitest";

import type { AeProjectDoc } from "../src/schema.js";
import { SCHEMA_VERSION } from "../src/schema.js";
import { validateAeProjectDoc } from "../src/validate.js";

function buildSynthetic(): AeProjectDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    aeVersion: "26.0",
    project: {
      file: null,
      bitsPerChannel: 8,
      timeDisplayType: "0",
    },
    items: [
      {
        id: 1,
        name: "Solids",
        type: "FolderItem",
        parentFolderId: null,
        parentFolderName: null,
        label: 0,
        comment: "",
      },
      {
        id: 2,
        name: "main",
        type: "CompItem",
        parentFolderId: null,
        parentFolderName: null,
        label: 0,
        comment: "",
        width: 1920,
        height: 1080,
        frameRate: 29.97,
        duration: 10,
        layerCount: 3,
        bgColor: [0, 0, 0],
        workAreaStart: 0,
        workAreaDuration: 10,
        pixelAspect: 1,
        shutterAngle: 180,
        shutterPhase: -90,
        motionBlur: false,
        displayStartTime: 0,
        layers: [
          {
            index: 1,
            name: "title",
            type: "TextLayer",
            enabled: true,
            solo: false,
            shy: false,
            locked: false,
            inPoint: 0,
            outPoint: 10,
            startTime: 0,
            stretch: 100,
            parentIndex: null,
            label: 5,
            parent: null,
            textGroup: {
              name: "Text",
              matchName: "ADBE Text Properties",
              properties: [
                {
                  name: "Source Text",
                  matchName: "ADBE Text Document",
                  propertyValueType: "TEXT_DOCUMENT",
                  value: {
                    __kind: "TextDocument",
                    text: "Hello",
                    font: null,
                    fontFamily: null,
                    fontStyle: null,
                    fontSize: 72,
                    fillColor: [1, 1, 1],
                    strokeColor: null,
                    strokeWidth: 0,
                    justification: null,
                    tracking: 0,
                    leading: 0,
                    baselineShift: 0,
                    applyFill: true,
                    applyStroke: false,
                    boxText: false,
                    boxTextSize: null,
                    boxTextPos: null,
                  },
                },
              ],
              groups: [],
            },
          },
          {
            index: 2,
            name: "red",
            type: "AVLayer",
            enabled: true,
            solo: false,
            shy: false,
            locked: false,
            inPoint: 0,
            outPoint: 10,
            startTime: 0,
            stretch: 100,
            parentIndex: null,
            label: 1,
            sourceId: 3,
            sourceName: "red_solid",
            width: 1920,
            height: 1080,
            hasVideo: true,
            hasAudio: false,
            threeDLayer: false,
            transformGroup: {
              name: "Transform",
              matchName: "ADBE Transform Group",
              properties: [
                {
                  name: "Position",
                  matchName: "ADBE Position",
                  propertyValueType: "TwoD_SPATIAL",
                  value: [960, 540],
                  keyframes: [
                    { time: 0, value: [100, 540], inInterp: 6613, outInterp: 6613 },
                    { time: 2, value: [1820, 540], inInterp: 6613, outInterp: 6613 },
                  ],
                },
              ],
              groups: [],
            },
          },
          {
            index: 3,
            name: "parent-ref",
            type: "AVLayer",
            enabled: true,
            solo: false,
            shy: false,
            locked: false,
            inPoint: 0,
            outPoint: 10,
            startTime: 0,
            stretch: 100,
            parentIndex: 2,
            label: 2,
            sourceId: 3,
          },
        ],
      },
      {
        id: 3,
        name: "red_solid",
        type: "FootageItem",
        parentFolderId: 1,
        parentFolderName: "Solids",
        label: 0,
        comment: "",
        width: 1920,
        height: 1080,
        duration: 0,
        sourceKind: "solid",
        color: [1, 0, 0],
        sourceWidth: 1920,
        sourceHeight: 1080,
      },
    ],
  };
}

describe("synthetic export document", () => {
  it("validates cleanly with no issues or warnings", () => {
    const doc = buildSynthetic();
    const result = validateAeProjectDoc(doc);
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("survives a JSON.stringify/parse round-trip without validation drift", () => {
    const doc = buildSynthetic();
    const first = validateAeProjectDoc(doc);

    const serialized = JSON.stringify(doc);
    const reparsed: unknown = JSON.parse(serialized);
    const second = validateAeProjectDoc(reparsed);

    expect(second.issues).toEqual([]);
    expect(second.ok).toBe(true);
    expect(second.warnings).toEqual(first.warnings);
    expect(reparsed).toEqual(doc);
  });
});
