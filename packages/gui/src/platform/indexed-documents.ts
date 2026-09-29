import type { DocumentStore } from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";

/**
 * The desktop platform's documents (docs/specs/client-runtime.md, "Package
 * and platform"): one IndexedDB database, keyed by the window's origin, the
 * app scheme's `agent-harness://app`, which the desktop registers standard
 * and secure so it is stable across launches. Each document is kept as its
 * JSON text in one object store, so a value that is not plain JSON is
 * refused whole, as every platform's store refuses it (IndexedDB's own
 * structured clone would keep a `BigInt` or a `Date` as no other store
 * could), and a write settles once its transaction has committed.
 */

const DATABASE = PRODUCT_NAME;
const VERSION = 1;
const STORE = "documents";

export const indexedDocuments = (indexedDB: IDBFactory): DocumentStore => {
  let opened: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        const database = request.result;
        // Another window upgrading the database asks this one to let go of it: the next call opens it again.
        database.onversionchange = () => {
          database.close();
          opened = undefined;
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error ?? new Error(`The ${DATABASE} database could not be opened.`));
    }).catch((error: unknown) => {
      opened = undefined;
      throw error;
    }));

  /** Runs one request in a transaction of its own, answering its result once the transaction has committed. */
  const inTransaction = async <T>(mode: IDBTransactionMode, ask: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const database = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = ask(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error(`A ${mode} transaction on ${STORE} was aborted.`));
    });
  };

  return {
    async get(key) {
      const text = await inTransaction<unknown>("readonly", (store) => store.get(key));
      return typeof text === "string" ? (JSON.parse(text) as unknown) : undefined;
    },
    async set(key, value) {
      const text = JSON.stringify(value) as string | undefined;
      if (text === undefined) throw new TypeError(`The document ${key} is not a JSON value.`);
      await inTransaction("readwrite", (store) => store.put(text, key));
    },
    async delete(key) {
      await inTransaction("readwrite", (store) => store.delete(key));
    },
  };
};
