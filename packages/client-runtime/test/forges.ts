import {
  FORGE_EVENT_PAYLOADS,
  ForgeAccountRecord,
  UNKNOWN_FORGE_CAPABILITIES,
  forgeVariableNames,
  type ForgeProblem,
} from "@agent-harness/contracts";
import { uuidv4 } from "../src/ids.js";
import { MANUAL_CLOCK_START } from "../src/testing/in-memory-platform.js";

/**
 * Forge accounts and their events as an environment answers and sends them
 * (forge spec, "The forge account record" and "Events"), for the suites of
 * the client runtime's forge part (#320). Each is parsed by its contracts
 * schema, so a fixture that drifts from the wire fails where it is made.
 */

/** A GitHub forge account on github.com with a pasted token, verified as David, primary; `fields` replace any of its own. */
export const forgeRecord = (fields: Partial<ForgeAccountRecord> = {}): ForgeAccountRecord => {
  const id = fields.id ?? uuidv4();
  const origin = fields.origin ?? "https://github.com";
  const slug = fields.slug ?? "github";
  const primary = fields.primary ?? true;
  const names = forgeVariableNames({ slug, origin, primary });
  return ForgeAccountRecord.parse({
    id,
    origin,
    aliases: [],
    kind: "github",
    slug,
    identity: { login: "david", userId: "42" },
    credential: { kind: "stored", provenance: "pasted", entry: `forge:${id}:${uuidv4()}` },
    capabilities: UNKNOWN_FORGE_CAPABILITIES,
    primary,
    problem: null,
    statusSince: MANUAL_CLOCK_START,
    tokenInformation: null,
    variables: { url: names.url, token: names.token, kind: names.kind },
    createdAt: MANUAL_CLOCK_START,
    copiedFrom: null,
    ...fields,
  });
};

/** A problem of `kind` since the manual clock's start, with a line a verification might write. */
export const forgeProblem = (kind: ForgeProblem["kind"], message = `The forge account is ${kind}: see Set up, Forges.`): ForgeProblem => ({ kind, since: MANUAL_CLOCK_START, message });

export type ForgeEventType = keyof typeof FORGE_EVENT_PAYLOADS;

/** A payload of `type` about `account`, as the environment appends it; `fields` replace any of its own. */
export const forgeEventPayload = (type: ForgeEventType, account: ForgeAccountRecord, fields: Record<string, unknown> = {}): Record<string, unknown> => {
  const forgeAccountId = account.id;
  const base: Record<ForgeEventType, Record<string, unknown>> = {
    "forge.account.added": {
      forgeAccountId,
      origin: account.origin,
      aliases: account.aliases,
      kind: account.kind,
      slug: account.slug,
      identity: account.identity,
      credential: account.credential,
      primary: account.primary,
      clearedPrimary: null,
      problem: account.problem,
      copiedFrom: account.copiedFrom,
    },
    "forge.account.updated": { forgeAccountId, slug: account.slug },
    "forge.account.primary-set": { forgeAccountId, cleared: null },
    "forge.account.verified": {
      forgeAccountId,
      identity: account.identity,
      capabilities: account.capabilities,
      tokenInformation: account.tokenInformation,
      problem: account.problem,
    },
    "forge.account.capability-learned": { forgeAccountId, capability: "writeIssues", state: "failed", operation: "open an issue", status: 403 },
    "forge.account.git-rejected": { forgeAccountId, origin: account.origin },
    "forge.account.removed": { forgeAccountId },
    "forge.origin-missing": { origin: "https://git.example.com", operation: "read a skill source" },
    "forge.origin-answered": { origin: "https://git.example.com", operation: "read a skill source" },
  };
  return FORGE_EVENT_PAYLOADS[type].parse({ ...base[type], ...fields }) as Record<string, unknown>;
};
