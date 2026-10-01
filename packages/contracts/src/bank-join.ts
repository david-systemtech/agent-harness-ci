import { z } from "zod";
import { BankManifest } from "./banks.js";

/** ADR 0037: the shared-bank rules a teammate sees before choosing any accounts. */
export const SHARED_BANK_RULES = ["No personal facts.", "No secrets."] as const;

const folder = z.object({ path: z.string().min(1), line: z.string().nullable() });

/** A bank preview, with repository access for the forge account matched by origin; nothing is attached. */
export const BankJoinPreview = z.object({
  name: BankManifest.shape.name,
  kind: BankManifest.shape.kind,
  line: z.string().min(1).meta({ description: "The bank line (T0) with the role this account's push access allows." }),
  orgs: z.array(folder),
  projects: z.array(folder).meta({ description: "The project folders, relative to projects/, including those without memories." }),
  entities: BankManifest.shape.entities,
  orientation: BankManifest.shape.orientation,
  owners: z.array(z.string().min(1)),
  merge: BankManifest.shape.write.shape.merge,
  rules: z.array(z.string().min(1)).meta({ description: "Shared-bank rules: no personal facts and no secrets; empty for a personal bank." }),
  canRead: z.boolean(),
  canPush: z.boolean(),
}).meta({ description: "What the bank contains, its review and shared-bank rules, and whether the forge account can read or push; preview attaches nothing." });
export type BankJoinPreview = z.infer<typeof BankJoinPreview>;
