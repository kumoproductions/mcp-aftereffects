# Tool reference

Generated from `src/tools/**` via `npm run docs:tools` — do not edit by hand. For a grouped summary and example prompts, see the main [README](../README.md).

`ae_do`'s operation registry (`layer.*`, `keyframe.*`, …) is discoverable at runtime via `ae_catalog` and is **not** listed in this file.

11 tools across 4 groups.

## Inspect

Read-only project/comp/layer introspection.

| Tool              | Description                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ae_project_info` | Project-level info: file path, dirty flag, all items with type/summary, active item.                                                                         |
| `ae_comp_info`    | Detailed comp info: size, fps, duration, work area, motion blur, layer summaries.                                                                            |
| `ae_layer_info`   | Full layer info: transform, effects, masks, text, shape contents, keyframes.                                                                                 |
| `ae_version_info` | AE version, build, capabilities (saveFrameToPng, app.effects, Socket).                                                                                       |
| `ae_context`      | Ambient context: project state, active comp, selected layers, item list, AE.\* helpers, ES3 rules, and the undo contract (every call = one auto undo group). |

## Document

Save, JSON export, and JSON import of the whole project.

| Tool                     | Description                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ae_save_project`        | Save the project.                                                                                                                  |
| `ae_project_export_json` | Serialize the entire project to JSON (folders, comps, layers, keyframes, effects, shapes, markers, time remap, solids, file refs). |
| `ae_project_import_json` | Rebuild the project from JSON (produced by ae_project_export_json).                                                                |

## Render

Single-frame rendering for visual verification.

| Tool              | Description                   |
| ----------------- | ----------------------------- |
| `ae_render_frame` | Render a single frame to PNG. |

## Operations

Atomic operation dispatch — discover with `ae_catalog`, execute with `ae_do`.

| Tool         | Description                                            |
| ------------ | ------------------------------------------------------ |
| `ae_catalog` | Discover available atomic operations for ae_do.        |
| `ae_do`      | Execute an atomic operation by name (from ae_catalog). |
