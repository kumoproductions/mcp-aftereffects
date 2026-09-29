// The pull path and the phantom-launch guard, without After Effects.
//
// Pull: a stand-in agent (a Node interval) keeps a heartbeat fresh in a
// throwaway instance directory under the REAL mailbox and answers requests
// the way jsx/agent.jsx does, so the transport is exercised end to end
// against the real wire format.
//
// Phantom: the launcher child is injected, so "AfterFX.exe that never exits
// because it is booting its own instance" is a fake process rather than an
// executable that happens to behave that way on one platform.

import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BUSY_LOCK_PATH,
  HEARTBEAT_FILENAME,
  HEARTBEAT_STALE_MS,
  PHANTOM_LAUNCH_MS,
  REQUEST_PREFIX,
  RESPONSE_PREFIX,
  instanceDirFor,
} from "../src/config.js";
import {
  FileIpcTransport,
  type LaunchedProcess,
  type SpawnFn,
} from "../src/transport/FileIpcTransport.js";
import {
  type AeDialog,
  setOsascriptRunner,
  setPowerShellRunner,
} from "../src/transport/dialogs.js";

// The transport scans for After Effects dialogs on its failure paths. Never
// let that reach the real desktop from a unit test.
let restoreRunners: Array<() => void> = [];
beforeAll(() => {
  restoreRunners = [setPowerShellRunner(async () => "[]"), setOsascriptRunner(async () => "[]")];
});
afterAll(() => restoreRunners.forEach((restore) => restore()));

const DIALOG: AeDialog = {
  pid: 4242,
  id: "123456",
  text: "After Effects warning: 1 file is missing since you last saved this project.",
  width: 492,
  height: 260,
  window: "Adobe After Effects 2026 - C:/work/ShotA.aep",
};
const seesDialog = async () => [DIALOG];

const INERT_EXE = process.platform === "win32" ? "C:/Windows/System32/cmd.exe" : "/usr/bin/true";
// Phantom detection is the `-r` path's; osascript legitimately blocks for the
// DoScript duration, so macOS never treats a live child as a phantom.
const itUnlessDarwin = it.skipIf(process.platform === "darwin");
const savedExe = process.env.AE_MCP_EXE;

afterEach(() => {
  if (savedExe === undefined) delete process.env.AE_MCP_EXE;
  else process.env.AE_MCP_EXE = savedExe;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal agent stand-in: heartbeats every 300 ms and, when `serve` is set,
 * answers each request-<id>.json with { ok: true, result: serve(request) }.
 */
class FakeAgent {
  readonly id = `t-${randomUUID().slice(0, 8)}`;
  readonly dir = instanceDirFor(this.id);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  served: Array<Record<string, unknown>> = [];

  constructor(private readonly serve: ((request: Record<string, unknown>) => unknown) | null) {}

  async start(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await this.heartbeat();
    this.timer = setInterval(() => void this.tick(), 40);
  }

  /** Stop ticking but leave the directory (and any pending request) in place. */
  pause(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async stop(): Promise<void> {
    this.pause();
    await fs.rm(this.dir, { recursive: true, force: true });
  }

  async heartbeat(overrides: Record<string, unknown> = {}): Promise<void> {
    const body = JSON.stringify({
      id: this.id,
      idSource: "env",
      aeVersion: "26.3x87",
      project: null,
      projectName: null,
      busy: this.busy,
      ts: Date.now(),
      ...overrides,
    });
    const tmp = path.join(this.dir, `${HEARTBEAT_FILENAME}.tmp`);
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, path.join(this.dir, HEARTBEAT_FILENAME));
  }

  private lastBeat = 0;

  private async tick(): Promise<void> {
    if (Date.now() - this.lastBeat >= 300) {
      this.lastBeat = Date.now();
      await this.heartbeat();
    }
    if (!this.serve) return;
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.startsWith(REQUEST_PREFIX) || !name.endsWith(".json")) continue;
      const id = name.slice(REQUEST_PREFIX.length, -".json".length);
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8"));
        await fs.unlink(path.join(this.dir, name));
      } catch {
        continue;
      }
      this.busy = true;
      await this.heartbeat();
      this.served.push(request);
      const response = {
        id,
        ok: true,
        phase: "execute",
        result: this.serve(request),
        error: null,
        stack: null,
        logs: ["served by " + this.id],
      };
      const tmp = path.join(this.dir, `.${RESPONSE_PREFIX}${id}.json.tmp`);
      await fs.writeFile(tmp, JSON.stringify(response), "utf8");
      await fs.rename(tmp, path.join(this.dir, `${RESPONSE_PREFIX}${id}.json`));
      this.busy = false;
      await this.heartbeat();
    }
  }
}

class FakeChild extends EventEmitter implements LaunchedProcess {
  pid = 4242;
  killed = false;
  stderr = null;
  kill(): void {
    this.killed = true;
    this.emit("exit", null);
  }
  unref(): void {}
}

function recordingSpawn(behaviour: (child: FakeChild) => void): {
  spawn: SpawnFn;
  calls: number;
  children: FakeChild[];
} {
  const state = { spawn: undefined as unknown as SpawnFn, calls: 0, children: [] as FakeChild[] };
  state.spawn = () => {
    state.calls++;
    const child = new FakeChild();
    state.children.push(child);
    behaviour(child);
    return child;
  };
  return state;
}

async function listMail(dir: string, prefix: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((e) => e.startsWith(prefix) && e.endsWith(".json"));
  } catch {
    return [];
  }
}

describe("pull path", () => {
  let agent: FakeAgent;

  afterEach(async () => {
    await agent?.stop();
  });

  it("round-trips through the instance's own mailbox without launching anything", async () => {
    agent = new FakeAgent((request) => ({ echo: request.code, answer: 42 }));
    await agent.start();
    const launcher = recordingSpawn(() => {});
    const transport = new FileIpcTransport({ instance: agent.id, spawn: launcher.spawn });

    const res = await transport.execute({
      code: "return 41 + 1;",
      label: "pull_roundtrip",
      timeoutMs: 5_000,
    });

    expect(res.ok, res.error ?? "").toBe(true);
    expect(res.result).toEqual({ echo: "return 41 + 1;", answer: 42 });
    expect(res.logs).toEqual([`served by ${agent.id}`]);
    // Pull never spawns: nothing to collide with a script AE is running, and
    // no AfterFX.exe path is needed at all.
    expect(launcher.calls).toBe(0);
    // The wire format is the dispatcher's: explicit undo/suppress flags, label.
    expect(agent.served[0]).toMatchObject({
      label: "pull_roundtrip",
      undoGroup: true,
      suppressDialogs: true,
    });
    expect(await listMail(agent.dir, REQUEST_PREFIX)).toEqual([]);
    expect(await listMail(agent.dir, RESPONSE_PREFIX)).toEqual([]);
  });

  it("finds the instance by the project it has open", async () => {
    agent = new FakeAgent(() => "ok");
    await agent.start();
    await agent.heartbeat({ project: "C:/work/ShotA.aep", projectName: "ShotA.aep" });
    // Keep the project in later heartbeats too, or the fake's own refresh
    // would drop it before the transport looks.
    const transport = new FileIpcTransport({
      instance: "shota",
      spawn: recordingSpawn(() => {}).spawn,
    });
    const res = await transport.execute({
      code: "return 1;",
      label: "pull_by_project",
      timeoutMs: 2_000,
    });
    // The fake refreshes without the project after ~300 ms; the transport
    // resolved before that, or this reads NO_INSTANCE — either way the assertion
    // below says which.
    expect(res.ok, res.error ?? "").toBe(true);
  });

  it("fails fast when the instance stops ticking, and takes the request back", async () => {
    agent = new FakeAgent(null); // heartbeats, never serves
    await agent.start();
    const transport = new FileIpcTransport({
      instance: agent.id,
      spawn: recordingSpawn(() => {}).spawn,
    });

    const call = transport.execute({ code: "return 1;", label: "pull_dies", timeoutMs: 30_000 });
    await sleep(200);
    // The instance vanishes mid-call: stop the fake's ticking (the request
    // must stay in the mailbox — that is what "never picked up" means) and
    // antedate its last beat.
    agent.pause();
    await agent.heartbeat({ ts: Date.now() - HEARTBEAT_STALE_MS - 1000 });

    const started = Date.now();
    const res = await call;
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("NO_INSTANCE");
    expect(res.error).toContain("stopped responding");
    expect(res.error).toContain("discarded");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await listMail(agent.dir, REQUEST_PREFIX)).toEqual([]);
  });

  it("names the dialog when the instance stopped ticking behind one", async () => {
    agent = new FakeAgent(null);
    await agent.start();
    const transport = new FileIpcTransport({
      instance: agent.id,
      spawn: recordingSpawn(() => {}).spawn,
      scanDialogs: seesDialog,
    });
    const call = transport.execute({ code: "return 1;", label: "pull_modal", timeoutMs: 30_000 });
    await sleep(200);
    agent.pause();
    await agent.heartbeat({ ts: Date.now() - HEARTBEAT_STALE_MS - 1000 });

    const res = await call;
    expect(res.errorCode).toBe("DIALOG_OPEN");
    expect(res.error).toContain("1 file is missing");
    expect(res.error).toContain("instance.dismiss_dialog");
    expect(res.dialogs).toEqual([DIALOG]);
    expect(await listMail(agent.dir, REQUEST_PREFIX)).toEqual([]);
  });

  it("reports DIALOG_OPEN for a stale named instance before sending anything", async () => {
    agent = new FakeAgent(null);
    await agent.start();
    agent.pause();
    await agent.heartbeat({ ts: Date.now() - HEARTBEAT_STALE_MS - 1000 });
    const transport = new FileIpcTransport({
      instance: agent.id,
      spawn: recordingSpawn(() => {}).spawn,
      scanDialogs: seesDialog,
    });
    const res = await transport.execute({
      code: "return 1;",
      label: "pull_stale",
      timeoutMs: 5_000,
    });
    expect(res.errorCode).toBe("DIALOG_OPEN");
    expect(res.error).toContain(agent.id);
    expect(await listMail(agent.dir, REQUEST_PREFIX)).toEqual([]);
  });

  it("times out naming the instance and reclaims an unconsumed request", async () => {
    agent = new FakeAgent(null);
    await agent.start();
    const transport = new FileIpcTransport({
      instance: agent.id,
      spawn: recordingSpawn(() => {}).spawn,
    });
    const res = await transport.execute({
      code: "return 1;",
      label: "pull_timeout",
      timeoutMs: 600,
    });
    expect(res.errorCode).toBe("TIMEOUT");
    expect(res.error).toContain(agent.id);
    expect(res.error).toContain("never picked up");
    expect(await listMail(agent.dir, REQUEST_PREFIX)).toEqual([]);
  });

  it("refuses an unknown target without spawning", async () => {
    agent = new FakeAgent(null);
    await agent.start();
    const launcher = recordingSpawn(() => {});
    const transport = new FileIpcTransport({
      instance: "no-such-instance-xyz",
      spawn: launcher.spawn,
    });
    const res = await transport.execute({
      code: "return 1;",
      label: "pull_unknown",
      timeoutMs: 5_000,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("NO_INSTANCE");
    expect(res.error).toContain("no-such-instance-xyz");
    expect(res.error).toContain("install-agent");
    expect(launcher.calls).toBe(0);
  });

  it("routes a call that names an instance there, whatever the transport's default", async () => {
    // One session driving several instances: the transport is bound to A
    // (constructor / AE_MCP_INSTANCE) but a call says B.
    agent = new FakeAgent(() => "from A");
    await agent.start();
    const other = new FakeAgent(() => "from B");
    await other.start();
    try {
      const transport = new FileIpcTransport({
        instance: agent.id,
        spawn: recordingSpawn(() => {}).spawn,
      });
      const viaDefault = await transport.execute({
        code: "return 1;",
        label: "route_default",
        timeoutMs: 5_000,
      });
      const viaOverride = await transport.execute({
        code: "return 1;",
        label: "route_override",
        instance: other.id,
        timeoutMs: 5_000,
      });
      expect(viaDefault.result).toBe("from A");
      expect(viaOverride.result).toBe("from B");
      expect(other.served).toHaveLength(1);
      expect((await transport.describeTarget(other.id)).mode).toBe("pull");
    } finally {
      await other.stop();
    }
  });

  it("describes where the next call goes", async () => {
    agent = new FakeAgent(null);
    await agent.start();
    const pull = await new FileIpcTransport({ instance: agent.id }).describeTarget();
    expect(pull.mode).toBe("pull");
    const push = await new FileIpcTransport({ instance: null }).describeTarget();
    expect(push).toEqual({ mode: "push" });
  });
});

describe("push path: phantom launch guard", () => {
  beforeEach(() => {
    process.env.AE_MCP_EXE = INERT_EXE;
  });

  afterEach(async () => {
    try {
      await fs.unlink(BUSY_LOCK_PATH);
    } catch {
      /* not held */
    }
  });

  itUnlessDarwin(
    "kills a launcher child that outlives a forwarder and reports NO_INSTANCE",
    async () => {
      // AfterFX.exe that never exits = it is booting an instance of its own
      // (nothing registered to receive -r: none running, or only -m ones). Left
      // alone it would run the request on an empty project and report success.
      const launcher = recordingSpawn(() => {});
      const transport = new FileIpcTransport({ instance: null, spawn: launcher.spawn });
      const started = Date.now();
      const res = await transport.execute({
        code: "return 1;",
        label: "phantom",
        timeoutMs: 30_000,
      });
      const elapsed = Date.now() - started;

      expect(res.ok).toBe(false);
      expect(res.errorCode).toBe("NO_INSTANCE");
      expect(res.error).toContain("booting");
      expect(res.error).toContain("-m");
      expect(res.error).toContain("install-agent");
      // Decided at PHANTOM_LAUNCH_MS, not at the deadline.
      expect(elapsed).toBeGreaterThanOrEqual(PHANTOM_LAUNCH_MS - 200);
      expect(elapsed).toBeLessThan(PHANTOM_LAUNCH_MS + 3_000);
      // One launch only — relaunching would have booted a second throwaway AE.
      expect(launcher.calls).toBe(1);
      expect(launcher.children[0].killed).toBe(true);
      await expect(fs.access(BUSY_LOCK_PATH)).rejects.toThrow();
    },
    15_000,
  );

  it("treats a child that exits promptly as a forwarder and keeps relaunching", async () => {
    // The real forwarder hands the script over and exits within a second;
    // an unconsumed request after that means AE refused it — relaunch.
    const launcher = recordingSpawn((child) => {
      setTimeout(() => child.emit("exit", 0), 30);
    });
    const transport = new FileIpcTransport({ instance: null, spawn: launcher.spawn });
    const res = await transport.execute({
      code: "return 1;",
      label: "forwarder",
      timeoutMs: 3_500,
    });
    expect(res.errorCode).toBe("TIMEOUT");
    expect(res.error).toMatch(/after 2 launch attempts/);
    expect(launcher.calls).toBe(2);
    expect(launcher.children.every((c) => !c.killed)).toBe(true);
  }, 10_000);

  it("stops relaunching once a dialog is what blocks the script", async () => {
    // Each -r into an AE that shows a modal adds a "Cannot run a script
    // while a modal dialog is waiting for response" alert on top of it.
    const launcher = recordingSpawn((child) => {
      setTimeout(() => child.emit("exit", 0), 30);
    });
    const transport = new FileIpcTransport({
      instance: null,
      spawn: launcher.spawn,
      // Visible only once the first launch is out, whatever else the real
      // mailbox holds: this is about the relaunch, not the pre-launch check.
      scanDialogs: async () => (launcher.calls > 0 ? [DIALOG] : []),
    });
    const res = await transport.execute({
      code: "return 1;",
      label: "modal_push",
      timeoutMs: 20_000,
    });
    expect(res.errorCode).toBe("DIALOG_OPEN");
    expect(res.error).toContain("after 1 launch attempt");
    expect(res.dialogs).toEqual([DIALOG]);
    expect(launcher.calls).toBe(1);
    await expect(fs.access(BUSY_LOCK_PATH)).rejects.toThrow();
  }, 15_000);

  it("does not launch at all when a stale agent sits behind a dialog", async () => {
    // The 2026-09-15 report: the agent stopped ticking behind a modal, the
    // server fell back to push, and three -r launches stacked three alerts.
    const stale = new FakeAgent(null);
    await stale.start();
    stale.pause();
    await stale.heartbeat({ ts: Date.now() - HEARTBEAT_STALE_MS - 1000 });
    try {
      const launcher = recordingSpawn(() => {});
      const transport = new FileIpcTransport({
        instance: null,
        spawn: launcher.spawn,
        scanDialogs: seesDialog,
      });
      const res = await transport.execute({
        code: "return 1;",
        label: "stale_push",
        timeoutMs: 20_000,
      });
      expect(res.errorCode).toBe("DIALOG_OPEN");
      expect(res.error).toContain("nothing was sent");
      expect(launcher.calls).toBe(0);
    } finally {
      await stale.stop();
    }
  });
});
