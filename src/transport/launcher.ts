// How the dispatcher gets into After Effects, per platform.
//
// win32 — `AfterFX.exe -r dispatcher.jsx`. Fire-and-forget: the spawned
// process hands the script to the running AE instance and exits; its exit
// code says nothing. `-r` can carry only a file path, so the dispatcher must
// find the mailbox on its own (pointer file / shared temp-dir convention — see
// config.ts and dispatcher.jsx). When NO instance is registered to receive
// the hand-off — none running, or only ones started with `-m`, which never
// register — the spawned process instead becomes an instance itself, runs the
// script on an empty project and quits; the transport watches for that child
// outliving a forwarder (see PHANTOM_LAUNCH_MS).
//
// darwin — After Effects has no `-r` equivalent; the scripting entry point is
// AppleScript. `osascript` sends a DoScript event carrying a two-statement
// bootstrap that pins the mailbox path into `$.global` and evalFiles the
// dispatcher. Injecting the path sidesteps mailbox discovery entirely: Node's
// os.tmpdir() and ExtendScript's Folder.temp never have to agree on macOS.
// Unlike AfterFX.exe, osascript's exit code IS meaningful — non-zero with
// "Not authorized to send Apple events" (-1743) means the OS-level Automation
// permission was denied — so the transport watches it for fast failure.

import { DISPATCHER_JSX, RUNTIME_DIR } from "../config.js";

export interface LaunchPlan {
  command: string;
  args: string[];
  /**
   * Watch stderr + exit code and treat non-zero as a launch failure. True for
   * osascript (its exit code carries the Automation-permission diagnosis);
   * false for AfterFX.exe, whose exit code is noise.
   */
  diagnoseExit: boolean;
  /**
   * Treat a child that is still alive PHANTOM_LAUNCH_MS after spawning, with
   * the request unconsumed, as AE booting a throwaway instance rather than
   * forwarding. True for AfterFX.exe (a forwarder exits within a second);
   * false for osascript, which legitimately blocks for the DoScript duration.
   */
  detectPhantom: boolean;
}

/** ExtendScript single-quoted string literal for a filesystem path. */
export function jsxPath(p: string): string {
  return `'${p.replace(/\\/g, "/").replace(/'/g, "\\'")}'`;
}

/** AppleScript double-quoted string literal. */
function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * AppleScript addresses the application bundle, not the binary inside it —
 * accept either and normalize to the `.app` path.
 */
function appBundlePath(aePath: string): string {
  const normalized = aePath.replace(/\\/g, "/");
  const match = normalized.match(/^(.*?\.app)(\/|$)/);
  return match ? match[1] : normalized;
}

/**
 * How to start a NEW After Effects instance (instance.start), as opposed to
 * reaching a running one. Windows: `AfterFX.exe -m` — the spawned process IS
 * the instance, so the AE_MCP_INSTANCE the caller puts in its environment is
 * what jsx/agent.jsx reads. macOS: `open -n` starts a second copy of the
 * bundle; `--env` (macOS 12+) carries the variable into it. Verified on AE
 * 26.5 / macOS 26.4: the second instance starts and its agent registers under
 * that name. `open` exits at once, so the spawned pid is not After Effects'.
 */
export function buildInstanceLaunchPlan(
  aePath: string,
  instanceId: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "darwin") {
    return {
      command: "/usr/bin/open",
      args: ["-n", "--env", `AE_MCP_INSTANCE=${instanceId}`, "-a", appBundlePath(aePath)],
    };
  }
  return { command: aePath, args: ["-m"] };
}

export function buildLaunchPlan(
  aePath: string,
  platform: NodeJS.Platform = process.platform,
  runtimeDir: string = RUNTIME_DIR,
  dispatcherJsx: string = DISPATCHER_JSX,
): LaunchPlan {
  if (platform === "darwin") {
    const bootstrap =
      `$.global.AE_MCP_RUNTIME_DIR_OVERRIDE = ${jsxPath(runtimeDir)}; ` +
      `$.evalFile(${jsxPath(dispatcherJsx)});`;
    return {
      command: "/usr/bin/osascript",
      args: [
        // The AppleScript default event timeout is 2 minutes; DoScript blocks
        // osascript until the JSX returns, so lift it well past every built-in
        // call timeout (the longest is the 10-minute project import).
        "-e",
        "with timeout of 7200 seconds",
        "-e",
        `tell application ${appleScriptString(appBundlePath(aePath))} to DoScript ${appleScriptString(bootstrap)}`,
        "-e",
        "end timeout",
      ],
      diagnoseExit: true,
      detectPhantom: false,
    };
  }
  return { command: aePath, args: ["-r", dispatcherJsx], diagnoseExit: false, detectPhantom: true };
}
