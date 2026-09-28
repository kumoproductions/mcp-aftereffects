// Modal dialogs After Effects is showing — seen from OUTSIDE the process.
//
// While After Effects shows a modal dialog no script runs: not the `-r`
// dispatcher, not the resident agent's scheduled task. From the mailbox that
// looks exactly like a hung or vanished After Effects, and the dialog itself
// is often hidden behind the main window, so the only honest report used to
// be "is AE showing a modal dialog?". This module answers that question
// directly on Windows.
//
// What was verified on AE 26.5 (Windows 11):
//   - Every alert (missing files on project open, "Project file doesn't
//     exist", "Cannot run a script while a modal dialog is waiting for
//     response") is a titleless, visible top-level `#32770` owned by
//     AfterFX.exe. GetWindowText on it is empty, but its message sits in a
//     child `Edit` control that answers WM_GETTEXT across processes.
//   - Posting Escape (WM_KEYDOWN/UP VK_ESCAPE) to the dialog closes it — an
//     OK-only warning, a script alert, and a "Save changes before closing?"
//     prompt, which it CANCELS: the project stays open and dirty, neither
//     saved nor discarded. Escape is the only key sent, because Enter presses
//     whatever the default button happens to be. The resident agent's
//     scheduled task resumes as soon as the dialog is gone.
//   - Splash / Home-screen windows are `#32770` too but carry no text, so
//     "has readable text" is what separates an alert from chrome.
//
// The scan shells out to PowerShell with a small inline C# helper (~0.6 s),
// so it runs only where a failure has to be explained or a caller asked —
// never on the happy path. macOS has no equivalent yet: every function here
// reports "nothing found" there.

import { execFile } from "node:child_process";

export interface AeDialog {
  /** AfterFX.exe process that owns the dialog. */
  pid: number;
  /**
   * Opaque dialog id — what `instance.dismiss_dialog` takes. On Windows the
   * window handle in decimal; other platforms will use their own scheme.
   */
  id: string;
  /** The dialog's message, whitespace-trimmed. */
  text: string;
  width: number;
  height: number;
  /** Main-window title of the owning process (names the project it has open). */
  window: string | null;
}

export interface DismissResult {
  /** The handle named a visible After Effects dialog and Escape was posted. */
  posted: boolean;
  /** The dialog was gone shortly afterwards. */
  closed: boolean;
  /** What the dialog said (null when it was not found). */
  text: string | null;
}

/** Runs a PowerShell script and resolves with its stdout. Injectable for tests. */
export type PowerShellRunner = (script: string, env: Record<string, string>) => Promise<string>;

const SCAN_TIMEOUT_MS = 8_000;

// Shared C# helper. Kept to what the scan and the dismiss need; everything
// goes through SendMessageTimeout so a hung window cannot hang the scan.
const HELPER = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AeMcpWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static string Txt(IntPtr h) { var s = new StringBuilder(8192); IntPtr r; SendMessageTimeout(h, 0x000D, (IntPtr)8192, s, 2, 500, out r); return s.ToString(); }
  public static List<IntPtr> Tops() { var l = new List<IntPtr>(); EnumWindows((h, p) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static string Message(IntPtr w) {
    var parts = new List<string>();
    EnumChildWindows(w, (h, p) => {
      var c = Cls(h);
      if (c == "Edit" || c == "Static") { var t = Txt(h).Trim(); if (t.Length > 0) parts.Add(t); }
      return true;
    }, IntPtr.Zero);
    return String.Join("\n", parts);
  }
}
"@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ae = @{}
Get-Process AfterFX -ErrorAction SilentlyContinue | ForEach-Object { $ae[[int]$_.Id] = $_.MainWindowTitle }
function Get-AeDialogs {
  $found = @()
  foreach ($h in [AeMcpWin]::Tops()) {
    $p = [uint32]0; [void][AeMcpWin]::GetWindowThreadProcessId($h, [ref]$p)
    if (-not $ae.ContainsKey([int]$p)) { continue }
    if (-not [AeMcpWin]::IsWindowVisible($h)) { continue }
    if ([AeMcpWin]::Cls($h) -ne "#32770") { continue }
    $text = [AeMcpWin]::Message($h)
    if ($text.Length -eq 0) { continue }
    $r = New-Object AeMcpWin+RECT; [void][AeMcpWin]::GetWindowRect($h, [ref]$r)
    $found += [pscustomobject]@{ pid = [int]$p; id = [string][int64]$h; text = $text; width = $r.R - $r.L; height = $r.B - $r.T; window = $ae[[int]$p] }
  }
  return ,$found
}
`;

const SCAN_SCRIPT = `${HELPER}
ConvertTo-Json -Compress -Depth 3 -InputObject (Get-AeDialogs)
`;

// The handle arrives through the environment, never spliced into the
// script: nothing a caller passes is ever parsed as PowerShell.
const DISMISS_SCRIPT = `${HELPER}
$target = [string]$env:AE_MCP_DIALOG_ID
$vk = 0x1B
$match = @(Get-AeDialogs | Where-Object { $_.id -eq $target })
if ($match.Count -eq 0) { ConvertTo-Json -Compress -InputObject @{ posted = $false; closed = $false; text = $null }; exit }
$h = [IntPtr][int64]$target
[void][AeMcpWin]::PostMessage($h, 0x0100, [IntPtr]$vk, [IntPtr]0)
[void][AeMcpWin]::PostMessage($h, 0x0101, [IntPtr]$vk, [IntPtr]0)
$closed = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 100
  if (-not [AeMcpWin]::IsWindow($h) -or -not [AeMcpWin]::IsWindowVisible($h)) { $closed = $true; break }
}
ConvertTo-Json -Compress -InputObject @{ posted = $true; closed = $closed; text = $match[0].text }
`;

function encodeScript(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const defaultRunner: PowerShellRunner = (script, env) =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodeScript(script),
      ],
      {
        env: { ...process.env, ...env },
        timeout: SCAN_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

let runner: PowerShellRunner = defaultRunner;

/** Swap the PowerShell runner (tests). Returns a function restoring the previous one. */
export function setPowerShellRunner(next: PowerShellRunner): () => void {
  const prev = runner;
  runner = next;
  return () => {
    runner = prev;
  };
}

function scanSupported(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/** Parse the scan's JSON output; anything unexpected yields no dialogs. */
export function parseDialogScan(raw: string): AeDialog[] {
  const trimmed = raw.replace(/^﻿/, "").trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: AeDialog[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.text !== "string" || typeof e.pid !== "number")
      continue;
    out.push({
      pid: e.pid,
      id: e.id,
      text: e.text.replace(/\r\n/g, "\n").trim(),
      width: typeof e.width === "number" ? e.width : 0,
      height: typeof e.height === "number" ? e.height : 0,
      window: typeof e.window === "string" && e.window.length > 0 ? e.window : null,
    });
  }
  return out;
}

/**
 * The modal dialogs every running After Effects is showing. Best-effort:
 * unsupported platform, no PowerShell, or a scan that fails all report none —
 * this only ever adds information to a failure, it must not cause one.
 */
export async function scanAeDialogs(
  platform: NodeJS.Platform = process.platform,
): Promise<AeDialog[]> {
  if (!scanSupported(platform)) return [];
  try {
    return parseDialogScan(await runner(SCAN_SCRIPT, {}));
  } catch {
    return [];
  }
}

/**
 * Close a dialog with Escape — its cancel action, never a decision (see the
 * header: a save prompt is cancelled, not answered). The handle must name a
 * dialog the scan would report
 * right now — anything else, including a window that has since closed or a
 * handle that was never an After Effects dialog, is refused inside the
 * script, so a stale or made-up handle can never send keys elsewhere.
 */
export async function dismissAeDialog(
  id: string,
  platform: NodeJS.Platform = process.platform,
): Promise<DismissResult> {
  if (!scanSupported(platform) || !/^\d{1,20}$/.test(id)) {
    return { posted: false, closed: false, text: null };
  }
  const raw = await runner(DISMISS_SCRIPT, {
    AE_MCP_DIALOG_ID: id,
  });
  try {
    const r = JSON.parse(raw.replace(/^﻿/, "").trim()) as Partial<DismissResult>;
    return {
      posted: r.posted === true,
      closed: r.closed === true,
      text: typeof r.text === "string" ? r.text.replace(/\r\n/g, "\n").trim() : null,
    };
  } catch {
    return { posted: false, closed: false, text: null };
  }
}

/** One line per dialog, for error messages. */
export function describeDialogs(dialogs: AeDialog[]): string {
  return dialogs
    .map((d) => {
      const where = d.window ? ` in "${d.window}"` : "";
      return `"${d.text.replace(/\s*\n\s*/g, " ")}" (pid ${d.pid}${where}, id ${d.id})`;
    })
    .join("; ");
}

/** The sentence a failure carries when dialogs were found. */
export function dialogBlockMessage(dialogs: AeDialog[]): string {
  const n = dialogs.length;
  return (
    `After Effects is showing ${n === 1 ? "a modal dialog" : `${n} modal dialogs`}, and no script can run until ` +
    `${n === 1 ? "it is" : "they are"} closed: ${describeDialogs(dialogs)}`
  );
}

export const DIALOG_HINT =
  "`instance.dismiss_dialog { id }` closes it with Escape — the dialog's cancel action, so a warning is " +
  "acknowledged and a question (save changes?) is cancelled, never answered — then retry. If the user needs " +
  "to answer it, ask them; it is often hidden behind the After Effects main window.";
