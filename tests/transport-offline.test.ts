// Transport behaviour that needs no After Effects: the per-id mailbox, the
// timeout path, and the spawn-failure path. AfterFX.exe is replaced with a
// stand-in that can never answer, so these run identically on a machine
// without AE installed.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BUSY_LOCK_PATH,
  BUSY_LOCK_STALE_MS,
  DEFAULT_RUNTIME_DIR,
  REQUEST_PREFIX,
  RESPONSE_PREFIX,
  RUNTIME_DIR,
  requestPathFor,
  responsePathFor,
} from "../src/config.js";
import { FileIpcTransport } from "../src/transport/FileIpcTransport.js";

/**
 * An executable that exists and starts, but will never write a response.
 *
 * Per-platform because `resolveAfterFxPath` stats it: a Windows-only path made
 * every timeout and busy-lock test fail with AE_NOT_FOUND on Linux CI, before
 * the behaviour under test could run at all.
 */
const INERT_EXE = process.platform === "win32" ? "C:/Windows/System32/cmd.exe" : "/bin/true";

const savedExe = process.env.AE_MCP_EXE;

afterEach(() => {
  if (savedExe === undefined) delete process.env.AE_MCP_EXE;
  else process.env.AE_MCP_EXE = savedExe;
});

async function mailboxEntries(prefix: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(RUNTIME_DIR);
    return entries.filter((e) => e.startsWith(prefix) && e.endsWith(".json"));
  } catch {
    return [];
  }
}

describe("mailbox location", () => {
  it("defaults to a machine-wide directory under the OS temp dir, not the package", () => {
    // The package directory is routinely read-only (global npm install, npx
    // cache, Program Files); writing the mailbox there used to crash startup.
    expect(DEFAULT_RUNTIME_DIR.startsWith(os.tmpdir())).toBe(true);
    expect(RUNTIME_DIR).toBe(DEFAULT_RUNTIME_DIR);
  });

  it("names every request and response after its own id", () => {
    const a = "11111111-2222-3333-4444-555555555555";
    const b = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(path.basename(requestPathFor(a))).toBe(`${REQUEST_PREFIX}${a}.json`);
    expect(path.basename(responsePathFor(b))).toBe(`${RESPONSE_PREFIX}${b}.json`);
    // Two in-flight calls can never collide on a filename — that is what makes
    // a second MCP client safe against the first.
    expect(requestPathFor(a)).not.toBe(requestPathFor(b));
  });

  it("honours AE_MCP_RUNTIME_DIR", async () => {
    const custom = path.join(os.tmpdir(), "mcp-ae-test-runtime");
    process.env.AE_MCP_RUNTIME_DIR = custom;
    try {
      vi.resetModules();
      const mod = await import("../src/config.js");
      expect(mod.RUNTIME_DIR).toBe(path.resolve(custom));
      expect(mod.RUNTIME_DIR_IS_CUSTOM).toBe(true);
    } finally {
      delete process.env.AE_MCP_RUNTIME_DIR;
      vi.resetModules();
    }
  });
});

describe("timeout", () => {
  let transport: FileIpcTransport;

  beforeEach(() => {
    process.env.AE_MCP_EXE = INERT_EXE;
    transport = new FileIpcTransport();
  });

  it("returns TIMEOUT and reclaims the unconsumed request", async () => {
    const before = await mailboxEntries(REQUEST_PREFIX);
    const res = await transport.execute({
      code: "return 1;",
      label: "offline_timeout",
      timeoutMs: 400,
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("TIMEOUT");
    // A request nobody picked up must not survive the call: leaving it behind
    // is how a "failed" mutation used to get executed minutes later by an
    // unrelated spawn.
    expect(res.error).toContain("never picked up");

    const after = await mailboxEntries(REQUEST_PREFIX);
    expect(after).toEqual(before);
    // The busy lock must not survive either — the request was reclaimed, so
    // nothing of ours can still be running inside AE.
    await expect(fs.access(BUSY_LOCK_PATH)).rejects.toThrow();
  });

  it("leaves no response file behind either", async () => {
    const before = await mailboxEntries(RESPONSE_PREFIX);
    await transport.execute({ code: "return 1;", label: "offline_timeout2", timeoutMs: 300 });
    expect(await mailboxEntries(RESPONSE_PREFIX)).toEqual(before);
  });
});

describe("busy lock", () => {
  beforeEach(() => {
    process.env.AE_MCP_EXE = INERT_EXE;
  });

  afterEach(async () => {
    try {
      await fs.unlink(BUSY_LOCK_PATH);
    } catch {
      /* already gone */
    }
  });

  it("waits for a fresh foreign lock and reports the busy timeout without dispatching", async () => {
    // Another server process is mid-call: its lock is fresh. We must not spawn
    // into AE (that is exactly the "second script" modal), just wait and time out.
    await fs.writeFile(BUSY_LOCK_PATH, JSON.stringify({ pid: 0, id: "foreign" }), "utf8");
    const before = await mailboxEntries(REQUEST_PREFIX);

    const transport = new FileIpcTransport();
    const res = await transport.execute({
      code: "return 1;",
      label: "offline_busy",
      timeoutMs: 500,
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("TIMEOUT");
    expect(res.error).toContain("busy lock");
    // The request must be reclaimed, and the FOREIGN lock must be left alone.
    expect(await mailboxEntries(REQUEST_PREFIX)).toEqual(before);
    await expect(fs.access(BUSY_LOCK_PATH)).resolves.toBeUndefined();
  });

  it("breaks a stale lock and proceeds with the call", async () => {
    await fs.writeFile(BUSY_LOCK_PATH, JSON.stringify({ pid: 0, id: "orphan" }), "utf8");
    const expired = new Date(Date.now() - BUSY_LOCK_STALE_MS - 60_000);
    await fs.utimes(BUSY_LOCK_PATH, expired, expired);

    const transport = new FileIpcTransport();
    const res = await transport.execute({
      code: "return 1;",
      label: "offline_stale_lock",
      timeoutMs: 400,
    });

    // The stale lock did not block the call: it went through the normal
    // dispatch path (and timed out only because the stand-in exe never answers).
    expect(res.errorCode).toBe("TIMEOUT");
    expect(res.error).toContain("never picked up");
    // Our own lock is released on the way out.
    await expect(fs.access(BUSY_LOCK_PATH)).rejects.toThrow();
  });

  it("leaves a lock it no longer owns alone on the way out", async () => {
    // A call whose event loop stalls past the stale threshold — a laptop
    // suspend is enough, since staleness is wall-clock — has its lock broken
    // and retaken by a waiter. Releasing must not delete the successor's lock,
    // or a third caller gets a dispatch slot while the second is still driving
    // AE: the collision the lock exists to prevent.
    const transport = new FileIpcTransport();
    const call = transport.execute({
      code: "return 1;",
      label: "offline_lock_stolen",
      timeoutMs: 600,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    await fs.writeFile(BUSY_LOCK_PATH, JSON.stringify({ pid: 0, id: "successor" }), "utf8");

    const res = await call;
    expect(res.ok).toBe(false);

    const held = JSON.parse(await fs.readFile(BUSY_LOCK_PATH, "utf8")) as { id?: string };
    expect(held.id).toBe("successor");
  });

  it("relaunches the dispatcher while the request stays unconsumed", async () => {
    // AE refusing our script (its "second script" warning) leaves the request
    // file unconsumed — the transport must try again rather than wait out the
    // whole timeout on a launch that already died.
    const transport = new FileIpcTransport();
    const res = await transport.execute({
      code: "return 1;",
      label: "offline_relaunch",
      timeoutMs: 6_000,
    });

    expect(res.errorCode).toBe("TIMEOUT");
    expect(res.error).toMatch(/after 2 launch attempts/);
  }, 15_000);
});

describe("spawn failure", () => {
  it("fails fast instead of burning the full timeout", async () => {
    // A file that exists but cannot be executed: spawn emits 'error', which
    // used to be swallowed — every such call waited out the whole timeout.
    const notAnExe = path.join(os.tmpdir(), "mcp-ae-not-an-exe.txt");
    await fs.writeFile(notAnExe, "not a program", "utf8");
    process.env.AE_MCP_EXE = notAnExe;

    const transport = new FileIpcTransport();
    const before = await mailboxEntries(REQUEST_PREFIX);
    const started = Date.now();
    const res = await transport.execute({
      code: "return 1;",
      label: "offline_spawn_fail",
      timeoutMs: 30_000,
    });
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("TRANSPORT");
    expect(res.error).toContain("could not launch After Effects");
    expect(elapsed).toBeLessThan(10_000);
    // The mailbox is machine-wide, so compare the delta rather than demanding
    // an empty directory — another client may legitimately have mail pending.
    expect(await mailboxEntries(REQUEST_PREFIX)).toEqual(before);
  });
});
