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
 * Selects OS items independently of ciphertext. An unavailable earlier item is
 * kept intact; new writes use a new helper name, hence a new Keychain item.
 * The envelope records its item, and private metadata remembers recovery
 * across launches so no background retry repeatedly asks for the earlier key.
 */
export const macCredentialStore = ({ dir, open }: MacCredentialStoreParts): MacCredentials & {
  recover(kept: Buffer): Promise<void>;
  recovery(): Promise<boolean>;
} => {
  const file = join(dir, "mac-credential-store.json");
  const providers = new Map<string, MacCredentials>();
  const unavailable = new Set<string>();
  let active = ORIGINAL_NAME;
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
  return {
    async available(signal) { await ready(); return provider(active).available(signal); },
    async encrypt(secret, signal) {
      await ready();
      const name = active;
      const encrypted = await provider(name).encrypt(secret, signal);
      return name === ORIGINAL_NAME ? encrypted : Buffer.concat([Buffer.from(HEADER + name + "\n"), encrypted]);
    },
    async decrypt(kept, signal) {
      await ready();
      const { name, encrypted } = unpack(kept);
      return provider(name).decrypt(encrypted, signal);
    },
    async recover(kept) {
      await ready();
      const { name } = unpack(kept);
      if (unavailable.has(name)) { await saved; return; }
      unavailable.add(name);
      providers.get(name)?.close();
      providers.delete(name);
      if (active === name) active = `agent-harness credentials ${randomUUID()}`;
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
      await saved;
    },
    async recovery() {
      await ready();
      if (unavailable.size === 0) return false;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
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
