// Instance operations — managing After Effects PROCESSES from the Node side.
//
// These are the building blocks of parallel work: a session starts a second
// (third, …) After Effects with `instance.start`, works in it through the
// `instance` argument every tool takes, saves there, merges the result into
// the main project with `project.merge`, and shuts the worker down with
// `instance.stop`. None of this generates ExtendScript: `run` executes in the
// server process (see Operation.run), and only `instance.start`'s project
// open and `instance.stop`'s quit go through the transport — into the
// instance they concern, by name.
//
// Every instance is reached through the pull path, so the resident agent
// must be installed (`mcp-aftereffects install-agent`); the operations say so
// when it is not rather than starting an AE nothing can talk to.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { agentInstallStatus } from "../agent-install.js";
import {
  HEARTBEAT_STALE_MS,
  instanceDirFor,
  rejectedOutputPath,
  resolveAfterFxPath,
  sanitizeInstanceId,
} from "../config.js";
import { jsxFail, jsxVal, registerOp } from "../registry.js";
import type { AeTransport } from "../transport/AeTransport.js";
import {
  ACCESSIBILITY_HINT,
  dialogBlockMessage,
  dialogHint,
  dialogScanSupported,
  dismissAeDialog,
  scanAeDialogs,
} from "../transport/dialogs.js";
import {
  type InstanceInfo,
  describeInstance,
  instanceLabel,
  listInstances,
  readInstance,
} from "../transport/instances.js";
import { buildInstanceLaunchPlan } from "../transport/launcher.js";

const INSTALL_CMD = "npx @kumoproductions/mcp-aftereffects install-agent";
const DEFAULT_START_TIMEOUT_MS = 120_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;

function nodeOnly(name: string): string {
  return jsxFail(
    `${name} runs on the Node side (it manages After Effects processes) — call it as its own ae_do, not inside batch.run`,
  );
}

function fail(error: string, extra: { errorCode?: string; hint?: string } = {}) {
  return { ok: false as const, error, ...extra };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function summarizeInstance(i: InstanceInfo) {
  return {
    label: instanceLabel(i),
    id: i.id,
    alive: i.alive,
    busy: i.heartbeat?.busy ?? false,
    project: i.heartbeat?.project ?? null,
    projectName: i.heartbeat?.projectName ?? null,
    dirty: i.heartbeat?.dirty ?? null,
    numItems: i.heartbeat?.numItems ?? null,
    aeVersion: i.heartbeat?.aeVersion ?? null,
    idSource: i.heartbeat?.idSource ?? null,
    lastSeenMsAgo: i.ageMs,
  };
}

async function describeTargetOf(transport: AeTransport) {
  if (!transport.describeTarget) return null;
  const target = await transport.describeTarget();
  switch (target.mode) {
    case "pull":
      return { mode: "pull" as const, instance: target.instance.id };
    case "push":
      return { mode: "push" as const };
    case "error":
      return { mode: "error" as const, message: target.message };
  }
}

registerOp({
  name: "instance.list",
  category: "instance",
  description:
    "List the After Effects instances whose resident agent is live — id, open project, busy state — " +
    "and which one this call would address. Instances are separate After Effects processes " +
    "(AfterFX.exe -m), each with its own project; address one on any tool with `instance: <id or project name>`. " +
    "Stale entries are instances that quit or stopped ticking (a modal dialog blocks scripting).",
  params: [],
  readOnly: true,
  toJsx: () => nodeOnly("instance.list"),
  async run(_args, transport) {
    const instances = await listInstances();
    return {
      ok: true,
      instances: instances.map(summarizeInstance),
      live: instances.filter((i) => i.alive).map((i) => i.id),
      target: await describeTargetOf(transport),
    };
  },
});

registerOp({
  name: "instance.start",
  category: "instance",
  description:
    "Start a NEW After Effects instance (AfterFX.exe -m) named `name`, wait until its agent registers, " +
    "and optionally open a project in it — or a COPY of one (`copyFrom`), which is the safe way to work " +
    "on a project another instance already has open (two instances saving one file overwrite each other). " +
    "Returns when the instance can be addressed with `instance: name` on every tool. Cold starts take " +
    "10–40 s. Parallel workflow: instance.start { name: 'w1', copyFrom: <main .aep> } → work with " +
    "instance: 'w1' → ae_save_project (instance: 'w1') → project.merge { path: <the copy> } on the main " +
    "instance → instance.stop { name: 'w1' }. Requires the resident agent (" +
    INSTALL_CMD +
    ") — every instance loads it at launch.",
  params: [
    {
      name: "name",
      type: "string",
      description:
        "Instance id — becomes AE_MCP_INSTANCE for the new process. Letters, digits, '.', '_', '-'. Must not be live already.",
      required: true,
    },
    {
      name: "project",
      type: "string",
      description: "Absolute .aep path to open in the new instance once it is up.",
      required: false,
    },
    {
      name: "copyFrom",
      type: "string",
      description:
        "Absolute .aep path to COPY first; the copy is what gets opened. Use for a project the main instance has open.",
      required: false,
    },
    {
      name: "copyTo",
      type: "string",
      description:
        "Where `copyFrom` is copied to (default: next to the original as <stem>__<name>.aep). Overwritten if present.",
      required: false,
    },
    {
      name: "timeoutMs",
      type: "number",
      description: `How long to wait for the instance to register (default ${DEFAULT_START_TIMEOUT_MS}).`,
      required: false,
    },
  ],
  toJsx: () => nodeOnly("instance.start"),
  async run(args, transport) {
    const name = sanitizeInstanceId(typeof args.name === "string" ? args.name : "");
    if (!name)
      return fail("name must contain letters, digits, '.', '_' or '-'", {
        errorCode: "INVALID_ARGS",
      });
    if (args.project && args.copyFrom) {
      return fail("pass either project or copyFrom, not both", { errorCode: "INVALID_ARGS" });
    }

    // Input problems first, environment problems second, side effects last:
    // a bad path is the caller's to fix regardless of what is installed, and
    // nothing gets copied for a launch that will not happen.
    let projectToOpen: string | null = null;
    let copiedFrom: string | null = null;
    let copyTo: string | null = null;
    if (typeof args.copyFrom === "string" && args.copyFrom) {
      const src = path.resolve(args.copyFrom);
      if (!(await exists(src))) return fail(`copyFrom not found: ${src}`, { errorCode: "IO" });
      const ext = path.extname(src) || ".aep";
      copyTo =
        typeof args.copyTo === "string" && args.copyTo
          ? path.resolve(args.copyTo)
          : path.join(path.dirname(src), `${path.basename(src, ext)}__${name}${ext}`);
      if (copyTo === src)
        return fail("copyTo must differ from copyFrom", { errorCode: "INVALID_ARGS" });
      // Same rule as every other path this server writes to: never into the
      // mailbox, which would turn a project copy into planted mail.
      const rejected = rejectedOutputPath(copyTo);
      if (rejected) return fail(rejected, { errorCode: "IO" });
      copiedFrom = src;
      projectToOpen = copyTo;
    } else if (typeof args.project === "string" && args.project) {
      projectToOpen = path.resolve(args.project);
      if (!(await exists(projectToOpen)))
        return fail(`project not found: ${projectToOpen}`, { errorCode: "IO" });
    }

    const clash = (await listInstances()).find((i) => i.alive && i.id === name);
    if (clash) {
      return fail(
        `instance '${name}' is already live (${describeInstance(clash)}) — address it directly, or pick another name`,
      );
    }

    const stubs = await agentInstallStatus();
    if (!stubs.some((s) => s.installed)) {
      return fail(
        "the resident agent is not installed, so a new instance could not be addressed once started",
        {
          errorCode: "NO_INSTANCE",
          hint: `Run \`${INSTALL_CMD}\` once (per After Effects version), then retry. Nothing was launched.`,
        },
      );
    }

    let exe: string;
    try {
      exe = resolveAfterFxPath();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), { errorCode: "AE_NOT_FOUND" });
    }

    if (copiedFrom !== null && copyTo !== null) {
      await fs.mkdir(path.dirname(copyTo), { recursive: true });
      await fs.copyFile(copiedFrom, copyTo);
    }

    const plan = buildInstanceLaunchPlan(exe, name);
    // On macOS the spawned process is `open`, which exits at once; the
    // After Effects it starts has a pid of its own that we never learn.
    const aePid = process.platform === "darwin" ? null : undefined;
    const launchedAt = Date.now();
    let spawnError: Error | null = null;
    const child = spawn(plan.command, plan.args, {
      env: { ...process.env, AE_MCP_INSTANCE: name },
      detached: true,
      stdio: "ignore",
      // A worker instance is a real After Effects the user may want to watch.
      windowsHide: false,
    });
    child.on("error", (err) => {
      spawnError = err;
    });
    child.unref();

    const timeoutMs =
      typeof args.timeoutMs === "number" && args.timeoutMs > 0
        ? args.timeoutMs
        : DEFAULT_START_TIMEOUT_MS;
    const deadline = launchedAt + timeoutMs;
    let registered: InstanceInfo | null = null;
    while (Date.now() < deadline) {
      if (spawnError !== null) {
        return fail(`could not launch After Effects (${exe}): ${(spawnError as Error).message}`, {
          errorCode: "TRANSPORT",
        });
      }
      const info = await readInstance(instanceDirFor(name));
      // A heartbeat older than the launch belongs to a previous instance of
      // the same name that has since died; wait for the new one's.
      if (info.alive && (info.heartbeat?.startedAt ?? 0) >= launchedAt - HEARTBEAT_STALE_MS) {
        registered = info;
        break;
      }
      await sleep(500);
    }
    if (registered === null) {
      // Windows: the spawned process IS the instance. macOS: `open -n` exits
      // at once, so the instance is the After Effects that launched since.
      const dialogs = (await scanAeDialogs()).filter(
        (d) => d.pid === child.pid || (d.startedAt ?? 0) >= launchedAt - 2_000,
      );
      if (dialogs.length > 0) {
        return {
          ...fail(
            `instance '${name}' did not register within ${timeoutMs} ms: ${dialogBlockMessage(dialogs)}`,
            { errorCode: "DIALOG_OPEN", hint: dialogHint(dialogs) },
          ),
          dialogs,
        };
      }
      return fail(
        `instance '${name}' did not register within ${timeoutMs} ms (After Effects was launched${aePid === null ? "" : `, pid ${child.pid ?? "?"}`})`,
        {
          errorCode: "NO_INSTANCE",
          hint:
            "Is the agent installed for THIS After Effects version (`mcp-aftereffects agent-status`)? Did After Effects " +
            "stop at a dialog while starting? After a force-killed or crashed session, every launch waits at the " +
            "'We detected a crash' Safe Mode dialog until someone dismisses it on screen. Raise timeoutMs for a slow machine. " +
            "The launched process is still running; quit it from its window rather than killing it.",
        },
      );
    }

    let opened: { file: string; numItems: number } | null = null;
    if (projectToOpen !== null) {
      const res = await transport.execute({
        instance: name,
        label: "instance.start",
        code: `
            var _f = new File(${jsxVal(projectToOpen)});
            if (!_f.exists) return { ok: false, error: "file not found: " + ${jsxVal(projectToOpen)} };
            app.open(_f);
            return { ok: true, file: app.project.file.fsName.replace(/\\\\/g, "/"), numItems: app.project.numItems };
        `,
        // A project boundary: no undo group (see project.open), dialogs
        // suppressed — missing footage on open is exactly what would pop one.
        undoGroup: false,
        suppressDialogs: true,
        timeoutMs: 120_000,
      });
      if (!res.ok)
        return fail(`instance '${name}' started but opening the project failed: ${res.error}`);
      const r = res.result as { ok: boolean; error?: string; file?: string; numItems?: number };
      if (r.ok === false)
        return fail(`instance '${name}' started but opening the project failed: ${r.error}`);
      opened = { file: r.file ?? projectToOpen, numItems: r.numItems ?? 0 };
    }

    return {
      ok: true,
      instance: name,
      pid: aePid === null ? null : (child.pid ?? null),
      startupMs: Date.now() - launchedAt,
      project: opened,
      // Forward slashes, like every other path this server reports.
      copiedFrom: copiedFrom === null ? null : copiedFrom.replace(/\\/g, "/"),
      hint: `Address it with instance: ${JSON.stringify(name)} on any tool; instance.stop { name: ${JSON.stringify(name)} } shuts it down.`,
    };
  },
});

registerOp({
  name: "instance.stop",
  category: "instance",
  description:
    "Quit an After Effects instance by name. Refuses while the project has unsaved changes unless `save: true` " +
    "(save in place — the project must have a file) or `discardChanges: true`. Returns once the instance has " +
    "gone quiet. Use on workers you started with instance.start; it works on any live instance, so check " +
    "instance.list before stopping one you did not start.",
  params: [
    {
      name: "name",
      type: "string",
      description: "Instance id (as in instance.list)",
      required: true,
    },
    {
      name: "save",
      type: "boolean",
      description: "Save the project to its existing file before quitting (default false)",
      required: false,
    },
    {
      name: "discardChanges",
      type: "boolean",
      description: "Quit even if the project has unsaved changes (default false)",
      required: false,
    },
    {
      name: "timeoutMs",
      type: "number",
      description: `How long to wait for the instance to go quiet (default ${DEFAULT_STOP_TIMEOUT_MS}).`,
      required: false,
    },
  ],
  toJsx: () => nodeOnly("instance.stop"),
  async run(args, transport) {
    const name = sanitizeInstanceId(typeof args.name === "string" ? args.name : "");
    if (!name)
      return fail("name must contain letters, digits, '.', '_' or '-'", {
        errorCode: "INVALID_ARGS",
      });
    const dir = instanceDirFor(name);
    const before = await readInstance(dir);
    if (!before.alive) {
      return fail(`instance '${name}' is not live (${describeInstance(before)})`, {
        errorCode: "NO_INSTANCE",
      });
    }

    const res = await transport.execute({
      instance: name,
      label: "instance.stop",
      code: `
          var _save = ${jsxVal(!!args.save)};
          var _discard = ${jsxVal(!!args.discardChanges)};
          var _proj = app.project;
          var _file = _proj.file ? _proj.file.fsName.replace(/\\\\/g, "/") : null;
          if (_save) {
              if (!_file) return { ok: false, error: "the project has never been saved — save it with ae_save_project (path) first, or pass discardChanges: true" };
              _proj.save();
          } else if (_proj.dirty && !_discard) {
              return { ok: false, error: "the project has unsaved changes" + (_file ? " (" + _file + ")" : "") + " — pass save: true or discardChanges: true" };
          }
          // Close first so quitting never asks about saving; dialogs are
          // suppressed around this call anyway.
          _proj.close(CloseOptions.DO_NOT_SAVE_CHANGES);
          app.quit();
          return { ok: true, file: _file, saved: _save };
      `,
      undoGroup: false,
      suppressDialogs: true,
      timeoutMs: 30_000,
    });

    let file: string | null = null;
    if (res.ok) {
      const r = res.result as { ok: boolean; error?: string; file?: string | null };
      if (r.ok === false) return fail(r.error ?? "refused");
      file = r.file ?? null;
    } else if (res.errorCode !== "TIMEOUT" && res.errorCode !== "NO_INSTANCE") {
      // app.quit() may tear the process down before the response lands;
      // a timeout or a vanished heartbeat is therefore not a failure here —
      // the wait below decides. Anything else is.
      return fail(res.error ?? "unknown failure");
    }

    const timeoutMs =
      typeof args.timeoutMs === "number" && args.timeoutMs > 0
        ? args.timeoutMs
        : DEFAULT_STOP_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let gone = false;
    while (Date.now() < deadline) {
      const now = await readInstance(dir);
      if (!now.alive) {
        gone = true;
        break;
      }
      await sleep(500);
    }
    if (!gone) {
      return fail(
        `instance '${name}' accepted the quit but is still ticking after ${timeoutMs} ms — check it for a dialog`,
      );
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return { ok: true, instance: name, stopped: true, saved: !!args.save, file };
  },
});

registerOp({
  name: "instance.dialogs",
  category: "instance",
  description:
    "List the modal dialogs every running After Effects is showing — the message text, the owning process " +
    "and its window title, and an id for instance.dismiss_dialog. While a dialog is open no script runs " +
    "(calls fail with DIALOG_OPEN, or an instance stops ticking), and the dialog is often hidden behind the " +
    "main window. Windows and macOS. On macOS the text is read only with Accessibility permission for the " +
    "app running this server; without it dialogs are still listed, with empty text (`accessibility: false`).",
  params: [],
  readOnly: true,
  toJsx: () => nodeOnly("instance.dialogs"),
  async run() {
    const dialogs = await scanAeDialogs();
    return {
      ok: true,
      dialogs,
      supported: dialogScanSupported(),
    };
  },
});

registerOp({
  name: "instance.dismiss_dialog",
  category: "instance",
  description:
    "Close a modal dialog After Effects is showing by its cancel action (what Escape does). A warning " +
    "(missing files or fonts, a script alert) is acknowledged; a question is cancelled, never answered: " +
    '"Save changes before closing?" leaves the project open and unsaved. Take `id` from instance.dialogs ' +
    "or from a DIALOG_OPEN error's details.dialogs. When the user wants a dialog answered some other way " +
    "(Save, Replace…), ask them to click it. Windows and macOS; on macOS it needs Accessibility permission. " +
    "A dialog Escape does not close is left open unless it has a single button (an OK-only warning), " +
    "which is pressed.",
  params: [
    {
      name: "id",
      type: "string",
      description: "The dialog's id, as listed by instance.dialogs",
      required: true,
    },
  ],
  toJsx: () => nodeOnly("instance.dismiss_dialog"),
  async run(args) {
    if (!dialogScanSupported()) {
      return fail("instance.dismiss_dialog is only available on Windows and macOS");
    }
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const r = await dismissAeDialog(id);
    if (r.reason === "no_permission") {
      return fail(`cannot close After Effects dialog ${id}: no Accessibility permission`, {
        hint: ACCESSIBILITY_HINT,
      });
    }
    if (!r.posted) {
      return fail(
        `no After Effects dialog with id ${JSON.stringify(id)} is open — it may already be closed`,
        { hint: "Call instance.dialogs for the current list." },
      );
    }
    const remaining = await scanAeDialogs();
    return {
      ok: true,
      dismissed: { id, text: r.text },
      closed: r.closed,
      remaining,
      ...(r.closed
        ? {}
        : {
            hint: "The dialog did not close on its cancel action — ask the user to answer it in After Effects.",
          }),
    };
  },
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
