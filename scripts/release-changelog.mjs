#!/usr/bin/env node
// Turns the CHANGELOG's `## [Unreleased]` section into the released one, so the
// heading, its date, and its release link can never drift from the tag — and so
// a release can't ship with its notes still filed under "Unreleased" (v0.1.1
// did). Wired into npm's version lifecycle:
//
//   preversion — `--check` refuses to start a release whose notes are missing
//                or empty, before package.json is touched.
//   version    — rewrites the heading and adds the release link; the version
//                script stages CHANGELOG.md into the version commit.
//
// The --file / --version / --date overrides exist so the rewrite can be
// exercised against a scratch file (tests/release-changelog.test.ts). The
// release path passes none of them.

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const FLAGS = new Set(["check", "allow-empty"]);
const OPTIONS = new Set(["file", "version", "date"]);

// A link reference definition at the foot of the file: `[0.1.0]: https://…`.
const LINK_DEF = /^\[[^\]]+\]:\s/;

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const { flags, options } = parseArgs(process.argv.slice(2));

const path = resolve(root, options.file ?? "CHANGELOG.md");
const rel = relative(root, path);
const name = rel.startsWith("..") ? path : rel;
const lines = readFileSync(path, "utf8").split("\n");

const start = lines.findIndex((line) => /^##\s+\[Unreleased\]\s*$/i.test(line));
if (start === -1) {
  fail(
    `${name} has no "## [Unreleased]" section — describe this release under one before bumping the version.`,
  );
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) {
    end = i;
    break;
  }
}

const hasNotes = lines
  .slice(start + 1, end)
  .some((line) => line.trim() !== "" && !LINK_DEF.test(line));
if (!hasNotes && !flags.has("allow-empty")) {
  fail(
    `"## [Unreleased]" in ${name} is empty — write the release notes first, or pass --allow-empty.`,
  );
}

if (flags.has("check")) {
  console.log(`${name}: [Unreleased] ready to release`);
  process.exit(0);
}

const version = options.version ?? pkg.version;
if (!version) fail("package.json has no version");

const date = options.date ?? today();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`--date must be YYYY-MM-DD, got: ${date}`);

const released = new RegExp(`^##\\s+\\[${escapeRegExp(version)}\\]`);
const duplicate = lines.findIndex((line, i) => i !== start && released.test(line));
if (duplicate !== -1) {
  fail(`${name} already has a section for ${version} (line ${duplicate + 1}) — nothing to stamp.`);
}

lines[start] = `## [${version}] - ${date}`;

// The section it pointed at is gone, so any `[Unreleased]:` definition goes
// with it. Drop it before the insert below, which works off line indices.
const unreleasedDef = lines.findIndex((line) => /^\[Unreleased\]:\s/i.test(line));
if (unreleasedDef !== -1) lines.splice(unreleasedDef, 1);

const url = releaseUrl(version);
if (url && !lines.some((line) => line.startsWith(`[${version}]:`))) {
  const link = `[${version}]: ${url}`;
  const firstDef = lines.findIndex((line) => LINK_DEF.test(line));
  if (firstDef === -1) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", link, "");
  } else {
    // Definitions run newest-first, matching the order of the sections above.
    lines.splice(firstDef, 0, link);
  }
}

writeFileSync(path, lines.join("\n"));
console.log(`${name}: [Unreleased] -> [${version}] - ${date}`);

function parseArgs(argv) {
  const parsedFlags = new Set();
  const parsedOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const key = arg.startsWith("--") ? arg.slice(2) : "";
    if (FLAGS.has(key)) {
      parsedFlags.add(key);
    } else if (OPTIONS.has(key)) {
      const value = argv[++i];
      if (value === undefined) fail(`--${key} needs a value`);
      parsedOptions[key] = value;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  return { flags: parsedFlags, options: parsedOptions };
}

/** The maintainer's local day — a release is dated where it was cut, not in UTC. */
function today() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function releaseUrl(tagVersion) {
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!raw) return null;
  const base = raw.replace(/^git\+/, "").replace(/\.git$/, "");
  return `${base}/releases/tag/v${tagVersion}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
