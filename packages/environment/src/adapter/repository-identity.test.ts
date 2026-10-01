import { randomUUID } from "node:crypto";
import { registry, type WorkspaceRequest } from "@agent-harness/contracts";
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

/**
 * An environment whose tool-server factory records the scope of every run it builds servers for, and whose
 * instruction composer, the environment's own over no layers, records the scope of every composition.
 */
const start = async () => {
  const toolScopes: ToolServerScope[] = [];
  const instructionScopes: InstructionScope[] = [];
  const compose = composeInstructions();
  const t = await startTestEnvironment({
    adapter: fakeAdapter(),
    adapterSeams: {
      toolServers: (scope) => {
        toolScopes.push(scope);
        return [];
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

describe("the tool-server scope", () => {
  it("carries the session's repository identity beside its workspace, and the scope's other facts as before", async () => {
    const { t, toolScopes } = await start();
    const client = await t.client();
    const path = repository({ origin: "git@github.com:Acme/receipts.git" });
    const id = await session(client, { kind: "directory", path });
    const runId = await run(t, client, id);

    expect(toolScopes).toEqual([
      { sessionId: id, runId, accountId: "claude-max", workspace: { kind: "directory", path }, repositoryIdentity: IDENTITY, clientTools: [], browser: { kind: "none" } },
    ]);
  });
});

describe("the instruction scope", () => {
  it("carries the session's repository identity beside its workspace, and the scope's other facts as before", async () => {
    const { t, instructionScopes } = await start();
    const client = await t.client();
    const path = repository({ origin: "git@github.com:Acme/receipts.git" });
    const id = await session(client, { kind: "directory", path });
    await run(t, client, id);

    expect(instructionScopes).toEqual([
      expect.objectContaining({ sessionId: id, accountId: "claude-max", workspace: { kind: "directory", path }, repositoryIdentity: IDENTITY, origin: "client" }),
    ]);
    expect(instructionScopes[0]?.trust).toEqual({ key: { kind: "identity", value: IDENTITY }, decision: "undecided" });
  });
});
