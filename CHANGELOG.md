# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-12

### Added

- **61 new operations closing the gap to the AE 2024–2026 scripting surface** (137 → 198, now 23 categories), verified end-to-end against a live After Effects 26.3:
  - **Text**: box and vertical text creation (`layer.create_text` with `boxSize`/`orientation`, AE 24.2), per-range styling (`text.set_style_range` over characters/paragraphs/composed lines, 24.3), layout measurement (`text.measure`: composed lines, paragraph spans, `baselineLocs`, box overflow), the 24.6 box controls on `text.set_box` (auto-fit policy, vertical alignment, first-baseline alignment, inset spacing), and the full 24.0 attribute surface on `text.set_style` (kerning, ligatures, RTL direction, tate-chu-yoko, paragraph indents/spacing, digit sets, composer engine, and more).
  - **Variable fonts**: `text.set_variable_font` (design-axis values by tag), `text.add_font_axis` (keyframeable axis on a text animator, 26.0), `font.info` (full FontObject incl. design axes), `font.check_glyphs` (glyph coverage, 25.1), `font.list_used` (`Project.usedFonts`, 24.5).
  - **Render queue**: raw settings access (`render.get_settings` / `render.set_settings` / `render.set_om_settings`, AE 13+), single-item `render.remove_item` and `render.duplicate_item`, and the render flag, `skipFrames`, `logType`, `postRenderAction`, `includeSourceXMP`, `queueItemNotify` on `render.set_output`.
  - **3D**: `comp.set_renderer` / `comp.list_renderers` with scheme-proof friendly names (`classic3d`/`advanced3d`/`cinema4d`), environment lights (24.3), `layer.create_parametric_mesh` (26.3), and `ThreeDModelLayer`/`ParametricMeshLayer` recognition in `project.find_layers` and layer summaries.
  - **Footage**: `footage.reload`, `footage.list_missing`, `footage.replace_with_solid` / `replace_with_placeholder`, solid/placeholder proxies, pulldown (`guessPulldown`/`removePulldown`), `item.usages` (reverse lookup), `project.import_placeholder`, and sequence frame ranges on `project.import_file`.
  - **Keyframes**: `keyframe.set_interpolation` (asymmetric in/out linear|bezier|hold plus the temporal continuity/auto-bezier flags) and `keyframe.set_label` (22.6).
  - **Effects and properties**: `effect.move` and `property.move` (stack/group reordering), `effect.set_dropdown_items` / `get_dropdown_items` (Dropdown Menu Control, the MOGRT-dropdown API, 17.0.1/26.0).
  - **Misc**: `project.new`, `project.parse_swatch` (.ase palettes), `project.get_xmp` / `set_xmp`, `egp.add_layer` (media replacement, 18.0), `layer.scene_edit_detection` (22.3), `layer.set_parent` with `jump`, Layer-panel ruler guides, `shape.add_wiggle_transform`, marker cue-point fields, and viewer fast-preview/channel controls.
  - **Preferences and app config** (new `pref` category): `pref.get` / `set` / `delete` (typed access to AE's preferences files incl. the PREFType selector), `pref.get_setting` / `set_setting` (script-scoped settings), `project.set_memory_limits`, `project.set_multi_frame_rendering` (22.0), `project.set_default_import_folder`, `project.get_tool` / `set_tool` (active Tools-panel tool), and the remaining project settings (`linearizeWorkingSpace`, `compensateForSceneReferredProfiles`, `displayStartFrame`, `feetFramesFilmType`, `footageTimecodeDisplayStartType`).
  - **Font management**: `font.list_duplicates` (24.6), `font.get_lists` / `set_favorites` (Favorites/MRU, 24.6), `font.set_substitution` (auto-replacement policy + Adobe Fonts sync freeze, 24.6), `font.get/set_default_for_script` (per-writing-script defaults, 25.1).
  - **More text/layer/render**: `text.paste_range` (copy text+styling between ranges, 25.1), `text.reset_style`, `keyframe.set_selected` / `property.select` (timeline selection staging), `render.save_template` (render/output-module templates), queue-wide `queueNotify` on `render.set_output`, `layer.calculate_transform` (corner-pin placement in 3D), `egp.open_in_panel`.
- **Explicit-consent gate for app-configuration operations.** The eleven operations that change After Effects itself rather than the project (`pref.set/delete/set_setting`, `project.set_memory_limits` / `set_multi_frame_rendering` / `set_default_import_folder` / `set_tool`, `font.set_substitution` / `set_favorites` / `set_default_for_script`, `render.save_template`) now require `confirm: true` — to be passed only when the user explicitly requested the change. `ae_do` and `batch.run` both enforce it, and `ae_catalog` marks the operations `appConfig: true`.
- **Enum names in `layer.set_props`**: `quality`, `samplingQuality`, `frameBlendingType`, `autoOrient`, `blendingMode`, and `lightType` accept string names — enum-valued attributes were previously unreachable through the generic passthrough.
- **`mask.set_props`** gains `inverted`, `locked`, `color`, `rotoBezier`, `motionBlur`, `featherFalloff`; **`mask.set_path`** accepts the variable-width feather arrays.
- **Dialog suppression in the dispatcher**: modal alerts raised while a request runs (missing fonts/footage on `project.open`, effect warnings) no longer wedge every later call.

### Fixed

- **`layer.set_blend_mode` silently failed for `silhouetteAlpha`** — the After Effects API spells that one member `SILHOUETE_ALPHA` (while luma is `SILHOUETTE_LUMA`); both spellings are now probed.
- **`layer.set_track_matte` demanded the matte sit directly above the target** — the AE 23.0 API it already used takes any layer; the matte can now also be addressed by name.
- **Project-boundary calls corrupted the undo stack.** `project.open` / `project.new` (and dialog suppression around undo/redo) ran inside the dispatcher's undo group; crossing a project boundary orphans the open group, After Effects 26 raises an async "UndoGroup Mismatch" dialog, and undo stays broken for the session. Both ops now run outside the group, the same exemption as undo/redo.
- `project.find_layers` reported `ThreeDModelLayer` / `ParametricMeshLayer` layers as plain `AVLayer`/`Layer`.
- Generic objects (swatch data, font usage records, design axes) serialized as `null` in results.

## [0.1.3] - 2026-08-11

### Fixed

- **`project.undo` reverted nothing.** Like every other call it was wrapped in an undo group, and After Effects resolves Undo against the group that is still open — so the previous call survived and the undo stack was left out of step with the project. Undo and redo (`project.undo`, `command.execute` with id 16 or 2035) now run outside the group. As a consequence they can no longer be children of a `batch.run`, which is itself one undo group: issue them as their own `ae_do` call.

## [0.1.2] - 2026-08-10

### Fixed

- **The GitHub Packages mirror never published anything.** Its "already published?" guard queried npmjs instead of GitHub Packages, so every release decided the version was already mirrored and skipped it. Installing from npmjs — the supported route — was never affected; GitHub Packages starts carrying the package at this version.

## [0.1.1] - 2026-08-10

### Fixed

- **Every call timed out on After Effects builds without a native `JSON` (seen on macOS).** Responses could not be serialized, so no call ever completed.
- **A failing dispatcher could raise a modal error dialog in After Effects,** which blocked every subsequent call until someone clicked OK.
- **`layer.move` never worked** — it failed for every layer. Reordering now works in both directions, and an out-of-range `toIndex` returns a clear error.
- Caught errors are now reported as readable messages instead of failing the call.
- A response that cannot be serialized returns an error immediately instead of costing the full 60 s timeout.

## [0.1.0] - 2026-08-09

Initial public release of `@kumoproductions/mcp-aftereffects`.

### Added

- **136 atomic operations across 21 categories** — keyframes, properties and expressions, layers, shapes, text, masks, footage, project items, markers, guides, comps, render queue, fonts, Essential Graphics / MOGRT, and the viewer.
- **Stable layer references.** Layer arguments accept `{ id: n }` alongside index and name, so references survive reordering and renaming.
- **Color-managed capture.** `ae_render_frame` matches the After Effects viewer in color-managed projects and writes sRGB-tagged PNGs.
- **Batched reads.** `ae_comp_info` accepts several comps, `ae_layer_info` accepts several layers or `"all"`, and both can run inside `batch.run` to verify a mutation in the same call.
- **macOS support.**
- **Argument validation** against the schema `ae_catalog` publishes, before After Effects is contacted.
- **Read-only mode** (`AE_MCP_READONLY=1`) and a category allowlist (`AE_MCP_ALLOW_CATEGORIES`).
- **Unified error envelope**: every failure returns `{ ok: false, error: { code, message, retryable } }`.
- `AE_MCP_RUNTIME_DIR` to relocate the IPC mailbox, and a `timeoutMs` parameter on `ae_do`.

### Changed

- **Arbitrary ExtendScript is opt-in** — `eval.run` requires `AE_MCP_ENABLE_EVAL=1`.
- **Concurrent calls are serialized across server processes,** so they no longer trigger After Effects' "second script" warning.
- Each call uses its own mailbox files under the OS temp dir, so multiple clients coexist and a read-only install works.
- Environment variables use the `AE_MCP_*` prefix (the legacy `AE_EXE` is still honored).

### Fixed

- Failed operations are reported as errors instead of success.
- A timed-out request can no longer execute later.
- A missing or blocked `AfterFX.exe` fails immediately instead of after 60 s.
- Omitting an optional argument no longer breaks code generation.
- Operation fixes: `layer.split`, `keyframe.set_easing`, `expression.restore_all`, `layer.create_light`, `project.undo`, `project.replace_font`, render queue indexing, and comp glob matching.

### Security

- Tool arguments can no longer be interpolated as executable code into the generated ExtendScript.
- `JSON.parse` on the ExtendScript side validates input before evaluating it.
- The IPC mailbox is created `0700`, the server warns when it is group- or world-writable, and no output path may target it.

### Known limitations

- Importing a project whose footage is missing can misattribute layer parenting.

[0.2.0]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.2.0
[0.1.3]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.1.3
[0.1.2]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.1.2
[0.1.1]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.1.1
[0.1.0]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.1.0
