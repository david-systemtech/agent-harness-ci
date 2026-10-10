import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MacCredentials } from "./mac-credentials.js";

export interface MacCredentialStoreParts {
  readonly dir: string;
  readonly open: (name: string) => MacCredentials;
}

const ORIGINAL_NAME = "agent-harness";
const HEADER = "ah-mac-credential-v1\n";
const validName = (name: unknown): name is string => typeof name === "string" &&
  (name === ORIGINAL_NAME || /^agent-harness credentials [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name));

/** Public storage identity only; a credential never enters an argument or this metadata. */
export const credentialHelperName = (argv: readonly string[]): string => {
  const name = argv.find(arg => arg.startsWith("--credential-store="))?.slice("--credential-store=".length) ?? ORIGINAL_NAME;
  if (!validName(name)) throw new Error("Invalid macOS credential storage identity.");
  return name;
};

const unpack = (kept: Buffer): { name: string; encrypted: Buffer } => {
  if (!kept.subarray(0, HEADER.length).equals(Buffer.from(HEADER))) return { name: ORIGINAL_NAME, encrypted: kept };
  const end = kept.indexOf(10, HEADER.length);
  const name = kept.subarray(HEADER.length, end).toString();
  if (end < 0 || !validName(name)) throw new Error("Invalid macOS credential envelope.");
  return { name, encrypted: kept.subarray(end + 1) };
};

/**
 * Selects OS items independently of ciphertext. Writes and availability use an
 * item of this data folder's own, never the app-wide original: an earlier,
 * differently signed build may own that one even when this folder is new.
 * The original only reads raw earlier ciphertext. An item whose access fails
 * or is refused is kept intact but retired, and new writes use a new helper
 * name, hence a new Keychain item. The envelope records its item.
 * A persisted active item is reused for writes only after this launch reads it
 * successfully; otherwise probes and writes select a fresh item before OS access.
 * Metadata remembers retired items across launches so no background retry or
 * availability probe asks for one again.
 */
export const macCredentialStore = ({ dir, open }: MacCredentialStoreParts): MacCredentials & {
  recover(kept: Buffer): Promise<void>;
  recovery(): Promise<boolean>;
} => {
  const file = join(dir, "mac-credential-store.json");
  const providers = new Map<string, MacCredentials>();
  const unavailable = new Set<string>();
  const freshItems = new Set<string>();
  let active: string | undefined;
  // A persisted name belongs to another launch until this process successfully reads its item.
  let activeAccessible = false;
  let closed = false;
  const usable = () => { if (closed) throw new Error("Desktop credential access was cancelled at shutdown."); };
  const load = (async () => {
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    let value: { active?: unknown; unavailable?: unknown };
    try { value = JSON.parse(text) as typeof value; }
    catch { throw new Error("Invalid macOS credential storage metadata."); }
    if (value === null || !validName(value.active) || !Array.isArray(value.unavailable) || !value.unavailable.every(validName) || value.unavailable.includes(value.active)) {
      throw new Error("Invalid macOS credential storage metadata.");
    }
    active = value.active;
    for (const name of value.unavailable as string[]) unavailable.add(name);
  })();
  // Initialization faults surface at the first operation, without an unhandled rejection during launch.
  void load.catch(() => {});
  let saved = load;
  const provider = (name: string) => {
    usable();
    if (unavailable.has(name)) throw new Error("The earlier macOS credential item is unavailable. Pair that environment again.");
    let current = providers.get(name);
    if (!current) { current = open(name); providers.set(name, current); }
    return current;
  };
  const ready = async () => { await saved; usable(); };
  /** Metadata from before #1572's reopening may still name the original as active. */
  const choose = (): boolean => {
    if (active !== undefined && active !== ORIGINAL_NAME && activeAccessible && !unavailable.has(active)) return false;
    active = `agent-harness credentials ${randomUUID()}`;
    activeAccessible = true;
    freshItems.add(active);
    return true;
  };
  const persist = () => {
    const text = JSON.stringify({ active, unavailable: [...unavailable] });
    saved = saved.then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
      const next = `${file}.${randomUUID()}.next`;
      try {
        await writeFile(next, text, { mode: 0o600 });
        usable();
        await rename(next, file);
      } catch (error) { await rm(next, { force: true }); throw error; }
    });
  };
  /** This folder's item, recorded before its first use. */
  const own = async (): Promise<string> => {
    await ready();
    if (choose()) persist();
    const name = active as string;
    await ready();
    return name;
  };
  /** Callers have loaded the metadata; marking before any await keeps a concurrent write off the item. */
  const retire = async (name: string) => {
    usable();
    if (!unavailable.has(name)) {
      unavailable.add(name);
      providers.get(name)?.close();
      providers.delete(name);
      choose();
      persist();
    }
    await saved;
  };
  /** A failure other than shutdown retires the item, so later writes do not ask for it again. */
  const attempt = async <T>(name: string, operation: (item: MacCredentials) => Promise<T>, refused: (answer: T) => boolean = () => false): Promise<T> => {
    let answer: T;
    try { answer = await operation(provider(name)); }
    catch (error) {
      // The operation's reason is the one to report; a metadata fault surfaces at the next call.
      if (!closed) await retire(name).catch(() => {});
      throw error;
    }
    if (refused(answer) && !closed) await retire(name);
    return answer;
  };
  return {
    async available(signal) { return attempt(await own(), (item) => item.available(signal), (answer) => !answer); },
    async encrypt(secret, signal) {
      const name = await own();
      const encrypted = await attempt(name, (item) => item.encrypt(secret, signal));
      return Buffer.concat([Buffer.from(HEADER + name + "\n"), encrypted]);
    },
    writeStorage(kept) { return freshItems.has(unpack(kept).name) ? "fresh-item" : "retained-item"; },
    async decrypt(kept, signal) {
      await ready();
      const { name, encrypted } = unpack(kept);
      const secret = await provider(name).decrypt(encrypted, signal);
      if (name === active) activeAccessible = true;
      return secret;
    },
    async recover(kept) {
      await ready();
      let name: string;
      try { name = unpack(kept).name; }
      catch {
        // The damaged file needs repair, but identifies no OS item to retire.
        // recovery() keeps the warning until that file is replaced or removed.
        return;
      }
      await retire(name);
    },
    async recovery() {
      await ready();
      const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".secret")) continue;
        let kept: Buffer;
        try { kept = await readFile(join(dir, entry.name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        let name: string;
        try { name = unpack(kept).name; }
        catch {
          // A damaged saved credential still needs repair, but must not break
          // fresh writes or deletion of another environment's former token.
          return true;
        }
        if (unavailable.has(name)) return true;
      }
      return false;
    },
    close() {
      closed = true;
      for (const current of providers.values()) current.close();
      providers.clear();
    },
  };
};
