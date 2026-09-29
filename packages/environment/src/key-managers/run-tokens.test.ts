import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import type { ManualClock } from "../../test/clock.js";
import { startFakeOpenBao, type FakeOpenBao } from "../../test/fake-openbao.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ROLE_ID, SECRET_ID, added, approle, list, verify } from "../../test/key-manager-connections.js";
import { create } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The OpenBao block and run tokens (#368; key-managers spec, "Run tokens"
 * and "Injection"; ADR 0011, ADR 0015, ADR 0028) through the primary seam:
 * an in-process environment beside the fake OpenBao on the manual clock,
 * the scripted fake adapter reporting the variables each process was
 * spawned with, and the fake PTY for terminals. What is asserted is what a
 * holder was given, what the fake OpenBao issued and was asked, and what
 * `keyManagers.list` answers; never the registry's own state.
 */

const { onCleanup } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const fakeOpenBao = async (clock: ManualClock): Promise<FakeOpenBao> => {
  const bao = await startFakeOpenBao({ now: () => clock.now() });
  onCleanup(() => bao.close());
  return bao;
};

/** The fake's policies: `reader` reads under `personal/`, `minter` mints run tokens, at the token-create path and the role `runs`'s. */
const POLICIES = {
  reader: `path "personal/*" { capabilities = ["read", "list"] }`,
  minter: `path "auth/token/create" { capabilities = ["update"] }
path "auth/token/create/runs" { capabilities = ["update"] }`,
};

/** An environment beside a fake OpenBao whose AppRole signs the test's role id and secret id in for two hours with default, minter and reader. */
const withOpenBao = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const bao = await fakeOpenBao(t.clock);
  for (const [name, text] of Object.entries(POLICIES)) bao.policy(name, text);
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "minter", "reader"], ttlSeconds: 7200 });
  return { t, bao, client: await t.client() };
};

/** A connection signed in by AppRole on `bao`, with its CA pinned, and verified, so whether it can mint is known. */
const connected = async (client: WireClient, bao: FakeOpenBao) => {
  const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
  await verify(client, connection.id);
  return connection;
};

const ended = (t: TestEnvironment, sessionId: string) => t.env.log.readStream({ kind: "session", id: sessionId }).filter((event) => event.type === "run.ended");

/** Starts a run on the session and waits for its end. */
const runTo = async (t: TestEnvironment, client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<void> => {
  const before = ended(t, sessionId).length;
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text }));
  if (answer.result === undefined) throw new Error(`runs.start was refused: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(ended(t, sessionId)).toHaveLength(before + 1));
};

/** What the session's latest process was spawned with. */
const spawnedWith = async (t: TestEnvironment, sessionId: string): Promise<Readonly<Record<string, string>>> => {
  const process = t.adapter.processesOf(sessionId).at(-1);
  if (process === undefined) throw new Error(`Session ${sessionId} has no process.`);
  return process.supplied;
};

/** The harness-owned empty configuration the block names for both CLIs. */
const configOf = (t: TestEnvironment): string => join(t.env.dataDir, "key-manager-cli", "openbao.hcl");

/** The block's variables in one family, as the spec lists them. */
const family = (prefix: "BAO" | "VAULT", values: { readonly address: string; readonly token: string; readonly ca: string; readonly config: string }): Record<string, string> => ({
  [`${prefix}_ADDR`]: values.address,
  [`${prefix}_TOKEN`]: values.token,
  [`${prefix}_CACERT_BYTES`]: values.ca,
  [`${prefix}_CACERT`]: "",
  [`${prefix}_CAPATH`]: "",
  [`${prefix}_CLIENT_CERT`]: "",
  [`${prefix}_CLIENT_KEY`]: "",
  [`${prefix}_NAMESPACE`]: "",
  [`${prefix}_TOKEN_PATH`]: "",
  [`${prefix}_HTTP_PROXY`]: "",
  [`${prefix}_PROXY_ADDR`]: "",
  [`${prefix}_SKIP_VERIFY`]: "false",
  [`${prefix}_MAX_RETRIES`]: "2",
  [`${prefix}_CLI_NO_COLOR`]: "1",
  [`${prefix}_CONFIG_PATH`]: values.config,
});

/** The whole block, in both families. */
const block = (values: Parameters<typeof family>[1]): Record<string, string> => ({ ...family("BAO", values), ...family("VAULT", values) });

describe("the OpenBao block", () => {
  it("gives a provider process, in both the BAO_ and VAULT_ families, the address, a run token and the pinned CA, every stray variable shadowed and a harness-owned empty configuration, and forces no output format", async () => {
    const { t, bao, client } = await withOpenBao();
    await connected(client, bao);
    const session = await create(client);

    await runTo(t, client, session.id);

    const env = await spawnedWith(t, session.id);
    expect(bao.created).toHaveLength(1);
    expect(env).toEqual(block({ address: bao.address, token: bao.created[0] ?? "", ca: bao.ca, config: configOf(t) }));
    expect(Object.keys(env).filter((name) => name.endsWith("_FORMAT"))).toEqual([]);
    expect(readFileSync(configOf(t), "utf8")).toBe("");
  });
});
