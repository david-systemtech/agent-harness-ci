import { randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { registry, type ParamsOf, type RunSkillSet, type SkillsViewSource } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { fakeAdapter } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { create } from "../../test/sessions.js";
import { SKILLS_HOST, skill, skillRepositories, skillsInsteadOf, type SkillRepositories } from "../../test/skill-repositories.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * Tracking a skill source through the primary seam (skills spec, "Skill
 * sources" and "Testing Decisions"; ADR 0029; #498): an in-process
 * environment driven by a real client, sources on local bare repositories
 * reached by `https://skills.test/` URLs through the harness git's
 * `insteadOf`, and the scripted fake adapter recording the skill set and
 * generation each run is handed.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (forge: SkillRepositories, options: TestEnvironmentOptions = {}): Promise<{ t: TestEnvironment; client: WireClient }> => {
  const t = await startTestEnvironment({ harnessGitConfig: skillsInsteadOf(forge), adapter: fakeAdapter(), ...options });
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};

type AddParams = Omit<ParamsOf<"skills.sources.add">, "commandId">;

/** Adds a source, following the remote's default branch unless told otherwise; answers the source. */
const add = async (client: WireClient, url: string, params: Partial<AddParams> = {}): Promise<SkillsViewSource> => {
  const answer = registry["skills.sources.add"].response.parse(
    await client.request("skills.sources.add", { commandId: randomUUID(), url, folder: ".", follow: { kind: "branch", branch: null }, ...params }),
  );
  if (answer.result === undefined) throw new Error(`skills.sources.add was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.source;
};

/** Starts a run in the session and waits for its end. */
const runIn = async (t: TestEnvironment, client: WireClient, sessionId: string): Promise<void> => {
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId, text: "Go" }));
  const runId = answer.result?.runId;
  if (runId === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true), {
    timeout: WAIT_MS,
  });
};

/** The skill set the adapter was handed for its latest run. */
const lastSet = (t: TestEnvironment): RunSkillSet => t.adapter.lastRun().input.skillSet;

describe("a repository whose root is one skill (ADR 0029's root-skill test)", () => {
  it("is added with folder ., and its one member, named after the repository, reaches the next run's generation from the source's snapshot", async () => {
    const forge = skillRepositories(tempDir);
    const commit = forge.commit("theclaymethod/unslop", { "SKILL.md": skill(null, "Remove AI writing patterns."), "references/patterns.md": "# patterns\n" });
    const { t, client } = await start(forge);

    const source = await add(client, `${SKILLS_HOST}theclaymethod/unslop`);
    expect(source).toEqual({
      id: expect.any(String),
      url: `${SKILLS_HOST}theclaymethod/unslop`,
      identity: "https://skills.test/theclaymethod/unslop",
      folder: ".",
      follow: { kind: "branch", branch: null },
      position: 1,
      addedBy: { kind: "client_session", id: expect.any(String) },
      addedAt: expect.any(String),
      commit,
      skillCount: 1,
    });

    const { id } = await create(client);
    await runIn(t, client, id);
    const set = lastSet(t);
    expect(set.members).toEqual([
      { name: "unslop", origin: { kind: "repository", repository: "https://skills.test/theclaymethod/unslop", path: "." }, invocation: "model+slash", native: false, alwaysOn: false },
    ]);
    const link = join(set.generation as string, "skills", "unslop");
    expect(readlinkSync(link)).toBe(join(t.dataDir, "skills", "snapshots", source.id, commit));
    expect(readFileSync(join(link, "references", "patterns.md"), "utf8")).toBe("# patterns\n");
  });
});
