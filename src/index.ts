#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { RUNTIME_DIR } from "./config.js";
import { errorResult } from "./errors.js";
import { denyTool, policySummary, readOnlyMode } from "./policy.js";
import { FileIpcTransport } from "./transport/FileIpcTransport.js";

// Load all operations into the registry (must run before catalog/do handle calls).
import "./operations/index.js";
import { ALL_TOOLS, type AnyTool } from "./tools/index.js";

// Read the real package version at runtime so the server never self-reports a
// stale literal. dist/index.js sits one level below package.json in both the
// repo and the published tarball.
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const transport = new FileIpcTransport();

const server = new McpServer({
  name: "mcp-aftereffects",
  version,
});

/**
 * MCP behaviour hints, derived from each tool's declared `effect` rather than
 * from a name list that has to be kept in sync by hand. `ae_do` declares
 * itself destructive: its real effect depends on the operation it dispatches,
 * and clients that see no annotation at all tend to treat a tool as safe.
 */
function annotationsFor(tool: AnyTool): { readOnlyHint?: boolean; destructiveHint?: boolean } {
  switch (tool.effect) {
    case "read":
      return { readOnlyHint: true };
    case "destructive":
      return { destructiveHint: true };
    case "write":
      return { destructiveHint: false };
  }
}

function register(tool: AnyTool): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputShape,
      annotations: annotationsFor(tool),
    },
    async (args: unknown) => {
      try {
        return await tool.handler(args as any, transport);
      } catch (err) {
        // A handler throwing is a bug in this server, not a modelling error —
        // report it under its own code so it is never mistaken for a
        // retryable AE hiccup.
        return errorResult("TRANSPORT", err instanceof Error ? err.message : String(err), {
          details: { tool: tool.name },
          stack: err instanceof Error ? (err.stack ?? null) : null,
        });
      }
    },
  );
}

const skipped: string[] = [];
for (const tool of ALL_TOOLS) {
  const denial = denyTool(tool.name, tool.blockedInReadOnly);
  if (denial) {
    skipped.push(tool.name);
    continue;
  }
  register(tool);
}

async function main(): Promise<void> {
  console.error(`[mcp-aftereffects] policy: ${policySummary()}`);
  console.error(`[mcp-aftereffects] mailbox: ${RUNTIME_DIR}`);
  if (readOnlyMode()) {
    console.error(
      `[mcp-aftereffects] read-only mode — ${skipped.length > 0 ? `tools withheld: ${skipped.join(", ")}; ` : ""}` +
        "ae_do accepts only operations that cannot modify the project.",
    );
  } else {
    console.error(
      "[mcp-aftereffects] WRITE ACCESS IS ON — tools can create, mutate and delete project content. " +
        "Set AE_MCP_READONLY=1 for inspection-only sessions.",
    );
  }
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

main().catch((err) => {
  process.stderr.write(`mcp-aftereffects fatal: ${err && err.stack ? err.stack : String(err)}\n`);
  process.exit(1);
});
