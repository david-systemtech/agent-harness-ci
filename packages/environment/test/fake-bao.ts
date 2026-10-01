import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A fake `bao` on a PATH the test sets (key-managers spec, "Testing
 * Decisions"; #368): `bao version` prints a version; any other command
 * prints, as one line of JSON, every `BAO_` and `VAULT_` variable it was
 * run with, by name and the SHA-256 of its value (never the value), and
 * exits 0. A shell script running a CommonJS script under this test's own
 * Node, so it runs from any directory with any PATH.
 */

/** The version `bao version` prints. */
export const FAKE_BAO_VERSION = "OpenBao v2.6.3 (fake for tests)";

/** Puts a fake `bao` in `directory`, and answers its path. */
export const installFakeBao = (directory: string): string => {
  mkdirSync(directory, { recursive: true });
  const script = join(directory, "bao.cjs");
  writeFileSync(
    script,
    `const { createHash } = require("node:crypto");
if (process.argv[2] === "version" || process.argv[2] === "--version") {
  console.log(${JSON.stringify(FAKE_BAO_VERSION)});
  process.exit(0);
}
const seen = {};
for (const [name, value] of Object.entries(process.env)) if (/^(BAO|VAULT)_/.test(name)) seen[name] = createHash("sha256").update(value ?? "").digest("hex");
console.log(JSON.stringify(seen));
`,
  );
  const bao = join(directory, "bao");
  writeFileSync(bao, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(bao, 0o755);
  return bao;
};

/** The hash the fake `bao` reports a value by. */
export const baoHash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** What the fake `bao` printed: each variable it saw by name, with its value's hash. */
export const baoSaw = (stdout: string): Record<string, string> => JSON.parse(stdout.trim()) as Record<string, string>;

/** What a fake OpenBao CLI saw on one call: its arguments, every `BAO_` and `VAULT_` variable by name with its value's hash, and the token its client held. */
export interface FakeOpenBaoCliCall {
  readonly argv: readonly string[];
  readonly saw: Readonly<Record<string, string>>;
  /** The hash of the token a command that asks the key manager held, which it sends; null for none; absent for one that asks nothing (`--version`). */
  readonly token?: string | null;
}

export interface FakeOpenBaoCli {
  /** The executable, on the PATH the test gives the environment. */
  readonly path: string;
  /** Every call so far, in order. */
  calls(): FakeOpenBaoCliCall[];
  /** From the next call on, a lookup the key manager refuses lists the token it was given among its error lines, as an error echoing a secret would; one that cannot reach it does not. */
  leakTokenOnRefusal(): void;
}

/** What the fake OpenBao CLI runs: `bao` or `vault` speaking to the key manager its variables name, as the real ones do. */
const OPENBAO_CLI = String.raw`
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { userInfo } from "node:os";
import { join, resolve as absolute } from "node:path";

const [name, calls, leaks, ...argv] = process.argv.slice(2);
const families = name === "bao" ? ["BAO_", "VAULT_"] : ["VAULT_"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const saw = {};
for (const [variable, value] of Object.entries(process.env)) if (/^(BAO|VAULT)_/.test(variable)) saw[variable] = hash(value ?? "");
const record = (fields) => appendFileSync(calls, JSON.stringify({ argv, saw, ...fields }) + "\n");

// A variable as the CLI reads it: bao its own family before vault's, and an empty value as none.
const read = (suffix) => {
  for (const family of families) {
    const value = process.env[family + suffix];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
};
// Written, then left to end with the code once the write has flushed: process.exit could cut a pipe's pending write short.
const exit = (stream, text, code) => {
  stream.write(text);
  process.exitCode = code;
};

// The token a command's client is built with, as the real CLIs build it (#716): the TOKEN variable, else what the token helper answers
// to get. That is the helper the configuration names (CONFIG_PATH, else ~/.vault), which must exist and is run through the shell as
// "<path> get", its path unquoted; else the internal one, which reads ~/.vault-token (bao's TOKEN_PATH, which the block empties, aside).
// Answers the token, or the line the CLI fails with.
const clientToken = () => {
  const given = read("TOKEN");
  if (given !== undefined) return { token: given };
  const home = process.env.HOME ?? "";
  const configuration = read("CONFIG_PATH") ?? join(home, ".vault");
  const quoted = existsSync(configuration) ? /^\s*token_helper\s*=\s*("(?:[^"\\]|\\.)*")/m.exec(readFileSync(configuration, "utf8"))?.[1] : undefined;
  if (quoted !== undefined) {
    const helper = JSON.parse(quoted);
    if (!existsSync(helper)) return { error: "failed to get token helper: unknown error getting the external helper path" };
    try {
      return { token: execFileSync(process.env.SHELL || "/bin/sh", ["-c", helper + " get"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
    } catch (error) {
      return { error: "failed to get token from token helper: " + JSON.stringify(String(error.stderr ?? "")) + ": exit status " + error.status };
    }
  }
  // Never a real machine's token: the internal helper is modelled only under a HOME a test made.
  if (home === "" || absolute(home) === userInfo().homedir) return { error: "The fake " + name + " reads no ~/.vault-token outside a HOME a test made." };
  const file = join(home, ".vault-token");
  return { token: existsSync(file) ? readFileSync(file, "utf8").trim() : "" };
};

const address = read("ADDR") ?? "https://127.0.0.1:8200";
let token = "";
const ca = read("CACERT_BYTES");
const call = (path, withToken) =>
  new Promise((resolve) => {
    const url = new URL("/v1/" + path, address);
    const options = { method: "GET", agent: false, headers: withToken && token !== "" ? { "X-Vault-Token": token } : {}, ...(ca !== undefined && { ca }) };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ url, status: response.statusCode, body: body === "" ? {} : JSON.parse(body) }));
    });
    request.on("error", (error) => resolve({ url, error }));
    request.end();
  });

const main = async () => {
  const lookup = argv[0] === "token" && argv[1] === "lookup";
  if (!lookup && argv[0] !== "status") {
    record({});
    if (argv[0] === "--version" || argv[0] === "version") return exit(process.stdout, name === "bao" ? "OpenBao v2.6.3 (fake for tests)\n" : "Vault v1.15.0 ('fake for tests'), built 2026-01-01T00:00:00Z\n", 0);
    return exit(process.stderr, "Usage: " + name + " <command> [args]\n", 1);
  }
  const client = clientToken();
  record({ token: client.token === undefined || client.token === "" ? null : hash(client.token) });
  if (client.error !== undefined) return exit(process.stderr, client.error + "\n", 2);
  token = client.token;

  if (lookup) {
    const answer = await call("auth/token/lookup-self", true);
    if (answer.error !== undefined) return exit(process.stderr, "Error looking up token: Get \"" + answer.url + "\": " + answer.error.message + "\n", 2);
    if (answer.status !== 200) {
      const errors = [...(answer.body.errors ?? []), ...(existsSync(leaks) ? ["the token was " + token] : [])];
      return exit(process.stderr, "Error looking up token: Error making API request.\n\nURL: GET " + answer.url + "\nCode: " + answer.status + ". Errors:\n\n" + errors.map((error) => "* " + error).join("\n") + "\n", 2);
    }
    const data = answer.body.data;
    const rows = [
      ["accessor", data.accessor],
      ["display_name", data.display_name],
      ["id", token],
      ["meta", "map[" + Object.entries(data.meta ?? {}).map(([key, value]) => key + ":" + value).join(" ") + "]"],
      ["policies", "[" + data.policies.join(" ") + "]"],
      ["renewable", String(data.renewable)],
      ["ttl", data.ttl + "s"],
      ["type", data.type],
    ];
    return exit(process.stdout, ["Key                 Value", "---                 -----", ...rows.map(([key, value]) => key.padEnd(20) + value)].join("\n") + "\n", 0);
  }

  const answer = await call("sys/seal-status", false);
  if (answer.error !== undefined) return exit(process.stderr, "Error checking seal status: Get \"" + answer.url + "\": " + answer.error.message + "\n", 1);
  return exit(process.stdout, "Key             Value\n---             -----\nSeal Type       shamir\nInitialized     true\nSealed          " + answer.body.sealed + "\n", answer.body.sealed ? 2 : 0);
};
await main();
`;

/**
 * Puts a fake `bao` or `vault` in `directory` (#375): it answers
 * `--version`, and `token lookup` and `status` by asking the key manager
 * its variables name over HTTP, trusting the PEM in `CACERT_BYTES`, as the
 * real CLIs do, `bao` reading its own family before `vault`'s and `vault`
 * only its own. With an empty token it asks the token helper, as they do
 * (#716): the one its configuration names, run through the shell, else the
 * internal one, which reads `~/.vault-token`, here only under a `HOME` a
 * test made. A lookup prints OpenBao's table, the token's id in it, and
 * exits 0, else prints the API's errors and exits 2; `status` exits 2
 * sealed, 0 unsealed, and 1 when the key manager cannot be reached. Every
 * call is recorded with the variables it saw, each by its value's hash, and
 * the token its client held.
 */
export const installFakeOpenBaoCli = (directory: string, name: "bao" | "vault"): FakeOpenBaoCli => {
  mkdirSync(directory, { recursive: true });
  const program = join(directory, `${name}-cli.mjs`);
  const calls = join(directory, `${name}.calls.jsonl`);
  const leaks = join(directory, `${name}.leaks`);
  writeFileSync(program, OPENBAO_CLI);
  writeFileSync(calls, "");
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${program}' ${name} '${calls}' '${leaks}' "$@"\n`);
  chmodSync(path, 0o755);
  return {
    path,
    calls: () =>
      readFileSync(calls, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as FakeOpenBaoCliCall),
    leakTokenOnRefusal: () => writeFileSync(leaks, ""),
  };
};
