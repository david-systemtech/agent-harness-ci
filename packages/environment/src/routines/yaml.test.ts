import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { readRoutineYaml } from "@agent-harness/contracts/routine-yaml";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, listRoutines, routineCommand, routineEvents, written } from "../../test/routines.js";
import { refusal } from "../../test/sessions.js";
import { git } from "../../test/workspaces.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Routines as YAML through the primary seam (routines spec, "YAML export and
 * import", "Moving a routine"; #528): an in-process environment and a real
 * client over a real WebSocket, with real git repositories made in the
 * test's temporary directory, so a routine document's checkout is present
 * here, absent, or known under another path. The codec itself is the
 * contracts' (`routine-yaml.test.ts`); this suite reads what the
 * environment answers with it.
 */

const { onCleanup, tempDir } = useCleanups();

/** The zone the test environment runs in: not the machine's, so a zone a document leaves out is visibly the environment's. */
const ZONE = "Asia/Manila";

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ timeZone: ZONE, name: "SYSTEM-SERVER", ...options });
  onCleanup(() => t.close());
  return t;
};

/** Sends `routines.endpoints.set` for an endpoint with a pasted secret; throws unless it was accepted. */
const endpointWithSecret = async (client: WireClient, name: string, secret: string): Promise<void> => {
  const answer = registry["routines.endpoints.set"].response.parse(
    await client.request("routines.endpoints.set", { commandId: randomUUID(), name, url: "https://hermes.example.com/webhooks/harness", secret: { kind: "pasted", secret } }),
  );
  if (answer.result === undefined) throw new Error(`routines.endpoints.set was not applied: ${JSON.stringify(answer.receipt)}`);
};

/** The identity every spelling of the harness's remote comes down to. */
const IDENTITY = "https://git.systemtech.dev/david/agent-harness";

/** A clone with one commit and its remote spelled `remote`, made at `path` (a fresh temporary directory unless given); answers its path. */
const clone = (remote = "git@git.systemtech.dev:david/agent-harness.git", path = tempDir("routine-clone-")): string => {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "first");
  git(path, "remote", "add", "origin", remote);
  return path;
};

describe("a routine's repository identity", () => {
  it("is recorded at create and edit as the one its workspace resolves to here, a directory's or a worktree's repository's; none for scratch; and as carried for a path not usable here", async () => {
    const t = await start();
    const client = await t.client();
    const checkout = clone();
    const tools = clone("https://example.com/Seth/tools.git");

    const routine = await created(client, written({ workspace: { kind: "directory", path: checkout, repositoryIdentity: null } }));
    expect(routine.definition.workspace).toEqual({ kind: "directory", path: checkout, repositoryIdentity: IDENTITY });
    expect(routineEvents(t, routine.state.id)[0]?.payload).toMatchObject({ definition: { workspace: { repositoryIdentity: IDENTITY } } });

    const update = (workspace: object) => routineCommand(client, "routines.update", { routineId: routine.state.id, fields: { workspace } as never });
    expect((await update({ kind: "worktree", repository: tools, branch: "main", repositoryIdentity: IDENTITY })).result?.routine.definition.workspace).toEqual({
      kind: "worktree",
      repository: tools,
      branch: "main",
      repositoryIdentity: "https://example.com/seth/tools",
    });
    expect((await update({ kind: "scratch", repositoryIdentity: IDENTITY })).result?.routine.definition.workspace).toEqual({ kind: "scratch", repositoryIdentity: null });
    const gone = join(tempDir(), "not-here");
    expect((await update({ kind: "directory", path: gone, repositoryIdentity: IDENTITY })).result?.routine.definition.workspace).toEqual({ kind: "directory", path: gone, repositoryIdentity: IDENTITY });
    const plain = join(tempDir(), "no-repository");
    mkdirSync(plain);
    expect((await update({ kind: "directory", path: plain, repositoryIdentity: IDENTITY })).result?.routine.definition.workspace).toEqual({ kind: "directory", path: plain, repositoryIdentity: null });
  });
});

describe("routines.export", () => {
  it("answers every routine as YAML, one document each, under a comment naming the environment and the time, with no id, ceiling or secret, and a webhook target by its endpoint's name", async () => {
    const t = await start();
    const client = await t.client();
    await endpointWithSecret(client, "hermes-home", "token-for-tests");
    const watch = await created(client, written({ delivery: [{ kind: "webhook", target: "hermes-home", on: "success" }] }));
    const digest = await created(client, written({ name: "Nightly digest", schedule: { kind: "daily", at: "23:30" }, timezone: "Europe/London", mode: "plan" }));

    const { yaml } = await client.request("routines.export", {});
    expect(yaml.split("\n")[0]).toBe(`# Routines exported from SYSTEM-SERVER at ${MANUAL_CLOCK_START}.`);
    expect(readRoutineYaml(yaml, "UTC")).toEqual([
      { index: 0, definition: watch.definition, issues: [] },
      { index: 1, definition: digest.definition, issues: [] },
    ]);
    expect(yaml).toContain("{ kind: webhook, target: hermes-home, on: success }");
    for (const absent of [watch.state.id, digest.state.id, client.hello.environmentId, client.hello.clientSessionId, watch.state.savedUnderCeiling, "token-for-tests"]) {
      expect(yaml).not.toContain(absent);
    }
  });

  it("answers the routines named, in the list's order, and refuses one it does not hold not_found", async () => {
    const t = await start();
    const client = await t.client();
    const watch = await created(client);
    const digest = await created(client, written({ name: "Nightly digest" }));
    await created(client, written({ name: "Weekly report" }));

    const { yaml } = await client.request("routines.export", { routineIds: [digest.state.id, watch.state.id.toUpperCase()] });
    expect(readRoutineYaml(yaml, ZONE).map((document) => document.definition)).toEqual([watch.definition, digest.definition]);

    const missing = randomUUID();
    const refused = await refusal(client.request("routines.export", { routineIds: [watch.state.id, missing] }));
    expect(refused).toMatchObject({ code: "not_found", data: { kind: "routine", routineId: missing } });
    expect(await listRoutines(client)).toHaveLength(3);
  });
});
