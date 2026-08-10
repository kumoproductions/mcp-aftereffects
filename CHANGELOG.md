# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[0.1.1]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.1.1
[0.1.0]: https://github.com/kumoproductions/mcp-aftereffects/releases/tag/v0.1.0
