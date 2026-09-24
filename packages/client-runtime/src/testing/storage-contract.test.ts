import { describe, expect, it } from "vitest";
import type { DocumentStore } from "../platform.js";
import { inMemoryDocuments } from "./in-memory-platform.js";
import { storageContractSuite } from "./storage-contract.js";

/** The storage contract suite on the in-memory platform's store, as every platform runs it on its own. */
describe("the storage contract on the in-memory documents", () => {
  for (const contractCase of storageContractSuite(() => inMemoryDocuments())) it(contractCase.name, () => contractCase.run());
});

describe("the storage contract itself", () => {
  it("fails a store that keeps half a write", async () => {
    // A store that writes the cursor, then fails before the snapshot: the torn write the contract forbids.
    const torn = (): DocumentStore => {
      const inner = inMemoryDocuments();
      return {
        get: inner.get,
        delete: inner.delete,
        async set(key, value) {
          const fields = value as Record<string, unknown>;
          const before = ((await inner.get(key)) ?? {}) as Record<string, unknown>;
          await inner.set(key, { ...before, format: fields["format"], sequence: fields["sequence"] });
          JSON.stringify(value);
          await inner.set(key, value);
        },
      };
    };
    const cutOff = storageContractSuite(torn).find((c) => c.name.startsWith("leaves the old pair"));
    await expect(cutOff?.run()).rejects.toThrow(/after a write was cut off/);
  });

  it("takes a platform's own way to cut a write off", async () => {
    let asked = 0;
    const suite = storageContractSuite(() => inMemoryDocuments(), {
      interrupt: async () => {
        asked++;
        throw new Error("The process died mid-write.");
      },
    });
    await suite.find((c) => c.name.startsWith("leaves the old pair"))?.run();
    expect(asked).toBe(1);
  });
});
