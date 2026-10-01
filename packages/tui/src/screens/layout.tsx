import { Box, Text } from "ink";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import type { Badge } from "../rail/badge.js";
import { headingState, nameOf } from "../view.js";

/**
 * The layout skeleton (docs/specs/tui.md, "The screen"): the header
 * (logo, environment chip, workspace), the rail on the left, and on the
 * right the open card over the composer, with one line for results and one
 * for questions above it and the activity line under it. Every component is
 * a function of its props, which come from the runtime's projections.
 */

/** Under this many columns the rail is hidden beside the pane; `rail/rail.tsx` draws it. */
export const RAIL_MIN_COLUMNS = 100;

/**
 * The header: the product, the environment it is about with its state, and
 * the workspace. The environment's name is drawn in its colour (`colour`, its
 * badge's), its state in the phase's. With a session open it is the session's
 * environment, its badge's two letters in its colour where the phase dot was,
 * then the session's title and its workspace (kind, directory name, a
 * worktree's branch), read-only.
 */
export const Header = (props: {
  readonly current: EnvironmentView | undefined;
  readonly badge?: Badge;
  readonly colour?: string;
  readonly startingService: boolean;
  readonly workspace: string;
}) => {
  const { current, badge } = props;
  const state = current && headingState(current, props.startingService);
  const phase = current?.phase === "ready" ? TERMINAL_ROLES.success : TERMINAL_ROLES.warning;
  return (
    <Box height={1}>
      <Text wrap="truncate-end">
        <Text bold>{PRODUCT_NAME}</Text>
        <Text dimColor> · </Text>
        {current ? (
          <Text>
            {badge ? <Text color={badge.colour}>{badge.abbreviation}</Text> : <Text color={phase}>●</Text>} <Text color={props.colour ?? phase}>{nameOf(current)}</Text>
            <Text color={phase}> {state ?? "ready"}</Text>
          </Text>
        ) : (
          <Text dimColor>no environment</Text>
        )}
        <Text dimColor> · {props.workspace}</Text>
      </Text>
    </Box>
  );
};

/** The screen when there is no environment at all: pair one (docs/specs/tui.md, "First launch"). */
export const PairingPrompt = () => (
  <Box flexDirection="column" paddingX={1}>
    <Text bold>Pair this terminal with an environment.</Text>
    <Text> </Text>
    <Text>{"  "}/pair &lt;link&gt;{"             "}the link `{PRODUCT_NAME} pair` prints on the environment&apos;s machine</Text>
    <Text>{"  "}/pair &lt;address&gt; &lt;code&gt;{"   "}its address and the short code</Text>
  </Box>
);

/** One line; a message longer than the frame is wide wraps onto the rows it needs rather than being cut. */
export const Line = (props: { readonly text: string | undefined; readonly color?: string; readonly dim?: boolean }) => (
  <Box flexShrink={0}>
    <Text wrap="wrap" {...(props.color !== undefined && { color: props.color })} dimColor={props.dim ?? false}>
      {props.text ?? " "}
    </Text>
  </Box>
);

/**
 * The line under the composer: `hint`, what has the keys when that is not
 * the composer, kept in sight with the latest notice or fault beside it in
 * red; otherwise the notice, or the composer's own hint when there is none.
 */
export const HintLine = (props: { readonly hint: string | undefined; readonly activity: string | undefined; readonly fallback: string }) => (
  <Box flexShrink={0}>
    <Text wrap="wrap">
      {props.hint !== undefined && <Text dimColor>{props.hint}</Text>}
      {props.hint !== undefined && props.activity !== undefined && <Text dimColor> · </Text>}
      {props.activity !== undefined && <Text color={TERMINAL_ROLES.danger}>{props.activity}</Text>}
      {props.hint === undefined && props.activity === undefined && <Text dimColor>{props.fallback}</Text>}
    </Text>
  </Box>
);

/** The composer: its prompt in colour and its cursor drawn while it has the keys; dim, with no cursor, while the rail or the transcript has them. */
export const Composer = (props: { readonly text: string; readonly focused: boolean }) => (
  <Box height={1}>
    <Text wrap="truncate-start" dimColor={!props.focused}>
      <Text {...(props.focused && { color: TERMINAL_ROLES.machine })}>› </Text>
      {props.text}
      {props.focused && <Text inverse> </Text>}
    </Text>
  </Box>
);
