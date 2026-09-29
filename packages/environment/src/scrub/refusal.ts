import { REGISTERED_VALUE_RULE, SHAPE_RULES, type SecretRule, type SecretShapedError } from "@agent-harness/contracts";
import type { ScrubRegistry } from "./registry.js";

/** What a refusal says a text held, by the rule that found it. */
const heldWhat = (rule: SecretRule): string =>
  rule === REGISTERED_VALUE_RULE ? "a secret this environment holds" : (SHAPE_RULES.find((shape) => shape.id === rule)?.label ?? "a secret");

/**
 * The refusal of a text the harness would send out (ADR 0011; key-managers
 * spec, "Refusal"): the first of `fields`, in their order, holding a
 * registered value or a shape rule's hit is refused `secret_shaped`, naming
 * the rule and the field and never the value; null when none holds either.
 * The forge's issue and pull-request writes call it before anything leaves,
 * and a memory draft's validation will (#90). `what` names the write (`the
 * issue`), and `consequence` ends the message with what did not happen.
 */
export const secretShapedIn = (
  registry: Pick<ScrubRegistry, "check">,
  what: string,
  fields: Readonly<Record<string, string>>,
  consequence: string,
): SecretShapedError | null => {
  for (const [field, text] of Object.entries(fields)) {
    const rule = registry.check(text);
    if (rule !== null) return { code: "secret_shaped", message: `The ${what}'s ${field} holds ${heldWhat(rule)}: take it out. ${consequence}`, data: { rule, field } };
  }
  return null;
};
