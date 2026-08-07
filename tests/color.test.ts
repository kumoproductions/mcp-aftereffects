// Color-managed capture pipeline, fully offline: PNG codec roundtrip,
// working-space transform math, and calibration analysis — the pieces that
// turn a raw saveFrameToPng dump into a viewer-matching sRGB image.

import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";

import { analyzeCalibrationPng } from "../src/color/calibration.js";
import { decodePng, encodePngSrgb8 } from "../src/color/png16.js";
import {
  AP1_TO_REC709,
  profileForWorkingSpace,
  sceneLinearToDisplaySrgb,
  srgbEncode,
} from "../src/color/transform.js";

/** Build a minimal 16-bit RGB PNG (filter 0) for decoder tests. */
function makePng16(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(16, 8);
  ihdr.writeUInt8(2, 9);
  const stride = width * 6;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw.writeUInt16BE(Math.round(r * 65535), row + 1 + x * 6);
      raw.writeUInt16BE(Math.round(g * 65535), row + 1 + x * 6 + 2);
      raw.writeUInt16BE(Math.round(b * 65535), row + 1 + x * 6 + 4);
    }
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("png16 codec", () => {
  it("decodes a 16-bit RGB PNG to normalized values", () => {
    const buf = makePng16(4, 2, (x) => [x / 4, 0.5, 1]);
    const img = decodePng(buf);
    expect(img.width).toBe(4);
    expect(img.height).toBe(2);
    expect(img.bitDepth).toBe(16);
    expect(img.rgb[0]).toBeCloseTo(0, 4);
    expect(img.rgb[3]).toBeCloseTo(0.25, 4);
    expect(img.rgb[1]).toBeCloseTo(0.5, 4);
    expect(img.rgb[2]).toBeCloseTo(1, 4);
  });

  it("roundtrips through the sRGB-tagged 8-bit encoder", () => {
    const src = new Float64Array([0, 0.25, 0.5, 1, 0.8, 0.2]);
    const buf = encodePngSrgb8(2, 1, src);
    // Chunks: tagged for color.
    expect(buf.toString("latin1")).toContain("sRGB");
    expect(buf.toString("latin1")).toContain("gAMA");
    const img = decodePng(buf);
    expect(img.bitDepth).toBe(8);
    for (let i = 0; i < src.length; i++) {
      expect(img.rgb[i]).toBeCloseTo(src[i], 2);
    }
  });
});

describe("working-space transform", () => {
  it("recognizes the working spaces it can convert", () => {
    expect(profileForWorkingSpace("ACES/ACEScg")).not.toBeNull();
    expect(profileForWorkingSpace("ACEScg")).not.toBeNull();
    expect(profileForWorkingSpace("ACES2065-1")).not.toBeNull();
    expect(profileForWorkingSpace("Rec.709 Gamma 2.4")).toBeNull();
    expect(profileForWorkingSpace("Adobe RGB (1998)")).toBeNull();
  });

  it("tone-maps ACEScg mid gray brighter than a naive matrix conversion", () => {
    // 0.18 scene-linear through the ACES output transform lands well above
    // srgbEncode(0.18) — the tone curve is the whole reason the naive
    // conversion mismatched the viewer.
    const rgb = new Float64Array([0.18, 0.18, 0.18]);
    sceneLinearToDisplaySrgb(rgb, AP1_TO_REC709);
    expect(rgb[0]).toBeGreaterThan(0.3);
    expect(rgb[0]).toBeLessThan(0.65);
    // Achromatic in ≈ achromatic out.
    expect(Math.abs(rgb[0] - rgb[1])).toBeLessThan(0.02);
    expect(Math.abs(rgb[1] - rgb[2])).toBeLessThan(0.02);
  });

  it("maps working-space white near display white and keeps overbrights finite", () => {
    const rgb = new Float64Array([1, 1, 1, 8, 8, 8]);
    sceneLinearToDisplaySrgb(rgb, AP1_TO_REC709);
    expect(rgb[0]).toBeGreaterThan(0.75);
    expect(rgb[0]).toBeLessThanOrEqual(1);
    expect(rgb[3]).toBeGreaterThanOrEqual(rgb[0]);
    expect(rgb[3]).toBeLessThanOrEqual(1);
  });

  it("srgbEncode matches the IEC transfer at the breakpoints", () => {
    expect(srgbEncode(0)).toBe(0);
    expect(srgbEncode(1)).toBeCloseTo(1, 6);
    expect(srgbEncode(0.0031308)).toBeCloseTo(0.04045, 3);
  });
});

describe("calibration analysis", () => {
  const VALS = [0.05, 0.18, 0.5, 1.0];

  function calibPng(transfer: (v: number) => number): Buffer {
    return makePng16(160, 40, (x) => {
      const v = transfer(VALS[Math.min(3, Math.floor(x / 40))]);
      return [v, v, v];
    });
  }

  it("detects the measured AE 26.3 behavior: a flat linear scale", () => {
    const res = analyzeCalibrationPng(calibPng((v) => v * 0.1));
    expect(res.kind).toBe("linear");
    expect(res.scale).toBeCloseTo(0.1, 3);
  });

  it("detects identity (non-color-managed projects)", () => {
    const res = analyzeCalibrationPng(calibPng((v) => v));
    expect(res.kind).toBe("identity");
  });

  it("reports a curved transfer as unknown instead of guessing", () => {
    const res = analyzeCalibrationPng(calibPng((v) => v * v));
    expect(res.kind).toBe("unknown");
  });
});
