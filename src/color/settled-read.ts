// CompItem.saveFrameToPng returns before the PNG hits the disk — the write
// completes asynchronously (measured on AE 26.3: the file appears up to a few
// hundred ms after the ExtendScript call returns, and even File.exists inside
// the same script run reports false). Any consumer that reads the capture
// right after the call must wait for the file to exist AND stop growing.

import { promises as fs } from "node:fs";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read a file once it has settled: present, non-empty, and unchanged in size
 * for `stableMs`. Throws when `timeoutMs` elapses first.
 */
export async function readFileSettled(
  filePath: string,
  timeoutMs = 15_000,
  stableMs = 250,
): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let lastChange = Date.now();
  for (;;) {
    let size = -1;
    try {
      size = (await fs.stat(filePath)).size;
    } catch {
      /* not there yet */
    }
    if (size >= 0) {
      if (size !== lastSize) {
        lastSize = size;
        lastChange = Date.now();
      } else if (size > 0 && Date.now() - lastChange >= stableMs) {
        return fs.readFile(filePath);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `file did not settle within ${timeoutMs}ms (saveFrameToPng writes asynchronously): ${filePath}`,
      );
    }
    await sleep(60);
  }
}
