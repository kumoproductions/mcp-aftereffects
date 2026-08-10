// Runtime measurement of what saveFrameToPng does to pixel values.
//
// In a color-managed project, After Effects writes the scene-linear working
// buffer through an undocumented transfer (measured: a flat ×0.1 on AE 26.3,
// i.e. 10× highlight headroom in the 16-bit container). Rather than hardcode
// that constant, a tiny calibration comp of known-value solids is rendered
// once per (project, working space, depth) and the transfer is measured —
// so a future AE changing the scale degrades to a clear "unknown transfer"
// warning instead of silently wrong output.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { jsxVal } from "../registry.js";
import type { AeTransport } from "../transport/AeTransport.js";
import { decodePng } from "./png16.js";
import { readFileSettled } from "./settled-read.js";

const CALIB_VALUES = [0.05, 0.18, 0.5, 1.0];
const PATCH = 40; // px per patch, square

export interface CalibrationResult {
  kind: "identity" | "linear" | "unknown";
  /** For "linear": PNG value = scale × buffer value. 1 for "identity". */
  scale: number;
  samples: Array<{ input: number; output: number }>;
}

const cache = new Map<string, CalibrationResult>();

export function calibrationKey(
  projectFile: string | null,
  workingSpace: string,
  bitsPerChannel: number,
): string {
  return `${projectFile ?? "(unsaved)"}|${workingSpace}|${bitsPerChannel}`;
}

/** Analysis half, separated for offline tests. */
export function analyzeCalibrationPng(buf: Buffer): CalibrationResult {
  const img = decodePng(buf);
  const samples: Array<{ input: number; output: number }> = [];
  for (let i = 0; i < CALIB_VALUES.length; i++) {
    const x = PATCH * i + PATCH / 2;
    const y = Math.floor(img.height / 2);
    samples.push({ input: CALIB_VALUES[i], output: img.rgb[(y * img.width + x) * 3] });
  }
  const ratios = samples.map((s) => s.output / s.input);
  const min = Math.min(...ratios);
  const max = Math.max(...ratios);
  if (min > 0 && max / min < 1.03) {
    const scale = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    if (Math.abs(scale - 1) < 0.02) return { kind: "identity", scale: 1, samples };
    return { kind: "linear", scale, samples };
  }
  return { kind: "unknown", scale: 1, samples };
}

/**
 * Measure the capture transfer for the current project state. One AE round
 * trip (one undo group; the calibration comp and its solids are removed
 * before it returns). Results are cached per project/working-space/depth for
 * the lifetime of the server process.
 */
export async function measureCaptureTransfer(
  transport: AeTransport,
  key: string,
  allowRender = true,
): Promise<CalibrationResult | { error: string }> {
  const cached = cache.get(key);
  if (cached) return cached;
  if (!allowRender) {
    return {
      error:
        "calibration needs a (transient, undo-grouped) render of a temporary comp, which read-only mode forbids",
    };
  }

  const pngPath = path.join(os.tmpdir(), `mcp-ae-calib-${randomUUID()}.png`).replace(/\\/g, "/");
  const code = `
        var _vals = ${jsxVal(CALIB_VALUES)};
        var _patch = ${jsxVal(PATCH)};
        var _w = _patch * _vals.length;
        var _tmp = app.project.items.addComp("__mcp_calibration__", _w, _patch, 1, 1, 24);
        var _srcs = [];
        var _out = { ok: true };
        try {
            for (var _i = 0; _i < _vals.length; _i++) {
                var _v = _vals[_i];
                var _s = _tmp.layers.addSolid([_v, _v, _v], "c" + _i, _patch, _patch, 1);
                if (_s.source) _srcs.push(_s.source);
                _s.property("Transform").property("Position").setValue([_patch * _i + _patch / 2, _patch / 2]);
            }
            _tmp.saveFrameToPng(0, new File(${jsxVal(pngPath)}));
            _out.saved = true;
        } catch (eCal) { _out.ok = false; _out.error = AE.errText(eCal); }
        try { _tmp.remove(); } catch (eRm) { /* leave for undo */ }
        for (var _j = 0; _j < _srcs.length; _j++) { try { _srcs[_j].remove(); } catch (eRs) { } }
        return _out;
    `;
  const result = await transport.execute({ code, label: "capture_calibration", timeoutMs: 60_000 });
  if (!result.ok) return { error: `calibration render failed: ${result.error}` };
  const payload = result.result as { ok?: boolean; saved?: boolean; error?: string } | null;
  if (!payload || payload.ok !== true || payload.saved !== true) {
    return { error: `calibration failed inside AE: ${payload?.error ?? "no result"}` };
  }

  let buf: Buffer;
  try {
    // saveFrameToPng writes asynchronously — wait for the file to settle.
    buf = await readFileSettled(pngPath);
  } catch (err) {
    return {
      error: `calibration PNG unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    fs.unlink(pngPath).catch(() => {});
  }

  try {
    const analysis = analyzeCalibrationPng(buf);
    cache.set(key, analysis);
    return analysis;
  } catch (err) {
    return {
      error: `calibration analysis failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
