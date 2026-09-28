import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, promises as fs, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { Readable } from "node:stream";

import {
  BUSY_LOCK_PATH,
  BUSY_LOCK_REFRESH_MS,
  BUSY_LOCK_STALE_MS,
  DEFAULT_TIMEOUT_MS,
  LIVENESS_CHECK_MS,
  MAX_LAUNCH_ATTEMPTS,
  PHANTOM_LAUNCH_MS,
  POLL_INTERVAL_MS,
  RELAUNCH_UNCONSUMED_AFTER_MS,
  REQUEST_PREFIX,
  RESPONSE_PREFIX,
  RUNTIME_DIR,
  RUNTIME_DIR_IS_CUSTOM,
  RUNTIME_DIR_MODE,
  RUNTIME_POINTER_PATH,
  RUNTIME_ROOT,
  STALE_RUNTIME_FILE_MS,
  instanceTargetFromEnv,
  requestPathFor,
  resolveAfterFxPath,
  responsePathFor,
  runtimeDirWarnings,
} from "../config.js";
import type { AeErrorCode } from "../errors.js";
import type { AeTransport, EvalRequest, EvalResult } from "./AeTransport.js";
import { type AeDialog, DIALOG_HINT, dialogBlockMessage, scanAeDialogs } from "./dialogs.js";
import {
  type InstanceInfo,
  type TargetResolution,
  describeInstance,
  listInstances,
  readInstance,
  resolveTarget,
  sweepDeadInstanceDirs,
} from "./instances.js";
import { type LaunchPlan, buildLaunchPlan } from "./launcher.js";

/**
 * The slice of ChildProcess the transport uses. Injectable (see
 * FileIpcTransportOptions.spawn) so a test can stand in a launcher child that
 * never exits — the signature of AE booting a throwaway instance — without an
 * executable that behaves that way on every platform.
 */
export interface LaunchedProcess {
  pid?: number;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(): unknown;
  unref?(): void;
  stderr?: Readable | null;
}

export interface LaunchSpawnOptions {
  stdio: "ignore" | ["ignore", "ignore", "pipe"];
  windowsHide: boolean;
  detached: boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: LaunchSpawnOptions,
) => LaunchedProcess;

export interface FileIpcTransportOptions {
  /**
   * Which After Effects instance to address. A string is what AE_MCP_INSTANCE
   * would hold (an instance id, or the name of the project file an instance
   * has open); `null` forces the legacy push path regardless of live agents;
   * undefined (the default) reads AE_MCP_INSTANCE at call time.
   */
  instance?: string | null;
  /** Process launcher; defaults to child_process.spawn. */
  spawn?: SpawnFn;
  /** Modal-dialog scan; defaults to scanAeDialogs (Windows only). Injectable for tests. */
  scanDialogs?: () => Promise<AeDialog[]>;
}

interface SpawnState {
  error: Error | null;
  child: LaunchedProcess | null;
  exited: boolean;
}

interface MailboxRequest {
  id: string;
  label: string;
  code: string;
  payload: unknown;
  undoGroup: boolean;
  suppressDialogs: boolean;
}

interface DispatcherResponse {
  id: string | null;
  ok: boolean;
  /** "dispatch" = failed before running our code; "execute" = our code threw. */
  phase?: "dispatch" | "execute";
  result: unknown;
  error: string | null;
  /**
   * 1-based line in the compiled function body where execution threw
   * (ExtendScript Error.line). Absent/null from dispatchers predating the
   * field. new Function's synthesized header is line 1, so the wrapped
   * request code starts at line 2 — callers that know the wrapper layout
   * (ae_do) translate this to a line in the code they assembled.
   */
  line?: number | null;
  stack: string | null;
  logs: string[];
}

/**
 * File-IPC transport. Two ways to reach After Effects, chosen per call by
 * `resolveTarget` (see transport/instances.ts):
 *
 * PUSH — write `request-<id>.json` into the shared mailbox, launch the
 * dispatcher inside AE (`AfterFX.exe -r` on Windows, `osascript`/DoScript on
 * macOS — see launcher.ts), poll `response-<id>.json`. Reaches the one
 * instance registered as THE running AE; instances started with `-m` are
 * invisible to it.
 *
 * PULL — write the request into `<mailbox>/instances/<id>/`, where the
 * resident agent (jsx/agent.jsx, loaded from that instance's Startup folder)
 * polls every 250 ms, and poll the response next to it. Nothing is spawned,
 * so nothing can collide with a script AE is already running. Used whenever
 * the instance named by AE_MCP_INSTANCE has a live heartbeat, or exactly one
 * agent is live and nothing was named.
 *
 * Mailbox: every request/response is its own file in a machine-wide directory
 * under the OS temp dir (see config.ts). That is what makes concurrent MCP
 * clients safe — the old single `request.json` / `response.json` pair meant a
 * second client could delete another's response (spurious timeout on a call
 * that actually applied) or overwrite an unconsumed request (a call that
 * silently never ran). With per-id files neither is expressible.
 *
 * Concurrency: calls from THIS process are still serialized with a promise
 * chain. AE executes JSX single-threaded, so overlapping our own calls would
 * only queue inside AE with less visibility.
 *
 * After Effects is resolved lazily on the first push (not in the constructor)
 * so the MCP server can start — and list its tools — on a machine where AE
 * isn't installed yet; the helpful "set AE_MCP_EXE" error surfaces per call.
 * Pull never needs the executable at all.
 */
export class FileIpcTransport implements AeTransport {
  private afterFxPath: string | null = null;
  private inflight: Promise<unknown> = Promise.resolve();
  /** Non-null when the mailbox directory is unusable; reported per call. */
  private readonly setupError: string | null = null;
  private readonly instanceOption: string | null | undefined;
  private readonly spawnFn: SpawnFn;
  private readonly scanDialogs: () => Promise<AeDialog[]>;

  constructor(options: FileIpcTransportOptions = {}) {
    this.instanceOption = options.instance;
    this.spawnFn = options.spawn ?? ((command, args, opts) => nodeSpawn(command, args, opts));
    this.scanDialogs = options.scanDialogs ?? (() => scanAeDialogs());
    try {
      // 0o700: write access to the mailbox is code execution inside AE (see
      // RUNTIME_DIR_MODE). recursive:true applies the mode to what it creates;
      // a directory that already exists keeps its mode, which is what
      // runtimeDirWarnings reports on below.
      mkdirSync(RUNTIME_DIR, { recursive: true, mode: RUNTIME_DIR_MODE });
      if (RUNTIME_DIR_IS_CUSTOM) {
        // dispatcher.jsx and agent.jsx derive the default mailbox path
        // themselves; when AE_MCP_RUNTIME_DIR moves it, this pointer is how
        // the JSX side finds it. Written at the fixed default location, which
        // is always writable.
        mkdirSync(RUNTIME_ROOT, { recursive: true, mode: RUNTIME_DIR_MODE });
        writeFileSync(RUNTIME_POINTER_PATH, RUNTIME_DIR, "utf8");
      } else {
        // Back on the default: clear any pointer a previous custom-dir run
        // left behind, or the JSX side would keep looking somewhere we no
        // longer write to.
        try {
          unlinkSync(RUNTIME_POINTER_PATH);
        } catch {
          /* nothing to clear */
        }
      }
      // Reported after both directories exist: the pointer directory is part of
      // the same trust boundary (the JSX side follows runtime-dir.txt before
      // looking at the default mailbox) and can only be checked once it's there.
      for (const warning of runtimeDirWarnings()) {
        process.stderr.write(`mcp-aftereffects: WARNING — ${warning}\n`);
      }
    } catch (err) {
      // Do NOT throw: the server must still start and list its tools so the
      // user gets a readable error from a tool call instead of a dead process.
      this.setupError = `cannot use runtime directory ${RUNTIME_DIR}: ${err instanceof Error ? err.message : String(err)}`;
    }
    void this.sweepStaleFiles();
  }

  /** Where the next call would go. For ae_context and the startup banner; never throws. */
  async describeTarget(instance?: string): Promise<TargetResolution> {
    return this.resolveTarget(instance);
  }

  /**
   * A per-call `instance` wins over the constructor option, which wins over
   * AE_MCP_INSTANCE; `instance: null` at construction forces push unless a
   * call names an instance explicitly.
   */
  private async resolveTarget(explicit?: string): Promise<TargetResolution> {
    const named = explicit?.trim();
    if (named) return resolveTarget(named);
    if (this.instanceOption === null) return { mode: "push" };
    const target =
      this.instanceOption === undefined ? instanceTargetFromEnv() : this.instanceOption;
    return resolveTarget(target);
  }

  async execute(req: EvalRequest): Promise<EvalResult> {
    // Serialize so our own concurrent tool calls queue here rather than inside AE.
    const prev = this.inflight;
    let release!: () => void;
    this.inflight = new Promise<void>((res) => {
      release = res;
    });
    try {
      await prev;
      return await this.executeOne(req);
    } catch (err) {
      // AeTransport contract: never throw — surface filesystem errors (e.g.
      // EPERM writing into the mailbox) as a normal failure result.
      return failure(
        "TRANSPORT",
        `mcp-aftereffects transport error: ${err instanceof Error ? err.message : String(err)}`,
        { stack: err instanceof Error && err.stack ? err.stack : null },
      );
    } finally {
      release();
    }
  }

  private async executeOne(req: EvalRequest): Promise<EvalResult> {
    const started = Date.now();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (this.setupError !== null) {
      return failure("TRANSPORT", this.setupError, {
        durationMs: Date.now() - started,
      });
    }

    const target = await this.resolveTarget(req.instance);
    if (target.mode === "error") {
      // A named instance that stopped ticking is most often one stuck behind
      // a dialog — say which, rather than only that it went quiet.
      const dialogs = await this.scanDialogs();
      if (dialogs.length > 0) return dialogFailure(dialogs, target.message, started);
      return failure("NO_INSTANCE", target.message, {
        durationMs: Date.now() - started,
        hint: target.hint,
      });
    }

    const request: MailboxRequest = {
      id: randomUUID(),
      label: req.label ?? "action",
      code: req.code,
      payload: req.payload ?? null,
      // Sent explicitly rather than by omission: the JSX side defaults a
      // missing field to true, and "group this" must not depend on a key
      // surviving the trip.
      undoGroup: req.undoGroup !== false,
      suppressDialogs: req.suppressDialogs !== false,
    };

    if (target.mode === "pull") {
      return this.executePull(request, target.instance, started, timeoutMs);
    }
    return this.executePush(request, started, timeoutMs);
  }

  // --- Pull: the instance's agent serves its own mailbox ---------------------

  private async executePull(
    request: MailboxRequest,
    instance: InstanceInfo,
    started: number,
    timeoutMs: number,
  ): Promise<EvalResult> {
    const dir = instance.dir;
    const requestPath = path.join(dir, `${REQUEST_PREFIX}${request.id}.json`);
    const responsePath = path.join(dir, `${RESPONSE_PREFIX}${request.id}.json`);
    await fs.mkdir(dir, { recursive: true });
    await this.writeRequest(dir, requestPath, request);

    // No busy lock and no launch: the agent dequeues one request per tick, so
    // two server processes aimed at the same instance simply queue in its
    // directory, and the "second script" refusal that the lock guards against
    // on the push path cannot happen here.
    const deadline = started + timeoutMs;
    let requestConsumed = false;
    let lastLivenessAt = started;
    while (Date.now() < deadline) {
      const parsed = await this.tryReadResponse(responsePath);
      if (parsed) {
        await this.safeUnlink(responsePath);
        return this.toEvalResult(parsed, Date.now() - started);
      }
      const now = Date.now();
      if (!requestConsumed && now - lastLivenessAt >= LIVENESS_CHECK_MS) {
        lastLivenessAt = now;
        if (!(await this.fileExists(requestPath))) {
          requestConsumed = true;
        } else {
          // Still waiting to be picked up: is anyone there to pick it up? A
          // heartbeat that stopped (and did not say `busy`) means AE quit,
          // crashed, or is stuck in a modal — fail now, not at the deadline.
          const current = await readInstance(dir, now);
          if (!current.alive) {
            await this.safeUnlink(requestPath);
            const dialogs = await this.scanDialogs();
            if (dialogs.length > 0) {
              return dialogFailure(
                dialogs,
                `After Effects instance '${instance.id}' stopped responding; the request was never picked up and has been discarded`,
                started,
              );
            }
            return failure(
              "NO_INSTANCE",
              `After Effects instance '${instance.id}' stopped responding (${describeInstance(current)}); ` +
                "the request was never picked up and has been discarded",
              {
                durationMs: Date.now() - started,
                hint:
                  "Is that After Effects still running, and free of modal dialogs? Scripts do not run while one is open. " +
                  "If it was restarted, the agent re-registers about ten seconds after launch — retry then.",
              },
            );
          }
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }

    const reclaimed = await this.safeUnlink(requestPath);
    const pullTimeoutMessage =
      `timeout after ${timeoutMs}ms waiting for After Effects instance '${instance.id}' to respond` +
      (reclaimed
        ? " (the request was never picked up and has been discarded)"
        : " (the request WAS picked up by the instance; the operation may still be running)");
    const pullDialogs = await this.scanDialogs();
    if (pullDialogs.length > 0) return dialogFailure(pullDialogs, pullTimeoutMessage, started);
    return failure("TIMEOUT", pullTimeoutMessage, {
      durationMs: Date.now() - started,
      hint:
        "Is After Effects showing a modal dialog, or rendering/previewing? Scripts wait for both. " +
        "For a long operation, raise timeoutMs.",
    });
  }

  // --- Push: launch the dispatcher into the registered instance ---------------

  private async executePush(
    request: MailboxRequest,
    started: number,
    timeoutMs: number,
  ): Promise<EvalResult> {
    try {
      this.afterFxPath ??= resolveAfterFxPath();
    } catch (err) {
      return failure("AE_NOT_FOUND", err instanceof Error ? err.message : String(err), {
        durationMs: Date.now() - started,
      });
    }

    // 0. A resident agent that registered and then stopped ticking is the
    // signature of an After Effects stuck behind a dialog — and every `-r`
    // launched at it would only stack a "Cannot run a script while a modal
    // dialog is waiting for response" alert on top. Look before launching.
    if ((await listInstances()).some((i) => !i.alive)) {
      const dialogs = await this.scanDialogs();
      if (dialogs.length > 0) {
        return dialogFailure(dialogs, "nothing was sent to After Effects", started);
      }
    }

    const id = request.id;
    const requestPath = requestPathFor(id);
    const responsePath = responsePathFor(id);

    // 1. Write the request atomically (tmp + rename).
    await this.writeRequest(RUNTIME_DIR, requestPath, request);

    // 2. Acquire the cross-process busy lock. AE refuses a script delivered
    // while another script runs — with a modal warning that halts all
    // scripting until dismissed — so two server processes must not dispatch
    // concurrently. Same-process calls are already serialized by `inflight`;
    // the lock extends that across processes (see config.ts).
    const deadline = started + timeoutMs;
    if (!(await this.acquireBusyLock(deadline, id))) {
      await this.safeUnlink(requestPath);
      return failure(
        "TIMEOUT",
        `timeout after ${timeoutMs}ms waiting for After Effects to become available — ` +
          "another call (possibly from another MCP server process) holds the dispatcher busy lock",
        {
          durationMs: Date.now() - started,
          hint:
            `The lock (${BUSY_LOCK_PATH}) is refreshed while its owner is alive and expires ` +
            `${Math.round(BUSY_LOCK_STALE_MS / 1000)}s after the owner stops. If this persists, ` +
            "check AE for a stuck script or a modal dialog, and avoid running two MCP servers against one AE.",
        },
      );
    }
    // True when the request was consumed but no response arrived in time: the
    // script may still be running inside AE, so the lock must outlive this
    // call and expire on its own instead of inviting an immediate collision.
    let leaveLockForRunningScript = false;
    try {
      // 3. Launch the dispatcher (launcher.ts picks the per-platform command).
      // The command returns immediately on Windows; on macOS osascript blocks
      // for the DoScript duration — either way the actual work happens inside
      // AE and we learn the outcome from the response file, not the child.
      const spawnState: SpawnState = { error: null, child: null, exited: false };
      const launch = this.launchDispatcher(spawnState);
      if (spawnState.error !== null) {
        return await this.spawnFailure(spawnState.error, requestPath, started);
      }

      // 4. Poll for OUR response file. While polling: keep the busy lock
      // fresh, and watch what became of the launch while the request sits
      // unconsumed. Two things can be wrong there:
      //   - AE refused the script (its "second script" warning) because
      //     something we cannot see was running when ours arrived — the
      //     launcher child exited normally, so launch again;
      //   - the launcher child is still alive: nothing was registered to
      //     receive the hand-off, and it is booting an instance of its own
      //     that would run the request on an empty project ~8s from now.
      //     Kill it and say so; relaunching would only boot a second one.
      let attempts = 1;
      let lastLaunchAt = started;
      let lastRefreshAt = started;
      let requestConsumed = false;
      while (Date.now() < deadline) {
        const parsed = await this.tryReadResponse(responsePath);
        if (parsed) {
          await this.safeUnlink(responsePath);
          return this.toEvalResult(parsed, Date.now() - started);
        }
        if (spawnState.error !== null) {
          return await this.spawnFailure(spawnState.error, requestPath, started);
        }
        const now = Date.now();
        if (now - lastRefreshAt >= BUSY_LOCK_REFRESH_MS) {
          lastRefreshAt = now;
          await this.refreshBusyLock(id);
        }
        if (!requestConsumed && now - lastLaunchAt >= RELAUNCH_UNCONSUMED_AFTER_MS) {
          if (!(await this.fileExists(requestPath))) {
            requestConsumed = true;
          } else if (launch.detectPhantom && spawnState.child !== null && !spawnState.exited) {
            if (now - lastLaunchAt >= PHANTOM_LAUNCH_MS) {
              return await this.phantomFailure(spawnState, requestPath, started);
            }
            // A forwarder that is merely slow exits shortly; give it until
            // PHANTOM_LAUNCH_MS before deciding.
          } else if (
            attempts < MAX_LAUNCH_ATTEMPTS &&
            now - lastLaunchAt >= RELAUNCH_UNCONSUMED_AFTER_MS * attempts
          ) {
            // Unconsumed with the forwarder gone: either AE refused the
            // script (the "second script" case — relaunching fixes it) or a
            // dialog blocks scripting, where each relaunch only adds another
            // alert. Tell the two apart before launching again.
            const dialogs = await this.scanDialogs();
            if (dialogs.length > 0) {
              await this.safeUnlink(requestPath);
              return dialogFailure(
                dialogs,
                `the request was never picked up after ${attempts} launch attempt${attempts === 1 ? "" : "s"} and has been discarded`,
                started,
              );
            }
            attempts++;
            lastLaunchAt = Date.now();
            this.launchDispatcher(spawnState);
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }

      // 5. Timed out. Reclaim the request if it is still sitting unconsumed:
      // leaving it there is how a "failed" mutation used to get picked up by a
      // later spawn and apply itself minutes after the caller gave up. If the
      // dispatcher already consumed it this unlink is a no-op.
      const reclaimed = await this.safeUnlink(requestPath);
      leaveLockForRunningScript = !reclaimed;
      const pushDialogs = await this.scanDialogs();
      if (pushDialogs.length > 0) {
        return dialogFailure(
          pushDialogs,
          reclaimed
            ? `timeout after ${timeoutMs}ms; the request was never picked up and has been discarded`
            : `timeout after ${timeoutMs}ms; the request WAS picked up by AE and may be waiting on the dialog`,
          started,
        );
      }
      return failure(
        "TIMEOUT",
        `timeout after ${timeoutMs}ms waiting for After Effects to respond` +
          (reclaimed
            ? ` (the request was never picked up by AE after ${attempts} launch attempt${attempts === 1 ? "" : "s"} and has been discarded)`
            : " (the request WAS picked up by AE; the operation may still be running)"),
        {
          durationMs: Date.now() - started,
          hint:
            "Is AE running with a project open? Is 'Allow Scripts to Write Files and Access Network' enabled? " +
            "Is AE showing a modal dialog (e.g. 'Attempt was made to run a second script')? Dismiss it — scripting is blocked while it is open. " +
            (process.platform === "darwin"
              ? "Is your MCP client allowed to control After Effects (System Settings → Privacy & Security → Automation)? " +
                "(pkill -9 -f 'After Effects' recovers a stuck AE)"
              : "(taskkill /F /IM AfterFX.exe recovers a stuck AE)"),
        },
      );
    } finally {
      if (!leaveLockForRunningScript) await this.releaseBusyLock(id);
    }
  }

  /**
   * Write a request atomically (tmp + rename). The tmp name is dotted so it
   * can never match the JSX side's `request-*.json` glob mid-write.
   */
  private async writeRequest(
    dir: string,
    requestPath: string,
    request: MailboxRequest,
  ): Promise<void> {
    const tmpRequestPath = path.join(dir, `.${REQUEST_PREFIX}${request.id}.json.tmp`);
    await fs.writeFile(tmpRequestPath, serializeRequest(request), "utf8");
    await fs.rename(tmpRequestPath, requestPath);
  }

  /**
   * Spawn the dispatcher launch command. Errors land in `state.error` rather
   * than throwing: a spawn failure (ENOENT, EACCES, EFTYPE, …) can never
   * produce a response, so the poll loop checks the state every tick instead
   * of waiting out the full timeout. When the plan says the exit code is
   * meaningful (osascript), a non-zero exit is treated the same way — that is
   * how a denied macOS Automation permission (-1743) surfaces in seconds.
   */
  private launchDispatcher(state: SpawnState): LaunchPlan {
    const launch = buildLaunchPlan(this.afterFxPath as string);
    state.child = null;
    state.exited = false;
    try {
      const child = this.spawnFn(launch.command, launch.args, {
        stdio: launch.diagnoseExit ? ["ignore", "ignore", "pipe"] : "ignore",
        windowsHide: true,
        detached: false,
      });
      state.child = child;
      // We don't wait for the child; AE may keep it short- or long-lived
      // depending on whether a new instance was started. Just make sure we
      // don't leak a handle that blocks node exit.
      child.unref?.();
      child.on("error", (err) => {
        state.error = err;
      });
      let stderr = "";
      if (launch.diagnoseExit) {
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          if (stderr.length < 4096) stderr += chunk;
        });
      }
      child.on("exit", (code) => {
        state.exited = true;
        if (launch.diagnoseExit && code !== null && code !== 0 && state.error === null) {
          const detail = stderr.trim();
          state.error = new Error(
            `${launch.command} exited with code ${code}${detail ? `: ${detail}` : ""}`,
          );
        }
      });
    } catch (err) {
      state.error = err instanceof Error ? err : new Error(String(err));
    }
    return launch;
  }

  /**
   * The launcher child outlived a forwarder with our request untouched: it is
   * AfterFX.exe becoming an instance, not delivering to one. Stop it before
   * it can run the request on an empty project, take the request back, and
   * explain — this is the one failure whose "success" would have been a lie.
   */
  private async phantomFailure(
    state: SpawnState,
    requestPath: string,
    started: number,
  ): Promise<EvalResult> {
    try {
      state.child?.kill();
    } catch {
      /* already gone */
    }
    await this.safeUnlink(requestPath);
    return failure(
      "NO_INSTANCE",
      "no running After Effects instance received the script: the launched AfterFX.exe started booting an " +
        "instance of its own. That happens when no After Effects is running, or when every running one was " +
        "started with `AfterFX.exe -m` — those never receive `-r` scripts. The booting instance was terminated " +
        "and the request discarded; nothing was executed.",
      {
        durationMs: Date.now() - started,
        hint:
          "Either drive one After Effects started WITHOUT -m, or set up multi-instance use: " +
          "`npx @kumoproductions/mcp-aftereffects install-agent`, restart After Effects, and set AE_MCP_INSTANCE " +
          "to the instance to address (see README, 'Multiple After Effects instances').",
      },
    );
  }

  /**
   * Acquire the cross-process busy lock, or give up at `deadline`.
   *
   * `open("wx")` is the atomic primitive: exactly one process can create the
   * file. A lock whose mtime is older than BUSY_LOCK_STALE_MS lost its owner
   * (crashed server, killed AE) and is broken by any waiter; the retry then
   * races other waiters on the "wx", which stays safe — one wins, the rest
   * keep waiting.
   */
  private async acquireBusyLock(deadline: number, id: string): Promise<boolean> {
    for (;;) {
      try {
        const handle = await fs.open(BUSY_LOCK_PATH, "wx");
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, id, startedAt: new Date().toISOString() }),
            "utf8",
          );
        } finally {
          await handle.close();
        }
        return true;
      } catch {
        try {
          const stat = await fs.stat(BUSY_LOCK_PATH);
          if (Date.now() - stat.mtimeMs > BUSY_LOCK_STALE_MS) {
            await this.safeUnlink(BUSY_LOCK_PATH);
          }
        } catch {
          // Lock vanished between open and stat, or the mailbox itself is
          // unreadable — fall through to the deadline check either way.
        }
        if (Date.now() >= deadline) return false;
        await sleep(POLL_INTERVAL_MS);
      }
    }
  }

  /**
   * True while the lock on disk is the one this call created. A call whose
   * event loop stalls past BUSY_LOCK_STALE_MS (a laptop suspend is enough —
   * the staleness test is wall-clock) has its lock broken and retaken by a
   * waiter, so neither refreshing nor releasing may touch the file blindly:
   * refreshing would keep someone else's lock alive forever, and releasing
   * would hand a third caller a dispatch slot while the second is still
   * driving AE — the exact collision the lock exists to prevent.
   */
  private async ownsBusyLock(id: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(BUSY_LOCK_PATH, "utf8");
      return (JSON.parse(raw) as { id?: unknown }).id === id;
    } catch {
      return false;
    }
  }

  /** Touch the lock so waiters keep seeing a live owner. Best-effort. */
  private async refreshBusyLock(id: string): Promise<void> {
    if (!(await this.ownsBusyLock(id))) return;
    const now = new Date();
    try {
      await fs.utimes(BUSY_LOCK_PATH, now, now);
    } catch {
      /* lock swept or broken — nothing to refresh */
    }
  }

  /** Drop the lock, but only while it is still ours. */
  private async releaseBusyLock(id: string): Promise<void> {
    if (!(await this.ownsBusyLock(id))) return;
    await this.safeUnlink(BUSY_LOCK_PATH);
  }

  private async fileExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /** AE never started, so nothing will consume the request — take it back. */
  private async spawnFailure(
    err: Error,
    requestPath: string,
    started: number,
  ): Promise<EvalResult> {
    await this.safeUnlink(requestPath);
    return failure(
      "TRANSPORT",
      `could not launch After Effects (${this.afterFxPath}): ${err.message}`,
      {
        stack: err.stack ?? null,
        durationMs: Date.now() - started,
        hint:
          process.platform === "darwin"
            ? "Check that AE_MCP_EXE points at the After Effects .app bundle and that your MCP client is " +
              "allowed to control After Effects (System Settings → Privacy & Security → Automation)."
            : "Check that AE_MCP_EXE points at a real AfterFX.exe and that After Effects is not blocked by policy or antivirus.",
      },
    );
  }

  private toEvalResult(parsed: DispatcherResponse, durationMs: number): EvalResult {
    if (parsed.ok) {
      return {
        ok: true,
        result: parsed.result,
        error: null,
        errorCode: null,
        stack: null,
        logs: parsed.logs ?? [],
        durationMs,
      };
    }
    const dispatchFailure = parsed.phase === "dispatch";
    return {
      ok: false,
      result: null,
      error: dispatchFailure ? `dispatcher error: ${parsed.error}` : parsed.error,
      errorCode: dispatchFailure ? "DISPATCHER" : "JSX_THROW",
      line: typeof parsed.line === "number" ? parsed.line : null,
      stack: parsed.stack,
      logs: parsed.logs ?? [],
      durationMs,
    };
  }

  private async tryReadResponse(responsePath: string): Promise<DispatcherResponse | null> {
    try {
      const raw = await fs.readFile(responsePath, "utf8");
      if (!raw) return null;
      return JSON.parse(raw) as DispatcherResponse;
    } catch {
      // Missing (normal, still waiting) or a torn read of a file being renamed
      // into place — either way, poll again.
      return null;
    }
  }

  /** Unlink and report whether the file was actually there. */
  private async safeUnlink(p: string): Promise<boolean> {
    try {
      await fs.unlink(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Drop request/response files old enough that no caller can still be waiting
   * on them — leftovers from a crashed server or a killed AE — and instance
   * directories whose agent has been silent for as long. Best-effort and never
   * fatal; a shared mailbox means another live client may own files we are
   * looking at, so only clearly-expired ones are touched.
   */
  private async sweepStaleFiles(): Promise<void> {
    try {
      const entries = await fs.readdir(RUNTIME_DIR);
      const cutoff = Date.now() - STALE_RUNTIME_FILE_MS;
      for (const entry of entries) {
        const isMail =
          (entry.startsWith(REQUEST_PREFIX) || entry.startsWith(RESPONSE_PREFIX)) &&
          entry.endsWith(".json");
        if (!isMail) continue;
        const full = path.join(RUNTIME_DIR, entry);
        try {
          const stat = await fs.stat(full);
          if (stat.mtimeMs < cutoff) await fs.unlink(full);
        } catch {
          /* raced with another client; leave it alone */
        }
      }
      // An expired busy lock from a crashed run would otherwise make the first
      // call of this session wait out the stale threshold.
      try {
        const lockStat = await fs.stat(BUSY_LOCK_PATH);
        if (Date.now() - lockStat.mtimeMs > BUSY_LOCK_STALE_MS) await fs.unlink(BUSY_LOCK_PATH);
      } catch {
        /* no lock, or raced with its owner */
      }
      await sweepDeadInstanceDirs();
    } catch {
      /* directory missing or unreadable — setupError already covers it */
    }
  }
}

function failure(
  errorCode: AeErrorCode,
  message: string,
  extra: { stack?: string | null; durationMs?: number; hint?: string; dialogs?: AeDialog[] } = {},
): EvalResult {
  return {
    ok: false,
    result: null,
    error: extra.hint ? `${message}\n${extra.hint}` : message,
    errorCode,
    stack: extra.stack ?? null,
    logs: [],
    durationMs: extra.durationMs ?? 0,
    ...(extra.dialogs ? { dialogs: extra.dialogs } : {}),
  };
}

/** DIALOG_OPEN: what the dialogs say first, then what became of the call. */
function dialogFailure(dialogs: AeDialog[], outcome: string, started: number): EvalResult {
  return failure("DIALOG_OPEN", `${dialogBlockMessage(dialogs)} — ${outcome}`, {
    durationMs: Date.now() - started,
    hint: DIALOG_HINT,
    dialogs,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize a request for the mailbox.
 *
 * U+2028/U+2029 are legal raw inside JSON strings, so `JSON.stringify` emits
 * them as-is — but they are LINE TERMINATORS to the ES3 parser that reads this
 * file on the other side. One of them anywhere in the request (a layer name
 * inside an imported project document, say) would otherwise cut a string
 * literal in half mid-parse. `jsxVal` has always escaped them on the codegen
 * path; the transport path needs the same treatment, because `payload` carries
 * caller-supplied content that never passes through `jsxVal`.
 */
export function serializeRequest(request: unknown): string {
  return JSON.stringify(request)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
