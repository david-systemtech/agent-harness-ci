import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import type { ManualClock } from "../../test/clock.js";
import { bubblewrapProbe } from "../../test/containment.js";
import { startFakeOpenBao, type FakeOpenBao } from "../../test/fake-openbao.js";
import { latestNoticed, startFakeReleaseSources } from "../../test/fake-release-sources.js";
import { fakeToolPath } from "../../test/fake-tools.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import {
  PERSON_TOKEN,
  ROLE_ID,
  SECRET_ID,
  added,
  approle,
  list,
  setBasePath,
  setInjected,
  setPolicies,
  token,
  update,
  verify,
  type AddParams,
} from "../../test/key-manager-connections.js";
import { create } from "../../test/sessions.js";
import { updateSettings } from "../../test/shelf.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";
import type { InjectionDecision } from "../adapter/process-environment.js";

/**
 * The orientation block's key managers section and the standing rule
 * (key-managers spec, "The orientation block"; ADR 0011, ADR 0028; #381)
 * through the primary seam: an in-process environment beside the fake
 * OpenBao on the manual clock, fake CLIs on the PATH the Managed tools
 * registry reads, the injection setting at each level, and the scripted
 * fake adapter reporting the instructions each run was handed and each
 * process was spawned with. What is asserted is the text a run is handed
 * and which process serves it.
 */

const { onCleanup, tempDir } = useCleanups();

/** The fakes are `#!/bin/sh` scripts on a colon-joined PATH: POSIX only, as the Managed tools suites are. */
const posix = describe.runIf(process.platform !== "win32");

/**
 * The fake's policies: `reader` reads under `personal/` and the texts of
 * every policy, `writer` writes there, `minter` mints run tokens; `default`
 * grants its own lookup alone.
 */
const POLICIES = {
  default: `path "auth/token/lookup-self" { capabilities = ["read"] }`,
  reader: `path "personal/*" { capabilities = ["read", "list"] }
path "sys/policies/acl/*" { capabilities = ["read"] }`,
  writer: `path "personal/*" { capabilities = ["create", "read", "update", "list"] }`,
  minter: `path "auth/token/create" { capabilities = ["update"] }`,
};

/**
 * An environment whose login shell answers a fake PATH holding the CLIs
 * `cli` names, each printing its version line, beside a fake OpenBao on its
 * clock whose AppRole signs the test's credential in with every policy.
 */
const withOpenBao = async (options: TestEnvironmentOptions = {}, cli: Partial<Record<"bao" | "vault", string>> = {}) => {
  const path = fakeToolPath(realpathSync(tempDir()));
  for (const [name, output] of Object.entries(cli)) path.install(name, { output });
  const t = await startTestEnvironment({ ...options, managedTools: { readPath: async () => path.path(), ...options.managedTools } });
  onCleanup(() => t.close());
  const bao = await fakeOpenBao(t.clock);
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "reader", "writer", "minter"], ttlSeconds: 7200 });
  return { t, bao, path, client: await t.client() };
};

const fakeOpenBao = async (clock: ManualClock): Promise<FakeOpenBao> => {
  const bao = await startFakeOpenBao({ now: () => clock.now() });
  onCleanup(() => bao.close());
  for (const [name, text] of Object.entries(POLICIES)) bao.policy(name, text);
  return bao;
};

/** A connection signed in by AppRole on `bao` with its CA pinned, and verified, so its policies and whether it can mint are known. */
const connected = async (client: WireClient, bao: FakeOpenBao, params: Partial<AddParams> = {}) => {
  const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle(), ...params });
  await verify(client, connection.id);
  return connection;
};

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session, waits for its end, and answers the instructions it was handed. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<string> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1), { timeout: WAIT_MS });
  return t.adapter.lastRun().input.instructions;
};

/** The key managers section's paragraphs, from its heading to the next section's or the end. */
const keyManagersOf = (text: string): string[] => {
  const start = text.indexOf("## Key managers\n\n");
  if (start === -1) throw new Error(`No key managers section in:\n${text}`);
  const rest = text.slice(start + "## Key managers\n\n".length);
  const next = rest.indexOf("\n\n## ");
  return (next === -1 ? rest : rest.slice(0, next)).split("\n\n");
};

/** The items of the list the section heads `heading`. */
const listIn = (paragraphs: readonly string[], heading: string): string[] => {
  const list = paragraphs.find((paragraph) => paragraph.startsWith(`${heading}\n`));
  if (list === undefined) throw new Error(`No list is headed ${heading} in:\n${paragraphs.join("\n\n")}`);
  return list
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/^- /, ""));
};

const CONNECTED = "Key managers connected here:";

const MINUTE = 60_000;

/** How many times the fake OpenBao has looked a token up: once per sign-in and once per verification. */
const lookups = (bao: FakeOpenBao): number => bao.requests.filter((request) => request.path === "auth/token/lookup-self").length;

/** The OpenBao block's names, in both families, as the spec lists them. */
const BLOCK_NAMES = ["BAO_", "VAULT_"].flatMap((family) =>
  [
    "ADDR",
    "TOKEN",
    "CACERT_BYTES",
    "CACERT",
    "CAPATH",
    "CLIENT_CERT",
    "CLIENT_KEY",
    "NAMESPACE",
    "TOKEN_PATH",
    "HTTP_PROXY",
    "PROXY_ADDR",
    "SKIP_VERIFY",
    "MAX_RETRIES",
    "CLI_NO_COLOR",
    "CONFIG_PATH",
  ].map((name) => `${family}${name}`),
);

/** `tools.list`, with a refresh when asked: its answer waits for the probe it starts or finds under way. */
const tools = (client: WireClient, refresh?: boolean) => client.request("tools.list", refresh === undefined ? {} : { refresh });

posix("the key managers section", () => {
  it("lists each connection with its provider, label and address, whether its CA is pinned and the base path where the harness keeps its secrets; the injecting one is injected, every other used for references", async () => {
    const { t, bao, client } = await withOpenBao();
    const home = await connected(client, bao, { label: "Home" });
    expect((await setBasePath(client, home.id, "personal/harness")).receipt).toMatchObject({ status: "accepted" });
    await added(client, { label: "Work", address: "https://vault.work.example:8200", method: "approle" });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(listIn(keyManagersOf(text), CONNECTED)).toEqual([
      `Home: OpenBao at ${bao.address}, its CA pinned; the harness keeps its secrets under personal/harness; injected into this run.`,
      "Work: OpenBao at https://vault.work.example:8200, trusting the system's CAs; no base path is set for the harness's secrets yet; used by the harness for references, not injected.",
    ]);
  });

  it("gives the injecting connection's status with when it last changed, the variables set by name, its ticked policies, and its CLI with the installed version against the minimum, never whether a newer one exists", async () => {
    const { t, bao, client } = await withOpenBao({}, { bao: "bao version 2.6.3", vault: "Vault v1.13.0 ('fake'), built 2026-01-01" });
    await tools(client);
    await connected(client, bao, { label: "Home" });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    const paragraphs = keyManagersOf(text);
    expect(paragraphs.slice(1, 5)).toEqual([
      "Home, injected into this run: signed in, verified every fifteen minutes; unchanged since 2026-09-24 00:00 UTC.",
      `Its variables, names only: ${BLOCK_NAMES.join(", ")}.`,
      "Policies ticked for its run tokens: default (does not write), reader (does not write), writer (writes) and minter (does not write).",
      "Its CLI (bao or vault): bao 2.6.3, which meets the minimum 2.1.1; vault 1.13.0, below the minimum 1.14.0.",
    ]);
    expect(text).not.toMatch(/newer|latest|update/i);
  });

  it("is byte-identical across verifications that find nothing new, so the session's process is reused; a changed status is stated with when it began, and the next run gets a fresh process", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.token(PERSON_TOKEN, { policies: ["default", "reader", "minter"], ttlSeconds: 1800 });
    const home = await connected(client, bao, { label: "Home", credential: token() });
    const session = await create(client);
    const first = await runTo(t, client, session.id);

    // The scheduled verification at 00:15, then one asked for at 00:16: neither finds anything new.
    t.clock.advance(15 * MINUTE);
    await vi.waitFor(() => expect(lookups(bao)).toBe(2), { timeout: WAIT_MS });
    t.clock.advance(MINUTE);
    await verify(client, home.id);
    const second = await runTo(t, client, session.id, "After the verifications");
    // At 00:31 the token has lived out its half hour.
    t.clock.advance(15 * MINUTE);
    await verify(client, home.id);
    const third = await runTo(t, client, session.id, "After the expiry");

    expect(second).toBe(first);
    expect(keyManagersOf(first)[1]).toBe("Home, injected into this run: signed in, verified every fifteen minutes; unchanged since 2026-09-24 00:00 UTC.");
    expect(second).not.toMatch(/00:1[56]/);
    expect(keyManagersOf(third)[1]).toBe("Home, injected into this run: expired since 2026-09-24 00:31 UTC, sign in again; runs get no token from it until then.");
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([first, third]);
  });

  it("states a changed CLI version once a probe finds it, and the next run gets a fresh process", async () => {
    const { t, bao, path, client } = await withOpenBao({}, { bao: "bao version 2.0.0" });
    await tools(client);
    await connected(client, bao, { label: "Home" });
    const session = await create(client);
    const below = await runTo(t, client, session.id);

    path.install("bao", { output: "bao version 2.6.3" });
    t.clock.advance(15 * MINUTE);
    await tools(client, true);
    const meets = await runTo(t, client, session.id, "After the update");

    expect(keyManagersOf(below)).toContain("Its CLI (bao or vault): bao 2.0.0, below the minimum 2.1.1; vault is not installed.");
    expect(keyManagersOf(meets)).toContain("Its CLI (bao or vault): bao 2.6.3, which meets the minimum 2.1.1; vault is not installed.");
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([below, meets]);
  });

  it("is byte-identical once a newer CLI release is known, its row update-available, so the session's process is reused", async () => {
    const released = await startFakeReleaseSources();
    onCleanup(() => released.close());
    released.github("openbao/openbao", ["v2.7.0"]);
    const { t, bao, client } = await withOpenBao({ managedTools: { releaseOrigins: released.origins } }, { bao: "bao version 2.6.3" });
    await tools(client);
    await connected(client, bao, { label: "Home" });
    const session = await create(client);
    const before = await runTo(t, client, session.id);

    const from = t.env.log.head();
    await tools(client, true);
    expect(await latestNoticed(client, from, "bao")).toMatchObject([{ tool: "bao", version: "2.6.3", latest: "2.7.0", status: "update-available" }]);
    const after = await runTo(t, client, session.id, "After the release");

    expect(after).toBe(before);
    expect(keyManagersOf(after)).toContain("Its CLI (bao or vault): bao 2.6.3, which meets the minimum 2.1.1; vault is not installed.");
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([before]);
  });

  it("tells a run given Bitwarden to pass bws the block's configuration file through --config-file, which bws below 0.5.0 reads from no variable, and no server URL, which would bypass its profile and state folder", async () => {
    const { t, client } = await withOpenBao();
    const bitwarden = await added(client, { provider: "bitwarden", label: "Bitwarden", address: "https://bitwarden.example.test" });
    expect((await setInjected(client, bitwarden.id)).receipt).toMatchObject({ status: "accepted" });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(keyManagersOf(text).slice(2, 5)).toEqual([
      "Its variables, names only: BWS_ACCESS_TOKEN, BWS_CONFIG_FILE, BWS_PROFILE.",
      'Run bws as bws --config-file "$BWS_CONFIG_FILE" <command>, never with --server-url: below 0.5.0 bws reads its configuration file from that option alone, else this host\'s ~/.bws/config, and that file\'s profile names the server and keeps bws\'s state in this run\'s own folder, where a server URL would keep it in this host\'s ~/.bws/state.',
      "Its CLI: bws is not installed.",
    ]);
  });

  it("never holds a credential, a login or run token, or the pinned CA", async () => {
    const { t, bao, client } = await withOpenBao();
    await connected(client, bao, { label: "Home" });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    const supplied = await t.adapter.processesOf(session.id).at(-1)?.supplied;
    const runToken = supplied?.["BAO_TOKEN"] ?? "";
    expect(runToken).not.toBe("");
    expect(bao.minted.length).toBeGreaterThan(0);
    for (const value of [ROLE_ID, SECRET_ID, runToken, ...bao.minted, bao.ca, bao.ca.split("\n")[1] ?? "BEGIN"]) expect(text).not.toContain(value);
  });
});

/** The standing rule's three forms, verbatim (ADR 0011; key-managers spec, "The orientation block"). */
const RULE =
  "Before saying you have no key or token, check the key manager above. When you are given a key, save it into the key manager under this project's folder, never into a file. Never print a secret's value.";
const READ_ONLY =
  "Before saying you have no key or token, check the key manager above. When you are given a key, ask the user to save it into the key manager; your token here is read-only; never write it into a file. Never print a secret's value.";
const NONE = "No key manager is connected here; ask the user for a credential rather than searching files for one.";

posix("the standing rule", () => {

  it("ends the section verbatim; once every ticked policy is known not to write its second sentence says the token is read-only, and the next run gets a fresh process", async () => {
    const { t, bao, client } = await withOpenBao();
    const home = await connected(client, bao, { label: "Home" });
    const session = await create(client);

    const writing = await runTo(t, client, session.id);
    expect((await setPolicies(client, home.id, ["default", "reader", "minter"])).receipt).toMatchObject({ status: "accepted" });
    const readOnly = await runTo(t, client, session.id, "Read-only now");

    expect(keyManagersOf(writing).at(-1)).toBe(RULE);
    expect(keyManagersOf(readOnly).at(-1)).toBe(READ_ONLY);
    expect(keyManagersOf(readOnly)).toContain("Policies ticked for its run tokens: default (does not write), reader (does not write) and minter (does not write).");
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([writing, readOnly]);
  });

  it("reads the default policy every run token holds beside the ticks: none ticked is read-only while default writes nothing, and a default that writes keeps the first form", async () => {
    const { t, bao, client } = await withOpenBao();
    const home = await connected(client, bao, { label: "Home" });
    expect((await setPolicies(client, home.id, [])).receipt).toMatchObject({ status: "accepted" });
    const session = await create(client);

    const quiet = await runTo(t, client, session.id);
    bao.policy("default", `path "personal/*" { capabilities = ["create", "update"] }`);
    await verify(client, home.id);
    const writing = await runTo(t, client, session.id, "Default writes now");

    expect(keyManagersOf(quiet)).toContain("Policies ticked for its run tokens: none, beside default (does not write), which every run token holds.");
    expect(keyManagersOf(quiet).at(-1)).toBe(READ_ONLY);
    expect(keyManagersOf(writing)).toContain("Policies ticked for its run tokens: none, beside default (writes), which every run token holds.");
    expect(keyManagersOf(writing).at(-1)).toBe(RULE);
  });

  it("keeps its first form while a ticked policy only may write, its text unread", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.policy("reader", `path "personal/*" { capabilities = ["read", "list"] }`);
    const home = await connected(client, bao, { label: "Home" });
    expect((await setPolicies(client, home.id, ["default", "reader"])).receipt).toMatchObject({ status: "accepted" });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(keyManagersOf(text)).toContain("Policies ticked for its run tokens: default (may write) and reader (may write).");
    expect(keyManagersOf(text).at(-1)).toBe(RULE);
  });

  it("with no connection is the section's one line, and a connection added gives the next run a fresh process", async () => {
    const { t, bao, client } = await withOpenBao();
    const session = await create(client);

    const none = await runTo(t, client, session.id);
    await connected(client, bao, { label: "Home" });
    const one = await runTo(t, client, session.id, "One connected");

    expect(keyManagersOf(none)).toEqual([NONE]);
    expect(keyManagersOf(one).at(-1)).toBe(RULE);
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([none, one]);
  });
});

posix("why a run has no token", () => {
  it("says of a login that cannot mint that runs get no token from it, and the capability it lacks, at the token role's path when it has one", async () => {
    const { t, bao, client } = await withOpenBao();
    bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "reader"], ttlSeconds: 7200 });
    const home = await connected(client, bao, { label: "Home" });
    expect((await list(client))[0]?.canMint).toBe(false);
    const session = await create(client);

    const withoutRole = await runTo(t, client, session.id);
    expect((await update(client, { connectionId: home.id, tokenRole: "runs" })).receipt).toMatchObject({ status: "accepted" });
    await verify(client, home.id);
    const withRole = await runTo(t, client, session.id, "With a token role");

    expect(keyManagersOf(withoutRole).slice(1, 3)).toEqual([
      "Home, injected into this run: signed in, verified every fifteen minutes; unchanged since 2026-09-24 00:00 UTC.",
      "Runs get no token from it: its login cannot mint one, lacking update on auth/token/create, so BAO_TOKEN and VAULT_TOKEN are empty.",
    ]);
    expect(keyManagersOf(withRole)[2]).toBe("Runs get no token from it: its login cannot mint one, lacking update on auth/token/create/runs, so BAO_TOKEN and VAULT_TOKEN are empty.");
    // Every tick is known not to write, but the run has no token to be read-only: the rule keeps its first form.
    expect(keyManagersOf(withoutRole)).toContain("Policies ticked for its run tokens: default (does not write) and reader (does not write).");
    expect(keyManagersOf(withoutRole).at(-1)).toBe(RULE);
  });

  it("says of a connection still signing in that a run spawned now gets no token from it, and once signed in the next run gets a fresh process", async () => {
    const dataDir = join(tempDir(), "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const before = await withOpenBao({ dataDir });
    await connected(before.client, before.bao, { label: "Home" });
    await before.t.close();
    let answer = (): void => undefined;
    before.bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "reader", "minter"], ttlSeconds: 7200, after: new Promise<void>((resolve) => (answer = resolve)) });
    onCleanup(() => answer());
    // This test releases sign-in after startup, while the start pass is still checking it.
    const t = await startTestEnvironment({ dataDir, awaitSetupStartPass: false, managedTools: { readPath: async () => before.path.path() } });
    onCleanup(() => t.close());
    const client = await t.client();
    expect((await list(client))[0]?.status.kind).toBe("signing-in");
    const session = await create(client);

    const signingIn = await runTo(t, client, session.id);
    answer();
    await vi.waitFor(async () => expect((await list(client))[0]?.status.kind).toBe("signed-in"), { timeout: WAIT_MS });
    const signedIn = await runTo(t, client, session.id, "Signed in now");

    expect(keyManagersOf(signingIn)[1]).toBe(
      "Home, injected into this run: signing in since 2026-09-24 00:00 UTC; a run spawned now gets no token from it unless the sign-in ends within five seconds.",
    );
    expect(keyManagersOf(signedIn)[1]).toBe("Home, injected into this run: signed in, verified every fifteen minutes; unchanged since 2026-09-24 00:00 UTC.");
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([signingIn, signedIn]);
  });

  it("at workspace-no-network says each injected key manager is unreachable from this run in place of what it is given", async () => {
    const { t, bao, client } = await withOpenBao({ containment: bubblewrapProbe() });
    await connected(client, bao, { label: "Home" });
    const session = await create(client, { workspace: { kind: "directory", path: realpathSync(tempDir("agent-harness-workspace-")) } });
    const set = await client.request("permissions.containment.set", { commandId: randomUUID(), sessionId: session.id, level: "workspace-no-network" });
    expect(set.receipt).toMatchObject({ status: "accepted" });

    const text = await runTo(t, client, session.id);

    expect(keyManagersOf(text).slice(0, 2)).toEqual([
      `${CONNECTED}\n- Home: OpenBao at ${bao.address}, its CA pinned; no base path is set for the harness's secrets yet; injected into this run.`,
      "Home is injected into this run but unreachable from it: this run's containment, workspace-no-network, lets its commands reach no host.",
    ]);
    for (const withheld of ["BAO_", "Policies ticked", "Its CLI", "signed in"]) expect(keyManagersOf(text).join("\n\n")).not.toContain(withheld);
  });

  it("says a run is given no key-manager variables or token while no connection injects", async () => {
    const { t, client } = await withOpenBao();
    await added(client, { label: "Work", address: "https://vault.work.example:8200", method: "approle" });
    const session = await create(client);

    const text = await runTo(t, client, session.id);

    expect(keyManagersOf(text)[1]).toBe("No key manager is injected into this run: it is given no key-manager variables or token.");
  });
});

posix("a run denied injection", () => {
  const DENIED = "This run is given no key-manager variables or token: credential injection is denied for it by";

  it("keeps every connection's line as used for references, and says in one line who denied it: this environment's setting, then the account by id; allowed after, the next run gets the injected lines in a fresh process", async () => {
    const { t, bao, client } = await withOpenBao();
    await connected(client, bao, { label: "Home" });
    const session = await create(client);

    expect((await updateSettings(client, { "credentials.injection": "deny" })).receipt).toMatchObject({ status: "accepted" });
    const byEnvironment = await runTo(t, client, session.id);
    expect((await updateSettings(client, { "credentials.injection": "allow", "credentials.injectionByAccount": { "claude-max": "deny" } })).receipt).toMatchObject({
      status: "accepted",
    });
    const byAccount = await runTo(t, client, session.id, "Denied by the account");
    expect((await updateSettings(client, { "credentials.injectionByAccount": {} })).receipt).toMatchObject({ status: "accepted" });
    const allowed = await runTo(t, client, session.id, "Allowed now");

    const home = `Home: OpenBao at ${bao.address}, its CA pinned; no base path is set for the harness's secrets yet;`;
    expect(keyManagersOf(byEnvironment).slice(0, 2)).toEqual([`${CONNECTED}\n- ${home} used by the harness for references, not injected.`, `${DENIED} this environment's setting.`]);
    expect(keyManagersOf(byAccount).slice(0, 2)).toEqual([`${CONNECTED}\n- ${home} used by the harness for references, not injected.`, `${DENIED} the account claude-max.`]);
    for (const denied of [byEnvironment, byAccount]) for (const withheld of ["injected into this run", "BAO_", "Policies ticked", "Its CLI"]) expect(denied).not.toContain(withheld);
    expect(keyManagersOf(allowed).slice(0, 2)).toEqual([
      `${CONNECTED}\n- ${home} injected into this run.`,
      "Home, injected into this run: signed in, verified every fifteen minutes; unchanged since 2026-09-24 00:00 UTC.",
    ]);
    expect(allowed).not.toContain(DENIED);
    expect(t.adapter.processesOf(session.id).map((process) => process.instructions)).toEqual([byEnvironment, byAccount, allowed]);
  });

  it("names the routine or bot that denied it by id", async () => {
    const routine = "c0ffee00-0000-4000-8000-00000000000a";
    const bot = "c0ffee00-0000-4000-8000-00000000000b";
    let level: InjectionDecision["level"] = { kind: "routine", id: routine };
    const { t, bao, client } = await withOpenBao({ adapterSeams: { injection: () => ({ answer: "deny", level }) } });
    await connected(client, bao, { label: "Home" });
    const session = await create(client);

    const byRoutine = await runTo(t, client, session.id);
    level = { kind: "bot", id: bot };
    const byBot = await runTo(t, client, session.id, "Denied by the bot");

    expect(keyManagersOf(byRoutine)[1]).toBe(`${DENIED} the routine ${routine}.`);
    expect(keyManagersOf(byBot)[1]).toBe(`${DENIED} the bot ${bot}.`);
  });
});
