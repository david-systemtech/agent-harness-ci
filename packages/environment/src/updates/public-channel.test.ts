import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { startFakeReleaseSource } from "../../test/release-source.js";

const { onCleanup } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}) => {
  const fake = await startFakeReleaseSource("github");
  onCleanup(() => fake.forge.close());
  const t = await startTestEnvironment({ harnessVersion: "0.4.1", releaseSource: fake.source, forgeFetch: fake.forge.fetch, ...options });
  onCleanup(() => t.close());
  const client = await t.client();
  return { fake, t, client };
};

const API = "/api/v3/repos/david-systemtech/agent-harness/releases";

describe("the public GitHub release channel", () => {
  it("reads stable anonymously within the newest 50 non-draft releases, and beta includes prereleases", async () => {
    const { fake, t, client } = await start();
    fake.publish({ version: "9.0.0" }, ...Array.from({ length: 48 }, (_, i) => ({ version: `0.5.${i}` })), { version: "0.6.0-beta.1" }, { version: "0.5.48" }, { version: "10.0.0", draft: true });
    const status = await client.request("updates.check", {});
    expect(status).toMatchObject({ newest: "0.5.48", lastCheck: { result: "ok" }, target: { version: "0.5.48", source: "channel" } });
    expect((await client.request("forge.accounts.list", {})).accounts).toEqual([]);
    expect(fake.reads()).toEqual([
      { method: "GET", path: API, query: "per_page=50", scheme: null },
      { method: "GET", path: `${API}/assets/5100`, scheme: null },
    ]);
    t.clock.advance(60_000);
    await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.channel": "beta" } });
    expect(await client.request("updates.check", {})).toMatchObject({ newest: "0.6.0-beta.1", lastCheck: { result: "ok" }, target: { version: "0.6.0-beta.1" } });
  });

  it.each([403, 429])("reports an anonymous HTTP %s rate limit and keeps the existing check cadence", async (status) => {
    const { fake, t, client } = await start();
    fake.forge.answer(null, `GET ${API}`, { status, headers: status === 403 ? { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(t.clock.now().getTime() / 1000 + 3600) } : { "retry-after": "3600" } });
    const checked = await client.request("updates.check", {});
    expect(checked.lastCheck).toMatchObject({ result: "failed", reason: "unreachable", message: expect.stringContaining(`anonymous reads (HTTP ${status})`) });
    expect((await client.request("updates.check", {})).lastCheck).toEqual(checked.lastCheck);
    expect(fake.reads()).toHaveLength(1);
    t.clock.advance(60_000);
    fake.publish({ version: "0.5.0" });
    fake.forge.answer(null, `GET ${API}`, { status: 200, body: [] });
    expect(await client.request("updates.check", {})).toMatchObject({ lastCheck: { result: "ok" } });
  });

  it("uses a configured GitHub account for the list and manifest instead of reading anonymously", async () => {
    const { fake, client } = await start();
    await fake.grantAccess(client);
    fake.publish({ version: "0.5.0" });
    expect(await client.request("updates.check", {})).toMatchObject({ newest: "0.5.0", lastCheck: { result: "ok" } });
    expect(fake.reads().filter((request) => request.path === API || request.path.includes("/assets/"))).toEqual([
      { method: "GET", path: API, query: "per_page=50", scheme: "Bearer" },
      { method: "GET", path: `${API}/assets/100`, scheme: "Bearer" },
    ]);
  });

  it("stages the desktop's GitHub asset anonymously with the manifest's checksum", async () => {
    const { fake, client } = await start();
    const bytes = new TextEncoder().encode("desktop build for tests");
    fake.publish({ version: "0.5.0", desktop: [{ name: "desktop.pacman", platform: "linux-x64", format: "pacman", bytes }] });
    const staged = await client.request("updates.desktop.stage", { platform: "linux-x64", format: "pacman" });
    expect(staged.version).toBe("0.5.0");
    expect(new Uint8Array(readFileSync(staged.path))).toEqual(bytes);
    expect(fake.reads().at(-1)).toEqual({ method: "GET", path: `${API}/assets/103`, scheme: null });
  });


  it("gives the host updater the GitHub release's GHCR reference and digest without downloading an artefact", async () => {
    const { fake, client } = await start({ containerDetector: { inContainer: () => true } });
    fake.publish({ version: "0.5.0" });
    const applied = await client.request("updates.apply", { commandId: randomUUID(), version: "0.5.0", when: "idle" });
    expect(applied.receipt.status).toBe("accepted");
    expect((await client.request("updates.status", {})).pending).toMatchObject({
      toVersion: "0.5.0", image: { reference: "ghcr.io/david-systemtech/agent-harness:0.5.0", digest: `sha256:${"0".repeat(64)}` },
    });
    expect(fake.reads().filter((request) => request.path.includes("/assets/"))).toEqual([{ method: "GET", path: `${API}/assets/100`, scheme: null }]);
  });

});
