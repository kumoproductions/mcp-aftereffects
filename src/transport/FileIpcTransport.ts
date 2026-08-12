import { spawn } from "node:child_process";
import { mkdirSync, promises as fs, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

import {
  BUSY_LOCK_PATH,
  BUSY_LOCK_REFRESH_MS,
  BUSY_LOCK_STALE_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_LAUNCH_ATTEMPTS,
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
  requestPathFor,
  resolveAfterFxPath,
  responsePathFor,
  runtimeDirWarnings,
} from "../config.js";
import type { AeErrorCode } from "../errors.js";
import type { AeTransport, EvalRequest, EvalResult } from "./AeTransport.js";
import { buildLaunchPlan } from "./launcher.js";

interface SpawnState {
  error: Error | null;
}

interface DispatcherResponse {
  id: string | null;
  ok: boolean;
  /** "dispatch" = failed before running our code; "execute" = our code threw. */
  phase?: "dispatch" | "execute";
  result: unknown;
  error: string | null;
  stack: string | null;
  logs: string[];
}

/**
 * File-IPC transport: for each call, write `request-<id>.json`, launch the
 * dispatcher inside AE (`AfterFX.exe -r` on Windows, `osascript`/DoScript on
 * macOS — see launcher.ts), then poll `response-<id>.json`.
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
 * After Effects is resolved lazily on the first call (not in the constructor)
 * so the MCP server can start — and list its tools — on a machine where AE
 * isn't installed yet; the helpful "set AE_MCP_EXE" error surfaces per call.
 */
export class FileIpcTransport implements AeTransport {
  private afterFxPath: string | null = null;
  private inflight: Promise<unknown> = Promise.resolve();
  /** Non-null when the mailbox directory is unusable; reported per call. */
  private readonly setupError: string | null = null;

  constructor() {
    try {
      // 0o700: write access to the mailbox is code execution inside AE (see
      // RUNTIME_DIR_MODE). recursive:true applies the mode to what it creates;
      // a directory that already exists keeps its mode, which is what
      // runtimeDirWarnings reports on below.
      mkdirSync(RUNTIME_DIR, { recursive: true, mode: RUNTIME_DIR_MODE });
      if (RUNTIME_DIR_IS_CUSTOM) {
        // dispatcher.jsx derives the default mailbox path itself; when
        // AE_MCP_RUNTIME_DIR moves it, this pointer is how the JSX side finds
        // it. Written at the fixed default location, which is always writable.
        mkdirSync(RUNTIME_ROOT, { recursive: true, mode: RUNTIME_DIR_MODE });
        writeFileSync(RUNTIME_POINTER_PATH, RUNTIME_DIR, "utf8");
      } else {
        // Back on the default: clear any pointer a previous custom-dir run
        // left behind, or the dispatcher would keep looking somewhere we no
        // longer write to.
        try {
          unlinkSync(RUNTIME_POINTER_PATH);
        } catch {
          /* nothing to clear */
        }
      }
      // Reported after both directories exist: the pointer directory is part of
      // the same trust boundary (dispatcher.jsx follows runtime-dir.txt before
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

    try {
      this.afterFxPath ??= resolveAfterFxPath();
    } catch (err) {
      return failure("AE_NOT_FOUND", err instanceof Error ? err.message : String(err), {
        durationMs: Date.now() - started,
      });
    }

    const id = randomUUID();
    const requestPath = requestPathFor(id);
    const responsePath = responsePathFor(id);

    const request = {
      id,
      label: req.label ?? "action",
      code: req.code,
      payload: req.payload ?? null,
      // Sent explicitly rather than by omission: the dispatcher defaults a
      // missing field to true, and "group this" must not depend on a key
      // surviving the trip.
      undoGroup: req.undoGroup !== false,
      suppressDialogs: req.suppressDialogs !== false,
    };

    // 1. Write the request atomically (tmp + rename). The tmp name is dotted so
    // it can never match the dispatcher's `request-*.json` glob mid-write.
    const tmpRequestPath = path.join(RUNTIME_DIR, `.${REQUEST_PREFIX}${id}.json.tmp`);
    await fs.writeFile(tmpRequestPath, serializeRequest(request), "utf8");
    await fs.rename(tmpRequestPath, requestPath);

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
      const spawnState: SpawnState = { error: null };
      this.launchDispatcher(spawnState);
      if (spawnState.error !== null) {
        return await this.spawnFailure(spawnState.error, requestPath, started);
      }

      // 4. Poll for OUR response file. While polling: keep the busy lock
      // fresh, and relaunch the dispatcher if the request is still sitting
      // unconsumed — that is the signature of AE having refused the script
      // (its "second script" warning) because something we cannot see (a user
      // panel, a startup script) was running when ours arrived.
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
        if (
          !requestConsumed &&
          attempts < MAX_LAUNCH_ATTEMPTS &&
          now - lastLaunchAt >= RELAUNCH_UNCONSUMED_AFTER_MS * attempts
        ) {
          if (await this.fileExists(requestPath)) {
            attempts++;
            lastLaunchAt = now;
            this.launchDispatcher(spawnState);
          } else {
            requestConsumed = true;
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
   * Spawn the dispatcher launch command. Errors land in `state.error` rather
   * than throwing: a spawn failure (ENOENT, EACCES, EFTYPE, …) can never
   * produce a response, so the poll loop checks the state every tick instead
   * of waiting out the full timeout. When the plan says the exit code is
   * meaningful (osascript), a non-zero exit is treated the same way — that is
   * how a denied macOS Automation permission (-1743) surfaces in seconds.
   */
  private launchDispatcher(state: SpawnState): void {
    const launch = buildLaunchPlan(this.afterFxPath as string);
    try {
      const child = spawn(launch.command, launch.args, {
        stdio: launch.diagnoseExit ? ["ignore", "ignore", "pipe"] : "ignore",
        windowsHide: true,
        detached: false,
      });
      // We don't wait for the child; AE may keep it short- or long-lived
      // depending on whether a new instance was started. Just make sure we
      // don't leak a handle that blocks node exit.
      child.unref?.();
      child.on("error", (err) => {
        state.error = err;
      });
      if (launch.diagnoseExit) {
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          if (stderr.length < 4096) stderr += chunk;
        });
        child.on("exit", (code) => {
          if (code !== null && code !== 0 && state.error === null) {
            const detail = stderr.trim();
            state.error = new Error(
              `${launch.command} exited with code ${code}${detail ? `: ${detail}` : ""}`,
            );
          }
        });
      }
    } catch (err) {
      state.error = err instanceof Error ? err : new Error(String(err));
    }
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
   * on them — leftovers from a crashed server or a killed AE. Best-effort and
   * never fatal; a shared mailbox means another live client may own files we
   * are looking at, so only clearly-expired ones are touched.
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
    } catch {
      /* directory missing or unreadable — setupError already covers it */
    }
  }
}

function failure(
  errorCode: AeErrorCode,
  message: string,
  extra: { stack?: string | null; durationMs?: number; hint?: string } = {},
): EvalResult {
  return {
    ok: false,
    result: null,
    error: extra.hint ? `${message}\n${extra.hint}` : message,
    errorCode,
    stack: extra.stack ?? null,
    logs: [],
    durationMs: extra.durationMs ?? 0,
  };
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
