import { z } from "zod";
import { BankFolderPointer, BankId } from "./bank-registry.js";
import type { EventTypeEntry } from "./event-types.js";

/** Successful memory-tool use belongs to the session, independent of a run or its queue. */
export const SessionBankUsedPayload = z.object({ bankId: BankId, pointers: z.array(BankFolderPointer).min(1) }).meta({ description: "session.bank-used: a successful read, search or draft used these canonical folder pointers; the next run renders them as recent use." });
export type SessionBankUsedPayload = z.infer<typeof SessionBankUsedPayload>;
export const BANK_SESSION_EVENT_TYPES = {
  "session.bank-used": { list: false, payload: SessionBankUsedPayload },
} as const satisfies Record<string, EventTypeEntry>;
