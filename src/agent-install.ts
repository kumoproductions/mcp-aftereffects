// Installing the resident agent into After Effects.
//
// After Effects runs every script in its Scripts/Startup folder at launch, in
// every instance — the only hook that reaches instances started with
// `AfterFX.exe -m`. The USER-LEVEL folder needs no admin rights:
//
//   Windows  %APPDATA%\Adobe\After Effects\<major.minor>\Scripts\Startup
//   macOS    ~/Library/Preferences/Adobe/After Effects/<major.minor>/Scripts/Startup
//
// (Windows verified on AE 26.3, macOS on AE 26.5 / macOS 26.4.) One folder per AE version,
// so an AE update means running `install-agent` again.
//
// What lands there is a STUB, not the agent: a few lines that pin the mailbox
// (RUNTIME_DIR) and runtime root Node computed, then `$.evalFile` jsx/agent.jsx
// out of this package. The agent and its #includes stay in the package, so
// updating the package updates the agent at AE's next launch; the stub only
// needs rewriting when the package moves or the mailbox location changes
// (AE_MCP_RUNTIME_DIR), both of which `agentInstallStatus` reports as stale.
//
// The mailbox is pinned rather than discovered on purpose: the agent polls for
// the whole After Effects session, and following the runtime-dir.txt pointer
// the dispatcher uses would let anyone who can write that pointer redirect
// every instance to a mailbox of their own. See jsx/agent.jsx.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AGENT_JSX, AGENT_STUB_FILENAME, RUNTIME_DIR, RUNTIME_ROOT } from "./config.js";
import { jsxPath } from "./transport/launcher.js";

/** Where After Effects keeps per-user, per-version files. */
export function aeProfileRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Adobe", "After Effects");
  }
  return path.join(home, "Library", "Preferences", "Adobe", "After Effects");
}

/** Version folders ("26.3", "25.0", …) present under the profile root, newest first. */
export async function listAeVersionDirs(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const versions = entries
    .filter((e) => e.isDirectory() && /^\d+\.\d+$/.test(e.name))
    .map((e) => e.name);
  return versions.sort((a, b) => compareVersions(b, a));
}

function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor] = a.split(".").map(Number);
  const [bMajor, bMinor] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

export function startupDirFor(root: string, version: string): string {
  return path.join(root, version, "Scripts", "Startup");
}

/**
 * The bootstrap stub. ES3, self-guarding: a missing agent file (package
 * uninstalled or moved) is a silent no-op rather than a modal at every AE
 * launch; anything the agent itself throws is caught by its own top-level
 * guard, and a failure to LOAD it (an #include that no longer resolves, a
 * syntax error) is written to <runtime root>/agent-fatal.log instead of
 * surfacing as a dialog that would block every instance at startup.
 */
export function stubSource(
  agentJsx: string = AGENT_JSX,
  runtimeRoot: string = RUNTIME_ROOT,
  mailbox: string = RUNTIME_DIR,
): string {
  return [
    "// mcp-aftereffects resident agent bootstrap.",
    "// Written by `mcp-aftereffects install-agent`; remove with `uninstall-agent`.",
    "// Loads jsx/agent.jsx from the package so a package update takes effect at",
    "// the next After Effects launch without reinstalling this stub. The mailbox",
    "// path below is fixed here on purpose; re-run install-agent to change it.",
    "(function () {",
    `    var agentFile = new File(${jsxPath(agentJsx)});`,
    "    if (!agentFile.exists) return;",
    `    var runtimeRoot = ${jsxPath(runtimeRoot)};`,
    "    $.global.AE_MCP_RUNTIME_ROOT_OVERRIDE = runtimeRoot;",
    `    $.global.AE_MCP_AGENT_MAILBOX = ${jsxPath(mailbox)};`,
    "    try {",
    "        $.evalFile(agentFile);",
    "    } catch (eLoad) {",
    "        try {",
    '            var why = (eLoad && eLoad.message) ? String(eLoad.message) : "unknown error";',
    '            if (eLoad && eLoad.line) why += " (line " + String(eLoad.line) + ")";',
    '            var log = new File(runtimeRoot + "/agent-fatal.log");',
    '            log.encoding = "UTF-8";',
    '            if (log.open("a")) {',
    '                log.writeln("[" + new Date().toString() + "] stub: could not load " + agentFile.fsName + ": " + why);',
    "                log.close();",
    "            }",
    "        } catch (eLog) { /* nothing left to try */ }",
    "    }",
    "})();",
    "",
  ].join("\n");
}

export interface StubStatus {
  version: string;
  stubPath: string;
  /** A stub exists at that path. */
  installed: boolean;
  /** …and its contents match what this package would write now. */
  current: boolean;
}

export interface InstallOptions {
  /** Only this AE version folder (e.g. "26.3"). Default: every version present. */
  version?: string;
  /** Write the stub into exactly this directory instead of the profile-derived ones. */
  dir?: string;
  dryRun?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

async function targetStartupDirs(
  opts: InstallOptions,
): Promise<Array<{ version: string; dir: string }>> {
  if (opts.dir) return [{ version: "custom", dir: path.resolve(opts.dir) }];
  const root = aeProfileRoot(opts.platform, opts.env, opts.home);
  const versions = opts.version ? [opts.version] : await listAeVersionDirs(root);
  return versions.map((version) => ({ version, dir: startupDirFor(root, version) }));
}

export async function agentInstallStatus(opts: InstallOptions = {}): Promise<StubStatus[]> {
  const expected = stubSource();
  const statuses: StubStatus[] = [];
  for (const { version, dir } of await targetStartupDirs(opts)) {
    const stubPath = path.join(dir, AGENT_STUB_FILENAME);
    let installed = false;
    let current = false;
    try {
      const actual = await fs.readFile(stubPath, "utf8");
      installed = true;
      current = actual === expected;
    } catch {
      /* not installed */
    }
    statuses.push({ version, stubPath, installed, current });
  }
  return statuses;
}

export interface InstallReport {
  /** Stub paths written (or that would be, on a dry run). */
  written: string[];
  /** Stub paths already up to date. */
  unchanged: string[];
}

/**
 * Write the stub into every target Startup folder, creating Scripts/Startup
 * where missing. A folder for an AE version that was never launched does not
 * exist yet and is not created — there is nothing to hook.
 */
export async function installAgent(opts: InstallOptions = {}): Promise<InstallReport> {
  const report: InstallReport = { written: [], unchanged: [] };
  const targets = await targetStartupDirs(opts);
  if (targets.length === 0) {
    throw new Error(
      `no After Effects version folder found under ${aeProfileRoot(opts.platform, opts.env, opts.home)} — ` +
        "launch After Effects once so it creates its profile, or pass --dir <Scripts/Startup folder>",
    );
  }
  const source = stubSource();
  for (const { dir } of targets) {
    const stubPath = path.join(dir, AGENT_STUB_FILENAME);
    try {
      if ((await fs.readFile(stubPath, "utf8")) === source) {
        report.unchanged.push(stubPath);
        continue;
      }
    } catch {
      /* absent — write it */
    }
    report.written.push(stubPath);
    if (opts.dryRun) continue;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(stubPath, source, "utf8");
  }
  return report;
}

export async function uninstallAgent(opts: InstallOptions = {}): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  for (const { dir } of await targetStartupDirs(opts)) {
    const stubPath = path.join(dir, AGENT_STUB_FILENAME);
    try {
      await fs.access(stubPath);
    } catch {
      continue;
    }
    removed.push(stubPath);
    if (!opts.dryRun) await fs.unlink(stubPath);
  }
  return { removed };
}
