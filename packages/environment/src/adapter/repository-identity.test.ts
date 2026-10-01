import { randomUUID } from "node:crypto";
import { registry, type Workspace, type WorkspaceRequest } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import type { InstructionScope, ToolServerScope } from "./seams.js";
import { composeInstructions } from "../instructions/composer.js";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { git } from "../../test/workspaces.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The repository identity on the run seams (banks spec, "The seams"; #1022)
 * through the primary seam: the in-process environment with the scripted
 * fake adapter, a tool-server factory and an instruction composer that
 * record the scopes the host hands them, typed clients over a real
 * WebSocket, and fixture repositories made with `git init` in the test's
 * temporary directory. What is asserted is what the two seams are handed
 * as a run launches and as `instructions.preview` composes.
 */

const { onCleanup, tempDir } = useCleanups();

/** What the receipts repository's remote comes down to. */
const IDENTITY = "https://github.com/acme/receipts";

/** What a bank would make of a scope's repository identity: a line naming it, or saying there is none. */
const repositoryLine = (identity: string | null): string => `Repository: ${identity ?? "none"}`;

/**
 * An environment whose tool-server factory records the scope of every run it builds servers for and serves a
 * `memory` server configured with its repository identity, and whose instruction composer, the environment's own
 * with a team-bank layer that names the identity, records the scope of every composition.
 */
const start = async () => {
  const toolScopes: ToolServerScope[] = [];
  const instructionScopes: InstructionScope[] = [];
  const compose = composeInstructions({
    teamBank: ({ repositoryIdentity }) => [{ id: "bank", version: null, title: "Team bank", text: repositoryLine(repositoryIdentity) }],
  });
  const t = await startTestEnvironment({
    adapter: fakeAdapter(),
    adapterSeams: {
      toolServers: (scope) => {
        toolScopes.push(scope);
        return [{ name: "memory", config: { repository: scope.repositoryIdentity } }];
      },
      instructions: (scope) => {
        instructionScopes.push(scope);
        return compose(scope);
      },
    },
  });
  onCleanup(() => t.close());
  return { t, toolScopes, instructionScopes };
};

/** A repository with one commit in a directory of its own, with `remotes` (name to URL) added. */
const repository = (remotes: Record<string, string> = {}): string => {
  const path = tempDir("agent-harness-identity-");
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "first");
  for (const [name, url] of Object.entries(remotes)) git(path, "remote", "add", name, url);
  return path;
};

/** Creates a session in `workspace`; throws unless the create was accepted. */
const session = async (client: WireClient, workspace: WorkspaceRequest): Promise<string> => {
  const { id, result } = await create(client, { workspace });
  if (result === undefined) throw new Error(`The create in ${JSON.stringify(workspace)} was not accepted.`);
  return id;
};

/** Starts a run on the session as a client does, and waits for its end; resolves with its id. */
const run = async (t: TestEnvironment, client: WireClient, sessionId: string): Promise<string> => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Fix the receipts" }));
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  const { runId } = answer.result;
  await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true));
  return runId;
};

describe("a run's scopes", () => {
  it("carry the session's repository identity beside its workspace, and their other facts as before", async () => {
    const { t, toolScopes, instructionScopes } = await start();
    const client = await t.client();
    const path = repository({ origin: "git@github.com:Acme/receipts.git" });
    const id = await session(client, { kind: "directory", path });
    const runId = await run(t, client, id);

    const workspace = { kind: "directory", path };
    expect(toolScopes).toEqual([{ sessionId: id, runId, accountId: "claude-max", workspace, repositoryIdentity: IDENTITY, clientTools: [], browser: { kind: "none" } }]);
    expect(instructionScopes).toEqual([expect.objectContaining({ sessionId: id, accountId: "claude-max", workspace, repositoryIdentity: IDENTITY, origin: "client" })]);
    expect(instructionScopes[0]?.trust).toEqual({ key: { kind: "identity", value: IDENTITY }, decision: "undecided" });
  });

  it("reach the scripted provider: the memory server and the bank layer built from the session's identity are what its run is handed", async () => {
    const { t } = await start();
    const client = await t.client();
    const identified = await session(client, { kind: "directory", path: repository({ origin: "git@github.com:Acme/receipts.git" }) });
    const scratch = await session(client, { kind: "scratch" });
    await run(t, client, identified);
    await run(t, client, scratch);

    const [identifiedRun, scratchRun] = t.adapter.runs.map(({ input }) => input);
    expect(identifiedRun?.toolServers).toContainEqual({ name: "memory", config: { repository: IDENTITY } });
    expect(identifiedRun?.instructions).toContain(repositoryLine(IDENTITY));
    expect(scratchRun?.toolServers).toContainEqual({ name: "memory", config: { repository: null } });
    expect(scratchRun?.instructions).toContain(repositoryLine(null));
  });

  it("carry the repository's identity for a session in a worktree of it, beside the worktree's own path", async () => {
    const { t, toolScopes, instructionScopes } = await start();
    const client = await t.client();
    const path = repository({ origin: "https://github.com/acme/receipts.git" });
    const id = await session(client, { kind: "worktree", repository: path });
    await run(t, client, id);

    const [tools] = toolScopes;
    const [instructions] = instructionScopes;
    expect(tools?.workspace).toMatchObject({ kind: "worktree", repository: path });
    expect(tools?.workspace.path).not.toBe(path);
    expect(tools).toMatchObject({ sessionId: id, repositoryIdentity: IDENTITY });
    expect(instructions).toMatchObject({ sessionId: id, workspace: tools?.workspace, repositoryIdentity: IDENTITY });
  });

  it("carry null for a session without a repository identity: a repository with no remote, a plain directory, a scratch workspace", async () => {
    const { t, toolScopes, instructionScopes } = await start();
    const client = await t.client();
    const sessions = [
      await session(client, { kind: "directory", path: repository() }),
      await session(client, { kind: "worktree", repository: repository() }),
      await session(client, { kind: "directory", path: tempDir("agent-harness-plain-") }),
      await session(client, { kind: "scratch" }),
    ];
    for (const id of sessions) await run(t, client, id);

    expect(toolScopes.map(({ sessionId, repositoryIdentity }) => [sessionId, repositoryIdentity])).toEqual(sessions.map((id) => [id, null]));
    expect(instructionScopes.map(({ sessionId, repositoryIdentity }) => [sessionId, repositoryIdentity])).toEqual(sessions.map((id) => [id, null]));
  });
});

describe("instructions.preview", () => {
  it("composes a session's preview under that session's repository identity", async () => {
    const { t, toolScopes, instructionScopes } = await start();
    const client = await t.client();
    const id = await session(client, { kind: "worktree", repository: repository({ origin: "https://github.com/acme/receipts.git" }) });

    const forSession = await client.request("instructions.preview", { sessionId: id });
    expect(instructionScopes).toEqual([expect.objectContaining({ sessionId: id, repositoryIdentity: IDENTITY })]);
    expect(forSession.text).toContain(repositoryLine(IDENTITY));
    // A preview builds no tool servers.
    expect(toolScopes).toEqual([]);
  });

  it("composes a new session's preview under the identity a session made in its workspace gets, so it reads as that session's first run", async () => {
    const { t, instructionScopes } = await start();
    const client = await t.client();
    const path = repository({ origin: "git@github.com:Acme/receipts.git" });

    const preview = await client.request("instructions.preview", { accountId: "claude-max", workspace: { kind: "directory", path } });
    expect(instructionScopes).toEqual([expect.objectContaining({ sessionId: null, workspace: { kind: "directory", path }, repositoryIdentity: IDENTITY })]);
    expect(instructionScopes[0]?.trust).toEqual({ key: { kind: "identity", value: IDENTITY }, decision: "undecided" });

    await run(t, client, await session(client, { kind: "directory", path }));
    const [firstRun] = t.adapter.runs.map(({ input }) => input);
    expect(preview.text).toContain(repositoryLine(IDENTITY));
    expect(firstRun?.instructions).toBe(preview.text);
  });

  it("composes a new session's preview under null where a session made there gets none: a repository with no remote, a plain directory, a scratch workspace", async () => {
    const { t, instructionScopes } = await start();
    const client = await t.client();
    const workspaces: Workspace[] = [
      { kind: "directory", path: repository() },
      { kind: "directory", path: tempDir("agent-harness-plain-") },
      // A scratch directory is no checkout, wherever it lies: no git is asked.
      { kind: "scratch", path: repository({ origin: "https://github.com/acme/receipts.git" }) },
    ];
    for (const workspace of workspaces) {
      const preview = await client.request("instructions.preview", { accountId: "claude-max", workspace });
      expect(preview.text).toContain(repositoryLine(null));
    }

    expect(instructionScopes.map(({ sessionId, workspace, repositoryIdentity }) => [sessionId, workspace, repositoryIdentity])).toEqual(workspaces.map((workspace) => [null, workspace, null]));
  });
});
