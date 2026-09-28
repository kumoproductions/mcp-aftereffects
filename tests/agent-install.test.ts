// Installing the Startup-folder stub: where it goes per platform and AE
// version, what it contains, and that install/status/uninstall agree.
// Everything runs against temp directories — the real AE profile is never
// touched.

import { mkdtempSync, promises as fs, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  aeProfileRoot,
  agentInstallStatus,
  installAgent,
  listAeVersionDirs,
  startupDirFor,
  stubSource,
  uninstallAgent,
} from "../src/agent-install.js";
import { AGENT_JSX, AGENT_STUB_FILENAME, RUNTIME_DIR, RUNTIME_ROOT } from "../src/config.js";
import { parseCliArgs, runCli } from "../src/cli.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-ae-agent-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("profile locations", () => {
  it("follows %APPDATA% on Windows and ~/Library/Preferences on macOS", () => {
    expect(
      aeProfileRoot("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me"),
    ).toBe(path.join("C:\\Users\\me\\AppData\\Roaming", "Adobe", "After Effects"));
    expect(aeProfileRoot("win32", {}, "C:\\Users\\me")).toBe(
      path.join("C:\\Users\\me", "AppData", "Roaming", "Adobe", "After Effects"),
    );
    expect(aeProfileRoot("darwin", {}, "/Users/me")).toBe(
      path.join("/Users/me", "Library", "Preferences", "Adobe", "After Effects"),
    );
  });

  it("lists version folders newest first and ignores everything else", async () => {
    for (const name of ["25.0", "26.3", "26.0", "Logs", "26.10"]) {
      await fs.mkdir(path.join(tmp, name));
    }
    await fs.writeFile(path.join(tmp, "27.0"), "a file, not a folder", "utf8");
    expect(await listAeVersionDirs(tmp)).toEqual(["26.10", "26.3", "26.0", "25.0"]);
    expect(await listAeVersionDirs(path.join(tmp, "missing"))).toEqual([]);
  });

  it("targets <version>/Scripts/Startup", () => {
    expect(startupDirFor("/p", "26.3")).toBe(path.join("/p", "26.3", "Scripts", "Startup"));
  });
});

describe("stub", () => {
  it("evalFiles the packaged agent and pins the runtime root", () => {
    const src = stubSource();
    expect(src).toContain(`new File('${AGENT_JSX.replace(/\\/g, "/")}')`);
    expect(src).toContain(`var runtimeRoot = '${RUNTIME_ROOT.replace(/\\/g, "/")}';`);
    expect(src).toContain("$.global.AE_MCP_RUNTIME_ROOT_OVERRIDE = runtimeRoot;");
    // The mailbox is pinned at install time. The agent must never discover it
    // through runtime-dir.txt: a pointer any local writer can plant would
    // redirect every instance for the rest of the session.
    expect(src).toContain(`$.global.AE_MCP_AGENT_MAILBOX = '${RUNTIME_DIR.replace(/\\/g, "/")}';`);
    expect(src).toContain("$.evalFile(agentFile)");
    // A load failure is logged where `mcp-aftereffects instances` users look,
    // never surfaced as a dialog that would block every instance at startup.
    expect(src).toContain("agent-fatal.log");
    // A stub that finds no agent (package removed) must be a silent no-op,
    // not a modal at every launch of every instance.
    expect(src).toContain("if (!agentFile.exists) return;");
  });

  it("stays ES3 and quotes a hostile path", () => {
    const src = stubSource("C:\\it's\\agent.jsx", "/tmp/x");
    expect(src).toContain("'C:/it\\'s/agent.jsx'");
    expect(src).not.toMatch(/\b(let|const)\b/);
    expect(src).not.toContain("=>");
  });
});

describe("install / status / uninstall", () => {
  it("writes the stub into every version's Startup folder, then reports it up to date", async () => {
    await fs.mkdir(path.join(tmp, "26.3"));
    await fs.mkdir(path.join(tmp, "25.0"));
    const opts = { platform: "win32" as const, env: { APPDATA: tmp }, home: tmp };
    // aeProfileRoot appends Adobe/After Effects to APPDATA — mirror that.
    const root = aeProfileRoot("win32", { APPDATA: tmp }, tmp);
    await fs.mkdir(path.join(root, "26.3"), { recursive: true });
    await fs.mkdir(path.join(root, "25.0"), { recursive: true });

    const first = await installAgent(opts);
    expect(first.written).toEqual([
      path.join(startupDirFor(root, "26.3"), AGENT_STUB_FILENAME),
      path.join(startupDirFor(root, "25.0"), AGENT_STUB_FILENAME),
    ]);
    expect(first.unchanged).toEqual([]);
    for (const p of first.written) expect(await fs.readFile(p, "utf8")).toBe(stubSource());

    const second = await installAgent(opts);
    expect(second.written).toEqual([]);
    expect(second.unchanged).toHaveLength(2);

    const status = await agentInstallStatus(opts);
    expect(status.map((s) => [s.version, s.installed, s.current])).toEqual([
      ["26.3", true, true],
      ["25.0", true, true],
    ]);

    // A stub from an older package (different path) is installed but stale.
    await fs.writeFile(first.written[1], "// old stub\n", "utf8");
    const stale = await agentInstallStatus(opts);
    expect(stale[1]).toMatchObject({ installed: true, current: false });

    const removed = await uninstallAgent(opts);
    expect(removed.removed).toEqual(first.written);
    for (const p of first.written) await expect(fs.access(p)).rejects.toThrow();
  });

  it("honours --version, --dir and --dry-run", async () => {
    const root = aeProfileRoot("win32", { APPDATA: tmp }, tmp);
    await fs.mkdir(path.join(root, "26.3"), { recursive: true });
    await fs.mkdir(path.join(root, "25.0"), { recursive: true });
    const base = { platform: "win32" as const, env: { APPDATA: tmp }, home: tmp };

    const one = await installAgent({ ...base, version: "26.3" });
    expect(one.written).toHaveLength(1);
    expect(one.written[0]).toContain("26.3");

    const custom = path.join(tmp, "custom-startup");
    const dry = await installAgent({ ...base, dir: custom, dryRun: true });
    expect(dry.written).toEqual([path.join(custom, AGENT_STUB_FILENAME)]);
    await expect(fs.access(custom)).rejects.toThrow();
  });

  it("refuses to install where After Effects has never run", async () => {
    await expect(
      installAgent({ platform: "win32", env: { APPDATA: tmp }, home: tmp }),
    ).rejects.toThrow(/no After Effects version folder/);
  });
});

describe("cli", () => {
  it("parses subcommand flags", () => {
    expect(parseCliArgs(["install-agent", "--version", "26.3", "--dry-run"])).toEqual({
      command: "install-agent",
      version: "26.3",
      dryRun: true,
      unknown: [],
    });
    expect(parseCliArgs(["agent-status", "--dir", "/x", "--bogus"])).toMatchObject({
      command: "agent-status",
      dir: "/x",
      unknown: ["--bogus"],
    });
    expect(parseCliArgs([])).toMatchObject({ command: "help" });
  });

  it("prints usage for help and unknown commands with the right exit codes", async () => {
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    expect(await runCli(["help"], out)).toBe(0);
    expect(lines.join("\n")).toContain("install-agent");
    lines.length = 0;
    expect(await runCli(["frobnicate"], out)).toBe(2);
    expect(lines[0]).toContain("unknown command");
    lines.length = 0;
    expect(await runCli(["instances", "--nope"], out)).toBe(2);
  });

  it("installs into an explicit directory and reports it", async () => {
    const lines: string[] = [];
    const dir = path.join(tmp, "startup");
    expect(await runCli(["install-agent", "--dir", dir, "--dry-run"], (l) => lines.push(l))).toBe(
      0,
    );
    expect(lines[0]).toContain("would write");
    await expect(fs.access(dir)).rejects.toThrow();

    lines.length = 0;
    expect(await runCli(["install-agent", "--dir", dir], (l) => lines.push(l))).toBe(0);
    expect(lines[0]).toContain("wrote");
    await expect(fs.access(path.join(dir, AGENT_STUB_FILENAME))).resolves.toBeUndefined();

    lines.length = 0;
    expect(await runCli(["agent-status", "--dir", dir], (l) => lines.push(l))).toBe(0);
    expect(lines[0]).toContain("installed");

    lines.length = 0;
    expect(await runCli(["uninstall-agent", "--dir", dir], (l) => lines.push(l))).toBe(0);
    expect(lines[0]).toContain("removed");
  });

  it("lists instances without failing when none are registered", async () => {
    const lines: string[] = [];
    expect(await runCli(["instances"], (l) => lines.push(l))).toBe(0);
    expect(lines[0]).toContain("mailbox:");
  });
});
