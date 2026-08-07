// Working-space → sRGB display conversion for color-managed captures.
//
// Validated empirically against After Effects 26.3 (ACES/ACEScg project):
// recovering the scene-linear buffer from saveFrameToPng and applying the
// ACES output transform (Hill's RRT+ODT fit) matched a viewer-referenced
// capture (Copy Frame to Clipboard) with a mean error of 1.7/255. A plain
// colorimetric matrix+gamma conversion does NOT match the viewer — the ACES
// view transform includes tone mapping.
//
// The fit is an approximation of the ACES 1.x sRGB output transform. If the
// viewer uses a non-default display/view transform (custom OCIO config, log
// view), this cannot match it — the view transform is not scriptable — and
// the clipboard capture method is the escape hatch.

export type Mat3 = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

/** ACEScg (AP1, D60) → linear Rec.709/sRGB (D65, Bradford CAT). */
export const AP1_TO_REC709: Mat3 = [
  [1.70505099, -0.62179212, -0.08325887],
  [-0.13025642, 1.1408047, -0.01054832],
  [-0.02400336, -0.12896898, 1.15297233],
];

/** ACES2065-1 (AP0, D60) → linear Rec.709/sRGB (D65, Bradford CAT). */
export const AP0_TO_REC709: Mat3 = [
  [2.52140088, -1.13399574, -0.38756249],
  [-0.27621892, 1.37259556, -0.09628267],
  [-0.01538264, -0.15292998, 1.16835777],
];

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

// Stephen Hill's ACES RRT+ODT fit operates in its own space around linear
// sRGB input; both matrices bake in that round trip.
const HILL_IN: Mat3 = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const HILL_OUT: Mat3 = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

export function srgbEncode(x: number): number {
  const v = Math.min(1, Math.max(0, x));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function apply(m: Mat3, r: number, g: number, b: number): [number, number, number] {
  return [
    m[0][0] * r + m[0][1] * g + m[0][2] * b,
    m[1][0] * r + m[1][1] * g + m[1][2] * b,
    m[2][0] * r + m[2][1] * g + m[2][2] * b,
  ];
}

function rrtOdtFit(v: number): number {
  return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
}

/**
 * Scene-linear working space → display sRGB (encoded 0..1), in place over an
 * interleaved RGB Float64Array. `toRec709` converts the working primaries to
 * linear Rec.709 first; the ACES output transform then tone-maps to display.
 */
export function sceneLinearToDisplaySrgb(rgb: Float64Array, toRec709: Mat3): void {
  for (let i = 0; i < rgb.length; i += 3) {
    let [r, g, b] = apply(toRec709, rgb[i], rgb[i + 1], rgb[i + 2]);
    r = Math.max(0, r);
    g = Math.max(0, g);
    b = Math.max(0, b);
    [r, g, b] = apply(HILL_IN, r, g, b);
    r = rrtOdtFit(r);
    g = rrtOdtFit(g);
    b = rrtOdtFit(b);
    [r, g, b] = apply(HILL_OUT, r, g, b);
    rgb[i] = srgbEncode(r);
    rgb[i + 1] = srgbEncode(g);
    rgb[i + 2] = srgbEncode(b);
  }
}

export interface WorkingSpaceProfile {
  /** Matrix from working primaries to linear Rec.709. */
  toRec709: Mat3;
  /** Human-readable note for the tool response. */
  note: string;
}

/**
 * Map an After Effects working-space name (Project.workingSpace) to the
 * conversion this module can perform. Returns null for spaces we cannot
 * faithfully convert — the caller should fall back to raw output plus a
 * warning pointing at the clipboard capture method.
 */
export function profileForWorkingSpace(workingSpace: string): WorkingSpaceProfile | null {
  const ws = workingSpace.toLowerCase();
  if (ws.includes("acescg")) {
    return {
      toRec709: AP1_TO_REC709,
      note: "ACEScg → sRGB via ACES output transform (RRT+ODT fit)",
    };
  }
  if (ws.includes("aces2065") || ws.includes("aces 2065")) {
    return {
      toRec709: AP0_TO_REC709,
      note: "ACES2065-1 → sRGB via ACES output transform (RRT+ODT fit)",
    };
  }
  // Scene-linear Rec.709/sRGB primaries: same primaries, tone mapping still
  // applies (the viewer's ACES transform does).
  if (ws.includes("scene-referred rec.709") || ws.includes("linear rec.709")) {
    return {
      toRec709: IDENTITY,
      note: "linear Rec.709 → sRGB via ACES output transform (RRT+ODT fit)",
    };
  }
  return null;
}
