// Dialog scan plumbing, without a desktop: the PowerShell and osascript
// runners are replaced, so what is under test is parsing, validation and the
// refusal paths.

import { afterEach, describe, expect, it } from "vitest";

import {
  ACCESSIBILITY_HINT,
  DARWIN_SCRIPT,
  DIALOG_HINT,
  describeDialogs,
  dialogBlockMessage,
  dialogHint,
  dismissAeDialog,
  parseDialogScan,
  scanAeDialogs,
  setOsascriptRunner,
  setPowerShellRunner,
} from "../src/transport/dialogs.js";

let restores: Array<() => void> = [];
afterEach(() => {
  restores.forEach((restore) => restore());
  restores = [];
});
function stubPowerShell(run: Parameters<typeof setPowerShellRunner>[0]): void {
  restores.push(setPowerShellRunner(run));
}
function stubOsascript(run: Parameters<typeof setOsascriptRunner>[0]): void {
  restores.push(setOsascriptRunner(run));
}

const SCANNED = {
  pid: 126576,
  id: "26744242",
  text: "After Effects warning: 1 file is missing since you last saved this project.\r\n\r\n",
  width: 492,
  height: 260,
  window: "Adobe After Effects 2026 - C:\\work\\ShotA.aep",
};

describe("parseDialogScan", () => {
  it("accepts the single-object form PowerShell emits for one result", () => {
    const [d] = parseDialogScan(JSON.stringify(SCANNED));
    expect(d.text).toBe(
      "After Effects warning: 1 file is missing since you last saved this project.",
    );
    expect(d.id).toBe("26744242");
    expect(d.window).toContain("ShotA.aep");
  });

  it("accepts arrays, a BOM, and drops malformed entries", () => {
    const raw =
      "\uFEFF" + JSON.stringify([SCANNED, { pid: "x" }, null, { ...SCANNED, id: "7", window: "" }]);
    const out = parseDialogScan(raw);
    expect(out.map((d) => d.id)).toEqual(["26744242", "7"]);
    expect(out[1].window).toBeNull();
  });

  it("treats empty or non-JSON output as no dialogs", () => {
    expect(parseDialogScan("")).toEqual([]);
    expect(parseDialogScan("Add-Type : something went wrong")).toEqual([]);
  });
});

describe("scanAeDialogs", () => {
  it("reports nothing on unsupported platforms without running anything", async () => {
    let ran = false;
    stubPowerShell(async () => {
      ran = true;
      return JSON.stringify(SCANNED);
    });
    stubOsascript(async () => {
      ran = true;
      return JSON.stringify(SCANNED);
    });
    expect(await scanAeDialogs("linux")).toEqual([]);
    expect(ran).toBe(false);
  });

  it("never turns a failed scan into a failure", async () => {
    stubPowerShell(async () => {
      throw new Error("powershell.exe not found");
    });
    expect(await scanAeDialogs("win32")).toEqual([]);
  });
});

describe("dismissAeDialog", () => {
  it("refuses a handle that is not a number without running anything", async () => {
    let ran = false;
    stubPowerShell(async () => {
      ran = true;
      return "{}";
    });
    const r = await dismissAeDialog("1; Stop-Process -Name AfterFX", "win32");
    expect(r).toEqual({
      posted: false,
      closed: false,
      text: null,
      reason: "not_found",
    });
    expect(ran).toBe(false);
  });

  it("passes the handle through the environment, not the script", async () => {
    let seen: Record<string, string> = {};
    let script = "";
    stubPowerShell(async (s, env) => {
      seen = env;
      script = s;
      return JSON.stringify({ posted: true, closed: true, text: "Warning\r\n" });
    });
    const r = await dismissAeDialog("26744242", "win32");
    expect(r).toEqual({ posted: true, closed: true, text: "Warning" });
    expect(seen).toEqual({ AE_MCP_DIALOG_ID: "26744242" });
    expect(script).not.toContain("26744242");
  });

  it("reports a failed dismiss script as not found instead of throwing", async () => {
    stubPowerShell(async () => {
      throw new Error("powershell.exe not found");
    });
    expect(await dismissAeDialog("26744242", "win32")).toMatchObject({
      posted: false,
      reason: "not_found",
    });
  });
});

// What DARWIN_SCRIPT prints: the CG window number is part of the id, and
// `accessibility` says whether AX could read the text.
const MAC_SCANNED = {
  pid: 812,
  id: "812:4471",
  text: "3 files are missing since you last saved this project.",
  width: 420,
  height: 180,
  window: "Adobe After Effects 2026 - /Users/me/ShotA.aep",
  accessibility: true,
  startedAt: 1_790_000_000_000,
};

describe("macOS", () => {
  it("scans through osascript, never PowerShell", async () => {
    let ps = false;
    let env: Record<string, string> = {};
    let script = "";
    stubPowerShell(async () => {
      ps = true;
      return "[]";
    });
    stubOsascript(async (s, e) => {
      script = s;
      env = e;
      return JSON.stringify([MAC_SCANNED]) + "\n";
    });
    const [d] = await scanAeDialogs("darwin");
    expect(ps).toBe(false);
    expect(script).toBe(DARWIN_SCRIPT);
    expect(env).toEqual({ AE_MCP_DIALOG_MODE: "scan" });
    expect(d).toEqual(MAC_SCANNED);
  });

  it("keeps a dialog whose text could not be read, and says so", async () => {
    stubOsascript(async () =>
      JSON.stringify([{ ...MAC_SCANNED, text: "", window: null, accessibility: false }]),
    );
    const dialogs = await scanAeDialogs("darwin");
    expect(dialogs).toHaveLength(1);
    expect(describeDialogs(dialogs)).toBe("(text unavailable) (pid 812, id 812:4471)");
    expect(dialogHint(dialogs)).toBe(`${DIALOG_HINT} ${ACCESSIBILITY_HINT}`);
    expect(dialogHint([MAC_SCANNED])).toBe(DIALOG_HINT);
  });

  it("never turns a failed scan into a failure", async () => {
    stubOsascript(async () => {
      throw new Error("osascript: execution error (-2700)");
    });
    expect(await scanAeDialogs("darwin")).toEqual([]);
  });

  it("refuses ids that are not <pid>:<window> without running anything", async () => {
    let ran = false;
    stubOsascript(async () => {
      ran = true;
      return "{}";
    });
    for (const id of ["26744242", '812:4471\'; do shell script "rm -rf ~"', "812:", ":4471", ""]) {
      expect(await dismissAeDialog(id, "darwin")).toMatchObject({
        posted: false,
        reason: "not_found",
      });
    }
    expect(ran).toBe(false);
  });

  it("passes the id through the environment, not the script", async () => {
    let env: Record<string, string> = {};
    let script = "";
    stubOsascript(async (s, e) => {
      script = s;
      env = e;
      return JSON.stringify({
        posted: true,
        closed: true,
        text: "Warning",
        method: "cancel_button",
      });
    });
    expect(await dismissAeDialog("812:4471", "darwin")).toEqual({
      posted: true,
      closed: true,
      text: "Warning",
    });
    expect(env).toEqual({
      AE_MCP_DIALOG_MODE: "dismiss",
      AE_MCP_DIALOG_ID: "812:4471",
    });
    expect(script).toBe(DARWIN_SCRIPT);
  });

  it("carries why nothing was pressed", async () => {
    for (const reason of ["no_permission", "not_found"] as const) {
      stubOsascript(async () =>
        JSON.stringify({ posted: false, closed: false, text: null, reason }),
      );
      expect((await dismissAeDialog("812:4471", "darwin")).reason).toBe(reason);
    }
    stubOsascript(async () =>
      JSON.stringify({
        posted: false,
        closed: false,
        text: null,
        reason: "weird",
      }),
    );
    expect((await dismissAeDialog("812:4471", "darwin")).reason).toBe("not_found");
  });

  it("never sends keys anywhere but the matched dialog's process, and presses no default button", () => {
    // The Escape fallback targets the dialog's own pid; Return (36) and
    // keystroke-to-frontmost are never used.
    expect(DARWIN_SCRIPT).toContain("CGEventPostToPid(d.pid");
    expect(DARWIN_SCRIPT).not.toMatch(
      /CGEventPost\(|keystroke|System Events|AXDefaultButton|, 36,/,
    );
  });

  it("judges modality by AXModal and focuses the dialog before Escape", () => {
    // AE 26.5 dialogs sit at levels 0, 8 and 101 — only AXModal marks them all;
    // Escape reaches AE's focused window, so the dialog must be focused first.
    expect(DARWIN_SCRIPT).toContain("'AXModal'");
    const focus = DARWIN_SCRIPT.indexOf("$('AXFocused'), $.kCFBooleanTrue");
    expect(focus).toBeGreaterThan(-1);
    expect(focus).toBeLessThan(DARWIN_SCRIPT.indexOf("CGEventPostToPid"));
  });
});

describe("messages", () => {
  it("quotes each dialog on one line with where it is", () => {
    const [d] = parseDialogScan(JSON.stringify({ ...SCANNED, text: "Line one\r\nLine two" }));
    expect(describeDialogs([d])).toBe(
      `"Line one Line two" (pid 126576 in "Adobe After Effects 2026 - C:\\work\\ShotA.aep", id 26744242)`,
    );
    expect(dialogBlockMessage([d, d])).toMatch(
      /^After Effects is showing 2 modal dialogs, .* until they are closed/,
    );
  });
});
