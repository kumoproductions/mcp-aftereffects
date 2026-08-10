// scripts/release-changelog.mjs runs inside `npm version`, where a mistake is
// expensive: the rewrite lands in the version commit that the tag — and every
// publish job keyed off it — is cut from. It is exercised here as the CLI the
// lifecycle actually invokes, against scratch files.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/release-changelog.mjs", import.meta.url));

const HEADER = `# Changelog

All notable changes to this project will be documented in this file.
`;

const RELEASED = `## [0.1.0] - 2026-08-09

### Added

- The first one.

[0.1.0]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.1.0
`;

const UNRELEASED = `## [Unreleased]

### Fixed

- Something that was broken.

`;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ae-mcp-changelog-"));
});

/** Writes `content` to a scratch CHANGELOG and runs the script over it. */
function run(content: string, args: string[]) {
  const path = join(dir, `${args.join("_").replace(/[^a-z0-9]+/gi, "-")}.md`);
  writeFileSync(path, content);
  const result = spawnSync(process.execPath, [SCRIPT, "--file", path, ...args], {
    encoding: "utf8",
  });
  return { ...result, path, read: () => readFileSync(path, "utf8") };
}

const stamp = ["--version", "0.2.0", "--date", "2026-09-01"];

describe("release-changelog", () => {
  it("stamps the heading with the version and date", () => {
    const { status, read } = run(`${HEADER}\n${UNRELEASED}${RELEASED}`, stamp);
    expect(status).toBe(0);
    expect(read()).toContain("## [0.2.0] - 2026-09-01");
    expect(read()).not.toContain("[Unreleased]");
  });

  it("keeps the notes and the older sections untouched", () => {
    const { read } = run(`${HEADER}\n${UNRELEASED}${RELEASED}`, stamp);
    expect(read()).toContain("- Something that was broken.");
    expect(read()).toContain("## [0.1.0] - 2026-08-09");
    expect(read().endsWith("\n")).toBe(true);
  });

  it("adds the release link above the existing definitions", () => {
    const { read } = run(`${HEADER}\n${UNRELEASED}${RELEASED}`, stamp);
    const defs = read()
      .split("\n")
      .filter((line) => line.startsWith("["));
    expect(defs).toEqual([
      "[0.2.0]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.2.0",
      "[0.1.0]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.1.0",
    ]);
  });

  it("starts a link block when the file has none", () => {
    const { read } = run(`${HEADER}\n${UNRELEASED}`, stamp);
    expect(
      read().endsWith(
        "\n[0.2.0]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.2.0\n",
      ),
    ).toBe(true);
  });

  it("replaces an [Unreleased] link definition rather than orphaning it", () => {
    const content = `${HEADER}\n${UNRELEASED}${RELEASED}[Unreleased]: https://github.com/kumoproductions/mcp-aftereffects/compare/v0.1.0...HEAD\n`;
    const { read } = run(content, stamp);
    expect(read()).not.toContain("[Unreleased]:");
    expect(read()).toContain("[0.2.0]: ");
  });

  it("refuses a file with no [Unreleased] section", () => {
    const { status, stderr } = run(`${HEADER}\n${RELEASED}`, stamp);
    expect(status).toBe(1);
    expect(stderr).toContain('no "## [Unreleased]" section');
  });

  it("refuses an empty [Unreleased] section", () => {
    const { status, stderr } = run(`${HEADER}\n## [Unreleased]\n\n${RELEASED}`, stamp);
    expect(status).toBe(1);
    expect(stderr).toContain("is empty");
  });

  it("releases an empty section only when asked to", () => {
    const { status, read } = run(`${HEADER}\n## [Unreleased]\n\n${RELEASED}`, [
      ...stamp,
      "--allow-empty",
    ]);
    expect(status).toBe(0);
    expect(read()).toContain("## [0.2.0] - 2026-09-01");
  });

  it("refuses to stamp a version the file already documents", () => {
    const { status, stderr } = run(`${HEADER}\n${UNRELEASED}${RELEASED}`, ["--version", "0.1.0"]);
    expect(status).toBe(1);
    expect(stderr).toContain("already has a section for 0.1.0");
  });

  it("--check reports readiness without touching the file", () => {
    const content = `${HEADER}\n${UNRELEASED}${RELEASED}`;
    const { status, read } = run(content, ["--check"]);
    expect(status).toBe(0);
    expect(read()).toBe(content);
  });

  it("--check fails the same way the stamp would", () => {
    expect(run(`${HEADER}\n${RELEASED}`, ["--check"]).status).toBe(1);
    expect(run(`${HEADER}\n## [Unreleased]\n\n${RELEASED}`, ["--check"]).status).toBe(1);
  });

  it("rejects an unknown argument instead of releasing", () => {
    const { status, stderr } = run(`${HEADER}\n${UNRELEASED}${RELEASED}`, ["--dry-run"]);
    expect(status).toBe(1);
    expect(stderr).toContain("unknown argument: --dry-run");
  });

  it("rejects a malformed date", () => {
    const { status, stderr } = run(`${HEADER}\n${UNRELEASED}${RELEASED}`, [
      "--version",
      "0.2.0",
      "--date",
      "2026/09/01",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("--date must be YYYY-MM-DD");
  });
});
