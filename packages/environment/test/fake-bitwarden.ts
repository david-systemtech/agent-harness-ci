import { randomUUID } from "node:crypto";
import type { BitwardenSdk, BitwardenSdkLoader } from "../src/key-managers/bitwarden-sdk.js";

export const BITWARDEN_TEST_TOKEN = "bitwarden-token-for-tests";
export const scriptedBitwarden = () => {
  const projectId = randomUUID();
  const secrets = new Map<string, { id: string; key: string; value: string; projectId: string }>();
  const calls: { operation: string; args: unknown[] }[] = [];
  let failure: unknown;
  let unavailable = false;
  const failures = new Map<string, unknown[]>();
  const called = (operation: string, ...args: unknown[]) => {
    calls.push({ operation, args });
    const scripted = failures.get(operation);
    if (scripted?.length) throw scripted.shift();
    if (failure !== undefined) throw failure;
  };
  const sdk: BitwardenSdk = {
    async login(token) { called("login", token); if (token !== BITWARDEN_TEST_TOKEN) throw new Error("HTTP 401"); },
    async projects() { called("projects"); return [{ id: projectId, name: "harness" }]; },
    async identifiers(project) { called("identifiers", project); return [...secrets.values()].filter((secret) => project === undefined || secret.projectId === project).map(({ id, key }) => ({ id, key })); },
    async get(id) { called("get", id); const secret = secrets.get(id); if (!secret) throw new Error("HTTP 404"); return secret; },
    async create(project, key, value, note) { called("create", project, key, value, note); const secret = { id: randomUUID(), projectId: project, key, value }; secrets.set(secret.id, secret); return secret; },
    async update(secret, value, note) { called("update", secret.id, value, note); const updated = { ...secret, projectId: secret.projectId ?? projectId, value }; secrets.set(secret.id, updated); return updated; },
  };
  const load: BitwardenSdkLoader = async (address) => {
    calls.push({ operation: "load", args: [address] });
    if (unavailable) throw new Error("native binding missing for tests");
    return sdk;
  };
  return { load, calls, secrets, projectId, fail: (error?: unknown) => { failure = error; }, failNext: (operation: string, error: unknown) => { const pending = failures.get(operation) ?? []; pending.push(error); failures.set(operation, pending); }, unavailable: (value = true) => { unavailable = value; } };
};
