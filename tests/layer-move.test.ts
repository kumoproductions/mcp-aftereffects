// layer.move, executed rather than pattern-matched.
//
// The operation shipped calling `_layer.moveTo(toIndex)`. `Layer` inherits
// `moveTo` from `PropertyBase`, so it exists, type-checks, and looks correct in
// review — and then throws for every layer, every time: "Can not moveTo this
// property, because parent is not an INDEXED_GROUP". A layer's parent is the
// composition, not a property group, so the inherited method never applies.
// `layer.move` had a 100% failure rate from the first release.
//
// Reordering a layer is only expressible relative to a sibling
// (`moveBefore`/`moveAfter`), which makes the target index a small piece of
// arithmetic — and arithmetic is worth executing, not eyeballing. So this suite
// runs the REAL generated JSX against a fake `app`, on top of the REAL
// helpers.jsx, and checks where layers actually land.
//
// The fake's move semantics were calibrated against After Effects 26.3x87: for
// each case below, AE produced exactly the ordering asserted here.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getOp } from "../src/registry.js";
import "../src/operations/index.js";

const HELPERS_PATH = fileURLToPath(new URL("../jsx/helpers.jsx", import.meta.url));

class FakeLayer {
  constructor(
    readonly name: string,
    private readonly comp: FakeComp,
  ) {}

  get index(): number {
    return this.comp.stack.indexOf(this) + 1;
  }

  /** AE: this layer ends up immediately above `other`, whichever way it came. */
  moveBefore(other: FakeLayer): void {
    this.reinsert(other, 0);
  }

  /** AE: this layer ends up immediately below `other`. */
  moveAfter(other: FakeLayer): void {
    this.reinsert(other, 1);
  }

  private reinsert(other: FakeLayer, offset: number): void {
    const stack = this.comp.stack;
    stack.splice(stack.indexOf(this), 1);
    stack.splice(stack.indexOf(other) + offset, 0, this);
  }
}

class FakeComp {
  readonly stack: FakeLayer[] = [];

  constructor(
    readonly name: string,
    layerNames: string[],
  ) {
    for (const n of layerNames) this.stack.push(new FakeLayer(n, this));
  }

  get numLayers(): number {
    return this.stack.length;
  }

  /** AE's CompItem.layer() — 1-based. */
  layer(index: number): FakeLayer {
    return this.stack[index - 1];
  }

  get order(): string {
    return this.stack.map((l) => l.name).join(",");
  }
}

interface OpResult {
  ok: boolean;
  error?: string;
  fromIndex?: number;
  newIndex?: number;
  name?: string;
}

/**
 * Run an operation's generated JSX the way the dispatcher does — as a function
 * body over `(app, log, payload)` — with helpers.jsx loaded ahead of it, so the
 * shared preambles and `AE.findLayerInComp` are the real ones.
 */
function runOpJsx(jsx: string, comp: FakeComp): OpResult {
  const helpers = readFileSync(HELPERS_PATH, "utf8");
  const app = { project: { numItems: 1, item: (i: number) => (i === 1 ? comp : null) } };
  // helpers.jsx narrows project items with `instanceof CompItem`. FakeComp is
  // the comp class here, so handing it in under that name keeps the real check.
  const run = new Function("app", "log", "payload", "CompItem", `${helpers}\n${jsx}`) as (
    a: unknown,
    l: unknown,
    p: unknown,
    c: unknown,
  ) => OpResult;
  return run(app, () => {}, null, FakeComp);
}

function move(comp: FakeComp, layer: string, toIndex: unknown): OpResult {
  const jsx = getOp("layer.move")!.toJsx({ comp: comp.name, layer, toIndex });
  return runOpJsx(jsx, comp);
}

const STACK = ["L1", "L2", "L3", "L4", "L5"];

describe("layer.move", () => {
  it("never calls the inherited moveTo, which always throws for a layer", () => {
    const jsx = getOp("layer.move")!.toJsx({ comp: "Main", layer: 1, toIndex: 2 });
    // Comments stripped: the emitted code explains why moveTo is wrong, and
    // that explanation must not be what satisfies this assertion.
    const code = jsx.replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/\.\s*moveTo\s*\(/);
    expect(code).toMatch(/\.\s*moveBefore\s*\(/);
    expect(code).toMatch(/\.\s*moveAfter\s*\(/);
  });

  // Every expectation here was produced by AE 26.3x87 for the same input.
  it.each([
    { layer: "L5", to: 2, order: "L1,L5,L2,L3,L4" },
    { layer: "L1", to: 4, order: "L2,L3,L4,L1,L5" },
    { layer: "L2", to: 1, order: "L2,L1,L3,L4,L5" },
    { layer: "L2", to: 5, order: "L1,L3,L4,L5,L2" },
    { layer: "L4", to: 2, order: "L1,L4,L2,L3,L5" },
    { layer: "L3", to: 3, order: "L1,L2,L3,L4,L5" },
  ])("puts $layer at index $to", ({ layer, to, order }) => {
    const comp = new FakeComp("Main", STACK);
    const res = move(comp, layer, to);
    expect(res.ok).toBe(true);
    // The whole point: it lands AT the index asked for, in both directions.
    expect(res.newIndex).toBe(to);
    expect(comp.order).toBe(order);
    expect(comp.layer(to).name).toBe(layer);
  });

  it("reports where the layer came from", () => {
    const comp = new FakeComp("Main", STACK);
    expect(move(comp, "L4", 2)).toMatchObject({ ok: true, fromIndex: 4, newIndex: 2, name: "L4" });
  });

  it.each([0, -1, 6, 99])("refuses out-of-range toIndex %i without reordering", (to) => {
    const comp = new FakeComp("Main", STACK);
    const res = move(comp, "L3", to);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/out of range \(comp has 5 layers\)/);
    expect(comp.order).toBe(STACK.join(","));
  });

  it("refuses a fractional toIndex, which AE rejects at the API boundary", () => {
    const comp = new FakeComp("Main", STACK);
    const res = move(comp, "L3", 2.5);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/whole number/);
    expect(comp.order).toBe(STACK.join(","));
  });

  it("still reports an unknown layer through the shared preamble", () => {
    const comp = new FakeComp("Main", STACK);
    const res = move(comp, "nope", 2);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no layer matching nope/);
  });
});
