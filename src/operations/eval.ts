// eval.run — last resort escape hatch, moved from static ae_eval into the registry.
// All execution now goes through ae_do for consistency + ambient context.

import { registerOp } from "../registry.js";

registerOp({
  name: "eval.run",
  category: "eval",
  description:
    "Execute custom ExtendScript (ES3). LAST RESORT — check ae_catalog first for a dedicated operation. Code is a function body ending with `return <JSON-serializable>;`. AE.* helpers are in scope. `log(msg)` pushes breadcrumbs. The code already runs inside an automatic undo group (one Ctrl+Z reverts the call) — do NOT call app.beginUndoGroup/endUndoGroup yourself; an unbalanced group leaks past this call and corrupts undo for the whole session. Do NOT undo/redo from here either (app.executeCommand 16/2035): inside this call's group AE resolves them against it, so nothing is reverted — use the project.undo operation, which runs outside the group. Do NOT close/open/replace the project from here (app.open, app.newProject, app.project.close): the open undo group is orphaned at the project boundary, AE raises an async 'UndoGroup Mismatch' dialog, and undo stays broken for the session — use project.open / project.new, which run outside the group.",
  params: [
    { name: "code", type: "string", description: "ExtendScript function body", required: true },
  ],
  toJsx(args) {
    // The code IS the JSX — pass through directly
    return String(args.code);
  },
});
