// Shared test harness: builds the server on demand and drives it over the
// real MCP stdio transport, exactly as an MCP client would. The offline
// suite uses only paths that never contact After Effects; the e2e suite
// layers AE probing on top of the same client.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "dist", "index.js");

/** Newest mtime (ms) of any file under `dir`, or 0 if the dir is missing. */
function newestMtimeMs(dir: string): number {
  let newest = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtimeMs(full) : statSync(full).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

export function ensureBuilt(): void {
  // Rebuild when dist is missing OR stale — otherwise a run right after editing
  // a tool (e.g. adding one) would spawn the old build and fail confusingly
  // ("unknown tool …") instead of testing the current source.
  const stale =
    !existsSync(SERVER_ENTRY) ||
    newestMtimeMs(path.join(REPO_ROOT, "src")) > statSync(SERVER_ENTRY).mtimeMs;
  if (!stale) return;
  const r = spawnSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    throw new Error("failed to build MCP server before tests");
  }
}

/** Thin MCP client wrapper that returns JSON-parsed tool results. */
export class McpTestClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;

  constructor() {
    this.client = new Client(
      { name: "mcp-aftereffects-tests", version: "0.0.1" },
      { capabilities: {} },
    );
  }

  async connect(env: Record<string, string> = {}): Promise<void> {
    ensureBuilt();
    this.transport = new StdioClientTransport({
      command: process.execPath, // current Node binary
      args: [SERVER_ENTRY],
      // Let AE_MCP_* settings flow through from the shell env, with
      // per-test overrides on top.
      env: { ...process.env, ...env } as Record<string, string>,
    });
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      /* ignore */
    }
    this.transport = null;
  }

  /** Raw tools/list result. */
  async listTools(): Promise<{ tools: Array<{ name: string }> }> {
    return (await this.client.listTools()) as { tools: Array<{ name: string }> };
  }

  async call<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const res = await this.client.callTool(
      { name, arguments: args },
      undefined,
      options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined,
    );
    const text = extractText(res);
    if (res.isError) {
      throw new Error(`tool ${name} returned error: ${text}`);
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(`tool ${name} returned non-JSON text: ${text}`, { cause: err });
    }
  }

  /** Like call() but returns the raw error message instead of throwing. */
  async callExpectError(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const res = await this.client.callTool({ name, arguments: args });
    if (!res.isError) {
      throw new Error(`expected tool ${name} to error, got ok: ${extractText(res)}`);
    }
    return extractText(res);
  }

  /**
   * Returns the unwrapped MCP content array — used by tests that need to
   * inspect non-text parts (e.g. ``ae_render_frame`` can return image
   * content that ``call()``'s text extractor would miss).
   */
  async callRaw(
    name: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<{ content: Array<Record<string, unknown>> }> {
    const res = await this.client.callTool(
      { name, arguments: args },
      undefined,
      options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : undefined,
    );
    if (res.isError) {
      throw new Error(`tool ${name} returned error: ${extractText(res)}`);
    }
    const content = Array.isArray(res?.content)
      ? (res.content as Array<Record<string, unknown>>)
      : [];
    return { content };
  }
}

function extractText(res: unknown): string {
  const content = (res as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content) || content.length === 0) return "";
  const first = content[0] as { text?: unknown };
  return typeof first?.text === "string" ? first.text : "";
}

// probeAe added by e2e suite
