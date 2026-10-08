import type { ParamsOf } from "@agent-harness/contracts";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { BANK_VALIDATOR_DIST, buildBankValidator } from "../../../contracts/scripts/bank-validator/build.js";
import { PERSONAL_BANK, markdown, personalManifest } from "../../../contracts/test/fixture-banks.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { useCleanups } from "../../test/cleanups.js";
import { added, DAVID, TOKEN } from "../../test/forge.js";
import { startTestEnvironment } from "../../test/helper.js";
import { WAIT_MS } from "../../test/wire-client.js";
import { git } from "../../test/workspaces.js";

const { onCleanup, tempDir } = useCleanups();
beforeAll(async () => {
  mkdirSync(dirname(BANK_VALIDATOR_DIST), { recursive: true });
  await buildBankValidator({ outFile: BANK_VALIDATOR_DIST });
});
const followUp = "# Repair the sensor\n\n## Problem\n\nThe sensor misses readings.\n\n## Done when\n\n- [ ] Every reading arrives.\n\n## Verification\n\nCheck the recorded readings.\n";
const start = async () => {
  const forge = await startFakeForge();
  onCleanup(() => forge.close());
  forge.user(TOKEN, DAVID);
  forge.repositories(TOKEN, []);
  forge.gitCredential("david", TOKEN);
  const bare = forge.gitRepository("david/maya-memory", { private: true, empty: true });
  forge.answer(TOKEN, "POST /api/v1/user/repos", () => {
    forge.repository(TOKEN, "david/maya-memory");
    return { status: 201, body: { full_name: "david/maya-memory", private: true, default_branch: "main", html_url: `${forge.origin}/david/maya-memory` } };
  });
  forge.answer(TOKEN, "POST /api/v1/repos/david/maya-memory/pulls", (request) => {
    const branch = (request.body as { head: string }).head;
    const sha = git(bare, "rev-parse", branch).trim();
    forge.pullRequest(TOKEN, "david/maya-memory", 1, { head: branch, sha, author: "david" });
    forge.validateCheck(TOKEN, "david/maya-memory", sha, "success");
    return { status: 201, body: { number: 1, title: "Publish", state: "open", user: { login: "david" }, head: { ref: branch, sha, repo: { full_name: "david/maya-memory" } }, base: { ref: "main" }, html_url: `${forge.origin}/david/maya-memory/pulls/1` } };
  });
  const helper = join(tempDir(), "helper");
  writeFileSync(helper, "#!/bin/sh\ncat >/dev/null\nprintf 'username=david\\npassword=token-for-tests\\n\\n'\n");
  chmodSync(helper, 0o755);
  const t = await startTestEnvironment({ dataDir: tempDir(), forgeFetch: forge.fetch, harnessCommand: [helper] });
  onCleanup(() => t.close());
  const client = await t.client();
  await added(client, { url: forge.origin, kind: "forgejo", primary: true });
  const checkout = tempDir();
  const files = { ...PERSONAL_BANK, "BANK.md": markdown(personalManifest({ write: { ...(personalManifest()["write"] as object), land: "commit" } })), "issues/README.md": "# Follow-ups\n", "issues/sensor.md": followUp };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), text);
  }
  git(checkout, "init", "--quiet", "--initial-branch=main");
  git(checkout, "add", "--all");
  git(checkout, "commit", "--quiet", "-m", "First memories.");
  writeFileSync(join(checkout, "README.md"), "More memories later.\n");
  git(checkout, "add", "--all");
  git(checkout, "commit", "--quiet", "-m", "Keep the later history.");
  const bankId = randomUUID();
  const bank = (await client.request("banks.register", { commandId: randomUUID(), bankId, path: checkout, role: "read-write", accounts: "all", repositories: "all", defaultFor: ["claude-max"] })).result!.bank;
  return { forge, bare, t, client, checkout, bank, helper };
};

it("publishes existing history and identity, holding the landing change for the personal owner and offering follow-ups", async () => {
  const h = await start();
  const head = git(h.checkout, "rev-parse", "main").trim();
  const params: ParamsOf<"banks.publish"> = { commandId: randomUUID(), bankId: h.bank.id };
  const answer = await h.client.request("banks.publish", params);
  expect(answer.receipt.status).toBe("accepted");
  expect(answer.result).toMatchObject({ bank: { ...h.bank, location: { kind: "remote", origin: h.forge.origin, repository: "david/maya-memory" }, credential: "forge", status: expect.objectContaining({ landing: expect.objectContaining({ state: "awaiting-review" }) }) }, review: { state: "awaiting-review" }, followUps: [{ path: "issues/sensor.md", title: "Repair the sensor", body: followUp, issue: null }] });
  expect(h.forge.requests.filter((r) => r.path === "/api/v1/user/repos").map((r) => r.body)).toEqual([{ name: "maya-memory", private: true }]);
  expect(h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).map((e) => e.type)).toEqual(expect.arrayContaining(["bank.updated", "bank.awaiting-review"]));
  expect(git(h.bare, "rev-parse", "main").trim()).toBe(head);
  expect(git(h.bare, "rev-list", "--count", "main").trim()).toBe("2");
  expect(git(h.bare, "show", "main:projects/personal/homelab/memories/deploys/rollback-steps.md")).toBe(git(h.checkout, "show", "main:projects/personal/homelab/memories/deploys/rollback-steps.md"));
  expect(git(h.bare, "show", "main:BANK.md")).toContain("land: commit");
  const held = h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).find((e) => e.type === "bank.review-held")!;
  expect(git(h.bare, "show", `${held.payload["head"]}:BANK.md`)).toContain("land: pull-request");
  expect(git(h.bare, "show", `${held.payload["head"]}:.forgejo/workflows/validate.yml`)).toContain("node .agent-harness/validate.mjs");
  expect(h.forge.requests.some((r) => r.path.endsWith("/issues") && r.method === "POST")).toBe(false);
  expect(h.forge.requests.some((r) => r.path.endsWith("/merge"))).toBe(false);
  expect(git(h.checkout, "remote", "get-url", "origin").trim()).toBe(`${h.forge.origin}/david/maya-memory.git`);
  expect((await h.client.request("banks.publish", params)).receipt).toEqual(answer.receipt);
  expect(h.forge.requests.filter((r) => r.path === "/api/v1/user/repos")).toHaveLength(1);
  await expect(h.client.request("banks.publish", { ...params, commandId: randomUUID() })).rejects.toMatchObject({ code: "conflict", message: `${h.bank.name} is already on a forge.`, data: { reason: "not_local_only" } });
});

it("refuses a follow-up holding a secret in plain words, its path in data, before making a repository", async () => {
  const h = await start();
  writeFileSync(join(h.checkout, "issues", "leak.md"), `# Rotate the token\n\nThe token is ${TOKEN}.\n`);
  git(h.checkout, "add", "--all");
  git(h.checkout, "commit", "--quiet", "-m", "Note a follow-up.");
  await expect(h.client.request("banks.publish", { commandId: randomUUID(), bankId: h.bank.id })).rejects.toMatchObject({
    code: "secret_shaped",
    message: `${h.bank.name} holds something that looks like a password. Take it out before it moves to your forge.`,
    data: { rule: "registered-value", field: "issues/leak.md" },
  });
  expect(h.forge.requests.some((r) => r.path === "/api/v1/user/repos")).toBe(false);
});

it("copies follow-ups into tracker issues only with an explicit choice, retaining their checklist", async () => {
  const h = await start();
  h.forge.answer(TOKEN, "POST /api/v1/repos/david/maya-memory/issues", (request) => {
    const body = request.body as { title: string; body: string };
    return { status: 201, body: { number: 1, ...body, state: "open", html_url: `${h.forge.origin}/david/maya-memory/issues/1` } };
  });
  const answer = await h.client.request("banks.publish", { commandId: randomUUID(), bankId: h.bank.id, transferIssues: true });
  expect(answer.result!.followUps).toEqual([{ path: "issues/sensor.md", title: "Repair the sensor", body: followUp, issue: `${h.forge.origin}/david/maya-memory/issues/1` }]);
  expect(h.forge.requests.filter((r) => r.path.endsWith("/issues") && r.method === "POST").map((r) => r.body)).toEqual([{ title: "Repair the sensor", body: followUp }]);
  expect(git(h.checkout, "show", "HEAD:issues/sensor.md")).toBe(followUp);
});

it("reconciles the first change only after the personal owner manually merges it, including after restart", async () => {
  const h = await start();
  const answer = await h.client.request("banks.publish", { commandId: randomUUID(), bankId: h.bank.id });
  expect((await h.client.request("banks.verify", { bankId: h.bank.id })).banks[0]?.status.landing.state).toBe("awaiting-review");
  const held = h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).find((e) => e.type === "bank.review-held")!;
  const head = held.payload["head"] as string;
  const branch = git(h.bare, "for-each-ref", "--format=%(refname:short)", "refs/heads/memory/").trim();
  await h.t.close();
  h.forge.pullRequest(TOKEN, "david/maya-memory", 1, { head: branch, sha: head, author: "david", state: "merged" });
  git(h.bare, "update-ref", "refs/heads/main", head);
  const t = await startTestEnvironment({ dataDir: h.t.dataDir, forgeFetch: h.forge.fetch, harnessCommand: [h.helper] });
  onCleanup(() => t.close());
  const client = await t.client();
  expect((await client.request("banks.verify", { bankId: h.bank.id })).banks[0]?.status.landing.state).toBe("ok");
  expect(git(h.checkout, "show", "HEAD:BANK.md")).toContain("land: pull-request");
  expect(git(h.checkout, "rev-list", "--count", "HEAD").trim()).toBe("3");
  expect(answer.result!.bank.id).toBe(h.bank.id);
  expect(t.env.log.readStream({ kind: "environment", id: t.env.id }).some((e) => e.type === "bank.landed")).toBe(true);
});

it("refuses publication while a local landing is held without creating a remote repository", async () => {
  const h = await start();
  const gate = tempDir();
  const ready = join(gate, "ready");
  const release = join(gate, "release");
  // Hold the reader after readiness so release can arrive before it starts reading.
  const reader = join(gate, "reader");
  execFileSync("mkfifo", [release, reader]);
  const readerDescriptor = openSync(reader, constants.O_RDWR | constants.O_NONBLOCK);
  const descriptor = openSync(release, constants.O_RDWR | constants.O_NONBLOCK);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapper = join(gate, "git");
  writeFileSync(wrapper, `#!/bin/sh\nfor arg do\n  if [ "$arg" = commit ]; then exec 3< '${release}'; touch '${ready}'; read ignored < '${reader}'; read ignored <&3; exec 3<&-; fi\ndone\nexec '${realGit}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  const previousPath = process.env["PATH"];
  process.env["PATH"] = `${gate}:${previousPath}`;
  const landing = h.t.env.banks.landChanges(h.bank.id, { title: "Keep a local change", body: "A local landing.", writes: { "README.md": "Local change.\n" } });
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: WAIT_MS });
    await expect(h.client.request("banks.publish", { commandId: randomUUID(), bankId: h.bank.id })).rejects.toMatchObject({ code: "conflict", message: `${h.bank.name} is saving a change. Try again in a moment.`, data: { reason: "landing_in_progress" } });
    expect(h.forge.requests.some((r) => r.path === "/api/v1/user/repos")).toBe(false);
  } finally {
    try {
      writeSync(descriptor, "continue\n");
      writeSync(readerDescriptor, "read\n");
      const result = await landing;
      expect(result, JSON.stringify(result)).toMatchObject({ state: "landed" });
    } finally {
      closeSync(descriptor);
      closeSync(readerDescriptor);
      process.env["PATH"] = previousPath;
    }
  }
});

it("refuses a publication path that is a symlink without overwriting its target", async () => {
  const h = await start();
  const outside = tempDir();
  const workflow = join(outside, "workflows");
  mkdirSync(workflow);
  const sentinel = join(workflow, "validate.yml");
  writeFileSync(sentinel, "Keep the outside file.\n");
  symlinkSync(outside, join(h.checkout, ".forgejo"));
  git(h.checkout, "add", "--all");
  git(h.checkout, "commit", "--quiet", "-m", "A path publication must refuse.");
  await expect(h.client.request("banks.publish", { commandId: randomUUID(), bankId: h.bank.id })).rejects.toMatchObject({
    code: "invalid_params",
    message: `A file in ${h.bank.name}'s folder is not a plain file, so it cannot move.`,
    data: { details: [expect.stringMatching(/ is not a (regular file|directory)\.$/)] },
  });
  expect(readFileSync(sentinel, "utf8")).toBe("Keep the outside file.\n");
  expect(h.forge.requests.some((r) => r.path === "/api/v1/user/repos")).toBe(false);
});
