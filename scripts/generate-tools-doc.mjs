#!/usr/bin/env node
// Generate docs/TOOLS.md from the ALL_TOOLS registry.
// Pass --check to fail when the generated content diverges from the committed
// file — useful for CI drift detection.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");
const outPath = join(repoRoot, "docs", "TOOLS.md");
const distIndex = join(repoRoot, "dist", "tools", "index.js");

let ALL_TOOLS;
try {
  ({ ALL_TOOLS } = await import(new URL(`file://${distIndex}`).href));
} catch (err) {
  console.error(`Failed to import ${distIndex}. Run \`npm run build\` first.\n\n${err.message}`);
  process.exit(1);
}

const GROUP_META = [
  { id: "inspect", title: "Inspect", blurb: "Read-only project/comp/layer introspection." },
  {
    id: "document",
    title: "Document",
    blurb: "Save, JSON export, and JSON import of the whole project.",
  },
  { id: "render", title: "Render", blurb: "Single-frame rendering for visual verification." },
  {
    id: "operations",
    title: "Operations",
    blurb: "Atomic operation dispatch — discover with `ae_catalog`, execute with `ae_do`.",
  },
];

// First-line summary for the table. Keep tool source descriptions free-form;
// we trim to the first sentence for the doc to stay scannable.
function summarize(description) {
  const cleaned = description.replace(/\s+/g, " ").trim();
  const cutoff = cleaned.search(/(?<=[.!?])\s|\.$/);
  if (cutoff === -1) return cleaned;
  return cleaned.slice(0, cutoff + 1).trim();
}

function escapeCell(s) {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function renderGroupSection(meta, tools) {
  const header = `## ${meta.title}\n\n${meta.blurb}\n`;
  const tableHeader = "| Tool | Description |\n| --- | --- |";
  const rows = tools
    .map((t) => `| \`${t.name}\` | ${escapeCell(summarize(t.description))} |`)
    .join("\n");
  return `${header}\n${tableHeader}\n${rows}\n`;
}

function render(tools) {
  const byGroup = new Map();
  for (const t of tools) {
    if (!byGroup.has(t.group)) byGroup.set(t.group, []);
    byGroup.get(t.group).push(t);
  }

  const unknown = [...byGroup.keys()].filter((g) => !GROUP_META.some((m) => m.id === g));
  if (unknown.length) {
    console.error(`Unknown group(s) in ALL_TOOLS: ${unknown.join(", ")}`);
    process.exit(1);
  }

  const sections = GROUP_META.filter((m) => byGroup.has(m.id)).map((m) =>
    renderGroupSection(m, byGroup.get(m.id)),
  );

  const header = `# Tool reference

Generated from \`src/tools/**\` via \`npm run docs:tools\` — do not edit by hand. For a grouped summary and example prompts, see the main [README](../README.md).

\`ae_do\`'s operation registry (\`layer.*\`, \`keyframe.*\`, …) is discoverable at runtime via \`ae_catalog\` and is **not** listed in this file.

${tools.length} tools across ${sections.length} groups.
`;

  return `${header}\n${sections.join("\n")}`;
}

const content = render(ALL_TOOLS);

// oxfmt pads markdown tables, so route every write through it — otherwise the
// committed file (which has been formatted) never matches raw generator output.
function format(path) {
  execSync(`npx oxfmt "${path}"`, { stdio: "ignore" });
}

if (process.argv.includes("--check")) {
  const tmp = mkdtempSync(join(tmpdir(), "tools-doc-"));
  const tmpFile = join(tmp, "TOOLS.md");
  writeFileSync(tmpFile, content, "utf8");
  format(tmpFile);
  const fresh = readFileSync(tmpFile, "utf8");
  let committed = "";
  try {
    committed = readFileSync(outPath, "utf8");
  } catch {
    /* treat as missing */
  }
  if (committed === fresh) {
    process.exit(0);
  }
  console.error(`docs/TOOLS.md is out of date. Run \`npm run docs:tools\` and commit the result.`);
  process.exit(1);
}

mkdirSync(join(repoRoot, "docs"), { recursive: true });
writeFileSync(outPath, content, "utf8");
format(outPath);
console.log(`Wrote ${outPath} (${ALL_TOOLS.length} tools)`);
