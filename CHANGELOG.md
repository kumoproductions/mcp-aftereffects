# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Every tool call failed on After Effects builds without a native `JSON`** (reported on 26.3x87 / macOS). ExtendScript hangs its operator-overload hooks off `Object.prototype` under one-character names, so inside AE `escMap["-"]` resolves to an inherited **Function** rather than `undefined`. The polyfill's `if (escMap[ch])` membership test therefore passed for `-`, `+`, `*` and `/`, and `out += <Function>` threw "Object of type Function found where a Number, Array, or Property is needed". Every request id is a hyphenated UUID, so every response was unserializable: no response file was ever written and every call timed out after 60s. `jsx/json2.jsx` now tests `typeof escMap[ch] === "string"`. Ordinary project data — a comp named `shot-01` — was enough to trigger it on its own. Where AE does supply a native `JSON` (Windows 26.3 does) the polyfill never installed and the bug never fired, which is why this was invisible on Windows.

- **A failing dispatcher took After Effects down with it.** `"FATAL: writeResponse threw: " + e` is not the harmless shorthand it looks like: ExtendScript cannot coerce an `Error` to a primitive, so the concatenation itself throws — from inside the handler whose only job was to report the original failure. The real error was never logged (`dispatcher.log` was never even created), the replacement escaped the dispatcher, and AE raised a modal error dialog. A modal blocks every subsequent `-r` launch, so from that point on every call failed as a confusing "another call holds the dispatcher busy lock" timeout until a human clicked OK. Exceptions now go through `AE.errText` (`jsx/helpers.jsx`) and the dispatcher's own copy of it, and the dispatcher body is wrapped in a top-level guard so nothing can reach AE's modal.

- **The same coercion bug in 94 other places.** Every `catch (e) { _w.push("prop: " + e); }` in the generated ExtendScript and in `jsx/import.jsx` had it. Unlike the dispatcher case these were contained by the execute handler, but each turned a recoverable warning into a failed call — and this class fires on **every** platform, native `JSON` or not. All of them now use `AE.errText`.

- **`layer.move` never worked.** It called `_layer.moveTo(toIndex)`. `Layer` inherits `moveTo` from `PropertyBase`, so the call exists, type-checks and reads correctly — and then throws for every layer, every time: `Can not "moveTo" this property, because parent is not an INDEXED_GROUP`. A layer's parent is the composition, not a property group, so the inherited method never applies; the operation had a 100% failure rate from the first release. Reordering is now expressed the way AE actually supports it, relative to a sibling: `moveBefore` when moving up, `moveAfter` when moving down (the layers in between shift up by one as soon as the layer vacates its slot, so landing _after_ the current occupant of `toIndex` is what puts it _at_ `toIndex`). `toIndex` is also range- and integer-checked now instead of being handed to AE unvalidated — it returns `{ ok: false, error }` with the comp's layer count rather than a raw `JSX_THROW`. Verified against AE 26.3x87 in both directions and at both ends of the stack; the same cases are pinned in `tests/layer-move.test.ts`, which executes the generated JSX against a fake `app` on top of the real `helpers.jsx`.

- **A response that cannot be serialized no longer costs 60 seconds.** `writeResponse` falls back to a hand-built minimal error response, so the caller learns what happened instead of waiting out its timeout.

### Changed

- `npm run check` now fails on both shapes of rendering a caught exception by coercion (`"..." + e`, `String(e)`) anywhere in `jsx/` or in generated JSX under `src/`. The rule keys off catch-parameter naming, so an ordinary identifier is not mistaken for an exception. It found the 14 sites in `jsx/import.jsx` that a hand grep had missed.

## [0.1.0] - 2026-08-09

Initial public release of `@kumoproductions/mcp-aftereffects`.

### Added

- **136 atomic operations across 21 categories**, verified against the current After Effects scripting guide:
  - `keyframe.*`: `hold` easing preset, `set_batch` (bulk `setValuesAtTimes`), `shift` (retime/scale with interpolation preserved), `copy` (property→property, cross-comp), `set_spatial` (tangents/continuity), `set_roving`.
  - `property.add` / `property.remove` / `property.separate_dimensions` — generic `addProperty` unlocks text animators, layer styles, and every shape modifier without dedicated ops.
  - `layer.bounds` (`sourceRectAtTime` + comp-space corners), `layer.convert_point`, `layer.apply_preset` (.ffx), `layer.replace_source`.
  - `shape.*`: polystar, repeater, rounded corners, offset paths, wiggle paths, zigzag, pucker/bloat, twist, gradient fill/stroke (stops are not scriptable in AE — documented in the op).
  - `text.*`: `set_style` grows justification, baseline shift, auto-leading, caps (via `fontCapsOption`), faux bold/italic, scale, tsume; `set_box` resizes box text; `add_animator` builds animator + range/wiggly/expression selector in one call.
  - `footage.*` (new): `replace` (relink, sequences included), `interpret` (alpha/fps/loop/fields/PAR), `set_proxy`.
  - `item.*` (new): `folder.create`, `item.move_to_folder`, `item.set_props` (rename/label/comment), `item.list`.
  - `marker.remove` / `marker.update` / `marker.list`; `mask.remove`; `comp.add_guide` / `remove_guide` / `set_guide` / `list_guides`.
  - `project.*`: `set_settings` / `get_settings` (color depth, expression engine, working space, time display, GPU), `reduce`, `remove_unused_footage`, `consolidate_footage`; `import_file` learns image sequences and layered-file import modes.
  - `render.*`: `set_output` (render/output-module templates, time span, path), `list_templates`, `status`, `queue_in_ame`.
  - `font.list` / `font.list_missing` (`app.fonts`, AE 24.0+).
  - `egp.*` (new): Essential Graphics / MOGRT — `set_name`, `add_property`, `list_controllers`, `export_mogrt`, `set_alternate_source`.
  - `viewer.get_state` / `viewer.set_options` (zoom, exposure, checkerboard, guides/rulers).
- **Stable layer references.** Layer-targeting arguments accept `{ id: n }` (`Layer.id`, AE 22.0+) alongside index and name, so references survive reordering and renaming; `ae_layer_info` and layer summaries now include `id`.
- Version-gated APIs degrade gracefully: operations that need a newer AE (fonts, guides, EGP, point conversion) report a clear error or warning instead of throwing.

- **Color-managed capture.** `ae_render_frame` detects the project working space. In color-managed projects it lets AE apply its own view transform — the comp is captured with a transient top-most adjustment layer carrying an "OCIO Display Transform" effect, so the viewer keeps showing the same comp and the result is viewer-exact for ANY working space and OCIO config (verified at a mean error of 0.2/255 against a viewer-referenced capture on a color-managed ACES/ACEScg project). The undocumented linear scale `saveFrameToPng` applies to the result (1/10 on AE 26.3) is measured by a one-shot in-AE calibration render and restored, and the output is written as an 8-bit sRGB-tagged PNG. Where the effect is unavailable (pre-OCIO AE, read-only mode) a pure-math ACES fallback (RRT+ODT fit, ~1.7/255) covers ACEScg/ACES2065-1, and anything else degrades to an explicit warning instead of silently wrong pixels. Non-color-managed projects get the same explicit sRGB tagging (values unchanged), closing the "every viewer interprets the untagged 16-bit file differently" ambiguity. `colorManaged: "off"` keeps the legacy raw output.

- **Cross-process dispatch serialization.** AE runs one script at a time and refuses (with a scripting-blocking modal) any script delivered mid-run — the "Attempt was made to run a second script" warning. Dispatches are serialized **across server processes** by a busy lock in the shared mailbox — acquired atomically (`open` with `wx`), mtime-refreshed while the owning call is alive, and broken by waiters 90s after its owner stops. When AE refuses our script anyway (a user panel or startup script was running), the still-unconsumed request is detected and the dispatcher is relaunched with backoff (up to 3 attempts) instead of waiting out the whole timeout; consume-on-read keeps duplicate launches harmless. Timeout messages now say how many launches were tried and point at the modal-dialog cause.

- **Batched reads and single-call verify loops.** `comp.info`, `layer.info`, and `render.frame` are registered as read-only operations, so one `batch.run` can mutate and then re-inspect or render visual proof in the same call. `ae_comp_info` accepts an array of comps, and `ae_layer_info` accepts an array of indices or `"all"`, collapsing a whole-comp audit into a single round trip. The read tools and their operation twins share one JSX body, so the two surfaces cannot drift apart.
- **macOS support.** On macOS the dispatcher is launched through AppleScript (`osascript` → `DoScript`) instead of `AfterFX.exe -r`, with the mailbox path injected directly into the launch so Node and ExtendScript never have to agree on a temp directory. Default `/Applications/Adobe After Effects <year>` installs are probed, `AE_MCP_EXE` accepts the `.app` bundle, and a denied macOS Automation permission is reported within seconds as a transport error instead of a silent timeout.
- **Operation argument validation.** `ae_do` (and every child of `batch.run`) validates `args` against the parameter schema `ae_catalog` publishes, before any code is generated or After Effects is contacted. Missing required parameters, wrong types, explicit `null`s, and unknown keys are all rejected — unknown keys come back with a nearest-name suggestion (`unknown parameter — did you mean 'layer'?`). The declarations stay the single source of truth; the validator is derived from them, so an operation can no longer advertise a schema it does not enforce.
- **Read-only mode.** `AE_MCP_READONLY=1` withholds `ae_save_project`, `ae_project_import_json`, and `ae_do`'s mutating operations, and keeps `eval.run` disabled regardless of the opt-in. `ae_catalog` lists only what survives, so the model never plans against an operation that will be refused. `ae_render_frame` and `ae_project_export_json` stay available — they write files but never touch the project.
- **Category allowlist.** `AE_MCP_ALLOW_CATEGORIES=keyframe,property` restricts `ae_do` to the named operation categories.
- **Unified error envelope.** Every tool failure returns `{ ok: false, error: { code, message, retryable, … } }` with a machine-readable `code` (`TIMEOUT`, `AE_NOT_FOUND`, `INVALID_ARGS`, `UNKNOWN_OPERATION`, `FORBIDDEN`, `OPERATION_FAILED`, `JSX_THROW`, `DISPATCHER`, `TRANSPORT`, `VALIDATION`, `IO`).
- **`AE_MCP_RUNTIME_DIR`** to relocate the IPC mailbox.
- `EvalRequest.payload` — bulk data travels beside the code instead of being inlined into it.
- `ae_do`: `timeoutMs` parameter for long-running operations.
- `ae_do` results include dispatcher `logs` and `durationMs`, and set `isError` when the operation fails.
- Vitest test suite: offline suites (schema validation, fixtures, JSX ES3 lint) always run; E2E suites probe for After Effects and self-skip when it is unreachable, with `AE_MCP_E2E=1` gating session-mutating tests and `AE_MCP_E2E_DESTRUCTIVE=1` gating the standalone kill-test.
- CI workflow (typecheck, lint, format, JSX ES3 lint, tool-docs drift, CRLF guard) and release automation: a `v*` tag publishes to npm (Trusted Publishing), the MCP Registry, and GitHub Packages, and creates the GitHub Release.

### Changed

- **Arbitrary ExtendScript is opt-in.** `eval.run` enters the operation registry only when `AE_MCP_ENABLE_EVAL=1` is set (read-only mode wins over the opt-in). Note that the default is not a sandbox: with eval off, `command.execute` still drives arbitrary menu commands and every write operation stays available.
- **Per-request mailbox.** Each call gets its own `request-<id>.json` / `response-<id>.json` in a machine-wide directory under the OS temp dir. Concurrent MCP clients cannot delete each other's responses or overwrite each other's unconsumed requests, and the mailbox needs no writable package directory, so a read-only install (global npm, `npx` cache, Program Files) works.
- `ae_project_import_json` sends the document as `payload` rather than embedding it in the generated ExtendScript, so importing a large project no longer hands the ES3 parser a multi-megabyte literal.
- `ae_do` is annotated `destructiveHint: true`; per-operation gating happens through the policy layer. Tool annotations are derived from each tool's declared effect rather than a hand-maintained name list.
- `layer` parameters are declared `any` (index **or** name) across all operations, matching what `CompItem.layer()` accepts.
- `batch.run` reports how many children failed and sets its own `ok` accordingly; its description states that the whole batch is one undo group.
- Tools are built on a `defineTool` registry (`src/tools/*` + `ALL_TOOLS`) with shared result helpers.
- Dispatcher responses carrying `id: null` (the dispatcher failed before reading the request) are surfaced immediately as errors instead of being ignored until the poll times out.
- Transport never throws: every failure — including a missing `AfterFX.exe` — comes back as a normal error result. `AfterFX.exe` is resolved lazily on the first call, so the server starts and lists tools on machines without After Effects installed.
- Project-JSON documents declaring a newer `schemaVersion` than the server supports now fail validation instead of importing with silent data loss.
- Environment variables use the `AE_MCP_*` prefix; the legacy `AE_EXE` name is honored as a fallback for `AE_MCP_EXE`.
- Upgraded to zod 4, MCP SDK 1.29, and Node.js 24.

### Fixed

- **Operation-level failures reported as success.** An operation that returns `{ ok: false }` ran fine as far as the transport is concerned, so `ae_render_frame` on a missing comp, a failed `ae_save_project`, `ae_comp_info` / `ae_layer_info` on a bad lookup, and a `batch.run` whose children all failed were all delivered to the model with `isError: false`.
- **Timed-out requests could execute late.** A request nobody picked up was left in the mailbox and could be consumed by a later spawn, applying a mutation minutes after the caller gave up. Timeouts now reclaim their own request and say whether it was still unclaimed.
- **Spawn failures waited out the full timeout.** A `spawn` error (bad `AE_MCP_EXE`, blocked executable) was swallowed, so a call that provably could not complete took the full 60 s to report a misleading "is AE running?". Both the synchronous throw and the `error` event now fail immediately with `TRANSPORT`.
- The dispatcher derives the request id from the filename, so a corrupt or unparseable request still produces a correlated response instead of a timeout.
- Dispatcher double-execution race: requests are now consumed (deleted) on read, so a timed-out call's still-queued dispatcher run can no longer pick up and re-execute the next request.
- `dryRun` was silently ignored when combined with `skipValidation`.
- `layer.split` produced a broken split.
- `keyframe.set_easing` mishandled spatial ease on position-like properties.
- `expression.restore_all` could loop forever.
- Expression manifest paths resolved incorrectly.
- `layer.create_light` ignored the requested `lightType`.
- `project.undo` used a wrong command id.
- `project.replace_font` did not apply the replacement.
- Render operations used a wrong `queueIndex`.
- `batch` skipped per-operation argument validation.
- `import.jsx` called a placeholder-footage API that does not exist in shipping After Effects.
- `findComps` glob patterns were not end-anchored, matching unintended comps.
- `jsxVal` now escapes U+2028/U+2029 (which ExtendScript's pre-ES2019 parser treats as line terminators) and normalizes `undefined` to `null`, so omitting an optional argument (e.g. `layer.create_solid` without `width`/`height`, `property.get` without `time`) no longer throws during code generation.
- The introspection tools (`ae_comp_info`, `ae_layer_info`, `ae_render_frame`, `ae_save_project`) and `ae_project_import_json` now embed user values through `jsxVal`, so a comp name, path, or text-layer string containing U+2028/U+2029 can't break the generated script.

### Security

- **Injection lint over generated ExtendScript.** A tool argument interpolated raw into generated JSX would be executable code inside After Effects, walking past the capability policy entirely — the policy gates which operation runs, never what its arguments expand to. The rule was documented but unenforced; `tests/helpers/lint-codegen.ts` now fails the build on it, and runs as part of `npm run check`, the pre-commit hook, and CI. No current operation violated it.
- **Guarded `JSON.parse` on the ExtendScript side.** `jsx/json2.jsx` parsed with a bare `eval`, on the assumption that only trusted data reached it. That assumption did not hold: the dispatcher parses the whole request file this way, and a request carries `payload`, which for `ae_project_import_json` is the contents of an arbitrary `.json` file the caller pointed at. Crockford's four-stage validation now runs before the eval.
- **U+2028/U+2029 escaped on the transport path.** They are legal raw inside JSON strings but line terminators to the ES3 parser, so one in an imported project document (a layer name, say) could cut a string literal in half mid-parse. `jsxVal` had always escaped them when generating code; the request serializer now does the same for `payload`, which never passes through `jsxVal`.
- **Narrower mailbox trust boundary.** The mailbox is created `0700` on POSIX, and the server warns at startup when it finds one group- or world-writable — including the parent directory that holds `runtime-dir.txt`, since the dispatcher follows that pointer before looking at the default mailbox and would execute a request out of wherever it leads. On Windows, where the mode check is inert and the per-user `%TEMP%` ACL carries the property instead, a mailbox relocated by `AE_MCP_RUNTIME_DIR` is reported as unverified rather than passing silently. When the macOS launcher injects the mailbox path, the dispatcher uses that path alone instead of falling back to other candidates, and the in-package location is not a mailbox candidate at all.
- **Output paths cannot target the mailbox.** `ae_render_frame`, `ae_project_export_json`, and the `render.frame` operation refuse to write inside the IPC directory, so nothing routed through the server can feed the transport its own input.
- The release workflow's verify job runs with read-only `contents` permission and does not persist git credentials.

### Known limitations

- Importing a project whose footage is missing can misattribute layer parenting (index-based references shift when a layer is skipped).

[0.1.0]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.1.0
