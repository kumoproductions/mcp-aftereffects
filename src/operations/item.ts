// Project-panel item organization — folders, moving, renaming, labels.

import { registerOp, jsxVal } from "../registry.js";

registerOp({
  name: "folder.create",
  category: "item",
  description: "Create a folder in the project panel, optionally inside another folder.",
  params: [
    { name: "name", type: "string", description: "Folder name", required: true },
    {
      name: "parent",
      type: "any",
      description: "Parent folder id or name (default: project root)",
      required: false,
    },
  ],
  toJsx(args) {
    return `
            var _parent = AE.findFolder(${jsxVal(args.parent ?? null)});
            if (!_parent) return { ok: false, error: "no folder matching " + ${jsxVal(String(args.parent))} };
            var _folder = app.project.items.addFolder(${jsxVal(args.name)});
            if (_parent.id !== app.project.rootFolder.id) _folder.parentFolder = _parent;
            return { ok: true, id: _folder.id, name: _folder.name, parent: _parent.name };
        `;
  },
});

registerOp({
  name: "item.move_to_folder",
  category: "item",
  description:
    "Move a project item (comp, footage, or folder) into a folder. Pass folder=null for the project root.",
  params: [
    {
      name: "item",
      type: "any",
      description: "Item id (number) or name (string)",
      required: true,
    },
    {
      name: "folder",
      type: "any",
      description: "Target folder id or name — null for project root",
      required: false,
      nullable: true,
    },
  ],
  toJsx(args) {
    return `
            var _item = AE.findItem(${jsxVal(args.item)});
            if (!_item) return { ok: false, error: "no project item matching " + ${jsxVal(String(args.item))} };
            var _folder = AE.findFolder(${jsxVal(args.folder ?? null)});
            if (!_folder) return { ok: false, error: "no folder matching " + ${jsxVal(String(args.folder))} };
            if (_item.id === _folder.id) return { ok: false, error: "cannot move a folder into itself" };
            _item.parentFolder = _folder;
            return { ok: true, item: _item.name, folder: _folder.name };
        `;
  },
});

registerOp({
  name: "item.set_props",
  category: "item",
  description:
    "Set project-item properties: name, label color (0-16), comment, selected. Works on comps, footage, and folders.",
  params: [
    {
      name: "item",
      type: "any",
      description: "Item id (number) or name (string)",
      required: true,
    },
    { name: "name", type: "string", description: "New name", required: false },
    { name: "label", type: "number", description: "Label color index (0-16)", required: false },
    { name: "comment", type: "string", description: "Comment text", required: false },
    {
      name: "selected",
      type: "boolean",
      description: "Select/deselect in project panel",
      required: false,
    },
  ],
  toJsx(args) {
    const sets: string[] = [];
    if (args.name !== undefined)
      sets.push(
        `try { _item.name = ${jsxVal(args.name)}; } catch (e) { _w.push("name: " + AE.errText(e)); }`,
      );
    if (args.label !== undefined)
      sets.push(
        `try { _item.label = ${jsxVal(args.label)}; } catch (e) { _w.push("label: " + AE.errText(e)); }`,
      );
    if (args.comment !== undefined)
      sets.push(
        `try { _item.comment = ${jsxVal(args.comment)}; } catch (e) { _w.push("comment: " + AE.errText(e)); }`,
      );
    if (args.selected !== undefined)
      sets.push(
        `try { _item.selected = ${jsxVal(args.selected)}; } catch (e) { _w.push("selected: " + AE.errText(e)); }`,
      );
    return `
            var _item = AE.findItem(${jsxVal(args.item)});
            if (!_item) return { ok: false, error: "no project item matching " + ${jsxVal(String(args.item))} };
            var _w = [];
            ${sets.join("\n")}
            return { ok: true, id: _item.id, name: _item.name, warnings: _w };
        `;
  },
});

registerOp({
  name: "item.list",
  category: "item",
  readOnly: true,
  description:
    "List project items, optionally filtered by folder, type, or name substring. Lighter than ae_project_info for targeted lookups.",
  params: [
    {
      name: "folder",
      type: "any",
      description: "Only items directly inside this folder (id or name)",
      required: false,
    },
    {
      name: "type",
      type: "string",
      description: "CompItem|FootageItem|FolderItem",
      required: false,
    },
    {
      name: "nameContains",
      type: "string",
      description: "Case-insensitive substring match on item name",
      required: false,
    },
    { name: "limit", type: "number", description: "Max results (default 200)", required: false },
  ],
  toJsx(args) {
    return `
            var _folderArg = ${jsxVal(args.folder ?? null)};
            var _folder = _folderArg === null ? null : AE.findFolder(_folderArg);
            if (_folderArg !== null && !_folder) return { ok: false, error: "no folder matching " + _folderArg };
            var _type = ${jsxVal(args.type ?? null)};
            var _needle = ${jsxVal(args.nameContains ?? null)};
            if (_needle !== null) _needle = _needle.toLowerCase();
            var _limit = ${jsxVal(args.limit ?? 200)};
            var _items = [];
            var _total = 0;
            for (var _i = 1; _i <= app.project.numItems; _i++) {
                var _it = app.project.item(_i);
                if (_folder && (!_it.parentFolder || _it.parentFolder.id !== _folder.id)) continue;
                var _summary = AE.serializeItemSummary(_it);
                if (_type !== null && _summary.type !== _type) continue;
                if (_needle !== null && _it.name.toLowerCase().indexOf(_needle) === -1) continue;
                _total++;
                if (_items.length < _limit) _items.push(_summary);
            }
            return { ok: true, total: _total, returned: _items.length, items: _items };
        `;
  },
});

registerOp({
  name: "item.usages",
  category: "item",
  readOnly: true,
  description:
    "Reverse lookup: list every comp that uses a footage item or comp (AVItem.usedIn), with the layer indices that reference it.",
  params: [
    {
      name: "item",
      type: "any",
      description: "Item id (number) or name (string)",
      required: true,
    },
  ],
  toJsx(args) {
    return `
            var _item = AE.findItem(${jsxVal(args.item)});
            if (!_item) return { ok: false, error: "no project item matching " + ${jsxVal(String(args.item))} };
            if (_item instanceof FolderItem) return { ok: false, error: "folders have no usages — list their contents with item.list" };
            var _comps = [];
            try { _comps = _item.usedIn; } catch (eU) { return { ok: false, error: "usedIn failed: " + AE.errText(eU) }; }
            var _out = [];
            for (var _i = 0; _i < _comps.length; _i++) {
                var _c = _comps[_i];
                var _layers = [];
                for (var _li = 1; _li <= _c.numLayers; _li++) {
                    var _srcId = null;
                    try { _srcId = _c.layer(_li).source ? _c.layer(_li).source.id : null; } catch (eS) {}
                    if (_srcId === _item.id) _layers.push(_li);
                }
                _out.push({ compId: _c.id, compName: _c.name, layerIndices: _layers });
            }
            return { ok: true, item: _item.name, itemId: _item.id, usedIn: _out, count: _out.length };
        `;
  },
});
