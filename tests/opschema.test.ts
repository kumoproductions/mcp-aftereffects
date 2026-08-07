// Argument validation for registry operations. These are the checks that used
// to not exist: ae_catalog advertised a parameter schema that ae_do never
// enforced, so a missing required arg became `null` in the generated
// ExtendScript and a misspelled key was dropped on the floor.

import { describe, expect, it } from "vitest";

import { suggestName, summarizeParams, validateOpArgs } from "../src/opschema.js";
import { getOp } from "../src/registry.js";
// Importing the operation registry for its registration side effects.
import "../src/operations/index.js";

function op(name: string) {
  const found = getOp(name);
  expect(found, `operation ${name} should be registered`).toBeTruthy();
  return found!;
}

describe("validateOpArgs", () => {
  it("accepts a fully specified call", () => {
    const res = validateOpArgs(op("keyframe.add"), {
      comp: "Main",
      layer: 1,
      property: ["Transform", "Position"],
      time: 2,
      value: [960, 540],
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a missing required parameter", () => {
    const res = validateOpArgs(op("keyframe.add"), {
      comp: "Main",
      layer: 1,
      property: ["Transform", "Position"],
      value: [960, 540],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.map((i) => i.path)).toContain("time");
    expect(res.issues[0].message).toContain("missing required parameter");
  });

  it("rejects a wrong type instead of coercing it", () => {
    const res = validateOpArgs(op("keyframe.add"), {
      comp: "Main",
      layer: 1,
      property: ["Transform", "Position"],
      time: "2",
      value: [960, 540],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues).toContainEqual({
      path: "time",
      message: "must be number, got string",
    });
  });

  it("rejects an unknown key and suggests the intended one", () => {
    const res = validateOpArgs(op("keyframe.add"), {
      comp: "Main",
      lyaer: 1,
      property: ["Transform", "Position"],
      time: 0,
      value: 0,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const unknown = res.issues.find((i) => i.path === "lyaer");
    expect(unknown?.message).toBe("unknown parameter — did you mean 'layer'?");
  });

  it("lists the accepted parameters when nothing is close enough to suggest", () => {
    const res = validateOpArgs(op("command.execute"), { id: 2004, zzzzzzzzzz: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues[0].message).toContain("this operation accepts: id");
  });

  it("treats a zero-parameter operation as accepting nothing", () => {
    expect(validateOpArgs(op("project.clear"), {}).ok).toBe(true);
    expect(validateOpArgs(op("project.clear"), { force: true }).ok).toBe(false);
  });

  it("allows an omitted optional parameter but not an explicit null", () => {
    expect(validateOpArgs(op("layer.create_solid"), { comp: "Main" }).ok).toBe(true);
    const withNull = validateOpArgs(op("layer.create_solid"), { comp: "Main", width: null });
    expect(withNull.ok).toBe(false);
    if (withNull.ok) return;
    expect(withNull.issues[0].message).toContain("omit the key instead of passing null");
  });

  it("allows null where null is the documented signal", () => {
    // layer.set_parent uses null/0 to unparent, so it opts in via `nullable`.
    const res = validateOpArgs(op("layer.set_parent"), {
      comp: "Main",
      layer: 2,
      parentLayer: null,
    });
    expect(res.ok).toBe(true);
  });

  it("accepts a layer NAME wherever the generated JSX accepts one", () => {
    // comp.layer(x) resolves an index or a name; the declarations used to say
    // `number`, so enforcing them would have broken name addressing.
    for (const name of ["keyframe.add", "effect.add", "mask.add", "text.set_content"]) {
      const params = op(name).params;
      const layerParam = params.find((p) => p.name === "layer");
      expect(layerParam, `${name} should declare a layer param`).toBeTruthy();
      expect(layerParam?.type, `${name}.layer must not claim to be number-only`).toBe("any");
    }
  });

  it("rejects a non-object args container", () => {
    const res = validateOpArgs(op("keyframe.add"), "comp=Main");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues[0]).toEqual({ path: "args", message: "must be an object, got string" });
  });

  it("treats omitted args as an empty object", () => {
    expect(validateOpArgs(op("render.start"), undefined).ok).toBe(true);
  });
});

describe("suggestName", () => {
  it("suggests a near miss", () => {
    expect(suggestName("lyaer", ["comp", "layer", "time"])).toBe("layer");
    expect(suggestName("keyframe.ad", ["keyframe.add", "keyframe.remove"])).toBe("keyframe.add");
  });

  it("declines when nothing is close", () => {
    expect(suggestName("totallyunrelated", ["comp", "layer"])).toBeNull();
  });
});

describe("summarizeParams", () => {
  it("marks required, optional, and nullable", () => {
    const summary = summarizeParams(op("layer.set_parent").params);
    expect(summary).toContain("comp: any (required)");
    expect(summary).toContain("parentLayer: any (required, nullable)");
    expect(summarizeParams(op("layer.create_solid").params)).toContain("width: number (optional)");
  });
});
