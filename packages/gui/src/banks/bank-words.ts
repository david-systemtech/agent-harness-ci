import { plainRefusal, type PlainRefusal, type RefusedAnswer } from "@agent-harness/client-runtime";
import type { BankRecord } from "@agent-harness/contracts";

/**
 * The codes whose refusals the environment's notebook methods word in
 * setup-copy.md §5.8 (creating, joining, previewing, moving and describing a
 * notebook, a preview keeping the forge's own code on its line): their message
 * is the plain line, their `details` the raw facts.
 */
const WORDED: ReadonlySet<string> = new Set(["invalid_params", "not_found", "conflict", "unreachable", "verification_failed", "kind_unsupported", "validation_failed", "bank_read_only", "secret_shaped", "forge_account_missing", "credential_unavailable", "no_primary_forge"]);

/**
 * A notebook refusal in plain words (setup-copy.md §5.8 "Refusals"): the
 * environment's own line where it words one, its raw facts in Details; else,
 * a refusal this app met itself, a schema's or an access one, `plainRefusal`'s.
 * Never cut: the line is short and the rest is in Details.
 */
export const bankRefusal = (refusal: RefusedAnswer, verb: string): PlainRefusal => {
  const plain = plainRefusal(refusal, verb);
  const { data } = refusal;
  const issues = data?.["issues"];
  if (data === undefined || !WORDED.has(refusal.code) || (Array.isArray(issues) && issues.length > 0)) return plain;
  const details = data["details"];
  return { line: refusal.message, details: [...plain.details, ...(Array.isArray(details) ? details.filter((detail): detail is string => typeof detail === "string") : [])] };
};

/** The host a notebook's forge or a pull request lives on. */
export const hostOf = (url: string): string => {
  try { return new URL(url).host; } catch { return url; }
};

/**
 * Why a notebook cannot be reached, by the cause the environment found, in
 * setup-copy.md §5.8's line (the Set up check words it the same way); what
 * the check saw goes in Details.
 */
export const unreachableLine = ({ name, copiedFrom, location, status: { reachable } }: BankRecord): string => {
  const cause = reachable.state === "unreachable" ? reachable.cause : undefined;
  const host = location.kind === "remote" ? hostOf(location.origin) : null;
  if (cause === "folder-missing") return `${name}'s folder on this computer is missing.`;
  if (cause === "no-forge-account" && host !== null) {
    return copiedFrom === null ? `${name} needs a forge account for ${host} on this computer.` : `Your ${host} account is connected on ${copiedFrom.environmentName}, not here. Connect it here too.`;
  }
  if (cause === "repository-missing" && host !== null) return `The repository for ${name} is missing on ${host}.`;
  return cannotReach(name);
};

/** §5.8's plain unreachable line, for a cause it has no line of its own for; the card draws Check again beside it. */
export const cannotReach = (name: string): string => `agent-harness cannot reach ${name}. Choose Check again.`;

/** A notebook's badges (setup-copy.md §5.8): Personal or Team, On or Off, and where it is kept; the rest is in Details. */
export const bankBadges = (bank: BankRecord): readonly string[] => [
  ...(bank.kind === null ? [] : [bank.kind === "team" ? "Team" : "Personal"]),
  bank.enabled ? "On" : "Off",
  bank.location.kind === "local" ? "On this computer only" : `On ${hostOf(bank.location.origin)}`,
];

const DESCRIPTION: { readonly [State in BankRecord["status"]["manifest"]["state"]]: string } = {
  valid: "ready", missing: "missing", invalid: "has a problem", "awaiting-review": "waiting for approval",
};

/** Where its description stands, in place of the manifest's state (setup-copy.md §5.8). */
export const descriptionWords = (bank: BankRecord): string => `Description: ${DESCRIPTION[bank.status.manifest.state]}`;
