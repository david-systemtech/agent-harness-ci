import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatHostPort } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeForge, type FakeForge } from "../../test/fake-forge.js";
import { DAVID, TOKEN, added, askCredentialRoute, forgeEvents, gitHost } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { hostileMachineGit } from "../../test/hostile-git.js";

/**
 * The harness's own git on a forge (forge spec, "The helper and the
 * credential route" and "No forge account"; ADR 0020; #314) through the
 * primary seam: an in-process environment, the fake forge serving git's smart
 * HTTP behind basic auth, a real git, and the machine's global configuration
 * naming a hostile helper and askpass that hang. The helper itself is the
 * CLI's (its end-to-end test is there); here a stand-in records what git
 * asked it with, to show what the environment names.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const fakeForge = async (): Promise<FakeForge> => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  return forge;
};

/** Long enough for git and the fake forge on a loaded runner; far shorter than the hostile programs hang. */
const PROMPTLY_MS = 10_000;

/**
 * The test that moves the manual clock on by eight days runs every timer the
 * environment has over them, among them 11,520 minute sweeps that each write
 * in a transaction: about a second on an idle machine, and past the preset 30
 * seconds on a throttled CI runner (#596).
 */
const EIGHT_DAYS_OF_TIMERS_MS = 120_000;

describe("the harness's git on an origin no forge account covers", () => {
  it("clones a public repository anonymously, never asking the machine's helper or askpass", async () => {
    const hostile = hostileMachineGit(tempDir, onCleanup);
    const forge = await fakeForge();
    forge.gitRepository("david/skills", { files: { "SKILL.md": "# a skill\n" } });
    const t = await start({ forgeFetch: forge.fetch });
    const parent = tempDir();

    const answer = await t.env.forge.git({ operation: "clone", repository: `${forge.origin}/david/skills.git`, cwd: parent, directory: "skills", purpose: "clone a skill source" });
    expect(answer.outcome).toBe("ran");
    if (answer.outcome !== "ran") return;
    expect(answer.git.ok, answer.git.stderr).toBe(true);
    expect(readFileSync(join(parent, "skills", "SKILL.md"), "utf8")).toBe("# a skill\n");
    expect(forge.gitRequests.every((request) => request.username === null && request.status === 200)).toBe(true);
    expect(hostile.asked()).toEqual([]);
  });

  it("refuses a private repository at once as forge_account_missing, naming the origin and the Forges step, without a prompt", async () => {
    const hostile = hostileMachineGit(tempDir, onCleanup);
    const forge = await fakeForge();
    forge.gitRepository("david/bank", { private: true });
    const t = await start({ forgeFetch: forge.fetch });
    const client = await t.client();
    const before = t.env.log.head();

    const began = Date.now();
    const answer = await t.env.forge.git({ operation: "clone", repository: `${forge.origin}/david/bank`, cwd: tempDir(), directory: "bank", purpose: "clone a bank" });
    expect(Date.now() - began).toBeLessThan(PROMPTLY_MS);
    expect(answer).toMatchObject({
      outcome: "refused",
      error: { code: "forge_account_missing", data: { origin: forge.origin, step: "forges" } },
    });
    const host = forge.origin.replace("http://", "");
    if (answer.outcome === "refused") expect(answer.error.message).toBe(`agent-harness needed a forge for ${host} and found none. Add ${host}.`);
    expect(hostile.asked()).toEqual([]);
    expect(forge.gitRequests.map((request) => request.status)).toEqual([401]);

    const events = await forgeEvents(client, before);
    expect(events.map((event) => [event.type, event.payload])).toEqual([["forge.origin-missing", { origin: forge.origin, operation: "clone a bank" }]]);
    expect(events[0]?.actor).toEqual({ kind: "system", id: "forge" });
  });

  it("records a missing origin at most once a day, and counts it for seven days or until a forge account covers it", async () => {
    hostileMachineGit(tempDir, onCleanup);
    const forge = await fakeForge();
    forge.gitRepository("david/bank", { private: true });
    forge.user(TOKEN, DAVID);
    const t = await start({ forgeFetch: forge.fetch });
    const client = await t.client();
    const refuse = async (purpose: string) => {
      const answer = await t.env.forge.git({ operation: "clone", repository: `${forge.origin}/david/bank.git`, cwd: tempDir(), directory: "bank", purpose });
      expect(answer.outcome).toBe("refused");
    };
    const recorded = async () => (await forgeEvents(client, 0)).filter((event) => event.type === "forge.origin-missing").map((event) => event.occurredAt);

    await refuse("clone a bank");
    await refuse("clone a bank again");
    t.clock.advance(23 * 60 * 60_000);
    await refuse("clone a bank later");
    expect(await recorded()).toEqual([MANUAL_CLOCK_START]);
    expect(t.env.forge.missingOrigins()).toEqual([{ origin: forge.origin, operation: "clone a bank", recordedAt: MANUAL_CLOCK_START }]);

    t.clock.advance(60 * 60_000);
    await refuse("clone a bank the next day");
    const [, second] = await recorded();
    expect(second).toBe("2026-09-25T00:00:00.000Z");
    expect(t.env.forge.missingOrigins()).toEqual([{ origin: forge.origin, operation: "clone a bank the next day", recordedAt: second }]);

    // The client goes first: the wire would ping it every fifteen seconds of the week, 40,320 times.
    await client.close();
    t.clock.advance(7 * 24 * 60 * 60_000 - 1);
    expect(t.env.forge.missingOrigins()).toHaveLength(1);
    t.clock.advance(1);
    expect(t.env.forge.missingOrigins()).toEqual([]);

    await refuse("clone a bank a week on");
    expect(t.env.forge.missingOrigins()).toHaveLength(1);
    await added(await t.client(), { url: forge.origin, kind: "forgejo" });
    expect(t.env.forge.missingOrigins()).toEqual([]);
  }, EIGHT_DAYS_OF_TIMERS_MS);
});

describe("the harness's git on an origin a forge account covers", () => {
  /** A stand-in for the CLI's helper: records its arguments and the variables git gave it, then tells git to quit. */
  const standIn = (): { readonly command: string; readonly record: string } => {
    const dir = tempDir("agent-harness-helper-");
    const record = join(dir, "record");
    const command = join(dir, "helper with a space");
    writeFileSync(
      command,
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' "$*" "$AGENT_HARNESS_ADDRESS" "$AGENT_HARNESS_RUN_SECRET" "$GIT_TERMINAL_PROMPT" > '${record}'\nenv | grep -E '^GIT_CONFIG_(COUNT|KEY_|VALUE_)' | sort >> '${record}'\necho quit=1\n`,
    );
    chmodSync(command, 0o755);
    return { command, record };
  };

  it("names the helper for the canonical origin in process configuration, with a secret for the operation alone, and uses the canonical URL", async () => {
    const hostile = hostileMachineGit(tempDir, onCleanup);
    const forge = await fakeForge();
    forge.gitRepository("david/bank", { private: true });
    forge.user(TOKEN, DAVID);
    const helper = standIn();
    const t = await start({ forgeFetch: forge.fetch, harnessCommand: [helper.command] });
    const account = await added(await t.client(), { url: forge.origin, kind: "forgejo" });

    // A URL with a user and password in it: the harness gives git the canonical origin's, which carries none.
    const given = forge.origin.replace("http://", "http://someone:password-for-tests@");
    const began = Date.now();
    const answer = await t.env.forge.git({ operation: "clone", repository: `${given}/david/bank.git`, cwd: tempDir(), directory: "bank", purpose: "clone a bank" });
    expect(Date.now() - began).toBeLessThan(PROMPTLY_MS);
    expect(answer.outcome).toBe("ran");
    if (answer.outcome !== "ran") return;
    expect(answer.git.ok).toBe(false);
    expect(answer.git.stderr).toContain("told us to quit");

    const [argv, address, secret = "", prompt, ...config] = readFileSync(helper.record, "utf8").trim().split("\n");
    expect(argv).toBe(`git-credential ${account.slug} get`);
    expect(address).toBe(formatHostPort(t.address.host, t.address.port));
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(prompt).toBe("0");
    expect(config).toEqual([
      "GIT_CONFIG_COUNT=2",
      `GIT_CONFIG_KEY_0=credential.${forge.origin}.helper`,
      `GIT_CONFIG_KEY_1=credential.${forge.origin}.helper`,
      "GIT_CONFIG_VALUE_0=",
      `GIT_CONFIG_VALUE_1=!'${helper.command}' git-credential ${account.slug}`,
    ]);
    expect(hostile.asked()).toEqual([]);
    expect(forge.gitRequests.map((request) => [request.path, request.username])).toEqual([["/david/bank.git/info/refs", null]]);

    // The operation's secret ended with it.
    const refused = await askCredentialRoute(t.address, secret, { action: "get", slug: account.slug, protocol: "http", host: gitHost(account.origin) });
    expect(refused.status).toBe(401);
  });

  it("scrubs git's standard error of the operation's secret and of shape-rule hits before answering it", async () => {
    hostileMachineGit(tempDir, onCleanup);
    const forge = await fakeForge();
    forge.gitRepository("david/bank", { private: true });
    forge.user(TOKEN, DAVID);
    // A helper that says too much on its standard error, which git passes on as its own; the shape is put together here, never written in the source.
    const dir = tempDir("agent-harness-helper-");
    const record = join(dir, "record");
    const command = join(dir, "noisy helper");
    const shaped = ["gh", "p_", "Fake0Test9".repeat(4).slice(0, 36)].join("");
    writeFileSync(command, `#!/bin/sh\ncat > /dev/null\nprintf '%s' "$AGENT_HARNESS_RUN_SECRET" > '${record}'\necho "helper saw $AGENT_HARNESS_RUN_SECRET and ${shaped}" >&2\necho quit=1\n`);
    chmodSync(command, 0o755);
    const t = await start({ forgeFetch: forge.fetch, harnessCommand: [command] });
    await added(await t.client(), { url: forge.origin, kind: "forgejo" });

    const answer = await t.env.forge.git({ operation: "clone", repository: `${forge.origin}/david/bank.git`, cwd: tempDir(), directory: "bank", purpose: "clone a bank" });
    expect(answer.outcome).toBe("ran");
    if (answer.outcome !== "ran") return;
    const secret = readFileSync(record, "utf8");
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(answer.git.stderr).toContain("helper saw [redacted] and [redacted]");
    expect(answer.git.stderr).not.toContain(secret);
    expect(answer.git.stderr).not.toContain(shaped);
  });

  it("gives git the canonical origin's URL for a remote on an alias, and resets the chain on every origin the forge account is served on", async () => {
    hostileMachineGit(tempDir, onCleanup);
    const forge = await fakeForge();
    const tailnet = await fakeForge();
    forge.gitRepository("david/bank", { private: true });
    tailnet.gitRepository("david/bank", { private: true });
    for (const origin of [forge, tailnet]) origin.user(TOKEN, DAVID);
    const helper = standIn();
    const t = await start({ harnessCommand: [helper.command] });
    const account = await added(await t.client(), { url: forge.origin, kind: "forgejo", aliases: [tailnet.origin] });

    const answer = await t.env.forge.git({ operation: "clone", repository: `${tailnet.origin}/david/bank.git`, cwd: tempDir(), directory: "bank", purpose: "clone a bank" });
    expect(answer.outcome).toBe("ran");
    expect(tailnet.gitRequests).toEqual([]);
    expect(forge.gitRequests.map((request) => request.path)).toEqual(["/david/bank.git/info/refs"]);
    const config = readFileSync(helper.record, "utf8").trim().split("\n").slice(4);
    const keys = config.filter((entry) => entry.startsWith("GIT_CONFIG_KEY_")).map((entry) => entry.slice(entry.indexOf("=") + 1));
    expect(keys).toEqual([`credential.${forge.origin}.helper`, `credential.${forge.origin}.helper`, `credential.${tailnet.origin}.helper`, `credential.${tailnet.origin}.helper`]);
    expect(config).toContain(`GIT_CONFIG_VALUE_3=!'${helper.command}' git-credential ${account.slug}`);
  });
});
