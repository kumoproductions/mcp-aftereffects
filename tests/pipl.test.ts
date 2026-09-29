// PiPL reading (src/effects/pipl.ts): the flag → bit-depth mapping, the
// property-list parser in both byte orders, and the classic Mac resource-file
// walker — on synthetic buffers, so the suite runs anywhere. The PE walker is
// exercised against real plug-ins when an After Effects install is present.

import { describe, expect, it } from "vitest";

import {
  bpcFromFlags,
  defaultPluginDirs,
  parsePipl,
  rsrcResources,
  scanPluginDirs,
} from "../src/effects/pipl.js";

const DEEP = 1 << 25;
const SMART = 1 << 10;
const FLOAT = 1 << 12;

interface Prop {
  key: string;
  data: Buffer;
}

/** Build a PiPL property list the way PiPLTool compiles it. */
function buildPipl(props: Prop[], littleEndian: boolean): Buffer {
  const code = (s: string) =>
    Buffer.from(littleEndian ? s.split("").reverse().join("") : s, "latin1");
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    if (littleEndian) b.writeUInt32LE(n >>> 0);
    else b.writeUInt32BE(n >>> 0);
    return b;
  };
  const head = Buffer.alloc(10);
  if (littleEndian) {
    head.writeUInt16LE(1, 0);
    head.writeUInt32LE(props.length, 6);
  } else {
    head.writeUInt16BE(1, 0);
    head.writeUInt32BE(props.length, 6);
  }
  const parts: Buffer[] = [head];
  for (const p of props) {
    const pad = Buffer.alloc(((p.data.length + 3) & ~3) - p.data.length);
    parts.push(code("8BIM"), code(p.key), u32(0), u32(p.data.length), p.data, pad);
  }
  return Buffer.concat(parts);
}

function pstr(s: string): Buffer {
  return Buffer.concat([Buffer.from([s.length]), Buffer.from(s, "latin1")]);
}

function effectPipl(matchName: string, glo: number, gl2: number, le: boolean): Buffer {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    if (le) b.writeUInt32LE(n >>> 0);
    else b.writeUInt32BE(n >>> 0);
    return b;
  };
  const kind = Buffer.from(le ? "TKFe" : "eFKT", "latin1");
  return buildPipl(
    [
      { key: "kind", data: kind },
      { key: "name", data: pstr("Display") },
      { key: "eMNA", data: pstr(matchName) },
      { key: "eGLO", data: u32(glo) },
      { key: "eGL2", data: u32(gl2) },
    ],
    le,
  );
}

describe("bpcFromFlags", () => {
  it("needs FLOAT_COLOR_AWARE together with SUPPORTS_SMART_RENDER for 32bpc", () => {
    expect(bpcFromFlags(DEEP, FLOAT | SMART)).toBe(32);
    // FLOAT without SMART is ignored by After Effects.
    expect(bpcFromFlags(DEEP, FLOAT)).toBe(16);
    expect(bpcFromFlags(DEEP, 0)).toBe(16);
    expect(bpcFromFlags(0, 0)).toBe(8);
  });
});

describe("parsePipl", () => {
  it("reads a Windows (little-endian, reversed codes) effect PiPL", () => {
    const fx = parsePipl(effectPipl("CC Light Rays", DEEP, FLOAT | SMART, true), true);
    expect(fx).toEqual({ matchName: "CC Light Rays", bpc: 32 });
  });

  it("reads a macOS (big-endian) effect PiPL", () => {
    const fx = parsePipl(effectPipl("CC Bender", DEEP, SMART, false), false);
    expect(fx).toEqual({ matchName: "CC Bender", bpc: 16 });
  });

  it("ignores PiPLs that are not effects, and malformed data", () => {
    const aegp = buildPipl([{ key: "kind", data: Buffer.from("PGEA", "latin1") }], true);
    expect(parsePipl(aegp, true)).toBeNull();
    expect(parsePipl(Buffer.from([1, 0, 0]), true)).toBeNull();
    // Declared length runs past the buffer.
    const truncated = effectPipl("X", 0, 0, true).subarray(0, 40);
    expect(parsePipl(truncated, true)).toBeNull();
  });
});

describe("rsrcResources", () => {
  /** A minimal classic resource file holding the given PiPL resources. */
  function buildRsrc(resources: Buffer[]): Buffer {
    const dataParts: Buffer[] = [];
    const offsets: number[] = [];
    let at = 0;
    for (const r of resources) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(r.length);
      offsets.push(at);
      dataParts.push(len, r);
      at += 4 + r.length;
    }
    const data = Buffer.concat(dataParts);
    const dataOff = 256;
    // Map: 16 reserved + 4 handle + 2 fileRef + 2 attrs + 2 typeListOff + 2 nameListOff
    const typeListOff = 28;
    const typeList = Buffer.alloc(2 + 8);
    typeList.writeUInt16BE(0, 0); // one type
    typeList.write("PiPL", 2, "latin1");
    typeList.writeUInt16BE(resources.length - 1, 6);
    typeList.writeUInt16BE(10, 8); // ref list right after the type list
    const refs = Buffer.alloc(12 * resources.length);
    offsets.forEach((o, i) => {
      refs.writeUInt16BE(16000 + i, i * 12);
      refs.writeUInt16BE(0xffff, i * 12 + 2);
      refs.writeUInt32BE(o & 0x00ffffff, i * 12 + 4);
    });
    const mapHead = Buffer.alloc(typeListOff);
    mapHead.writeUInt16BE(typeListOff, 24);
    const map = Buffer.concat([mapHead, typeList, refs]);
    const mapOff = dataOff + data.length;
    const header = Buffer.alloc(dataOff);
    header.writeUInt32BE(dataOff, 0);
    header.writeUInt32BE(mapOff, 4);
    header.writeUInt32BE(data.length, 8);
    header.writeUInt32BE(map.length, 12);
    return Buffer.concat([header, data, map]);
  }

  it("finds every PiPL resource in a resource file", () => {
    const a = effectPipl("FX A", DEEP, FLOAT | SMART, false);
    const b = effectPipl("FX B", 0, 0, false);
    const found = rsrcResources(buildRsrc([a, b]));
    expect(found.map((r) => parsePipl(r, false))).toEqual([
      { matchName: "FX A", bpc: 32 },
      { matchName: "FX B", bpc: 8 },
    ]);
  });

  it("skips a resource whose declared length runs past the file", () => {
    const whole = buildRsrc([effectPipl("FX A", DEEP, FLOAT | SMART, false)]);
    // Declare a length longer than the whole file.
    const dataOff = whole.readUInt32BE(0);
    whole.writeUInt32BE(whole.readUInt32BE(dataOff) + whole.length, dataOff);
    expect(rsrcResources(whole)).toEqual([]);
  });

  it("returns nothing for garbage", () => {
    expect(rsrcResources(Buffer.from("not a resource file"))).toEqual([]);
  });
});

// Scanned once; the suite below runs only where Cycore is actually installed
// (the MediaCore folder alone exists on machines without After Effects).
const INSTALLED = process.platform === "win32" ? scanPluginDirs(defaultPluginDirs()) : new Map();

describe("scanPluginDirs against an installed After Effects", () => {
  it.skipIf(!INSTALLED.has("CC Light Rays"))(
    "reads the bundled Cycore effects' depths from their .aex files",
    () => {
      // Known badges in the Effects & Presets panel.
      expect(INSTALLED.get("CC Light Rays")?.bpc).toBe(32);
      expect(INSTALLED.get("CC Bender")?.bpc).toBe(16);
      // Adobe's own effects register in code and have no PiPL.
      expect(INSTALLED.has("ADBE Gaussian Blur 2")).toBe(false);
    },
  );
});
