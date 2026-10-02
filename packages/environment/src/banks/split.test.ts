import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { startFakeForge } from "../../test/fake-forge.js";
import { added, DAVID, TOKEN } from "../../test/forge.js";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { PERSONAL_BANK, memory, markdown, personalManifest } from "../../../contracts/test/fixture-banks.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { git } from "../../test/workspaces.js";

const { onCleanup, tempDir } = useCleanups();
const pointer = "maya-memory:personal/homelab/";
const folder = "projects/personal/homelab/";
const files = {
  ...PERSONAL_BANK,
  ...Object.fromEntries(Array.from({ length: 41 }, (_, i) => {
    const name = `${i < 21 ? "backup" : "network"}-fact-${i + 1}`;
    return [`${folder}memories/${name}.md`, memory(name, { body: "Keep [[backup-schedule]] and [[rollback-steps]] as memory links.\n" })];
  })),
};
const start = async (remote = false, bankFiles: Readonly<Record<string, string>> = files, role: "read-write" | "read-only" = "read-write") => {
  const checkout = tempDir("bank-split-");
  for (const [path, text] of Object.entries(bankFiles)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), text);
  }
  git(checkout, "init", "--quiet", "--initial-branch=main");
  git(checkout, "add", "--all");
  git(checkout, "commit", "--quiet", "-m", "A crowded bank.");
  const forge = remote ? await startFakeForge() : null;
  let originRepo: string | null = null;
  if (forge) {
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    forge.repository(TOKEN, "maya/memory");
    originRepo = join(tempDir("split-origin-"), "memory.git");
    git(checkout, "clone", "--bare", checkout, originRepo);
    git(checkout, "remote", "add", "origin", `${forge.origin}/maya/memory.git`);
  }
  const helper = join(tempDir("split-helper-"), "helper.mjs");
  writeFileSync(helper, "process.exit(0);\n");
  const t = await startTestEnvironment(forge && originRepo ? { harnessCommand: [process.execPath, helper], forgeFetch: forge.fetch, harnessGitConfig: [[`url.${pathToFileURL(originRepo).href}.insteadOf`, `${forge.origin}/maya/memory.git`]] } : {});
  onCleanup(() => t.close());
  const client = await t.client();
  if (forge) await added(client, { url: forge.origin, kind: "forgejo" });
  const bankId = randomUUID();
  expect((await client.request("banks.register", { commandId: randomUUID(), bankId, path: checkout, role, accounts: "all", repositories: "all", defaultFor: [] })).receipt.status).toBe("accepted");
  return { t, client, checkout, bankId, forge, remote: originRepo };
};

it("proposes deterministic name-prefix clusters from an over-cap folder without changing files or landing", async () => {
  const h = await start();
  const head = git(h.checkout, "rev-parse", "HEAD");
  const proposal = await h.client.request("banks.split.propose", { pointer });
  expect(proposal).toMatchObject({ pointer, count: 43, clusters: [
    { prefix: "backup", memories: expect.arrayContaining(["backup-schedule", "backup-fact-1", "backup-fact-21"]) },
    { prefix: "network", memories: expect.arrayContaining(["network-fact-22", "network-fact-41"]) },
  ] });
  expect(proposal.clusters[0]?.memories).toHaveLength(22);
  expect(proposal.clusters[1]?.memories).toHaveLength(20);
  expect(await h.client.request("banks.split.propose", { pointer })).toEqual(proposal);
  expect(git(h.checkout, "rev-parse", "HEAD")).toBe(head);
  expect(git(h.checkout, "status", "--porcelain")).toBe("");
  expect(h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).some((event) => event.type === "bank.review-held" || event.type === "bank.landed")).toBe(false);
});

it.each(["personal", "team"])("requires an authored map and preserves names, links and counts after the %s review path", async (kind) => {
  const h = await start(true, kind === "team" ? { ...files, "BANK.md": markdown(personalManifest({ kind: "team", owners: ["david", "sam"] })) } : files);
  const forge = h.forge!;
  const remote = h.remote!;
  let branch = "";
  let sha = "";
  forge.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls", (request) => {
    branch = (request.body as { head: string }).head;
    sha = git(remote, "rev-parse", branch).trim();
    forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, author: "david" });
    forge.validateCheck(TOKEN, "maya/memory", sha, "success");
    forge.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls/1/merge", () => {
      git(remote, "update-ref", "refs/heads/main", sha);
      return { status: 200 };
    });
    return { status: 201, body: { number: 1, title: "Split", state: "open", user: { login: "david" }, head: { ref: branch, sha, repo: { full_name: "maya/memory" } }, base: { ref: "main" }, html_url: `${forge.origin}/maya/memory/pulls/1` } };
  });
  const proposal = await h.client.request("banks.split.propose", { pointer });
  expect(forge.requests.some((request) => request.method === "POST" && request.path.endsWith("/pulls"))).toBe(false);
  const command = { commandId: randomUUID(), pointer, topics: Object.fromEntries(proposal.clusters.map((cluster) => [cluster.prefix, { line: `Facts about ${cluster.prefix}`, memories: cluster.memories }])) };
  const applied = await h.client.request("banks.split.apply", command);
  expect(applied.receipt.status).toBe("accepted");
  expect(applied.result?.landing, JSON.stringify(applied.result)).toMatchObject({ state: "awaiting-review", pullRequest: `${forge.origin}/maya/memory/pulls/1` });
  expect((await h.client.request("banks.split.apply", command)).receipt).toEqual(applied.receipt);
  expect(forge.requests.filter((request) => request.method === "POST" && request.path.endsWith("/pulls"))).toHaveLength(1);
  expect(forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
  expect(git(h.checkout, "show", `HEAD:${folder}memories/backup-fact-1.md`)).toBe(files[`${folder}memories/backup-fact-1.md`]);
  expect(git(remote, "show", `${sha}:${folder}memories/backup/backup-fact-1.md`)).toBe(files[`${folder}memories/backup-fact-1.md`]);
  expect(git(remote, "show", `${sha}:${folder}PROJECT.md`)).toContain("deploys:");
  expect(git(remote, "show", `${sha}:${folder}PROJECT.md`)).toContain("# The folder");
  if (kind === "team") forge.reviews(TOKEN, "maya/memory", 1, [{ login: "sam", state: "APPROVED", commit: sha }]);
  else {
    git(remote, "update-ref", "refs/heads/main", sha);
    forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, state: "merged" });
  }
  await h.client.request("banks.verify", { bankId: h.bankId });
  expect((await h.client.request("banks.get", { bankId: h.bankId })).bank).toMatchObject({ memories: 46, status: { landing: { state: "ok" } } });
  const root = await h.client.request("banks.memory.read", { repositoryIdentity: null, pointer: "maya-memory" });
  expect(root.text).toContain(`${pointer} (43)`);
  expect(root.text).not.toContain("memories/backup/");
  const read = await h.client.request("banks.memory.read", { repositoryIdentity: null, pointer });
  expect(read.text).toContain("maya-memory:personal/homelab/memories/backup/ (22)");
  expect(read.text).toContain("maya-memory:personal/homelab/memories/network/ (20)");
  expect(read.text).toContain("maya-memory:personal/homelab/memories/deploys/ (1)");
  expect((await h.client.request("banks.memory.read", { repositoryIdentity: null, pointer: "maya-memory:backup-fact-1" })).text).toContain("[[backup-schedule]] and [[rollback-steps]]");
  expect(git(h.checkout, "status", "--porcelain")).toBe("");
});

it("refuses an accepted topic over forty lines through the common validator before opening a reviewed change", async () => {
  const h = await start(true);
  const proposal = await h.client.request("banks.split.propose", { pointer });
  const head = git(h.checkout, "rev-parse", "HEAD");
  await expect(h.client.request("banks.split.apply", { commandId: randomUUID(), pointer, topics: { everything: { line: "All the facts", memories: proposal.clusters.flatMap((cluster) => cluster.memories) } } })).rejects.toMatchObject({ code: "validation_failed", data: { rules: expect.arrayContaining(["index_over_cap"]) } });
  expect(h.forge!.requests.some((request) => request.method === "POST" && request.path.endsWith("/pulls"))).toBe(false);
  expect(git(h.checkout, "rev-parse", "HEAD")).toBe(head);
});

it("refuses empty acceptance, duplicate assignments, missing or already nested memories and read-only writes", async () => {
  const h = await start();
  const topic = { line: "Backup facts", memories: ["backup-schedule"] };
  for (const topics of [{}, { first: topic, second: topic }, { backup: { ...topic, memories: ["missing"] } }, { backup: { ...topic, memories: ["rollback-steps"] } }]) {
    await expect(h.client.request("banks.split.apply", { commandId: randomUUID(), pointer, topics })).rejects.toMatchObject({ code: "invalid_params" });
  }
  const readonly = await start(false, files, "read-only");
  expect((await readonly.client.request("banks.split.propose", { pointer })).count).toBe(43);
  await expect(readonly.client.request("banks.split.apply", { commandId: randomUUID(), pointer, topics: { backup: topic } })).rejects.toMatchObject({ code: "bank_read_only" });
});

it("refuses a split prepared from stale main without replacing an intervening folder edit", async () => {
  const h = await start(true);
  const proposal = await h.client.request("banks.split.propose", { pointer });
  const other = tempDir("split-other-author-");
  git(other, "clone", h.remote!, ".");
  writeFileSync(join(other, `${folder}PROJECT.md`), files[`${folder}PROJECT.md`]!.replace("Maya's homelab:", "The updated homelab:"));
  git(other, "add", "--all");
  git(other, "commit", "--quiet", "-m", "Update the folder's line.");
  git(other, "push", "--quiet", "origin", "main");
  const answer = await h.client.request("banks.split.apply", { commandId: randomUUID(), pointer, topics: Object.fromEntries(proposal.clusters.map((cluster) => [cluster.prefix, { line: cluster.prefix, memories: cluster.memories }])) });
  expect(answer.result?.landing).toMatchObject({ state: "failed", reason: expect.stringContaining("main changed") });
  expect(h.forge!.requests.some((request) => request.method === "POST" && request.path.endsWith("/pulls"))).toBe(false);
  expect(git(h.remote!, "show", `main:${folder}PROJECT.md`)).toContain("The updated homelab:");
});

it("splits an area in a local-only bank and keeps unselected memories and the artefact body intact", async () => {
  const area = `${folder}nas/`;
  const areaFiles = { ...PERSONAL_BANK, "BANK.md": markdown(personalManifest()).replace("land: pull-request", "land: commit"), [`${area}memories/nas-temperature.md`]: memory("nas-temperature") };
  const h = await start(false, areaFiles);
  const areaPointer = "maya-memory:personal/homelab/nas/";
  expect((await h.client.request("banks.split.propose", { pointer: areaPointer })).clusters).toEqual([{ prefix: "nas", memories: ["nas-disk-layout", "nas-temperature"] }]);
  const answer = await h.client.request("banks.split.apply", { commandId: randomUUID(), pointer: areaPointer, topics: { disks: { line: "Disk facts", memories: ["nas-disk-layout"] } } });
  expect(answer.result?.landing).toMatchObject({ state: "landed", files: expect.arrayContaining([{ path: `${area}AREA.md`, state: "present" }, { path: `${area}memories/nas-disk-layout.md`, state: "removed" }, { path: `${area}memories/disks/nas-disk-layout.md`, state: "present" }]) });
  expect(git(h.checkout, "show", `HEAD:${area}memories/nas-temperature.md`)).toBe(areaFiles[`${area}memories/nas-temperature.md`]);
  expect(git(h.checkout, "show", `HEAD:${area}AREA.md`)).toContain("# The folder");
});
