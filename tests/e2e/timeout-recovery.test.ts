// DESTRUCTIVE test: intentionally hangs After Effects with an infinite loop,
// verifies that the transport times out cleanly, then `taskkill /F /IM
// AfterFX.exe`s AE, relaunches it, and verifies the transport can round-trip
// again. ALL AE session state (open project, selection, unsaved changes) is
// lost.
//
// Because of that it is NOT part of the normal `npm test` flow:
//   - it only runs when AE_MCP_E2E_DESTRUCTIVE=1 is set, and
//   - it must be run STANDALONE and LAST, after every other suite:
//
//       vitest run tests/e2e/timeout-recovery.test.ts
//
// Running it alongside other AE suites would kill the instance they depend on.

import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

import { resolveAfterFxPath } from "../../src/config.js";
import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import { printSkipBanner, probeAe } from "./harness.js";

const execAsync = promisify(exec);
const DESTRUCTIVE_ENABLED = process.env.AE_MCP_E2E_DESTRUCTIVE === "1";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killAe(): Promise<void> {
  try {
    await execAsync(
      process.platform === "darwin"
        ? 'pkill -9 -f "Adobe After Effects"'
        : "taskkill /F /IM AfterFX.exe",
    );
  } catch {
    // already dead or doesn't exist
  }
  // Wait briefly for the process to fully terminate
  await sleep(1500);
}

async function startAe(): Promise<void> {
  const exe = resolveAfterFxPath();
  // Detached non-blocking launch; on macOS the resolved path is the .app
  // bundle, which only `open` can launch.
  const child =
    process.platform === "darwin"
      ? spawn("open", ["-a", exe], { detached: true, stdio: "ignore" })
      : spawn(exe, [], { detached: true, stdio: "ignore" });
  child.unref();
  // Wait for AE to come up enough to accept dispatcher launches
  await sleep(12_000);
}

async function waitForAeReady(transport: FileIpcTransport, maxAttempts: number): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await transport.execute({ code: "return 'ready';", timeoutMs: 8000 });
    if (res.ok && res.result === "ready") return true;
    await sleep(2000);
  }
  return false;
}

let ready = false;
let transport: FileIpcTransport | null = null;

describe("e2e timeout & recovery (destructive)", () => {
  beforeAll(async () => {
    if (!DESTRUCTIVE_ENABLED) {
      printSkipBanner("timeout-recovery", "SKIPPING — AE_MCP_E2E_DESTRUCTIVE not set", [
        " This suite hangs After Effects and then taskkills + relaunches it.",
        " ALL unsaved AE state is lost. Opt in explicitly and run it",
        " standalone, LAST:",
        "   PowerShell : $env:AE_MCP_E2E_DESTRUCTIVE = '1'; npx vitest run tests/e2e/timeout-recovery.test.ts",
        "   cmd        : set AE_MCP_E2E_DESTRUCTIVE=1 && npx vitest run tests/e2e/timeout-recovery.test.ts",
      ]);
      return;
    }
    // The hang phase needs a responsive AE to begin with — probe first so a
    // machine without AE running skips instead of failing confusingly.
    const probe = await probeAe("timeout-recovery");
    if (!probe.ready || !probe.transport) return;
    transport = probe.transport;
    ready = true;
  });

  it("timeout: infinite loop returns ok:false in bounded time", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    const started = Date.now();
    const res = await transport.execute({
      code: "while(true){} return 'never';",
      label: "hang_test",
      timeoutMs: 4000,
    });
    const elapsed = Date.now() - started;
    expect(res.ok, "expected timeout error, got ok").toBe(false);
    expect(elapsed, "should have timed out under 8s").toBeLessThan(8000);
    expect(res.error ?? "", "error should mention timeout").toContain("timeout");
  });

  // AE is now hung in while(true) — recover by killing.
  it("recovery: taskkill AE, restart, round-trip again", async (ctx) => {
    if (!ready || !transport) return ctx.skip();
    await killAe();
    await startAe();
    const aeReady = await waitForAeReady(transport, 6);
    expect(aeReady, "AE did not become ready after restart").toBe(true);
    const res = await transport.execute({
      code: "return { alive: true, version: app.version };",
      timeoutMs: 15_000,
    });
    expect(res.ok, `post-restart call failed: ${res.error}`).toBe(true);
  });
});
