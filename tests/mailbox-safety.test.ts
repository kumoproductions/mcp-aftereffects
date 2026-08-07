// The mailbox is the transport's trust boundary: dispatcher.jsx executes the
// `code` of any request it finds there, with no signature to check and no
// access to the capability policy. These tests pin the two properties that
// keep that boundary meaningful — nothing we control writes into it, and a
// mailbox anyone can write to is reported rather than used silently.

import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  RUNTIME_DIR,
  rejectedOutputPath,
  uncheckedMailboxAclWarning,
  unsafePointerDirWarning,
  unsafeRuntimeDirWarning,
} from "../src/config.js";
import { getOp } from "../src/registry.js";
import { projectExportTool } from "../src/tools/project-export.js";
import { renderFrameTool } from "../src/tools/render-frame.js";
import "../src/operations/index.js";
import { nullTransport } from "./helpers/null-transport.js";

function errorCode(res: { structuredContent?: unknown }): string | undefined {
  const structured = (res.structuredContent ?? {}) as { error?: { code?: string } };
  return structured.error?.code;
}

describe("output paths cannot target the mailbox", () => {
  const inside = path.join(RUNTIME_DIR, "request-planted.json");

  it("ae_render_frame refuses, without contacting AE", async () => {
    const transport = nullTransport();
    const res = await renderFrameTool.handler(
      { compNameOrId: "Main", time: 0, outPath: inside },
      transport,
    );
    expect(res.isError).toBe(true);
    expect(errorCode(res)).toBe("IO");
    expect(transport.calls).toHaveLength(0);
  });

  it("ae_project_export_json refuses, without contacting AE", async () => {
    const transport = nullTransport();
    const res = await projectExportTool.handler({ outPath: inside }, transport);
    expect(res.isError).toBe(true);
    expect(errorCode(res)).toBe("IO");
    expect(transport.calls).toHaveLength(0);
  });

  it("the render.frame operation refuses too — batching is not a way around it", () => {
    const jsx = getOp("render.frame")!.toJsx({ comp: "Main", time: 0, outPath: inside });
    expect(jsx).toContain("IPC mailbox");
    expect(jsx).not.toContain("saveFrameToPng");
  });

  it("still allows ordinary paths", async () => {
    const transport = nullTransport();
    const outside = path.join(os.tmpdir(), "mcp-ae-check.png");
    const res = await renderFrameTool.handler(
      { compNameOrId: "Main", time: 0, outPath: outside },
      transport,
    );
    expect(errorCode(res)).toBeUndefined();
    expect(transport.calls).toHaveLength(1);
  });

  it("is not fooled by traversal back into the mailbox", () => {
    const traversal = path.join(RUNTIME_DIR, "..", "runtime", "request-x.json");
    expect(rejectedOutputPath(traversal)).not.toBeNull();
  });
});

describe("mailbox permission check", () => {
  it("passes a private directory", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-perm-"));
    try {
      chmodSync(dir, 0o700);
      expect(unsafeRuntimeDirWarning(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("flags a world-writable directory", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-perm-"));
    try {
      chmodSync(dir, 0o777);
      const warning = unsafeRuntimeDirWarning(dir);
      expect(warning).toContain("world-writable");
      expect(warning).toContain("chmod 700");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says nothing about a directory that does not exist", () => {
    expect(unsafeRuntimeDirWarning(path.join(os.tmpdir(), "mcp-ae-absent-xyz"))).toBeNull();
  });
});

// The pointer directory is the same boundary one level up: dispatcher.jsx reads
// runtime-dir.txt from it and searches the directory it names FIRST, so writing
// there redirects After Effects at a mailbox of the writer's choosing — a
// private mailbox does not help.
describe("pointer directory permission check", () => {
  it("passes a private directory", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-ptr-"));
    try {
      chmodSync(dir, 0o700);
      expect(unsafePointerDirWarning(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("flags a world-writable directory", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-ptr-"));
    try {
      chmodSync(dir, 0o777);
      const warning = unsafePointerDirWarning(dir);
      expect(warning).toContain("world-writable");
      expect(warning).toContain("runtime-dir.txt");
      expect(warning).toContain("chmod 700");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says nothing about a directory that does not exist", () => {
    expect(unsafePointerDirWarning(path.join(os.tmpdir(), "mcp-ae-absent-xyz"))).toBeNull();
  });
});

// Windows carries the private-mailbox property in the %TEMP% ACL, which Node
// cannot read — so the mode checks above return null there and print nothing.
// For the default mailbox that silence is correct; for a custom one it would
// read as "checked, and fine", which is the case this warning covers.
describe("unverified Windows ACL", () => {
  it("says nothing about the default mailbox", () => {
    expect(uncheckedMailboxAclWarning("win32")).toBeNull();
    expect(uncheckedMailboxAclWarning("darwin")).toBeNull();
  });

  it("flags a custom mailbox on Windows only", async () => {
    process.env.AE_MCP_RUNTIME_DIR = path.join(os.tmpdir(), "mcp-ae-test-acl");
    try {
      vi.resetModules();
      const mod = await import("../src/config.js");
      const warning = mod.uncheckedMailboxAclWarning("win32");
      expect(warning).toContain("AE_MCP_RUNTIME_DIR");
      expect(warning).toContain("not verified");
      // POSIX has the mode check, so it says nothing extra there.
      expect(mod.uncheckedMailboxAclWarning("darwin")).toBeNull();
      expect(mod.uncheckedMailboxAclWarning("linux")).toBeNull();
    } finally {
      delete process.env.AE_MCP_RUNTIME_DIR;
      vi.resetModules();
    }
  });
});
