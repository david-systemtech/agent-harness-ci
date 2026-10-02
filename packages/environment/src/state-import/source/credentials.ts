import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { KeyManagerReference, registry, normaliseRemote, type KeyManagerReference as Reference, type ParamsOf } from "@agent-harness/contracts";
import { readStore, readSnapshot, type StoreRead, type StoreSnapshot } from "./stores.js";

/** Source writers: the v2 Bank registry and the per-slug encrypted token map. Tokens never leave this reader. */
export interface SourceCredential {
  readonly sourceId: string;
  readonly reference: Reference | null;
  readonly invalid: boolean;
}
export interface SourceConnection {
  readonly sourceId: string;
  readonly label: string;
  readonly params: ParamsOf<"keyManagers.connections.add"> | null;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const exec = promisify(execFile);
/** Read only the checkout's own config, snapshotting it and stripping URL userinfo before returning an origin. */
export const bankRemote = async (path: string): Promise<{ readonly origin: string; readonly snapshot: StoreSnapshot } | null> => {
  const bounds = { timeout: 10_000, maxBuffer: 8192 };
  try {
    const config = (await exec("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-path", "config"], bounds)).stdout.trim();
    const snapshot = await readSnapshot(config);
    if (snapshot === null) return null;
    const { stdout } = await exec("git", ["config", "--no-includes", "--file", config, "--get", "remote.origin.url"], bounds);
    const remote = normaliseRemote(stdout.trim());
    return remote === null ? null : { origin: remote.origin, snapshot };
  } catch { return null; }
};
export interface CredentialStores {
  readonly banks: StoreRead<{ readonly entries: readonly { readonly sourceId: string; readonly path: string }[] }>;
  readonly connections: StoreRead<{ readonly entries: readonly SourceConnection[] }>;
  readonly tokens: StoreRead<{ readonly entries: readonly SourceCredential[] }>;
}
export const readCredentialStores = async (sourceKey: string): Promise<CredentialStores> => {
  const [banks, tokens, connections] = await Promise.all([
    readStore<{ readonly entries: readonly { readonly sourceId: string; readonly path: string }[] }>(join(sourceKey, "memory-banks.json"), { name: "The Bank registry", is: "is" }, (value) => {
      if (!record(value) || value["version"] !== 2 || !Array.isArray(value["banks"])) return { refused: "The Bank registry is not a supported version 2 list." };
      const entries: { sourceId: string; path: string }[] = [];
      for (const bank of value["banks"]) {
        if (!record(bank) || typeof bank["slug"] !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bank["slug"]) || typeof bank["path"] !== "string" || !bank["path"]) continue;
        if (!entries.some((entry) => entry.sourceId === bank["slug"])) entries.push({ sourceId: bank["slug"], path: bank["path"] });
      }
      return { entries };
    }, { entries: [] }),
    readStore<{ readonly entries: readonly SourceCredential[] }>(join(sourceKey, "memory-bank-tokens.json"), { name: "The Bank credentials", is: "are" }, (value) => {
      if (!record(value)) return { refused: "The Bank credentials hold no credential map." };
      const entries: SourceCredential[] = [];
      for (const [sourceId, raw] of Object.entries(value)) {
        if (!record(raw)) { entries.push({ sourceId, reference: null, invalid: true }); continue; }
        if (raw["kind"] === "ref") {
          const parsed = KeyManagerReference.safeParse(raw["ref"]);
          entries.push({ sourceId, reference: parsed.success ? { ...parsed.data, connectionId: parsed.data.connectionId.toLowerCase() } : null, invalid: !parsed.success });
        } else entries.push({ sourceId, reference: null, invalid: typeof raw["token"] !== "string" });
      }
      return { entries };
    }, { entries: [] }),
    readStore<{ readonly entries: readonly SourceConnection[] }>(join(sourceKey, "secret-managers.json"), { name: "The Key-manager registry", is: "is" }, (value) => {
      if (!record(value) || !Array.isArray(value["connections"]) || (value["version"] !== undefined && value["version"] !== 1)) return { refused: "The Key-manager registry holds no supported connection list." };
      const entries: SourceConnection[] = [];
      for (const raw of value["connections"]) {
        if (!record(raw) || typeof raw["id"] !== "string") { entries.push({ sourceId: "invalid", label: "Invalid Key-manager connection", params: null }); continue; }
        const sourceId = raw["id"].toLowerCase();
        if (entries.some((entry) => entry.sourceId === sourceId)) continue;
        const label = typeof raw["label"] === "string" ? raw["label"] : "Unnamed connection";
        const provider = raw["provider"];
        const parsed = registry["keyManagers.connections.add"].params.safeParse({
          commandId: sourceId, connectionId: sourceId, provider, label, address: raw["address"],
          ...(provider === "openbao" ? { method: raw["authMethod"] === "userpass" ? "userpass" : "token", ...(typeof raw["caPem"] === "string" && { ca: raw["caPem"] }), ...(typeof raw["username"] === "string" && { username: raw["username"] }) } : {}),
        });
        entries.push({ sourceId, label: parsed.success ? label : "Invalid Key-manager connection", params: parsed.success ? parsed.data : null });
      }
      return { entries };
    }, { entries: [] }),
  ]);
  return { banks, tokens, connections };
};
