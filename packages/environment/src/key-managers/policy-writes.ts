import type { KeyManagerPolicyWrites } from "@agent-harness/contracts";

/**
 * Whether an OpenBao or Vault policy can write (key-managers spec,
 * "Providers"; ADR 0028's warning on a ticked policy): it does when its text
 * grants `create`, `update`, `patch` or `delete` on a path outside `auth/`,
 * `sys/`, `cubbyhole/` and `identity/`, the token's and the key manager's
 * own paths. A path pattern is taken as it is written: one that does not
 * start with those prefixes (`*`, `+/data/*`) may reach outside them, so it
 * counts. A text that is neither the policy language nor its JSON form, as
 * far as this reads them, possibly writes.
 */

const WRITING = new Set(["create", "update", "patch", "delete"]);
const OWN_PATHS = ["auth/", "sys/", "cubbyhole/", "identity/"];

/** One `path` rule: its pattern, and the capabilities it grants. */
interface Rule {
  readonly path: string;
  readonly capabilities: readonly string[];
}

const writes = (rules: readonly Rule[]): KeyManagerPolicyWrites =>
  rules.some((rule) => !OWN_PATHS.some((own) => rule.path.startsWith(own)) && !rule.capabilities.includes("deny") && rule.capabilities.some((capability) => WRITING.has(capability)))
    ? "yes"
    : "no";

/** The text with its comments (`#`, `//` and `/* *\/`) blanked out, strings kept whole. */
const withoutComments = (text: string): string => text.replace(/"(?:[^"\\]|\\.)*"|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) => (match.startsWith('"') ? match : " "));

/** The rules of a text in the policy language (HCL); null when its `path` blocks do not close. */
const hclRules = (text: string): Rule[] | null => {
  const source = withoutComments(text);
  const rules: Rule[] = [];
  const opening = /\bpath\s+"((?:[^"\\]|\\.)*)"\s*=?\s*\{/g;
  for (let match = opening.exec(source); match !== null; match = opening.exec(source)) {
    // The block runs to its matching brace: a rule's parameters may nest blocks of their own.
    let depth = 1;
    let end = opening.lastIndex;
    for (; end < source.length && depth > 0; end += 1) {
      const character = source[end];
      if (character === '"') end = skipString(source, end);
      else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
    }
    if (depth > 0) return null;
    const body = source.slice(opening.lastIndex, end - 1);
    const listed = /\bcapabilities\s*=\s*\[([^\]]*)\]/.exec(body)?.[1] ?? "";
    rules.push({ path: match[1] ?? "", capabilities: [...listed.matchAll(/"([^"]*)"/g)].map(([, capability = ""]) => capability.toLowerCase()) });
    opening.lastIndex = end;
  }
  return rules;
};

/** Where the string opening at `start` closes. */
const skipString = (source: string, start: number): number => {
  for (let at = start + 1; at < source.length; at += 1) {
    if (source[at] === "\\") at += 1;
    else if (source[at] === '"') return at;
  }
  return source.length;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The rules of a policy in its JSON form (`{"path": {"<pattern>": {"capabilities": [...]}}}`); null for a text that is not that. */
const jsonRules = (text: string): Rule[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const paths = parsed["path"];
  if (paths === undefined) return [];
  // The JSON form may give the rules as an object, or as a list of one-rule objects.
  const entries = Array.isArray(paths) ? paths.filter(isRecord).flatMap((each) => Object.entries(each)) : isRecord(paths) ? Object.entries(paths) : null;
  if (entries === null) return null;
  return entries.map(([path, rule]) => ({
    path,
    capabilities: isRecord(rule) && Array.isArray(rule["capabilities"]) ? rule["capabilities"].filter((each): each is string => typeof each === "string").map((each) => each.toLowerCase()) : [],
  }));
};

/** Whether the policy `text` can write, as the rule above reads it. */
export const policyWrites = (text: string): KeyManagerPolicyWrites => {
  const rules = text.trimStart().startsWith("{") ? jsonRules(text) : hclRules(text);
  return rules === null ? "possibly" : writes(rules);
};
