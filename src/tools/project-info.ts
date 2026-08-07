import { defineTool, toMcpResult } from "./define-tool.js";

const CODE = `
    var proj = app.project;
    var items = [];
    for (var i = 1; i <= proj.numItems; i++) {
        items.push(AE.serializeItemSummary(proj.item(i)));
    }
    var active = proj.activeItem;
    return {
        file: proj.file ? proj.file.fsName.replace(/\\\\/g, "/") : null,
        dirty: app.project.dirty,
        numItems: proj.numItems,
        bitsPerChannel: proj.bitsPerChannel,
        timeDisplayType: String(proj.timeDisplayType),
        activeItem: active ? { id: active.id, name: active.name, typeName: (active instanceof CompItem) ? "CompItem" : (active instanceof FootageItem) ? "FootageItem" : (active instanceof FolderItem) ? "FolderItem" : "Other" } : null,
        items: items
    };
`;

export const projectInfoTool = defineTool({
  name: "ae_project_info",
  title: "Project info",
  description:
    "Project-level info: file path, dirty flag, all items with type/summary, active item. Start here.",
  group: "inspect",
  blockedInReadOnly: false,
  effect: "read",
  inputShape: {},
  handler: async (_args, transport) => {
    const result = await transport.execute({ code: CODE, label: "project_info" });
    return toMcpResult(result);
  },
});
