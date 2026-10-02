#!/usr/bin/env node
// A job may supply the large Linux SDK archive. The committed lockfile's
// integrity is the authority; neither the download source nor its filename is.
// Seeding each pinned version: docs/agents/image-sdk-cache.md.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const cache = ".image-sdk-cache";
const archive = `${cache}/sdk.tgz`;

function pin(lock) {
  const match = /^ {2}'@anthropic-ai\/claude-agent-sdk-linux-x64@([^']+)':\n {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/m.exec(lock);
  if (!match) throw new Error("image SDK cache: Linux SDK lockfile pin not found");
  return { version: match[1], integrity: match[2], entry: match[0] };
}

async function verify(file, integrity) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (`sha512-${hash.digest("base64")}` !== integrity) {
    throw new Error("image SDK cache: archive does not match lockfile integrity");
  }
}

async function download() {
  // A reused checkout must never supply an archive left by an earlier pin.
  await rm(cache, { recursive: true, force: true });
  const base = process.env.IMAGE_SDK_CACHE_BASE;
  const token = process.env.FORGEJO_TOKEN;
  if (!base || !token) return;
  try {
    const { version, integrity } = pin(await readFile("pnpm-lock.yaml", "utf8"));
    const url = `${base.replace(/\/$/, "")}/claude-agent-sdk-linux-x64/${version}/claude-agent-sdk-linux-x64-${version}.tgz`;
    await mkdir(cache);
    const partial = `${archive}.part`;
    const response = await globalThis.fetch(url, {
      headers: { Authorization: `token ${token}` },
      redirect: "error", signal: globalThis.AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error("empty response body");
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    await verify(partial, integrity);
    await rename(partial, archive);
    console.error(`image SDK cache: verified lockfile pin ${version}`);
  } catch (error) {
    await rm(cache, { recursive: true, force: true });
    console.error(`image SDK cache: ${error.message}; using npm`);
  }
}

function pnpm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function fetchPackages(args) {
  try { await access(archive); } catch { return pnpm(["fetch", ...args]); }
  const lock = await readFile("pnpm-lock.yaml", "utf8");
  const { version, entry, integrity } = pin(lock);
  await verify(archive, integrity);
  // pnpm rejects file: tarballs behind registry dependency keys. A loopback
  // HTTP tarball preserves that key and populates the same integrity index,
  // so the original workspace can then install from the store offline.
  const file = resolve(archive);
  const server = createServer((_req, res) => {
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  });
  const dir = await mkdtemp(join(tmpdir(), "image-sdk-fetch-"));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/sdk.tgz`;
    const key = `@anthropic-ai/claude-agent-sdk-linux-x64@${version}`;
    const scratchLock = `${lock.slice(0, lock.indexOf("importers:"))}importers:
  .:
    dependencies:
      '@anthropic-ai/claude-agent-sdk-linux-x64':
        specifier: ${version}
        version: ${version}
packages:
${entry.replace(/\}$/, `, tarball: ${url}}`)}
snapshots:
  '${key}': {}
`;
    const { packageManager } = JSON.parse(await readFile("package.json", "utf8"));
    await writeFile(join(dir, "pnpm-lock.yaml"), scratchLock);
    await writeFile(join(dir, "package.json"), JSON.stringify({
      name: "image-sdk-fetch", packageManager,
      dependencies: { "@anthropic-ai/claude-agent-sdk-linux-x64": version },
    }));
    await writeFile(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
    console.error("image SDK cache: importing verified archive; original lockfile unchanged");
    const status = await pnpm(["--dir", dir, "fetch", ...args]);
    if (status !== 0) return status;
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
  return pnpm(["fetch", ...args]);
}

function checkSdk() {
  try {
    const sdk = createRequire(resolve("packages/environment/package.json")).resolve("@anthropic-ai/claude-agent-sdk");
    createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`);
  } catch (error) {
    throw new Error(`image dependencies: required Linux SDK is missing for ${process.arch}: ${error.message}; refusing to build an image without the agent binary`, { cause: error });
  }
}

try {
  if (process.argv[2] === "download") await download();
  else if (process.argv[2] === "fetch") process.exitCode = await fetchPackages(process.argv.slice(3));
  else if (process.argv[2] === "check") checkSdk();
  else throw new Error("usage: image-sdk-cache.mjs download|check|fetch [pnpm fetch options]");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
