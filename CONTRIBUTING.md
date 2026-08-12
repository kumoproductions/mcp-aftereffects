# Contributing to mcp-aftereffects

Thanks for your interest. This project connects Adobe After Effects to MCP clients (Claude Desktop / Claude Code and any other stdio-capable MCP client) through a TypeScript server that drives AE via file IPC plus a per-platform dispatcher launch (`AfterFX.exe -r` on Windows, `osascript`/DoScript on macOS). Most contributions will touch either the TS tool/operation definitions, the ExtendScript in `jsx/`, or both.

## Prerequisites

- **Node.js** >= 24
- **Adobe After Effects** 2024–2026 — required only when running E2E tests. Windows and macOS (the transport launches the dispatcher via `AfterFX.exe -r` / `osascript`).
- **Git** with `core.autocrlf` unset or set to `input` (repo enforces LF via `.gitattributes`)

```bash
git clone https://github.com/kumoproductions/mcp-aftereffects.git
cd mcp-aftereffects
npm install        # also runs `lefthook install`
npm run build
```

If After Effects is installed somewhere other than the default locations (`C:/Program Files/Adobe/Adobe After Effects <year>/Support Files/AfterFX.exe` on Windows, `/Applications/Adobe After Effects <year>/Adobe After Effects <year>.app` on macOS), set `AE_MCP_EXE` to the full path — the `.exe` on Windows, the `.app` bundle on macOS.

### Pointing a local MCP client at your checkout

While iterating, point your MCP client at the freshly-built `dist/index.js` instead of the published npm package:

```json
{
  "mcpServers": {
    "aftereffects": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-aftereffects/dist/index.js"]
    }
  }
}
```

There is nothing to install inside After Effects — the dispatcher JSX is handed to AE on every call (`AfterFX.exe -r` on Windows, `osascript`/DoScript on macOS), so ExtendScript edits take effect on the next tool call with no restart.

## Development loop

| Task                        | Command                  |
| --------------------------- | ------------------------ |
| Build the TS server         | `npm run build`          |
| Build in watch mode         | `npm run dev`            |
| Type-check without emitting | `npm run typecheck`      |
| Type-check the tests        | `npm run typecheck:test` |
| Lint TS/JS                  | `npm run lint`           |
| Auto-fix TS/JS lint         | `npm run lint:fix`       |
| Format TS/JS/JSON/MD/YAML   | `npm run format`         |
| ES3 lint the ExtendScript   | `npm run lint:jsx`       |
| Regenerate `docs/TOOLS.md`  | `npm run docs:tools`     |
| **Run every static check**  | `npm run check`          |
| Run the test suite          | `npm test`               |
| Tests in watch mode         | `npm run test:watch`     |

`npm run check` (typecheck + test typecheck + oxlint + oxfmt check + JSX ES3 lint + tool-docs drift) is what CI runs on every PR. Run it locally before pushing.

Pre-commit hooks (via [lefthook](https://lefthook.dev/)) automatically run `oxlint`, the JSX ES3 lint, `oxfmt`, a CRLF guard, and regenerate `docs/TOOLS.md` when the tool registry changed. They install themselves during `npm install`.

## How a call reaches After Effects

There is no long-lived bridge process. Each JSX execution is one round-trip:

1. Node validates the call against the operation's declared parameters (`src/opschema.ts`) — nothing reaches AE until the arguments type-check.
2. Node writes `<mailbox>/request-<id>.json`: `{ id, label, code, payload, undoGroup }`. The mailbox is `%TEMP%\mcp-aftereffects\runtime\` unless `AE_MCP_RUNTIME_DIR` says otherwise.
3. Node launches the dispatcher (`src/transport/launcher.ts`). Windows: `AfterFX.exe -r jsx/dispatcher.jsx`. macOS: `osascript` sends a `DoScript` bootstrap that pins the mailbox path into `$.global.AE_MCP_RUNTIME_DIR_OVERRIDE` and `$.evalFile`s the dispatcher — injecting the path means Node's `os.tmpdir()` and ExtendScript's `Folder.temp` never have to agree on macOS.
4. The dispatcher locates the mailbox, picks the **oldest pending** `request-*.json`, and **deletes it immediately (consume-on-read)** — this is what prevents a timed-out, still-queued dispatcher run from picking up another request and executing it twice. A run that finds nothing pending logs and exits without writing a response.
5. The dispatcher evals `code` with `payload` in scope — inside an undo group unless the request set `undoGroup: false` — JSON-serializes the result, and writes `<mailbox>/response-<id>.json` atomically (tmp file + rename).
6. Node polls for **its own** `response-<id>.json`, then deletes it.

Response shape: `{ id, ok, phase, result, error, stack, logs }`. `phase` distinguishes a dispatcher failure (before our code ran) from a script failure, which the transport maps to the `DISPATCHER` and `JSX_THROW` error codes respectively.

**Why per-id files.** One machine has one AE, so every server process on it shares the mailbox. A single `request.json`/`response.json` pair let one client delete another's response or overwrite an unconsumed request. Per-id files make both unrepresentable. The dispatcher takes the id from the _filename_, not the JSON body, so even an unparseable request still gets a correlated reply instead of stranding the caller for a full timeout.

**Why `payload`.** Anything bulky or caller-supplied (a whole project document, a manifest, a vertex list) travels as `payload` rather than being inlined into the generated source. It never passes through the ES3 tokenizer.

The transport (`src/transport/FileIpcTransport.ts`) never throws — every failure mode, including "AfterFX.exe not found", comes back as a normal `ok: false` result carrying an `errorCode`. Calls from one process are serialized Node-side; AE's JSX engine is single-threaded anyway. When things go wrong, `dispatcher.log` and `dispatcher_start.txt` in the mailbox tell you how far the dispatcher got.

### The mailbox is the trust boundary

`dispatcher.jsx` executes the `code` string of whatever request it finds, inside After Effects, with AE's full authority. It has no signature to check and no access to the capability policy — `AE_MCP_READONLY`, `AE_MCP_ENABLE_EVAL` and the category allowlist all live on the Node side and are applied while _generating_ that code. So write access to the mailbox is equivalent to arbitrary code execution, and everything about it is arranged around keeping that access narrow:

- The directory is created `0700` on POSIX and lives under the per-user OS temp dir, not in the package. The server prints a warning at startup if it finds the mailbox group- or world-writable (which `AE_MCP_RUNTIME_DIR` pointing at a shared path would do).
- Its parent — `<temp>/mcp-aftereffects/`, which holds `runtime-dir.txt` — is checked the same way. The dispatcher follows that pointer _before_ looking at the default mailbox, so write access there is write access to the mailbox: plant a pointer, plant a request, and the dispatcher runs it out of a directory of the writer's choosing even though the real mailbox is private.
- On Windows both mode checks are inert (Node reports a synthetic mode; the per-user ACL on `%TEMP%` is what carries the property). Silence there would read as "checked, and fine", so a mailbox relocated by `AE_MCP_RUNTIME_DIR` gets an explicit "ACL not verified" warning at startup instead. The default location says nothing.
- The dispatcher reads from as few places as possible. When the macOS launcher injects the exact mailbox path via `DoScript`, that path is used **alone** — falling back would mean executing a request some other party left elsewhere. The in-package location is not a candidate at all.
- Tools that take an output path (`ae_render_frame`, `ae_project_export_json`, and the `render.frame` operation) refuse to write inside the mailbox, so nothing routed through the server can feed the transport its own input.
- Everything the dispatcher reads goes through the guarded `JSON.parse` in `jsx/json2.jsx`, which validates before it evals — see the comment there before touching it.

### Mailbox contents

`%TEMP%\mcp-aftereffects\runtime\` (or `AE_MCP_RUNTIME_DIR`) holds:

- `request-<id>.json` — one outbound request, consumed (deleted) by the dispatcher on read
- `response-<id>.json` — its reply, deleted by the server once collected
- `dispatcher.log` — append-only debug log written by `dispatcher.jsx`. A "no pending request; searched: …" line means AE and the server disagree about where the mailbox is (most likely AE running as a different user).
- `dispatcher_start.txt` — proof-of-life marker written at the top of each dispatcher run
  Orphaned request/response files older than an hour are swept on server startup. Nothing else belongs in here — the sweeper only knows about mail, and the tools refuse to write into it. E2E artifacts (project backups, roundtrip documents) go to `%TEMP%\mcp-aftereffects-e2e\` instead.

## Error envelope

Every tool failure returns the same shape — `{ ok: false, error: { code, message, retryable, details?, hint? } }` — so the model branches on `code` instead of pattern-matching prose. The codes (`src/errors.ts`):

| Code                              | Meaning                                                                     | What to do                                         |
| --------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- |
| `TIMEOUT`                         | AE never answered (retryable)                                               | Retry; check AE is running and not showing a modal |
| `TRANSPORT`                       | Spawn or filesystem failure on the Node side (retryable)                    | Check `AE_MCP_EXE`; retry                          |
| `AE_NOT_FOUND`                    | `AfterFX.exe` could not be located                                          | Set `AE_MCP_EXE`                                   |
| `INVALID_ARGS`                    | Arguments failed the operation's parameter schema                           | Fix the args (`details.issues` says how)           |
| `UNKNOWN_OPERATION` / `_CATEGORY` | No such operation/category                                                  | `ae_catalog`; `details.suggestion` may name it     |
| `FORBIDDEN`                       | Blocked by the capability policy                                            | Stop — this is a deployment decision, not a bug    |
| `OPERATION_FAILED`                | The operation ran and reported failure (comp not found, index out of range) | Fix the target and retry                           |
| `JSX_THROW`                       | The generated ExtendScript threw inside AE                                  | Inspect `stack`                                    |
| `DISPATCHER`                      | dispatcher.jsx failed before running our code                               | Check the mailbox and AE's scripting preference    |
| `VALIDATION`                      | A project JSON document failed schema validation                            | Fix the document; `dryRun` to inspect              |
| `IO`                              | Node-side read/write of a caller-supplied path failed                       | Pick a readable/writable path                      |

## How the code fits together

```
src/                         TypeScript MCP server
├── index.ts                 Stdio entry, registers ALL_TOOLS (policy-filtered)
├── config.ts                Paths, mailbox location, AfterFX.exe resolution
├── policy.ts                Capability policy (readonly / allowlist / eval)
├── errors.ts                AeErrorCode + the unified error envelope
├── registry.ts              Operation registry + JSX generation helpers
├── opschema.ts              Argument validation derived from OperationParam[]
├── schema.ts / validate.ts  Project-JSON schema + validation
├── transport/
│   ├── AeTransport.ts       Transport interface (execute → EvalResult)
│   ├── launcher.ts          Per-platform dispatcher launch (AfterFX.exe -r / osascript)
│   └── FileIpcTransport.ts  per-id mailbox / spawn / poll response-<id>.json
├── tools/
│   ├── define-tool.ts       defineTool() + jsonResult()/toMcpResult() helpers
│   ├── index.ts             ALL_TOOLS registration list
│   └── *.ts                 one file per MCP tool (ae_*)
└── operations/
    ├── index.ts             imports every operation module
    └── *.ts                 registerOp() calls grouped by area

jsx/                         ExtendScript that runs inside After Effects
├── dispatcher.jsx           Request/response loop, undo group, error capture
├── helpers.jsx              AE.* lookup helpers shared by generated code
├── export.jsx / import.jsx  Project JSON export/import
└── json2.jsx                JSON polyfill for ExtendScript
```

Two layers of MCP surface:

- **Static tools** (`ae_project_info`, `ae_comp_info`, `ae_render_frame`, …) — one `defineTool` per file, documented in `docs/TOOLS.md`.
- **Operations** — small atomic mutations (`layer.create_text`, `keyframe.set`, …) registered in `src/operations/`. They are _not_ separate MCP tools: clients discover them at runtime via `ae_catalog` and execute them via `ae_do`.

## ExtendScript rules (ES3)

After Effects' ExtendScript engine is ECMAScript 3. Everything that ends up **inside AE** — the files in `jsx/` _and_ every JSX string generated inside TypeScript template literals — must stay ES3:

- `var` only — no `let`, `const`, arrow functions, classes, or destructuring.
- No template literals in the _output_ (the surrounding TS template literal is fine; the generated string must not contain backticks). Build strings with `+` concatenation.
- No `Array.prototype.map` / `filter` / `forEach` / `indexOf` — plain `for` loops.
- No trailing commas, no getters/setters, no `JSON` beyond what `json2.jsx` provides.
- Never render a caught exception by coercion — see below.

### Two ways ExtendScript is not JavaScript

These are not style rules. Each one shipped as a bug that broke every tool call, and neither is visible when the same code is read as JavaScript.

**Never write `"failed: " + e`.** ExtendScript cannot coerce an `Error` to a primitive, so the concatenation _itself_ throws `Object of type Error found where a Number, Array, or Property is needed` — from inside the handler whose job was to report the original failure. The real error is lost and a bogus one takes its place; in the dispatcher it escaped as far as AE's modal error dialog, which blocks scripting for the rest of the session and makes every later call look like a busy-lock timeout. `String(e)` has the same problem. Use `AE.errText(e)` from `jsx/helpers.jsx` (the dispatcher keeps a private copy, `describeError`, so it stays able to report failures if an `#include` did not take). Enforced by the `es-error-concat` rule in `tests/helpers/lint-jsx.ts` and by the matching pass in `tests/helpers/lint-codegen.ts`.

**Never use truthiness to test membership of a dynamic key in a plain object.** ExtendScript hangs its operator-overload hooks off `Object.prototype` under one-character names, so `({})["-"]`, `["+"]`, `["*"]` and `["/"]` are each a **Function**, not `undefined`:

```js
// WRONG — passes for "-", then `out +=` throws on the Function it found:
if (escMap[ch]) out += escMap[ch];

// RIGHT — a hit is a string, or it is not a hit:
var esc = escMap[ch];
if (typeof esc === "string") out += esc;
```

Check the type you expect, or guard with `hasOwnProperty`. This is what made `json2.jsx` fail on every response id (all UUIDs, all hyphenated) on AE builds with no native `JSON`. Static analysis cannot see it; `tests/json-safety.test.ts` reproduces it by recreating the polluted prototype in Node, which is the only place the hazard is visible outside AE.

`npm run lint:jsx` (a vitest suite, `tests/lint-jsx.test.ts`) runs two static passes. The first scans the files under `jsx/` for ES3 violations and AE API misuse. The second scans every template literal under `src/` for the injection rule below. Lefthook runs both on staged files too.

### Embedding values: `jsxVal`, never raw interpolation

Any user-supplied argument embedded into generated JSX **must** go through `jsxVal(...)` from `src/registry.ts` — never interpolate user strings raw:

```ts
// WRONG — breaks on quotes, and is an injection vector:
var name = "${args.name}";

// RIGHT:
var name = ${jsxVal(args.name)};
```

`jsxVal` JSON-stringifies and additionally escapes U+2028/U+2029, which are legal in JSON strings but line terminators to ExtendScript's pre-ES2019 parser. Use the shared preambles for entity lookup: `jsxCompPreamble(args)` (defines `_comp`) and `jsxCompLayerPreamble(args)` (defines `_comp` + `_layer`, range-guards numeric layer indices). Static interpolation of _your own_ literals (e.g. a property name you control) is fine; anything that originates from tool arguments is not.

**This is enforced, not just documented.** `tests/helpers/lint-codegen.ts` fails the build on a bare `args` reference inside a template literal that looks like generated JSX. Two shapes are accepted: the reference sits inside a `jsx*` encoder call (`jsxVal(!!args.flag)`, `jsxCompPreamble(args)`), or it sits in the _test_ of a ternary that decides whether to emit a fragment at all (`${args.name ? … : ""}`) — the branch itself still has to encode. Note the limit: a value laundered through a local (`const n = args.name` … `${n}`) is invisible to it, so `jsxVal` at the point of embedding remains the rule you follow, not a rule the linter can prove. Helpers in the `jsx*` family are trusted by name, which is only sound while they live under `src/` where the same lint reads them.

Why it matters: the capability policy gates _which_ operation runs, never what its arguments expand to. A raw interpolation turns a comp name into executable ExtendScript and walks straight past `AE_MCP_READONLY` and the `eval.run` opt-in.

Generated code is a function body: end with `return { ok: true, ... };` (or `{ ok: false, error: "..." }` for expected failures) so results serialize cleanly.

## Adding a static MCP tool

1. Create `src/tools/my-tool.ts`:

   ```ts
   import { z } from "zod";
   import { defineTool, toMcpResult } from "./define-tool.js";

   export const myTool = defineTool({
     name: "ae_my_tool",
     title: "My Tool",
     description: "What it does, plus examples that help an LLM pick it.",
     group: "inspect", // inspect | document | render | operations
     inputShape: {
       /* zod schema */
     },
     handler: async (args, transport) => {
       const code = `
           // ES3 only — see above. Embed args via jsxVal(...).
           return { ok: true };
       `;
       return toMcpResult(await transport.execute({ code, label: "my_tool" }));
     },
   });
   ```

2. Add it to `ALL_TOOLS` in `src/tools/index.ts`.
3. `npm run docs:tools` to regenerate `docs/TOOLS.md` (the pre-commit hook also does this and stages the result).
4. Add tests (see below).

Static tools should stay rare — most new capability belongs in the operation registry instead.

## Adding an operation

1. Add a `registerOp` call in the matching `src/operations/<area>.ts` (or a new file):

   ```ts
   import { registerOp, jsxVal, jsxCompLayerPreamble } from "../registry.js";

   registerOp({
     name: "layer.my_op",
     category: "layer",
     description: "One-liner an LLM can act on.",
     params: [
       { name: "comp", type: "any", description: "Comp name or id", required: true },
       { name: "layer", type: "number", description: "1-based layer index", required: true },
     ],
     toJsx(args) {
       return `
           ${jsxCompLayerPreamble(args)}
           return { ok: true };
       `;
     },
   });
   ```

2. If you created a new file, import it in `src/operations/index.ts` (side-effect import — that's what triggers registration).

No docs regen needed: operations are advertised at runtime by `ae_catalog` and never appear in `docs/TOOLS.md`. They automatically get `ae_do`'s arg validation, `dryRun`, undo grouping, and batch support.

**Application-configuration operations require explicit user consent.** An operation that changes the user's AE application state rather than the project — preferences, memory limits, font substitution policy, saved render templates, the active tool — declares `appConfig: true`. Registration injects a required `confirm: true` parameter, and `ae_do`/`batch.run` refuse the call unless it is passed; the contract (surfaced in `ae_catalog` and the refusal message) is that the caller passes `confirm` only when the user explicitly requested the change, never as a side effect of other work.

**Undo grouping is automatic — do not open a group yourself,** either in `toJsx` output or in `eval.run` code; an unbalanced group leaks past the call and corrupts undo for the whole session. The one exception is an operation that _drives_ the undo stack (undo, redo): After Effects resolves those against the group that is still open, so wrapped in one they revert nothing the caller asked for. Such an operation declares `undoGroup: () => false` (see `project.undo`), which travels to the dispatcher as `undoGroup: false` and makes the call run bare. `batch.run` rejects those children — a batch is itself one undo group.

## Testing tiers

Tests run under vitest (`npm test`). They are layered so `npm test` is always safe to run:

1. **Offline suites** — schema validation, fixtures, the JSX ES3 lint. No After Effects needed; these always run (including on CI, which has no AE).
2. **E2E suites** — talk to a real After Effects through the full transport. They probe for AE first and **self-skip with a visible banner** when it isn't reachable, so a machine without AE gets a clean pass, not failures.
3. **Session-mutating E2E** — tests that modify the open AE session (create/delete comps and layers, import/export). Opt in with `AE_MCP_E2E=1`. Don't run these while real work is open in AE.
4. **Destructive E2E** — the kill/timeout tests that terminate AfterFX processes. Opt in with `AE_MCP_E2E_DESTRUCTIVE=1` and run them standalone, never alongside the other suites or a live AE session you care about.

Keep assertions focused on tool-observable behavior (the JSON a tool returns), not AE internals.

### Fixtures

`fixtures/` contains hand-crafted JSON documents matching the export schema, useful for exercising `ae_project_import_json` without first exporting a real project:

- `fixtures/empty.json` — smallest valid document (no items)
- `fixtures/simple.json` — one folder, one 1920×1080 comp, a text layer plus two AVLayers with position/opacity keyframes, two solid footage items

Every file under `fixtures/` is validated against the schema as part of the offline test suite.

## Coding style

- **TypeScript**: strict ESM (`Node16` resolution — relative imports end in `.js`), oxlint + oxfmt. Prefer `async`/`await`. 2-space indent.
- **ExtendScript**: ES3 as described above, both in `jsx/` and in generated code.
- **Line endings**: LF. `.gitattributes` enforces, lefthook auto-fixes staged files (`scripts/fix-crlf.pl`), CI double-checks. If a commit is blocked, run `git add --renormalize .` or configure `git config --global core.autocrlf input`.
- **Comments**: Describe _why_, not _what_. Don't narrate obvious code.

## Environment variables

| Variable                 | Effect                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `AE_MCP_EXE`             | Path to AE — `AfterFX.exe` on Windows, the `.app` bundle on macOS (overrides the default probe). Legacy: `AE_EXE`. |
| `AE_MCP_ENABLE_EVAL`     | Set to `1` to add `eval.run` (arbitrary ExtendScript) to the operation registry. Off by default.                   |
| `AE_MCP_E2E`             | Set to `1` to enable session-mutating E2E tests.                                                                   |
| `AE_MCP_E2E_DESTRUCTIVE` | Set to `1` to enable the destructive kill-test (run standalone).                                                   |

## Commit / PR flow

- Branch from `main`. One focused change per PR.
- Commit messages: imperative mood, present tense ("Add marker operation" not "Added …"). First line ≤ 72 chars. Body optional.
- Keep the PR description tight: what changed, why, how it was tested.
- CI must be green before review. If you can't run E2E locally (no After Effects), say so in the PR — reviewers will help verify on a real instance.

## Release flow (maintainers)

1. Land the release notes under a `## [Unreleased]` heading in `CHANGELOG.md` (Keep a Changelog subsections: Added / Changed / Fixed / Security).
2. `npm version <patch|minor|major>` — two scripts run around the bump and stage their output into the version commit:
   - `scripts/release-changelog.mjs` rewrites `## [Unreleased]` to `## [<version>] - <today>` and adds the `[<version>]: …/releases/tag/v<version>` link. It runs first as `preversion --check`, so a missing or empty `[Unreleased]` section aborts the release before anything is bumped.
   - `scripts/sync-server-version.mjs` syncs `server.json` to the new version.
3. Push the commit and the `v*` tag.
4. The `release.yml` workflow re-runs the full check + test gate, then publishes to npm (Trusted Publishing via OIDC), the MCP Registry (`mcp-publisher`), and mirrors to GitHub Packages, plus creates the GitHub Release. Every publish step is idempotent — re-running a partially failed release is safe.

The workflow refuses to publish if the tag, `package.json`, and `server.json` versions disagree, so never edit versions by hand.

## Reporting issues / feature requests

Use the GitHub issue templates. Please include:

- After Effects version (Help → About)
- OS and Node.js version
- MCP client (Claude Desktop / Claude Code / other) and its version
- The exact tool call that failed, and the dispatcher log (`dispatcher.log` in the mailbox — the server prints its path to stderr at startup)

## License

By contributing you agree that your contributions are licensed under the MIT license of this project.
