// The one exception to "every call is ONE undo group": undo and redo.
//
// AE resolves Undo/Redo against the group that is still open, so running
// `app.executeCommand(16)` between beginUndoGroup and endUndoGroup reverts
// nothing the caller asked for — the previous call survives — and the group
// that closes afterwards leaves the undo stack describing a step that never
// happened. These assert the opt-out survives every hop it has to cross:
// operation declaration → ae_do → the request the dispatcher reads → the
// dispatcher's own branch. batch.run is the fourth case: it IS one undo group,
// so an undo child has no way to get what it needs and is refused instead.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getOp, wantsDialogSuppression, wantsUndoGroup } from "../src/registry.js";
import { doTool } from "../src/tools/do.js";
import "../src/operations/index.js";
import { nullTransport } from "./helpers/null-transport.js";

const DISPATCHER = readFileSync(
  fileURLToPath(new URL("../jsx/dispatcher.jsx", import.meta.url)),
  "utf8",
);

/** ae_do unwraps `{ result, context }`, so the canned answer must have both. */
const OK_RESPONSE = { result: { result: { ok: true }, context: {} } };

describe("operations that drive the undo stack", () => {
  it("project.undo declares that it runs outside the group", () => {
    expect(wantsUndoGroup(getOp("project.undo")!, { count: 1 })).toBe(false);
  });

  it("command.execute opts out for Undo (16) and Redo (2035), and only those", () => {
    const op = getOp("command.execute")!;
    expect(wantsUndoGroup(op, { id: 16 })).toBe(false);
    expect(wantsUndoGroup(op, { id: 2035 })).toBe(false);
    // Deselect All — an ordinary menu command, still one Ctrl+Z per call.
    expect(wantsUndoGroup(op, { id: 2040 })).toBe(true);
  });

  it("leaves every other operation grouped", () => {
    // eval.run is deliberately absent: it only registers under
    // AE_MCP_ENABLE_EVAL, so asserting on it here would test the policy switch.
    for (const name of ["layer.create_null", "keyframe.add", "batch.run", "project.purge"]) {
      expect(wantsUndoGroup(getOp(name)!, {}), name).toBe(true);
    }
  });
});

describe("ae_do", () => {
  it("sends undoGroup:false for project.undo", async () => {
    const transport = nullTransport(OK_RESPONSE);
    await doTool.handler({ operation: "project.undo", args: { count: 2 } }, transport);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].undoGroup).toBe(false);
  });

  it("sends undoGroup:false for command.execute(16) but keeps the group otherwise", async () => {
    const undo = nullTransport(OK_RESPONSE);
    await doTool.handler({ operation: "command.execute", args: { id: 16 } }, undo);
    expect(undo.calls[0].undoGroup).toBe(false);

    const deselect = nullTransport(OK_RESPONSE);
    await doTool.handler({ operation: "command.execute", args: { id: 2040 } }, deselect);
    expect(deselect.calls[0].undoGroup).toBe(true);
  });

  it("keeps the group for a mutation", async () => {
    const transport = nullTransport(OK_RESPONSE);
    await doTool.handler({ operation: "layer.create_null", args: { comp: "Main" } }, transport);
    expect(transport.calls[0].undoGroup).toBe(true);
  });
});

describe("dialog suppression", () => {
  it("only undo/redo opt out; project boundary ops keep suppression", () => {
    expect(wantsDialogSuppression(getOp("project.undo")!, {})).toBe(false);
    const cmd = getOp("command.execute")!;
    expect(wantsDialogSuppression(cmd, { id: 16 })).toBe(false);
    expect(wantsDialogSuppression(cmd, { id: 2035 })).toBe(false);
    expect(wantsDialogSuppression(cmd, { id: 2040 })).toBe(true);
    // project.open / project.new run ungrouped, but they are the calls most
    // likely to pop a modal (missing footage/fonts) — they stay suppressed.
    for (const name of ["project.open", "project.new", "layer.create_null"]) {
      expect(wantsDialogSuppression(getOp(name)!, {}), name).toBe(true);
    }
  });

  it("ae_do sends undoGroup:false but suppressDialogs:true for project.open", async () => {
    const transport = nullTransport(OK_RESPONSE);
    await doTool.handler(
      { operation: "project.open", args: { path: "C:/missing.aep" } },
      transport,
    );
    expect(transport.calls[0].undoGroup).toBe(false);
    expect(transport.calls[0].suppressDialogs).toBe(true);
  });

  it("ae_do sends suppressDialogs:false for undo", async () => {
    const transport = nullTransport(OK_RESPONSE);
    await doTool.handler({ operation: "project.undo", args: {} }, transport);
    expect(transport.calls[0].suppressDialogs).toBe(false);
  });
});

describe("batch.run", () => {
  it("refuses an undo child rather than running it inside the batch's group", () => {
    const jsx = getOp("batch.run")!.toJsx({
      ops: [
        { operation: "layer.create_null", args: { comp: "Main" } },
        { operation: "project.undo", args: {} },
      ],
    });
    expect(jsx).toContain("cannot run inside batch.run");
    expect(jsx).not.toContain("executeCommand(16)");
    // The refusal is per child: the sibling mutation still runs.
    expect(jsx).toContain("addNull");
  });

  it("refuses command.execute(16) but not an ordinary menu command", () => {
    const undo = getOp("batch.run")!.toJsx({
      ops: [{ operation: "command.execute", args: { id: 2035 } }],
    });
    expect(undo).toContain("cannot run inside batch.run");
    expect(undo).not.toContain("executeCommand(2035)");

    const deselect = getOp("batch.run")!.toJsx({
      ops: [{ operation: "command.execute", args: { id: 2040 } }],
    });
    expect(deselect).toContain("executeCommand(2040)");
  });
});

describe("dispatcher", () => {
  it("opens an undo group only when the request asks for one", () => {
    expect(DISPATCHER).toContain("request.undoGroup !== false");
    // One call site, and it sits inside the guard — an unguarded second one
    // would silently re-group undo/redo. Match "inside the if-block"
    // structurally: braces must stay balanced-open between guard and call.
    expect(DISPATCHER.match(/app\.beginUndoGroup\(/g)).toHaveLength(1);
    const guardBlock = /if \(wantUndoGroup\) \{([\s\S]*?)app\.beginUndoGroup\(/.exec(DISPATCHER);
    expect(guardBlock, "beginUndoGroup must come after the wantUndoGroup guard").toBeTruthy();
    const between = guardBlock?.[1] ?? "";
    const opens = (between.match(/\{/g) ?? []).length;
    const closes = (between.match(/\}/g) ?? []).length;
    expect(
      opens,
      "the wantUndoGroup block must still be open at beginUndoGroup",
    ).toBeGreaterThanOrEqual(closes);
  });

  it("decides dialog suppression separately from the undo group", () => {
    // beginSuppressDialogs opens an undo-transaction-like scope of its own:
    // wrapping the bare undo/redo requests in it makes AE resolve Undo against
    // that scope (nothing reverts, async "UndoGroup Mismatch" dialogs). But
    // project boundary requests (project.open / project.new) run ungrouped AND
    // suppressed — they are the calls most likely to pop a modal — so the
    // decision is its own request field, not the undo-group condition.
    expect(DISPATCHER.match(/app\.beginSuppressDialogs\(\)/g)).toHaveLength(1);
    const guard = /if \(wantSuppress\) \{([\s\S]*?)app\.beginSuppressDialogs\(\)/.exec(DISPATCHER);
    expect(guard, "beginSuppressDialogs must sit behind the wantSuppress guard").toBeTruthy();
    // A request without the field falls back to the old contract (suppress
    // exactly when grouping), so an old server cannot break undo/redo.
    expect(DISPATCHER).toContain('typeof request.suppressDialogs === "boolean"');
    // And it must always be released, without replaying the queued alerts.
    expect(DISPATCHER).toContain("endSuppressDialogs(false)");
  });

  it("closes the group only when it opened one", () => {
    // endUndoGroup is gated on `undoOpen`, which is set inside the same guard —
    // closing a group nobody opened is how an unbalanced stack starts.
    expect(/if \(undoOpen\) \{[\s\S]*?app\.endUndoGroup\(\)/.test(DISPATCHER)).toBe(true);
  });
});
