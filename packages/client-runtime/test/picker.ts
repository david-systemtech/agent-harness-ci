import type { WorkspaceRequest } from "@agent-harness/contracts";
import type { TestEnvironment, TestEnvironmentOptions } from "../../environment/test/helper.js";
import { git } from "../../environment/test/workspaces.js";
import { uuidv4 } from "../src/ids.js";
import type { CommandParams } from "../src/outbox/outbox.js";
import type { Runtime } from "../src/runtime.js";
import { inMemoryPlatform } from "../src/testing/in-memory-platform.js";
import { holds, type useHarness } from "./harness.js";

/**
 * What the picker's suites build on (workspace-picker spec, "Testing
 * Decisions"), over a suite's own harness: directories and real git
 * repositories made in the test's temporary directory and removed after it,
 * a runtime paired with two in-process environments, and sessions created
 * through the runtime.
 */

/** What a session is created with beside its id and workspace. */
export type CreateExtras = Omit<CommandParams<"sessions.create">, "id" | "workspace">;

export const pickerFixtures = (harness: ReturnType<typeof useHarness>) => {
  /** A directory of the test's own, removed after it. */
  const directory = (): string => harness.tempDir("agent-harness-known-");

  /** A repository with one commit and `remotes` (name to URL) in a directory of the test's own. */
  const repository = (remotes: Record<string, string> = {}): string => {
    const path = directory();
    git(path, "init", "-q");
    git(path, "commit", "-q", "--allow-empty", "-m", "first");
    for (const [name, url] of Object.entries(remotes)) git(path, "remote", "add", name, url);
    return path;
  };

  /** A runtime paired with two in-process environments, desk first, each started with its own options. */
  const twoEnvironments = async (options: { readonly runtime?: Runtime; readonly desk?: TestEnvironmentOptions; readonly laptop?: TestEnvironmentOptions } = {}) => {
    const desk = await harness.environment({ name: "desk", ...options.desk });
    const laptop = await harness.environment({ name: "laptop", ...options.laptop });
    const runtime = options.runtime ?? harness.runtime(inMemoryPlatform());
    await runtime.start();
    for (const t of [desk, laptop]) await runtime.connections.add({ link: (await t.createPairing()).link });
    return { desk, laptop, runtime };
  };

  /** Creates a session on `t` in `workspace` through the runtime, and waits for its row. */
  const create = async (runtime: Runtime, t: TestEnvironment, workspace: WorkspaceRequest, extras: CreateExtras = {}): Promise<string> => {
    const id = uuidv4();
    const answer = await runtime.commands.dispatch(t.env.id, "sessions.create", { id, workspace, ...extras });
    if (!answer.ok) throw new Error(`The environment refused the session: ${answer.error.message}`);
    await holds(runtime.projections.sessionList, (view) => view.rows.some((row) => row.summary.id === id));
    return id;
  };

  return { directory, repository, twoEnvironments, create };
};
