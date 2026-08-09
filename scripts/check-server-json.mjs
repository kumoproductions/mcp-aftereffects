#!/usr/bin/env node
// Validate server.json against the constraints the MCP Registry enforces at
// publish time. Those checks run inside `mcp-publisher publish`, i.e. after the
// tag is pushed and after npm has already published — too late to fix without
// retagging. Running them in `npm run check` moves the failure to the commit
// that introduced it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const srv = JSON.parse(readFileSync(resolve(root, "server.json"), "utf8"));

const errors = [];

// registry: body.description has `expected length <= 100`
const DESCRIPTION_MAX = 100;
if (!srv.description) {
  errors.push("description is missing");
} else if (srv.description.length > DESCRIPTION_MAX) {
  errors.push(
    `description is ${srv.description.length} chars, max ${DESCRIPTION_MAX}: ${srv.description}`,
  );
}

if (srv.name !== pkg.mcpName) {
  errors.push(`name ${srv.name} != package.json mcpName ${pkg.mcpName}`);
}

// The version triple is what release.yml compares against the git tag; catching
// a drift here means never discovering it mid-release.
if (srv.version !== pkg.version) {
  errors.push(`version ${srv.version} != package.json version ${pkg.version}`);
}

const npmPackage = (srv.packages ?? []).find((p) => p.registryType === "npm");
if (!npmPackage) {
  errors.push("no npm entry in packages[]");
} else {
  if (npmPackage.identifier !== pkg.name) {
    errors.push(
      `packages[npm].identifier ${npmPackage.identifier} != package.json name ${pkg.name}`,
    );
  }
  if (npmPackage.version !== pkg.version) {
    errors.push(
      `packages[npm].version ${npmPackage.version} != package.json version ${pkg.version}`,
    );
  }
}

if (errors.length > 0) {
  console.error("server.json is not publishable:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log("server.json ok");
