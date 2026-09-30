import { ACCOUNT_STREAM_KIND, SKILLS_STREAM_KIND, type AccountRemovedPayload, type SkillChoice, type SkillsAlwaysOnSetPayload, type SkillsEnabledSetPayload } from "@agent-harness/contracts";
import type { EventLog, ProjectionDb, Projector, StreamRef } from "../event-log/event-log.js";

/**
 * The skill set's choices (skills spec, "Choices: disabled and always-on";
 * ADR 0009, ADR 0029): each name switched off or on, for one account or the
 * whole environment, and each name made always-on for an account, recorded
 * on the `skills` stream, one stream whose id is the environment's, as a
 * read model rebuilt from the log. A name and account have at most one
 * choice of each kind: the latest. A choice is keyed by name, never by a
 * member, so it survives a source's re-layout and applies to every layer
 * holding the name, and waits, inert, for a name no layer holds. An
 * account's removal drops the choices naming it.
 */

export const SKILL_CHOICES_PROJECTOR = "skill-choices";

export const SKILL_CHOICES_TABLES = {
  skill_choices: `CREATE TABLE skill_choices (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    account_id TEXT,
    value INTEGER NOT NULL
  ) STRICT`,
} as const;

/** Replaces the choice of `kind` held for `name` and `account`, the whole environment's when it is null. */
const replace = (db: ProjectionDb, kind: SkillChoice["kind"], name: string, account: string | null, value: boolean): void => {
  db.run("DELETE FROM skill_choices WHERE kind = ? AND name = ? AND account_id IS ?", kind, name, account);
  db.run("INSERT INTO skill_choices (kind, name, account_id, value) VALUES (?, ?, ?, ?)", kind, name, account, value ? 1 : 0);
};

export const skillChoicesProjector: Projector = {
  name: SKILL_CHOICES_PROJECTOR,
  tables: SKILL_CHOICES_TABLES,
  apply(event, db) {
    if (event.streamKind === SKILLS_STREAM_KIND && event.type === "skills.enabled-set") {
      const { name, accountId, enabled } = event.payload as SkillsEnabledSetPayload;
      replace(db, "enabled", name, accountId, enabled);
    } else if (event.streamKind === SKILLS_STREAM_KIND && event.type === "skills.always-on-set") {
      const { name, accountId, on } = event.payload as SkillsAlwaysOnSetPayload;
      replace(db, "always-on", name, accountId, on);
    } else if (event.streamKind === ACCOUNT_STREAM_KIND && event.type === "account.removed") {
      db.run("DELETE FROM skill_choices WHERE account_id = ?", (event.payload as AccountRemovedPayload).accountId);
    }
  },
};

/** The skills stream: the environment's one, the aggregate of every choice. */
export const skillsStream = (environmentId: string): StreamRef => ({ kind: SKILLS_STREAM_KIND, id: environmentId });

interface ChoiceRow {
  readonly kind: SkillChoice["kind"];
  readonly name: string;
  readonly account_id: string | null;
  readonly value: number;
}

const choiceOf = ({ kind, name, account_id: accountId, value }: ChoiceRow): SkillChoice => {
  if (kind === "enabled") return { kind, name, accountId, enabled: value === 1 };
  // An always-on choice is an account's: the command takes no other.
  if (accountId === null) throw new Error(`The always-on choice for ${name} names no account.`);
  return { kind, name, accountId, on: value === 1 };
};

/**
 * Every choice the environment holds, as the log's query-only read gives
 * it (inside a command, as of its transaction): by name, then enabled
 * before always-on, then the whole environment's before the accounts', by
 * id.
 */
export const readSkillChoices = (log: Pick<EventLog, "read">): SkillChoice[] =>
  log
    .read<ChoiceRow>("SELECT kind, name, account_id, value FROM skill_choices ORDER BY name, kind = 'always-on', account_id IS NOT NULL, account_id")
    .map(choiceOf);

/** What the choices come to for one account: whether a name is on, and whether it is always-on. */
export interface AccountChoices {
  /** On unless switched off: the whole environment's choice, else the account's, else on. */
  enabled(name: string): boolean;
  /** Whether the account made the name always-on. */
  alwaysOn(name: string): boolean;
}

/**
 * The choices as they apply to `accountId`'s runs, the precedence rule's
 * one place: the whole environment's choice about a name outranks the
 * account's, either way. With no account (an environment holding none),
 * only the whole environment's apply.
 */
export const choicesFor = (choices: readonly SkillChoice[], accountId: string | null): AccountChoices => {
  const environmentWide = new Map<string, boolean>();
  const account = new Map<string, boolean>();
  const alwaysOn = new Set<string>();
  for (const choice of choices) {
    if (choice.kind === "enabled" && choice.accountId === null) environmentWide.set(choice.name, choice.enabled);
    else if (choice.kind === "enabled" && choice.accountId === accountId) account.set(choice.name, choice.enabled);
    else if (choice.kind === "always-on" && choice.accountId === accountId && choice.on) alwaysOn.add(choice.name);
  }
  return {
    enabled: (name) => environmentWide.get(name) ?? account.get(name) ?? true,
    alwaysOn: (name) => alwaysOn.has(name),
  };
};
