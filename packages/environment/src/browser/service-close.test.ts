import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { PORT_FILE_NAME } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { TEST_EXTENSION, TEST_EXTENSION_VERSION } from "../../test/fake-extension.js";
import { startTestEnvironment } from "../../test/helper.js";
import { openEventLog } from "../event-log/event-log.js";
import { permissionsProjector } from "../permissions/permissions-store.js";
import { fileVault } from "../serve/vault.js";
import { settingsProjector } from "../settings/settings-store.js";
import { createBrowserService } from "./service.js";

// Hold a copy at the filesystem boundary; all other filesystem work is real.
const copying = vi.hoisted(() => ({ before: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    cp: async (...args: Parameters<typeof actual.cp>) => {
      await copying.before?.();
      return actual.cp(...args);
    },
  };
});

const { onCleanup, tempDir } = useCleanups();

const signal = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("browser service shutdown", () => {
  it("joins a held replacement and queued rename updates before returning, and admits no folder work after close", async () => {
    const dataDir = tempDir();
    const log = openEventLog({ path: ":memory:", projectors: [settingsProjector, permissionsProjector] });
    onCleanup(() => log.close());
    const stream = { kind: "environment", id: randomUUID() };
    const service = createBrowserService({
      log,
      stream,
      clock: manualClock(),
      environmentId: stream.id,
      name: () => "Laptop",
      harnessVersion: TEST_EXTENSION_VERSION,
      dataDir,
      extensionSource: TEST_EXTENSION,
      ports: { preferred: 0, last: 0 },
      vault: fileVault(join(dataDir, "vault.json")),
      headless: {
        declaredContainer: false,
        find: () => ({ ok: false, reason: "No test executable." }),
        launch: () => {
          throw new Error("No browser may launch in this test.");
        },
        resolve: async () => [],
      },
    });
    onCleanup(() => service.close());
    // No listener or browser is started: their close has no I/O to wait on.
    // Status and renames still use the real extension-folder queue.
    await service.status();
    rmSync(join(dataDir, "extension", "current"), { recursive: true });
    const entered = signal();
    const release = signal();
    copying.before = () => {
      entered.resolve();
      return release.promise;
    };
    onCleanup(() => {
      copying.before = undefined;
      release.resolve();
    });

    log.append(stream, [{ type: "environment.renamed", payload: { name: "Work laptop" } }], { actor: "system:test" });
    await entered.promise;
    log.append(stream, [{ type: "environment.renamed", payload: { name: "Again" } }], { actor: "system:test" });
    const pendingStatus = service.status();
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    try {
      // An event-loop turn settles promise-only close work, while the copy
      // stays explicitly held. There is no wall-clock budget or sleep.
      await setImmediate();
      expect(closed).toBe(false);
    } finally {
      release.resolve();
      await Promise.all([closing, pendingStatus]);
      copying.before = undefined;
    }
    expect(readdirSync(join(dataDir, "extension"))).toEqual(["current"]);
    expect(readdirSync(join(dataDir, "extension", "current")).sort()).toEqual(["manifest.json", "worker.js"]);

    rmSync(join(dataDir, "extension"), { recursive: true });
    log.append(stream, [{ type: "environment.renamed", payload: { name: "After close" } }], { actor: "system:test" });
    await service.status();
    expect(existsSync(join(dataDir, "extension"))).toBe(false);
  });

  it("lets fixture cleanup remove the owned directory after rename updates", async () => {
    const t = await startTestEnvironment();
    onCleanup(() => t.close());
    const client = await t.client();
    await client.apply("environment.rename", { commandId: randomUUID(), name: "Work laptop" });
    await client.apply("environment.rename", { commandId: randomUUID(), name: "Again" });
    expect(existsSync(join(t.dataDir, "extension", "current", PORT_FILE_NAME))).toBe(true);
    await t.close();
    expect(existsSync(t.dataDir)).toBe(false);
  });
});
