import { BankRecord } from "@agent-harness/contracts";
import { uuidv4 } from "../src/ids.js";
import { MANUAL_CLOCK_START as since } from "../src/testing/in-memory-platform.js";

/** A remote team bank as the environment answers it, with no secret value. */
export const bankRecord = (fields: Partial<BankRecord> = {}): BankRecord => BankRecord.parse({
  id: uuidv4(), name: "acme", kind: "team",
  location: { kind: "remote", origin: "https://forge.test", repository: "acme/memory" },
  checkout: "/source/banks/acme", checkoutOwnership: "managed",
  role: "read-write", enabled: true, accounts: "all", repositories: "all", defaultFor: [],
  pins: ["acme:acme/web/"], mergeOverride: "review-memories", privateCopy: true,
  credential: "forge", importedFrom: null, copiedFrom: null, createdAt: since,
  status: {
    reachable: { state: "reachable", since }, manifest: { state: "valid", since },
    orientation: { missing: [], since }, owners: { unresolved: [], since },
    lastSync: null, landing: { state: "ok", since },
  }, memories: 7, folders: 2, line: "## acme (team, read-write) — 7 memories in 2 folders", sharedAliases: [],
  ...fields,
});
