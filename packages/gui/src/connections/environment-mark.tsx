import type { EnvironmentView } from "@agent-harness/client-runtime";
import { EnvironmentColour } from "@agent-harness/contracts";
import { classes } from "../ui/classes.js";

/** Each environment colour's token as a text colour (ADR 0023: the name is data, drawn with its token). */
const TOKEN_TEXT: Readonly<Record<EnvironmentColour, string>> = {
  red: "text-environment-red",
  orange: "text-environment-orange",
  amber: "text-environment-amber",
  yellow: "text-environment-yellow",
  lime: "text-environment-lime",
  green: "text-environment-green",
  teal: "text-environment-teal",
  cyan: "text-environment-cyan",
  blue: "text-environment-blue",
  indigo: "text-environment-indigo",
  violet: "text-environment-violet",
  pink: "text-environment-pink",
};

/**
 * An environment's icon and colour beside its name (workspace-picker spec,
 * "Name, icon and colour"): a dot in the colour's token and the icon's name,
 * named for assistive technology by both; nothing while the environment has
 * said neither.
 */
export const EnvironmentMark = ({ view }: { readonly view: EnvironmentView }) => {
  const colour = EnvironmentColour.safeParse(view.colour);
  const named = [view.icon, colour.success ? colour.data : null].filter((part): part is string => part !== null);
  if (named.length === 0) return null;
  return (
    <span role="img" aria-label={named.join(", ")} className={classes("inline-flex items-center gap-1 text-xs", colour.success ? TOKEN_TEXT[colour.data] : "text-ink-muted")}>
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      {view.icon !== null && <span aria-hidden="true">{view.icon}</span>}
    </span>
  );
};
