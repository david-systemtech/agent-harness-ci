import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { BANK_VALIDATOR_DIST, buildBankValidator } from "../../../contracts/scripts/bank-validator/build.js";
import { PERSONAL_BANK, markdown, personalManifest } from "../../../contracts/test/fixture-banks.js";
import { startFakeForge } from "../../test/fake-forge.js";
import { added, DAVID, TOKEN } from "../../test/forge.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import { git } from "../../test/workspaces.js";
import { TEAM_MIGRATION_CHOICES, TEAM_MIGRATION_FIXTURE } from "../../test/team-migration-fixture.js";

const { tempDir, onCleanup } = useCleanups();
beforeAll(async () => {
  mkdirSync(dirname(BANK_VALIDATOR_DIST), { recursive: true });
  await buildBankValidator({ outFile: BANK_VALIDATOR_DIST });
});
const fixture: Record<string, string> = { ...PERSONAL_BANK, "BANK.md": markdown(personalManifest({ description: "Private machines and projects", purpose: undefined, kind: undefined, entities: undefined, orientation: undefined, index: { file: "INDEX.md" } })), "INDEX.md": "Generated index\n", ".forgejo/workflows/old.yml": "name: old\njobs:\n  check:\n    steps:\n      - run: python -m bank check\n" };
const start = async (remote = false, role: "read-write" | "read-only" = "read-write", files = fixture, github = false) => {
  const checkout = tempDir("migration-bank-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), text);
  }
  git(checkout, "init", "--quiet", "--initial-branch=main");
  git(checkout, "add", "--all");
  git(checkout, "commit", "--quiet", "-m", "A synthetic bank before conversion.");
  const forge = remote ? await startFakeForge() : null;
  let originRepo: string | null = null;
  if (forge) {
    onCleanup(() => forge.close());
    forge.user(TOKEN, DAVID);
    forge.repository(TOKEN, "maya/memory");
    originRepo = join(tempDir("migration-origin-"), "memory.git");
    git(checkout, "clone", "--bare", checkout, originRepo);
    git(checkout, "remote", "add", "origin", `${forge.origin}/maya/memory.git`);
  }
  const helper = join(tempDir("migration-helper-"), "helper.mjs");
  writeFileSync(helper, "process.exit(0);\n");
  const t = await startTestEnvironment(forge && originRepo ? { harnessCommand: [process.execPath, helper], forgeFetch: forge.fetch, harnessGitConfig: [[`url.${pathToFileURL(originRepo).href}.insteadOf`, `${forge.origin}/maya/memory.git`]] } : {});
  onCleanup(() => t.close());
  const client = await t.client();
  if (forge) await added(client, { url: forge.origin, kind: github ? "github" : "forgejo" });
  const bankId = randomUUID();
  await client.request("banks.register", { commandId: randomUUID(), bankId, path: checkout, role, accounts: "all", repositories: "all", defaultFor: [] });
  return { checkout, bankId, client, t, forge, remote: originRepo };
};

it("prepares an idempotent admin dry run of committed files without branches, worktrees, events or forge writes", async () => {
  const h = await start(true);
  const head = git(h.checkout, "rev-parse", "HEAD");
  const refs = git(h.checkout, "show-ref");
  const worktrees = git(h.checkout, "worktree", "list", "--porcelain");
  writeFileSync(join(h.checkout, "INDEX.md"), "Keep this uncommitted content.\n");
  const status = git(h.checkout, "status", "--porcelain");
  const command = { commandId: randomUUID(), bankId: h.bankId, dryRun: true, choices: { retiredWorkflows: [".forgejo/workflows/old.yml"], secretScan: "bash scripts/scan-secrets.sh" } };
  const answer = await h.client.request<"banks.migrate">("banks.migrate", command);
  expect(answer.receipt.status).toBe("accepted");
  expect(answer.result).toMatchObject({ landing: null, report: { valid: true, memories: { before: 5, after: 6, added: 1 }, moves: [] } });
  expect((await h.client.request<"banks.migrate">("banks.migrate", command)).receipt).toEqual(answer.receipt);
  expect(git(h.checkout, "rev-parse", "HEAD")).toBe(head);
  expect(git(h.checkout, "show-ref")).toBe(refs);
  expect(git(h.checkout, "worktree", "list", "--porcelain")).toBe(worktrees);
  expect(git(h.checkout, "status", "--porcelain")).toBe(status);
  expect(h.forge!.requests.some((r) => r.method === "POST" && r.path.endsWith("/pulls"))).toBe(false);
  expect(h.t.env.log.readStream({ kind: "environment", id: h.t.env.id }).some((e) => e.type === "bank.review-held" || e.type === "bank.landed")).toBe(false);
});

it("prepares the team conversion and draft on a copy, then lets a fake human post the heads-up before the unmerged PR", async () => {
  const h = await start(true, "read-write", TEAM_MIGRATION_FIXTURE, true);
  const forge = h.forge!;
  const head = git(h.checkout, "rev-parse", "HEAD");
  const refs = git(h.checkout, "show-ref");
  const worktrees = git(h.checkout, "worktree", "list", "--porcelain");
  const command = { commandId: randomUUID(), bankId: h.bankId, dryRun: true, choices: TEAM_MIGRATION_CHOICES };
  const dry = await h.client.request<"banks.migrate">("banks.migrate", command);
  expect(dry.result).toMatchObject({ landing: null, report: { valid: true, memories: { before: 4, after: 5, added: 1 }, preservation: { names: true, links: true, counts: true } } });
  expect(git(h.checkout, "show-ref")).toBe(refs);
  expect(git(h.checkout, "worktree", "list", "--porcelain")).toBe(worktrees);
  expect(forge.requests.filter((request) => request.method === "POST" && /\/(issues|pulls)$/.test(request.path))).toEqual([]);
  const draft = dry.result!.report.headsUp!;
  forge.answer(TOKEN, "POST /api/v3/repos/maya/memory/issues", { status: 201, body: { number: 2, ...draft, state: "open", html_url: `${forge.origin}/maya/memory/issues/2` } });
  // This explicit call stands for David; banks.migrate never posts the draft.
  expect(await h.t.env.forge.issues.create({ origin: forge.origin, repository: "maya/memory", purpose: "Post the approved fixture heads-up", ...draft })).toMatchObject({ outcome: "done", value: { number: 2, body: expect.stringContaining("No landing date is set") } });
  let sha = "";
  forge.answer(TOKEN, "POST /api/v3/repos/maya/memory/pulls", (request) => {
    const branch = (request.body as { head: string }).head;
    sha = git(h.remote!, "rev-parse", branch).trim();
    forge.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, author: "david" });
    return { status: 201, body: { number: 1, title: "Team migration", state: "open", user: { login: "david" }, head: { ref: branch, sha, repo: { full_name: "maya/memory" } }, base: { ref: "main" }, html_url: `${forge.origin}/maya/memory/pulls/1` } };
  });
  const submitted = { ...command, commandId: randomUUID(), dryRun: false };
  const answer = await h.client.request<"banks.migrate">("banks.migrate", submitted);
  expect(answer.result?.landing).toMatchObject({ state: "awaiting-review", pullRequest: `${forge.origin}/maya/memory/pulls/1` });
  expect((await h.client.request<"banks.migrate">("banks.migrate", submitted)).receipt).toEqual(answer.receipt);
  expect(forge.requests.filter((request) => request.method === "POST" && /\/(issues|pulls)$/.test(request.path)).map((request) => request.path)).toEqual(["/api/v3/repos/maya/memory/issues", "/api/v3/repos/maya/memory/pulls"]);
  expect(forge.requests.some((request) => request.path.endsWith("/merge"))).toBe(false);
  expect(git(h.remote!, "rev-parse", "main")).toBe(head);
  expect(git(h.checkout, "rev-parse", "HEAD")).toBe(head);
  expect(git(h.remote!, "show", `${sha}:BANK.md`)).toContain("david-systemtech");
  expect(git(h.remote!, "show", `${sha}:.github/workflows/validate.yml`)).toContain("node .agent-harness/validate.mjs");
  expect(git(h.remote!, "show", `${sha}:.github/workflows/secrets.yml`)).toContain("gitleaks");
  expect(git(h.remote!, "show", `${sha}:.agent-harness/validate.mjs`)).toContain("bank-validator");
  expect(git(h.remote!, "show", `${sha}:projects/meadowstudios/sample-brand/product/memories/sample-line/product-fact.md`)).toBe(TEAM_MIGRATION_FIXTURE["brands/sample-brand/product/sample-line/memories/product-fact.md"]);
});

it("opens one reviewed migration PR on the fake forge without merging or changing source main", async () => {
  const h = await start(true);
  const head = git(h.checkout, "rev-parse", "HEAD");
  let sha = "";
  h.forge!.answer(TOKEN, "POST /api/v1/repos/maya/memory/pulls", (request) => {
    const branch = (request.body as { head: string }).head;
    sha = git(h.remote!, "rev-parse", branch).trim();
    h.forge!.pullRequest(TOKEN, "maya/memory", 1, { head: branch, sha, author: "david" });
    return { status: 201, body: { number: 1, title: "Migration", state: "open", user: { login: "david" }, head: { ref: branch, sha, repo: { full_name: "maya/memory" } }, base: { ref: "main" }, html_url: `${h.forge!.origin}/maya/memory/pulls/1` } };
  });
  const command = { commandId: randomUUID(), bankId: h.bankId, dryRun: false, choices: { retiredWorkflows: [".forgejo/workflows/old.yml"] } };
  const answer = await h.client.request<"banks.migrate">("banks.migrate", command);
  expect(answer.result?.landing, JSON.stringify(answer.result)).toMatchObject({ state: "awaiting-review", pullRequest: `${h.forge!.origin}/maya/memory/pulls/1` });
  expect((await h.client.request<"banks.migrate">("banks.migrate", command)).receipt).toEqual(answer.receipt);
  expect(h.forge!.requests.filter((r) => r.method === "POST" && r.path.endsWith("/pulls"))).toHaveLength(1);
  expect(h.forge!.requests.some((r) => r.path.endsWith("/merge"))).toBe(false);
  expect(git(h.checkout, "rev-parse", "HEAD")).toBe(head);
  expect(git(h.remote!, "rev-parse", "main")).toBe(head);
  expect(git(h.remote!, "show", `${sha}:BANK.md`)).toContain("purpose:");
  expect(git(h.remote!, "show", `${sha}:.forgejo/workflows/validate.yml`)).toContain("node .agent-harness/validate.mjs");
  expect(git(h.remote!, "show", `${sha}:.agent-harness/validate.mjs`)).toContain("bank-validator");
  expect(git(h.remote!, "ls-tree", "-r", "--name-only", sha)).not.toContain("INDEX.md");
  expect(git(h.remote!, "ls-tree", "-r", "--name-only", sha)).not.toContain("old.yml");
  expect(git(h.remote!, "show", `${sha}:projects/personal/homelab/memories/backup-schedule.md`)).toBe(fixture["projects/personal/homelab/memories/backup-schedule.md"]);
});

it("allows read-only and local dry runs but refuses their PR writes and unresolved conversion decisions", async () => {
  const h = await start(true, "read-only");
  const choices = { retiredWorkflows: [".forgejo/workflows/old.yml"] };
  expect((await h.client.request<"banks.migrate">("banks.migrate", { commandId: randomUUID(), bankId: h.bankId, dryRun: true, choices })).result?.report.valid).toBe(true);
  await expect(h.client.request<"banks.migrate">("banks.migrate", { commandId: randomUUID(), bankId: h.bankId, dryRun: false, choices })).rejects.toMatchObject({ code: "bank_read_only" });
  const local = await start();
  expect((await local.client.request<"banks.migrate">("banks.migrate", { commandId: randomUUID(), bankId: local.bankId, dryRun: true, choices })).result?.landing).toBeNull();
  await expect(local.client.request<"banks.migrate">("banks.migrate", { commandId: randomUUID(), bankId: local.bankId, dryRun: false, choices })).rejects.toMatchObject({ code: "invalid_params" });
  const writable = await start(true);
  expect((await writable.client.request<"banks.migrate">("banks.migrate", { commandId: randomUUID(), bankId: writable.bankId, dryRun: true })).result?.report.decisions).toContainEqual(expect.objectContaining({ path: ".forgejo/workflows/old.yml" }));
  await expect(writable.client.request<"banks.migrate">("banks.migrate", { commandId: randomUUID(), bankId: writable.bankId, dryRun: false })).rejects.toMatchObject({ code: "invalid_params" });
});

it("returns common validator findings on a dry run and refuses invalid conversion before any PR", async () => {
  const h = await start(true);
  const path = "projects/personal/homelab/memories/backup-schedule.md";
  writeFileSync(join(h.checkout, path), fixture[path]!.replace("When a backup is missing - the nightly schedule and its logs", "Too short"));
  git(h.checkout, "add", "--all");
  git(h.checkout, "commit", "--quiet", "-m", "A synthetic invalid description.");
  const choices = { retiredWorkflows: [".forgejo/workflows/old.yml"] };
  const dry = await h.client.request<"banks.migrate">("banks.migrate", { commandId: randomUUID(), bankId: h.bankId, dryRun: true, choices });
  expect(dry.result?.report).toMatchObject({ valid: false, findings: expect.arrayContaining([expect.objectContaining({ rule: "description_length", path })]) });
  await expect(h.client.request("banks.migrate", { commandId: randomUUID(), bankId: h.bankId, dryRun: false, choices })).rejects.toMatchObject({ code: "validation_failed", data: { rules: expect.arrayContaining(["description_length"]) } });
  expect(h.forge!.requests.some((r) => r.method === "POST" && r.path.endsWith("/pulls"))).toBe(false);
});

it("refuses a plan prepared from stale main without overwriting another author's edit", async () => {
  const h = await start(true);
  const other = tempDir("migration-other-author-");
  git(other, "clone", h.remote!, ".");
  writeFileSync(join(other, "BANK.md"), fixture["BANK.md"]!.replace("Private machines and projects", "Updated private machines and projects"));
  git(other, "add", "--all");
  git(other, "commit", "--quiet", "-m", "Update the bank's description.");
  git(other, "push", "--quiet", "origin", "main");
  const answer = await h.client.request<"banks.migrate">("banks.migrate", { commandId: randomUUID(), bankId: h.bankId, dryRun: false, choices: { retiredWorkflows: [".forgejo/workflows/old.yml"] } });
  expect(answer.result?.landing).toMatchObject({ state: "failed", reason: expect.stringContaining("main changed") });
  expect(h.forge!.requests.some((r) => r.method === "POST" && r.path.endsWith("/pulls"))).toBe(false);
  expect(git(h.remote!, "show", "main:BANK.md")).toContain("Updated private machines and projects");
});
