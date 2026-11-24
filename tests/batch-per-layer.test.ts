// batch.run must count a child as failed when the child
// reports per layer (property.set, transform.set, layer ops with `layers`) and
// any layer result is ok: false, even though the child itself says ok: true.
// The generated JSX is plain ES3, so it runs here under a stub `AE`.

import { describe, expect, it } from "vitest";

import { getOp, registerOp } from "../src/registry.js";
import "../src/operations/index.js";

// Stand-ins for a per-layer child: one layer set, one refused (the shape
// property.set returns), and a fully good one.
registerOp({
  name: "test.partial",
  category: "test",
  description: "per-layer child with one failed layer",
  params: [],
  readOnly: true,
  toJsx: () =>
    `return { ok: true, count: 2, layers: [{ name: "A", ok: true }, { name: "B", ok: false, error: "refused" }] };`,
});
registerOp({
  name: "test.good",
  category: "test",
  description: "per-layer child, all layers fine",
  params: [],
  readOnly: true,
  toJsx: () => `return { ok: true, count: 1, layers: [{ name: "A", ok: true }] };`,
});

type BatchResult = {
  ok: boolean;
  failed: number;
  count: number;
  results: Array<{ skipped?: boolean; ok?: boolean }>;
};

function run(ops: Array<{ operation: string }>, stopOnError = false): BatchResult {
  const jsx = getOp("batch.run")!.toJsx({ ops: ops.map((o) => ({ ...o, args: {} })), stopOnError });
  const AE = { errText: (e: unknown) => String(e) };
  return new Function("AE", jsx)(AE) as BatchResult;
}

describe("batch.run with per-layer children", () => {
  it("counts a child with a failed layer as failed", () => {
    const r = run([{ operation: "test.good" }, { operation: "test.partial" }]);
    expect(r.failed).toBe(1);
    expect(r.ok).toBe(false);
  });

  it("stops on a failed layer when stopOnError is set", () => {
    const r = run([{ operation: "test.partial" }, { operation: "test.good" }], true);
    expect(r.failed).toBe(1);
    expect(r.results[1]).toEqual({ skipped: true });
  });

  it("still reports ok when every layer succeeded", () => {
    const r = run([{ operation: "test.good" }, { operation: "test.good" }]);
    expect(r).toMatchObject({ ok: true, failed: 0, count: 2 });
  });
});
