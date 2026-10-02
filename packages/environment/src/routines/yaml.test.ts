import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { registry, type Ceiling, type SchemaIssue } from "@agent-harness/contracts";
import { readRoutineYaml } from "@agent-harness/contracts/routine-yaml";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { created, listRoutines, routineCommand, routineEvents, written } from "../../test/routines.js";
import { create, refusal } from "../../test/sessions.js";
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

/** A routine document's YAML: these keys over a disabled, manual, scratch one's, each value as YAML writes it. */
const documentYaml = (keys: Readonly<Record<string, string>> = {}): string =>
  `${Object.entries({
    kind: "routine",
    version: "1",
    name: "Imported",
    enabled: "false",
    schedule: "{ kind: manual }",
    workspace: "{ kind: scratch }",
    account: "null",
    model: "null",
    effort: "null",
    mode: "null",
    containment: "null",
    skills: "[]",
    "pre-check": "null",
    instructions: "Read the sources and file a digest.",
    ...keys,
  })
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")}\n`;

/** Routine documents as one file. */
const yamlOf = (...documents: string[]): string => documents.join("---\n");

/** The definition `documentYaml()` holds, as this environment would save it: the presets applied and its zone. */
const importedDefinition = {
  name: "Imported",
  schedule: { kind: "manual" },
  timezone: ZONE,
  ifMissed: "run-once",
  instructions: "Read the sources and file a digest.",
  workspace: { kind: "scratch", repositoryIdentity: null },
  account: null,
  model: null,
  effort: null,
  mode: null,
  containment: null,
  injection: "inherit",
  skills: [],
  preCheck: null,
  silenceMarker: "[SILENT]",
  maxDurationMinutes: 60,
  delivery: [{ kind: "client-notice", on: "both" }],
  enabled: false,
};

describe("routines.checkImport", () => {
  it("answers per document the definition as it would be saved, the issues at their paths, and the attention it would show here, saving nothing", async () => {
    const t = await start();
    const client = await t.client();
    const watch = await created(client);
    const yaml = yamlOf(
      documentYaml({ name: '"  Imported  "', account: "{ provider: fake, email: nobody@example.com, organisation: null }" }),
      documentYaml({ name: "Broken", schedule: "{ kind: hourly, minute: 60 }", colour: "blue" }),
      documentYaml({ name: "UPSTREAM WATCH" }),
      documentYaml({ name: "imported" }),
    );

    const { documents } = await client.request("routines.checkImport", { yaml });
    expect(documents).toHaveLength(4);
    expect(documents[0]).toEqual({
      index: 0,
      definition: { ...importedDefinition, account: { provider: "fake", email: "nobody@example.com", organisation: null } },
      issues: [],
      warnings: { attention: ["account_missing"], unknownSkills: [], workspace: null },
    });
    expect(documents[1]).toMatchObject({ index: 1, definition: null, warnings: { attention: [], workspace: null } });
    expect(documents[1]?.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([["schedule", "minute"], ["colour"]]));
    expect(documents[2]).toMatchObject({ index: 2, definition: { name: "UPSTREAM WATCH" }, issues: [{ path: ["name"], params: { reason: "name_taken", routineId: watch.state.id } }] });
    expect(documents[3]).toMatchObject({ index: 3, definition: { name: "imported" }, issues: [{ path: ["name"], params: { reason: "name_taken", document: 0 } }] });
    expect(await listRoutines(client)).toEqual([watch]);
  });

  it("reads a document as the replacement of the routine named: its own name is no issue, a second document is, and a routine not here is not_found", async () => {
    const t = await start();
    const client = await t.client();
    const watch = await created(client);

    const own = await client.request("routines.checkImport", { yaml: documentYaml({ name: "upstream watch" }), routineId: watch.state.id });
    expect(own.documents).toEqual([{ index: 0, definition: { ...importedDefinition, name: "upstream watch" }, issues: [], warnings: { attention: [], unknownSkills: [], workspace: null } }]);

    const two = await client.request("routines.checkImport", { yaml: yamlOf(documentYaml(), documentYaml({ name: "Other" })), routineId: watch.state.id });
    expect(two.documents.map((document) => document.issues.map((issue) => issue.path))).toEqual([[[]], [[]]]);

    const missing = randomUUID();
    expect(await refusal(client.request("routines.checkImport", { yaml: documentYaml(), routineId: missing }))).toMatchObject({ code: "not_found", data: { kind: "routine", routineId: missing } });
  });
});

describe("a document's workspace", () => {
  it("is used as written where its path is usable here, with the identity git finds there, whatever identity the document carries", async () => {
    const t = await start();
    const client = await t.client();
    const checkout = clone();
    const yaml = documentYaml({ workspace: `{ kind: directory, path: "${checkout}", repository-identity: https://example.com/someone/else }` });
    const { documents } = await client.request("routines.checkImport", { yaml });
    expect(documents[0]?.definition?.workspace).toEqual({ kind: "directory", path: checkout, repositoryIdentity: IDENTITY });
    expect(documents[0]?.warnings.workspace).toBeNull();
  });

  it("is re-resolved where its path is not usable here and its identity is known: to the most recently used present checkout holding it, a worktree keeping its branch, else to scratch; with no identity, kept as written", async () => {
    const t = await start();
    const client = await t.client();
    const [older, newer] = [clone(), clone("https://git.systemtech.dev:5526/david/agent-harness")];
    await create(client, { workspace: { kind: "directory", path: older } });
    t.clock.advance(60_000);
    await create(client, { workspace: { kind: "directory", path: newer } });
    const elsewhere = join(tempDir(), "elsewhere", "agent-harness");

    const yaml = yamlOf(
      documentYaml({ name: "Directory", workspace: `{ kind: directory, path: "${elsewhere}", repository-identity: ${IDENTITY} }` }),
      documentYaml({ name: "Windows", workspace: `{ kind: directory, path: 'C:\\work\\agent-harness', repository-identity: ${IDENTITY} }` }),
      documentYaml({ name: "Worktree", workspace: `{ kind: worktree, repository: "${elsewhere}", branch: main, repository-identity: ${IDENTITY} }` }),
      documentYaml({ name: "Unknown here", workspace: `{ kind: directory, path: "${elsewhere}", repository-identity: https://git.systemtech.dev/david/elsewhere }` }),
      documentYaml({ name: "No identity", workspace: `{ kind: directory, path: "${elsewhere}" }` }),
    );
    const { documents } = await client.request("routines.checkImport", { yaml });
    const resolved = { kind: "directory", path: newer, repositoryIdentity: IDENTITY };
    const scratch = { kind: "scratch", repositoryIdentity: null };
    expect(documents.map((document) => [document.definition?.workspace, document.warnings.workspace])).toEqual([
      [resolved, resolved],
      [resolved, resolved],
      [
        { kind: "worktree", repository: newer, branch: "main", repositoryIdentity: IDENTITY },
        { kind: "worktree", repository: newer, branch: "main", repositoryIdentity: IDENTITY },
      ],
      [scratch, scratch],
      [{ kind: "directory", path: elsewhere, repositoryIdentity: null }, null],
    ]);
  });
});

/** A client of a client session paired under `ceiling` with the routine commands' scope, as a phone would be. */
const paired = async (t: TestEnvironment, ceiling: Ceiling): Promise<WireClient> =>
  t.client({ token: (await t.pair({ kind: "web", label: "a phone", ceiling, scopes: ["read", "sessions:write"] })).token, clientKind: "web" });

/** The paths of the issues an `invalid_params` names. */
const pathsOf = (data: Record<string, unknown>): SchemaIssue["path"][] => (data["issues"] as SchemaIssue[]).map((issue) => issue.path);

describe("routines.import", () => {
  it("makes each document a routine under the ids given, as the client session, saved under its ceiling and linked to the routine it was moved from, answering the routines and checkImport's warnings", async () => {
    const t = await start();
    const phone = await paired(t, "acceptEdits");
    const checkout = clone();
    await create(await t.client(), { workspace: { kind: "directory", path: checkout } });
    const elsewhere = join(tempDir(), "elsewhere", "agent-harness");
    const yaml = yamlOf(
      documentYaml({ name: "First", enabled: "true", workspace: `{ kind: directory, path: "${elsewhere}", repository-identity: ${IDENTITY} }` }),
      documentYaml({ name: "Second", account: "{ provider: fake, email: nobody@example.com, organisation: null }" }),
    );
    const [first, second] = [randomUUID(), randomUUID()];
    const original = { environmentId: randomUUID(), routineId: randomUUID() };

    const answer = await routineCommand(phone, "routines.import", { yaml, routineIds: [first.toUpperCase(), second], movedFrom: { ...original, routineId: original.routineId.toUpperCase() } });
    expect(answer.receipt).toMatchObject({ status: "accepted", changed: true });
    const resolved = { kind: "directory", path: checkout, repositoryIdentity: IDENTITY };
    const movedFrom = { ...original, at: MANUAL_CLOCK_START };
    expect(answer.result?.warnings).toEqual([
      { attention: [], unknownSkills: [], workspace: resolved },
      { attention: ["account_missing"], unknownSkills: [], workspace: null },
    ]);
    expect(answer.result?.routines.map((routine) => [routine.state.id, routine.definition, routine.state.savedUnderCeiling, routine.state.savedBy, routine.state.movedFrom])).toEqual([
      [first, { ...importedDefinition, name: "First", enabled: true, workspace: resolved }, "acceptEdits", phone.hello.clientSessionId, movedFrom],
      [second, { ...importedDefinition, name: "Second", account: { provider: "fake", email: "nobody@example.com", organisation: null } }, "acceptEdits", phone.hello.clientSessionId, movedFrom],
    ]);
    expect(routineEvents(t).map((event) => [event.type, event.actor])).toEqual([
      ["routine.created", `client_session:${phone.hello.clientSessionId}`],
      ["routine.created", `client_session:${phone.hello.clientSessionId}`],
    ]);
    expect(await listRoutines(phone)).toEqual(answer.result?.routines);
  });

  it("mints the routines' ids when none are given", async () => {
    const t = await start();
    const client = await t.client();
    const answer = await routineCommand(client, "routines.import", { yaml: yamlOf(documentYaml({ name: "First" }), documentYaml({ name: "Second" })) });
    const ids = answer.result?.routines.map((routine) => routine.state.id) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect((await listRoutines(client)).map((routine) => routine.state.id)).toEqual(ids);
  });

  it("with routineId replaces that routine's definition from one document, keeping its id, state and links, saved under the caller's ceiling; refuses a second document and a routine not here", async () => {
    const t = await start();
    const client = await t.client();
    const watch = await created(client);
    const phone = await paired(t, "plan");
    t.clock.advance(60_000);

    const yaml = documentYaml({ name: "upstream watch", mode: "acceptEdits", schedule: "{ kind: daily, at: \"06:00\" }" });
    const answer = await routineCommand(phone, "routines.import", { yaml, routineId: watch.state.id, movedFrom: { environmentId: randomUUID(), routineId: randomUUID() } });
    const definition = { ...importedDefinition, name: "upstream watch", mode: "acceptEdits", schedule: { kind: "daily", at: "06:00" } };
    expect(answer.result).toEqual({ routines: [expect.objectContaining({ definition })], warnings: [{ attention: ["clamped"], unknownSkills: [], workspace: null }] });
    expect(answer.result?.routines[0]?.state).toMatchObject({ id: watch.state.id, savedUnderCeiling: "plan", movedFrom: null, createdAt: watch.state.createdAt, editedAt: t.clock.now().toISOString() });
    expect(routineEvents(t, watch.state.id).at(-1)).toEqual({ type: "routine.edited", payload: { fields: definition, savedUnderCeiling: "plan" }, actor: `client_session:${phone.hello.clientSessionId}` });

    const two = await refusal(client.request("routines.import", { commandId: randomUUID(), yaml: yamlOf(documentYaml(), documentYaml({ name: "Other" })), routineId: watch.state.id }));
    expect(two.code).toBe("invalid_params");
    expect(pathsOf(two.data)).toEqual([["yaml"]]);
    const missing = randomUUID();
    const notHere = await routineCommand(client, "routines.import", { yaml, routineId: missing });
    expect(notHere.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "routine", routineId: missing } } });
    expect(routineEvents(t).map((event) => event.type)).toEqual(["routine.created", "routine.edited"]);
  });

  it("is all or nothing: a document with an issue refuses the whole import invalid_params at its path under yaml, and so do a count of ids other than the documents', an id given twice in another case, and a YAML with none", async () => {
    const t = await start();
    const client = await t.client();
    const broken = yamlOf(documentYaml({ name: "Fine" }), documentYaml({ name: "Broken", schedule: "{ kind: hourly, minute: 60 }" }));
    const refused = await refusal(client.request("routines.import", { commandId: randomUUID(), yaml: broken }));
    expect(refused.code).toBe("invalid_params");
    expect(pathsOf(refused.data)).toEqual([["yaml", 1, "schedule", "minute"]]);

    const counted = await refusal(client.request("routines.import", { commandId: randomUUID(), yaml: yamlOf(documentYaml({ name: "A" }), documentYaml({ name: "B" })), routineIds: [randomUUID()] }));
    expect(pathsOf(counted.data)).toEqual([["routineIds"]]);
    const id = randomUUID();
    const recased = await refusal(client.request("routines.import", { commandId: randomUUID(), yaml: yamlOf(documentYaml({ name: "A" }), documentYaml({ name: "B" })), routineIds: [id, id.toUpperCase()] }));
    expect(pathsOf(recased.data)).toEqual([["routineIds", 1]]);
    const empty = await refusal(client.request("routines.import", { commandId: randomUUID(), yaml: "# nothing to import\n" }));
    expect(pathsOf(empty.data)).toEqual([["yaml"]]);
    expect(await listRoutines(client)).toEqual([]);
  });

  it("fails the whole import conflict name_taken naming the document when a routine here or an earlier document holds its name, and conflict exists for an id used before; nothing is saved", async () => {
    const t = await start();
    const client = await t.client();
    const watch = await created(client);

    const held = await routineCommand(client, "routines.import", { yaml: yamlOf(documentYaml({ name: "Fine" }), documentYaml({ name: "UPSTREAM WATCH" })) });
    expect(held.receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "name_taken", document: 1, name: "UPSTREAM WATCH", heldName: "Upstream watch", routineId: watch.state.id } },
    });
    const twice = await routineCommand(client, "routines.import", { yaml: yamlOf(documentYaml({ name: "Twice" }), documentYaml({ name: "twice" })) });
    expect(twice.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "name_taken", document: 1, name: "twice", heldName: "Twice", heldByDocument: 0 } } });
    const used = await routineCommand(client, "routines.import", { yaml: yamlOf(documentYaml({ name: "Fresh" }), documentYaml({ name: "Fresher" })), routineIds: [randomUUID(), watch.state.id] });
    expect(used.receipt).toMatchObject({ status: "rejected", reason: "conflict", error: { data: { reason: "exists", routineId: watch.state.id } } });
    expect(await listRoutines(client)).toEqual([watch]);
    expect(routineEvents(t).map((event) => event.type)).toEqual(["routine.created"]);
  });
});

