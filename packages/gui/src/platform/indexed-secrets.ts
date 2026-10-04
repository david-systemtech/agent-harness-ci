import type { SecretStore } from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";

const DATABASE = `${PRODUCT_NAME}-secrets`;
const VERSION = 1;
const STORE = "secrets";

/** Origin-scoped credentials, separate from documents, transcripts and cursors. No pretend encryption. */
export const indexedSecrets = (indexedDB: IDBFactory): SecretStore => {
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
      return typeof text === "string" ? text : undefined;
    },
    async set(key, value) {
      const text = value;
      await inTransaction("readwrite", (store) => store.put(text, key));
    },
    async delete(key) {
      await inTransaction("readwrite", (store) => store.delete(key));
    },
  };
};
