// The `instance` argument every AE-touching tool carries: declared once in
// tools/index.ts, stripped before the tool's own handler runs, and turned
// into a transport bound to that instance. Offline — the null transport
// records what reached it.

import { describe, expect, it } from "vitest";

import "../src/operations/index.js";
import { ALL_TOOLS, bindTransportToInstance } from "../src/tools/index.js";
import { nullTransport } from "./helpers/null-transport.js";

function tool(name: string) {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe("instance argument", () => {
  it("is declared on every tool that talks to After Effects, and only those", () => {
    for (const t of ALL_TOOLS) {
      const declared = "instance" in t.inputShape;
      expect(declared, `${t.name} instance param`).toBe(t.name !== "ae_catalog");
    }
  });

  it("binds the transport to the named instance and hides the argument from the tool", async () => {
    const transport = nullTransport({ result: { project: {}, items: [] } });
    const res = await tool("ae_project_info").handler({ instance: " w1 " }, transport);
    expect(res.isError).toBeFalsy();
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].instance).toBe("w1");
    expect(transport.calls[0].label).toBe("project_info");
  });

  it("leaves the transport's own default in place when omitted", async () => {
    const transport = nullTransport({ result: { project: {}, items: [] } });
    await tool("ae_project_info").handler({}, transport);
    expect(transport.calls[0].instance).toBeUndefined();
  });

  it("carries through ae_do without leaking into the operation's arguments", async () => {
    // batch.run with no children is the smallest operation that reaches the
    // transport; an unknown key in `args` would have been rejected before it.
    const transport = nullTransport({
      result: { result: { ok: true, results: [], failed: 0 }, context: {} },
    });
    const res = await tool("ae_do").handler(
      { operation: "batch.run", args: { ops: [] }, instance: "w2" },
      transport,
    );
    expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
    expect(transport.calls[0].instance).toBe("w2");
  });

  it("lets a call through a bound transport still name another instance", async () => {
    // instance.start, bound to the main instance by the tool's `instance`
    // argument, opens the project in the NEW instance: a request's own
    // instance must win over the binding.
    const transport = nullTransport({ result: { ok: true } });
    const bound = bindTransportToInstance(transport, "bound");
    await bound.execute({ code: "return 1;", instance: "explicit" });
    await bound.execute({ code: "return 1;" });
    expect(transport.calls.map((c) => c.instance)).toEqual(["explicit", "bound"]);
    expect((await bound.describeTarget!()).mode).not.toBe("push");
  });
});
