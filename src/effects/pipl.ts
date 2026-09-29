// Processing bit depth of plug-in effects, read from their PiPL resources.
//
// A compiled After Effects effect declares its capabilities in a PiPL
// ("plug-in property list") resource: `eGLO` carries PF_OutFlags and `eGL2`
// PF_OutFlags2. Two bits decide the bit depth the effect renders at:
//   PF_OutFlag_DEEP_COLOR_AWARE    (eGLO, 1 << 25) → 16bpc
//   PF_OutFlag2_FLOAT_COLOR_AWARE  (eGL2, 1 << 12) → 32bpc, honoured only
//     together with PF_OutFlag2_SUPPORTS_SMART_RENDER (eGL2, 1 << 10)
// This is exactly what the Effects & Presets panel badges are drawn from.
//
// Reading the flags is the only SAFE way to learn a third-party effect's
// depth: measuring it means rendering it, and a third-party render can block
// After Effects indefinitely (licensing / activation UI — observed with Red
// Giant Universe on AE 26.5). Adobe's own effects register in code and carry
// no PiPL; jsx/toolkit.jsx measures those instead (AE.effectBitDepth).
//
// Windows: PiPL is a PE resource of type "PIPL" inside .aex/.prm/.dll files,
// little-endian with every four-char code byte-reversed ("MIB8" = '8BIM').
// macOS: PiPL lives in <bundle>.plugin/Contents/Resources/*.rsrc, a classic
// resource-fork file, big-endian with four-char codes in natural order.
//
// Files are read partially (headers, then the resource section/file) and the
// scan runs once per process. Everything here fails soft: an unreadable or
// malformed file contributes nothing.

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import * as path from "node:path";

import { resolveAfterFxPath } from "../config.js";

export type Bpc = 8 | 16 | 32;

export interface PiplEffect {
  matchName: string;
  bpc: Bpc;
  /** The plug-in file the PiPL came from. */
  file: string;
}

const PF_OUT_FLAG_DEEP_COLOR_AWARE = 1 << 25;
const PF_OUT_FLAG2_SUPPORTS_SMART_RENDER = 1 << 10;
const PF_OUT_FLAG2_FLOAT_COLOR_AWARE = 1 << 12;

/** Bit depth from an effect's eGLO / eGL2 flags. */
export function bpcFromFlags(outFlags: number, outFlags2: number): Bpc {
  const f2 = outFlags2 >>> 0;
  if (
    (f2 & PF_OUT_FLAG2_FLOAT_COLOR_AWARE) !== 0 &&
    (f2 & PF_OUT_FLAG2_SUPPORTS_SMART_RENDER) !== 0
  ) {
    return 32;
  }
  return ((outFlags >>> 0) & PF_OUT_FLAG_DEEP_COLOR_AWARE) !== 0 ? 16 : 8;
}

/**
 * Parse one PiPL resource. Returns the effect it declares, or null for a
 * PiPL that is not an effect (importers, AEGPs, …) or is malformed.
 */
export function parsePipl(data: Buffer, littleEndian: boolean): Omit<PiplEffect, "file"> | null {
  try {
    const u32 = (o: number) => (littleEndian ? data.readUInt32LE(o) : data.readUInt32BE(o));
    const code = (o: number) => {
      const s = data.toString("latin1", o, o + 4);
      return littleEndian ? s.split("").reverse().join("") : s;
    };
    // Header: int16 version, int32 reserved, int32 property count.
    const count = u32(6);
    let p = 10;
    let kind: string | null = null;
    let matchName: string | null = null;
    let outFlags: number | null = null;
    let outFlags2 = 0;
    for (let i = 0; i < count && p + 16 <= data.length; i++) {
      const key = code(p + 4);
      const len = u32(p + 12);
      const body = p + 16;
      if (body + len > data.length) break;
      if (key === "kind" && len >= 4) kind = code(body);
      else if (key === "eMNA" && len >= 1) {
        // Pascal string.
        const n = data[body];
        matchName = data.toString("latin1", body + 1, Math.min(body + 1 + n, body + len));
      } else if (key === "eGLO" && len >= 4) outFlags = u32(body);
      else if (key === "eGL2" && len >= 4) outFlags2 = u32(body);
      p = body + ((len + 3) & ~3);
    }
    if (kind !== "eFKT" || !matchName || outFlags === null) return null;
    return { matchName, bpc: bpcFromFlags(outFlags, outFlags2) };
  } catch {
    return null;
  }
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  return n === length ? buf : buf.subarray(0, n);
}

/** Every PIPL resource in a PE file (.aex / .prm / .dll). */
export function peResources(file: string, typeName = "PIPL"): Buffer[] {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const dos = readAt(fd, 0, 64);
    if (dos.length < 64 || dos.toString("latin1", 0, 2) !== "MZ") return [];
    const pe = dos.readUInt32LE(0x3c);
    const head = readAt(fd, pe, 24 + 240);
    if (head.length < 24 || head.toString("latin1", 0, 4) !== "PE\0\0") return [];
    const numSections = head.readUInt16LE(6);
    const optSize = head.readUInt16LE(20);
    const opt = readAt(fd, pe + 24, optSize);
    if (opt.length < optSize) return [];
    const magic = opt.readUInt16LE(0);
    const dataDirs = magic === 0x20b ? 112 : 96;
    if (optSize < dataDirs + 3 * 8) return [];
    const rsrcRva = opt.readUInt32LE(dataDirs + 2 * 8);
    if (rsrcRva === 0) return [];
    const sections = readAt(fd, pe + 24 + optSize, numSections * 40);
    let secRva = -1;
    let secRaw = 0;
    let secSize = 0;
    for (let i = 0; i < numSections; i++) {
      const s = i * 40;
      const virtSize = sections.readUInt32LE(s + 8);
      const va = sections.readUInt32LE(s + 12);
      const rawSize = sections.readUInt32LE(s + 16);
      if (rsrcRva >= va && rsrcRva < va + Math.max(virtSize, rawSize)) {
        secRva = va;
        secRaw = sections.readUInt32LE(s + 20);
        secSize = rawSize;
      }
    }
    if (secRva < 0 || secSize === 0) return [];
    const sec = readAt(fd, secRaw, secSize);
    const base = rsrcRva - secRva;
    const entries = (dir: number) => {
      const out: Array<{ name: string | number; off: number }> = [];
      const n = sec.readUInt16LE(dir + 12) + sec.readUInt16LE(dir + 14);
      for (let i = 0; i < n; i++) {
        const e = dir + 16 + i * 8;
        const nameField = sec.readUInt32LE(e);
        let name: string | number = nameField;
        if (nameField & 0x80000000) {
          const at = base + (nameField & 0x7fffffff);
          name = sec.toString("utf16le", at + 2, at + 2 + sec.readUInt16LE(at) * 2);
        }
        out.push({ name, off: base + (sec.readUInt32LE(e + 4) & 0x7fffffff) });
      }
      return out;
    };
    const found: Buffer[] = [];
    for (const type of entries(base)) {
      if (type.name !== typeName) continue;
      for (const id of entries(type.off)) {
        for (const lang of entries(id.off)) {
          const at = sec.readUInt32LE(lang.off) - secRva;
          const size = sec.readUInt32LE(lang.off + 4);
          if (at >= 0 && at + size <= sec.length) found.push(sec.subarray(at, at + size));
        }
      }
    }
    return found;
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Every resource of `type` in a classic Mac resource file (data-fork .rsrc). */
export function rsrcResources(data: Buffer, type = "PiPL"): Buffer[] {
  try {
    const dataOff = data.readUInt32BE(0);
    const mapOff = data.readUInt32BE(4);
    const typeList = mapOff + data.readUInt16BE(mapOff + 24);
    const numTypes = data.readUInt16BE(typeList) + 1;
    const found: Buffer[] = [];
    for (let t = 0; t < numTypes; t++) {
      const te = typeList + 2 + t * 8;
      if (data.toString("latin1", te, te + 4) !== type) continue;
      const count = data.readUInt16BE(te + 4) + 1;
      const refList = typeList + data.readUInt16BE(te + 6);
      for (let r = 0; r < count; r++) {
        const ref = refList + r * 12;
        const at = dataOff + (data.readUInt32BE(ref + 4) & 0x00ffffff);
        const len = data.readUInt32BE(at);
        // subarray clamps silently: a truncated PiPL could still yield a
        // matchName with its eGL2 flags cut off — a 32bpc effect read as 16.
        if (at + 4 + len > data.length) continue;
        found.push(data.subarray(at + 4, at + 4 + len));
      }
    }
    return found;
  } catch {
    return [];
  }
}

function piplsIn(file: string): Array<{ data: Buffer; littleEndian: boolean }> {
  if (/\.(aex|prm|dll|8bf)$/i.test(file)) {
    return peResources(file).map((data) => ({ data, littleEndian: true }));
  }
  if (/\.rsrc$/i.test(file)) {
    try {
      return rsrcResources(readFileSync(file)).map((data) => ({ data, littleEndian: false }));
    } catch {
      return [];
    }
  }
  return [];
}

function walk(dir: string, depth: number, visit: (file: string) => void): void {
  if (depth > 8) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, depth + 1, visit);
    else visit(full);
  }
}

/** Scan plug-in folders; the first PiPL seen for a matchName wins. */
export function scanPluginDirs(dirs: string[]): Map<string, PiplEffect> {
  const out = new Map<string, PiplEffect>();
  for (const dir of dirs) {
    walk(dir, 0, (file) => {
      for (const { data, littleEndian } of piplsIn(file)) {
        const fx = parsePipl(data, littleEndian);
        if (fx && !out.has(fx.matchName)) out.set(fx.matchName, { ...fx, file });
      }
    });
  }
  return out;
}

/**
 * The folders After Effects loads effects from: its own Plug-ins folder and
 * the MediaCore folder shared by Adobe video apps (where most third-party
 * installers put effects). AE_MCP_PLUGIN_DIRS (path-list separated) adds more.
 */
export function defaultPluginDirs(platform: NodeJS.Platform = process.platform): string[] {
  const dirs: string[] = [];
  const extra = process.env.AE_MCP_PLUGIN_DIRS?.trim();
  if (extra) dirs.push(...extra.split(path.delimiter).filter(Boolean));
  try {
    const ae = resolveAfterFxPath(platform);
    dirs.push(path.join(path.dirname(ae), "Plug-ins"));
  } catch {
    /* no After Effects found: MediaCore alone */
  }
  dirs.push(
    platform === "darwin"
      ? "/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore"
      : "C:/Program Files/Adobe/Common/Plug-ins/7.0/MediaCore",
  );
  return dirs.filter((d) => existsSync(d));
}

let cached: Map<string, PiplEffect> | null = null;

/**
 * matchName → bit depth for every plug-in effect with a readable PiPL.
 * Scanned on first use, then kept for the life of the process.
 */
export function pluginBitDepths(): Map<string, PiplEffect> {
  if (cached === null) cached = scanPluginDirs(defaultPluginDirs());
  return cached;
}

/** Drop the cached scan (tests). */
export function resetPluginBitDepths(): void {
  cached = null;
}

/** `{ bpc }` for AE.effectBitDepth's `known` argument, or null. */
export function knownBitDepth(matchName: unknown): { bpc: Bpc } | null {
  if (typeof matchName !== "string") return null;
  const fx = pluginBitDepths().get(matchName);
  return fx ? { bpc: fx.bpc } : null;
}

/** matchName → bpc for every plug-in effect, for embedding into JSX. */
export function knownBitDepthTable(): Record<string, Bpc> {
  const out: Record<string, Bpc> = {};
  for (const [name, fx] of pluginBitDepths()) out[name] = fx.bpc;
  return out;
}
