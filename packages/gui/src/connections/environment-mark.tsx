import type { EnvironmentView } from "@agent-harness/client-runtime";
import { EnvironmentColour } from "@agent-harness/contracts";

/**
 * An environment's icon and colour beside its name (workspace-picker spec,
 * "Name, icon and colour"): a dot in the colour's token
 * (`--environment-<name>`) and the icon's name, named for assistive
 * technology by both; nothing while the environment has said neither.
 */
export const EnvironmentMark = ({ view }: { readonly view: EnvironmentView }) => {
  const colour = EnvironmentColour.safeParse(view.colour);
  const named = [view.icon, colour.success ? colour.data : null].filter((part) => part !== null);
  if (named.length === 0) return null;
  return (
    <span
      role="img"
      aria-label={named.join(", ")}
      className="inline-flex items-center gap-1 text-xs text-ink-muted"
      // The colour's token, a CSS variable the theme derives per name (ADR 0023): the name is data, never a literal.
      style={colour.success ? { color: `var(--environment-${colour.data})` } : undefined}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      {view.icon !== null && <span aria-hidden="true">{view.icon}</span>}
    </span>
  );
};
