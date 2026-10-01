import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What one call of the fake bws resolved, as bws 0.3.0 would have. */
export interface FakeBwsCall {
  readonly argv: string[];
  /** The words left once its options are taken out: the command and its arguments. */
  readonly command: string[];
  /** Every `BWS_` variable it was given. */
  readonly saw: Record<string, string>;
  readonly profile: string | null;
  readonly serverUrl: string | null;
  /** The configuration file it would read and `bws config` would write: `--config-file`'s, else `~/.bws/config`. */
  readonly configFile: string;
  /** That file's contents and permission bits, null while it does not exist. */
  readonly config: string | null;
  readonly mode: number | null;
}

/**
 * Fake bws on PATH: never contacts a server. It parses its options as
 * bws 0.3.0, the declared floor, does (`crates/bws/src/main.rs`, `Cli`, in
 * `bitwarden/sdk-sm` at `bws-v0.3.0`, on clap 4.3): six global options, each
 * taking a value as `--name value`, `--name=value`, `-x value`, `-xvalue` or
 * `-x=value`, before or after the command; the argument outranks the
 * environment, where only the access token, profile and server URL are
 * bound, an empty variable counting as given. The configuration file has no
 * variable at that floor (`BWS_CONFIG_FILE` is bound from 0.5.0), so without
 * `--config-file` it is `~/.bws/config`. Every call is recorded with what it
 * resolved.
 */
export const installFakeBws = (directory: string) => {
  mkdirSync(directory, { recursive: true });
  const calls = join(directory, "calls.jsonl");
  const script = join(directory, "bws.cjs");
  writeFileSync(script, `const { appendFileSync, existsSync, readFileSync, statSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("bws 0.3.0"); process.exit(0); }
const SHORT = { o: "output", c: "color", t: "access-token", f: "config-file", p: "profile", u: "server-url" };
const BOUND = { "access-token": "BWS_ACCESS_TOKEN", profile: "BWS_PROFILE", "server-url": "BWS_SERVER_URL" };
const given = {};
const command = [];
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index];
  if (arg === "--") { command.push(...argv.slice(index + 1)); break; }
  const long = arg.startsWith("--") ? arg.slice(2).split("=")[0] : undefined;
  const name = long !== undefined ? (Object.values(SHORT).includes(long) ? long : undefined) : /^-[^-]/.test(arg) ? SHORT[arg[1]] : undefined;
  if (name === undefined) { command.push(arg); continue; }
  const attached = long !== undefined ? (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined) : arg.length > 2 ? arg.slice(2).replace(/^=/, "") : undefined;
  if (attached === undefined && index + 1 === argv.length) { console.error("error: a value is required for '--" + name + " <" + name.toUpperCase() + ">' but none was supplied"); process.exit(2); }
  given[name] = attached === undefined ? argv[++index] : attached;
}
for (const [name, variable] of Object.entries(BOUND)) if (given[name] === undefined && process.env[variable] !== undefined) given[name] = process.env[variable];
const configFile = given["config-file"] ?? join(process.env.HOME ?? homedir(), ".bws", "config");
const exists = existsSync(configFile);
const saw = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("BWS_")));
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv, command, saw, profile: given.profile ?? null, serverUrl: given["server-url"] ?? null, configFile, config: exists ? readFileSync(configFile, "utf8") : null, mode: exists ? statSync(configFile).mode & 0o777 : null }) + "\\n");
if (given["access-token"] === undefined) { console.error("Error: Missing access token"); process.exit(1); }
console.log(JSON.stringify(command[0] === "project" ? [{ id: "fake-project-for-tests", name: "harness" }] : []));
`);
  const path = join(directory, "bws");
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(path, 0o755);
  return { directory, calls: (): FakeBwsCall[] => readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as FakeBwsCall) };
};
