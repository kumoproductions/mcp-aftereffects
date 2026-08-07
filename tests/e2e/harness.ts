// E2E harness for suites that talk to a real After Effects instance.
//
// probeAe() decides whether the AE-dependent suites can run at all. Order
// matters: spawning FileIpcTransport.execute() runs `AfterFX.exe -r ...`,
// which BOOTS After Effects if it is not already running — so we check for a
// live AfterFX.exe process first and never probe blind.
//
// Also hosts the test-project lifecycle helpers (backup / fixture / restore)
// shared by the session-mutating suites (tools, roundtrip).

import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import "../../src/operations/index.js"; // side-effect import: fills the operation registry
import { jsxVal } from "../../src/registry.js";
import { doTool } from "../../src/tools/do.js";
import { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";

const execAsync = promisify(exec);

/**
 * Where the E2E suites keep their own artifacts (project backups, roundtrip
 * documents). Deliberately NOT under the IPC mailbox: that directory is the
 * transport's trust boundary, holds mail and nothing else, and the tools now
 * refuse to write into it. Its sweeper only knows about request/response
 * files anyway, so test leftovers there would accumulate forever.
 */
export const E2E_SCRATCH_DIR = path.join(os.tmpdir(), "mcp-aftereffects-e2e");

export interface AeProbeResult {
  ready: boolean;
  reason?: string;
  transport?: FileIpcTransport;
}

/** Loud, unmissable banner so skips are never confused with success. */
export function printSkipBanner(suite: string, headline: string, lines: string[] = []): void {
  const divider = "─".repeat(72);
  console.warn([divider, `[e2e ${suite}] ${headline}`, ...lines, divider].join("\n"));
}

function printAeUnreachableBanner(suite: string, reason: string): void {
  printSkipBanner(suite, "SKIPPING — After Effects not reachable", [
    ` reason : ${reason}`,
    " ",
    " To run these tests:",
    "   1. Launch Adobe After Effects (any project open is fine).",
    "   2. Enable Edit > Preferences > Scripting & Expressions >",
    "      'Allow Scripts to Write Files and Access Network'.",
    "   3. If After Effects is not in a default install path, set AE_MCP_EXE",
    "      to its full path (Windows: AfterFX.exe / macOS: the .app bundle).",
    "   4. Re-run `npm test`.",
  ]);
}

async function isAfterFxRunning(): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      // -f matches the full command line, so this finds AE regardless of the
      // bundle's executable name (the .app path contains "Adobe After Effects").
      await execAsync('pgrep -f "Adobe After Effects"');
      return true;
    }
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq AfterFX.exe" /NH');
    return stdout.toLowerCase().includes("afterfx.exe");
  } catch {
    return false;
  }
}

/**
 * Probe a running AE instance: process check → transport construction → one
 * trivial execute round trip. On any failure returns { ready: false, reason }
 * and prints a skip banner; never throws.
 */
export async function probeAe(suite: string): Promise<AeProbeResult> {
  if (!(await isAfterFxRunning())) {
    const reason =
      "no running After Effects process (probing would boot AE, so we refuse to probe blind)";
    printAeUnreachableBanner(suite, reason);
    return { ready: false, reason };
  }

  let transport: FileIpcTransport;
  try {
    // Resolution of AfterFX.exe is lazy (first execute), but keep the guard —
    // the constructor still touches the filesystem (mkdir runtime/).
    transport = new FileIpcTransport();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    printAeUnreachableBanner(suite, reason);
    return { ready: false, reason };
  }

  const res = await transport.execute({
    code: "return 'pong';",
    label: "e2e_probe",
    timeoutMs: 30_000,
  });
  if (!res.ok || res.result !== "pong") {
    const reason = res.error ?? `unexpected probe result: ${JSON.stringify(res.result)}`;
    printAeUnreachableBanner(suite, reason);
    return { ready: false, reason };
  }
  return { ready: true, transport };
}

// ---------------------------------------------------------------------------
// Test project lifecycle. Backs up whatever the user has open in AE, swaps in
// a fresh test project, and restores the original at the end.
//
// Safety contract:
//   - If the current project is dirty or unsaved, it is saved to a timestamped
//     backup file under `runtime/` via Save As. The ORIGINAL on-disk file (if
//     any) is untouched.
//   - If the current project is saved and clean, no backup is needed — we just
//     close it and reopen from the same path at the end.
// ---------------------------------------------------------------------------

export interface SavedProjectState {
  origPath: string | null;
  backupPath: string | null;
  wasDirty: boolean;
  origNumItems: number;
}

export async function backupAndOpenTestProject(
  transport: FileIpcTransport,
): Promise<SavedProjectState> {
  await fs.mkdir(E2E_SCRATCH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(E2E_SCRATCH_DIR, `user_backup_${stamp}.aep`).replace(/\\/g, "/");

  const res = await transport.execute({
    code: `
      var origPath = app.project.file ? app.project.file.fsName.replace(/\\\\/g, "/") : null;
      var wasDirty = !!app.project.dirty;
      var origNumItems = app.project.numItems;
      var backupPathUsed = null;
      if (wasDirty || origPath === null) {
          var bf = new File(${jsxVal(backupPath)});
          app.project.save(bf);
          backupPathUsed = bf.fsName.replace(/\\\\/g, "/");
      }
      // Close current project without saving (either it's saved to disk at origPath,
      // or we just save-as'd to backupPathUsed).
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
      app.newProject();
      return {
          origPath: origPath,
          backupPath: backupPathUsed,
          wasDirty: wasDirty,
          origNumItems: origNumItems
      };
    `,
    label: "test_backup_and_new",
    timeoutMs: 60_000,
  });
  if (!res.ok) {
    throw new Error("backup/newProject failed: " + res.error);
  }
  return res.result as SavedProjectState;
}

export async function restoreUserProject(
  transport: FileIpcTransport,
  saved: SavedProjectState,
): Promise<void> {
  // Prefer the original on-disk path if it exists; otherwise reopen the backup.
  const restorePath = saved.origPath ?? saved.backupPath;
  if (!restorePath) {
    // Nothing to restore (the user had a fresh empty project with no backup needed)
    await transport.execute({
      code: "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); app.newProject(); return { restored: false };",
      label: "test_teardown_empty",
      timeoutMs: 30_000,
    });
    return;
  }
  const res = await transport.execute({
    code: `
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
      var f = new File(${jsxVal(restorePath)});
      if (!f.exists) return { restored: false, error: "restore path not found: " + ${jsxVal(restorePath)} };
      app.open(f);
      return { restored: true, numItems: app.project.numItems };
    `,
    label: "test_restore_user_project",
    timeoutMs: 60_000,
  });
  if (!res.ok) throw new Error("restore failed: " + res.error);
}

// ---------------------------------------------------------------------------
// ae_do helpers for the operation suites.
// ---------------------------------------------------------------------------

export interface DoError {
  code: string;
  message: string;
}

interface DoResponse {
  isError?: boolean;
  structuredContent?: { result?: unknown; error?: DoError };
}

/**
 * Bind ae_do to one transport.
 *
 * `run` unwraps a successful call and throws with AE's own message, so a
 * failing operation reports why rather than as an assertion on `undefined`.
 * `expectRefusal` is its mirror: it asserts the call was refused and returns
 * the error envelope. The safety suite is built on the second one — every
 * check there is "this destructive call declined, and the project is
 * untouched", which only means something if the call really did fail.
 */
export function opRunner(transport: FileIpcTransport) {
  const call = (operation: string, args: Record<string, unknown>) =>
    doTool.handler({ operation, args }, transport) as Promise<DoResponse>;

  return {
    async run<T>(operation: string, args: Record<string, unknown> = {}): Promise<T> {
      const res = await call(operation, args);
      if (res.isError) {
        throw new Error(`${operation} failed: ${JSON.stringify(res.structuredContent?.error)}`);
      }
      return res.structuredContent?.result as T;
    },

    async expectRefusal(operation: string, args: Record<string, unknown> = {}): Promise<DoError> {
      const res = await call(operation, args);
      if (!res.isError) {
        throw new Error(
          `${operation} should have been refused but succeeded: ` +
            JSON.stringify(res.structuredContent?.result),
        );
      }
      return res.structuredContent?.error as DoError;
    },
  };
}

/** Open a comp in the viewer — viewer.* operations need an active comp viewer. */
export async function openCompInViewer(
  transport: FileIpcTransport,
  compName: string,
): Promise<boolean> {
  const res = await transport.execute({
    code: `
      var c = AE.findCompByNameOrId(${jsxVal(compName)});
      if (!c) return { opened: false };
      c.openInViewer();
      return { opened: true };
    `,
    label: "e2e_open_comp",
    timeoutMs: 30_000,
  });
  return res.ok && (res.result as { opened?: boolean } | null)?.opened === true;
}

export async function buildFixtureProject(transport: FileIpcTransport): Promise<void> {
  const res = await transport.execute({
    code: `
      var proj = app.project;
      var folder = proj.items.addFolder("test_folder");
      var comp = proj.items.addComp("test_comp", 1920, 1080, 1, 5, 29.97);
      comp.parentFolder = folder;

      // AE API quirk: standalone Solid footage items are created via
      // LayerCollection#addSolid, which both creates the Solid FootageItem
      // and places a layer referencing it into the comp. The footage then
      // lives under the project-level "Solids" folder and persists.
      var redLayer = comp.layers.addSolid([1, 0, 0], "red_solid", 1920, 1080, 1, 5);
      redLayer.name = "red_layer";
      redLayer.transform.position.setValueAtTime(0, [100, 540]);
      redLayer.transform.position.setValueAtTime(2, [1820, 540]);
      redLayer.transform.opacity.setValueAtTime(0, 100);
      redLayer.transform.opacity.setValueAtTime(4, 20);

      var blueLayer = comp.layers.addSolid([0, 0.2, 1], "blue_solid", 640, 360, 1, 5);
      blueLayer.name = "blue_layer";
      blueLayer.transform.position.setValue([960, 540]);
      blueLayer.transform.scale.setValue([50, 50]);
      blueLayer.transform.rotation.setValueAtTime(0, 0);
      blueLayer.transform.rotation.setValueAtTime(3, 360);

      var textLayer = comp.layers.addText("Hello mcp-aftereffects");
      textLayer.transform.position.setValue([960, 200]);

      return {
          compId: comp.id,
          redSolidSourceId: redLayer.source ? redLayer.source.id : null,
          blueSolidSourceId: blueLayer.source ? blueLayer.source.id : null,
          folderId: folder.id,
          compLayerCount: comp.numLayers
      };
    `,
    label: "test_build_fixture",
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new Error("fixture build failed: " + res.error);
}
