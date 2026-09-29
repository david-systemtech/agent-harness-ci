import { storageContractSuite } from "@agent-harness/client-runtime/testing/storage-contract";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { indexedDocuments } from "./platform/indexed-documents.js";

/**
 * The desktop platform's documents (docs/specs/client-runtime.md, "Package
 * and platform"): IndexedDB, keyed by the app scheme's origin, run through
 * the storage contract every platform's store runs, over fake-indexeddb in
 * place of the browser's.
 */
describe("the storage contract on IndexedDB", () => {
  for (const contractCase of storageContractSuite(() => indexedDocuments(new IDBFactory()))) it(contractCase.name, () => contractCase.run());
});

describe("documents in IndexedDB", () => {
  it("keeps each document for a store opened again on the same database, as a relaunch opens it", async () => {
    const indexedDB = new IDBFactory();
    const first = indexedDocuments(indexedDB);
    await first.set("presentation", { format: 1, sidebarWidth: 24 });
    await first.set("connections.paired", { format: 1, connections: [] });
    await first.delete("connections.paired");

    const again = indexedDocuments(indexedDB);
    expect(await again.get("presentation")).toEqual({ format: 1, sidebarWidth: 24 });
    expect(await again.get("connections.paired")).toBeUndefined();
    expect(await indexedDocuments(new IDBFactory()).get("presentation")).toBeUndefined();
  });

  it("refuses a value that is not plain JSON, as every platform's store does, and keeps what it held", async () => {
    const documents = indexedDocuments(new IDBFactory());
    await documents.set("presentation", { format: 1 });
    await expect(documents.set("presentation", { format: 1, at: BigInt(1) })).rejects.toThrow();
    expect(await documents.get("presentation")).toEqual({ format: 1 });
  });

  it("rejects every call once the database cannot be opened, saying so", async () => {
    const indexedDB = new IDBFactory();
    const refusing = { open: () => indexedDB.open("agent-harness", 0) } as unknown as IDBFactory;
    await expect(indexedDocuments(refusing).get("presentation")).rejects.toThrow();
  });
});
