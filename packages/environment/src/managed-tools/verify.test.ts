import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ManagedToolRow } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { baoHash, installFakeOpenBaoCli, type FakeOpenBaoCli } from "../../test/fake-bao.js";
import { installFakeGh } from "../../test/fake-gh.js";
import { UNREACHABLE_OPENBAO, startFakeOpenBao, type FakeOpenBao } from "../../test/fake-openbao.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ROLE_ID, SECRET_ID, added, approle, setInjected, verify } from "../../test/key-manager-connections.js";
import { updateSettings } from "../../test/shelf.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Verify commands (#375; key-managers spec, "Managed tools"; ADR 0011, ADR
 * 0026, ADR 0028) through the primary seam: an in-process environment on
 * the manual clock beside the fake OpenBao, with a fake `bao` or `vault` on
 * the PATH its login shell answers, which asks the key manager its
 * variables name as the real CLIs do and reports the variables it saw, and
 * the forge's fake `gh`. What is asserted is what `tools.verify` and
 * `keyManagers.list` answer, what the fake CLIs saw and what the fake
 * OpenBao issued; never the registry's state.
 */

const { onCleanup, tempDir } = useCleanups();

/** The fakes are `#!/bin/sh` scripts on a colon-joined PATH: POSIX only, as the registry's own suite is. */
const posix = describe.runIf(process.platform !== "win32");

/** The fake's policies: `reader` reads under `personal/`, `minter` mints run tokens. */
const POLICIES = {
  reader: `path "personal/*" { capabilities = ["read", "list"] }`,
  minter: `path "auth/token/create" { capabilities = ["update"] }`,
};

/**
 * An environment whose login shell's PATH holds a fake of each CLI named,
 * beside a fake OpenBao on its clock whose AppRole signs the test's role id
 * and secret id in with default, minter and reader.
 */
const withOpenBao = async (clis: readonly ("bao" | "vault")[], options: TestEnvironmentOptions = {}) => {
  const bin = join(realpathSync(tempDir()), "bin");
  mkdirSync(bin);
  const installed: Partial<Record<"bao" | "vault", FakeOpenBaoCli>> = {};
  for (const name of clis) installed[name] = installFakeOpenBaoCli(bin, name);
  const t: TestEnvironment = await startTestEnvironment({ ...options, managedTools: { readPath: async () => bin, ...options.managedTools } });
  onCleanup(() => t.close());
  const bao: FakeOpenBao = await startFakeOpenBao({ now: () => t.clock.now() });
  onCleanup(() => bao.close());
  for (const [name, text] of Object.entries(POLICIES)) bao.policy(name, text);
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "minter", "reader"], ttlSeconds: 7200 });
  return { t, bao, cli: installed, client: await t.client() };
};

/** A connection signed in by AppRole on `bao`, its CA pinned, and verified, so whether it can mint is known. */
const connected = async (client: WireClient, bao: FakeOpenBao) => {
  const connection = await added(client, { address: bao.address, ca: bao.ca, credential: approle() });
  await verify(client, connection.id);
  return connection;
};

const toolRow = async (client: WireClient, tool: string): Promise<ManagedToolRow> => {
  const row = (await client.request("tools.list", {})).tools.find((candidate) => candidate.tool === tool);
  if (row === undefined) throw new Error(`No ${tool} row.`);
  return row;
};

posix("keyManagers.list", () => {
  it("answers each connection with its CLI's row: bao's when bao is installed, vault's when vault alone is, else bao's, not installed", async () => {
    for (const [clis, expected] of [
      [["bao", "vault"], "bao"],
      [["vault"], "vault"],
      [[], "bao"],
    ] as const) {
      const { bao, client } = await withOpenBao(clis);
      await connected(client, bao);
      const [listed] = (await client.request("keyManagers.list", {})).connections;
      expect(listed?.cli, clis.join(" and ")).toEqual(await toolRow(client, expected));
    }
  });

  it("gives a connection with no CLI installed bao's row to install, never vault's", async () => {
    const { bao, client } = await withOpenBao([]);
    await connected(client, bao);
    const [listed] = (await client.request("keyManagers.list", {})).connections;
    expect(listed?.cli).toMatchObject({ tool: "bao", path: null, status: "not-installed", action: "install" });
  });
});

/** Runs the tool's verify command over the wire, as an admin client does. */
const verifyTool = (client: WireClient, tool: "bao" | "vault" | "doppler" | "op" | "bws" | "gh") => client.request("tools.verify", { tool });

/** The variables a fake CLI saw on its last call to `command`, each by its value's hash. */
const lastSaw = (cli: FakeOpenBaoCli | undefined, ...command: string[]): Readonly<Record<string, string>> => {
  const call = cli?.calls().findLast((each) => each.argv.join(" ") === command.join(" "));
  if (call === undefined) throw new Error(`The fake CLI was never called with ${command.join(" ")}.`);
  return call.saw;
};

posix("tools.verify on bao", () => {
  it("runs bao token lookup with the injection block and a run token minted for it, and passes naming the token's policies", async () => {
    const { bao, cli, client } = await withOpenBao(["bao"]);
    await connected(client, bao);

    expect(await verifyTool(client, "bao")).toEqual({ tool: "bao", outcome: "passed", reason: `bao looked up its run token at ${bao.address}: policies default, minter, reader.` });

    const token = bao.created.at(-1) ?? "";
    expect(bao.issued(token)).toMatchObject({ policies: ["default", "minter", "reader"], displayName: "token-agent-harness", meta: { holder: "verify-command" } });
    expect(bao.issued(token)?.parent).toBe(bao.minted.at(-1));
    const saw = lastSaw(cli.bao, "token", "lookup");
    for (const family of ["BAO", "VAULT"]) {
      expect(saw[`${family}_ADDR`], family).toBe(baoHash(bao.address));
      expect(saw[`${family}_TOKEN`], family).toBe(baoHash(token));
      expect(saw[`${family}_CACERT_BYTES`], family).toBe(baoHash(bao.ca));
      expect(saw[`${family}_NAMESPACE`], family).toBe(baoHash(""));
    }
    // It passed, so status was never asked.
    expect(cli.bao?.calls().map((call) => call.argv.join(" "))).toEqual(["--version", "token lookup"]);
  });

  it("never keeps the output, which prints the token: nothing of it is answered or appended", async () => {
    const { t, bao, client } = await withOpenBao(["bao"]);
    await connected(client, bao);
    const answer = await verifyTool(client, "bao");
    const token = bao.created.at(-1) ?? "";
    expect(token).not.toBe("");
    const logged = t.env.log
      .read<{ payload: string }>("SELECT payload FROM events")
      .map((event) => event.payload)
      .join("\n");
    for (const printed of [token, "accessor-for-tests", "token-agent-harness"]) {
      expect(JSON.stringify(answer)).not.toContain(printed);
      expect(logged).not.toContain(printed);
    }
  });

  it("revokes its run token once the command has exited", async () => {
    const { bao, client } = await withOpenBao(["bao"]);
    await connected(client, bao);
    await verifyTool(client, "bao");
    const token = bao.created.at(-1) ?? "";
    await vi.waitFor(() => expect(bao.live(token)).toBe(false));
    expect(bao.requests.filter((request) => request.path === "auth/token/revoke-self")).toHaveLength(1);
  });
});

posix("a failed bao token lookup", () => {
  it("is followed by status, whose exit 2 answers sealed", async () => {
    const { bao, cli, client } = await withOpenBao(["bao"]);
    await connected(client, bao);
    bao.seal();

    expect(await verifyTool(client, "bao")).toEqual({ tool: "bao", outcome: "failed", reason: `OpenBao at ${bao.address} is sealed: unseal it, then verify again.` });
    expect(cli.bao?.calls().map((call) => call.argv.join(" "))).toEqual(["--version", "token lookup", "status"]);
  });

  it("is followed by status, whose exit 1 answers unreachable with what it said", async () => {
    const { bao, cli, client } = await withOpenBao(["bao"]);
    const connection = await added(client, { address: UNREACHABLE_OPENBAO, ca: bao.ca, credential: approle() });
    await setInjected(client, connection.id);

    const answer = await verifyTool(client, "bao");
    expect(answer).toMatchObject({ tool: "bao", outcome: "failed" });
    expect(answer.reason).toMatch(/^OpenBao at https:\/\/127\.0\.0\.1:1 could not be reached: Error checking seal status: Get "https:\/\/127\.0\.0\.1:1\/v1\/sys\/seal-status": .*ECONNREFUSED.*\.$/);
    expect(cli.bao?.calls().map((call) => call.argv.join(" "))).toEqual(["--version", "token lookup", "status"]);
    // Not signed in, so it was given the address with no run token.
    expect(lastSaw(cli.bao, "token", "lookup")["BAO_TOKEN"]).toBe(baoHash(""));
  });

  it("answers the lookup's own error when OpenBao is unsealed and answers, what it keeps of standard error scrubbed of the run token", async () => {
    const { bao, cli, client } = await withOpenBao(["bao"]);
    await connected(client, bao);
    bao.answer("GET auth/token/lookup-self", { status: 403, error: "permission denied" });
    cli.bao?.leakTokenOnRefusal();

    const answer = await verifyTool(client, "bao");
    const token = bao.created.at(-1) ?? "";
    expect(token).not.toBe("");
    expect(answer).toEqual({ tool: "bao", outcome: "failed", reason: `bao token lookup failed at ${bao.address}: permission denied; the token was [redacted].` });
    expect(cli.bao?.calls().map((call) => call.argv.join(" "))).toEqual(["--version", "token lookup", "status"]);
  });
});

posix("tools.verify on vault", () => {
  it("runs vault token lookup when vault alone is installed, with the VAULT_ family it reads", async () => {
    const { bao, cli, client } = await withOpenBao(["vault"]);
    await connected(client, bao);
    const [listed] = (await client.request("keyManagers.list", {})).connections;
    expect(listed?.cli.tool).toBe("vault");

    expect(await verifyTool(client, "vault")).toEqual({
      tool: "vault",
      outcome: "passed",
      reason: `vault looked up its run token at ${bao.address}: policies default, minter, reader.`,
    });
    const token = bao.created.at(-1) ?? "";
    expect(lastSaw(cli.vault, "token", "lookup")["VAULT_TOKEN"]).toBe(baoHash(token));
    expect(bao.issued(token)?.meta).toEqual({ holder: "verify-command" });
  });
});

posix("tools.verify, running nothing", () => {
  it("answers not installed for a tool its row finds missing, minting no run token", async () => {
    const { bao, client } = await withOpenBao([]);
    await connected(client, bao);
    const created = bao.created.length;

    expect(await verifyTool(client, "bao")).toEqual({ tool: "bao", outcome: "not-installed", reason: "bao is not installed on this environment." });
    expect(await verifyTool(client, "gh")).toEqual({ tool: "gh", outcome: "not-installed", reason: "gh is not installed on this environment." });
    expect(bao.created).toHaveLength(created);
  });

  it("answers failed for a key-manager CLI while no connection of its provider injects", async () => {
    const { cli, client } = await withOpenBao(["bao"]);

    expect(await verifyTool(client, "bao")).toEqual({
      tool: "bao",
      outcome: "failed",
      reason: "No OpenBao connection injects on this environment, so bao has nothing to reach: connect one in Set up, Key manager.",
    });
    expect(cli.bao?.calls().map((call) => call.argv.join(" "))).toEqual(["--version"]);
  });
});

posix("a verify command's injection", () => {
  it("is never denied by the setting, which decides what runs are given", async () => {
    const { bao, client } = await withOpenBao(["bao"]);
    await connected(client, bao);
    const answer = await updateSettings(client, { "credentials.injection": "deny" });
    expect(answer.receipt.status).toBe("accepted");

    expect(await verifyTool(client, "bao")).toMatchObject({ tool: "bao", outcome: "passed" });
  });
});

posix("tools.verify on gh", () => {
  /** An environment finding the forge's fake gh on its login shell's PATH, its host environment holding a stray token in every variable gh reads one from. */
  const withGh = async (valid: boolean) => {
    const gh = installFakeGh(realpathSync(tempDir()), { accounts: [{ host: "github.com", login: "david", token: "token-for-tests", valid }] });
    const t = await startTestEnvironment({ managedTools: gh.managedTools });
    onCleanup(() => t.close());
    return { gh, client: await t.client() };
  };

  it("runs gh auth status and passes naming the hosts and logins it is signed in to, no stray token reaching it", async () => {
    const { gh, client } = await withGh(true);

    expect(await verifyTool(client, "gh")).toEqual({ tool: "gh", outcome: "passed", reason: "gh auth status passed: signed in to github.com as david." });
    expect(gh.calls().at(-1)).toEqual({ argv: ["auth", "status"], sawTokenVariables: [] });
  });

  it("fails with the line gh auth status failed with", async () => {
    const { client } = await withGh(false);

    expect(await verifyTool(client, "gh")).toEqual({ tool: "gh", outcome: "failed", reason: "gh auth status failed: Failed to log in to github.com account david (keyring)." });
  });
});

posix("a verify command that does not answer", () => {
  it("is stopped after ten seconds on the environment's clock and answers failed saying so", async () => {
    const bin = join(realpathSync(tempDir()), "bin");
    mkdirSync(bin);
    const started = join(bin, "started");
    // Answers --version, and on anything else says it started and waits.
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ "$1" = --version ]; then echo 'gh version 2.63.2 (2026-01-01)'; exit 0; fi\n: > '${started}'\nexec '${process.execPath}' -e 'setTimeout(() => {}, 3600000)'\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const t = await startTestEnvironment({ managedTools: { readPath: async () => bin } });
    onCleanup(() => t.close());
    const client = await t.client();

    const answer = verifyTool(client, "gh");
    await vi.waitFor(() => expect(existsSync(started)).toBe(true));
    t.clock.advance(10_000);

    expect(await answer).toEqual({ tool: "gh", outcome: "failed", reason: "gh auth status failed: no answer within 10 s." });
  });
});
