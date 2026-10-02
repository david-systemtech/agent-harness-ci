import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The bws releases the fake models, from the declared floor; each resolves its configuration, profile and state as that release does. */
export type FakeBwsVersion = "0.3.0" | "0.4.0" | "0.5.0" | "1.0.0" | "2.0.0" | "2.1.0";

/** What one call of the fake bws resolved, as its release would have. */
export interface FakeBwsCall {
  readonly version: FakeBwsVersion;
  readonly argv: string[];
  /** The words left once its options are taken out: the command and its arguments. */
  readonly command: string[];
  /** Every `BWS_` variable it was given. */
  readonly saw: Record<string, string>;
  readonly profile: string | null;
  readonly serverUrl: string | null;
  /** The configuration file it would read and `bws config` would write: `--config-file`'s, from 0.5.0 `BWS_CONFIG_FILE`'s, else `~/.bws/config`. */
  readonly configFile: string;
  /** That file's contents and permission bits, null while it does not exist. */
  readonly config: string | null;
  readonly mode: number | null;
  /** The server its profile names: the server URL given, else the selected profile's `server_base`; null for bws's own default. */
  readonly server: string | null;
  /** The state file it kept, which it wrote: null where its release and profile keep none. */
  readonly stateFile: string | null;
}

/**
 * Fake bws on PATH: never contacts a server. It parses its options as bws
 * 0.3.0 to 2.1.0 do (`crates/bws/src/main.rs` in `bitwarden/sdk-sm` at
 * `bws-v0.3.0` to `bws-v2.1.0`, `Cli`, on clap 4): six global options, each
 * taking a value as `--name value`, `--name=value`, `-x value`, `-xvalue` or
 * `-x=value`, before or after the command; the argument outranks the
 * environment, where the access token, profile and server URL are bound, and
 * the configuration file from 0.5.0, an empty variable counting as given.
 * Without a file it is `~/.bws/config`.
 *
 * Then it resolves what its release resolves (`get_config_profile`,
 * `config.rs`, `state.rs`): a server URL makes the profile from itself alone
 * and reads no configuration; else the configuration is read, the file given
 * required to exist and to hold a `profiles` table, and the profile named is
 * taken, required to exist, or with none named the access token id's, else
 * `default`. Its state file: none at 0.3; at 0.4 and 0.5 the profile's
 * `state_file_dir` alone; from 1.0.0 none when the profile's `state_opt_out`
 * is true, else the profile's `state_dir`, else `$HOME/.bws/state`; named
 * after the access token id, its directory made and the file written as a
 * sign-in leaves it. A token not in bws's shape (`<version>.<id>.<secret>:<key>`)
 * is not refused, as bws would: its id is a stand-in, so the suites' plain
 * test token serves. Every call is recorded with what it resolved.
 */
export const installFakeBws = (directory: string, version: FakeBwsVersion = "0.3.0") => {
  mkdirSync(directory, { recursive: true });
  const calls = join(directory, "calls.jsonl");
  const script = join(directory, "bws.cjs");
  writeFileSync(script, `const { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const VERSION = ${JSON.stringify(version)};
const from = (release) => { const [a, b] = [VERSION, release].map((each) => each.split(".").map(Number)); for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("bws " + VERSION); process.exit(0); }
const SHORT = { o: "output", c: "color", t: "access-token", f: "config-file", p: "profile", u: "server-url" };
const BOUND = { "access-token": "BWS_ACCESS_TOKEN", profile: "BWS_PROFILE", "server-url": "BWS_SERVER_URL", ...(from("0.5.0") && { "config-file": "BWS_CONFIG_FILE" }) };
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
// The home directory as dirs-sys finds it on Unix: HOME unless empty, else the user's entry.
const home = process.env.HOME || homedir();
const configFile = given["config-file"] ?? join(home, ".bws", "config");
const exists = existsSync(configFile);
const call = { version: VERSION, argv, command, saw: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("BWS_"))), profile: given.profile ?? null, serverUrl: given["server-url"] ?? null, configFile, config: exists ? readFileSync(configFile, "utf8") : null, mode: exists ? statSync(configFile).mode & 0o777 : null, server: null, stateFile: null };
const record = () => appendFileSync(${JSON.stringify(calls)}, JSON.stringify(call) + "\\n");
const fail = (message) => { record(); console.error("Error: " + message); process.exit(1); };
// The subset of TOML a configuration needs: tables under profiles, string keys. Every Profile field is a string through 2.1.0.
const readProfiles = (text) => {
  const profiles = {};
  let table = null;
  let found = false;
  for (const line of text.split(/\\r?\\n/).map((each) => each.trim())) {
    if (line === "" || line.startsWith("#")) continue;
    if (line === "[profiles]") { found = true; table = null; continue; }
    const header = /^\\[profiles\\.("(?:[^"\\\\]|\\\\.)*"|[A-Za-z0-9_-]+)\\]$/.exec(line);
    if (header !== null) { found = true; const key = header[1].startsWith('"') ? JSON.parse(header[1]) : header[1]; table = profiles[key] ??= {}; continue; }
    const entry = /^([A-Za-z0-9_-]+)\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")$/.exec(line);
    if (table !== null && entry !== null) { table[entry[1]] = JSON.parse(entry[2]); continue; }
    fail("TOML parse error: " + line);
  }
  if (!found) fail("TOML parse error: missing field \`profiles\`");
  return profiles;
};
if (command[0] === "config") { record(); process.exit(0); }
const token = given["access-token"];
if (token === undefined) fail("Missing access token");
const tokenId = /^\\d+\\.([^.]+)\\./.exec(token)?.[1] ?? "access-token-id-for-tests";
let profile = null;
if (given["server-url"] !== undefined) {
  if (!/^https?:\\/\\//.test(given["server-url"])) fail("Server URL must start with http:// or https://, the provided URL is: \`" + given["server-url"] + "\`");
  profile = { server_base: given["server-url"] };
} else {
  if (given["config-file"] !== undefined && !exists) fail("Config file doesn't exist");
  const profiles = exists ? readProfiles(call.config) : {};
  const key = given.profile ?? tokenId;
  if (profiles[key] === undefined && given.profile !== undefined) fail("The specified profile does not exist");
  profile = profiles[key] ?? profiles.default ?? null;
}
call.server = profile?.server_base ?? null;
const optedOut = ["true", "1"].includes(String(profile?.state_opt_out ?? "").trim().toLowerCase());
const stateDirectory = !from("0.4.0") ? null : !from("1.0.0") ? profile?.state_file_dir ?? null : optedOut ? null : profile?.state_dir ?? join(home, ".bws", "state");
if (stateDirectory !== null) {
  try {
    mkdirSync(stateDirectory, { recursive: true });
    call.stateFile = join(stateDirectory, tokenId);
    writeFileSync(call.stateFile, "state-for-tests");
  } catch (error) {
    if (!from("1.0.0")) throw error;
    call.stateFile = null;
    console.error("Warning: " + error.message + "\\nRetrieving the state file failed. Attempting to continue without using state.");
  }
}
record();
console.log(JSON.stringify(command[0] === "project" ? [{ id: "fake-project-for-tests", name: "harness" }] : []));
`);
  const path = join(directory, "bws");
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(path, 0o755);
  return { directory, calls: (): FakeBwsCall[] => readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as FakeBwsCall) };
};
