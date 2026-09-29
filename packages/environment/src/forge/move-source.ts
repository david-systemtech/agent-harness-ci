import { randomUUID } from "node:crypto";
import type { ForgeAccountRecord, ParamsOf } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { MoveSource } from "../key-managers/moves.js";
import { runInProcess } from "../serve/in-process.js";
import type { PreparedCommand } from "../serve/methods.js";
import type { Vault } from "../serve/vault.js";
import type { Reader } from "../sessions/session-tables.js";
import { listForgeAccounts, liveForgeAccount } from "./forge-store.js";

/**
 * The forge's Move source (key-managers spec, "Move stored tokens"; ADR
 * 0020, ADR 0028; #371): every forge account holding a pasted token, whose
 * entry is `forge-<slug>` with the token at `token`. Its stored value is
 * the token in its vault entry; it is swapped to a reference through
 * `forge.accounts.update`, carried out in process for the client session
 * that asked for the Move, which asks the forge who the reference's value
 * is before it takes it (#312); and its delete deletes that vault entry,
 * never one the forge account holds, as it would be if the swap had not
 * taken. The forge's own start deletes any entry no forge account holds, so
 * a delete that fails is gone by the next start either way.
 */

export interface ForgeMoveSourceOptions {
  readonly log: EventLog;
  readonly reader: Reader;
  readonly vault: Vault;
  /** `forge.accounts.update` as the ForgeService prepares it. */
  readonly update: PreparedCommand<"forge.accounts.update">;
}

/** A forge account's host, which its entry's `service` field names. */
const hostOf = (account: ForgeAccountRecord): string => account.origin.replace(/^https?:\/\//, "");

/** Whether a forge account holds the vault entry `entry` as its stored token now. */
const holds = (account: ForgeAccountRecord | null, entry: string): boolean => account?.credential.kind === "stored" && account.credential.entry === entry;

export const createForgeMoveSource = ({ log, reader, vault, update }: ForgeMoveSourceOptions): MoveSource => ({
  kind: "forge-account",
  key: "token",

  items: () =>
    listForgeAccounts(reader)
      .filter((account) => account.credential.kind === "stored")
      .map((account) => ({
        id: account.id,
        name: account.origin,
        entry: `forge-${account.slug}`,
        service: hostOf(account),
        note: `The token of the forge account ${account.slug} (${account.origin}), moved here by agent-harness, which reads it for every operation on that forge. To rotate it, make a new token on the forge and write it here in place of this one.`,
      })),

  async read(id) {
    const account = liveForgeAccount(reader, id);
    if (account?.credential.kind !== "stored") return null;
    const { entry } = account.credential;
    try {
      const value = await vault.get(entry);
      return value === undefined ? null : { value, storedAt: entry };
    } catch (error) {
      console.error(`Reading the vault entry ${entry} of the forge account ${account.slug} for a Move failed:`, error);
      return null;
    }
  },

  async swap(id, reference, caller) {
    const params: ParamsOf<"forge.accounts.update"> = { commandId: randomUUID(), forgeAccountId: id, credential: { kind: "reference", reference } };
    const answer = await runInProcess(log, { caller, commandId: params.commandId }, async (context) => {
      const handler = await update.prepare(params, context);
      return (command) => handler(params, command);
    });
    return answer.outcome === "accepted" ? { outcome: "swapped" } : { outcome: "refused", error: answer.error };
  },

  async delete(id, storedAt) {
    if (!storedAt.startsWith(`forge:${id}:`)) throw new Error(`${storedAt} is not a vault entry of the forge account ${id}.`);
    if (holds(liveForgeAccount(reader, id), storedAt)) return;
    await vault.delete(storedAt);
  },
});
