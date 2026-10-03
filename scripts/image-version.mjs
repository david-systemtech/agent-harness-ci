#!/usr/bin/env node
// Stamp only the build's copied workspace, after pnpm's frozen installs.
// The CLI and environment read their own package manifests at runtime.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const version = process.argv[2];
const number = "(0|[1-9][0-9]*)";
const identifier = "(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)";
if (!version || !new RegExp(`^${number}\\.${number}\\.${number}(-${identifier}(\\.${identifier})*)?$`).test(version)) {
  throw new Error("image version must be a semantic version without build metadata");
}
for (const entry of readdirSync("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join("packages", entry.name, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
}
