import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { sourceConnection } from "../../test/source-folder.js";
import type { WireClient } from "../../test/wire-client.js";
import { machinePointedAt } from "./source/folders.js";

const { onCleanup, tempDir } = useCleanups();
const writeBrowser = (folder: string, policy: Record<string, unknown>, browsers: readonly unknown[] = []) =>
  writeFileSync(join(folder, "paired-browsers.json"), JSON.stringify({ policy, browsers }), { mode: 0o600 });
const start = async (policy: Record<string, unknown>, options: TestEnvironmentOptions = {}) => {
  const folder = tempDir();
  writeBrowser(folder, policy);
  const t = await startTestEnvironment({ stateImportSource: machinePointedAt({ dataFolder: folder, home: tempDir() }), ...options });
  onCleanup(() => t.close());
  return { t, folder, client: await t.client() };
};
const run = async (client: WireClient, dryRun = false) =>
  registry["stateImport.run"].response.parse(await client.request("stateImport.run", { commandId: randomUUID(), dryRun }));
const policyOf = async (client: WireClient) =>
  (await client.request("settings.get", { keys: ["browser.devSites", "browser.evaluateEverywhere", "browser.deepReadEverywhere"] })).values;

describe("state import's local page policy", () => {
  it("previews without writing, then carries dev sites and evaluate-everywhere through Browser settings on this Environment alone", async () => {
    const { t, client } = await start({ devSites: ["dev.example", "*.app.test"], evaluateEverywhere: true, deepReadEverywhere: true });
    const other = await startTestEnvironment();
    onCleanup(() => other.close());
    const head = t.env.log.head();
    const preview = await run(client, true);
    expect(preview.result).toMatchObject({ carried: { devSites: 2 }, failed: [], dryRun: true });
    expect(t.env.log.head()).toBe(head);
    expect(await policyOf(client)).toEqual({ "browser.devSites": [], "browser.evaluateEverywhere": false, "browser.deepReadEverywhere": false });
    const applied = await run(client);
    expect(applied.result).toEqual({ ...preview.result, dryRun: false });
    expect(await policyOf(client)).toEqual({ "browser.devSites": ["dev.example", "*.app.test"], "browser.evaluateEverywhere": true, "browser.deepReadEverywhere": false });
    expect(await policyOf(await other.client())).toEqual({ "browser.devSites": [], "browser.evaluateEverywhere": false, "browser.deepReadEverywhere": false });
  });

  it("reports Pairings, saved Connections and client-local exclusions with their replacement Steps, leaving other providers for later", async () => {
    const { t, folder, client } = await start({ devSites: ["dev.example"], evaluateEverywhere: true });
    const accounts = await client.request("accounts.list", {});
    const head = t.env.log.head();
    writeBrowser(folder, { devSites: ["dev.example"], evaluateEverywhere: true }, [{ browserId: "chrome-fixture", browserName: "token-for-tests", secret: "token-for-tests", pairedAt: 1 }]);
    writeFileSync(join(folder, "prefs.json"), JSON.stringify({ cwd: "/fixture", model: "model-fixture", modelBySession: { one: "model" }, dockLayout: {}, dockLayouts: { one: {} } }));
    // The source's saved Connection provider is named only inside the source-reader exemption.
    writeFileSync(join(folder, "profiles.json"), JSON.stringify({ version: 2, profiles: [sourceConnection(), { id: "deferred", providerId: "codex", label: "token-for-tests" }] }));
    const preview = await run(client, true);
    expect(preview.result).toMatchObject({
      notCarried: expect.arrayContaining([
        { label: "Browser Pairings", count: 1, step: "browser" },
        { label: "Saved server Connections", count: 1, step: "your-machines" },
        { label: "Composer seeds", count: 2, step: null },
        { label: "Per-session model choices", count: 1, step: null },
        { label: "Dock layouts", count: 2, step: null },
      ]),
      later: [{ label: "Profile for codex", provider: "codex" }],
      failed: [],
    });
    const applied = await run(client);
    expect(applied.result).toEqual({ ...preview.result, dryRun: false });
    expect(await client.request("browser.chromes.list", {})).toEqual({ chromes: [] });
    expect(await client.request("accounts.list", {})).toEqual(accounts);
    const events = t.env.log.readStream({ kinds: ["state-import", "environment", "settings"] }, head);
    expect(JSON.stringify({ preview, applied, events })).not.toContain("token-for-tests");
    expect(events.some((event) => event.type.startsWith("chrome.") || event.type.startsWith("account."))).toBe(false);
  });

  it("classifies file frecency as not carried even when the only source is a terminal folder", async () => {
    const folder = tempDir();
    writeFileSync(join(folder, "files.json"), JSON.stringify({ version: 1, entries: { "/fixture/one": { at: 1, count: 2 }, "/fixture/two": { at: 2, count: 1 } } }));
    const t = await startTestEnvironment({ stateImportSource: machinePointedAt({ terminalFolder: folder, home: tempDir() }) });
    onCleanup(() => t.close());
    const client = await t.client();
    const head = t.env.log.head();
    const preview = await run(client, true);
    expect(preview.result).toMatchObject({ notCarried: [{ label: "File frecency", count: 2, step: null }], failed: [] });
    expect(t.env.log.head()).toBe(head);
    const applied = await run(client);
    expect(applied.result).toEqual({ ...preview.result, dryRun: false });
    expect(await policyOf(client)).toMatchObject({ "browser.devSites": [], "browser.evaluateEverywhere": false });
    expect(JSON.stringify(applied)).not.toContain("/fixture/");
  });

  it("fails invalid sites without quoting them, carries valid siblings and retries corrected sites", async () => {
    const { t, folder, client } = await start({ devSites: ["dev.example", "https://token-for-tests@example.test/path", "bad:123"] });
    const head = t.env.log.head();
    const preview = await run(client, true);
    expect(preview.result).toMatchObject({ carried: { devSites: 1 }, failed: [
      { label: "Dev site", message: "Browser settings require a host pattern without a scheme, port or path." },
      { label: "Dev site", message: "Browser settings require a host pattern without a scheme, port or path." },
    ] });
    const applied = await run(client);
    expect(applied.result).toEqual({ ...preview.result, dryRun: false });
    expect(await policyOf(client)).toMatchObject({ "browser.devSites": ["dev.example"], "browser.evaluateEverywhere": false });
    const events = t.env.log.readStream({ kinds: ["state-import", "environment", "settings"] }, head);
    expect(JSON.stringify({ preview, applied, events })).not.toContain("token-for-tests");
    writeBrowser(folder, { devSites: ["dev.example", "fixed.test"] });
    expect((await run(client)).result).toMatchObject({ carried: { devSites: 1 }, failed: [] });
    expect(await policyOf(client)).toMatchObject({ "browser.devSites": ["dev.example", "fixed.test"] });
  });

  it("holds edited and removed policy across restart and projection rebuild, offering only new sites", async () => {
    const dataDir = tempDir();
    const { t, folder, client } = await start({ devSites: ["dev.example", "evaluate-everywhere"], evaluateEverywhere: true }, { dataDir });
    expect((await run(client)).result).toMatchObject({ carried: { devSites: 2 }, failed: [] });
    await client.request("settings.update", { commandId: randomUUID(), values: { "browser.devSites": ["mine.test"], "browser.evaluateEverywhere": false } });
    await t.close();
    const restarted = await startTestEnvironment({ dataDir, stateImportSource: machinePointedAt({ dataFolder: folder, home: tempDir() }) });
    onCleanup(() => restarted.close());
    const after = await restarted.client();
    await after.request("environment.rebuildProjections", { commandId: randomUUID() });
    const head = restarted.env.log.head();
    expect((await run(after, true)).result).toMatchObject({ carried: { devSites: 0 }, failed: [] });
    expect((await run(after)).result).toMatchObject({ carried: { devSites: 0 }, failed: [] });
    expect(restarted.env.log.readStream({ kinds: ["settings"] }, head)).toEqual([]);
    expect(await policyOf(after)).toMatchObject({ "browser.devSites": ["mine.test"], "browser.evaluateEverywhere": false });
    writeBrowser(folder, { devSites: ["dev.example", "evaluate-everywhere", "new.test"], evaluateEverywhere: true });
    expect((await run(after)).result).toMatchObject({ carried: { devSites: 1 }, failed: [] });
    expect(await policyOf(after)).toMatchObject({ "browser.devSites": ["mine.test", "new.test"], "browser.evaluateEverywhere": false });
  });

  it("fails policy whose source bytes changed after planning while carrying an unchanged Instructions store", async () => {
    let folder = "";
    const built = await start({ devSites: ["dev.example"], evaluateEverywhere: true }, {
      stateImportHooks: { planned: () => writeBrowser(folder, { devSites: ["changed.test"], evaluateEverywhere: true }) },
    });
    folder = built.folder;
    writeFileSync(join(folder, "agent-prompts.json"), JSON.stringify({ version: 1, prompts: [{ id: "one", name: "Checks", markdown: "Check work", scope: { kind: "all" } }] }));
    expect((await run(built.client)).result).toMatchObject({ carried: { devSites: 0, instructions: 1 }, failed: [{ label: "Browser policy", message: "It changed after it was read: preview again, then import." }] });
    expect(await policyOf(built.client)).toMatchObject({ "browser.devSites": [], "browser.evaluateEverywhere": false });
    expect((await run(built.client)).result).toMatchObject({ carried: { devSites: 1, instructions: 0 }, failed: [] });
  });

  it("unions sites with Browser settings changed after planning and commits mapping evidence with each owner's update", async () => {
    const built = await start({ devSites: ["dev.example"], evaluateEverywhere: false }, {
      stateImportHooks: { planned: async () => { await built.client.request("settings.update", { commandId: randomUUID(), values: { "browser.devSites": ["mine.test"] } }); } },
    });
    const client = built.client;
    const head = built.t.env.log.head();
    expect((await run(client)).result).toMatchObject({ carried: { devSites: 1 }, failed: [] });
    expect(await policyOf(client)).toMatchObject({ "browser.devSites": ["mine.test", "dev.example"], "browser.evaluateEverywhere": false });
    const events = built.t.env.log.readStream({ kinds: ["settings", "state-import"] }, head);
    const site = events.find((event) => event.type === "state-import.item-carried" && event.payload["kind"] === "dev-site");
    expect(site?.payload).toMatchObject({ store: "browser.devSites", sourceId: "dev.example", targetId: "dev.example", origin: "import" });
    const update = events.find((event) => event.type === "settings.updated" && event.commandId === site?.commandId);
    expect(update).toBeDefined();
    expect(update?.actor).toBe(site?.actor);
    expect((await run(client, true)).result).toMatchObject({ carried: { devSites: 0 }, failed: [] });
  });
});
