// Discovery and selection of After Effects instances on the pull path.
//
// Every instance running the resident agent (jsx/agent.jsx) keeps
// <runtime>/instances/<id>/heartbeat.json fresh — every second while idle,
// flagged `busy` around a request (ticks do not fire while a script runs, so a
// long call silences the heartbeat legitimately). This module reads those
// files and turns "which AE should this call go to" into a decision the
// transport can act on without touching AE.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  HEARTBEAT_BUSY_STALE_MS,
  HEARTBEAT_FILENAME,
  HEARTBEAT_STALE_MS,
  INSTANCE_DIR_SWEEP_MS,
  INSTANCES_DIR,
  sanitizeInstanceId,
} from "../config.js";

/** What jsx/agent.jsx writes. Every field but `id`/`ts` is best-effort. */
export interface Heartbeat {
  id: string;
  idSource?: "env" | "random";
  agentVersion?: number;
  aeVersion?: string;
  project: string | null;
  projectName: string | null;
  dirty?: boolean;
  numItems?: number;
  startedAt?: number;
  ticks?: number;
  served?: number;
  busy?: boolean;
  busySince?: number | null;
  lastError?: string | null;
  /** Epoch milliseconds, AE's clock — same machine as ours. */
  ts: number;
}

export interface InstanceInfo {
  id: string;
  dir: string;
  heartbeat: Heartbeat | null;
  /** Milliseconds since the last heartbeat, or null without one. */
  ageMs: number | null;
  alive: boolean;
}

export function isAlive(heartbeat: Heartbeat | null, now: number = Date.now()): boolean {
  if (heartbeat === null || typeof heartbeat.ts !== "number") return false;
  const age = now - heartbeat.ts;
  return age < (heartbeat.busy ? HEARTBEAT_BUSY_STALE_MS : HEARTBEAT_STALE_MS);
}

/** Describe one instance directory. Never throws; a missing or torn heartbeat reads as dead. */
export async function readInstance(dir: string, now: number = Date.now()): Promise<InstanceInfo> {
  const id = path.basename(dir);
  let heartbeat: Heartbeat | null = null;
  try {
    const raw = await fs.readFile(path.join(dir, HEARTBEAT_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<Heartbeat>;
    if (parsed && typeof parsed.ts === "number") {
      heartbeat = {
        ...parsed,
        id: typeof parsed.id === "string" ? parsed.id : id,
        project: typeof parsed.project === "string" ? parsed.project : null,
        projectName: typeof parsed.projectName === "string" ? parsed.projectName : null,
        ts: parsed.ts,
      };
    }
  } catch {
    /* no heartbeat yet, unreadable, or mid-rename — dead until proven otherwise */
  }
  return {
    id,
    dir,
    heartbeat,
    ageMs: heartbeat ? now - heartbeat.ts : null,
    alive: isAlive(heartbeat, now),
  };
}

/** Every instance directory, alive or not, sorted by id. */
export async function listInstances(
  instancesDir: string = INSTANCES_DIR,
  now: number = Date.now(),
): Promise<InstanceInfo[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(instancesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const infos: InstanceInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    infos.push(await readInstance(path.join(instancesDir, entry.name), now));
  }
  return infos.sort((a, b) => a.id.localeCompare(b.id));
}

function projectStem(name: string): string {
  return path
    .basename(name)
    .toLowerCase()
    .replace(/\.aepx?$/i, "");
}

/** Case-insensitive, separator-agnostic form of a path for equality checks. */
function projectPathKey(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

/**
 * Does `target` (as the user wrote it) name this instance? Three forms:
 *   - an id, matched exactly or after the same sanitizing the agent applied;
 *   - a project file name, with or without its extension, matched
 *     case-insensitively on the stem — "shotA" and "ShotA.aep" both address
 *     the instance that has ShotA.aep open;
 *   - a project PATH (anything containing a separator), matched on the whole
 *     resolved path — the way to pick one of two instances whose projects
 *     share a file name in different folders.
 */
export function matchesTarget(instance: InstanceInfo, target: string): boolean {
  const wanted = target.trim();
  if (wanted.length === 0) return false;
  if (instance.id === wanted || instance.id === sanitizeInstanceId(wanted)) return true;
  const hb = instance.heartbeat;
  if (/[\\/]/.test(wanted)) {
    return hb?.project ? projectPathKey(hb.project) === projectPathKey(wanted) : false;
  }
  const project = hb?.projectName ?? (hb?.project ? path.basename(hb.project) : null);
  if (!project) return false;
  return projectStem(project) === projectStem(wanted);
}

export type TargetResolution =
  | { mode: "push" }
  | { mode: "pull"; instance: InstanceInfo }
  | { mode: "error"; message: string; hint: string };

const INSTALL_HINT =
  "Each instance needs the resident agent: run `npx @kumoproductions/mcp-aftereffects install-agent` " +
  "once per After Effects version, then (re)start After Effects — the agent registers about ten " +
  "seconds after launch. To name an instance, set AE_MCP_INSTANCE in the environment that launches it " +
  "(works with `AfterFX.exe -m`); the server-side AE_MCP_INSTANCE can also name the project file it has open.";

/**
 * How an instance is named to people and models: the project it has open
 * first, because that is what anyone actually thinks of it as, then the id
 * in brackets — needed to address it when the project is untitled or open
 * twice. `ShotA.aep [ae-t6s4fl]`, `untitled [ae-9k2p1q]`.
 */
export function instanceLabel(instance: InstanceInfo): string {
  const project = instance.heartbeat?.projectName ?? "untitled";
  return `${project} [${instance.id}]`;
}

export function describeInstance(instance: InstanceInfo): string {
  const hb = instance.heartbeat;
  const state = instance.alive ? (hb?.busy ? "busy" : "live") : "stale";
  const seen =
    instance.ageMs === null ? "never seen" : `seen ${Math.round(instance.ageMs / 1000)}s ago`;
  return `${instanceLabel(instance)} (${state}, ${seen})`;
}

export function instanceSummary(instances: InstanceInfo[]): string {
  return instances.length === 0 ? "none" : instances.map(describeInstance).join("; ");
}

/**
 * Decide where a call goes.
 *
 * With a target: exactly one live instance must match. Without one: pull to
 * the single live instance if there is one, push when there is none — the
 * pre-agent behaviour, so a user who never installed the agent sees no change
 * — and refuse when several are live, because guessing would drive the wrong
 * project.
 */
export async function resolveTarget(
  target: string | null,
  instancesDir: string = INSTANCES_DIR,
  now: number = Date.now(),
): Promise<TargetResolution> {
  const all = await listInstances(instancesDir, now);
  const live = all.filter((i) => i.alive);

  if (target === null) {
    if (live.length === 0) return { mode: "push" };
    if (live.length === 1) return { mode: "pull", instance: live[0] };
    return {
      mode: "error",
      message:
        `${live.length} After Effects instances are live and none was named — ` +
        `set AE_MCP_INSTANCE to one of: ${live.map(instanceLabel).join(", ")}`,
      hint:
        'Name the instance by its id or by the project file it has open (e.g. "shotA" or "shotA.aep"): ' +
        "AE_MCP_INSTANCE on the server picks its default, and every tool takes an `instance` argument to " +
        `address another for one call. Live instances: ${instanceSummary(live)}.`,
    };
  }

  const matches = live.filter((i) => matchesTarget(i, target));
  if (matches.length === 1) return { mode: "pull", instance: matches[0] };
  if (matches.length > 1) {
    return {
      mode: "error",
      message:
        `'${target}' matches ${matches.length} live After Effects instances: ` +
        matches.map(instanceLabel).join(", "),
      hint: `Address one of them by id instead. Live instances: ${instanceSummary(live)}.`,
    };
  }
  const stale = all.filter((i) => !i.alive && matchesTarget(i, target));
  const why =
    stale.length > 0
      ? ` — it was last seen ${Math.round((stale[0].ageMs ?? 0) / 1000)}s ago and has stopped ticking (After Effects quit, crashed, or is stuck in a modal dialog)`
      : live.length > 0
        ? `; live instances: ${instanceSummary(live)}`
        : "; no instance has a live agent";
  return {
    mode: "error",
    message: `no live After Effects instance matches '${target}'${why}`,
    hint: INSTALL_HINT,
  };
}

/**
 * Remove instance directories nobody can still be using: heartbeat older than
 * INSTANCE_DIR_SWEEP_MS, or no heartbeat at all in a directory that old
 * (an agent creates the directory and heartbeats within the same tick).
 * Returns the ids removed. Best-effort — a directory that vanishes or is
 * held open underneath us is simply left for the next sweep.
 */
export async function sweepDeadInstanceDirs(
  instancesDir: string = INSTANCES_DIR,
  now: number = Date.now(),
): Promise<string[]> {
  const removed: string[] = [];
  for (const instance of await listInstances(instancesDir, now)) {
    let lastActivity: number | null = instance.heartbeat?.ts ?? null;
    if (lastActivity === null) {
      try {
        lastActivity = (await fs.stat(instance.dir)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (now - lastActivity < INSTANCE_DIR_SWEEP_MS) continue;
    try {
      await fs.rm(instance.dir, { recursive: true, force: true });
      removed.push(instance.id);
    } catch {
      /* raced with a returning agent, or locked — next time */
    }
  }
  return removed;
}
