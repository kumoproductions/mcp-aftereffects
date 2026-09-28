// Parallel work across several After Effects instances, end to end: start a
// "main" instance and a worker, give the worker a COPY of main's project,
// edit in both at once, save the worker's copy, merge it back into main, and
// shut both down. Every step goes through the public surface — ae_do with
// `instance`, ae_save_project, ae_context — exactly as a session would.
//
// Opt-in with AE_MCP_E2E_MULTI=1: it launches two After Effects processes
// (`AfterFX.exe -m`) and quits them again, and needs the resident agent
// installed for the After Effects version in use
// (`node dist/index.js install-agent`). Windows only for now — the macOS
// launch plan (`open -n --env`) is unverified.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agentInstallStatus } from "../../src/agent-install.js";
import "../../src/operations/index.js";
import { ALL_TOOLS, type AnyTool } from "../../src/tools/index.js";
import { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import { listInstances } from "../../src/transport/instances.js";
import { E2E_SCRATCH_DIR, printSkipBanner } from "./harness.js";

const MAIN = "e2e-main";
const WORKER = "e2e-w1";
const START_TIMEOUT = 180_000;

let ready = false;
let transport: FileIpcTransport;
let aeDo: AnyTool;
let saveProject: AnyTool;
let context: AnyTool;
let mainProject: string;
let workerProject: string | null = null;
const pids: Record<string, number | null> = {};

function toolNamed(name: string): AnyTool {
  return ALL_TOOLS.find((t) => t.name === name)!;
}

/** ae_do through the public tool surface; throws on a coded error. */
async function call(
  operation: string,
  args: Record<string, unknown>,
  instance: string,
): Promise<Record<string, unknown>> {
  const res = await aeDo.handler({ operation, args, instance, timeoutMs: 120_000 }, transport);
  const payload = res.structuredContent as {
    result?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
  if (res.isError)
    throw new Error(
      `${operation} (${instance}): [${payload.error?.code}] ${payload.error?.message}`,
    );
  return payload.result ?? {};
}

async function contextOf(instance: string): Promise<Record<string, unknown>> {
  const res = await context.handler({ instance }, transport);
  const payload = res.structuredContent as {
    result?: Record<string, unknown>;
    error?: { message: string };
  };
  if (res.isError) throw new Error(`ae_context (${instance}): ${payload.error?.message}`);
  return payload.result ?? {};
}

/** Windows paths come back with either separator and any case; compare by meaning. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

async function liveIds(): Promise<string[]> {
  return (await listInstances()).filter((i) => i.alive).map((i) => i.id);
}

describe("e2e multi-instance", () => {
  beforeAll(async () => {
    if (process.env.AE_MCP_E2E_MULTI !== "1") {
      printSkipBanner("multi-instance", "SKIPPING — AE_MCP_E2E_MULTI not set", [
        " This suite launches two After Effects instances (AfterFX.exe -m) and quits them.",
      ]);
      return;
    }
    if (process.platform !== "win32") {
      printSkipBanner(
        "multi-instance",
        "SKIPPING — Windows only (macOS instance launch is unverified)",
      );
      return;
    }
    if (!(await agentInstallStatus()).some((s) => s.installed)) {
      printSkipBanner("multi-instance", "SKIPPING — resident agent not installed", [
        " Run `node dist/index.js install-agent`, then re-run.",
      ]);
      return;
    }
    const live = await liveIds();
    if (live.includes(MAIN) || live.includes(WORKER)) {
      printSkipBanner("multi-instance", `SKIPPING — ${MAIN} / ${WORKER} already live`, [
        " Stop them (ae_do instance.stop) or wait for them to go stale, then re-run.",
      ]);
      return;
    }
    await fs.mkdir(path.join(E2E_SCRATCH_DIR, "multi"), { recursive: true });
    mainProject = path.join(E2E_SCRATCH_DIR, "multi", "main.aep").replace(/\\/g, "/");
    await fs.rm(mainProject, { force: true });
    transport = new FileIpcTransport({ instance: null });
    aeDo = toolNamed("ae_do");
    saveProject = toolNamed("ae_save_project");
    context = toolNamed("ae_context");
    ready = true;
  }, 30_000);

  afterAll(async () => {
    if (!ready) return;
    // Whatever the tests left running is asked to quit — never killed. A
    // force-killed After Effects makes the NEXT launch stop at the Safe Mode
    // dialog, which would break every later instance.start on this machine.
    for (const name of [WORKER, MAIN]) {
      if (!(await liveIds()).includes(name)) continue;
      try {
        await call("instance.stop", { name, discardChanges: true, timeoutMs: 20_000 }, name);
      } catch (err) {
        printSkipBanner(
          "multi-instance",
          `instance '${name}' (pid ${pids[name] ?? "?"}) is still running`,
          [
            ` ${err instanceof Error ? err.message : String(err)}`,
            " Quit it from its own window (File > Exit) — do not taskkill it.",
          ],
        );
      }
    }
  }, 120_000);

  it(
    "starts a main instance and registers it under its name",
    async (ctx) => {
      if (!ready) return ctx.skip();
      const res = await call("instance.start", { name: MAIN, timeoutMs: START_TIMEOUT }, MAIN);
      expect(res.instance).toBe(MAIN);
      expect(typeof res.pid).toBe("number");
      pids[MAIN] = res.pid as number;
      expect(res.project).toBeNull();
      expect(await liveIds()).toContain(MAIN);
      const ctxMain = (await contextOf(MAIN)) as { instance: { id: string; idSource: string } };
      expect(ctxMain.instance.id).toBe(MAIN);
      expect(ctxMain.instance.idSource).toBe("env");
    },
    START_TIMEOUT + 30_000,
  );

  it("gives the main instance a project to share", async (ctx) => {
    if (!ready) return ctx.skip();
    await call(
      "comp.create",
      { name: "MainComp", width: 640, height: 360, fps: 24, duration: 2 },
      MAIN,
    );
    const saved = await saveProject.handler({ path: mainProject, instance: MAIN }, transport);
    expect(saved.isError, JSON.stringify(saved.structuredContent)).toBeFalsy();
    await expect(fs.access(mainProject)).resolves.toBeUndefined();
  }, 60_000);

  it(
    "starts a worker on a COPY of the main project",
    async (ctx) => {
      if (!ready) return ctx.skip();
      const res = await call(
        "instance.start",
        { name: WORKER, copyFrom: mainProject, timeoutMs: START_TIMEOUT },
        MAIN,
      );
      expect(res.instance).toBe(WORKER);
      pids[WORKER] = res.pid as number;
      const project = res.project as { file: string; numItems: number };
      workerProject = project.file;
      expect(project.file.toLowerCase()).toContain(`main__${WORKER}.aep`);
      expect(project.numItems).toBe(1);
      expect(samePath(String(res.copiedFrom), mainProject)).toBe(true);
      // The original is untouched by the copy.
      const mainCtx = (await contextOf(MAIN)) as { project: { file: string } };
      expect(samePath(mainCtx.project.file, mainProject)).toBe(true);
    },
    START_TIMEOUT + 30_000,
  );

  it("answers both instances at the same time, each as itself", async (ctx) => {
    if (!ready) return ctx.skip();
    const [main, worker] = await Promise.all([contextOf(MAIN), contextOf(WORKER)]);
    expect((main.instance as { id: string }).id).toBe(MAIN);
    expect((worker.instance as { id: string }).id).toBe(WORKER);
    const list = await call("instance.list", {}, MAIN);
    expect(list.live).toEqual(expect.arrayContaining([MAIN, WORKER]));
  }, 60_000);

  it("edits in the worker and saves its copy without touching main", async (ctx) => {
    if (!ready) return ctx.skip();
    await call(
      "comp.create",
      { name: "FromWorker", width: 320, height: 180, fps: 24, duration: 1 },
      WORKER,
    );
    const saved = await saveProject.handler({ instance: WORKER }, transport);
    expect(saved.isError, JSON.stringify(saved.structuredContent)).toBeFalsy();
    const mainCtx = (await contextOf(MAIN)) as { project: { numItems: number } };
    expect(mainCtx.project.numItems).toBe(1);
  }, 60_000);

  it("merges the worker's project into main as a folder", async (ctx) => {
    if (!ready) return ctx.skip();
    const merged = await call(
      "project.merge",
      { path: workerProject, folderName: "merged-w1" },
      MAIN,
    );
    expect((merged.folder as { name: string }).name).toBe("merged-w1");
    const comps = merged.comps as Array<{ name: string }>;
    expect(comps.map((c) => c.name)).toEqual(expect.arrayContaining(["MainComp", "FromWorker"]));
    const mainCtx = (await contextOf(MAIN)) as { project: { numItems: number } };
    // MainComp + folder + its two comps.
    expect(mainCtx.project.numItems).toBe(4);
  }, 60_000);

  it("stops the worker (its project is saved, so no flag needed) and main (discarding the merge)", async (ctx) => {
    if (!ready) return ctx.skip();
    const stoppedWorker = await call("instance.stop", { name: WORKER }, MAIN);
    expect(stoppedWorker.stopped).toBe(true);
    expect(await liveIds()).not.toContain(WORKER);

    // Main is dirty after the merge: without a flag the stop must refuse.
    await expect(call("instance.stop", { name: MAIN }, MAIN)).rejects.toThrow(/unsaved changes/);
    const stoppedMain = await call("instance.stop", { name: MAIN, discardChanges: true }, MAIN);
    expect(stoppedMain.stopped).toBe(true);
    expect(await liveIds()).not.toContain(MAIN);
  }, 120_000);
});
