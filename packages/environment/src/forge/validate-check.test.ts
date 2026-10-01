import { expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { added, DAVID, TOKEN } from "../../test/forge.js";
import { startTestEnvironment } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";

const { onCleanup } = useCleanups();
// A commit id, deliberately not a credential.
const sha = "0".repeat(40);

it.each(["github", "forgejo", "gitea"] as const)("reads completed, failed and pending validate checks through the %s account", async (kind) => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const t = await startTestEnvironment({ forgeFetch: forge.fetch, setupSteps: NO_SETUP_STEPS });
  onCleanup(() => t.close());
  const client = await t.client();
  await added(client, { url: forge.origin, kind });
  const target = { origin: forge.origin, repository: "david/memory", purpose: "validate memories", sha };
  for (const state of ["pending", "success", "failure"] as const) {
    forge.validateCheck(TOKEN, target.repository, sha, state);
    expect(await t.env.forge.pullRequests.validateCheck(target)).toMatchObject({ outcome: "done", value: state });
  }
});

it("uses the newest vendored Forgejo validate job status and ignores another successful check", async () => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const t = await startTestEnvironment({ forgeFetch: forge.fetch, setupSteps: NO_SETUP_STEPS });
  onCleanup(() => t.close());
  await added(await t.client(), { url: forge.origin, kind: "forgejo" });
  const target = { origin: forge.origin, repository: "david/memory", purpose: "validate memories", sha };
  const route = `GET /api/v1/repos/david/memory/commits/${sha}/statuses`;
  forge.answer(TOKEN, route, { status: 200, body: [{ context: "secret-scan", state: "success" }, { context: "validate / validate (pull_request)", state: "success" }] });
  expect(await t.env.forge.pullRequests.validateCheck(target)).toMatchObject({ outcome: "done", value: "success" });
  forge.answer(TOKEN, route, { status: 200, body: [{ context: "validate / validate (pull_request)", state: "pending" }, { context: "validate / validate (pull_request)", state: "success" }] });
  expect(await t.env.forge.pullRequests.validateCheck(target)).toMatchObject({ outcome: "done", value: "pending" });
  forge.answer(TOKEN, route, { status: 200, body: [{ context: "validate", state: "success" }, { context: "validate / validate (pull_request)", state: "failure" }] });
  expect(await t.env.forge.pullRequests.validateCheck(target)).toMatchObject({ outcome: "done", value: "failure" });
  forge.answer(TOKEN, route, { status: 200, body: [{ context: "secret-scan", state: "success" }] });
  expect(await t.env.forge.pullRequests.validateCheck(target)).toMatchObject({ outcome: "done", value: "pending" });
});
