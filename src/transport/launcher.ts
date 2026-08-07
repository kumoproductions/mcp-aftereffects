// How the dispatcher gets into After Effects, per platform.
//
// win32 — `AfterFX.exe -r dispatcher.jsx`. Fire-and-forget: the spawned
// process hands the script to the running AE instance (or boots one) and
// exits; its exit code says nothing. `-r` can carry only a file path, so the
// dispatcher must find the mailbox on its own (pointer file / shared temp-dir
// convention — see config.ts and dispatcher.jsx).
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
}

/** ExtendScript single-quoted string literal for a filesystem path. */
function jsxPath(p: string): string {
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
    };
  }
  return { command: aePath, args: ["-r", dispatcherJsx], diagnoseExit: false };
}
