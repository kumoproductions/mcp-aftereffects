// The instance.* operations and project.merge, offline: argument checks,
// the refusals that must happen before anything is launched or copied, and
// the generated ExtendScript. Starting a real instance is the e2e suite's job.

import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HEARTBEAT_FILENAME, RUNTIME_DIR, instanceDirFor } from "../src/config.js";
import "../src/operations/index.js";
import { getOp } from "../src/registry.js";
import { nullTransport } from "./helpers/null-transport.js";

interface OpFailure {
  ok: false;
  error: string;
  errorCode?: string;
  hint?: string;
}

async function run<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const op = getOp(name);
  if (!op?.run) throw new Error(`${name} is not a Node-side operation`);
  return (await op.run(args, nullTransport())) as T;
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-instance-ops-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("instance.* are Node-side", () => {
  it("are registered with run() and refuse to be inlined into batch.run", () => {
    for (const name of ["instance.list", "instance.start", "instance.stop"]) {
      const op = getOp(name)!;
      expect(typeof op.run).toBe("function");
      expect(op.toJsx({})).toContain("Node side");
    }
    const batch = getOp("batch.run")!.toJsx({
      ops: [{ operation: "instance.list", args: {} }],
    });
    expect(batch).toContain("Node side");
  });

  it("instance.list reports what is on disk and no target for a transport without one", async () => {
    const res = await run("instance.list", {});
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.instances)).toBe(true);
    expect(Array.isArray(res.live)).toBe(true);
    expect(res.target).toBeNull();
  });
});

describe("instance.start refusals (nothing launched)", () => {
  it("rejects an unusable name", async () => {
    const res = await run<OpFailure>("instance.start", { name: "!!!" });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("INVALID_ARGS");
  });

  it("rejects project together with copyFrom", async () => {
    const res = await run<OpFailure>("instance.start", {
      name: "w1",
      project: "a.aep",
      copyFrom: "b.aep",
    });
    expect(res.errorCode).toBe("INVALID_ARGS");
  });

  it("rejects a missing project or copyFrom before looking at the environment", async () => {
    const missing = path.join(tmp, "missing.aep");
    const asProject = await run<OpFailure>("instance.start", { name: "w1", project: missing });
    expect(asProject.errorCode).toBe("IO");
    expect(asProject.error).toContain("project not found");
    const asCopy = await run<OpFailure>("instance.start", { name: "w1", copyFrom: missing });
    expect(asCopy.errorCode).toBe("IO");
    expect(asCopy.error).toContain("copyFrom not found");
  });

  it("refuses a copyTo inside the mailbox, like every other output path", async () => {
    const source = path.join(tmp, "main.aep");
    await fs.writeFile(source, "not really an aep", "utf8");
    const planted = path.join(RUNTIME_DIR, "request-planted.json");
    const res = await run<OpFailure>("instance.start", {
      name: "w1",
      copyFrom: source,
      copyTo: planted,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("IO");
    expect(res.error).toContain("IPC mailbox");
    await expect(fs.access(planted)).rejects.toThrow();
  });

  it("refuses a name that is already live, without copying anything", async () => {
    const name = `t-clash-${randomUUID().slice(0, 6)}`;
    const dir = instanceDirFor(name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, HEARTBEAT_FILENAME),
      JSON.stringify({ id: name, project: null, projectName: null, busy: false, ts: Date.now() }),
      "utf8",
    );
    const source = path.join(tmp, "main.aep");
    await fs.writeFile(source, "not really an aep", "utf8");
    try {
      const res = await run<OpFailure>("instance.start", { name, copyFrom: source });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("already live");
      await expect(fs.access(path.join(tmp, `main__${name}.aep`))).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("instance.stop", () => {
  it("refuses an instance that is not live", async () => {
    const res = await run<OpFailure>("instance.stop", {
      name: `t-nope-${randomUUID().slice(0, 6)}`,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("NO_INSTANCE");
    expect(res.error).toContain("not live");
  });
});

describe("project.merge", () => {
  it("imports the .aep as a folder, diffs the item list, and embeds arguments safely", () => {
    const jsx = getOp("project.merge")!.toJsx({
      path: "C:/work/shot__w1.aep",
      folderName: 'from "w1"',
      parentFolder: "Incoming",
    });
    expect(jsx).toContain("new ImportOptions(_f)");
    expect(jsx).toContain("app.project.importFile");
    expect(jsx).toContain('"C:/work/shot__w1.aep"');
    expect(jsx).toContain('"from \\"w1\\""');
    expect(jsx).toContain("AE.findFolder");
    // Nothing already in the project is touched: only items absent from the
    // pre-import snapshot are reported.
    expect(jsx).toContain("_before[_it.id]");
  });

  it("is a project mutation (not available read-only)", () => {
    expect(getOp("project.merge")!.readOnly).toBeFalsy();
  });
});
