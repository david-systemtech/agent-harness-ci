import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { TEAM_BANK } from "../../contracts/test/fixture-banks.js";
import { startFakeForge } from "../../environment/test/fake-forge.js";
import { added, pasted } from "../../environment/test/forge.js";
import { useHarness } from "../test/harness.js";
import { inMemoryPlatform } from "./testing/in-memory-platform.js";

const harness = useHarness();

it("copies through each environment's BankService using its own forge identity and checkout", async () => {
  const forge = await startFakeForge();
  harness.onCleanup(() => forge.close());
  forge.gitRepository("acme/memory", { private: true, files: TEAM_BANK });
  const environments = [];
  for (const login of ["source", "target"]) {
    const token = `${login}-token-for-tests`;
    forge.user(token, { login, id: login === "source" ? 42 : 43 });
    forge.gitCredential(login, token);
    forge.repository(token, "acme/memory");
    for (const api of ["/api/v1", "/api/v3"]) forge.answer(token, `GET ${api}/repos/acme/memory`, { status: 200, body: { full_name: "acme/memory", private: true, default_branch: "main", html_url: `${forge.origin}/acme/memory`, permissions: { pull: true, push: true } } });
    const helper = join(harness.tempDir(), "helper");
    writeFileSync(helper, `#!/bin/sh\ncat > /dev/null\nprintf 'username=${login}\\npassword=${token}\\n'\n`);
    chmodSync(helper, 0o755);
    const environment = await harness.environment({ name: login, forgeFetch: forge.fetch, harnessCommand: [helper] });
    const client = await environment.client();
    await added(client, { url: forge.origin, kind: "forgejo", slug: "team", credential: pasted(token) });
    environments.push({ environment, client });
  }
  const [source, target] = environments;
  const joined = await source!.client.request("banks.join", { commandId: randomUUID(), bankId: randomUUID(), url: `${forge.origin}/acme/memory.git`, accounts: [], repositories: "all" });
  const sourceBank = joined.result!.bank;
  await source!.client.request("banks.registry.update", { commandId: randomUUID(), bankId: sourceBank.id, accounts: "all", role: "read-only", enabled: false, pins: ["acme:acme/web/"], mergeOverride: "review-memories", privateCopy: true });
  const runtime = harness.runtime(inMemoryPlatform());
  await runtime.start();
  for (const { environment } of environments) await runtime.connections.add({ link: (await environment.createPairing()).link });
  const before = forge.gitRequests.length;
  expect(await runtime.commands.copyToEnvironments(source!.environment.env.id, { bankIds: [sourceBank.id] }, [target!.environment.env.id])).toMatchObject([
    { status: "copied", result: [{ kind: "bank", id: sourceBank.id, status: "copied" }] },
  ]);
  const banks = (await target!.client.request("banks.list", {})).banks;
  expect(banks).toHaveLength(1);
  expect(banks[0]).toMatchObject({
    name: "acme", checkout: join(target!.environment.dataDir, "banks", "acme"), credential: "forge",
    role: "read-only", enabled: false, accounts: "all", repositories: "all", pins: ["acme:acme/web/"],
    mergeOverride: "review-memories", privateCopy: true,
    copiedFrom: { environmentId: source!.environment.env.id, environmentName: "source" },
  });
  expect(banks[0]!.checkout).not.toBe(sourceBank.checkout);
  expect(banks[0]!.id).not.toBe(sourceBank.id);
  const authenticated = forge.gitRequests.slice(before).filter((request) => request.username !== null);
  expect(authenticated.length).toBeGreaterThan(0);
  expect(authenticated.every((request) => request.username === "target")).toBe(true);
}, 30_000);
