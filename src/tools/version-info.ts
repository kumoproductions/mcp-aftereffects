import { defineTool, toMcpResult } from "./define-tool.js";

// Returns AE version, build, and a small capability probe. Useful for the
// agent to decide what APIs are available without guessing.

const CODE = `
    return {
        app: {
            version: app.version,
            buildName: AE.safeGet(function () { return app.buildName; }, null),
            buildNumber: AE.safeGet(function () { return app.buildNumber; }, null),
            language: AE.safeGet(function () { return String(app.isoLanguage); }, null),
            memoryInUse: AE.safeGet(function () { return app.memoryInUse; }, null),
            availableGPUs: AE.safeGet(function () { return app.availableGPUAccelTypes ? app.availableGPUAccelTypes.length : 0; }, null)
        },
        capabilities: {
            saveFrameToPng: AE.safeGet(function () {
                // Test on a scratch comp and immediately remove it
                var tc = app.project.items.addComp("__probe__", 4, 4, 1, 1, 1);
                var has = typeof tc.saveFrameToPng === "function";
                tc.remove();
                return has;
            }, false),
            appEffects: AE.safeGet(function () { return !!(app.effects && app.effects.length); }, false),
            bridgeTalk: AE.safeGet(function () { return typeof BridgeTalk !== "undefined"; }, false),
            socket: AE.safeGet(function () { return typeof Socket !== "undefined"; }, false)
        },
        project: {
            numItems: app.project.numItems,
            file: app.project.file ? app.project.file.fsName.replace(/\\\\/g, "/") : null,
            dirty: app.project.dirty
        },
        server: {
            exportSchemaVersion: AE.EXPORT_SCHEMA_VERSION
        }
    };
`;

export const versionInfoTool = defineTool({
  name: "ae_version_info",
  title: "Version info",
  description:
    "AE version, build, capabilities (saveFrameToPng, app.effects, Socket). " +
    "Call at session start to know what APIs are available.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {},
  handler: async (_args, transport) => {
    const result = await transport.execute({ code: CODE, label: "version_info" });
    return toMcpResult(result);
  },
});
