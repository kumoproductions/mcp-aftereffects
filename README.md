# mcp-aftereffects

[![CI](https://github.com/kumoproductions/mcp-aftereffects/actions/workflows/ci.yml/badge.svg)](https://github.com/kumoproductions/mcp-aftereffects/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-informational)](package.json)
[![After Effects](https://img.shields.io/badge/After%20Effects-2024%E2%80%932026-informational)](https://www.adobe.com/products/aftereffects.html)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-informational)](#requirements)

Let an LLM drive Adobe After Effects. **mcp-aftereffects** bridges MCP-compatible clients (Claude Desktop, Claude Code, or any other stdio-capable MCP client) to a running After Effects session so the model can inspect project state, mutate comps and layers through atomic undo-grouped operations, checkpoint and restore entire projects as JSON, and verify its own edits by rendering frames — a typed tool layer instead of ad-hoc scripts pasted into the ExtendScript console.

**Good for:**

- **Comp audits** — "List every layer in `Main`; flag any with a disabled effect, a missing footage reference, or an expression error."
- **Keyframe / expression work** — "Add eased position keyframes to layer 3 between 0s and 2s, then put a wiggle expression on its opacity."
- **JSON checkpoint / restore** — snapshot the whole project to a JSON document before risky changes, roll back with a single import.
- **Render-verify loops** — mutate, render a frame with `ae_render_frame`, look at the PNG, correct, repeat — the model checks its own work visually.

> [!CAUTION]
> **Do not proceed unless you understand what this does.** An LLM with a live connection to After Effects can read your project, write to it, and (if you opt in) execute arbitrary code on your machine. In concrete terms:
>
> 1. **Your project data leaves your machine.** Comp and layer names, expression source, keyframe values, footage file paths — whatever the LLM reads via `ae_project_info` / `ae_comp_info` / `ae_layer_info` / `ae_project_export_json` — is forwarded to your chosen LLM provider and may be logged by your MCP client. **Under NDA or on unreleased work? Confirm with your studio/legal team first** that the provider's retention policy and your client's logs are acceptable.
> 2. **The LLM gets write access.** It can create, mutate, and delete comps, layers, keyframes, effects, masks, and expressions. Every call runs inside a single automatic undo group, so one Ctrl+Z reverts one call's project mutations — but `ae_save_project` overwrites the file on disk, and files written outside the project (rendered PNGs, exported JSON) are not undoable. Note that `batch.run` is one call: a fifty-operation batch is a single Ctrl+Z.
> 3. **Arbitrary ExtendScript is off by default.** The `eval.run` operation (called through `ae_do`) executes unrestricted ExtendScript with the full authority of the After Effects process: file I/O, `system.callSystem`, `Socket`. It exists only while `AE_MCP_ENABLE_EVAL=1` is set — the escape hatch for anything the atomic operations don't cover. Turn it back off when you no longer need it.
>
> **`AE_MCP_READONLY=1` turns point 2 off and overrides the point-3 opt-in.** Point 1 still applies — the model can still read your project and forward it to your provider. See [Capability policy](#capability-policy).
>
> Before first use: back up (or commit) your project, start on a throwaway `.aep`, and leave your MCP client's per-call approval prompts enabled.

---

## How it works

```
MCP client (Claude Code, Claude Desktop, …)
   │ stdio
   ▼
mcp-aftereffects  (Node.js)
   │ AfterFX.exe -r (Windows) / osascript (macOS)  +  file IPC
   ▼
After Effects  (your running instance)
```

There is nothing to install inside After Effects — no plugin, no panel, no socket. The server drives your existing AE instance — through `AfterFX.exe -r` on Windows, through AppleScript (`osascript` → `DoScript`) on macOS — one round trip per tool call. Every call runs inside a single automatic undo group, so one Ctrl+Z reverts exactly one call. Transport internals are documented in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Requirements

- **Windows or macOS.**
- **Adobe After Effects 2024, 2025, or 2026.** Default install locations are probed automatically (2026 → 2025 → 2024): `C:/Program Files/Adobe/Adobe After Effects <year>/Support Files/AfterFX.exe` on Windows, `/Applications/Adobe After Effects <year>/Adobe After Effects <year>.app` on macOS. Override with `AE_MCP_EXE` if yours lives elsewhere.
- **Node.js 24+.**
- **The AE preference `Preferences → Scripting & Expressions → Allow Scripts to Write Files and Access Network` must be ON.** Without it every call times out.
- **macOS only: allow Automation.** The first call makes macOS ask whether your MCP client (or terminal) may control After Effects. Approve it — or later under `System Settings → Privacy & Security → Automation`. A denied permission shows up as calls failing fast with a `Not authorized` transport error.
- An MCP-compatible client (e.g. Claude Code).

## Quickstart

There is no checkout to clone and nothing to install inside After Effects. Assuming you already meet the [Requirements](#requirements):

1. **Start After Effects manually and open (or create) a project.** The transport targets the existing AE instance; a warm call takes ~500 ms–1 s. If AE isn't running, the first call cold-launches it (10–30 s) and is unreliable until AE has been through some user interaction — starting AE yourself first is the dependable path.

2. **Smoke-test the MCP server from the CLI:**

   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ae_version_info","arguments":{}}}' \
     | npx -y @kumoproductions/mcp-aftereffects
   #   → {"result":{"content":[{"type":"text","text":"{\n  \"ok\": true,\n  \"result\": {\n    \"app\": {\n      \"version\": \"26.3x87\", …
   ```

Then wire it into your MCP client (see [Client configuration](#client-configuration)) and try:

> _"What comps are in this project? Add a red solid to `Main` and render frame 0 so I can see it."_

The LLM will call `ae_project_info` → `ae_do` → `ae_render_frame` in sequence.

Prefer running from a local checkout? See [CONTRIBUTING.md](./CONTRIBUTING.md) for the source-install flow.

## Client configuration

Register it as a stdio MCP server launched through `npx` — the package is fetched on demand, so there is no build step and nothing to keep up to date by hand:

```json
{
  "mcpServers": {
    "aftereffects": {
      "command": "npx",
      "args": ["-y", "@kumoproductions/mcp-aftereffects"]
    }
  }
}
```

| Client            | Where that goes                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code       | `claude mcp add aftereffects -- npx -y @kumoproductions/mcp-aftereffects`, or the JSON above in `.mcp.json` at your project root    |
| Claude Desktop    | `%APPDATA%\Claude\claude_desktop_config.json` (Windows) · `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Other MCP clients | see the client's docs for registering a stdio server                                                                                |

To scope what the model is allowed to do, add an `env` map to the same entry — every switch in [Environment variables](#environment-variables) is read from the server process's environment. Inspection-only sessions want:

```json
"env": { "AE_MCP_READONLY": "1" }
```

> [!NOTE]
> **Official releases only come from two places:** the npm package [`@kumoproductions/mcp-aftereffects`](https://www.npmjs.com/package/@kumoproductions/mcp-aftereffects) and the [Releases page](https://github.com/kumoproductions/mcp-aftereffects/releases) under `kumoproductions/mcp-aftereffects`. If you obtained a scoped npm package from anywhere else claiming to be this server, treat it as untrusted.

## Environment variables

| Var                       | Legacy alias | Default                                                       | Notes                                                                                                                                                    |
| ------------------------- | ------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AE_MCP_EXE`              | `AE_EXE`     | probes AE 2026 → 2025 → 2024 in the default install locations | Windows: full path to `AfterFX.exe`. macOS: the `.app` bundle. Set when AE is installed somewhere non-standard.                                          |
| `AE_MCP_READONLY`         | —            | unset (write access **on**)                                   | `1` blocks everything that can modify the project. See [Capability policy](#capability-policy).                                                          |
| `AE_MCP_ALLOW_CATEGORIES` | —            | unset (all categories)                                        | Comma-separated `ae_do` category allowlist, e.g. `keyframe,property,batch`.                                                                              |
| `AE_MCP_ENABLE_EVAL`      | —            | unset (`eval.run` **disabled**)                               | `1` adds `eval.run` (arbitrary ExtendScript) to the registry. Ignored while `AE_MCP_READONLY=1` is set.                                                  |
| `AE_MCP_RUNTIME_DIR`      | —            | `<os temp>/mcp-aftereffects/runtime`                          | Relocate the file-IPC mailbox. Both sides must agree; the server publishes the location so the dispatcher can find it. Rarely needed outside of testing. |

### Capability policy

Three independent switches. `ae_catalog` only ever advertises what the current policy will actually execute, so the model plans against what it can run rather than concluding the server is broken.

| Setting                       | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AE_MCP_READONLY=1`           | `ae_save_project` and `ae_project_import_json` are not registered. `ae_do` accepts only operations that cannot modify the project (`property.get`/`list`, `layer.bounds`, `project.find_layers`, `marker.list`, `render.status`, `font.list`, `command.find`/`list`, and the rest of the read-only set `ae_catalog` advertises while this mode is on, plus read-only `batch.run` children). `eval.run` stays disabled regardless of `AE_MCP_ENABLE_EVAL`. |
| `AE_MCP_ALLOW_CATEGORIES=a,b` | `ae_do` refuses any operation outside the listed categories. Combine with read-only mode for a tightly scoped audit session.                                                                                                                                                                                                                                                                                                                              |
| `AE_MCP_ENABLE_EVAL=1`        | Adds `eval.run` (arbitrary ExtendScript) to the registry; overridden by `AE_MCP_READONLY=1`. Note the default (unset) is **not** a sandbox: `command.execute` still drives arbitrary menu commands and every write operation remains. Use `AE_MCP_READONLY=1` if you mean "don't touch my project".                                                                                                                                                       |

`ae_render_frame` and `ae_project_export_json` survive read-only mode: they write files but never touch the project, and the render-verify loop is the point of an inspection session. Read that literally — **read-only means "does not modify your project", not "has no side effects"**: both tools write to whatever absolute path they are given, so the model can still create or overwrite files anywhere After Effects can write (the one exception being the server's own IPC directory, which they refuse). The active policy is printed to stderr at startup and returned by `ae_catalog`.

## Tools

11 tools. The LLM picks tools itself based on the prompt — you rarely invoke them directly. See [docs/TOOLS.md](./docs/TOOLS.md) for the generated per-tool reference.

| Tool                     | Purpose                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ae_project_info`        | Project-level info: file path, dirty flag, all items with type/summary, active item. Start here.                                                                                                                                        |
| `ae_comp_info`           | Detailed comp info: size, fps, duration, work area, motion blur, layer summaries. Accepts a name or item id — or an array of them for one round trip.                                                                                   |
| `ae_layer_info`          | Full layer info including Transform / Effects / Masks / Text / Contents property trees with keyframes. `layerIndex` also takes an array or `"all"` — a whole-comp audit in one call.                                                    |
| `ae_render_frame`        | Render a single PNG of a comp at a given time. The agent's "eyes" — pair with mutations for a visual feedback loop.                                                                                                                     |
| `ae_save_project`        | Save the project. Pass `path` for Save As.                                                                                                                                                                                              |
| `ae_project_export_json` | Serialize the entire project to a JSON document: folders, comps, layers, keyframes, effects, masks, text, shape contents, markers (comp + layer), time remap, solids, and file footage references. Write to `outPath` or return inline. |
| `ae_project_import_json` | Rebuild a project from a document produced by `ae_project_export_json`. Supports `clearFirst`, `dryRun` (validate-only), and `skipValidation`.                                                                                          |
| `ae_version_info`        | AE version, build, and capability probe (`saveFrameToPng`, `app.effects`, `Socket`).                                                                                                                                                    |
| `ae_catalog`             | Discover available atomic operations for `ae_do`. Without args: all categories. With a category: detailed per-operation params.                                                                                                         |
| `ae_do`                  | Execute an atomic operation by name (from `ae_catalog`). Covers keyframes, transforms, effects, shapes, expressions, comp/layer mutations, etc.                                                                                         |
| `ae_context`             | Ambient project/comp/selection state plus the `AE.*` helper list, ES3 rules, and the undo contract. Call once at session start.                                                                                                         |

Read-heavy work gets dedicated tools; the entire mutation surface hangs off a two-step model instead: `ae_catalog` enumerates atomic operations grouped by category with their parameter schemas, and `ae_do` executes one by name — validating arguments against the published schema before anything reaches After Effects, and returning ambient context (active comp, selection, project state) with every response. `eval.run` is the opt-in escape hatch when no atomic operation fits.

## Usage patterns

### Discovery: "what's in this project?"

1. `ae_project_info()` → item list and the active item.
2. `ae_comp_info({ nameOrId: ["Main", "Intro"] })` → layer lists for several comps in one call.
3. `ae_layer_info({ compNameOrId: "Main", layerIndex: "all" })` → every layer's full property values and keyframes in one call (a single index or an array of indices also works).

### Mutation with visual verification

1. `ae_catalog({ category: "layer" })` → find the operation and its params.
2. One `ae_do` call both mutates and verifies — `batch.run` children run in order, and `render.frame` / `comp.info` ride in the same call:

   ```
   ae_do({ operation: "batch.run", args: { ops: [
     { operation: "keyframe.add", args: { comp: "Main", layer: 2, property: ["Transform", "Position"], time: 0, value: [960, 540] } },
     { operation: "render.frame", args: { comp: "Main", time: 0, outPath: "/absolute/path/check.png" } }
   ] } })
   ```

3. View `check.png` through your client's image capability to verify the result.
4. If wrong, correct with another `ae_do` call — one `project.undo` reverts the whole previous call, batch included.

### Checkpoint / restore via JSON

- **Snapshot before risky changes:** `ae_project_export_json({ outPath: "/absolute/path/before.json" })`.
- **Make changes** via any combination of mutating tools.
- **Roll back if needed:** `ae_project_import_json({ inPath: "/absolute/path/before.json", clearFirst: true })`.
- **Validate a document without touching AE:** `ae_project_import_json({ inPath, dryRun: true })` returns the plan (item counts) only.

### Custom JSX via `eval.run`

Requires `AE_MCP_ENABLE_EVAL=1`. `ae_do({ operation: "eval.run", args: { code: "..." } })` runs an ES3 function body: `var` only (no `let`/`const`, arrow functions, or template strings), classic `for` loops, and end with `return <JSON-friendly-value>;`. The code already runs inside the call's automatic undo group — never open your own. Helpers are in scope under `AE.*` (`AE.findCompByNameOrId`, `AE.serializeLayerFull`, `AE.exportProject`, …) and `log("message")` pushes breadcrumbs into the response; `ae_context` returns the full helper list and rules.

## Troubleshooting

- **Every call times out.** Check that After Effects is running with a project open, and that `Preferences → Scripting & Expressions → Allow Scripts to Write Files and Access Network` is ON — without it AE cannot write responses. On macOS, also check that your MCP client is allowed to control After Effects (`System Settings → Privacy & Security → Automation`).
- **`AE_NOT_FOUND`.** After Effects is not in the default install locations — set `AE_MCP_EXE`.
- **AE warns "Attempt was made to run a second script while another script was already running".** AE runs one script at a time and refuses any script delivered mid-run — and the warning dialog itself blocks all scripting until dismissed, so click OK first. Server-originated calls are serialized across processes by a busy lock, and a refused dispatch is retried automatically; the usual remaining causes are a user-installed panel/startup script running at that moment, or two different script-driving tools (another AE automation tool, or this server registered twice) driving the same AE — remove one.
- **A call hung After Effects:**
  1. `taskkill /F /IM AfterFX.exe` (Windows) / `pkill -9 -f "Adobe After Effects"` (macOS)
  2. Start AE again and open (or create) a project so it is in a "ready" state
  3. Retry
- **Deeper digging:** the server prints its mailbox path to stderr at startup; `dispatcher.log` in that directory records what each call did inside AE. A "no pending request" line there means AE and the server disagree about the mailbox location (typically AE running as a different user).

## Known limitations

- **Import fidelity with missing footage.** `ae_project_import_json` addresses layers by their original stacking index. When a layer is skipped during import (its source footage is absent and no placeholder resolves), later parent-index references can point at the wrong layer. Keep the referenced footage reachable, or expect parenting to need a manual touch-up on projects with missing sources.
- **One After Effects instance.** Multiple MCP clients are safe, but they all drive the same AE, and AE runs JSX single-threaded. Concurrent calls queue; they do not parallelize. Use `batch.run` to collapse a burst of mutations into one round trip.
- **Ambient context is not free in tokens.** Every `ae_do` response carries the active comp and full selected-layer list. It costs no extra round trip, but on a comp with hundreds of selected layers it is not nothing.
- **macOS support is young.** The macOS launcher (AppleScript / `osascript`) is newer than the Windows path and has seen less real-world use. Issue reports are welcome.

## Contributing

Bug reports, feature requests, and PRs are welcome. [CONTRIBUTING.md](./CONTRIBUTING.md) covers the development setup, transport internals, testing tiers, and how to add tools and operations.

## License

[MIT](./LICENSE) © 2026 kumo.productions, Inc.

## Trademarks

Adobe® and Adobe After Effects® are trademarks of Adobe Inc. This project is an independent, unofficial tool, **not affiliated with or endorsed by Adobe**.
