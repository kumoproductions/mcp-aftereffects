// Lightweight structural validator for AE project JSON documents. Written by
// hand (not via Zod or Ajv) to keep startup fast and avoid binding the server
// to a schema-validator dependency. Catches the common malformed-document cases
// so the agent gets a clean error message instead of AE throwing a cryptic
// ExtendScript exception deep in import.jsx.
//
// Scope: shallow/structural checks only. Does NOT verify:
//   - That referenced sourceIds exist (import.jsx warns for missing sources)
//   - That effect matchNames are valid (import.jsx catches addProperty errors)
//   - That keyframe interpolation type enums are real

import type {
  AeProjectDoc,
  ItemSpec,
  LayerSpec,
  PropertySpec,
  PropertyGroupSpec,
  KeyframeSpec,
} from "./schema.js";
import { SCHEMA_VERSION } from "./schema.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  warnings: ValidationIssue[];
}

class Validator {
  readonly issues: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];

  err(path: string, message: string): void {
    this.issues.push({ path, message });
  }
  warn(path: string, message: string): void {
    this.warnings.push({ path, message });
  }

  isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
}

export function validateAeProjectDoc(doc: unknown): ValidationResult {
  const v = new Validator();
  if (!v.isObject(doc)) {
    v.err("", "document is not an object");
    return { ok: false, issues: v.issues, warnings: v.warnings };
  }
  const d = doc as Partial<AeProjectDoc>;

  if (typeof d.schemaVersion !== "number") v.err("schemaVersion", "missing or not a number");
  else if (d.schemaVersion > SCHEMA_VERSION)
    v.err(
      "schemaVersion",
      `document schemaVersion ${d.schemaVersion} is newer than runtime ${SCHEMA_VERSION}; refusing to import (use skipValidation to force)`,
    );

  if (!Array.isArray(d.items)) {
    v.err("items", "missing or not an array");
    return { ok: v.issues.length === 0, issues: v.issues, warnings: v.warnings };
  }

  // Track ids to detect duplicates and validate cross-references.
  const seenIds = new Set<number>();
  const folderIds = new Set<number>();
  const itemTypeById = new Map<number, string>();

  for (let i = 0; i < d.items.length; i++) {
    const item = d.items[i] as ItemSpec;
    const base = `items[${i}]`;
    if (!v.isObject(item)) {
      v.err(base, "not an object");
      continue;
    }
    if (typeof item.id !== "number") v.err(`${base}.id`, "missing or not a number");
    else {
      if (seenIds.has(item.id)) v.err(`${base}.id`, `duplicate item id ${item.id}`);
      seenIds.add(item.id);
      itemTypeById.set(item.id, item.type);
      if (item.type === "FolderItem") folderIds.add(item.id);
    }
    if (typeof item.name !== "string") v.err(`${base}.name`, "missing or not a string");
    if (typeof item.type !== "string") v.err(`${base}.type`, "missing or not a string");
    if (
      item.type !== "FolderItem" &&
      item.type !== "CompItem" &&
      item.type !== "FootageItem" &&
      item.type !== "UnknownItem"
    ) {
      v.err(`${base}.type`, `unknown item type: ${item.type}`);
    }
    if (
      item.parentFolderId !== null &&
      item.parentFolderId !== undefined &&
      typeof item.parentFolderId !== "number"
    ) {
      v.err(`${base}.parentFolderId`, "must be number or null");
    }
    // Type-specific validation
    if (item.type === "CompItem") {
      if (typeof item.width !== "number") v.err(`${base}.width`, "missing or not a number");
      if (typeof item.height !== "number") v.err(`${base}.height`, "missing or not a number");
      if (typeof item.duration !== "number") v.err(`${base}.duration`, "missing or not a number");
      if (typeof item.frameRate !== "number") v.err(`${base}.frameRate`, "missing or not a number");
      if (Array.isArray(item.layers)) {
        for (let li = 0; li < item.layers.length; li++) {
          validateLayer(v, `${base}.layers[${li}]`, item.layers[li]);
        }
      }
    } else if (item.type === "FootageItem") {
      if (typeof item.sourceKind !== "string")
        v.err(`${base}.sourceKind`, "missing or not a string");
      if (item.sourceKind === "solid") {
        if (!Array.isArray(item.color) || item.color.length !== 3)
          v.err(`${base}.color`, "solid requires [r,g,b]");
      } else if (item.sourceKind === "file") {
        if (item.file !== null && typeof item.file !== "string")
          v.err(`${base}.file`, "file must be string or null");
      }
    }
  }

  // Second pass: validate parentFolderId cross-references
  for (let i = 0; i < d.items.length; i++) {
    const item = d.items[i];
    if (item && typeof item.parentFolderId === "number") {
      if (!seenIds.has(item.parentFolderId)) {
        v.warn(`items[${i}].parentFolderId`, `parent id ${item.parentFolderId} not in items list`);
      } else if (!folderIds.has(item.parentFolderId)) {
        v.warn(
          `items[${i}].parentFolderId`,
          `parent id ${item.parentFolderId} is not a FolderItem`,
        );
      }
    }
  }

  // Validate AVLayer sourceId cross-refs
  for (let i = 0; i < d.items.length; i++) {
    const item = d.items[i];
    if (item && item.type === "CompItem" && Array.isArray(item.layers)) {
      for (let li = 0; li < item.layers.length; li++) {
        const layer = item.layers[li];
        if (layer && layer.type === "AVLayer" && typeof layer.sourceId === "number") {
          if (!seenIds.has(layer.sourceId)) {
            v.warn(
              `items[${i}].layers[${li}].sourceId`,
              `layer source id ${layer.sourceId} not in items list — layer will be skipped on import`,
            );
          }
        }
      }
    }
  }

  return { ok: v.issues.length === 0, issues: v.issues, warnings: v.warnings };
}

function validateLayer(v: Validator, path: string, layer: LayerSpec): void {
  if (!v.isObject(layer)) {
    v.err(path, "not an object");
    return;
  }
  if (typeof layer.index !== "number") v.err(`${path}.index`, "missing or not a number");
  if (typeof layer.name !== "string") v.err(`${path}.name`, "missing or not a string");
  if (typeof layer.type !== "string") v.err(`${path}.type`, "missing or not a string");
  else if (
    ["AVLayer", "TextLayer", "ShapeLayer", "CameraLayer", "LightLayer", "Layer"].indexOf(
      layer.type,
    ) === -1
  ) {
    v.warn(`${path}.type`, `unknown layer type: ${layer.type}`);
  }
  if (layer.transformGroup)
    validatePropertyGroup(v, `${path}.transformGroup`, layer.transformGroup);
  if (layer.effectsGroup) validatePropertyGroup(v, `${path}.effectsGroup`, layer.effectsGroup);
  if (layer.masksGroup) validatePropertyGroup(v, `${path}.masksGroup`, layer.masksGroup);
  if (layer.textGroup) validatePropertyGroup(v, `${path}.textGroup`, layer.textGroup);
  if (layer.contentsGroup) validatePropertyGroup(v, `${path}.contentsGroup`, layer.contentsGroup);
  if (layer.markers) validateProperty(v, `${path}.markers`, layer.markers);
  if (layer.timeRemapProperty)
    validateProperty(v, `${path}.timeRemapProperty`, layer.timeRemapProperty);
}

function validatePropertyGroup(v: Validator, path: string, group: PropertyGroupSpec): void {
  if (!v.isObject(group)) {
    v.err(path, "not an object");
    return;
  }
  if (typeof group.matchName !== "string") v.err(`${path}.matchName`, "missing or not a string");
  if (Array.isArray(group.properties)) {
    for (let i = 0; i < group.properties.length; i++) {
      validateProperty(v, `${path}.properties[${i}]`, group.properties[i]);
    }
  }
  if (Array.isArray(group.groups)) {
    for (let i = 0; i < group.groups.length; i++) {
      validatePropertyGroup(v, `${path}.groups[${i}]`, group.groups[i]);
    }
  }
}

function validateProperty(v: Validator, path: string, prop: PropertySpec): void {
  if (!v.isObject(prop)) {
    v.err(path, "not an object");
    return;
  }
  if (typeof prop.matchName !== "string") v.err(`${path}.matchName`, "missing or not a string");
  if (Array.isArray(prop.keyframes)) {
    for (let i = 0; i < prop.keyframes.length; i++) {
      validateKeyframe(v, `${path}.keyframes[${i}]`, prop.keyframes[i]);
    }
  }
}

function validateKeyframe(v: Validator, path: string, kf: KeyframeSpec): void {
  if (!v.isObject(kf)) {
    v.err(path, "not an object");
    return;
  }
  if (typeof kf.time !== "number") v.err(`${path}.time`, "missing or not a number");
}
