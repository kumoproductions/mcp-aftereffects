// Dialog scan plumbing, without a desktop: the PowerShell runner is replaced,
// so what is under test is parsing, validation and the refusal paths.

import { afterEach, describe, expect, it } from "vitest";

import {
  describeDialogs,
  dialogBlockMessage,
  dismissAeDialog,
  parseDialogScan,
  scanAeDialogs,
  setPowerShellRunner,
} from "../src/transport/dialogs.js";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

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
  it("reports nothing off Windows without running anything", async () => {
    let ran = false;
    restore = setPowerShellRunner(async () => {
      ran = true;
      return JSON.stringify(SCANNED);
    });
    expect(await scanAeDialogs("darwin")).toEqual([]);
    expect(ran).toBe(false);
  });

  it("never turns a failed scan into a failure", async () => {
    restore = setPowerShellRunner(async () => {
      throw new Error("powershell.exe not found");
    });
    expect(await scanAeDialogs("win32")).toEqual([]);
  });
});

describe("dismissAeDialog", () => {
  it("refuses a handle that is not a number without running anything", async () => {
    let ran = false;
    restore = setPowerShellRunner(async () => {
      ran = true;
      return "{}";
    });
    const r = await dismissAeDialog("1; Stop-Process -Name AfterFX", "win32");
    expect(r).toEqual({ posted: false, closed: false, text: null });
    expect(ran).toBe(false);
  });

  it("passes the handle through the environment, not the script", async () => {
    let seen: Record<string, string> = {};
    let script = "";
    restore = setPowerShellRunner(async (s, env) => {
      seen = env;
      script = s;
      return JSON.stringify({ posted: true, closed: true, text: "Warning\r\n" });
    });
    const r = await dismissAeDialog("26744242", "win32");
    expect(r).toEqual({ posted: true, closed: true, text: "Warning" });
    expect(seen).toEqual({ AE_MCP_DIALOG_ID: "26744242" });
    expect(script).not.toContain("26744242");
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
