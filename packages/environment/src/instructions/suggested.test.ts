import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOGUE,
  CATALOGUE_SEED_INSTRUCTION_ID,
  Catalogue,
  Ceiling,
  registry,
  type CatalogueInstructionEntry,
  type MethodName,
  type ParamsOf,
  type ResponseOf,
  type Scope,
} from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Suggested instructions through the primary seam (skills-instructions
 * spec, "Owned instructions" and "Testing Decisions"; ADR 0030, ADR 0019;
 * #509): the in-process environment with its catalogue behind the seam a
 * test swaps for one holding a newer version, and a scratch session tagged
 * as the Instructions step mints one, with a Markdown file written into its
 * workspace. What is asserted is what the commands answer and append, and
 * what instructions.list and instructions.diff answer.
 */

const { onCleanup } = useCleanups();

const ENTRY = "coding.fresh-checkout";
const TEXTS = ["Pull before you read code.", "Pull, or clone fresh, before you read code.", "Clone fresh before you read code, and name the commit."] as const;

/** This build's catalogue with the fresh-checkout entry at `version` (1 to 3), every earlier text kept. */
const catalogueAt = (version: 1 | 2 | 3): Catalogue => {
  const entries = CATALOGUE.instructions.entries.map(
    (entry): CatalogueInstructionEntry =>
      entry.id === ENTRY
        ? { ...entry, version, text: TEXTS[version - 1] ?? "", earlierVersions: TEXTS.slice(0, version - 1).map((text, index) => ({ version: index + 1, text })) }
        : entry,
  );
  return Catalogue.parse({ ...CATALOGUE, instructions: { ...CATALOGUE.instructions, entries } });
};

const start = async () => {
  const catalogue = { now: catalogueAt(1) };
  const t = await startTestEnvironment({ accounts: [{ id: "claude-max", provider: "fake" }], orientation: () => ({ text: "# Orientation", unreadRegistries: [] }), catalogue: () => catalogue.now });
  onCleanup(() => t.close());
  return { t, catalogue };
};

type Command = Extract<MethodName, `instructions.${string}`> &
  (
    | "instructions.create"
    | "instructions.edit"
    | "instructions.setEnabled"
    | "instructions.resolveVersion"
    | "instructions.remove"
    | "instructions.dismissSuggestion"
    | "instructions.restoreSuggestion"
    | "instructions.import"
  );

const command = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** Ticks the catalogue entry `catalogueId`, and resolves with the copy. */
const tick = async (client: WireClient, catalogueId: string) => {
  const answer = await command(client, "instructions.create", { id: randomUUID(), catalogueId });
  if (answer.result === undefined) throw new Error(`instructions.create was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.instruction;
};

const list = async (client: WireClient) => registry["instructions.list"].result.parse(await client.request("instructions.list", {}));
const diff = async (client: WireClient, instructionId: string) => registry["instructions.diff"].result.parse(await client.request("instructions.diff", { instructionId }));
const typesOf = (t: TestEnvironment) => t.env.log.readStream({ kind: "instructions", id: t.env.id }).map((event) => event.type);
const payloadsOf = (t: TestEnvironment) => t.env.log.readStream({ kind: "instructions", id: t.env.id }).map((event) => [event.type, event.payload]);

const narrowClient = (t: TestEnvironment, scopes: Scope[]) =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a narrow program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

describe("ticking", () => {
  it("copies the entry's current title, text and version into an owned instruction that remembers its origin; an unknown entry is not_found of kind instruction", async () => {
    const { t, catalogue } = await start();
    catalogue.now = catalogueAt(2);
    const client = await t.client();
    const copy = await tick(client, ENTRY);
    expect(copy).toMatchObject({ title: "Read code from a fresh checkout", body: TEXTS[1], origin: { catalogueId: ENTRY, version: 2 }, scope: "all", enabled: true });
    expect((await list(client)).instructions).toEqual([expect.objectContaining({ id: copy.id, newerVersion: null })]);

    const unknown = await command(client, "instructions.create", { id: randomUUID(), catalogueId: "coding.no-such-entry" });
    expect(unknown.receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "instruction", catalogueId: "coding.no-such-entry" } } });
    const both = { commandId: randomUUID(), id: randomUUID(), catalogueId: ENTRY, title: "Mine", body: "" };
    expect((await refusal(client.request("instructions.create", both as ParamsOf<"instructions.create">))).code).toBe("invalid_params");
    expect(typesOf(t)).toEqual(["instructions.created"]);
  });

  it("seeds About my setup from the Setup entry, which is removed and dismissed by the same rule", async () => {
    const { t } = await start();
    const client = await t.client();
    const seed = await tick(client, CATALOGUE_SEED_INSTRUCTION_ID);
    expect(seed).toMatchObject({ title: "About my setup", origin: { catalogueId: CATALOGUE_SEED_INSTRUCTION_ID, version: 1 } });
    await command(client, "instructions.remove", { instructionId: seed.id });
    expect((await list(client)).dismissed).toEqual([CATALOGUE_SEED_INSTRUCTION_ID]);
  });
});

describe("a newer version", () => {
  it("shows as newerVersion on every copy, edited or not, each body unchanged, until replace or keep resolves it, and again at the next version", async () => {
    const { t, catalogue } = await start();
    const client = await t.client();
    const unedited = await tick(client, ENTRY);
    const edited = await tick(client, ENTRY);
    await command(client, "instructions.edit", { instructionId: edited.id, title: edited.title, body: "Pull first. Always." });
    const custom = (await command(client, "instructions.create", { id: randomUUID(), title: "Mine", body: "My own." })).result?.instruction;
    if (custom === undefined) throw new Error("The Custom instruction was not made.");

    catalogue.now = catalogueAt(2);
    const rows = (await list(client)).instructions;
    expect(rows.map((row) => [row.id, row.body, row.origin?.version ?? null, row.newerVersion])).toEqual([
      [unedited.id, TEXTS[0], 1, 2],
      [edited.id, "Pull first. Always.", 1, 2],
      [custom.id, "My own.", null, null],
    ]);

    // See what changed: the catalogue's old text against the new, and the copy against the new.
    const reader = await narrowClient(t, ["read"]);
    expect(await diff(reader, edited.id)).toEqual({ catalogueId: ENTRY, fromVersion: 1, toVersion: 2, from: TEXTS[0], to: TEXTS[1], body: "Pull first. Always." });
    expect(await diff(reader, unedited.id)).toMatchObject({ from: TEXTS[0], to: TEXTS[1], body: TEXTS[0] });
    expect(await refusal(reader.request("instructions.diff", { instructionId: custom.id }))).toMatchObject({ code: "conflict", data: { reason: "no_origin" } });
    expect(await refusal(reader.request("instructions.diff", { instructionId: randomUUID() }))).toMatchObject({ code: "not_found", data: { kind: "instruction" } });
    expect((await refusal(reader.request("instructions.resolveVersion", { commandId: randomUUID(), instructionId: edited.id, choice: "keep" }))).code).toBe("forbidden");

    const replaced = await command(client, "instructions.resolveVersion", { instructionId: unedited.id, choice: "replace" });
    expect(replaced.result?.instruction).toMatchObject({ body: TEXTS[1], origin: { catalogueId: ENTRY, version: 2 } });
    const kept = await command(client, "instructions.resolveVersion", { instructionId: edited.id, choice: "keep" });
    expect(kept.result?.instruction).toMatchObject({ body: "Pull first. Always.", origin: { catalogueId: ENTRY, version: 2 } });
    expect((await list(client)).instructions.map((row) => row.newerVersion)).toEqual([null, null, null]);
    // Resolved already: nothing to append. Custom has no version to resolve.
    expect((await command(client, "instructions.resolveVersion", { instructionId: edited.id, choice: "replace" })).receipt).toMatchObject({ status: "accepted", changed: false });
    expect((await command(client, "instructions.resolveVersion", { instructionId: custom.id, choice: "keep" })).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "no_origin" } },
    });
    expect(payloadsOf(t).filter(([type]) => type === "instructions.version-resolved")).toEqual([
      ["instructions.version-resolved", { id: unedited.id, choice: "replace", version: 2, body: TEXTS[1] }],
      ["instructions.version-resolved", { id: edited.id, choice: "keep", version: 2 }],
    ]);

    catalogue.now = catalogueAt(3);
    expect((await list(client)).instructions.map((row) => row.newerVersion)).toEqual([3, 3, null]);
    expect(await diff(client, edited.id)).toEqual({ catalogueId: ENTRY, fromVersion: 2, toVersion: 3, from: TEXTS[1], to: TEXTS[2], body: "Pull first. Always." });
  });

  it("is held across a restart: a replaced body and a kept version come back from the log", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agent-harness-suggested-"));
    onCleanup(() => rmSync(dataDir, { recursive: true, force: true }));
    const options = { dataDir, accounts: [{ id: "claude-max", provider: "fake" }], orientation: () => ({ text: "# Orientation", unreadRegistries: [] }) };
    const first = await startTestEnvironment({ ...options, catalogue: () => catalogueAt(1) });
    const client = await first.client();
    const copy = await tick(client, ENTRY);
    await first.close();

    const again = await startTestEnvironment({ ...options, catalogue: () => catalogueAt(2) });
    onCleanup(() => again.close());
    const next = await again.client();
    expect((await list(next)).instructions).toEqual([expect.objectContaining({ id: copy.id, body: TEXTS[0], newerVersion: 2 })]);
    await command(next, "instructions.resolveVersion", { instructionId: copy.id, choice: "replace" });
    again.env.log.rebuildProjections();
    expect((await list(next)).instructions).toEqual([expect.objectContaining({ id: copy.id, body: TEXTS[1], origin: { catalogueId: ENTRY, version: 2 }, newerVersion: null })]);
  });
});

describe("removal", () => {
  it("of a copy dismisses its entry, listed for the Dismissed fold, and restoreSuggestion brings it back; switching a copy off dismisses nothing", async () => {
    const { t } = await start();
    const client = await t.client();
    const copy = await tick(client, ENTRY);
    const other = await tick(client, "coding.no-attribution");
    await command(client, "instructions.setEnabled", { instructionId: other.id, enabled: false });
    expect((await list(client)).dismissed).toEqual([]);

    expect(await command(client, "instructions.remove", { instructionId: copy.id })).toMatchObject({ result: { instructionId: copy.id } });
    expect((await list(client)).dismissed).toEqual([ENTRY]);
    expect((await list(client)).instructions.map((row) => row.id)).toEqual([other.id]);
    const restored = await command(client, "instructions.restoreSuggestion", { catalogueId: ENTRY });
    expect(restored.result).toEqual({ catalogueId: ENTRY, dismissed: false });
    expect((await list(client)).dismissed).toEqual([]);
    expect((await command(client, "instructions.restoreSuggestion", { catalogueId: ENTRY })).receipt).toMatchObject({ status: "accepted", changed: false });

    expect(payloadsOf(t).slice(3)).toEqual([
      ["instructions.removed", { id: copy.id }],
      ["instructions.suggestion-dismissed", { catalogueId: ENTRY }],
      ["instructions.suggestion-restored", { catalogueId: ENTRY }],
    ]);
    const notices = t.env.log.readStream({ kind: "environment", id: t.env.id }).filter((event) => event.type === "instructions.updated");
    expect(notices).toHaveLength(5);
  });

  it("of Custom dismisses nothing, and of one of two copies of an entry dismisses it only with the last", async () => {
    const { t } = await start();
    const client = await t.client();
    const custom = (await command(client, "instructions.create", { id: randomUUID(), title: "Mine", body: "" })).result?.instruction;
    await command(client, "instructions.remove", { instructionId: custom?.id ?? "" });
    const first = await tick(client, ENTRY);
    const second = await tick(client, ENTRY);
    await command(client, "instructions.remove", { instructionId: first.id });
    expect((await list(client)).dismissed).toEqual([]);
    await command(client, "instructions.remove", { instructionId: second.id });
    expect((await list(client)).dismissed).toEqual([ENTRY]);
    expect(typesOf(t).filter((type) => type === "instructions.suggestion-dismissed")).toHaveLength(1);
  });

  it("dismissSuggestion dismisses an entry never ticked, refuses one held as a copy, and a dismissed entry never returns by itself; ticking it restores it", async () => {
    const { t, catalogue } = await start();
    const client = await t.client();
    const dismissed = await command(client, "instructions.dismissSuggestion", { catalogueId: "working.ask-with-a-recommendation" });
    expect(dismissed.result).toEqual({ catalogueId: "working.ask-with-a-recommendation", dismissed: true });
    expect((await command(client, "instructions.dismissSuggestion", { catalogueId: "working.ask-with-a-recommendation" })).receipt).toMatchObject({ changed: false });
    const copy = await tick(client, ENTRY);
    expect((await command(client, "instructions.dismissSuggestion", { catalogueId: ENTRY })).receipt).toMatchObject({
      status: "rejected",
      reason: "conflict",
      error: { data: { reason: "ticked", catalogueId: ENTRY, instructionId: copy.id } },
    });
    expect((await command(client, "instructions.dismissSuggestion", { catalogueId: "coding.no-such-entry" })).receipt).toMatchObject({
      status: "rejected",
      reason: "not_found",
      error: { data: { kind: "instruction" } },
    });

    // A newer catalogue build brings nothing back.
    catalogue.now = catalogueAt(3);
    expect((await list(client)).dismissed).toEqual(["working.ask-with-a-recommendation"]);
    const ticked = await tick(client, "working.ask-with-a-recommendation");
    expect((await list(client)).dismissed).toEqual([]);
    expect(payloadsOf(t).slice(-2)).toEqual([
      ["instructions.created", expect.objectContaining({ id: ticked.id, origin: { catalogueId: "working.ask-with-a-recommendation", version: 1 } })],
      ["instructions.suggestion-restored", { catalogueId: "working.ask-with-a-recommendation" }],
    ]);
  });
});

describe("import from a minted session", () => {
  /** A scratch session tagged as the Instructions step mints one, with `files` written into its workspace. */
  const minted = async (client: WireClient, files: Record<string, string>, tags = ["setup", "instructions"]) => {
    const { id, result } = await create(client, { workspace: { kind: "scratch" }, tags });
    const workspace = result?.summary.workspace;
    if (workspace?.kind !== "scratch") throw new Error("The session has no scratch workspace.");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(workspace.path, path, ".."), { recursive: true });
      writeFileSync(join(workspace.path, path), text);
    }
    return { sessionId: id, root: workspace.path };
  };

  const importing = (client: WireClient, params: Omit<ParamsOf<"instructions.import">, "commandId" | "id">) =>
    command(client, "instructions.import", { id: randomUUID(), ...params });

  it("reads a Markdown file in the workspace into an owned instruction titled by its first heading, with the catalogue origin when given", async () => {
    const { t } = await start();
    const client = await t.client();
    const text = "# Fresh checkouts, my way\n\nClone into `~/scratch`, never pull in place.\n\n## Why\n\nMy checkouts drift.\n";
    const { sessionId, root } = await minted(client, { "out/instruction.md": text, "plain.md": "Intro line.\n\n```\n# not a heading\n```\n\n## Plain  ##\n\nBody." });

    const tailored = await importing(client, { sessionId, path: "out/instruction.md", catalogueId: ENTRY });
    expect(tailored.result?.instruction).toMatchObject({
      title: "Fresh checkouts, my way",
      body: "Clone into `~/scratch`, never pull in place.\n\n## Why\n\nMy checkouts drift.",
      origin: { catalogueId: ENTRY, version: 1 },
      scope: "all",
      enabled: true,
    });
    const plain = await importing(client, { sessionId, path: join(root, "plain.md") });
    expect(plain.result?.instruction).toMatchObject({ title: "Plain", body: "Intro line.\n\n```\n# not a heading\n```\n\nBody.", origin: null });
    expect(typesOf(t)).toEqual(["instructions.created", "instructions.created"]);
  });

  it("refuses invalid_params for a path elsewhere, a file that is not Markdown or has no heading, and a session that was not minted", async () => {
    const { t } = await start();
    const client = await t.client();
    const outside = mkdtempSync(join(tmpdir(), "agent-harness-outside-"));
    onCleanup(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "elsewhere.md"), "# Elsewhere\n\nNot mine.");
    const { sessionId, root } = await minted(client, { "notes.txt": "# Notes", "headless.md": "No heading here.", "dir.md/keep.md": "# Inside" });
    symlinkSync(join(outside, "elsewhere.md"), join(root, "link.md"));

    for (const path of ["../elsewhere.md", join(outside, "elsewhere.md"), "link.md", "notes.txt", "headless.md", "missing.md", "dir.md", "."]) {
      const refused = await refusal(client.request("instructions.import", { commandId: randomUUID(), id: randomUUID(), sessionId, path }));
      expect(refused.code, path).toBe("invalid_params");
    }
    const untagged = await minted(client, { "instruction.md": "# Mine" }, ["setup"]);
    expect((await refusal(client.request("instructions.import", { commandId: randomUUID(), id: randomUUID(), sessionId: untagged.sessionId, path: "instruction.md" }))).code).toBe("invalid_params");
    const { id: directory } = await create(client, { tags: ["setup", "instructions"] });
    expect((await refusal(client.request("instructions.import", { commandId: randomUUID(), id: randomUUID(), sessionId: directory, path: "instruction.md" }))).code).toBe("invalid_params");
    expect((await importing(client, { sessionId: randomUUID(), path: "instruction.md" })).receipt).toMatchObject({ status: "rejected", reason: "not_found", error: { data: { kind: "session" } } });
    expect(typesOf(t)).toEqual([]);
  });
});
