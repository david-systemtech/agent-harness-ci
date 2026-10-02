import { expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { added, DAVID, TOKEN } from "../../test/forge.js";
import { startTestEnvironment } from "../../test/helper.js";
import { NO_SETUP_STEPS } from "../../test/setup-steps.js";

const { onCleanup } = useCleanups();
it.each(["github", "forgejo", "gitea"] as const)("reads PR authors and owner reviews through %s, including later dismissals", async (kind) => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  forge.pullRequest(TOKEN, "david/memory", 7, { author: "david" });
  const api = kind === "github" ? "/api/v3" : "/api/v1";
  forge.answer(TOKEN, `GET ${api}/repos/david/memory/pulls/7/reviews`, { status: 200, body: [
    { id: 1, user: { login: "sam" }, state: "APPROVED", commit_id: "0".repeat(40) },
    { id: 2, user: { login: "sam" }, state: "DISMISSED", commit_id: "0".repeat(40) },
  ] });
  const t = await startTestEnvironment({ forgeFetch: forge.fetch, setupSteps: NO_SETUP_STEPS });
  onCleanup(() => t.close());
  await added(await t.client(), { url: forge.origin, kind });
  const target = { origin: forge.origin, repository: "david/memory", purpose: "review bank changes", number: 7 };
  expect(await t.env.forge.pullRequests.get(target)).toMatchObject({ outcome: "done", value: { author: "david" } });
  expect(await t.env.forge.pullRequests.reviews(target)).toMatchObject({ outcome: "done", value: [
    { id: 1, login: "sam", state: "approved", commit: "0".repeat(40) },
    { id: 2, login: "sam", state: "dismissed", commit: "0".repeat(40) },
  ] });
});

it.each(["github", "forgejo"] as const)("reads review dismissals on later %s pages", async (kind) => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  const api = kind === "github" ? "/api/v3" : "/api/v1";
  const route = `${api}/repos/david/memory/pulls/7/reviews`;
  const size = kind === "github" ? "per_page=100" : "limit=50";
  forge.answer(TOKEN, `GET ${route}?${size}`, { status: 200, body: [{ id: 1, user: { login: "sam" }, state: "APPROVED" }], headers: { link: `<${forge.origin}${route}?${size}&page=2>; rel="next"` } });
  forge.answer(TOKEN, `GET ${route}?${size}&page=2`, { status: 200, body: [{ id: 2, user: { login: "sam" }, state: "DISMISSED" }] });
  const t = await startTestEnvironment({ forgeFetch: forge.fetch, setupSteps: NO_SETUP_STEPS });
  onCleanup(() => t.close());
  await added(await t.client(), { url: forge.origin, kind });
  expect(await t.env.forge.pullRequests.reviews({ origin: forge.origin, repository: "david/memory", purpose: "review bank changes", number: 7 })).toMatchObject({ outcome: "done", value: [{ state: "approved" }, { state: "dismissed" }] });
});
