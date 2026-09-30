import { execFile, spawn } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { DiscoveryDocument, HEALTH_PATH, HealthDocument, PRODUCT_NAME, type PreflightReport } from "@agent-harness/contracts";
import { artefactNode, parsePreflightReport } from "@agent-harness/contracts/launcher";
import { declaredVersion } from "../../src/launch/versions.js";
import { BuildError, type ArtefactTarget } from "./targets.js";

/**
 * The release build's check of the artefact of the platform it runs on
 * (#356): the archive unpacked as a machine unpacks it, into a fresh folder,
 * and run from there with no Node on the path and an empty home. Its
 * `--version`, its `node-pty` and the Claude binary its environment would run
 * resolved inside it, its preflight, and `serve` answering discovery and
 * health until it is stopped, each naming the tag's version. On a runner that
 * builds as root, every command runs as `nobody`, since `serve` refuses root.
 */

/** How long one command may take, and `serve` to be ready and then to stop: generous, since CI's runners are shared and loaded. */
const COMMAND_MS = 120_000;
const READY_MS = 180_000;
const STOP_MS = 60_000;

/** `path` (a PATH) without the folders holding a `node` or `node.exe`, so nothing the artefact runs reaches a Node but its own. */
export const withoutNode = (path: string, exists: (path: string) => boolean = existsSync): string =>
  path
    .split(delimiter)
    .filter((folder) => folder !== "" && !["node", "node.exe"].some((name) => exists(join(folder, name))))
    .join(delimiter);

/** The user the artefact runs as when the build runs as root: `nobody`. */
const NOBODY = { uid: 65534, gid: 65534 };

/** Where `command` is on `path` (a PATH), found as a shell would. */
const onPath = (command: string, path: string): string | undefined =>
  path
    .split(delimiter)
    .map((folder) => join(folder, command))
    .find((candidate) => existsSync(candidate));

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A free loopback port, which `serve` is then given. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(COMMAND_MS) });
  if (!response.ok) throw new BuildError(`${url} answered ${response.status}.`);
  return response.json();
};

/** Unpacks the archive at `archive` of `target`'s artefact and runs it (see the module's comment), answering its preflight report. */
export const verifyArtefact = async (archive: string, target: ArtefactTarget, version: string): Promise<PreflightReport> => {
  if (target.format !== "tar.gz") throw new BuildError(`The build checks its host's artefact on Linux or macOS, not ${target.platform}.`);
  const base = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-check-`));
  chmodSync(base, 0o755);
  const [root, home, data] = ["artefact", "home", "data"].map((name) => join(base, name)) as [string, string, string];
  try {
    mkdirSync(root);
    await new Promise<void>((resolve, reject) =>
      execFile("tar", ["-xf", archive, "-C", root], (error, _stdout, stderr) => (error ? reject(new BuildError(`${archive} did not unpack: ${stderr.trim() || error.message}`)) : resolve())),
    );
    const asRoot = process.getuid?.() === 0;
    for (const own of [home, data]) {
      mkdirSync(own, { mode: 0o700 });
      if (asRoot) chownSync(own, NOBODY.uid, NOBODY.gid);
    }
    const env = { PATH: withoutNode(process.env["PATH"] ?? ""), HOME: home };
    const setpriv = asRoot ? onPath("setpriv", process.env["PATH"] ?? "") : undefined;
    if (asRoot && setpriv === undefined) throw new BuildError("The build runs as root, and setpriv, which runs the artefact as nobody (serve refuses root), is not on the path.");
    const command = (program: string, args: readonly string[]): [string, string[]] =>
      setpriv === undefined ? [program, [...args]] : [setpriv, [`--reuid=${NOBODY.uid}`, `--regid=${NOBODY.gid}`, "--clear-groups", "--", program, ...args]];
    const run = (program: string, args: readonly string[]): Promise<Ran> =>
      new Promise((resolve) => {
        const [file, argv] = command(program, args);
        execFile(file, argv, { env, cwd: base, timeout: COMMAND_MS, encoding: "utf8" }, (error, stdout, stderr) =>
          resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout, stderr }),
        );
      });
    const bin = join(root, "bin", PRODUCT_NAME);
    const said = (ran: Ran) => `exit ${ran.code ?? "by signal"}: ${`${ran.stdout}${ran.stderr}`.trim() || "nothing printed"}`;

    const printed = await run(bin, ["--version"]);
    if (printed.code !== 0 || printed.stdout !== `${PRODUCT_NAME} ${version}\n`) throw new BuildError(`${PRODUCT_NAME} --version did not print ${PRODUCT_NAME} ${version} (${said(printed)}).`);

    // node-pty and the Claude binary, resolved as the environment resolves them, from its own package.
    const resolveInside = `
      const { createRequire } = await import("node:module");
      const { pathToFileURL } = await import("node:url");
      const environment = createRequire(${JSON.stringify(join(root, "node_modules", "@agent-harness", "environment", "package.json"))});
      const { bundledExecutable } = await import(pathToFileURL(environment.resolve("@agent-harness/environment")).href);
      console.log(JSON.stringify({ "node-pty": environment.resolve("node-pty"), "Claude binary": bundledExecutable() }));`;
    const resolved = await run(join(root, ...artefactNode(target.os)), ["--input-type=module", "-e", resolveInside]);
    if (resolved.code !== 0) throw new BuildError(`The artefact's node-pty and Claude binary could not be resolved (${said(resolved)}).`);
    const inside = realpathSync(root) + sep;
    for (const [what, path] of Object.entries(JSON.parse(resolved.stdout) as Record<string, string | null>)) {
      if (path === null || !realpathSync(path).startsWith(inside)) throw new BuildError(`The artefact's ${what} resolves to ${path ?? "nothing"}, outside the artefact.`);
    }

    const preflight = await run(bin, ["preflight"]);
    const report = preflight.code === 0 ? parsePreflightReport(preflight.stdout.trim()) : undefined;
    if (report === undefined) throw new BuildError(`${PRODUCT_NAME} preflight printed no report (${said(preflight)}).`);
    const declared = declaredVersion(root);
    if ("problem" in declared) throw new BuildError(`The artefact declares no version: ${declared.problem}.`);
    if (report.launcherProtocol !== declared.launcherProtocol) {
      throw new BuildError(`The artefact's preflight reports launcher protocol ${report.launcherProtocol}, but its CLI package declares ${declared.launcherProtocol}.`);
    }

    await serveAndStop(command(bin, ["serve", "--data-dir", data, "--port", String(await freePort())]), env, version);
    return report;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

/** Starts `serve` as `command` says, reads its discovery and health once it prints its discovery address, then stops it with SIGTERM and waits for it to exit 0. */
const serveAndStop = async ([file, args]: [string, string[]], env: NodeJS.ProcessEnv, version: string): Promise<void> => {
  const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let [stdout, stderr] = ["", ""];
  child.stderr.on("data", (chunk: Buffer) => void (stderr += chunk.toString()));
  const exited = new Promise<string>((resolve) => child.on("exit", (code, signal) => resolve(code === null ? `by ${signal}` : `with ${code}`)));
  try {
    const discovery = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BuildError(`serve did not print its discovery address within ${READY_MS / 1000} s: ${stderr.trim()}`)), READY_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const address = /^(http:\/\/\S+)$/m.exec(stdout)?.[1];
        if (address !== undefined) {
          clearTimeout(timer);
          resolve(address);
        }
      });
      void exited.then((how) => {
        clearTimeout(timer);
        reject(new BuildError(`serve exited ${how} before it was ready: ${stderr.trim() || stdout.trim()}`));
      });
    });
    const document = DiscoveryDocument.pick({ harnessVersion: true, readiness: true }).parse(await fetchJson(discovery));
    if (document.harnessVersion !== version) throw new BuildError(`serve's discovery document names the version ${document.harnessVersion}, not ${version}.`);
    const health = HealthDocument.parse(await fetchJson(new URL(HEALTH_PATH, discovery).href));
    if (health.version !== version) throw new BuildError(`serve's health answer names the version ${health.version}, not ${version}.`);
    if (document.readiness !== "ready" || health.status !== "ready") throw new BuildError(`serve printed its address but reads ${document.readiness}, health ${health.status}.`);
    child.kill("SIGTERM");
    const stopped = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve("never"), STOP_MS))]);
    if (stopped !== "with 0") throw new BuildError(`serve did not stop cleanly on SIGTERM: it exited ${stopped === "never" ? `not at all within ${STOP_MS / 1000} s` : stopped}.`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
};
