import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment } from "../../test/helper.js";
import type { WireClient } from "../../test/wire-client.js";
import { machinePointedAt } from "./source/folders.js";

/**
 * Carry over's favourite models (#1821): the source keeps no favourites, so
 * the models the person chose there, the composer's first and then each
 * per-session choice by how many sessions made it, become the favourite
 * models while the environment has none, and never replace a list it has.
 */

const { onCleanup, tempDir } = useCleanups();
const start = async (preferences: Record<string, unknown>) => {
  const folder = tempDir();
  writeFileSync(join(folder, "prefs.json"), JSON.stringify(preferences));
  const t = await startTestEnvironment({ stateImportSource: machinePointedAt({ dataFolder: folder, home: tempDir() }) });
  onCleanup(() => t.close());
  return { t, client: await t.client() };
};
const run = async (client: WireClient, dryRun = false) =>
  registry["stateImport.run"].response.parse(await client.request("stateImport.run", { commandId: randomUUID(), dryRun }));
const favouritesOf = async (client: WireClient) => (await client.request("settings.get", { keys: ["accounts.favouriteModels"] })).values["accounts.favouriteModels"];
const choice = (model: string | null) => ({ model, effort: null, fastMode: false, ultracode: false });

const PREFERENCES = {
  model: "claude-sonnet-5",
  modelBySession: { s1: choice("claude-opus-5"), s2: choice("claude-haiku-5"), s3: choice("claude-opus-5"), s4: choice(null), s5: choice("claude-sonnet-5"), s6: "not-a-choice" },
};

describe("Carry over's favourite models", () => {
  it("previews without writing, then makes the models chosen in the source the favourites: the composer's, then by how many sessions chose each", async () => {
    const { t, client } = await start(PREFERENCES);
    const head = t.env.log.head();
    await run(client, true);
    expect(t.env.log.head()).toBe(head);
    expect(await favouritesOf(client)).toEqual([]);
    expect((await run(client)).result?.failed).toEqual([]);
    expect(await favouritesOf(client)).toEqual(["claude-sonnet-5", "claude-opus-5", "claude-haiku-5"]);
    // Carried once: a person's later edit is not undone by another import.
    await client.request("settings.update", { commandId: randomUUID(), values: { "accounts.favouriteModels": ["claude-haiku-5"] } });
    await run(client);
    expect(await favouritesOf(client)).toEqual(["claude-haiku-5"]);
  });

  it("carries the model id alone of a choice the source stored as `<account>/<model>`, each once (#1954)", async () => {
    const { client } = await start({
      model: "account-a/claude-fable-5-1",
      modelBySession: { s1: choice("account-a/opus"), s2: choice("account-b/opus"), s3: choice("account-b/claude-fable-5-1"), s4: choice("opus") },
    });
    expect((await run(client)).result?.failed).toEqual([]);
    expect(await favouritesOf(client)).toEqual(["claude-fable-5-1", "opus"]);
  });

  it("keeps the favourites the environment already has", async () => {
    const { client } = await start(PREFERENCES);
    await client.request("settings.update", { commandId: randomUUID(), values: { "accounts.favouriteModels": ["claude-fable-5"] } });
    expect((await run(client)).result?.failed).toEqual([]);
    expect(await favouritesOf(client)).toEqual(["claude-fable-5"]);
  });

  it("carries none when the source chose no model", async () => {
    const { t, client } = await start({ modelBySession: { s1: choice(null) } });
    await run(client);
    expect(await favouritesOf(client)).toEqual([]);
    expect(t.env.log.read<{ n: number }>("SELECT count(*) AS n FROM events WHERE type = 'state-import.item-carried'")[0]?.n).toBe(0);
  });
});
