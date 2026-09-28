import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create, get } from "../../test/sessions.js";
import { git } from "../../test/workspaces.js";

/**
 * The repository identity at creation (workspace-picker spec, "Repository
 * identity"; #324), through the primary seam: an in-process environment and
 * a real client, over real git repositories made in the test's temporary
 * directory, their remotes added in every spelling; no network, no forge.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** The identity every spelling of the harness's own repository comes down to. */
const IDENTITY = "https://git.systemtech.dev/david/agent-harness";

/** A repository with one commit in a directory of its own, with `remotes` (name to URL) added. */
const repository = (remotes: Record<string, string> = {}, path = tempDir("agent-harness-repository-")): string => {
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "first");
  for (const [name, url] of Object.entries(remotes)) git(path, "remote", "add", name, url);
  return path;
};

describe("sessions.create's repository identity", () => {
  it("is recorded in session.created from the workspace's repository, and the summary shows it", async () => {
    const t = await start();
    const client = await t.client();
    const path = repository({ origin: "ssh://git@git.systemtech.dev:2222/david/agent-harness.git" });

    const { id, receipt, result } = await create(client, { workspace: { kind: "directory", path } });

    expect(receipt.status).toBe("accepted");
    expect(result?.summary).toMatchObject({ workspace: { kind: "directory", path }, repositoryIdentity: IDENTITY });
    expect(t.env.log.readStream({ kind: "session", id })[0]).toMatchObject({ type: "session.created", payload: { repositoryIdentity: IDENTITY } });
    expect((await get(client, id)).repositoryIdentity).toBe(IDENTITY);
  });

  it("is copied by sessions.fork from its source, not read again: the fork records its source's identity", async () => {
    const t = await start();
    const client = await t.client();
    const path = repository({ origin: "git@git.systemtech.dev:david/agent-harness.git" });
    const { id } = await create(client, { workspace: { kind: "directory", path } });
    git(path, "remote", "set-url", "origin", "https://github.com/david/elsewhere.git");

    const forkId = randomUUID();
    const forked = await client.apply("sessions.fork", { commandId: randomUUID(), sessionId: id, id: forkId });

    expect(forked.summary).toMatchObject({ workspace: { kind: "directory", path }, repositoryIdentity: IDENTITY });
    expect(t.env.log.readStream({ kind: "session", id: forkId })[0]).toMatchObject({ type: "session.created", payload: { repositoryIdentity: IDENTITY } });
  });
});
