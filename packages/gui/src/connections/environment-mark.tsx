import type { EnvironmentView } from "@agent-harness/client-runtime";
import { EnvironmentColour } from "@agent-harness/contracts";
import { EnvironmentGlyph } from "./environment-badge.js";

/**
 * An environment's icon and colour beside its name (workspace-picker spec,
 * "Name, icon and colour"): the badge's glyph in the colour's token
 * (`--environment-<name>`), named for assistive technology by the icon's
 * name and the colour's, which the Your machines card sets; nothing while
 * the environment has said neither.
 */
export const EnvironmentMark = ({ view }: { readonly view: EnvironmentView }) => {
  const colour = EnvironmentColour.safeParse(view.colour);
  const named = [view.icon, colour.success ? colour.data : null].filter((part) => part !== null);
  return named.length === 0 ? null : <EnvironmentGlyph view={view} label={named.join(", ")} />;
};
