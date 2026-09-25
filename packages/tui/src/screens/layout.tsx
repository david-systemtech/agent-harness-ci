import { Box, Text } from "ink";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { headingState, nameOf } from "../view.js";

/**
 * Artemis's layout skeleton (docs/specs/tui.md, "The screen"): the header
 * (logo, environment chip, workspace), the rail on the left, and on the
 * right the open card over the composer, with one line for results and one
 * for questions above it and the activity line under it. Every component is
 * a function of its props, which come from the runtime's projections.
 */

/** Under this many columns the rail is hidden (Artemis's threshold). */
export const RAIL_MIN_COLUMNS = 100;
export const RAIL_WIDTH = 28;

export const Header = (props: { readonly current: EnvironmentView | undefined; readonly startingService: boolean; readonly workspace: string }) => {
  const { current } = props;
  const state = current && headingState(current, props.startingService);
  return (
    <Box height={1}>
      <Text wrap="truncate-end">
        <Text bold>{PRODUCT_NAME}</Text>
        <Text dimColor> · </Text>
        {current ? (
          <Text color={current.phase === "ready" ? "green" : "yellow"}>
            ● {nameOf(current)} {state ?? "ready"}
          </Text>
        ) : (
          <Text dimColor>no environment</Text>
        )}
        <Text dimColor> · {props.workspace}</Text>
      </Text>
    </Box>
  );
};

/**
 * The rail: one heading per environment in the runtime's order, and its
 * sessions, which the session-list ticket fills. Its edge is drawn in colour
 * while it has the keys.
 */
export const Rail = (props: { readonly views: readonly EnvironmentView[]; readonly startingService: boolean; readonly focused: boolean }) => (
  <Box
    flexDirection="column"
    width={RAIL_WIDTH}
    flexShrink={0}
    borderStyle="single"
    borderTop={false}
    borderBottom={false}
    borderLeft={false}
    {...(props.focused && { borderColor: "cyan" })}
  >
    {props.views.map((view) => {
      const state = headingState(view, props.startingService);
      return (
        <Box key={view.environmentId} flexDirection="column">
          <Text wrap="truncate-end" bold dimColor={view.phase !== "ready"}>
            {nameOf(view)}
          </Text>
          {state && (
            <Text wrap="truncate-end" dimColor>
              {"  "}
              {state}
            </Text>
          )}
          <Text dimColor>{"  "}no sessions</Text>
        </Box>
      );
    })}
  </Box>
);

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

/** The composer: its prompt in colour and its cursor drawn while it has the keys; dim, with no cursor, while the rail or the conversation has them. */
export const Composer = (props: { readonly text: string; readonly focused: boolean }) => (
  <Box height={1}>
    <Text wrap="truncate-start" dimColor={!props.focused}>
      <Text {...(props.focused && { color: "cyan" })}>› </Text>
      {props.text}
      {props.focused && <Text inverse> </Text>}
    </Text>
  </Box>
);
