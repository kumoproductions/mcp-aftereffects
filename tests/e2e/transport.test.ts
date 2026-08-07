// Transport-level round-trip tests against a real After Effects instance.
// Read-only with respect to the user's project — nothing here mutates AE
// state, so these run whenever AE is reachable (no env-var opt-in needed).
// Skips itself (loudly) when AE isn't running — see harness.probeAe().

import { beforeAll, describe, expect, it } from "vitest";

import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import { probeAe } from "./harness.js";

let ready = false;
let transport: FileIpcTransport | null = null;

describe("e2e transport", () => {
  beforeAll(async () => {
    const probe = await probeAe("transport");
    ready = probe.ready;
    transport = probe.transport ?? null;
  });

  it("smoke: trivial round trip returns result and logs", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const res = await transport.execute({
      code: "return { answer: 42, version: app.version, numItems: app.project.numItems };",
      label: "smoke",
      timeoutMs: 30_000,
    });
    expect(res.ok, `expected ok, got error: ${res.error}`).toBe(true);
    const r = res.result as { answer: number; version: string; numItems: number };
    expect(r.answer).toBe(42);
    expect(typeof r.version).toBe("string");
    expect(typeof r.numItems).toBe("number");
  });

  it("round trip: returns numeric result", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const res = await transport.execute({ code: "return 1 + 2 + 3;", label: "smoke_numeric" });
    expect(res.ok, `expected ok, got error: ${res.error}`).toBe(true);
    expect(res.result).toBe(6);
  });

  it("round trip: returns object with AE project metadata", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const res = await transport.execute({
      code: `
        return {
            numItems: app.project.numItems,
            hasFile: app.project.file != null,
            version: app.version
        };
      `,
      label: "smoke_project",
    });
    expect(res.ok, `expected ok, got: ${res.error}`).toBe(true);
    const r = res.result as { numItems: number; hasFile: boolean; version: string };
    expect(typeof r.numItems).toBe("number");
    expect(typeof r.version).toBe("string");
  });

  it("round trip: AE helpers are available", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const res = await transport.execute({
      code: `
        var proj = app.project;
        var summary = null;
        if (proj.numItems > 0) summary = AE.serializeItemSummary(proj.item(1));
        return { helperLoaded: typeof AE.serializeItemSummary === "function", summary: summary };
      `,
      label: "smoke_helpers",
    });
    expect(res.ok, `expected ok, got: ${res.error}`).toBe(true);
    const r = res.result as { helperLoaded: boolean };
    expect(r.helperLoaded).toBe(true);
  });

  it("error: syntax error in JSX returns error without hanging AE", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const res = await transport.execute({
      code: "this is not valid javascript $$$;",
      label: "smoke_syntax_err",
    });
    expect(res.ok, "expected error, got ok").toBe(false);
    expect(res.error).not.toBeNull();
  });

  it("error: runtime error is caught and reported", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const res = await transport.execute({
      code: "throw new Error('boom from test'); return 1;",
      label: "smoke_runtime_err",
    });
    expect(res.ok, "expected error, got ok").toBe(false);
    expect(res.error ?? "").toContain("boom from test");
  });

  it("log: breadcrumbs are surfaced in response.logs in order", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const res = await transport.execute({
      code: `
        log("step 1");
        log("step 2: " + app.project.numItems + " items");
        return "done";
      `,
      label: "smoke_logs",
    });
    expect(res.ok, `expected ok, got: ${res.error}`).toBe(true);
    expect(res.logs).toHaveLength(2);
    expect(res.logs[0]).toBe("step 1");
  });

  // NOTE: timeout & recovery tests live in timeout-recovery.test.ts — they
  // intentionally hang AE and require taskkill, so they must be run last,
  // standalone.
});
