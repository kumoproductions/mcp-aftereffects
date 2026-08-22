// TypeScript types for the AE project export JSON schema produced by
// `ae_project_export_json` and consumed by `ae_project_import_json`. Keeping
// these in a single file lets both the Node-side validator and any future
// agent-side code share the shape without drift.
//
// Schema version: 2
//
// Versioning policy: breaking schema changes bump SCHEMA_VERSION. The import
// loader will refuse documents with a schemaVersion higher than the runtime
// version it understands; lower versions are read best-effort.

export const SCHEMA_VERSION = 2;

// --- Leaf value types ---

export type AeColor = [number, number, number];

/** A serialized ExtendScript `TextDocument` value. */
export interface TextDocumentValue {
  __kind: "TextDocument";
  text: string;
  font: string | null;
  fontFamily: string | null;
  fontStyle: string | null;
  fontSize: number;
  fillColor: AeColor | null;
  strokeColor: AeColor | null;
  strokeWidth: number;
  justification: string | null;
  tracking: number;
  leading: number;
  baselineShift: number;
  applyFill: boolean;
  applyStroke: boolean;
  boxText: boolean;
  boxTextSize: [number, number] | null;
  boxTextPos: [number, number] | null;
}

/** A serialized ExtendScript `Shape` (mask path / shape layer path). */
export interface ShapeValue {
  __kind: "Shape";
  closed: boolean;
  vertices: number[][];
  inTangents: number[][];
  outTangents: number[][];
}

/** A serialized ExtendScript `MarkerValue`. */
export interface MarkerValueValue {
  __kind: "MarkerValue";
  comment: string;
  chapter: string;
  url: string;
  frameTarget: string;
  cuePointName: string;
  duration: number;
  label: number;
  protectedRegion: boolean;
}

/** The set of legal property values a dispatcher can receive. */
export type PropertyValue =
  | null
  | number
  | boolean
  | string
  | number[]
  | AeColor
  | TextDocumentValue
  | ShapeValue
  | MarkerValueValue;

// --- Property tree ---

export interface KeyframeSpec {
  time: number;
  value: PropertyValue;
  /** KeyframeInterpolationType enum value (e.g. 6613=LINEAR, 6614=BEZIER). */
  inInterp: number | null;
  outInterp: number | null;
  /** Readable twins of inInterp/outInterp: "linear" | "bezier" | "hold". Informational. */
  inInterpName?: string | null;
  outInterpName?: string | null;
  /**
   * Temporal ease per dimension, present when either side is bezier.
   * Applied on import (before interpolation types, matching AE.applyKeys).
   */
  inEase?: Array<{ speed: number; influence: number }> | null;
  outEase?: Array<{ speed: number; influence: number }> | null;
}

export interface PropertySpec {
  name: string;
  matchName: string;
  propertyValueType: string | number;
  value?: PropertyValue;
  expression?: string;
  keyframes?: KeyframeSpec[];
}

export interface PropertyGroupSpec {
  name: string;
  matchName: string;
  properties: PropertySpec[];
  groups: PropertyGroupSpec[];
}

// --- Layers ---

export type LayerType =
  | "AVLayer"
  | "TextLayer"
  | "ShapeLayer"
  | "CameraLayer"
  | "LightLayer"
  | "Layer";

export interface LayerSpec {
  index: number;
  name: string;
  type: LayerType;
  enabled: boolean;
  solo: boolean;
  shy: boolean;
  locked: boolean;
  inPoint: number;
  outPoint: number;
  startTime: number;
  stretch: number;
  parentIndex: number | null;
  label: number;
  /** Parent by index + name (for sanity during import). */
  parent?: { index: number; name: string } | null;
  /** AVLayer-specific: source item id (remapped during import). */
  sourceId?: number | null;
  sourceName?: string | null;
  width?: number;
  height?: number;
  hasVideo?: boolean;
  hasAudio?: boolean;
  threeDLayer?: boolean;
  /** TextLayer-specific: the text's displayed string (for human reference; not authoritative). */
  text?: string | null;
  fontSize?: number;
  font?: string | null;
  fillColor?: AeColor;
  // Property trees
  transformGroup?: PropertyGroupSpec | null;
  effectsGroup?: PropertyGroupSpec | null;
  masksGroup?: PropertyGroupSpec | null;
  textGroup?: PropertyGroupSpec | null;
  contentsGroup?: PropertyGroupSpec | null;
  materialOptionsGroup?: PropertyGroupSpec | null;
  audioGroup?: PropertyGroupSpec | null;
  // Extras
  timeRemapEnabled?: boolean;
  timeRemapProperty?: PropertySpec | null;
  markers?: PropertySpec | null;
}

// --- Items (project level) ---

export type ItemType = "FolderItem" | "CompItem" | "FootageItem" | "UnknownItem";
export type SourceKind = "solid" | "file" | "placeholder" | "unknown";

export interface ItemSpecBase {
  id: number;
  name: string;
  type: ItemType;
  parentFolderId: number | null;
  parentFolderName: string | null;
  label: number;
  comment: string;
}

export interface FolderItemSpec extends ItemSpecBase {
  type: "FolderItem";
}

export interface CompItemSpec extends ItemSpecBase {
  type: "CompItem";
  width: number;
  height: number;
  frameRate: number;
  duration: number;
  layerCount: number;
  bgColor: AeColor;
  workAreaStart?: number;
  workAreaDuration?: number;
  pixelAspect?: number;
  shutterAngle?: number;
  shutterPhase?: number;
  motionBlur?: boolean;
  displayStartTime?: number;
  layers?: LayerSpec[];
  markers?: PropertySpec | null;
}

export interface FootageItemSpec extends ItemSpecBase {
  type: "FootageItem";
  width: number;
  height: number;
  duration: number;
  sourceKind: SourceKind;
  // solid
  color?: AeColor;
  sourceWidth?: number;
  sourceHeight?: number;
  alphaMode?: number;
  hasAlpha?: boolean;
  // file
  file?: string | null;
  missingFootagePath?: string | null;
}

export type ItemSpec = FolderItemSpec | CompItemSpec | FootageItemSpec;

// --- Project document ---

export interface AeProjectDoc {
  schemaVersion: number;
  exportedAt: string;
  aeVersion: string;
  project: {
    file: string | null;
    bitsPerChannel: number;
    timeDisplayType: string;
  };
  items: ItemSpec[];
}
