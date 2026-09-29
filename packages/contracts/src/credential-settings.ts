import { z } from "zod";
import { AccountId } from "./accounts.js";
import type { SettingDefinition } from "./settings.js";

/**
 * The injection setting (key-managers spec, "Injection"; ADR 0011, ADR
 * 0028; #367): whether runs on an environment receive credentials, the
 * forge variables and credential helper (ADR 0020) and the key managers'
 * block alike. Its entries in the settings key table (`settings.ts`, which
 * spreads them in), each with its schema, its preset and the Key manager
 * step that writes it, on the Access band's Key managers row (ADR 0027);
 * the generic `settings.update` writes them. A run's answer is the most
 * specific present: its own override (a routine's, later a bot's), then its
 * account's entry, then the environment's value.
 */

/** Whether a holder's credentials are injected: `allow` or `deny`. */
export const INJECTION_ANSWERS = ["allow", "deny"] as const;
export const InjectionAnswer = z.enum(INJECTION_ANSWERS).meta({
  description: "Whether runs receive credentials (the forge variables and credential helper, and the key managers' block): allow or deny.",
});
export type InjectionAnswer = z.infer<typeof InjectionAnswer>;

/**
 * A run's own injection (#367): its routine's `allow` or `deny`, later a
 * bot's, which outranks its account's entry and the environment's value.
 * Recorded on the run's policy, so a run the environment starts after it
 * for the same routine (from its queue, or an update's continuation) keeps
 * it. A routine's `inherit` is no override: the run records none.
 */
export const RunInjection = z
  .object({
    answer: InjectionAnswer,
    id: z.string().min(1).meta({ description: "The id of the routine (or bot, as the policy's actorKind says) whose own injection it is." }),
  })
  .meta({ description: "A run's own credential injection: its routine's or bot's allow or deny, which outranks its account's entry and the environment's value." });
export type RunInjection = z.infer<typeof RunInjection>;

export const CredentialInjection = InjectionAnswer.meta({
  description:
    "credentials.injection: whether runs on this environment receive credentials (the forge variables and credential helper, and the key managers' block), unless an account's entry or a routine's own injection says otherwise. Preset allow.",
});

export const CredentialInjectionByAccount = z.record(AccountId, InjectionAnswer).meta({
  description:
    "credentials.injectionByAccount: by account id, allow or deny, which outranks credentials.injection for that account's runs and terminals and is outranked by a routine's own injection. An account not listed takes the environment's value; an account's entry is dropped when the account is removed. Preset empty.",
});

/** A key's definition, its preset checked against its schema by the compiler. */
const setting = <const S extends z.ZodType>(definition: SettingDefinition<S>): SettingDefinition<S> => definition;

/** Both keys sit under the Key manager step, on its home row `access.key-managers` (ADR 0027). */
const KEY_MANAGER_STEP = { id: "key-manager", row: "access.key-managers" } as const;

/** Every injection settings key, in the spec's order. */
export const CREDENTIAL_SETTINGS = {
  "credentials.injection": setting({ schema: CredentialInjection, preset: "allow", step: KEY_MANAGER_STEP }),
  "credentials.injectionByAccount": setting({ schema: CredentialInjectionByAccount, preset: {}, step: KEY_MANAGER_STEP }),
} as const;

export type CredentialSettingsKey = keyof typeof CREDENTIAL_SETTINGS;

/** Every injection settings key, in the table's order. */
export const CREDENTIAL_SETTINGS_KEYS = Object.keys(CREDENTIAL_SETTINGS) as [CredentialSettingsKey, ...CredentialSettingsKey[]];
