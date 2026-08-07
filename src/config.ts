import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";

// Resolve the package root by walking up from this file's location until a
// package.json appears. Compiled (dist/config.js) and source (src/config.ts,
// as executed by vitest) both sit one level below the root, but the walk keeps
// working if either ever nests deeper.
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`mcp-aftereffects: no package.json found above ${startDir}`);
    }
    dir = parent;
  }
}

export const PACKAGE_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

export const DISPATCHER_JSX = path.join(PACKAGE_ROOT, "jsx", "dispatcher.jsx");

// --- Runtime (file-IPC mailbox) location -----------------------------------
//
// The mailbox lives under the OS temp dir, NOT under the package, for two
// reasons:
//   1. The package directory is frequently read-only (global npm install,
//      `npx` cache, Program Files). Writing there used to crash the server at
//      construction time.
//   2. A single machine-wide directory is what makes multi-client safe: every
//      request/response is a per-id file (`request-<uuid>.json` /
//      `response-<uuid>.json`), so two server processes — even from different
//      installs — share the directory without ever touching each other's mail.
//
// Both sides must agree on the location. Node and dispatcher.jsx compute
// DEFAULT_RUNTIME_DIR identically from the OS temp dir; when AE_MCP_RUNTIME_DIR
// overrides it, Node drops a pointer file at the default location so the
// dispatcher can still find the mailbox.
export const RUNTIME_ROOT = path.join(os.tmpdir(), "mcp-aftereffects");
export const DEFAULT_RUNTIME_DIR = path.join(RUNTIME_ROOT, "runtime");
export const RUNTIME_POINTER_PATH = path.join(RUNTIME_ROOT, "runtime-dir.txt");

/**
 * Mode for the mailbox directory: owner only.
 *
 * The mailbox is the transport's trust boundary. `dispatcher.jsx` executes the
 * `code` string of any request it finds there, with no signature to check and
 * no access to the capability policy — so write access to this directory is
 * equivalent to arbitrary code execution inside After Effects. The OS temp dir
 * is already per-user on both supported platforms; this narrows our own
 * subdirectory the rest of the way on POSIX. Ignored on Windows, where the
 * per-user ACL on %TEMP% is what carries the property.
 */
export const RUNTIME_DIR_MODE = 0o700;

function resolveRuntimeDir(): string {
  const override = process.env.AE_MCP_RUNTIME_DIR?.trim();
  return override ? path.resolve(override) : DEFAULT_RUNTIME_DIR;
}

export const RUNTIME_DIR = resolveRuntimeDir();

/** True when AE_MCP_RUNTIME_DIR moved the mailbox off the discoverable default. */
export const RUNTIME_DIR_IS_CUSTOM =
  path.resolve(RUNTIME_DIR) !== path.resolve(DEFAULT_RUNTIME_DIR);

export const REQUEST_PREFIX = "request-";
export const RESPONSE_PREFIX = "response-";

export function requestPathFor(id: string): string {
  return path.join(RUNTIME_DIR, `${REQUEST_PREFIX}${id}.json`);
}

export function responsePathFor(id: string): string {
  return path.join(RUNTIME_DIR, `${RESPONSE_PREFIX}${id}.json`);
}

/**
 * Age past which an orphaned request/response file is swept on startup. Long
 * enough that it can never race a legitimately slow call (the longest built-in
 * timeout is the 10-minute project import).
 */
export const STALE_RUNTIME_FILE_MS = 60 * 60 * 1000;

/**
 * Reject a caller-supplied output path that lands inside the mailbox.
 *
 * `ae_render_frame` and `ae_project_export_json` write wherever they are told,
 * and both survive read-only mode. Neither has any business writing into the
 * IPC directory: a file dropped there is at best mistaken for mail and swept,
 * at worst shaped into a request the dispatcher executes. This closes the one
 * write target that feeds back into the transport itself. Returns an error
 * message, or null when the path is fine.
 */
export function rejectedOutputPath(outPath: string): string | null {
  const abs = path.resolve(outPath);
  const roots = [path.resolve(RUNTIME_DIR), path.resolve(RUNTIME_ROOT)];
  for (const root of roots) {
    const rel = path.relative(root, abs);
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (inside) {
      return (
        `refusing to write inside the mcp-aftereffects IPC mailbox (${root}). ` +
        "That directory is the transport's trust boundary — pick a path outside it."
      );
    }
  }
  return null;
}

// --- Reporting on where the mailbox lives ------------------------------------
//
// Write access to the mailbox is code execution inside After Effects, and the
// capability policy cannot help (it lives on the Node side; the dispatcher
// executes what it finds with no policy and no signature to check). None of
// these checks *enforce* anything — they exist so a mailbox anyone can write to
// is reported at startup rather than used silently.

/**
 * How far past its owner `dir` is writable, or null when it is owner-only,
 * missing, or unknowable. Windows reports a synthetic mode, so the check is
 * POSIX-only — see `uncheckedMailboxAclWarning` for what covers that side.
 */
function looseWriteScope(dir: string): { scope: "group" | "world"; mode: number } | null {
  if (process.platform === "win32") return null;
  let mode: number;
  try {
    mode = statSync(dir).mode;
  } catch {
    return null;
  }
  if ((mode & 0o022) === 0) return null;
  return { scope: (mode & 0o002) !== 0 ? "world" : "group", mode: mode & 0o777 };
}

/**
 * Complain when the mailbox is writable by anyone but its owner.
 *
 * A group- or world-writable mailbox lets any local account plant a request,
 * which `dispatcher.jsx` will execute inside After Effects. That can happen
 * when `AE_MCP_RUNTIME_DIR` points somewhere shared (`/tmp/…`), or when a
 * pre-existing directory carries loose permissions. Returns a warning string,
 * or null when the mode is fine or unknowable.
 */
export function unsafeRuntimeDirWarning(dir: string = RUNTIME_DIR): string | null {
  const loose = looseWriteScope(dir);
  if (loose === null) return null;
  return (
    `mailbox ${dir} is ${loose.scope}-writable ` +
    `(mode ${loose.mode.toString(8)}). Any local account that can write there can ` +
    `execute code inside After Effects. Fix with: chmod 700 ${JSON.stringify(dir)} ` +
    `— or unset AE_MCP_RUNTIME_DIR to use the per-user default.`
  );
}

/**
 * Same complaint for the directory holding the mailbox POINTER, which is part
 * of the same trust boundary.
 *
 * `dispatcher.jsx` reads `runtime-dir.txt` from RUNTIME_ROOT and puts the
 * directory it names FIRST among the places it will execute a request from. So
 * write access here is as good as write access to the mailbox: plant a pointer,
 * plant a request, and the dispatcher runs it — even though the real mailbox is
 * private and the server is not using a custom one. RUNTIME_ROOT is always the
 * fixed per-user path (`AE_MCP_RUNTIME_DIR` moves the mailbox, never the
 * pointer), so this only fires on a pre-existing directory with loose modes.
 */
export function unsafePointerDirWarning(dir: string = RUNTIME_ROOT): string | null {
  const loose = looseWriteScope(dir);
  if (loose === null) return null;
  return (
    `mailbox pointer directory ${dir} is ${loose.scope}-writable ` +
    `(mode ${loose.mode.toString(8)}). It holds ${path.basename(RUNTIME_POINTER_PATH)}, which the ` +
    `dispatcher follows to locate the mailbox, so any local account that can write there can point ` +
    `After Effects at a mailbox of its own. Fix with: chmod 700 ${JSON.stringify(dir)}`
  );
}

/**
 * Say plainly that a custom mailbox is unverified on Windows.
 *
 * There the safety of the mailbox rests on the ACL of the directory it sits in,
 * which Node cannot read — so the mode checks above return null and print
 * nothing, which would otherwise read as "checked, and fine". The default under
 * `%TEMP%` is per-user and genuinely safe; `AE_MCP_RUNTIME_DIR` is the case
 * nothing verifies, so it gets one line at startup.
 */
export function uncheckedMailboxAclWarning(
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "win32" || !RUNTIME_DIR_IS_CUSTOM) return null;
  return (
    `mailbox ${RUNTIME_DIR} comes from AE_MCP_RUNTIME_DIR and its Windows ACL is not verified here. ` +
    `Any account that can write there can execute code inside After Effects — keep the mailbox on a ` +
    `per-user path (not a shared, world-writable, or synced folder), or unset AE_MCP_RUNTIME_DIR to ` +
    `use the default under the per-user temp dir.`
  );
}

/** Every startup warning about the mailbox location, in report order. */
export function runtimeDirWarnings(): string[] {
  const warnings = [unsafeRuntimeDirWarning(RUNTIME_DIR)];
  // A custom mailbox that IS the pointer directory needs only the one warning.
  if (path.resolve(RUNTIME_DIR) !== path.resolve(RUNTIME_ROOT)) {
    warnings.push(unsafePointerDirWarning(RUNTIME_ROOT));
  }
  warnings.push(uncheckedMailboxAclWarning());
  return warnings.filter((w) => w !== null);
}

const DEFAULT_AE_PATHS_WIN32 = [
  "C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/AfterFX.exe",
  "C:/Program Files/Adobe/Adobe After Effects 2025/Support Files/AfterFX.exe",
  "C:/Program Files/Adobe/Adobe After Effects 2024/Support Files/AfterFX.exe",
];

const DEFAULT_AE_PATHS_DARWIN = [
  "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app",
  "/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app",
  "/Applications/Adobe After Effects 2024/Adobe After Effects 2024.app",
];

/**
 * Locate After Effects — AfterFX.exe on Windows, the .app bundle on macOS.
 * Honors AE_MCP_EXE (and the legacy AE_EXE name) first so the user can
 * override without editing source, then probes the default install paths for
 * AE 2026 → 2025 → 2024.
 */
export function resolveAfterFxPath(platform: NodeJS.Platform = process.platform): string {
  for (const env of [process.env.AE_MCP_EXE, process.env.AE_EXE]) {
    if (env && existsSync(env)) return env;
  }
  const candidates = platform === "darwin" ? DEFAULT_AE_PATHS_DARWIN : DEFAULT_AE_PATHS_WIN32;
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    platform === "darwin"
      ? "Could not locate After Effects. Set the AE_MCP_EXE env var to the .app bundle, e.g. " +
          '"/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"'
      : "Could not locate AfterFX.exe. Set the AE_MCP_EXE env var to the full path, e.g. " +
          '"C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/AfterFX.exe"',
  );
}

/** Default per-call timeout (ms) for JSX execution before we give up polling. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Poll interval (ms) while waiting for our response file to appear. */
export const POLL_INTERVAL_MS = 80;

// --- Cross-process dispatch serialization -----------------------------------
//
// After Effects runs one script at a time: a `-r` (or DoScript) that arrives
// while another script is executing is REFUSED, and AE raises a modal warning
// ("Attempt was made to run a second script…") that blocks all further script
// execution until a human clicks OK. Same-process calls are serialized by the
// transport's promise chain, but two server processes (two MCP clients, or an
// old and a new install side by side) had nothing coordinating them.
//
// The busy lock closes that gap: before spawning the dispatcher, a call
// acquires BUSY_LOCK_PATH via exclusive create (open "wx" — atomic across
// processes), holds it for the lifetime of the call while refreshing its
// mtime, and releases it when the response arrives. A lock whose mtime is
// older than BUSY_LOCK_STALE_MS has lost its owner (crashed server, killed
// AE) and may be broken by any waiter.
//
// The lock cannot see scripts WE didn't start (user panels, startup scripts,
// other tooling). That case is covered by relaunching: a request file still
// unconsumed RELAUNCH_UNCONSUMED_AFTER_MS after a launch means AE refused or
// dropped the script, so the dispatcher is launched again (the request is
// still in the mailbox; consume-on-read keeps a duplicate launch harmless),
// up to MAX_LAUNCH_ATTEMPTS with linear backoff.

/** Lock file marking a dispatcher call in flight. Lives in the shared mailbox. */
export const BUSY_LOCK_PATH = path.join(RUNTIME_DIR, "dispatcher-busy.lock");

/**
 * Age past which a busy lock is considered orphaned. Its owner refreshes the
 * mtime every BUSY_LOCK_REFRESH_MS while alive, so this can be far shorter
 * than any legitimate call duration.
 */
export const BUSY_LOCK_STALE_MS = 90_000;

/** How often the lock owner refreshes the lock's mtime while polling. */
export const BUSY_LOCK_REFRESH_MS = 15_000;

/**
 * With the request still unconsumed this long after a launch, launch the
 * dispatcher again (linear backoff: xN for the Nth attempt).
 */
export const RELAUNCH_UNCONSUMED_AFTER_MS = 2_500;

/** Total dispatcher launches per call, first attempt included. */
export const MAX_LAUNCH_ATTEMPTS = 3;
