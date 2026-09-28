import { z } from "zod";
import type { ToolEffect } from "../policy.js";
import type { AeTransport } from "../transport/AeTransport.js";
import { resolveTarget } from "../transport/instances.js";
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

/**
 * The one argument every AE-touching tool shares: which After Effects
 * instance to talk to. Added here, in one place, rather than in each tool —
 * a tool's own handler never sees it; the transport it receives is already
 * bound to that instance.
 */
export const INSTANCE_PARAM = z
  .string()
  .optional()
  .describe(
    "After Effects instance to address for this call, when several are running (AfterFX.exe -m): " +
      "an instance id (its AE_MCP_INSTANCE at launch, or the `name` given to instance.start) or the name " +
      "of the project file it has open. Omit to use this server's default (AE_MCP_INSTANCE, else the " +
      "single live instance). ae_context and ae_do instance.list show what is live.",
  );

/** Tools that never contact After Effects have no instance to pick. */
const INSTANCE_FREE_TOOLS = new Set(["ae_catalog"]);

/**
 * A view of `transport` whose calls go to `instance` unless a call names one
 * itself — a Node-side operation bound to the main instance still has to
 * reach the worker it is starting.
 */
export function bindTransportToInstance(transport: AeTransport, instance: string): AeTransport {
  return {
    execute: (req) => transport.execute({ instance, ...req }),
    describeTarget: () => resolveTarget(instance),
    ...(transport.close ? { close: () => transport.close!() } : {}),
  };
}

function withInstanceParam(tool: AnyTool): AnyTool {
  if (INSTANCE_FREE_TOOLS.has(tool.name)) return tool;
  return {
    ...tool,
    inputShape: { ...tool.inputShape, instance: INSTANCE_PARAM },
    handler: async (args: Record<string, unknown> | undefined, transport: AeTransport) => {
      const { instance, ...rest } = args ?? {};
      const named = typeof instance === "string" ? instance.trim() : "";
      return tool.handler(rest, named ? bindTransportToInstance(transport, named) : transport);
    },
  };
}

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
].map((tool) => withInstanceParam(tool as AnyTool));
