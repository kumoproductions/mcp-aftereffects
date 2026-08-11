# mcp-aftereffects

[![CI](https://github.com/kumoproductions/mcp-aftereffects/actions/workflows/ci.yml/badge.svg)](https://github.com/kumoproductions/mcp-aftereffects/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-informational)](package.json)
[![After Effects](https://img.shields.io/badge/After%20Effects-2024%E2%80%932026-informational)](https://www.adobe.com/products/aftereffects.html)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-informational)](#requirements)

English | [日本語](./README.ja.md)

An MCP server that enables AI to control Adobe After Effects.

You can connect MCP-compatible clients such as Claude Code or Claude Desktop to a running instance of After Effects, allowing the AI to handle everything from project inspection and editing to rendering.

There is no need to provide detailed instructions on how to operate After Effects. Simply explain what you want to achieve in natural language, and the AI will check the project status and perform the necessary operations.

**Windows / macOS · After Effects 2024–2026 · Node.js 24+**

> [!CAUTION]
> **This tool directly manipulates After Effects projects via AI.**
>
> The AI can read project contents and modify compositions, layers, effects, keyframes, and more.
>
> Additionally, information the AI reads from the project may be sent to the AI service you are using. This may include composition names, layer names, expressions, keyframes, footage file paths, etc.
>
> If using this for projects under NDA or unreleased works, please check the data retention policy of the AI service you are using and the logs of your MCP client beforehand.
>
> For first-time use, we recommend trying it with a backup or a test .aep file rather than a critical project.

## Capabilities

With mcp-aftereffects, you can request the AI to perform After Effects tasks.

- Inspect project contents
- Investigate compositions and layers
- Edit layers and properties
- Add or modify keyframes
- Edit effects and masks
- Edit text and shapes
- Set expressions
- Save projects
- Create and restore project backups
- Render frames to preview changes

For example, you can give instructions like these:

> "Import this Illustrator file and create some nice-looking text motion."

> "Apply the revisions mentioned in this PDF."

> "Point out any issues in this AEP."

Even for complex tasks, the AI can combine necessary operations while checking the project status.

## Requirements

- Windows or macOS
- Adobe After Effects 2024 / 2025 / 2026
- Node.js 24 or higher
- MCP-compatible client (Claude Code, Claude Desktop, etc.)

No plugins or panels need to be installed within After Effects.

### After Effects Settings

In After Effects Preferences, please turn ON the following:

**Preferences → Scripting & Expressions → "Allow Scripts to Write Files and Access Network"**

If this setting is OFF, the AI will not be able to perform operations correctly.

### For macOS

Upon first use, macOS may request permission for the client to control After Effects.

If it is not permitted, go to:

**System Settings → Privacy & Security → Automation**

and allow your MCP client or terminal to control After Effects.

## Quick Start

No installation is required on the After Effects side.

First, launch After Effects and open the project you wish to operate on.

Next, register mcp-aftereffects with your MCP client.

### Claude Code

```bash
claude mcp add aftereffects -- npx -y @kumoproductions/mcp-aftereffects
```

### Claude Desktop

Add the following to your MCP configuration file:

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

If you are using other MCP clients, please follow their respective registration methods for MCP servers.

### Read-Only Mode

If you want to inspect or audit project content without making any changes, you can use read-only mode.

Add the following to your MCP client configuration:

```json
{
  "mcpServers": {
    "aftereffects": {
      "command": "npx",
      "args": ["-y", "@kumoproductions/mcp-aftereffects"],
      "env": {
        "AE_MCP_READONLY": "1"
      }
    }
  }
}
```

You can still investigate the project and render frames for preview.

## Advanced Settings

Usually, no configuration is necessary.

In some environments, such as when After Effects is installed in a non-standard location, additional settings may be required.

### Specifying After Effects Location

If After Effects is not in the standard installation path, you can specify the executable location using `AE_MCP_EXE`.

By default, it automatically searches for After Effects in the order of 2026 → 2025 → 2024.

### Limiting Operation Scope

Using `AE_MCP_ALLOW_CATEGORIES`, you can restrict the types of operations permitted for the AI.

For example, you can limit permissions to only keyframe-related operations depending on your use case.

## Execution of Arbitrary ExtendScript

mcp-aftereffects includes an advanced feature to execute arbitrary ExtendScript for processes that cannot be handled by standard operations.

This feature is **disabled by default**.

> [!CAUTION]
> **Enabling arbitrary ExtendScript allows operations outside of After Effects.**
>
> **This may permit actions that affect your entire computer**, such as file or process manipulation.
>
> This feature is disabled by default. Enable it only if necessary.

To enable it, set the following in your MCP server environment variables:

```json
"env": {
  "AE_MCP_ENABLE_EVAL": "1"
}
```

Use this feature only for advanced processing that cannot be achieved through regular operations or when custom ExtendScript is required.

## Official Releases

> [!NOTE]
> **Official releases are distributed only through npm and GitHub Releases.**
>
> Please exercise caution if obtaining packages claiming to be `@kumoproductions/mcp-aftereffects` or files claiming to be this server from any other location.

## Troubleshooting

### Operations Timeout

Please check the following:

- Is After Effects running?
- Is a project open?
- Is "Allow Scripts to Write Files and Access Network" turned ON?
- On macOS, is the Automation permission enabled?

### After Effects Not Found

If you have installed After Effects in a non-standard location, please set `AE_MCP_EXE`.

If the issue persists, please report it via an Issue or to @cumuloworks.

## Developer Information

For information regarding internal MCP tools, communication methods with After Effects, ExtendScript, test environments, and how to add custom operations, please refer to the developer documentation.

- `docs/TOOLS.md`
- `CONTRIBUTING.md`

## Contributing

Bug reports, feature requests, and Pull Requests are welcome.

For information on setting up the development environment and the internal architecture, please refer to `CONTRIBUTING.md`.

## License

MIT © 2026 kumo.productions, Inc.

## Trademark

Adobe® and Adobe After Effects® are trademarks of Adobe Inc.

This project is an independent, unofficial tool and is **not affiliated with or endorsed by Adobe**.
