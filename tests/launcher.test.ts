// Per-platform launch plans. The darwin plan is the one worth testing hard:
// it nests an ExtendScript string inside an AppleScript string inside an argv
// element, and a quoting mistake at either layer only surfaces on a real Mac.

import { describe, expect, it } from "vitest";

import { buildLaunchPlan } from "../src/transport/launcher.js";

const AE_WIN = "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/AfterFX.exe";
const AE_MAC = "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app";
const RUNTIME = "/var/folders/ab/T/mcp-aftereffects/runtime";
const DISPATCHER = "/usr/local/lib/mcp-aftereffects/jsx/dispatcher.jsx";

describe("buildLaunchPlan (win32)", () => {
  it("spawns AfterFX.exe -r with the dispatcher path", () => {
    const plan = buildLaunchPlan(AE_WIN, "win32", "C:/t/runtime", "C:/pkg/jsx/dispatcher.jsx");
    expect(plan.command).toBe(AE_WIN);
    expect(plan.args).toEqual(["-r", "C:/pkg/jsx/dispatcher.jsx"]);
    expect(plan.diagnoseExit).toBe(false);
  });
});

describe("buildLaunchPlan (darwin)", () => {
  it("drives osascript with a DoScript bootstrap that injects the mailbox path", () => {
    const plan = buildLaunchPlan(AE_MAC, "darwin", RUNTIME, DISPATCHER);
    expect(plan.command).toBe("/usr/bin/osascript");
    expect(plan.diagnoseExit).toBe(true);

    const tellLine = plan.args.find((a) => a.startsWith("tell application"));
    expect(tellLine).toBeDefined();
    expect(tellLine).toContain(`"${AE_MAC}"`);
    expect(tellLine).toContain("DoScript");
    expect(tellLine).toContain(`$.global.AE_MCP_RUNTIME_DIR_OVERRIDE = '${RUNTIME}';`);
    expect(tellLine).toContain(`$.evalFile('${DISPATCHER}');`);
  });

  it("wraps the call in a long AppleScript timeout (DoScript blocks until the JSX returns)", () => {
    const plan = buildLaunchPlan(AE_MAC, "darwin", RUNTIME, DISPATCHER);
    expect(plan.args[0]).toBe("-e");
    expect(plan.args[1]).toMatch(/^with timeout of \d+ seconds$/);
    expect(plan.args.at(-1)).toBe("end timeout");
  });

  it("normalizes a path into the bundle when AE_MCP_EXE points inside the .app", () => {
    const inner = `${AE_MAC}/Contents/MacOS/AfterFX`;
    const plan = buildLaunchPlan(inner, "darwin", RUNTIME, DISPATCHER);
    const tellLine = plan.args.find((a) => a.startsWith("tell application"))!;
    expect(tellLine).toContain(`"${AE_MAC}"`);
    expect(tellLine).not.toContain("Contents/MacOS");
  });

  it("escapes both string layers: backslashes become slashes in JSX paths, quotes survive", () => {
    // A Windows-style runtime dir (possible when testing cross-platform) and a
    // hostile dispatcher path exercise the two escaping layers.
    const plan = buildLaunchPlan(AE_MAC, "darwin", "C:\\Temp\\runtime", "/pkg/it's here/d.jsx");
    const tellLine = plan.args.find((a) => a.startsWith("tell application"))!;
    // JSX path literal: backslashes normalized to forward slashes.
    expect(tellLine).toContain("'C:/Temp/runtime'");
    // Single quote inside a single-quoted JSX literal: escaped with \' — which
    // the AppleScript string layer then doubles into \\'.
    expect(tellLine).toContain("it\\\\'s here");
  });
});
