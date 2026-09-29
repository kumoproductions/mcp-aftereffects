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
// never on the happy path.
//
// macOS runs a JXA script through osascript (~0.13 s). What was verified on
// AE 26.5 (macOS 26.4):
//   - While a modal dialog is up, DoScript blocks until its AppleEvent
//     timeout (-1712) — no error, and no extra alert stacks up. A script that
//     timed out this way did NOT run once the dialog closed. The agent stops
//     ticking and resumes on its own when the dialog goes.
//   - AE's dialogs are not at one window level: the missing-files warning,
//     script alert() and "Save changes…?" sit at 8, the System Compatibility
//     Report at 101, the Adobe Licensing prompt at 0. Every one of them is
//     AXModal in the accessibility tree, with its text readable.
//   - AE exposes no AXCancelButton, and Escape goes to AE's FOCUSED window —
//     often the main window, not the dialog. Focusing the dialog through AX
//     (AXRaise + AXFocused, which does not activate AE) and then posting
//     Escape to AE's pid (CGEventPostToPid) closes it: the save prompt is
//     cancelled (project left open and dirty), the warning and alert() are
//     acknowledged. The frontmost app stays frontmost.
// So there are two tiers:
//   - Without permission, CGWindowListCopyWindowInfo gives owner pid and
//     level only: AE windows at levels 8 and 101 are reported, with empty
//     text; a level-0 dialog (Licensing) is missed. Nothing can be closed —
//     Escape posted without Accessibility is dropped.
//   - With Accessibility permission for the app running this server, every
//     AXModal AE window is reported with its text, and dismissing presses
//     AXCancelButton if there is one, else focuses the dialog and posts
//     Escape; if that leaves it open and it has exactly one titled button
//     (an OK-only warning), that button is pressed. Otherwise it stays open.
// System Events is deliberately not used: the first Apple event to it raises
// an Automation consent prompt — itself a modal — and blocks until answered.

import { execFile } from "node:child_process";

export interface AeDialog {
  /** AfterFX.exe process that owns the dialog. */
  pid: number;
  /**
   * Opaque dialog id — what `instance.dismiss_dialog` takes. On Windows the
   * window handle in decimal; on macOS `<pid>:<CG window number>`.
   */
  id: string;
  /** The dialog's message, whitespace-trimmed. Empty when it could not be read. */
  text: string;
  width: number;
  height: number;
  /** Main-window title of the owning process (names the project it has open). */
  window: string | null;
  /**
   * macOS only: whether Accessibility permission was available, i.e. whether
   * the text could be read and the dialog can be dismissed.
   */
  accessibility?: boolean;
  /** macOS only: when the owning process launched (ms since epoch). */
  startedAt?: number;
}

export interface DismissResult {
  /** The id named a visible After Effects dialog and its cancel action was sent. */
  posted: boolean;
  /** The dialog was gone shortly afterwards. */
  closed: boolean;
  /** What the dialog said (null when it was not found). */
  text: string | null;
  /**
   * Why nothing was sent, when posted is false: no such dialog, or no
   * Accessibility permission (macOS).
   */
  reason?: "not_found" | "no_permission";
}

/** Runs a script and resolves with its stdout. Injectable for tests. */
export type ScriptRunner = (script: string, env: Record<string, string>) => Promise<string>;
/** Runs a PowerShell script (Windows). */
export type PowerShellRunner = ScriptRunner;

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

// macOS: one JXA script, two modes. Everything it acts on arrives through the
// environment (AE_MCP_DIALOG_MODE, AE_MCP_DIALOG_ID). AX calls go straight to
// ApplicationServices; AXIsProcessTrusted never prompts.
export const DARWIN_SCRIPT = String.raw`
ObjC.import('Cocoa'); ObjC.import('CoreGraphics'); ObjC.import('ApplicationServices');
function envVar(k) { var v = $.NSProcessInfo.processInfo.environment.objectForKey(k); return v.isNil() ? '' : ObjC.unwrap(v); }
var trusted = !!$.AXIsProcessTrusted();
function isAe(bundle) { return /^com\.adobe\.aftereffects/i.test(bundle); }
function aeProcesses() {
  var out = {}, apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0, n = Number(apps.count); i < n; i++) {
    var a = apps.objectAtIndex(i), bundle = ObjC.unwrap(a.bundleIdentifier) || '';
    if (!isAe(bundle)) continue;
    out[a.processIdentifier] = { startedAt: a.launchDate.isNil() ? 0 : Math.round(a.launchDate.timeIntervalSince1970 * 1000) };
  }
  return out;
}
function cgWindows() {
  var r = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);
  return ObjC.deepUnwrap(ObjC.castRefToObject(r)) || [];
}
// Attribute names must be NSStrings. An element read from a single-valued
// attribute has to be cast before it is passed back in; ones out of an AX
// array can be passed as they are.
function ax(el, attr) { var ref = Ref(); return $.AXUIElementCopyAttributeValue(el, $(attr), ref) === 0 ? ref[0] : null; }
function axElement(el, attr) { var v = ax(el, attr); return v ? ObjC.castRefToObject(v) : null; }
function axList(el, attr) {
  var v = ax(el, attr), out = [];
  if (!v) return out;
  var arr = ObjC.castRefToObject(v);
  for (var i = 0, n = Number(arr.count); i < n; i++) out.push(arr.objectAtIndex(i));
  return out;
}
function axString(el, attr) { var v = ax(el, attr); if (!v) return ''; var s = ObjC.unwrap(ObjC.castRefToObject(v)); return typeof s === 'string' ? s : ''; }
function axNums(el, attr) {
  var v = ax(el, attr); if (!v) return null;
  var m = ObjC.unwrap(ObjC.castRefToObject(v).description).match(/[xw]:(-?[\d.]+) [yh]:(-?[\d.]+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function axTexts(el, out, depth, budget) {
  var kids = axList(el, 'AXChildren');
  for (var i = 0; i < kids.length && budget.n-- > 0; i++) {
    var role = axString(kids[i], 'AXRole');
    if (role === 'AXStaticText' || role === 'AXTextArea' || role === 'AXTextField') {
      var t = axString(kids[i], 'AXValue').trim(); if (t) out.push(t);
    } else if (depth < 6) axTexts(kids[i], out, depth + 1, budget);
  }
  return out;
}
function axButtons(el, out, depth) {
  var kids = axList(el, 'AXChildren');
  for (var i = 0; i < kids.length; i++) {
    if (axString(kids[i], 'AXRole') === 'AXButton') out.push(kids[i]);
    else if (depth < 6) axButtons(kids[i], out, depth + 1);
  }
  return out;
}
function axBool(el, attr) { var v = ax(el, attr); return v ? ObjC.unwrap(ObjC.castRefToObject(v)) == true : false; }
function axApp(pid, cache) {
  if (cache[pid]) return cache[pid];
  var app = $.AXUIElementCreateApplication(pid), wins = [], title = '';
  axList(app, 'AXWindows').forEach(function (w) {
    var aw = { el: w, pos: axNums(w, 'AXPosition'), size: axNums(w, 'AXSize'), modal: axBool(w, 'AXModal'), title: axString(w, 'AXTitle') };
    // AE reports no AXMainWindow; its main window is the titled, non-modal one.
    if (!title && !aw.modal && aw.title) title = aw.title;
    wins.push(aw);
  });
  return (cache[pid] = { wins: wins, title: title });
}
function near(a, b) { return Math.abs(a - b) < 2; }
// Seen on AE 26.5: the missing-files warning sits at layer 8, the System
// Compatibility Report at 101, the Adobe Licensing prompt at 0 — so with AX
// the test is AXModal, and without it only layers 8 and 101 are guessed at.
var GUESSED_LAYERS = { 8: true, 101: true };
function scan() {
  var procs = aeProcesses(), wins = cgWindows(), cache = {}, found = [];
  var titles = {};
  wins.forEach(function (w) { if (w.kCGWindowLayer === 0 && w.kCGWindowName && !titles[w.kCGWindowOwnerPID]) titles[w.kCGWindowOwnerPID] = w.kCGWindowName; });
  wins.forEach(function (w) {
    var pid = w.kCGWindowOwnerPID, b = w.kCGWindowBounds;
    if (!procs[pid] || !(w.kCGWindowAlpha > 0)) return;
    var d = { pid: pid, id: pid + ':' + w.kCGWindowNumber, text: '', width: Math.round(b.Width), height: Math.round(b.Height),
      window: titles[pid] || null, accessibility: trusted, startedAt: procs[pid].startedAt, number: w.kCGWindowNumber, el: null };
    var modal = !!GUESSED_LAYERS[w.kCGWindowLayer];
    if (trusted) {
      var app = axApp(pid, cache);
      if (app.title) d.window = app.title;
      app.wins.forEach(function (aw) {
        if (!d.el && aw.pos && aw.size && near(aw.pos[0], b.X) && near(aw.pos[1], b.Y) && near(aw.size[0], b.Width) && near(aw.size[1], b.Height)) { d.el = aw.el; modal = aw.modal; }
      });
      if (modal && d.el) d.text = axTexts(d.el, [], 0, { n: 400 }).filter(function (t) { return !/^(Adobe )?After Effects$/.test(t); }).join('\n');
    }
    if (modal) found.push(d);
  });
  return found;
}
function strip(d) { return { pid: d.pid, id: d.id, text: d.text, width: d.width, height: d.height, window: d.window, accessibility: d.accessibility, startedAt: d.startedAt }; }
function gone(number) {
  for (var i = 0; i < 10; i++) {
    delay(0.1);
    if (!cgWindows().some(function (w) { return w.kCGWindowNumber === number; })) return true;
  }
  return false;
}
function dismiss(target) {
  var none = { posted: false, closed: false, text: null };
  var d = null;
  scan().forEach(function (x) { if (x.id === target) d = x; });
  if (!d) { none.reason = 'not_found'; return none; }
  if (!trusted) { none.reason = 'no_permission'; return none; }
  var cancel = d.el ? axElement(d.el, 'AXCancelButton') : null;
  if (cancel) {
    $.AXUIElementPerformAction(cancel, $('AXPress'));
    return { posted: true, closed: gone(d.number), text: d.text || null, method: 'cancel_button' };
  }
  // AE exposes no AXCancelButton. Escape goes to the app's focused window,
  // which is often the main window rather than the dialog, so focus the
  // dialog inside AE first (this does not activate AE).
  if (d.el) {
    $.AXUIElementPerformAction(d.el, $('AXRaise'));
    $.AXUIElementSetAttributeValue(d.el, $('AXFocused'), $.kCFBooleanTrue);
  }
  [true, false].forEach(function (down) { $.CGEventPostToPid(d.pid, $.CGEventCreateKeyboardEvent($(), 53, down)); });
  if (gone(d.number)) return { posted: true, closed: true, text: d.text || null, method: 'escape' };
  // Escape did nothing: an OK-only warning has no choice to make, so its one
  // button is pressed; anything offering choices is left for the user.
  var buttons = d.el ? axButtons(d.el, [], 0).filter(function (b) { return axString(b, 'AXTitle'); }) : [];
  if (buttons.length === 1) {
    $.AXUIElementPerformAction(buttons[0], $('AXPress'));
    return { posted: true, closed: gone(d.number), text: d.text || null, method: 'only_button' };
  }
  return { posted: true, closed: false, text: d.text || null, method: 'escape' };
}
var mode = envVar('AE_MCP_DIALOG_MODE');
if (mode === 'dismiss') {
  var result;
  try { result = dismiss(envVar('AE_MCP_DIALOG_ID')); } catch (e) { result = { posted: false, closed: false, text: null, reason: 'not_found' }; }
  JSON.stringify(result);
} else JSON.stringify(scan().map(strip));
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

const defaultOsascriptRunner: ScriptRunner = (script, env) =>
  new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      {
        env: { ...process.env, ...env },
        timeout: SCAN_TIMEOUT_MS,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

let runner: PowerShellRunner = defaultRunner;
let osascriptRunner: ScriptRunner = defaultOsascriptRunner;

/** Swap the PowerShell runner (tests). Returns a function restoring the previous one. */
export function setPowerShellRunner(next: PowerShellRunner): () => void {
  const prev = runner;
  runner = next;
  return () => {
    runner = prev;
  };
}

/** Swap the osascript runner (tests). Returns a function restoring the previous one. */
export function setOsascriptRunner(next: ScriptRunner): () => void {
  const prev = osascriptRunner;
  osascriptRunner = next;
  return () => {
    osascriptRunner = prev;
  };
}

function scanSupported(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** Whether this platform can scan for dialogs at all. */
export function dialogScanSupported(platform: NodeJS.Platform = process.platform): boolean {
  return scanSupported(platform);
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
      ...(typeof e.accessibility === "boolean" ? { accessibility: e.accessibility } : {}),
      ...(typeof e.startedAt === "number" && e.startedAt > 0 ? { startedAt: e.startedAt } : {}),
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
    const raw =
      platform === "darwin"
        ? await osascriptRunner(DARWIN_SCRIPT, { AE_MCP_DIALOG_MODE: "scan" })
        : await runner(SCAN_SCRIPT, {});
    return parseDialogScan(raw);
  } catch {
    return [];
  }
}

const DISMISS_REASONS = new Set(["not_found", "no_permission"]);

/**
 * Close a dialog by its cancel action, never a decision (see the header: a
 * save prompt is cancelled, not answered). The id must name a dialog the scan
 * would report right now — anything else, including a window that has since
 * closed or an id that was never an After Effects dialog, is refused inside
 * the script, so a stale or made-up id can never send keys elsewhere.
 */
export async function dismissAeDialog(
  id: string,
  platform: NodeJS.Platform = process.platform,
): Promise<DismissResult> {
  const notFound: DismissResult = {
    posted: false,
    closed: false,
    text: null,
    reason: "not_found",
  };
  const shape = platform === "darwin" ? /^\d{1,10}:\d{1,10}$/ : /^\d{1,20}$/;
  if (!scanSupported(platform) || !shape.test(id)) return notFound;
  try {
    const raw =
      platform === "darwin"
        ? await osascriptRunner(DARWIN_SCRIPT, {
            AE_MCP_DIALOG_MODE: "dismiss",
            AE_MCP_DIALOG_ID: id,
          })
        : await runner(DISMISS_SCRIPT, { AE_MCP_DIALOG_ID: id });
    const r = JSON.parse(raw.replace(/^\uFEFF/, "").trim()) as Partial<DismissResult>;
    const posted = r.posted === true;
    return {
      posted,
      closed: r.closed === true,
      text: typeof r.text === "string" ? r.text.replace(/\r\n/g, "\n").trim() : null,
      ...(posted
        ? {}
        : {
            reason:
              typeof r.reason === "string" && DISMISS_REASONS.has(r.reason)
                ? r.reason
                : "not_found",
          }),
    };
  } catch {
    return notFound;
  }
}

/** One line per dialog, for error messages. */
export function describeDialogs(dialogs: AeDialog[]): string {
  return dialogs
    .map((d) => {
      const where = d.window ? ` in "${d.window}"` : "";
      const text = d.text ? `"${d.text.replace(/\s*\n\s*/g, " ")}"` : "(text unavailable)";
      return `${text} (pid ${d.pid}${where}, id ${d.id})`;
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
  "`instance.dismiss_dialog { id }` closes it by its cancel action (what Escape does), so a warning is " +
  "acknowledged and a question (save changes?) is cancelled, never answered — then retry. If the user needs " +
  "to answer it, ask them; it is often hidden behind the After Effects main window.";

export const ACCESSIBILITY_HINT =
  "On macOS, reading a dialog's text and closing it need Accessibility permission for the app that runs " +
  "this MCP server (System Settings > Privacy & Security > Accessibility). Without it, dialogs are only " +
  "detected; ask the user to close them in After Effects.";

/** DIALOG_HINT, plus the Accessibility note when any dialog was seen without it. */
export function dialogHint(dialogs: AeDialog[]): string {
  return dialogs.some((d) => d.accessibility === false)
    ? `${DIALOG_HINT} ${ACCESSIBILITY_HINT}`
    : DIALOG_HINT;
}
