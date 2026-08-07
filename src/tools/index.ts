import type { z } from "zod";
import type { ToolEffect } from "../policy.js";
import type { AeTransport } from "../transport/AeTransport.js";
import type { ToolGroup } from "./define-tool.js";
import type { ToolResult } from "./types.js";

import { catalogTool } from "./catalog.js";
import { compInfoTool } from "./comp-info.js";
import { contextTool } from "./context.js";
import { doTool } from "./do.js";
import { layerInfoTool } from "./layer-info.js";
import { projectExportTool } from "./project-export.js";
import { projectImportTool } from "./project-import.js";
import { projectInfoTool } from "./project-info.js";
import { renderFrameTool } from "./render-frame.js";
import { saveProjectTool } from "./save-project.js";
import { versionInfoTool } from "./version-info.js";

export type AnyTool = {
  name: string;
  title: string;
  description: string;
  group: ToolGroup;
  blockedInReadOnly: boolean;
  effect: ToolEffect;
  inputShape: z.ZodRawShape;
  handler: (args: any, transport: AeTransport) => Promise<ToolResult>;
};

/** Every MCP tool this server exposes, in registration order. */
export const ALL_TOOLS: AnyTool[] = [
  projectInfoTool,
  compInfoTool,
  layerInfoTool,
  renderFrameTool,
  saveProjectTool,
  projectExportTool,
  projectImportTool,
  versionInfoTool,
  catalogTool,
  doTool,
  contextTool,
];
