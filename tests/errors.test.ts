// The unified error envelope, and the failure layer that used to leak through
// it: an operation that RETURNS `{ ok: false }` ran fine as far as the
// transport is concerned, so "no comp matching Main" arrived as a success.

import { describe, expect, it } from "vitest";

import { errorEnvelope, errorResult, isRetryable } from "../src/errors.js";
import { jsxReportedFailure, toMcpResult } from "../src/tools/define-tool.js";
import { doTool } from "../src/tools/do.js";
import { renderFrameTool } from "../src/tools/render-frame.js";
import type { EvalResult } from "../src/transport/AeTransport.js";
import "../src/operations/index.js";
import { nullTransport } from "./helpers/null-transport.js";

function evalResult(over: Partial<EvalResult>): EvalResult {
  return {
    ok: true,
    result: null,
    error: null,
    errorCode: null,
    stack: null,
    logs: [],
    durationMs: 1,
    ...over,
  };
}

function structured(res: { structuredContent?: unknown }): {
  ok?: unknown;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
} {
  return (res.structuredContent ?? {}) as never;
}

describe("error envelope", () => {
  it("marks only transient classes retryable", () => {
    expect(isRetryable("TIMEOUT")).toBe(true);
    expect(isRetryable("TRANSPORT")).toBe(true);
    expect(isRetryable("INVALID_ARGS")).toBe(false);
    expect(isRetryable("AE_NOT_FOUND")).toBe(false);
    expect(isRetryable("FORBIDDEN")).toBe(false);
  });

  it("omits empty optional fields instead of emitting nulls", () => {
    const env = errorEnvelope("VALIDATION", "bad doc");
    expect(env).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "bad doc", retryable: false },
    });
  });

  it("puts the code in the human-readable text too", () => {
    const res = errorResult("TIMEOUT", "no answer", { hint: "start AE" });
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("[TIMEOUT] no answer");
    expect(text).toContain("hint: start AE");
  });
});

describe("jsxReportedFailure", () => {
  it("detects the { ok: false } convention and nothing else", () => {
    expect(jsxReportedFailure({ ok: false, error: "boom" })).toEqual({ error: "boom" });
    expect(jsxReportedFailure({ ok: false })).toEqual({
      error: "operation reported ok: false",
    });
    expect(jsxReportedFailure({ ok: true, error: "boom" })).toBeNull();
    expect(jsxReportedFailure({ found: false })).toBeNull();
    expect(jsxReportedFailure(null)).toBeNull();
    expect(jsxReportedFailure([{ ok: false }])).toBeNull();
  });
});

describe("toMcpResult", () => {
  it("maps a transport failure onto its error code", () => {
    const res = toMcpResult(
      evalResult({ ok: false, error: "gave up", errorCode: "TIMEOUT", durationMs: 60_000 }),
    );
    expect(res.isError).toBe(true);
    expect(structured(res).error).toMatchObject({ code: "TIMEOUT", retryable: true });
  });

  it("does NOT report a { ok: false } return as success", () => {
    const res = toMcpResult(evalResult({ result: { ok: false, error: "no comp matching Main" } }));
    expect(res.isError).toBe(true);
    expect(structured(res).error).toMatchObject({
      code: "OPERATION_FAILED",
      message: "no comp matching Main",
    });
  });

  it("passes a genuine success through with ok: true", () => {
    const res = toMcpResult(evalResult({ result: { ok: true, index: 3 } }));
    expect(res.isError).toBe(false);
    expect(structured(res).ok).toBe(true);
  });
});

describe("ae_render_frame", () => {
  it("reports a missing comp as an error rather than a successful render", async () => {
    // The JSX returns { ok: false, error } when the comp lookup fails; the
    // transport call itself succeeded, which is exactly the case that used to
    // slip through as isError: false.
    const transport = nullTransport({
      result: { ok: false, error: "no comp matching Nope" },
    });
    const res = await renderFrameTool.handler(
      { compNameOrId: "Nope", time: 0, outPath: "C:/tmp/x.png" },
      transport,
    );
    expect(res.isError).toBe(true);
    expect(structured(res).error).toMatchObject({ code: "OPERATION_FAILED" });
  });
});

describe("ae_do failure propagation", () => {
  it("reports an operation-level failure with its own message", async () => {
    const transport = nullTransport({
      result: { result: { ok: false, error: "no layer at index 9" }, context: {} },
    });
    const res = await doTool.handler(
      {
        operation: "keyframe.remove",
        args: { comp: "Main", layer: 9, property: ["x"], keyIndex: 1 },
      },
      transport,
    );
    expect(res.isError).toBe(true);
    expect(structured(res).error).toMatchObject({
      code: "OPERATION_FAILED",
      message: "keyframe.remove: no layer at index 9",
    });
  });

  it("fails a batch whose children failed, instead of reporting ok", async () => {
    const transport = nullTransport({
      result: {
        result: {
          ok: false,
          error: "2 of 3 operations failed",
          results: [{ ok: true }, { ok: false, error: "a" }, { ok: false, error: "b" }],
          count: 3,
          failed: 2,
        },
        context: {},
      },
    });
    const res = await doTool.handler({ operation: "batch.run", args: { ops: [] } }, transport);
    expect(res.isError).toBe(true);
    const err = structured(res).error!;
    expect(err.code).toBe("OPERATION_FAILED");
    expect(err.message).toContain("2 of 3 operations failed");
    expect(err.details?.result).toMatchObject({ failed: 2 });
  });

  it("passes a clean batch through as success", async () => {
    const transport = nullTransport({
      result: {
        result: { ok: true, results: [{ ok: true }], count: 1, failed: 0 },
        context: {},
      },
    });
    const res = await doTool.handler({ operation: "batch.run", args: { ops: [] } }, transport);
    expect(res.isError).toBe(false);
    expect(structured(res).ok).toBe(true);
  });
});
