import { randomUUID } from "node:crypto";
import type { EventLog } from "../event-log/event-log.js";
import type { MoveSource } from "../key-managers/moves.js";
import { runInProcess } from "../serve/in-process.js";
import type { Vault } from "../serve/vault.js";
import type { Reader } from "../sessions/session-tables.js";
import { listBanks, liveBank } from "./bank-store.js";
import type { BankCredentials } from "./credentials.js";

/** Bank fallbacks use the existing Move orchestration, swapping through the bank's own command (ADR 0028). */
export const createBankMoveSource = (log: EventLog, vault: Vault, credentials: BankCredentials): MoveSource => {
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  return {
    kind: "bank",
    key: "token",
    items: () => listBanks(reader).filter((bank) => bank.credential === "stored").map((bank) => ({
      id: bank.id,
      name: bank.name,
      entry: `bank-${bank.name}`,
      service: bank.location.kind === "remote" ? new URL(bank.location.origin).host : "",
      note: `The fallback token for the bank ${bank.name}, used only by its BankService git operations. Rotate it by replacing the token here.`,
    })),
    async read(id) {
      const bank = liveBank(reader, id);
      if (bank?.credential !== "stored" || bank.credentialEntry == null) return null;
      const value = await vault.get(bank.credentialEntry);
      return value === undefined ? null : { value, storedAt: bank.credentialEntry };
    },
    async swap(id, reference, caller) {
      const params = { commandId: randomUUID(), bankId: id, reference };
      const answer = await runInProcess(log, { caller, commandId: params.commandId }, async (context) => {
        const handler = await credentials.swap.prepare(params, context);
        return (command) => handler(params, command);
      });
      return answer.outcome === "accepted" ? { outcome: "swapped" } : { outcome: "refused", error: answer.error };
    },
    async delete(id, storedAt) {
      if (!storedAt.startsWith(`bank:${id}:`)) throw new Error("The stored value does not belong to this bank.");
      const bank = liveBank(reader, id);
      if (bank?.credential === "stored" && bank.credentialEntry === storedAt) return;
      await vault.delete(storedAt);
    },
  };
};
