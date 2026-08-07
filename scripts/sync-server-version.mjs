#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkgPath = resolve(root, "package.json");
const srvPath = resolve(root, "server.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const srv = JSON.parse(readFileSync(srvPath, "utf8"));
const version = pkg.version;

if (!version) {
  console.error("package.json has no version");
  process.exit(1);
}

srv.version = version;
for (const p of srv.packages ?? []) {
  if (p.identifier === pkg.name) p.version = version;
}

writeFileSync(srvPath, `${JSON.stringify(srv, null, 2)}\n`);
console.log(`server.json synced to ${version}`);
