import assert from "node:assert/strict";
import { log } from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setInterval, clearInterval } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// Shipped account owner and event store; only the external provider and retry clock are held.
export async function checkPackagedAccountRecovery(server, source = false) {
  const moduleRoot = source ? join(server, "packages/environment/src") : join(server, "node_modules/@agent-harness/environment/dist");
  const load = (path) => import(pathToFileURL(join(moduleRoot, path)));
  const { createAccountService, PROBE_RETRY_INTERVAL_MS } = await load("accounts/account-service.js");
  const { accountsProjector } = await load("accounts/account-store.js");
  const { openEventLog } = await load("event-log/event-log.js");
  const { accountStateChecks } = await load("accounts/step-checks.js");
  const scratch = mkdtempSync(join(tmpdir(), "packaged-account-recovery-"));
  const path = join(scratch, "events.sqlite");
  // The production deadlines are unrefed; keep this standalone smoke alive until they settle.
  const keepAlive = setInterval(() => {}, 120_000);
  const timers = new Map();
  const clock = {
    now: () => new Date(),
    setTimeout: (callback, ms) => {
      const key = {};
      timers.set(key, { callback, ms });
      return { cancel: () => timers.delete(key) };
    },
  };
  let held = false;
  const cancelled = [];
  const blocked = (kind, account, signal) => new Promise((_resolve, reject) => {
    assert.ok(signal, "Account probes must carry cancellation into the provider");
    signal.addEventListener("abort", () => { cancelled.push(`${kind}:${account.id}`); reject(signal.reason); }, { once: true });
  });
  const adapter = {
    descriptor: { provider: "smoke-provider", displayName: "Smoke provider" },
    status: async (account, signal) => held ? blocked("status", account, signal) : {
      signedIn: true, authMethod: "test", email: `${account.id}@example.com`, orgName: null, subscriptionType: null, error: null,
    },
    models: async (account, signal) => held ? blocked("models", account, signal) : { live: true, models: [{ id: "model", family: "model", tier: 1, efforts: [] }] },
  };
  let events;
  let service;
  const start = async () => {
    events = openEventLog({ path, clock: clock.now, projectors: [accountsProjector] });
    service = createAccountService({ log: events, clock, environmentId: "smoke-environment", adapters: [adapter], ownedRoot: null,
      probeTimeoutMs: 50, configured: [{ id: "one", provider: "smoke-provider", directory: join(scratch, "one") }, { id: "two", provider: "smoke-provider", directory: join(scratch, "two") }] });
    await service.start();
  };
  const stop = () => { service?.close(); events?.close(); };
  try {
    await start();
    assert.deepEqual(service.list().map(account => account.status.state), ["signed-in", "signed-in"]);
    stop();
    for (const phase of ["update startup", "restart"]) {
      held = true;
      cancelled.length = 0;
      await start();
      assert.deepEqual(cancelled.sort(), ["models:one", "models:two", "status:one", "status:two"], phase);
      assert.deepEqual(service.list().map(account => account.status.state), ["unavailable", "unavailable"], phase);
      assert.equal(service.facts("one").signedIn, false, "Temporary status must not admit runs");
      assert.notEqual(accountStateChecks({ accounts: () => service.list() })["account.signed-in"](), true, "Account readiness must stay strict");
      held = false;
      const retries = [...timers.values()];
      assert.equal(retries.length, 2);
      assert.ok(retries.every(timer => timer.ms === PROBE_RETRY_INTERVAL_MS));
      timers.clear();
      for (const timer of retries) timer.callback();
      const deadline = Date.now() + 120_000;
      while (service.list().some(account => account.status.state !== "signed-in")) {
        assert.ok(Date.now() < deadline, "Automatic account recovery did not settle");
        await delay(10);
      }
      assert.deepEqual((await service.catalogues()).map(catalogue => catalogue.live), [true, true]);
      assert.equal(accountStateChecks({ accounts: () => service.list() })["account.signed-in"](), true);
      stop();
      assert.equal(timers.size, 0, "Close must cancel all retries");
    }
    log("Verified packaged account recovery: two persisted accounts, cancelled deadlines, strict readiness, automatic recovery after update startup and restart");
  } finally { clearInterval(keepAlive); stop(); rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkPackagedAccountRecovery(resolve(process.argv[2]), process.argv.includes("--source"));
}
